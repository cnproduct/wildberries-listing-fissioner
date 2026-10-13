import io
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from scripts.wb_media_audit import media_roots, verify_gallery


class MediaAuditTests(unittest.TestCase):
    def setUp(self):
        self.card = {'nmID': 1884742078, 'vendorCode': 'real', 'photos': [{}, {}]}
        self.routes = {'origin': {'mediabasket_route_map': [{'method': 'range', 'hosts': [
            {'host': 'basket-53.wbbasket.ru', 'vol_range_from': 18822, 'vol_range_to': 19589}]}]}}
        def photo(color):
            b = io.BytesIO(); Image.new('RGB', (900, 1200), color).save(b, 'PNG'); return b.getvalue()
        self.red, self.blue = photo('red'), photo('blue')
        self.fetch = lambda url: self.red if '/1.webp' in url else self.blue

    def test_all_images_must_decode_not_just_count_or_http_success(self):
        for fetch in (lambda u: b'<html>error</html>', lambda u: self.red if '/1.webp' in u else None):
            r = verify_gallery(self.card, fetch, self.routes, expected_count=2, catalog_pics=2)
            self.assertFalse(r['gallery_bytes_verified'])

    def test_duplicate_images_are_not_a_complete_gallery(self):
        r = verify_gallery(self.card, lambda u: self.red, self.routes, expected_count=2)
        self.assertIn('duplicate_gallery_images', r['issues'])

    def test_routing_and_wrong_product_reference(self):
        self.assertIn('basket-53.wbbasket.ru/vol18847/part1884742/1884742078/', media_roots(self.card['nmID'], self.routes)[0])
        self.card['photos'][0]['big'] = 'https://basket-53.wbbasket.ru/vol0/part0/999999/images/big/1.webp'
        r = verify_gallery(self.card, self.fetch, self.routes, expected_count=2)
        self.assertIn('image_1_big_foreign_reference', r['issues'])

    def test_expected_content_order_and_ui_evidence_are_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            red, blue = Path(tmp)/'red.png', Path(tmp)/'blue.png'
            red.write_bytes(self.red); blue.write_bytes(self.blue)
            good = verify_gallery(self.card, self.fetch, self.routes, expected_count=2, expected_paths=[red, blue])
            self.assertTrue(good['expected_content_verified'])
            self.assertFalse(good['browser_interaction_verified'])
            wrong = verify_gallery(self.card, self.fetch, self.routes, expected_count=2, expected_paths=[blue, red])
            self.assertFalse(wrong['expected_content_verified'])

