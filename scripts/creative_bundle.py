"""Package ten reviewed scene images and copy, independently of seller-upload specs."""
import hashlib
import html
import json
import shutil
import zipfile
from pathlib import Path
from PIL import Image
from openpyxl import Workbook


def build_creative_bundle(data, output):
    if data.get('example_only') or data.get('review', {}).get('subject_consistency_verified') is not True:
        raise ValueError('Reviewed source-product images required')
    items = data.get('items', [])
    if len(items) != 10:
        raise ValueError('Exactly ten scenes required')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    (output / 'images').mkdir()
    rows, titles, hashes = [], set(), set()
    for index, item in enumerate(items, 1):
        for key in ('persona', 'title', 'description', 'scene_name'):
            if not isinstance(item.get(key), str) or not item[key].strip():
                raise ValueError('Missing creative field: ' + key)
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
        rows.append({**{k: item.get(k) for k in ('scene_name', 'persona', 'title', 'description', 'keywords')},
                     'index': index, 'image_path': ref, 'sha256': digest})
    manifest = {'schema_version': 1, 'mode': 'creative', 'source_nm_id': str(data['source_nm_id']),
                'status': 'reviewed_creative_assets', 'published': False, 'count': 10,
                'review': data['review'], 'source_facts': data.get('source_facts', {}), 'items': rows}
    manifest_path = output / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    lines = [f"# WB {data['source_nm_id']} · 10 种应用场景", '',
             '同款产品，仅改变应用场景与表达。AI 对照检查已完成，正式使用前请核对商品主体与文案。', '']
    book = Workbook()
    sheet = book.active
    sheet.title = '场景图文'
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
        cards.append(f"<article><img src='{row['image_path']}' alt='{html.escape(row['scene_name'])}' loading='lazy'><div class='copy'><span>{row['index']:02d} / 10 · {html.escape(row['persona'])}</span><h2>{html.escape(row['scene_name'])}</h2><h3 lang='ru'>{html.escape(row['title'])}</h3><p lang='ru'>{text}</p></div></article>")
    gallery = "<!doctype html><html lang='zh-CN'><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>WB 场景图文</title><style>body{margin:0;background:#f6f4f2;color:#272320;font-family:system-ui,sans-serif}header{padding:48px 5vw 32px;max-width:1400px;margin:auto}h1{font-size:clamp(28px,4vw,46px);letter-spacing:-.04em;margin:12px 0}header p{color:#6d6460;line-height:1.6;max-width:750px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:28px;max-width:1400px;padding:0 5vw 50px;margin:auto}article{background:white;border:1px solid #e7e0da;border-radius:18px;overflow:hidden}img{width:100%;aspect-ratio:3/4;object-fit:cover}.copy{padding:24px}span{color:#866757;font-size:13px}h2{font-size:24px;margin:12px 0 18px}h3{font-size:17px;line-height:1.5}p{line-height:1.7;font-size:15px}a{color:#6b21a8}footer{padding:20px 5vw 40px;color:#6d6460;text-align:center}@media(max-width:500px){header{padding-top:28px}main{grid-template-columns:1fr}}</style><header><span>同一产品 · 十种表达</span><h1>WB " + html.escape(str(data['source_nm_id'])) + " 场景图文</h1><p>以原商品照片为依据，保留商品主体和原包装，改变应用背景、光线与构图。每张附俄语标题和描述，正式使用前请核对外观与文案。</p><a href='场景图文.xlsx'>下载场景图文 Excel</a></header><main>" + ''.join(cards) + "</main><footer>已完成 AI 原图对照检查 · 营销素材，尚未店铺发布</footer></html>"
    (output / 'index.html').write_text(gallery)
    archive = output.parent / ('WB-' + str(data['source_nm_id']) + '-10-scenes.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                z.write(file, file.relative_to(output))
    return {'manifest_path': str(manifest_path), 'excel_path': str(excel), 'archive_path': str(archive), 'manifest': manifest}
