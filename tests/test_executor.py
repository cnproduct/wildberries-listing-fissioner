"""Executor failure/recovery boundaries; no public network or marketplace writes."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import antigravity_executor as executor


class FakeGateway:
    def __init__(self):
        self.updates = []
    def call(self, path, data=None):
        if path.endswith("/claim"):
            return {"task": {"task_id": "test", "nmId": "1520898783", "lease_id": "lease", "attempts": 1}}
        if path.endswith("/update"):
            self.updates.append(data)
        return {"code": 0}


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = {"OUTPUT_ROOT": str(self.root / "output"), "FACTS_ROOT": str(self.root / "facts")}
        self.gateway = FakeGateway()
        self.task = {"key": "task:user:test", "task_id": "test", "nmId": "1520898783"}

    def test_unavailable_source_never_becomes_demo_or_ready(self):
        with patch.object(executor, "acquire_source", return_value=({"product": None, "errors": ["unavailable"]},{})):
            self.assertEqual(executor.execute_task(self.task, self.gateway, self.config, "worker"), "needs_input")
        final = self.gateway.updates[-1]
        self.assertEqual(final["status"], "needs_input")
        self.assertEqual(["source_images"], final["details"]["missing_fields"])
        self.assertFalse(final["details"]["published"])
        self.assertEqual(list(self.root.rglob("*.jpg")), [])
        self.assertEqual(list(self.root.rglob("*.xlsx")), [])

    def test_confirmed_data_without_generator_returns_actionable_failure(self):
        facts = {"source_verified": True, "brand": "Verified", "category": "Test", "composition": "Steel", "country": "China",
                 "length_cm": 11, "width_cm": 7, "height_cm": 3, "weight_kg": .1, "source_images": ["original.jpg"],
                 "sales_quantity": 1, "barcode": "0123456789012"}
        with patch.object(executor, "get_facts", return_value=facts), patch.object(executor, "acquire_source", return_value=({"product": {"id":1520898783}}, facts)):
            self.assertEqual(executor.execute_task(self.task, self.gateway, self.config, "worker"), "failed")
        self.assertEqual(self.gateway.updates[-1]["details"]["reason"], "generator_not_configured")

    def test_lease_loss_during_claim_never_runs_generation(self):
        self.gateway.call = lambda *args: (_ for _ in ()).throw(executor.GatewayError("Lease lost"))
        with patch.object(executor, "fetch_product") as fetch:
            with self.assertRaises(executor.GatewayError):
                executor.execute_task(self.task, self.gateway, self.config, "worker")
            fetch.assert_not_called()

    def test_foreign_product_or_unreviewed_images_are_rejected(self):
        class Result:
            returncode = 0
            stdout = json.dumps({"source_nm_id": "211832049", "review":{"subject_consistency_verified":True}})
        with patch.object(executor.subprocess, "Popen") as process:
            process.return_value.communicate.return_value = (Result.stdout, None)
            process.return_value.returncode = 0
            with self.assertRaises(ValueError):
                executor.run_generator(self.task, {}, {}, self.root, ["dummy"])
        Result.stdout = json.dumps({"source_nm_id":"1520898783"})
        with patch.object(executor.subprocess, "Popen") as process:
            process.return_value.communicate.return_value = (Result.stdout, None)
            process.return_value.returncode = 0
            with self.assertRaises(ValueError):
                executor.run_generator(self.task, {}, {}, self.root, ["dummy"])

    def test_cards_require_verified_taxonomy_and_include_package_weight(self):
        payload = {"subject_id": 123, "brand":"Confirmed", "length_cm":11, "width_cm":7, "height_cm":3, "weight_kg":.1,
                   "characteristics":[{"id":42,"value":["Steel"]}],
                   "items":[{"vendor_code":"REAL-SKU","title":"Товар","description":"Описание","barcode":"0123456789012"}]}
        cards = executor.construct_wb_cards_upload_payload(payload)
        var = cards[0]["variants"][0]
        self.assertEqual(cards[0]["subjectID"],123)
        self.assertEqual(var["dimensions"]["weightBrutto"],.1)
        self.assertNotIn("isValid",var["dimensions"])
        self.assertNotIn("price",var["sizes"][0])
        payload.pop("subject_id")
        with self.assertRaises(ValueError):
            executor.construct_wb_cards_upload_payload(payload)

    def test_no_default_secret_or_publishing_capability(self):
        with patch.object(executor, "CONFIG_PATH", self.root/"none"):
            with self.assertRaises(executor.GatewayError):
                executor.load_config(self.root/"none")
        self.assertEqual(executor.capabilities({})["publishing"],False)
        self.assertEqual(executor.capabilities({})["generation"],False)


class LeaseRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.clock = patch.object(executor.time, 'monotonic', side_effect=lambda: self.now)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        self.sleep = patch.object(executor.time, 'sleep', side_effect=self.advance)
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def advance(self, seconds):
        self.now += seconds

    def test_timeout_recovers_without_losing_lease(self):
        from unittest.mock import Mock
        gateway = Mock()
        gateway.call.side_effect = [executor.GatewayError('URLError'), executor.GatewayError('TimeoutError'), {'code': 0}]
        lease = executor.LeaseSession(gateway, {})
        self.assertEqual(lease.call('/api/executor/heartbeat', {}), {'code': 0})
        self.assertFalse(lease.lost.is_set())
        self.assertEqual(gateway.call.call_count, 3)
        self.assertEqual(lease.deadline, 176)

    def test_transport_failure_never_extends_unacknowledged_lease(self):
        from unittest.mock import Mock
        gateway = Mock()
        gateway.call.side_effect = executor.GatewayError('TimeoutError')
        lease = executor.LeaseSession(gateway, {})
        with self.assertRaises(executor.GatewayError):
            lease.call('/api/executor/heartbeat', {})
        self.assertEqual(lease.deadline, 170)
        self.assertTrue(lease.lost.is_set())
        self.assertLess(self.now, 180)

    def test_auth_or_ownership_rejection_stops_without_retry(self):
        from unittest.mock import Mock
        for status in (401, 403, 409):
            gateway = Mock()
            gateway.call.side_effect = executor.GatewayError('HTTP ' + str(status))
            lease = executor.LeaseSession(gateway, {})
            with self.assertRaises(executor.GatewayError):
                lease.call('/api/executor/heartbeat', {})
            self.assertTrue(lease.lost.is_set())
            self.assertEqual(gateway.call.call_count, 1)

    def test_expired_lease_never_contacts_gateway(self):
        from unittest.mock import Mock
        gateway = Mock()
        lease = executor.LeaseSession(gateway, {})
        self.now = 171
        with self.assertRaises(executor.GatewayError):
            lease.call('/api/tasks/update', {'status': 'generating_images'})
        gateway.call.assert_not_called()

    def test_generator_stops_on_lease_loss_even_without_new_progress(self):
        import subprocess
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as tmp, patch.object(executor.subprocess, 'Popen') as launch:
            process = launch.return_value
            process.communicate.side_effect = subprocess.TimeoutExpired('generator', 5)
            check = Mock(side_effect=executor.GatewayError('Lease lost'))
            with self.assertRaises(executor.GatewayError):
                executor.run_generator({'nmId':'1'}, {}, {}, Path(tmp), ['dummy'], check_lease=check)
            process.kill.assert_called_once()
            check.assert_called_once()


if __name__ == "__main__":
    unittest.main()
