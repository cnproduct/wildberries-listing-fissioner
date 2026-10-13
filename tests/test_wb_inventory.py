import unittest
from scripts.wb_inventory import inventory_payload, verify_inventory

class InventoryTests(unittest.TestCase):
    def test_user_default_five_and_actual_readback_required(self):
        p=inventory_payload([{'nmID':123,'sizes':[{'chrtID':456}]}])
        self.assertEqual(p,{'stocks':[{'chrtId':456,'amount':5}]})
        self.assertTrue(verify_inventory(p,p))
        self.assertFalse(verify_inventory(p,{'stocks':[]}))
        self.assertFalse(verify_inventory(p,{'stocks':[{'chrtId':456,'amount':100}]}))
    def test_multi_size_and_duplicate_identity_do_not_multiply_stock(self):
        card={'nmID':123,'sizes':[{'chrtID':456}]}
        for cards in ([card,card],[{'nmID':123,'sizes':[{'chrtID':456},{'chrtID':457}]}]):
            with self.assertRaises(ValueError):inventory_payload(cards)
    def test_invalid_quantities_rejected(self):
        for amount in (True,-1,2.5,'5'):
            with self.assertRaises(ValueError):inventory_payload([{'nmID':123,'sizes':[{'chrtID':456}]}],amount)
