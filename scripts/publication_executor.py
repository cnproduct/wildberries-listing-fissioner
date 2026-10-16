"""Publish an authorized batch only from an owner-maintained, verified plan."""
import hashlib
import json
import time
import urllib.request
from pathlib import Path
from urllib.parse import quote
from scripts import wb_upload_fixed as wb
from scripts.runtime_files import read_cache, write_json
from scripts.wb_pricing import calculate_fission_prices, build_wb_price_upload_payload
from scripts.wb_inventory import inventory_payload, verify_inventory
from scripts.wb_source import resource
from scripts.wb_media_audit import verify_gallery


def plan_path(task, config):
    digest=hashlib.sha256(task['task_id'].encode()).hexdigest()[:16]
    store=task['publication']['store']
    if not store or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in store):
        raise ValueError('Invalid store binding')
    return Path(config.get('PUBLICATION_ROOT',Path.home()/'.config/wb-fission/publications'))/digest/store/'plan.json'


def validate_plan(plan, task):
    if not isinstance(plan,dict):
        return ['store_authorization','complete_gallery','verified_package_specs','brand']
    if plan.get('task_id')!=task['task_id'] or str(plan.get('source_nm_id'))!=str(task['nmId']) or plan.get('store')!=task['publication']['store']:
        raise ValueError('Publication plan binding mismatch')
    manifest_path=Path(task['details']['manifest_path'])
    if plan.get('manifest_sha256')!=hashlib.sha256(manifest_path.read_bytes()).hexdigest():
        raise ValueError('Publication plan belongs to another asset version')
    manifest=json.loads(manifest_path.read_text())
    payload=plan.get('payload') or {}
    missing=[]
    if plan.get('store_authorization_verified') is not True: missing.append('store_authorization')
    if plan.get('facts_verified') is not True: missing.append('verified_package_specs')
    if not payload.get('brand') and payload.get('omit_brand') is not True: missing.append('brand')
    try:
        wb.construct_wb_cards_upload_payload(payload,plan.get('subject_id'),[str(i+1) for i in range(10)])
    except (ValueError,TypeError,AttributeError): missing.append('verified_package_specs')
    items=payload.get('items') or []
    if len(items)!=10 or len(manifest.get('items',[]))!=10: missing.append('complete_gallery')
    else:
        for item, original in zip(items,manifest['items']):
            if item.get('title')!=original['title'] or item.get('description')!=original['description']:
                raise ValueError('Publication copy differs from approved batch')
            files=(plan.get('galleries') or {}).get(item.get('version_id'),[])
            try:
                wb._validate_images(files)
                hashes=[hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files]
                if not 1<=len(files)<=30 or len(set(hashes))!=len(files) or hashes[0]!=original['sha256']: missing.append('complete_gallery')
            except (ValueError,OSError,TypeError): missing.append('complete_gallery')
    return list(dict.fromkeys(missing))


def execute_publication(task, gateway, config, worker_id, store=None):
    key=task['key'];p=task['publication']
    if store and store!=p['store']: return
    claim=gateway.call('/api/tasks/publication/claim',{'key':key,'worker_id':worker_id,'store':store})
    lease=claim['publication']['lease_id']
    state={}
    def update(state,summary,**details):
        return gateway.call('/api/tasks/publication/update',{'key':key,'worker_id':worker_id,'lease_id':lease,'state':state,'summary':summary,**details})
    try:
        file=plan_path(task,config);plan=read_cache(file)
        missing=validate_plan(plan,task)
        if missing:
            names={'store_authorization':'目标店铺与实际授权账户核验','complete_gallery':'每款至少1张可上传的本批图片','verified_package_specs':'建卡必需的包装参数及类目属性','brand':'确认品牌或明确留空'}
            if plan and plan.get('owner_confirmations',{}).get('package_dimensions_cm'):
                names['verified_package_specs']='包装毛重与类目属性核验（包装尺寸已确认）'
            summary='上架指令已保留，待补齐：'+'；'.join(names[x] for x in missing)+'。现有图文不需要重新提交。'
            update('needs_input',summary)
            gateway.call('/api/tasks/publication/preflight',{'key':key,'store':p['store'],'missing_fields':missing,'summary':summary})
            return
        creds=gateway.call('/api/credentials?sender='+quote(task['sender_id'])).get('credentials') or {}
        if creds.get('shop_name','').upper()!=p['store'] or not creds.get('api_token'):
            raise ValueError('Publication credentials binding changed')
        def api(host,path,method='GET',body=None,content_type='application/json',extra_headers=None):
            update('checking','商品已上传成功，正在继续完善与核验。' if state.get('upload_verified') else '正在上传商品与保存执行断点。')
            headers={'Authorization':'Bearer '+config['EXECUTOR_SECRET'],'X-WB-Token':creds['api_token'],'Content-Type':content_type,**(extra_headers or {})}
            raw=json.dumps(body).encode() if body is not None and not isinstance(body,bytes) else body
            req=urllib.request.Request(gateway.url+'/api/wb-proxy?url='+quote('https://'+host+path,safe=''),data=raw,headers=headers,method=method)
            with gateway.open(req,timeout=45) if gateway.open else urllib.request.urlopen(req,timeout=45) as response:
                data=response.read();status=response.status
            result=json.loads(data) if data else {}
            if isinstance(result,dict) and (result.get('error') or result.get('code') and status!=204): raise RuntimeError('WB rejected publication step')
            return status,result
        checkpoint=file.parent/'execution.json'
        fingerprint=hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()
        saved=read_cache(checkpoint,{'plan_sha256':fingerprint})
        if saved.get('plan_sha256')!=fingerprint: raise ValueError('Existing publication checkpoint belongs to another plan')
        state=saved
        def content_transport(token,path,body,content_type,extra_headers):
            return api('content-api.wildberries.ru',path,'POST',body,content_type,extra_headers)
        if not state.get('upload_verified'):
            with wb.using_transport(content_transport):
                mapping=wb.execute_upload({**plan['payload'],'facts_verified':True},plan['subject_id'],creds['api_token'],plan['galleries'],authorized=True,checkpoint=file.parent/'cards.json',expected_images_per_card=None)
            if len(mapping)!=10 or len(set(mapping.values()))!=10 or any(type(n) is not int or n<=0 for n in mapping.values()): raise ValueError('Actual product IDs required')
            state.update(upload_verified=True,nm_ids=mapping)
        mapping=state['nm_ids']
        state.setdefault('created_at',time.time());write_json(checkpoint,state)
        vcs=[x['version_id'] for x in plan['payload']['items']];nmids=[mapping[x] for x in vcs]
        pending=[]
        if plan.get('visual_review_verified') is not True: pending.append('图片一致性待修改或复核')
        if any(len(plan['galleries'][vc])<8 for vc in vcs): pending.append('图库待补足8张')
        update('checking','10款商品已上传成功，真实货号与图片记录已读回；继续完善后续项目。',upload_verified=True,card_media_readback_verified=True,nm_ids=nmids,pending_improvements=pending)
        cards=[]
        with wb.using_transport(content_transport):
            for vc in vcs: cards.append(wb._find_card(creds['api_token'],vc))
        if not state.get('media_verified'):
            routing=json.loads(resource(config,'https://cdn.wbbasket.ru/api/v3/upstreams') or b'{}')
            def photograph(url):
                update('checking','正在核验实际商品图库内容、顺序和可读取性。')
                return resource(config,url)
            for card,vc in zip(cards,vcs):
                result=verify_gallery(card,photograph,routing,expected_count=len(plan['galleries'][vc]),expected_paths=plan['galleries'][vc],output=file.parent/('media-'+str(card['nmID'])))
                if not result['expected_content_verified']: raise RuntimeError('Published gallery differs from verified files')
            state['media_verified']=True;write_json(checkpoint,state)
        try:
            prices=[x['price'] for x in calculate_fission_prices(plan.get('base_price'))]
            if plan.get('discount_stages',[30,50])!=[30,50] or plan.get('discount')!=50 or plan.get('currency') not in ['RUB','CNY']: raise ValueError('Price inputs required')
        except (ValueError,TypeError):
            update('needs_input','10款商品已上传成功；价格与折扣待确认，确认后在现有商品继续设置。')
            return
        if not state.get('price_verified'):
            for nm in nmids:
                goods=api('discounts-prices-api.wildberries.ru',f'/api/v2/list/goods/filter?limit=10&filterNmID={nm}')[1].get('data',{}).get('listGoods',[])
                if not any(x.get('nmID')==nm and x.get('currencyIsoCode4217')==plan['currency'] for x in goods): raise ValueError('Target seller currency differs from verified plan')
            for discount in [30,50]:
                phase=state.setdefault('price_stages',{}).setdefault(str(discount),{})
                if phase.get('verified'):continue
                if not phase.get('requested_at'):
                    phase['requested_at']=time.time();write_json(checkpoint,state)
                    api('discounts-prices-api.wildberries.ru','/api/v2/upload/task','POST',build_wb_price_upload_payload(nmids,prices,discount))
                verified=True
                for nm,expected in zip(nmids,prices):
                    goods=api('discounts-prices-api.wildberries.ru',f'/api/v2/list/goods/filter?limit=10&filterNmID={nm}')[1].get('data',{}).get('listGoods',[])
                    row=next((x for x in goods if x.get('nmID')==nm),None)
                    if not row or row.get('currencyIsoCode4217')!=plan['currency'] or row.get('discount')!=discount or not row.get('sizes') or any(x.get('price')!=expected for x in row['sizes']): verified=False
                if not verified:
                    if time.time()-phase['requested_at']>900: raise RuntimeError('Price stage not verified within expected interval')
                    update('requested',f'10款商品已上传成功；正在等待{discount}%折扣生效并读回，核验后继续，不重复提交。',resume_at=int((time.time()+60)*1000))
                    return
                phase['verified']=True;write_json(checkpoint,state)
            state['price_verified']=True;write_json(checkpoint,state)
        # New cards need marketplace synchronization before the first stock write.
        if time.time()-state['created_at']<1800:
            update('requested','10款商品已上传成功，价格已核验；等待平台商品同步后初始化每款5件库存。',resume_at=int((state['created_at']+1800)*1000))
            return
        if not state.get('stock_verified'):
            if not plan.get('warehouse_id') or str(creds.get('warehouse_id'))!=str(plan['warehouse_id']): raise ValueError('Warehouse binding requires confirmation')
            warehouses=api('marketplace-api.wildberries.ru','/api/v3/warehouses')[1]
            if not isinstance(warehouses,list) or not any(str(w.get('id'))==str(plan['warehouse_id']) for w in warehouses): raise ValueError('Warehouse unavailable in bound store')
            stocks=inventory_payload(cards)
            endpoint='/api/v3/stocks/'+str(plan['warehouse_id'])
            if not state.get('stock_requested'):
                state['stock_requested']=True;write_json(checkpoint,state)
                api('marketplace-api.wildberries.ru',endpoint,'PUT',stocks)
            response=api('marketplace-api.wildberries.ru',endpoint,'POST',{'chrtIds':[x['chrtId'] for x in stocks['stocks']]})[1]
            if not verify_inventory(stocks,response): raise RuntimeError('Stock not verified')
            state['stock_verified']=True;write_json(checkpoint,state)
        update('submitted','10款商品已上传成功，现有图库、价格和初始库存已读回核验；图片精修按待完善项目继续，买家页面待核验。',nm_ids=nmids,media_verified=True,price_verified=True,stock_verified=True)
    except Exception:
        update('failed','10款商品已上传成功，后续完善或核验未完成；已保留货号与断点，继续处理现有商品。' if state.get('upload_verified') else '商品上传未完成，已保留断点；需核对已提交结果后继续，避免重复建卡。')
