import unittest
from copy import deepcopy
from scripts.wb_detail_update import build_detail_update, verify_detail_readback


class DetailUpdateTests(unittest.TestCase):
    def setUp(self):
        self.card = {'nmID': 1234567, 'vendorCode': 'real', 'brand': 'Real',
            'title': 'Маска', 'description': 'Verified description',
            'dimensions': {'length': 9, 'width': 8, 'height': 7, 'weightBrutto': .2, 'isValid': True},
            'sizes': [{'chrtID': 456, 'techSize': '0', 'wbSize': '', 'skus': ['123']}],
            'characteristics': [{'id': 1, 'name': 'Volume', 'value': 200}, {'id': 2, 'value': ['Unverified']}],
            'kizMarked': False, 'photos': [{'big': 'https://example.test/image'}]}

    def test_description_edit_preserves_brand_sizes_and_dimensions(self):
        p = build_detail_update(self.card, {'description': 'Corrected description'})
        for field in ('brand', 'sizes', 'vendorCode', 'kizMarked'):
            self.assertEqual(p[field], self.card[field])
        self.assertNotIn('photos', p)
        self.assertNotIn('isValid', p['dimensions'])
        p['sizes'][0]['skus'].append('456')
        self.assertEqual(self.card['sizes'][0]['skus'], ['123'])

    def test_attribute_loss_requires_explicit_review(self):
        changes = {'characteristics': [{'id': 1, 'value': 200}]}
        with self.assertRaises(ValueError): build_detail_update(self.card, changes)
        p = build_detail_update(self.card, changes, removed_characteristic_ids=[2])
        self.assertEqual(len(p['characteristics']), 1)

    def test_readback_ignores_attribute_order_but_detects_fact_and_barcode_changes(self):
        p = build_detail_update(self.card, {'description': 'Corrected'})
        actual = deepcopy(p); actual['characteristics'].reverse()
        self.assertEqual(verify_detail_readback(p, actual), [])
        actual['brand'] = ''; actual['sizes'][0]['skus'] = ['999']
        actual['characteristics'][1]['value'] = 201
        self.assertEqual(set(verify_detail_readback(p, actual)), {'brand_mismatch', 'characteristics_mismatch', 'sizes_or_barcodes_mismatch'})

    def test_price_stock_identity_and_blank_brand_cannot_be_changed(self):
        for changes in ({'price': 590}, {'stock': 100}, {'nmID': 999}, {'brand': ''}, {'title': 'a'*61}):
            with self.assertRaises(ValueError): build_detail_update(self.card, changes)

