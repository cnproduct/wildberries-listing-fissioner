#!/usr/bin/env python3
"""Unit tests for Antigravity backend executor."""

import tempfile
import unittest
from pathlib import Path
from PIL import Image

from scripts.antigravity_executor import (
    generate_fission_variants,
    construct_wb_cards_upload_payload,
    create_compliant_cover_image,
    CREATIVE_ANGLES
)


class TestAntigravityExecutor(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_executor_"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_creative_angles_count_and_titles(self):
        self.assertEqual(len(CREATIVE_ANGLES), 10)
        for idx, angle in enumerate(CREATIVE_ANGLES, 1):
            self.assertTrue(len(angle["title"]) <= 60, f"Title {angle['title']} exceeds 60 chars")
            self.assertTrue(len(angle["title"]) >= 20, f"Title {angle['title']} too short")
            self.assertTrue(len(angle["keywords"]) >= 2)

    def test_compliant_cover_image_specs(self):
        img_path = self.temp_dir / "test_cover.jpg"
        result_path = create_compliant_cover_image(img_path, CREATIVE_ANGLES[0], "1520898783")
        self.assertTrue(Path(result_path).exists())
        with Image.open(result_path) as img:
            self.assertEqual(img.size, (900, 1200))
            self.assertEqual(img.format, "JPEG")
            # 3:4 ratio check
            self.assertEqual(img.width * 4, img.height * 3)

    def test_generate_fission_variants(self):
        payload = generate_fission_variants("1520898783", self.temp_dir)
        self.assertEqual(payload["manifest_version"], 2)
        self.assertEqual(len(payload["items"]), 10)
        self.assertEqual(payload["category"], "Термосы и термокружки")
        self.assertEqual(payload["country"], "Китай")
        for item in payload["items"]:
            self.assertTrue(Path(item["image_path"]).exists())
            self.assertTrue(len(item["title"]) <= 60)
            self.assertTrue(item["barcode"].startswith("460"))
            self.assertGreater(item["price"], 0)

    def test_construct_wb_cards_upload_payload(self):
        payload = generate_fission_variants("1520898783", self.temp_dir)
        cards = construct_wb_cards_upload_payload(payload)
        self.assertEqual(len(cards), 10)
        for card in cards:
            self.assertEqual(card["subjectID"], 607)
            self.assertEqual(len(card["variants"]), 1)
            var = card["variants"][0]
            self.assertEqual(var["dimensions"]["length"], 22)
            self.assertTrue(var["dimensions"]["isValid"])
            self.assertEqual(len(var["sizes"]), 1)
            self.assertEqual(len(var["sizes"][0]["skus"]), 1)


if __name__ == "__main__":
    unittest.main()
