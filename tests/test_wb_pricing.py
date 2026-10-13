import unittest
from scripts.wb_pricing import (
    calculate_fission_prices,
    get_fission_price_values,
    extract_base_price_from_source,
    build_wb_price_upload_payload,
    verify_fission_price_distribution,
    DEFAULT_UPPER_RATIOS,
    DEFAULT_LOWER_RATIOS
)


class TestWbPricing(unittest.TestCase):
    def test_pricing_strategy_produces_ten_distinct_prices(self):
        for base in [50, 100, 350, 590, 1000, 3110, 5558, 12000]:
            with self.subTest(base=base):
                items = calculate_fission_prices(base)
                self.assertEqual(len(items), 10)
                prices = [item["price"] for item in items]
                # Every single price must be distinct!
                self.assertEqual(len(set(prices)), 10)
                
                # Check tiers
                up = items[:5]
                down = items[5:]
                
                for i, item in enumerate(up, 1):
                    self.assertEqual(item["index"], i)
                    self.assertEqual(item["tier"], "upper")
                    self.assertGreater(item["price"], base)
                    ratio = (item["price"] - base) / base
                    self.assertGreaterEqual(ratio, 0.01)
                    # Allow slight margin for integer rounding on small bases
                    self.assertLessEqual(ratio, 0.20 if base < 100 else 0.16)
                    
                for i, item in enumerate(down, 6):
                    self.assertEqual(item["index"], i)
                    self.assertEqual(item["tier"], "lower")
                    self.assertLess(item["price"], base)
                    ratio = (item["price"] - base) / base
                    self.assertLessEqual(ratio, -0.01)
                    self.assertGreaterEqual(ratio, -0.15 if base < 100 else -0.11)

                valid, msg = verify_fission_price_distribution(base, prices)
                self.assertTrue(valid, msg)

    def test_get_fission_price_values(self):
        prices = get_fission_price_values(590)
        self.assertEqual(len(prices), 10)
        self.assertEqual(len(set(prices)), 10)
        self.assertEqual(prices, [602, 620, 637, 655, 678, 578, 566, 555, 543, 531])

    def test_invalid_base_prices_rejected(self):
        for invalid in [0, -100, True, False, "590", float("nan"), float("inf"), None]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    calculate_fission_prices(invalid)

    def test_invalid_counts_and_ratios_rejected(self):
        with self.assertRaises(ValueError):
            calculate_fission_prices(590, count=8)
        with self.assertRaises(ValueError):
            calculate_fission_prices(590, up_ratios=[0.02, 0.05, 0.08, 0.11])  # Only 4
        with self.assertRaises(ValueError):
            calculate_fission_prices(590, up_ratios=[0.02, 0.05, 0.08, 0.11, 0.25])  # > 15%
        with self.assertRaises(ValueError):
            calculate_fission_prices(590, down_ratios=[-0.02, -0.04, -0.06, -0.08, -0.15])  # < -10%

    def test_extract_base_price_from_source(self):
        evidence_kopecks = {
            "product": {
                "id": 1879785812,
                "sizes": [
                    {
                        "price": {
                            "basic": 731900,
                            "product": 311000
                        }
                    }
                ]
            }
        }
        self.assertEqual(extract_base_price_from_source(evidence_kopecks), 3110)

        evidence_rubles = {"product": {"price": 590}}
        self.assertEqual(extract_base_price_from_source(evidence_rubles), 590)

        self.assertIsNone(extract_base_price_from_source({}))
        self.assertIsNone(extract_base_price_from_source(None))

    def test_build_wb_price_upload_payload(self):
        nmids = [1884742000 + i for i in range(10)]
        prices = get_fission_price_values(590)
        payload = build_wb_price_upload_payload(nmids, prices, default_discount=15)
        
        self.assertIn("data", payload)
        self.assertEqual(len(payload["data"]), 10)
        for i, entry in enumerate(payload["data"]):
            self.assertEqual(entry["nmID"], nmids[i])
            self.assertEqual(entry["price"], prices[i])
            self.assertEqual(entry["discount"], 15)

    def test_build_wb_price_upload_payload_rejects_duplicates_and_invalid(self):
        nmids = [1884742000 + i for i in range(10)]
        # Duplicate prices
        dup_prices = [500] * 10
        with self.assertRaisesRegex(ValueError, "unique price"):
            build_wb_price_upload_payload(nmids, dup_prices)

        # Invalid count
        with self.assertRaises(ValueError):
            build_wb_price_upload_payload(nmids[:8], [500]*8)

        # Invalid discount
        with self.assertRaises(ValueError):
            build_wb_price_upload_payload(nmids, get_fission_price_values(590), default_discount=150)


if __name__ == "__main__":
    unittest.main()
