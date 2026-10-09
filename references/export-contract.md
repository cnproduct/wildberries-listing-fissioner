# 导出输入与状态

输入根对象含 `items` 数组，默认正好十项。全局共享事实字段为 `brand`、`category`、`composition`、`country`，包装测量为 `length_cm`、`width_cm`、`height_cm`、`weight_kg`。这些字段可由每项继承；单项与全局事实冲突会列为 QA 问题，严格模式拒绝。不同真实商品或销售包装应拆开导出。

每项需有 `persona`、`title`、`description`、`keywords`（字符串或字符串数组），以及 `image_path`（优先）或 `image_url`。可选 `price`、`discount`；缺失时为空，不自动定价。条码 `barcode` 按项填写真实字符串；不生成占位条码。营销版本编号不等于新条码，不据此断定必须分配十个实体条码。

包装尺寸和重量是包装后的实际测量，不是商品裸件尺寸。数值必须是有限正数，布尔值、数字字符串、零、负数、NaN、Infinity 拒绝；折扣为 0–100。明确提供非法数值时即使草稿模式也拒绝。

图片相对路径以输入 JSON 所在目录为基准，Python 函数调用者可传 `base_dir`。检查实际文件格式并保留相应扩展名。严格模式只接受可解码的静态本地图像，至少 700×900、最大 32 MiB。尺寸、格式校验不代替原图一致性审查。远程 URL 在草稿中保留并注明尚未验证，不下载、不声称已归档。

默认 `--expected-count 10`，可改为 1–100。SKU 只接受 1–64 个字母、数字、下划线、连字符；拒绝路径字符。输出目录已存在时拒绝覆盖，可另选输出目录保存新一轮结果。

输出目录 `wb_fission_<SKU>/` 含：

- `WB_Listing_Review_<SKU>.xlsx`：`Listing_Review` 数据与 `QA_Issues` 问题清单，文字按字面保存，避免公式执行。
- `images/`：成功复制的本地图片。
- `wb_fission_<SKU>_manifest.json`：`schema_version: 2`，状态 `draft` 或 `validated_assets`，始终 `official_import_template: false`、`published: false`。

教学资料应标注 `example_only: true`，该标记进入 manifest 并阻止严格校验通过；替换成卖家确认的真实商品资料后再制作正式资产。

工作簿列名与旧版不同，不能继续按“官方模板”使用。CLI 的 `--sku` 现在必填。原函数 `build_wb_batch_excel(data, output_dir, sku)` 保留，附加选项为关键字参数。
