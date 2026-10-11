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
