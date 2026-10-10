"""WB Content API v2 上传修复模块（drop-in）.

替换 scripts/antigravity_executor.py 中的:
  - construct_wb_cards_upload_payload()   (整函数替换)
  - Step 6 WB Publishing 段                    (整段替换, 见下方 execute_upload())
新增:
  - allocate_barcodes()   WB 官方分配条码(替代本地 Pillow 自造 EAN-13)
  - wait_for_cards()      轮询等卡片生成拿 nmId(WB 是异步建卡)
  - upload_card_media()   media/save 传图(当前代码完全缺失这一步)

调用约定与 wb_writer.py(ozon-to-wb-fast-listing, 生产验证过)保持一致.
所有函数跑在固定IP真机, 不经过 Cloudflare Worker.
"""

import base64
import json
import time
import urllib.request
import urllib.error

CONTENT = "https://content-api.wildberries.ru"


def _wb_post(token, path, body):
    """最小 WB API 客户端: 状态码 + JSON, 错误收敛为 RuntimeError(不泄露 token)."""
    req = urllib.request.Request(
        CONTENT + path,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": token, "Content-Type": "application/json",
                 "Accept": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError(f"wb_api_{e.code}:{detail}")
    except Exception as e:
        raise RuntimeError(f"wb_unreachable:{type(e).__name__}")


def allocate_barcodes(token, count):
    """POST /content/v2/barcodes -> {"data": [...]}. 每张卡片独立码."""
    _, resp = _wb_post(token, "/content/v2/barcodes", {"count": count})
    codes = resp.get("data", [])
    if len(codes) != count:
        raise RuntimeError("barcode_unavailable")
    return [str(c) for c in codes]


def construct_wb_cards_upload_payload(payload, subject_id, barcodes):
    """修正版 cards/upload 组包.

    修复原实现的 4 处硬伤:
    1. dimensions 去掉 "isValid"(WB 无此字段) -> "weightBrutto"(kg, float)
    2. characteristics 去掉 "name", value 必须是 list(原实现是裸字符串)
    3. sizes 去掉 "price"(建卡接口不收价格, 价格走 discounts-prices-api 另设)
    4. subjectID 由参数传入(原实现 hardcode 607=保温杯, 换品类就错)
    """
    brand = payload["brand"]
    dims = {
        "length": int(payload["length_cm"]),
        "width": int(payload["width_cm"]),
        "height": int(payload["height_cm"]),
        "weightBrutto": float(payload["weight_kg"]),
    }
    # characteristics 模板由调用方按类目传入, 格式 [{"id": int, "value": [str]}]
    charcs_tpl = payload.get("characteristics_tpl", [])
    cards = []
    for item, barcode in zip(payload["items"], barcodes):
        chars = []
        for c in charcs_tpl:
            chars.append({"id": int(c["id"]), "value": list(c["value"])})
        # 每组的差异化属性覆盖(如 10 维里某组改了材质/容量), 增量合并
        for cid, val in (item.get("charc_overrides") or {}).items():
            chars = [c for c in chars if c["id"] != int(cid)]
            chars.append({"id": int(cid), "value": val if isinstance(val, list) else [str(val)]})
        card = {
            "subjectID": int(subject_id),
            "variants": [{
                "vendorCode": item["version_id"],
                "title": str(item["title"])[:100],
                "description": str(item["description"])[:5000],
                "brand": brand,
                "dimensions": dims,
                "characteristics": chars,
                "sizes": [{"skus": [barcode]}],
            }],
        }
        cards.append(card)
    return cards


def wait_for_cards(token, vendor_codes, timeout=300, interval=10):
    """cards/upload 是异步的: 轮询 get/cards/list 拿 nmId."""
    deadline = time.time() + timeout
    found = {}
    while time.time() < deadline:
        for vc in vendor_codes:
            if vc in found:
                continue
            _, resp = _wb_post(token, "/content/v2/get/cards/list", {
                "settings": {"cursor": {"limit": 100},
                             "filter": {"withPhoto": -1, "textSearch": vc}}})
            hit = next((c for c in resp.get("cards", [])
                        if c.get("vendorCode") == vc and c.get("nmID")), None)
            if hit:
                found[vc] = hit["nmID"]
        if len(found) == len(vendor_codes):
            return found
        time.sleep(interval)
    raise RuntimeError(f"cards_pending_timeout:{[v for v in vendor_codes if v not in found]}")


def upload_card_media(token, nm_id, image_paths):
    """POST /content/v3/media/save {"nmId","data":[base64…]}. 每卡 ≤30 张.
    image_paths: 本地图片路径 list(第1张=差异化主图)."""
    data = []
    for p in image_paths[:30]:
        with open(p, "rb") as f:
            data.append(base64.b64encode(f.read()).decode())
    if not data:
        raise RuntimeError("no_photos")
    _wb_post(token, "/content/v3/media/save", {"nmId": int(nm_id), "data": data})
    return len(data)


def execute_upload(payload, subject_id, token, image_paths_per_card):
    """Step 6 整段替换: 分配码 -> 组包 -> 上传 -> 等卡 -> 传图. 返回 {vendorCode: nmId}.

    payload["items"] 每项需有 version_id/title/description;
    image_paths_per_card: 与 items 等长的 list, 每项是该卡片的图片路径 list.
    """
    n = len(payload["items"])
    barcodes = allocate_barcodes(token, n)
    cards = construct_wb_cards_upload_payload(payload, subject_id, barcodes)
    _wb_post(token, "/content/v2/cards/upload", cards)
    nm_map = wait_for_cards(token, [c["variants"][0]["vendorCode"] for c in cards])
    for item, vc in zip(payload["items"],
                        [c["variants"][0]["vendorCode"] for c in cards]):
        paths = image_paths_per_card.get(item["version_id"], [])
        if paths:
            upload_card_media(token, nm_map[vc], paths)
    return nm_map
