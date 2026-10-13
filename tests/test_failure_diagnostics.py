import json
import tempfile
import unittest
from pathlib import Path
from scripts.failure_diagnostics import failure_details, failure_summary


class DiagnosticTests(unittest.TestCase):
    def test_quality_failure_retains_progress_without_exposing_private_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'generated').mkdir()
            (p/'generator.err.log').write_text('private token SECRET\nSource consistency review failed after retries at image 3\n')
            for n in (1,2):
                (p/'generated'/f'{n:02d}-accepted.json').write_text(json.dumps({'review':{'passed':True,'issues':[]}}))
            (p/'generated'/'03-try1-review.json').write_text(json.dumps({'issues':['Camera angle is frontal','extra product unit','garbled text SECRET']}))
            d=failure_details(RuntimeError('Generation program failed; see its private diagnostics'),p)
            self.assertEqual(d['reason_code'],'image_quality_failed');self.assertEqual(d['completed'],2)
            self.assertEqual(d['failed_image'],3);self.assertIn('extra_product',d['issue_codes'])
            self.assertNotIn('SECRET',json.dumps(d));self.assertIn('2/10',failure_summary(d))
            self.assertEqual(failure_details(TimeoutError('network'),p)['reason_code'],'connection_failed')

    def test_unknown_exception_does_not_fabricate_or_echo_cause(self):
        d=failure_details(RuntimeError('api_token=SECRET'))
        self.assertEqual(d['reason_code'],'unknown_failure');self.assertNotIn('SECRET',json.dumps(d))


    def test_native_404_identifies_generation_service_not_wb(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'generator.err.log').write_text('Native generation HTTP 404\n')
            d=failure_details(RuntimeError('Generation program failed'),p)
            self.assertEqual(d['reason_code'],'generation_model_unavailable')

    def test_ninth_image_does_not_hide_packaging_and_composition_errors_as_angle_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'generated').mkdir()
            (p/'generator.err.log').write_text('Source consistency review failed after retries at image 9\n')
            (p/'generated'/'09-try1-review.json').write_text(json.dumps({'issues':['Distorted Russian text on the lower front panel']}))
            (p/'generated'/'09-try2-review.json').write_text(json.dumps({'issues':['Camera angle is frontal', 'Outer carton display is positioned behind the bottle.']}))
            (p/'generated'/'09-try3-review.json').write_text(json.dumps({'issues':['Source promotional overlay was incorporated onto the carton packaging.']}))
            d=failure_details(RuntimeError('Generation program failed'),p)
            self.assertEqual(set(d['issue_codes']),{'camera_angle','label_distortion','composition_mismatch'})
