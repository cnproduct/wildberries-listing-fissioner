"""Fetch exact WB source data and photographs; never infer shipping specifications."""
import concurrent.futures
import io
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote
from PIL import Image
try:
    from .runtime_files import write_json, read_cache
except ImportError:
    from runtime_files import write_json, read_cache


def resource(config, url):
    target = config['GATEWAY_URL'].rstrip('/') + '/api/wb-resource?url=' + quote(url, safe='')
    req = urllib.request.Request(target, headers={'Authorization': 'Bearer ' + config['EXECUTOR_SECRET']})
    try:
        opener = urllib.request.urlopen if config.get('GATEWAY_USE_SYSTEM_PROXY') is True else urllib.request.build_opener(urllib.request.ProxyHandler({})).open
        with opener(req, timeout=18) as response:
            data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                return None
            return data
    except (OSError, ValueError):
        return None


def basket_candidates(nm_id, cached=None):
    vol = int(nm_id) // 100000
    limits = [143,287,431,719,1007,1061,1115,1169,1313,1601,1655,1919,2045,2189,2405,2621,2837,3053,3269,3485,3701,3917,4133,4349,4565,4781,4997,5213,5429,5645,5861,6077]
    estimated = next((i + 1 for i, limit in enumerate(limits) if vol <= limit), (vol - 6077) // 216 + 33)
    order = [cached, estimated, estimated-1, estimated+1, vol // 144 + 1] + list(range(1, 101))
    seen = set()
    for basket in order:
        if basket and 1 <= int(basket) <= 200 and int(basket) not in seen:
            seen.add(int(basket))
            yield int(basket)


def acquire_source(task, gateway, config, output, facts):
    nm_id = str(task['nmId'])
    if not nm_id.isdigit():
        raise ValueError('Invalid product ID')
    facts = dict(facts)
    evidence_path = Path(output) / 'source-evidence.json'
    evidence = read_cache(evidence_path, {'product': None})
    if not evidence.get('product'):
        try:
            evidence = gateway.call('/api/source', {'nmId': nm_id})
        except (RuntimeError, OSError):
            evidence = {'product':None, 'errors':['public_source_unavailable']}
    product = evidence.get('product')
    if product:
        if str(product.get('id')) != nm_id:
            raise ValueError('Source product ID mismatch')
        # Keep only provenance and meaningful product facts, never opaque shopping tokens.
        evidence['product'] = {k: product[k] for k in ('id','name','brand','subjectId','pics') if k in product}
        facts.setdefault('product_name', product.get('name'))
        if product.get('brand'):
            facts.setdefault('brand', product['brand'])
    original_files = facts.get('source_images') or []
    if original_files:
        for file in original_files:
            with Image.open(file) as image:
                image.verify()
        facts['source_verified'] = True
        return evidence, facts
    cached = Path(output) / 'source-cache.json'
    data = read_cache(cached, {})
    if data.get('source_nm_id') == nm_id and data.get('source_images'):
        try:
            for file in data['source_images']:
                with Image.open(file) as image:
                    image.verify()
            facts = {**data['facts'], **facts}
            facts['source_images'] = data['source_images']
            facts['source_verified'] = True
            return evidence, facts
        except (OSError, ValueError, KeyError):
            evidence.setdefault('errors', []).append('source_cache_invalid')
    vol, part = int(nm_id) // 100000, int(nm_id) // 1000
    def read_card(root):
        payload = resource(config, root + 'info/ru/card.json')
        if not payload:
            return None
        try:
            card = json.loads(payload)
        except ValueError:
            return None
        if not isinstance(card, dict) or not card.get('imt_name') or (card.get('nm_id') and str(card['nm_id']) != nm_id):
            return None
        return root, card
    # Follow WB's current routing configuration, without executing remote JavaScript.
    roots = []
    route_payload = resource(config, 'https://cdn.wbbasket.ru/api/v3/upstreams')
    if route_payload:
        try:
            routing = json.loads(route_payload)
            evidence['routing_url'] = 'https://cdn.wbbasket.ru/api/v3/upstreams'
            for section in ('recommend', 'origin'):
                route = routing.get(section, {}).get('mediabasket_route_map', [{}])[0]
                hosts = route.get('hosts', [])
                selected = None
                if route.get('method') == 'mod' and hosts:
                    selected = hosts[int(nm_id) % len(hosts)]
                elif route.get('method') == 'range':
                    selected = next((h for h in hosts if h.get('vol_range_from',0) <= vol <= h.get('vol_range_to',-1)), None)
                if selected:
                    host = selected['host']
                    if __import__('re').fullmatch(r'(?:basket-[0-9]+\.wbbasket\.ru|[a-z]{3}-basket-cdn-[0-9]+\.geobasket\.ru)',host):
                        roots.append(f'https://{host}/vol{vol}/part{part}/{nm_id}/')
        except (ValueError, KeyError, IndexError, TypeError):
            evidence.setdefault('errors',[]).append('cdn_routing_invalid')
    found = next((result for root in roots if (result := read_card(root))), None)
    if not found:
        # Legacy fallback is bounded; current official routing always has priority.
        candidates = list(basket_candidates(nm_id))[:16]
        def probe(basket):
            return read_card(f'https://basket-{basket:02d}.wbbasket.ru/vol{vol}/part{part}/{nm_id}/')
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for offset in range(0,len(candidates),4):
                results=list(pool.map(probe,candidates[offset:offset+4]))
                found=next((r for r in results if r),None)
                if found:
                    break
    if not found:
        evidence.setdefault('errors', []).append('original_image_cdn_unavailable')
        return evidence, facts
    root, card = found
    facts.setdefault('product_name', card['imt_name'])
    evidence['card_url'] = root + 'info/ru/card.json'
    evidence['card'] = card
    if card.get('description'):
        facts.setdefault('source_description', card['description'])
    if card.get('subj_name'):
        facts.setdefault('category', card['subj_name'])
    selling = card.get('selling', {})
    if selling.get('brand_name'):
        facts.setdefault('brand', selling['brand_name'])
    originals = []
    for index in range(1, min(max(int((product or {}).get('pics',2)),1),2) + 1):
        url = root + f'images/big/{index}.webp'
        payload = resource(config, url)
        if not payload:
            continue
        try:
            with Image.open(io.BytesIO(payload)) as image:
                image.verify()
        except (OSError, ValueError):
            continue
        file = Path(output) / f'original-{index}.webp'
        file.write_bytes(payload)
        originals.append(str(file))
    if originals:
        facts['source_images'] = originals
        facts['source_verified'] = True
        write_json(cached, {'source_nm_id':nm_id,'source_images':originals,'facts':facts})
    return evidence, facts
