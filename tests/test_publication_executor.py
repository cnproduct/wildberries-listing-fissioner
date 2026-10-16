import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote
from PIL import Image
from scripts.publication_executor import validate_plan, execute_publication, plan_path


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        photos=[]
        for i in range(8):
            p=self.root/f'{i}.png';Image.new('RGB',(720,960),(i*25,50,100)).save(p);photos.append(str(p))
        self.manifest=self.root/'manifest.json'
        rows=[{'title':f'Товар {i}','description':'Описание','sha256':hashlib.sha256(Path(photos[0]).read_bytes()).hexdigest()} for i in range(10)]
        self.manifest.write_text(json.dumps({'items':rows}))
        self.task={'key':'task:owner:request','task_id':'request','nmId':'1586452643','sender_id':'owner','publication':{'store':'RR010'},'details':{'manifest_path':str(self.manifest)}}
        self.plan={'task_id':'request','source_nm_id':'1586452643','store':'RR010','manifest_sha256':hashlib.sha256(self.manifest.read_bytes()).hexdigest(),
            'store_authorization_verified':True,'facts_verified':True,'visual_review_verified':True,'base_price':1000,'discount':50,'currency':'RUB','subject_id':250,'warehouse_id':'10',
            'payload':{'brand':'','omit_brand':True,'length_cm':22,'width_cm':1,'height_cm':1,'weight_kg':.205,'characteristics_tpl':[{'id':42,'value':['confirmed']}],
                'items':[{'version_id':f'variant-{i}','title':r['title'],'description':r['description']} for i,r in enumerate(rows)]},
            'galleries':{f'variant-{i}':photos for i in range(10)}}
    def test_complete_plan_is_bound_to_actual_batch_and_gallery(self):
        self.assertEqual(validate_plan(self.plan,self.task),[])
        self.plan['galleries']['variant-0']=self.plan['galleries']['variant-0'][:1]
        self.assertEqual(validate_plan(self.plan,self.task),[])
        self.plan['galleries']['variant-0']=[]
        self.assertIn('complete_gallery',validate_plan(self.plan,self.task))
        self.plan['store']='RR012'
        with self.assertRaises(ValueError):validate_plan(self.plan,self.task)
    def test_quality_and_price_are_deferred_but_required_facts_and_file_integrity_remain(self):
        self.plan['visual_review_verified']=False;self.plan['facts_verified']=False;self.plan['base_price']=None
        self.plan['galleries']['variant-0']=[self.plan['galleries']['variant-0'][0]]*8
        missing=validate_plan(self.plan,self.task)
        for field in ['verified_package_specs','complete_gallery']:self.assertIn(field,missing)
        for field in ['visual_review','verified_price']:self.assertNotIn(field,missing)
        self.plan['payload']['items'][0]['description']='changed'
        with self.assertRaises(ValueError):validate_plan(self.plan,self.task)
    def test_no_plan_records_missing_inputs_without_any_seller_write(self):
        calls=[]
        class Gateway:
            def call(self,path,data=None):
                calls.append((path,data))
                return {'publication':{'lease_id':'lease'}} if path.endswith('/claim') else {}
        with patch('scripts.publication_executor.wb.execute_upload') as upload:
            execute_publication(self.task,Gateway(),{'PUBLICATION_ROOT':str(self.root/'plans')},'worker')
            upload.assert_not_called()
        self.assertTrue(any(d and d.get('state')=='needs_input' for _,d in calls))
        self.assertTrue(any(p.endswith('/preflight') for p,_ in calls))
    def test_plan_path_is_owned_by_exact_task_and_store(self):
        self.assertNotEqual(plan_path(self.task,{}),plan_path({**self.task,'task_id':'other'},{}))
        self.task['publication']['store']='../RR010'
        with self.assertRaises(ValueError):plan_path(self.task,{})
    def test_unconfirmed_or_wrong_seller_binding_blocks_even_a_resumed_request(self):
        config={'PUBLICATION_ROOT':str(self.root/'plans')}
        file=plan_path(self.task,config);file.parent.mkdir(parents=True)
        calls=[]
        class Gateway:
            def call(self,path,data=None):
                calls.append((path,data))
                return {'publication':{'lease_id':'lease'}} if path.endswith('/claim') else {}
        for confirmed in [None,False]:
            self.plan['store_authorization_verified']=confirmed
            file.write_text(json.dumps(self.plan))
            with patch('scripts.publication_executor.wb.execute_upload') as upload:
                execute_publication(self.task,Gateway(),config,'worker')
                upload.assert_not_called()
            self.assertIn('store_authorization',calls[-1][1]['missing_fields'])
        self.assertFalse(any(p.startswith('/api/credentials') for p,_ in calls))
    def test_unconfirmed_discount_and_currency_do_not_block_card_upload(self):
        self.plan['currency']='CNY';self.assertEqual(validate_plan(self.plan,self.task),[])
        self.plan['discount_stages']=[50,30];self.assertEqual(validate_plan(self.plan,self.task),[])
        self.plan['discount_stages']=[30,50];self.plan['currency']=None;self.assertEqual(validate_plan(self.plan,self.task),[])
    def test_upload_success_survives_pending_quality_missing_price_and_later_failure(self):
        mapping={f'variant-{i}':1000+i for i in range(10)}
        self.plan['visual_review_verified']=False;self.plan['base_price']=None
        for vc in self.plan['galleries']:self.plan['galleries'][vc]=self.plan['galleries'][vc][:1]
        config={'PUBLICATION_ROOT':str(self.root/'plans')}
        file=plan_path(self.task,config);file.parent.mkdir(parents=True);file.write_text(json.dumps(self.plan))
        calls=[]
        class Gateway:
            def call(self,path,data=None):
                calls.append((path,data))
                if path.endswith('/claim'):return {'publication':{'lease_id':'lease'}}
                if path.startswith('/api/credentials'):return {'credentials':{'shop_name':'RR010','api_token':'TOKEN'}}
                return {}
        with patch('scripts.publication_executor.wb.execute_upload',return_value=mapping) as upload,patch('scripts.publication_executor.wb._find_card',side_effect=lambda _,vc:{'nmID':mapping[vc]}) as find,patch('scripts.publication_executor.resource',return_value=b'{}'),patch('scripts.publication_executor.verify_gallery',return_value={'expected_content_verified':True}) as media:
            execute_publication(self.task,Gateway(),config,'worker')
            receipt=next(d for _,d in calls if d and d.get('upload_verified'))
            self.assertEqual(len(receipt['nm_ids']),10)
            self.assertTrue(receipt['pending_improvements']);self.assertEqual(calls[-1][1]['state'],'needs_input')
            self.assertIn('已上传成功',calls[-1][1]['summary'])
            self.assertFalse(json.loads(file.read_text())['visual_review_verified'])
            find.side_effect=RuntimeError('Readback temporarily unavailable')
            execute_publication(self.task,Gateway(),config,'worker')
            self.assertEqual(upload.call_count,1)
            self.assertEqual(calls[-1][1]['state'],'failed')
            self.assertIn('已上传成功',calls[-1][1]['summary'])
            self.assertTrue(json.loads((file.parent/'execution.json').read_text())['upload_verified'])
    def test_receipts_are_verified_and_retry_never_resets_stock_or_resubmits_price(self):
        import time
        config={'PUBLICATION_ROOT':str(self.root/'plans'),'EXECUTOR_SECRET':'PRIVATE'}
        file=plan_path(self.task,config);file.parent.mkdir(parents=True);file.write_text(json.dumps(self.plan))
        (file.parent/'execution.json').write_text(json.dumps({'plan_sha256':hashlib.sha256(json.dumps(self.plan,sort_keys=True).encode()).hexdigest(),'created_at':time.time()-3600}))
        updates=[];writes=[];current_discount=[51];current_currency=['RUB']
        class Response:
            status=200
            def __init__(self,value):self.value=value
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self):return json.dumps(self.value).encode()
        class Gateway:
            url='https://gateway.test'
            def call(self,path,data=None):
                if path.endswith('/claim'):return {'publication':{'lease_id':'lease'}}
                if path.startswith('/api/credentials'):return {'credentials':{'shop_name':'RR010','warehouse_id':'10','api_token':'TOKEN'}}
                updates.append(data);return {}
            def open(self,req,timeout):
                target=unquote(req.full_url.split('?url=')[1])
                if req.method in ['PUT','POST']:writes.append((req.method,target,json.loads(req.data)))
                if '/upload/task' in target:current_discount[0]=json.loads(req.data)['data'][0]['discount']
                if target.endswith('/api/v3/warehouses'):return Response([{'id':10}])
                if '/goods/filter' in target:
                    nm=int(target.split('filterNmID=')[1]);price=1000 if nm==1586452643 else [1020,1050,1080,1110,1150,980,960,940,920,900][nm-1000]
                    return Response({'data':{'listGoods':[{'nmID':nm,'discount':current_discount[0],'currencyIsoCode4217':current_currency[0],'sizes':[{'price':price}]}]}})
                if req.method=='POST' and '/stocks/' in target:return Response({'stocks':[{'chrtId':i+2000,'amount':5} for i in range(10)]})
                return Response({})
        mapping={f'variant-{i}':1000+i for i in range(10)}
        cards=[{'nmID':1000+i,'sizes':[{'chrtID':2000+i}]} for i in range(10)]
        with patch('scripts.publication_executor.wb.execute_upload',return_value=mapping) as upload,patch('scripts.publication_executor.wb._find_card',side_effect=lambda _,vc:cards[int(vc.split('-')[1])]),patch('scripts.publication_executor.resource',return_value=b'{}'),patch('scripts.publication_executor.verify_gallery',return_value={'expected_content_verified':True}):
            execute_publication(self.task,Gateway(),config,'worker')
            self.assertEqual(updates[-1]['state'],'submitted')
            self.assertEqual(len([x for x in writes if x[0]=='PUT']),1)
            self.assertEqual([x[2]['data'][0]['discount'] for x in writes if '/upload/task' in x[1]],[30,50])
            execute_publication(self.task,Gateway(),config,'worker')
            self.assertEqual(updates[-1]['state'],'submitted')
            before=upload.call_count;current_currency[0]='CNY'
            saved=json.loads((file.parent/'execution.json').read_text());saved.pop('price_verified');(file.parent/'execution.json').write_text(json.dumps(saved))
            execute_publication(self.task,Gateway(),config,'worker')
            self.assertEqual(updates[-1]['state'],'failed');self.assertEqual(upload.call_count,before)
            self.assertIn('已上传成功',updates[-1]['summary'])
        self.assertEqual(len([x for x in writes if x[0]=='PUT']),1)
        self.assertEqual([x[2]['data'][0]['discount'] for x in writes if '/upload/task' in x[1]],[30,50])
