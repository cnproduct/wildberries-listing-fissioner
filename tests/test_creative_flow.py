import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from scripts.creative_bundle import build_creative_bundle
from scripts.feishu_delivery import FeishuDelivery, DeliveryError
from scripts.wb_source import acquire_source
from scripts import antigravity_executor as executor


class CreativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        items = []
        for i in range(10):
            file = self.root / f'{i}.png'
            Image.new('RGB',(720,960),(i*20,20,40)).save(file)
            items.append({'scene_name':f'场景{i}', 'persona':'受众', 'title':f'Товар {i}',
                          'description':'Описание товара.', 'keywords':['товар'], 'image_path':str(file)})
        self.data = {'source_nm_id':'1879785812','review':{'subject_consistency_verified':True}, 'items':items}

    def test_creative_export_does_not_require_shipping_specs_barcodes_or_country(self):
        result = build_creative_bundle(self.data,self.root/'bundle')
        self.assertEqual(result['manifest']['count'],10)
        self.assertTrue(Path(result['archive_path']).is_file())
        self.assertFalse(result['manifest']['published'])
        self.data['items'][1]['image_path']=self.data['items'][0]['image_path']
        with self.assertRaisesRegex(ValueError,'Duplicate scene'):
            build_creative_bundle(self.data,self.root/'invalid')

    def test_delivery_receipts_resume_without_duplicate_messages(self):
        bundle=build_creative_bundle(self.data,self.root/'bundle')
        client=FeishuDelivery({})
        calls=[]
        client.upload=lambda path,kind:'key:'+Path(path).name
        client.send=lambda task,kind,content,label: calls.append((kind,label)) or 'message:'+label
        task={'task_id':'original','nmId':'1879785812','chat_id':'original_chat'}
        receipt=client.deliver(task,bundle,self.root/'delivery.json')
        self.assertEqual(len(receipt['scenes']),10)
        self.assertEqual(len(calls),12)
        client.deliver(task,bundle,self.root/'delivery.json')
        self.assertEqual(len(calls),12)
        self.assertEqual(calls[-2][0],'file')

    def test_failed_delivery_never_has_completion_receipt(self):
        bundle=build_creative_bundle(self.data,self.root/'bundle')
        client=FeishuDelivery({})
        client.upload=lambda *a:'key'
        client.send=lambda *a: (_ for _ in ()).throw(DeliveryError('failed'))
        with self.assertRaises(DeliveryError):
            client.deliver({'task_id':'original','nmId':'1879785812','chat_id':'chat'},bundle,self.root/'delivery.json')
        receipt=json.loads((self.root/'delivery.json').read_text())
        self.assertEqual(receipt['scenes'],{})
        self.assertNotIn('completion_message_id',receipt)

    def test_wrong_product_source_rejected_and_original_picture_is_sufficient(self):
        class Gateway:
            def call(self,*args):
                return {'product':{'id':123456789,'name':'Other'}}
        with self.assertRaisesRegex(ValueError,'mismatch'):
            acquire_source({'nmId':'1879785812'},Gateway(),{},self.root,{})
        class Exact:
            def call(self,*args):
                return {'product':{'id':1879785812,'name':'Original','pics':1}}
        evidence,facts=acquire_source({'nmId':'1879785812'},Exact(),{},self.root,{'source_images':[str(self.root/'0.png')]})
        self.assertTrue(facts['source_verified'])
        self.assertEqual(facts['product_name'],'Original')
        self.assertNotIn('weight_kg',facts)

    def test_creative_task_becomes_ready_only_after_ten_delivery_receipts(self):
        class Gateway:
            updates=[]
            def call(self, path, data):
                if path.endswith('/claim'):
                    return {'task':{'task_id':'original','nmId':'1879785812','chat_id':'chat','lease_id':'lease','attempts':1}}
                if path.endswith('/update'):
                    self.updates.append(data)
                return {'code':0}
        g=Gateway()
        config={'OUTPUT_ROOT':str(self.root/'output'),'FISSION_GENERATOR_CMD':['dummy']}
        generated={**self.data,'facts_verified':True}
        facts={'source_images':[str(self.root/'0.png')],'source_verified':True}
        receipt={'scenes':{str(i):f'm{i}' for i in range(10)},'archive_message_id':'filemsg'}
        with patch.object(executor,'acquire_source',return_value=({'product':{'id':1879785812}},facts)), \
             patch.object(executor,'run_generator',return_value=generated), \
             patch.object(FeishuDelivery,'deliver',return_value=receipt):
            self.assertEqual(executor.execute_task({'key':'task:user:original'},g,config,'worker'),'ready')
        final=g.updates[-1]
        self.assertTrue(final['details']['delivery_verified'])
        self.assertEqual(final['details']['delivered_scenes'],10)

    def test_current_wb_routing_uses_recommended_then_exact_origin(self):
        from scripts import wb_source
        calls=[]
        photo=(self.root/'0.png').read_bytes()
        class Gateway:
            def call(self,*args):return {'product':{'id':1879785812,'name':'Original','pics':1}}
        routing={'recommend':{'mediabasket_route_map':[{'method':'mod','hosts':[{'host':'mow-basket-cdn-34.geobasket.ru'}]}]},
                 'origin':{'mediabasket_route_map':[{'method':'range','hosts':[{'host':'basket-52.wbbasket.ru','vol_range_from':18054,'vol_range_to':18821}]}]}}
        def resource(config,url):
            calls.append(url)
            if url.endswith('/upstreams'):return json.dumps(routing).encode()
            if 'mow-basket' in url:return None
            if url.endswith('card.json'):return json.dumps({'nm_id':1879785812,'imt_name':'Original','description':'Source copy'}).encode()
            if url.endswith('1.webp'):return photo
            raise AssertionError('Unexpected source URL')
        with patch.object(wb_source,'resource',side_effect=resource):
            evidence,facts=acquire_source({'nmId':'1879785812'},Gateway(),{},self.root,{})
        self.assertTrue(facts['source_verified'])
        self.assertTrue(evidence['card_url'].startswith('https://basket-52.wbbasket.ru/vol18797/part1879785/1879785812/'))
        self.assertTrue(any('mow-basket-cdn-34' in u for u in calls))
        self.assertEqual(facts['source_description'],'Source copy')

    def test_partial_bundle_is_not_left_on_validation_failure(self):
        self.data['items'][8]['title']=''
        with self.assertRaises(ValueError):
            build_creative_bundle(self.data,self.root/'bad')
        self.assertFalse((self.root/'bad').exists())
        self.data['items'][8]['title']='Товар 8'
        build_creative_bundle(self.data,self.root/'bad')

    def test_bundle_can_recover_after_directory_commit_before_pointer_saved(self):
        first=build_creative_bundle(self.data,self.root/'bundle')
        self.assertEqual(build_creative_bundle(self.data,self.root/'bundle'),first)

    def test_corrupt_image_or_archive_cannot_be_delivered(self):
        from scripts.creative_bundle import validate_bundle
        bundle=build_creative_bundle(self.data,self.root/'bundle')
        (Path(bundle['manifest_path']).parent/'images/01.png').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'checksum'):
            validate_bundle(bundle,'1879785812')

    def test_receipts_cannot_be_reused_in_another_chat_or_revision(self):
        bundle=build_creative_bundle(self.data,self.root/'bundle')
        client=FeishuDelivery({});client.upload=lambda *a:'key';client.send=lambda *a:'message'
        task={'task_id':'task','nmId':'1879785812','chat_id':'original'}
        client.deliver(task,bundle,self.root/'receipt.json')
        with self.assertRaisesRegex(DeliveryError,'identity or revision'):
            client.deliver({**task,'chat_id':'other'},bundle,self.root/'receipt.json')
        receipt=json.loads((self.root/'receipt.json').read_text());receipt['binding']['revision']='different'
        (self.root/'receipt.json').write_text(json.dumps(receipt))
        with self.assertRaises(DeliveryError):client.deliver(task,bundle,self.root/'receipt.json')

    def test_lost_lease_during_upload_prevents_send(self):
        bundle=build_creative_bundle(self.data,self.root/'bundle')
        client=FeishuDelivery({});client.upload=lambda *a:'key'
        calls=[];client.send=lambda *a:calls.append(a)
        checks=iter([True,False])
        def owned():
            if not next(checks):raise executor.GatewayError('Lease lost')
        with self.assertRaises(executor.GatewayError):
            client.deliver({'task_id':'task','nmId':'1879785812','chat_id':'chat'},bundle,self.root/'r.json',before_send=owned)
        self.assertEqual(calls,[])

    def test_cached_generated_result_must_match_product_facts(self):
        data={**self.data,'facts_verified':True,'brand':'changed'}
        with self.assertRaises(ValueError):executor.validate_generated(data,{'nmId':'1879785812'},{'brand':'original'})
        with self.assertRaises(ValueError):executor.validate_generated(data,{'nmId':'1520898783'},{})

    def test_user_original_remains_usable_when_public_source_times_out(self):
        class Offline:
            def call(self,*a):raise executor.GatewayError('TimeoutError')
        _,facts=acquire_source({'nmId':'1879785812'},Offline(),{},self.root,{'source_images':[str(self.root/'0.png')],'product_name':'Original'})
        self.assertTrue(facts['source_verified'])

    def test_corrupt_source_cache_is_refetched_and_confirmed_brand_is_preserved(self):
        from scripts import wb_source
        (self.root/'source-cache.json').write_text('{broken')
        class Empty:
            def call(self,*a):return {'product':None}
        def resource(config,url):
            if url.endswith('upstreams'):return json.dumps({'origin':{'mediabasket_route_map':[{'method':'range','hosts':[{'host':'basket-52.wbbasket.ru','vol_range_from':1,'vol_range_to':99999}]}]}}).encode()
            if url.endswith('card.json'):return json.dumps({'nm_id':1879785812,'imt_name':'Source','selling':{'brand_name':'CDN'}}).encode()
            return (self.root/'0.png').read_bytes() if url.endswith('1.webp') else b'bad image'
        with patch.object(wb_source,'resource',side_effect=resource):
            _,facts=acquire_source({'nmId':'1879785812'},Empty(),{},self.root,{'brand':'Confirmed'})
        self.assertEqual(facts['brand'],'Confirmed');self.assertEqual(len(facts['source_images']),1)
