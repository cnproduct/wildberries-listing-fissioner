#!/usr/bin/env python3
"""Export reviewed WB marketing variants; never invent missing product facts."""
import argparse
import json
import math
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
from PIL import Image

FACT_FIELDS = ("brand", "category", "composition", "country")
PACKAGE_FIELDS = ("length_cm", "width_cm", "height_cm", "weight_kg")
IMAGE_EXTENSIONS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "BMP": ".bmp", "GIF": ".gif"}
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def validate_payload(data, sku, base_dir, expected_count=10):
    """Normalize rows and collect QA issues before creating any output."""
    if not isinstance(sku, str) or not re.fullmatch(r"[\w-]{1,64}", sku):
        raise ValueError("SKU must contain 1–64 letters, digits, underscores or hyphens.")
    if not isinstance(expected_count, int) or isinstance(expected_count, bool) or not 1 <= expected_count <= 100:
        raise ValueError("expected_count must be between 1 and 100.")
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("Payload must be an object with an items array.")
    if len(data["items"]) != expected_count:
        raise ValueError(f"Expected {expected_count} variants, got {len(data['items'])}.")
    rows, issues, seen_titles = [], [], set()
    if data.get("example_only"):
        issues.append({"version_id": "all", "field": "example_only",
                       "reason": "teaching example; replace with seller-confirmed product data"})
    for idx, item in enumerate(data["items"], 1):
        if not isinstance(item, dict):
            raise ValueError(f"items[{idx - 1}] must be an object.")
        row = {"version_id": f"{sku}_V{idx:02d}"}

        def issue(field, reason):
            issues.append({"version_id": row["version_id"], "field": field, "reason": reason})

        for field in ("persona", "title", "description", "keywords") + FACT_FIELDS:
            value = item.get(field, data.get(field) if field in FACT_FIELDS else None)
            if isinstance(value, list) and field == "keywords" and all(isinstance(v, str) for v in value):
                value = ", ".join(value)
            if not isinstance(value, str) or not value.strip():
                row[field] = None
                issue(field, "missing or not a non-empty string")
            else:
                if CONTROL_CHARS.search(value) or len(value) > 32767:
                    raise ValueError(f"{row['version_id']}.{field}: unsupported Excel text.")
                row[field] = value.strip()
            if field in FACT_FIELDS and field in item and field in data and item[field] != data[field]:
                issue(field, "conflicts with shared product fact; export a separate physical SKU instead")
        title = row["title"]
        if title:
            if len(title) > 60:
                issue("title", "exceeds 60 characters")
            normalized = " ".join(title.casefold().split())
            if normalized in seen_titles:
                issue("title", "duplicate title")
            seen_titles.add(normalized)
        for field in PACKAGE_FIELDS + ("price", "discount"):
            value = item.get(field, data.get(field))
            if value is not None:
                valid = _positive(value)
                if field == "discount":
                    valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 100
                if not valid:
                    raise ValueError(f"{row['version_id']}.{field}: invalid numeric value.")
            elif field in PACKAGE_FIELDS:
                issue(field, "missing verified package measurement")
            row[field] = value
            if field in PACKAGE_FIELDS and field in item and field in data and item[field] != data[field]:
                issue(field, "conflicts with shared package measurement")
        barcode = item.get("barcode")
        if barcode is not None and (not isinstance(barcode, str) or not barcode.strip() or barcode.startswith("AUTO_")):
            raise ValueError(f"{row['version_id']}.barcode: provide a real barcode string or omit it.")
        if barcode and (CONTROL_CHARS.search(barcode) or len(barcode) > 32767):
            raise ValueError(f"{row['version_id']}.barcode: unsupported Excel text.")
        row["barcode"] = barcode
        if not barcode:
            issue("barcode", "missing seller-confirmed barcode; no placeholder is generated")
        row["image_source"] = None
        row["image_url"] = item.get("image_url")
        row["image_extension"] = None
        if row["image_url"] is not None:
            if not isinstance(row["image_url"], str):
                raise ValueError(f"{row['version_id']}.image_url must be a URL string.")
            url = urlparse(row["image_url"])
            if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or CONTROL_CHARS.search(row["image_url"]):
                raise ValueError(f"{row['version_id']}.image_url: invalid HTTP(S) URL.")
        src = item.get("image_path")
        if src:
            if not isinstance(src, str):
                raise ValueError(f"{row['version_id']}.image_path must be a string.")
            image_path = Path(src).expanduser()
            image_path = (Path(base_dir) / image_path).resolve() if not image_path.is_absolute() else image_path.resolve()
            if not image_path.is_file():
                issue("image_path", "local image does not exist")
            else:
                try:
                    with Image.open(image_path) as img:
                        image_format, image_size = img.format, img.size
                        animated = getattr(img, "is_animated", False)
                        img.verify()
                    with Image.open(image_path) as img:
                        img.load()
                    if image_format not in IMAGE_EXTENSIONS or animated:
                        issue("image_path", "unsupported format or animated image")
                    else:
                        row["image_source"] = image_path
                        row["image_extension"] = IMAGE_EXTENSIONS[image_format]
                        if image_size[0] < 700 or image_size[1] < 900 or image_path.stat().st_size > 32 * 1024 * 1024:
                            issue("image_path", "image must be at least 700×900 and no larger than 32 MiB")
                except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                    issue("image_path", "cannot decode image")
        elif row["image_url"]:
            issue("image_url", "remote image not downloaded or visually verified; strict export requires a local file")
        else:
            issue("image_path", "missing main image")
        rows.append(row)
    # Without global defaults, per-item facts must still describe the same SKU.
    for field in FACT_FIELDS + PACKAGE_FIELDS:
        values = [row[field] for row in rows if row[field] is not None]
        if values and any(value != values[0] for value in values[1:]):
            issues.append({"version_id": "all", "field": field,
                           "reason": "marketing variants disagree on a fixed product fact"})
    return rows, issues


def build_wb_batch_excel(data, output_dir, sku, *, base_dir=None, strict=False, expected_count=10):
    """Legacy callable retained; workbook is for review, not official direct import."""
    rows, issues = validate_payload(data, sku, base_dir or Path.cwd(), expected_count)
    if strict and issues:
        details = "; ".join(f"{i['version_id']}.{i['field']}: {i['reason']}" for i in issues)
        raise ValueError("Strict export blocked: " + details)
    output_root = Path(output_dir).resolve()
    target = output_root / f"wb_fission_{sku}"
    if target.exists():
        raise FileExistsError(f"Output already exists: {target}. Choose another output directory.")
    output_root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".wb_fission_{sku}_", dir=output_root))
    try:
        (staging / "images").mkdir()
        exported_rows = []
        for row in rows:
            exported = {k: v for k, v in row.items() if k not in {"image_source", "image_extension"}}
            exported["image_path"] = None
            if row["image_source"]:
                image_ref = f"images/{row['version_id']}_main{row['image_extension']}"
                shutil.copy2(row["image_source"], staging / image_ref)
                exported["image_path"] = image_ref
            exported_rows.append(exported)
        excel_name = f"WB_Listing_Review_{sku}.xlsx"
        with pd.ExcelWriter(staging / excel_name, engine="openpyxl") as writer:
            pd.DataFrame(exported_rows).to_excel(writer, sheet_name="Listing_Review", index=False)
            pd.DataFrame(issues, columns=["version_id", "field", "reason"]).to_excel(writer, sheet_name="QA_Issues", index=False)
            for sheet in writer.sheets.values():
                sheet.freeze_panes = "A2"
                for column in sheet.columns:
                    for cell in column:
                        if isinstance(cell.value, str):
                            cell.data_type = "s"  # Keep formula-looking user input literal.
                    sheet.column_dimensions[column[0].column_letter].width = min(max(max(len(str(c.value or "")) for c in column) + 3, 12), 50)
        manifest = {"schema_version": 2, "sku": sku, "total_variants": len(rows),
                    "status": "validated_assets" if strict else "draft",
                    "official_import_template": False, "published": False,
                    "example_only": bool(data.get("example_only")),
                    "issues": issues, "items": exported_rows}
        (staging / f"wb_fission_{sku}_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        staging.rename(target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(f"[{manifest['status']}] {target / excel_name} ({len(issues)} QA issues)")
    return str(target / excel_name)


def main():
    parser = argparse.ArgumentParser(description="Export WB marketing variants for review")
    parser.add_argument("--json", required=True)
    parser.add_argument("--out", default="./output/fission")
    parser.add_argument("--sku", required=True)
    parser.add_argument("--strict", action="store_true", help="Block missing facts, barcodes and unverified images")
    parser.add_argument("--expected-count", type=int, default=10)
    args = parser.parse_args()
    source = Path(args.json).resolve()
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
        build_wb_batch_excel(payload, args.out, args.sku, base_dir=source.parent, strict=args.strict, expected_count=args.expected_count)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"Export failed: {exc}\n")


if __name__ == "__main__":
    main()
