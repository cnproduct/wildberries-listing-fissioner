"""Package ten reviewed scene images and copy, independently of seller-upload specs."""
import hashlib
import html
import json
import shutil
import zipfile
import tempfile
import re
from pathlib import Path
from PIL import Image
from openpyxl import Workbook
try:
    from .wb_pricing import calculate_fission_prices, extract_base_price_from_source
except ImportError:
    from wb_pricing import calculate_fission_prices, extract_base_price_from_source


def _build_creative_bundle(data, output):
    if data.get('example_only') or data.get('review', {}).get('subject_consistency_verified') is not True:
        raise ValueError('Reviewed source-product images required')
    items = data.get('items', [])
    scene_count = len(items)
    if scene_count not in (5, 10):
        raise ValueError('Exactly five or ten scenes required')
    if not re.fullmatch(r'[0-9]{6,13}', str(data.get('source_nm_id', ''))):
        raise ValueError('Invalid source product ID')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    (output / 'images').mkdir()
    base_price = data.get('base_price') or data.get('source_facts', {}).get('price')
    if not base_price and data.get('source_evidence'):
        base_price = extract_base_price_from_source(data['source_evidence'])
    fission_pricing = None
    if isinstance(base_price, (int, float)) and not isinstance(base_price, bool) and base_price > 0:
        try:
            fission_pricing = calculate_fission_prices(base_price, count=scene_count)
        except ValueError:
            fission_pricing = None
    rows, titles, hashes = [], set(), set()
    for index, item in enumerate(items, 1):
        for key in ('persona', 'title', 'description', 'scene_name'):
            if not isinstance(item.get(key), str) or not item[key].strip():
                raise ValueError('Missing creative field: ' + key)
        if not isinstance(item.get('keywords', []), list) or any(not isinstance(k, str) for k in item.get('keywords', [])):
            raise ValueError('Keywords must be strings in a list')
        title = item['title'].strip()
        if len(title) > 60 or title.casefold() in titles:
            raise ValueError('Invalid or duplicate title')
        titles.add(title.casefold())
        source = Path(item['image_path'])
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest in hashes:
            raise ValueError('Duplicate scene image')
        hashes.add(digest)
        with Image.open(source) as image:
            extension = {'PNG': '.png', 'JPEG': '.jpg', 'WEBP': '.webp'}.get(image.format)
            size = image.size
            image.verify()
        if not extension or min(size) < 700 or max(size) < 900:
            raise ValueError('Invalid scene image size or format')
        ref = f'images/{index:02d}{extension}'
        shutil.copy2(source, output / ref)
        row_data = {**{k: item.get(k) for k in ('scene_name', 'persona', 'title', 'description', 'keywords')},
                    'index': index, 'image_path': ref, 'sha256': digest}
        if fission_pricing:
            p_info = fission_pricing[index - 1]
            row_data['price'] = p_info['price']
            row_data['price_delta_ratio'] = p_info['delta_ratio']
            row_data['price_delta_percent'] = p_info['delta_percent']
        rows.append(row_data)
    manifest = {'schema_version': 1, 'mode': 'creative', 'source_nm_id': str(data['source_nm_id']),
                'status': 'reviewed_creative_assets', 'published': False, 'count': scene_count,
                'review': data['review'], 'source_facts': data.get('source_facts', {}), 'items': rows}
    manifest_path = output / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    lines = [f"# WB {data['source_nm_id']} · {scene_count} 种应用场景", '',
             '同款产品，仅改变应用场景与表达。AI 对照检查已完成，正式使用前请核对商品主体与文案。', '']
    book = Workbook()
    sheet = book.active
    sheet.title = '场景图文'
    if fission_pricing:
        sheet.append(['编号', '场景', '受众', '建议售价 (₽)', '价格浮动', '俄语标题', '俄语描述', '关键词', '图片'])
        for row in rows:
            sheet.append([row['index'], row['scene_name'], row['persona'], row.get('price'), row.get('price_delta_percent'),
                          row['title'], row['description'], ', '.join(row['keywords'] or []), row['image_path']])
            for cell in sheet[sheet.max_row]:
                if isinstance(cell.value, str):
                    cell.data_type = 's'
            lines += [f"## {row['index']:02d} · {row['scene_name']}", '', f"受众：{row['persona']}", '',
                      f"建议售价：{row.get('price')} ₽ ({row.get('price_delta_percent')})", '',
                      f"**{row['title']}**", '', row['description'], '', f"![{row['scene_name']}]({row['image_path']})", '']
        sheet.freeze_panes = 'A2'
        for column, width in [('A', 8), ('B', 25), ('C', 25), ('D', 15), ('E', 15), ('F', 55), ('G', 90), ('H', 40), ('I', 25)]:
            sheet.column_dimensions[column].width = width
    else:
        sheet.append(['编号', '场景', '受众', '俄语标题', '俄语描述', '关键词', '图片'])
        for row in rows:
            sheet.append([row['index'], row['scene_name'], row['persona'], row['title'], row['description'],
                          ', '.join(row['keywords'] or []), row['image_path']])
            for cell in sheet[sheet.max_row]:
                if isinstance(cell.value, str):
                    cell.data_type = 's'
            lines += [f"## {row['index']:02d} · {row['scene_name']}", '', f"受众：{row['persona']}", '',
                      f"**{row['title']}**", '', row['description'], '', f"![{row['scene_name']}]({row['image_path']})", '']
        sheet.freeze_panes = 'A2'
        for column, width in [('A', 8), ('B', 25), ('C', 25), ('D', 55), ('E', 90), ('F', 40), ('G', 25)]:
            sheet.column_dimensions[column].width = width
    excel = output / '场景图文.xlsx'
    book.save(excel)
    (output / '场景图文.md').write_text('\n'.join(lines))
    cards = []
    for row in rows:
        text = html.escape(row['description'])
        cards.append(f"<article><img src='{row['image_path']}' alt='{html.escape(row['scene_name'])}' loading='lazy'><div class='copy'><span>{row['index']:02d} / {scene_count:02d} · {html.escape(row['persona'])}</span><h2>{html.escape(row['scene_name'])}</h2><h3 lang='ru'>{html.escape(row['title'])}</h3><p lang='ru'>{text}</p></div></article>")
    label_cn = '五种表达' if scene_count == 5 else '十种表达'
    gallery = "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>WB 场景图文</title><style>body{margin:0;background:#f6f4f2;color:#272320;font-family:system-ui,sans-serif}header{padding:48px 5vw 32px;max-width:1400px;margin:auto}h1{font-size:clamp(28px,4vw,46px);letter-spacing:-.04em;margin:12px 0}header p{color:#6d6460;line-height:1.6;max-width:750px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:28px;max-width:1400px;padding:0 5vw 50px;margin:auto}article{background:white;border:1px solid #e7e0da;border-radius:18px;overflow:hidden}img{width:100%;aspect-ratio:3/4;object-fit:cover}.copy{padding:24px}span{color:#866757;font-size:13px}h2{font-size:24px;margin:12px 0 18px}h3{font-size:17px;line-height:1.5}p{line-height:1.7;font-size:15px}a{color:#6b21a8}footer{padding:20px 5vw 40px;color:#6d6460;text-align:center}@media(max-width:500px){header{padding-top:28px}main{grid-template-columns:1fr}}</style><header><span>同一产品 · " + label_cn + "</span><h1>WB " + html.escape(str(data['source_nm_id'])) + " 场景图文</h1><p>以原商品照片为依据，保留商品主体和原包装，改变应用背景、光线与构图。每张附俄语标题和描述，正式使用前请核对外观与文案。</p><a href='场景图文.xlsx'>下载场景图文 Excel</a></header><main>" + ''.join(cards) + "</main><footer>已完成 AI 原图对照检查 · 营销素材，尚未店铺发布</footer></html>"
    (output / 'index.html').write_text(gallery)
    archive = output.parent / f"WB-{data['source_nm_id']}-{scene_count}-scenes.zip"
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                z.write(file, file.relative_to(output))
    return {'manifest_path': str(manifest_path), 'excel_path': str(excel), 'archive_path': str(archive), 'manifest': manifest}


def validate_bundle(bundle, nm_id=None):
    """Recheck disk bytes and archive, including after an interrupted execution."""
    manifest_path = Path(bundle['manifest_path'])
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest != bundle['manifest'] or (nm_id is not None and str(manifest['source_nm_id']) != str(nm_id)):
        raise ValueError('Bundle source or manifest mismatch')
    scene_count = manifest.get('count')
    if scene_count not in (5, 10) or manifest.get('published') is not False or manifest.get('review', {}).get('subject_consistency_verified') is not True:
        raise ValueError('Unreviewed bundle')
    items = manifest.get('items', [])
    if [i.get('index') for i in items] != list(range(1, scene_count + 1)):
        raise ValueError('Invalid scene indexes')
    base = manifest_path.parent.resolve()
    hashes = set()
    for item in items:
        path = (base / item['image_path']).resolve()
        if not path.is_relative_to(base) or not path.is_file():
            raise ValueError('Invalid bundle image path')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != item['sha256'] or digest in hashes:
            raise ValueError('Bundle image checksum mismatch')
        hashes.add(digest)
    with zipfile.ZipFile(bundle['archive_path']) as archive:
        if archive.testzip() or json.loads(archive.read('manifest.json')) != manifest:
            raise ValueError('Archive does not match bundle')
        for item in items:
            if hashlib.sha256(archive.read(item['image_path'])).hexdigest() != item['sha256']:
                raise ValueError('Archive image checksum mismatch')
    return bundle


def build_creative_bundle(data, output):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        # A crash after the atomic directory rename can precede bundle-paths.json.
        manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
        scene_count = len(data.get('items', []))
        if manifest.get('review') != data.get('review') or scene_count not in (5, 10) or manifest.get('count') != scene_count:
            raise ValueError('Existing bundle differs from reviewed result')
        for row, item in zip(manifest['items'], data['items']):
            if any(row.get(k) != item.get(k) for k in ('title','description','scene_name','persona','keywords')) or row['sha256'] != hashlib.sha256(Path(item['image_path']).read_bytes()).hexdigest():
                raise ValueError('Existing bundle differs from reviewed result')
        return validate_bundle({'manifest_path':str(output/'manifest.json'), 'excel_path':str(output/'场景图文.xlsx'),
            'archive_path':str(output / f"WB-{data['source_nm_id']}-{scene_count}-scenes.zip"), 'manifest':manifest},data['source_nm_id'])
    with tempfile.TemporaryDirectory(prefix='.bundle-', dir=output.parent) as temp:
        staged = Path(temp) / 'assets'
        bundle = _build_creative_bundle(data, staged)
        archive = Path(bundle['archive_path'])
        archive.rename(staged / archive.name)
        bundle['archive_path'] = str(staged / archive.name)
        validate_bundle(bundle, data['source_nm_id'])
        staged.rename(output)
        for key in ('manifest_path','excel_path','archive_path'):
            bundle[key] = str(output / Path(bundle[key]).name)
        return bundle
