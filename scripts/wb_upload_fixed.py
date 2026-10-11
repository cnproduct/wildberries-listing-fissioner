"""Explicit seller upload helpers, separate from the default creative executor.

Contract: verified category/attributes and actual package measurements, explicit
publication authorization, and a private checkpoint. Returned nmIDs prove cards
and media readback only; prices, stock and storefront visibility remain separate.
API reference: https://dev.wildberries.ru/en/openapi/work-with-products
"""
import hashlib
import json
import math
import mimetypes
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path
from PIL import Image
try:
    from .runtime_files import write_json, read_cache
except ImportError:
    from runtime_files import write_json, read_cache

CONTENT = 'https://content-api.wildberries.ru'


def _wb_request(token, path, body, content_type='application/json', extra_headers=None):
    headers = {'Authorization':token, 'Content-Type':content_type, 'Accept':'application/json'}
    headers.update(extra_headers or {})
    raw = json.dumps(body, ensure_ascii=False).encode() if not isinstance(body, bytes) else body
    req = urllib.request.Request(CONTENT+path, data=raw, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            status, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        # Upstream body can echo customer data: keep it out of logs and replies.
        raise RuntimeError(f'wb_api_http_{error.code}') from None
    except (OSError, ValueError) as error:
        raise RuntimeError('wb_unreachable:' + type(error).__name__) from None
    if not isinstance(result, dict) or result.get('error'):
        raise RuntimeError('wb_api_rejected')
    return status, result


def _wb_post(token, path, body):
    return _wb_request(token, path, body)


def allocate_barcodes(token, count):
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 1000:
        raise ValueError('Invalid barcode count')
    _, result = _wb_post(token, '/content/v2/barcodes', {'count':count})
    codes = result.get('data', [])
    if len(codes) != count or len(set(codes)) != count or any(not str(c).isdigit() for c in codes):
        raise RuntimeError('barcode_unavailable')
    return [str(c) for c in codes]


def _positive(value, integer=False):
    if isinstance(value, bool) or not isinstance(value, (float,int)) or not math.isfinite(value) or value <= 0 or (integer and int(value) != value):
        raise ValueError('Package dimensions, weight and IDs must be real positive numbers')
    return int(value) if integer else value


def construct_wb_cards_upload_payload(payload, subject_id, barcodes):
    subject_id = _positive(subject_id, True)
    items = payload.get('items', [])
    if not items or len(items) != len(barcodes) or len(set(barcodes)) != len(barcodes):
        raise ValueError('Each card requires a unique barcode')
    if any(not isinstance(c,str) or not c.isdigit() for c in barcodes):
        raise ValueError('Invalid barcodes')
    brand = payload.get('brand')
    if not isinstance(brand, str) or not brand.strip():
        raise ValueError('Confirmed brand required')
    dims = {k:_positive(payload.get(k+'_cm'), True) for k in ('length','width','height')}
    dims['weightBrutto'] = _positive(payload.get('weight_kg'))
    templates = payload.get('characteristics_tpl') or payload.get('characteristics')
    if not isinstance(templates,list) or not templates:
        raise ValueError('Verified category attributes required')
    chars = []
    for c in templates:
        cid = _positive(c.get('id'), True)
        value = c.get('value')
        if not isinstance(value,(list,int,float)) or isinstance(value,bool) or (isinstance(value,list) and (not value or any(not isinstance(v,str) or not v.strip() for v in value))) or (isinstance(value,(int,float)) and not math.isfinite(value)):
            raise ValueError('Characteristic values must match category schema')
        if any(previous['id']==cid for previous in chars):
            raise ValueError('Duplicate characteristic ID')
        chars.append({'id':cid,'value':value})
    cards, vendors = [], set()
    for item, barcode in zip(items,barcodes):
        vc = item.get('version_id') or item.get('vendor_code')
        if not isinstance(vc,str) or not vc.strip() or len(vc)>72 or vc in vendors:
            raise ValueError('Unique seller vendor codes required')
        vendors.add(vc)
        if item.get('charc_overrides') or item.get('characteristics') not in (None, templates) or any(k in item and item[k] != payload.get(k) for k in ('length_cm','width_cm','height_cm','weight_kg','brand')):
            raise ValueError('Scene variants cannot change physical product facts')
        title, description = item.get('title'), item.get('description')
        if not isinstance(title,str) or not title.strip() or len(title)>60 or not isinstance(description,str) or not description.strip() or len(description)>5000:
            raise ValueError('Invalid title or description; do not silently truncate')
        cards.append({'subjectID':subject_id,'variants':[{'vendorCode':vc,'title':title,'description':description,
            'brand':brand,'dimensions':dims.copy(),'characteristics':chars,'sizes':[{'skus':[barcode]}]}]})
    return cards


def _find_card(token, vendor_code):
    _, result = _wb_post(token, '/content/v2/get/cards/list', {'settings':{
        'cursor':{'limit':100},'filter':{'withPhoto':-1,'textSearch':vendor_code}}})
    return next((c for c in result.get('cards',[]) if c.get('vendorCode')==vendor_code and c.get('nmID')),None)


def wait_for_cards(token, vendor_codes, timeout=300, interval=2, expected_images=None):
    if len(set(vendor_codes)) != len(vendor_codes):
        raise ValueError('Duplicate vendor codes')
    deadline, found = time.monotonic()+timeout, {}
    while time.monotonic()<deadline:
        for vc in vendor_codes:
            if vc in found:
                continue
            card = _find_card(token,vc)
            if card and (not expected_images or len(card.get('photos',[])) >= expected_images[vc]):
                found[vc] = card['nmID']
            # Content API shares a seller-level rate limit.
            time.sleep(.65)
        if len(found)==len(vendor_codes):
            return found
        time.sleep(min(interval,max(0,deadline-time.monotonic())))
    raise RuntimeError('cards_or_media_pending_timeout')


def _validate_images(paths):
    if not isinstance(paths,(list,tuple)) or not 1<=len(paths)<=30:
        raise ValueError('Each card requires 1 to 30 actual images')
    for file in paths:
        p=Path(file)
        if not p.is_file() or not 0<p.stat().st_size<=32*1024*1024:
            raise ValueError('Invalid image size')
        with Image.open(p) as image:
            if image.format not in ('JPEG','PNG','WEBP','BMP','GIF') or image.width<700 or image.height<900 or getattr(image,'n_frames',1)>1:
                raise ValueError('Invalid WB image format or dimensions')
            image.verify()


def upload_card_media(token, nm_id, image_paths):
    _positive(nm_id,True)
    _validate_images(image_paths)
    for number, file in enumerate(image_paths,1):
        p=Path(file); boundary='wb-'+uuid.uuid4().hex
        mime=mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
        body=(f'--{boundary}\r\nContent-Disposition: form-data; name="uploadfile"; filename="image{p.suffix}"\r\nContent-Type: {mime}\r\n\r\n'.encode()+p.read_bytes()+f'\r\n--{boundary}--\r\n'.encode())
        _wb_request(token,'/content/v3/media/file',body,'multipart/form-data; boundary='+boundary,
                    {'X-Nm-Id':str(nm_id),'X-Photo-Number':str(number)})
        time.sleep(.65)
    return len(image_paths)


def execute_upload(payload, subject_id, token, image_paths_per_card, *, authorized=False, checkpoint=None):
    if authorized is not True or payload.get('facts_verified') is not True or not checkpoint:
        raise ValueError('Explicit publishing authorization, verified facts and private checkpoint required')
    n=len(payload.get('items',[]))
    # Validate every card and every photo before any barcode or card write.
    cards=construct_wb_cards_upload_payload(payload,subject_id,[str(i+1) for i in range(n)])
    vcs=[c['variants'][0]['vendorCode'] for c in cards]
    if not isinstance(image_paths_per_card,dict) or set(image_paths_per_card)!=set(vcs):
        raise ValueError('Images must cover every vendor code')
    image_hashes={}
    for vc, paths in image_paths_per_card.items():
        _validate_images(paths)
        image_hashes[vc]=[hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in paths]
    fingerprint=hashlib.sha256(json.dumps({'payload':payload,'subject':subject_id,'images':image_hashes,'credential_binding':hashlib.sha256(token.encode()).hexdigest()},sort_keys=True).encode()).hexdigest()
    checkpoint=Path(checkpoint)
    state=read_cache(checkpoint)
    if checkpoint.exists() and (not isinstance(state,dict) or state.get('fingerprint')!=fingerprint):
        raise ValueError('Upload checkpoint mismatch; reconcile before retry')
    if state is None:
        if any(_find_card(token,vc) for vc in vcs):
            raise ValueError('Vendor code already exists; do not overwrite unrelated cards')
        checkpoint.parent.mkdir(parents=True,exist_ok=True)
        state={'fingerprint':fingerprint,'media_uploaded':[]}
        write_json(checkpoint,state)
    if not state.get('barcodes'):
        state['barcodes']=allocate_barcodes(token,n)
        write_json(checkpoint,state)
    if not state.get('submitted'):
        cards=construct_wb_cards_upload_payload(payload,subject_id,state['barcodes'])
        # A lost response cannot cause an automatic duplicate creation request.
        state['submitted']=True
        write_json(checkpoint,state)
        _wb_post(token,'/content/v2/cards/upload',cards)
    nm_map=wait_for_cards(token,vcs)
    for vc in vcs:
        if vc not in state['media_uploaded']:
            upload_card_media(token,nm_map[vc],image_paths_per_card[vc])
            state['media_uploaded'].append(vc)
            write_json(checkpoint,state)
    verified=wait_for_cards(token,vcs,expected_images={vc:len(paths) for vc,paths in image_paths_per_card.items()})
    state.update({'nm_ids':verified,'media_readback_verified':True,'storefront_verified':False})
    write_json(checkpoint,state)
    return verified
