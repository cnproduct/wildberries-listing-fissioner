"""Read-only gallery verification: records, current CDN bytes and expected images.

Never treats a photo count or a successful HTTP response as a usable gallery.
The browser interaction status is a separate field; this module cannot prove it.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import re
from pathlib import Path
from urllib.parse import urlparse,quote
from PIL import Image, ImageChops, ImageStat
try:
    from .wb_source import resource
    from .runtime_files import write_json
except ImportError:
    from wb_source import resource
    from runtime_files import write_json

HOST = re.compile(r'(?:basket-[0-9]+\.(?:wbbasket|wb)\.ru|[a-z]{3}-basket-cdn-[0-9]+\.geobasket\.ru)')


def media_roots(nm_id, routing):
    nm=int(nm_id);vol=nm//100000;hosts=[]
    for section in ('recommend','origin'):
        for route in routing.get(section,{}).get('mediabasket_route_map',[]):
            hs=route.get('hosts',[]);selected=None
            if route.get('method')=='mod' and hs:selected=hs[nm%len(hs)]
            if route.get('method')=='range':selected=next((h for h in hs if h.get('vol_range_from',0)<=vol<=h.get('vol_range_to',-1)),None)
            host=(selected or {}).get('host','')
            if HOST.fullmatch(host) and host not in hosts:hosts.append(host)
    return [f'https://{host}/vol{vol}/part{nm//1000}/{nm}/' for host in hosts]


def inspect_image(payload, full_size=True):
    if not payload or len(payload)>32*1024*1024:raise ValueError('empty_or_oversize_image')
    with Image.open(io.BytesIO(payload)) as image:
        image.load()
        if image.format not in ('JPEG','PNG','WEBP','GIF','BMP') or getattr(image,'n_frames',1)>1:raise ValueError('invalid_image_format')
        if full_size and (image.width<700 or image.height<900):raise ValueError('image_resolution_too_small')
        rgb=image.convert('RGB')
        digest=hashlib.sha256(payload).hexdigest()
        pixels=hashlib.sha256(rgb.tobytes()).hexdigest()
        gray=rgb.resize((16,16)).convert('L');values=list(gray.getdata());mean=sum(values)/len(values)
        ahash=f'{sum((1<<i) for i,v in enumerate(values) if v>=mean):064x}'
        return {'width':image.width,'height':image.height,'format':image.format,'bytes':len(payload),'sha256':digest,'pixel_sha256':pixels,'average_hash':ahash}


def image_distance(payload, expected_path):
    with Image.open(io.BytesIO(payload)) as actual, Image.open(expected_path) as expected:
        a=actual.convert('RGB').resize((96,128));b=expected.convert('RGB').resize((96,128))
        return math.sqrt(sum(v*v for v in ImageStat.Stat(ImageChops.difference(a,b)).rms)/3)/255


def verify_gallery(card, fetch_bytes, routing, *, expected_count=None, expected_paths=None, catalog_pics=None, output=None):
    nm=str(card.get('nmID',''))
    if not re.fullmatch(r'[0-9]{6,13}',nm):raise ValueError('invalid_nm_id')
    photos=card.get('photos') or []
    expected_count=expected_count if expected_count is not None else len(photos)
    if not isinstance(expected_count,int) or isinstance(expected_count,bool) or not 1<=expected_count<=30:raise ValueError('explicit_gallery_count_required')
    if expected_paths is not None and len(expected_paths)!=expected_count:raise ValueError('expected_image_count_mismatch')
    roots=media_roots(nm,routing)
    issues=[];rows=[]
    if len(photos)!=expected_count:issues.append('seller_photo_count_mismatch')
    if catalog_pics is not None and catalog_pics!=expected_count:issues.append('catalog_photo_count_mismatch')
    folder=Path(output) if output else None
    if folder:folder.mkdir(parents=True,exist_ok=True)
    for index in range(1,expected_count+1):
        photo=photos[index-1] if index<=len(photos) else {}
        row={'index':index,'resolutions':{}}
        for variant in ('big','c246x328'):
            raw_url=photo.get(variant)
            candidates=[]
            # Resolve current official routing first; old Content API hosts can be stale.
            for root in roots:candidates.append(root+f'images/{variant}/{index}.webp')
            if raw_url:
                url=urlparse(raw_url)
                suffix=f'/vol{int(nm)//100000}/part{int(nm)//1000}/{nm}/images/{variant}/{index}.webp'
                if url.scheme=='https' and HOST.fullmatch(url.hostname or '') and not url.username and not url.password and not url.port and url.path==suffix:
                    if raw_url not in candidates:candidates.append(raw_url)
                else:issues.append(f'image_{index}_{variant}_foreign_reference')
            result=None;raw=None
            for candidate in candidates:
                try:
                    raw=fetch_bytes(candidate);meta=inspect_image(raw,variant=='big')
                    result={**meta,'url':candidate};break
                except (OSError,ValueError,TypeError):continue
            if not result:
                issues.append(f'image_{index}_{variant}_unavailable');row['resolutions'][variant]={'verified':False};continue
            row['resolutions'][variant]={'verified':True,**result}
            if raw_url and raw_url!=result['url']:row['resolutions'][variant]['api_url_differs']=True
            if variant=='big':
                if folder:
                    dest=folder/f'{index:02d}.webp';dest.write_bytes(raw);row['local_path']=str(dest)
                if expected_paths is not None:
                    distance=image_distance(raw,expected_paths[index-1]);row['expected_image_distance']=distance
                    if distance>.05:issues.append(f'image_{index}_content_or_order_mismatch')
        rows.append(row)
    full=[r['resolutions'].get('big',{}) for r in rows if r['resolutions'].get('big',{}).get('verified')]
    unique=len({r['pixel_sha256'] for r in full})
    if len(full)==expected_count and unique!=expected_count:issues.append('duplicate_gallery_images')
    result={'nm_id':nm,'vendor_code':card.get('vendorCode'),'expected_count':expected_count,'seller_photo_count':len(photos),
        'catalog_pics':catalog_pics,'decoded_full_images':len(full),'unique_full_images':unique,
        'gallery_bytes_verified':not issues,'expected_content_verified':not issues and expected_paths is not None,
        'browser_interaction_verified':False,'issues':issues,'images':rows}
    if folder:write_json(folder/'audit.json',result)
    return result


def main():
    parser=argparse.ArgumentParser(description='Read-only WB gallery audit; never changes stock, price or cards')
    parser.add_argument('--expected-count',type=int,required=True)
    parser.add_argument('--vendor-prefix',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    try:from .antigravity_executor import load_config,Gateway,request_json
    except ImportError:from antigravity_executor import load_config,Gateway,request_json
    config=load_config();gateway=Gateway(config)
    def api(url,data=None,seller=False):
        headers={'Authorization':'Bearer '+config['EXECUTOR_SECRET']}
        if seller:headers['X-WB-Token']=config['WB_API_TOKEN']
        return request_json(config['GATEWAY_URL']+'/api/wb-proxy?url='+quote(url,safe=''),'POST' if data is not None else 'GET',data,headers,timeout=45,opener=gateway.open)
    # Walk the API cursor rather than assuming requested cards are in the first page.
    cards=[];cursor={'limit':100};seen=set()
    while True:
        page=api('https://content-api.wildberries.ru/content/v2/get/cards/list',{'settings':{'cursor':cursor,'filter':{'withPhoto':-1}}},True)
        batch=page.get('cards',[])
        cards.extend(c for c in batch if c.get('vendorCode','').startswith(args.vendor_prefix))
        nxt=page.get('cursor',{})
        if len(batch)<100:break
        marker=(nxt.get('updatedAt'),nxt.get('nmID'))
        if not all(marker) or marker in seen:raise RuntimeError('card_pagination_did_not_advance')
        seen.add(marker);cursor={**nxt,'limit':100};cursor.pop('total',None)
    if not cards:raise RuntimeError('no_matching_cards')
    routing=json.loads(resource(config,'https://cdn.wbbasket.ru/api/v3/upstreams') or b'{}')
    public={}
    for offset in range(0,len(cards),50):
        ids=';'.join(str(c['nmID']) for c in cards[offset:offset+50])
        data=api('https://card.wb.ru/cards/v4/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm='+ids)
        public.update({str(p['id']):p for p in data.get('products',data.get('data',{}).get('products',[]))})
    args.output.mkdir(parents=True,exist_ok=True)
    def audit(card):
        result=verify_gallery(card,lambda u:resource(config,u),routing,expected_count=args.expected_count,
            catalog_pics=public.get(str(card['nmID']),{}).get('pics',0),output=args.output/str(card['nmID']))
        print(json.dumps({k:result[k] for k in ('vendor_code','nm_id','decoded_full_images','unique_full_images','gallery_bytes_verified','issues')},ensure_ascii=False),flush=True)
        return result
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(audit,cards))
    write_json(args.output/'summary.json',{'cards':results,'all_gallery_bytes_verified':all(r['gallery_bytes_verified'] for r in results),'browser_interaction_verified':False})

if __name__=='__main__':main()
