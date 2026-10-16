import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from scripts import wb_upload_fixed as wb

class UploadTests(unittest.TestCase):
    def setUp(self):
        self.payload={'brand':'Real','length_cm':9,'width_cm':8,'height_cm':7,'weight_kg':.26,
            'characteristics_tpl':[{'id':42,'value':['Actual']}],
            'items':[{'version_id':'real-1','title':'Товар','description':'Описание'}]}
    def test_invalid_specs_and_fact_overrides_are_rejected(self):
        for value in (0,-1,float('nan'),float('inf'),True):
            with self.assertRaises(ValueError):wb.construct_wb_cards_upload_payload({**self.payload,'weight_kg':value},360,['123'])
        self.payload['items'][0]['charc_overrides']={'42':['different']}
        with self.assertRaises(ValueError):wb.construct_wb_cards_upload_payload(self.payload,360,['123'])
    def test_barcode_counts_and_title_limit_are_not_silently_truncated(self):
        with self.assertRaises(ValueError):wb.construct_wb_cards_upload_payload(self.payload,360,[])
        self.payload['items'][0]['title']='a'*61
        with self.assertRaises(ValueError):wb.construct_wb_cards_upload_payload(self.payload,360,['123'])
    def test_no_write_before_explicit_authorization_and_image_validation(self):
        with patch.object(wb,'_wb_post') as post:
            with self.assertRaises(ValueError):wb.execute_upload(self.payload,360,'test',{})
            with self.assertRaises(ValueError):wb.execute_upload({**self.payload,'facts_verified':True},360,'test',{},authorized=True,checkpoint='/tmp/not-written.json')
            post.assert_not_called()
    def test_explicit_unbranded_selection_omits_brand_without_inventing_one(self):
        payload={**self.payload,'brand':'','omit_brand':True}
        card=wb.construct_wb_cards_upload_payload(payload,360,['123'])[0]['variants'][0]
        self.assertNotIn('brand',card)
        with self.assertRaises(ValueError): wb.construct_wb_cards_upload_payload({**payload,'brand':'Other'},360,['123'])
        with self.assertRaises(ValueError): wb.construct_wb_cards_upload_payload({**payload,'omit_brand':False},360,['123'])
    def test_gateway_transport_is_scoped_and_restored_after_failure(self):
        def gateway(*args): raise RuntimeError('gateway unavailable')
        with self.assertRaises(RuntimeError):
            with wb.using_transport(gateway): wb._wb_post('private','/path',{})
        self.assertIsNone(wb._transport.get())
    def test_local_photo_uses_multipart_file_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            photo=Path(tmp)/'image.png';Image.new('RGB',(720,960)).save(photo)
            with patch.object(wb,'_wb_request',return_value=(200,{'error':False})) as request,patch.object(wb.time,'sleep'):
                self.assertEqual(wb.upload_card_media('dummy',123,[str(photo)]),1)
            args=request.call_args.args
            self.assertEqual(args[1],'/content/v3/media/file');self.assertIn(b'name="uploadfile"',args[2]);self.assertEqual(args[4]['X-Nm-Id'],'123')

    def test_incomplete_new_gallery_rejected_before_any_seller_write(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(wb,'_wb_post') as post:
            photo=Path(tmp)/'photo.png';Image.new('RGB',(720,960)).save(photo)
            with self.assertRaisesRegex(ValueError,'complete planned gallery'):
                wb.execute_upload({**self.payload,'facts_verified':True},360,'test',{'real-1':[str(photo)]},authorized=True,checkpoint=Path(tmp)/'state.json')
            post.assert_not_called()
    def test_http_200_with_business_error_is_rejected(self):
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self):return b'{"error":true,"errorText":"private detail"}'
        with patch.object(wb.urllib.request,'urlopen',return_value=Response()):
            with self.assertRaisesRegex(RuntimeError,'wb_api_rejected'):wb._wb_post('dummy','/path',{})
    def test_upload_first_accepts_available_gallery_and_reads_it_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            photo=Path(tmp)/'photo.png';Image.new('RGB',(720,960)).save(photo)
            with patch.object(wb,'_find_card',return_value=None),patch.object(wb,'allocate_barcodes',return_value=['123']),patch.object(wb,'_wb_post') as post,patch.object(wb,'upload_card_media') as media,patch.object(wb,'wait_for_cards',return_value={'real-1':123}) as readback:
                result=wb.execute_upload({**self.payload,'facts_verified':True},360,'test',{'real-1':[str(photo)]},authorized=True,checkpoint=Path(tmp)/'state.json',expected_images_per_card=None)
                self.assertEqual(result,{'real-1':123})
                self.assertEqual(readback.call_args.kwargs['expected_images'],{'real-1':1})
                media.assert_called_once();post.assert_called_once()
    def test_wrong_product_or_missing_photos_never_pass_readback(self):
        with patch.object(wb,'_wb_post',return_value=(200,{'cards':[{'vendorCode':'other','nmID':123,'photos':[{}]}]})):
            self.assertIsNone(wb._find_card('dummy','wanted'))
        with patch.object(wb,'_find_card',return_value={'nmID':123,'photos':[]}),patch.object(wb.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'pending_timeout'):
                wb.wait_for_cards('dummy',['wanted'],timeout=.001,expected_images={'wanted':1})
