#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Wildberries Listing Fission Exporter
将 10 套裂变生成的图文资产打包为 Wildberries 官方标准批量上传 Excel 表格与资产包。
"""

import os
import sys
import json
import shutil
import argparse
from pathlib import Path
import pandas as pd

def build_wb_batch_excel(data, output_dir, sku):
    """
    生成符合 Wildberries 批量导入规范的 Excel 表格与目录结构
    """
    target_dir = Path(output_dir) / f"wb_fission_{sku}"
    images_dir = target_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    items = data.get("items", [])
    if not items:
        raise ValueError("No items found in fission data payload.")

    excel_rows = []

    for idx, item in enumerate(items, 1):
        version_id = f"{sku}_V{idx:02d}"
        
        # 复制或整理图片
        src_img = item.get("image_path")
        dest_img_name = f"{version_id}_main.png"
        dest_img_path = images_dir / dest_img_name

        if src_img and os.path.exists(src_img):
            shutil.copy2(src_img, dest_img_path)
            img_ref = str(dest_img_path.resolve())
        else:
            img_ref = item.get("image_url", f"images/{dest_img_name}")

        row = {
            "序号 (№)": idx,
            "版本代号 (Version ID)": version_id,
            "矩阵定位 (Persona)": item.get("persona", f"场景 {idx}"),
            "商品标题 (Наименование)": item.get("title", ""),
            "商品描述 (Описание)": item.get("description", ""),
            "核心关键词 (Ключевые слова)": item.get("keywords", ""),
            "品牌 (Бренд)": item.get("brand", data.get("brand", "NoBrand")),
            "类目 (Предмет)": item.get("category", data.get("category", "")),
            "原产国 (Страна производства)": item.get("country", "Китай"),
            "主图路径/链接 (Главное фото)": img_ref,
            "材质 (Состав)": item.get("composition", data.get("composition", "")),
            "建议零售价 (Цена)": item.get("price", data.get("price", 1990)),
            "折扣 (Скидка %)": item.get("discount", data.get("discount", 45)),
            "条形码占位 (Баркод)": item.get("barcode", f"AUTO_{sku}_{idx:02d}"),
            "包装尺寸长(см)": item.get("length_cm", data.get("length_cm", 20)),
            "包装尺寸宽(см)": item.get("width_cm", data.get("width_cm", 15)),
            "包装尺寸高(см)": item.get("height_cm", data.get("height_cm", 10)),
            "包装重量(кг)": item.get("weight_kg", data.get("weight_kg", 0.5)),
        }
        excel_rows.append(row)

    df = pd.DataFrame(excel_rows)

    excel_file = target_dir / f"WB_Batch_Import_{sku}.xlsx"
    with pd.ExcelWriter(excel_file, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Wildberries_Batch_Cards", index=False)
        
        # 简单列宽自适应
        worksheet = writer.sheets["Wildberries_Batch_Cards"]
        for col in worksheet.columns:
            max_len = max(len(str(cell.value or '')) for cell in col)
            col_letter = col[0].column_letter
            worksheet.column_dimensions[col_letter].width = min(max(max_len + 3, 12), 50)

    # 导出便于审查与脚本读取的 JSON 备份
    json_file = target_dir / f"wb_fission_{sku}_manifest.json"
    with open(json_file, "w", encoding="utf-8") as f:
        json.dump({"sku": sku, "total_variants": len(excel_rows), "items": excel_rows}, f, ensure_ascii=False, indent=2)

    print(f"[SUCCESS] Wildberries Fission Package generated successfully:")
    print(f"  - Excel:  {excel_file}")
    print(f"  - Images: {images_dir}")
    print(f"  - Config: {json_file}")
    return str(excel_file)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export WB Fission Dataset to Excel")
    parser.add_argument("--json", required=True, help="Path to input JSON payload")
    parser.add_argument("--out", default="./output/fission", help="Output directory")
    parser.add_argument("--sku", default="SKU_DEFAULT", help="Base SKU/Product identifier")
    args = parser.parse_args()

    with open(args.json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    build_wb_batch_excel(payload, args.out, args.sku)
