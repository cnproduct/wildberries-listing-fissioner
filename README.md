# Wildberries Listing Fissioner

把一个商品的已确认事实转为多套俄语营销方案、场景主图与可审查资产包，默认十套。可用于 Codex 与 Antigravity 共享工作目录。

本项目目前提供 Skill 指令、Python 导出器与飞书请求接收示例。自动商品抓取、图文生成执行器和 WB API 发布尚未接通。素材差异化不保证流量、平台审核通过或同商品重复创建获准。

## 使用 Skill

阅读 [SKILL.md](SKILL.md)，提供 WB 详情链接或平台货号、原图、真实规格与包装测量。Agent 先锁定商品事实，再选择适用的受众与场景，制作并逐项审查图文。

材质、容量、性能、包装数量等事实不能因营销方案变化。卖家 SKU、WB 平台货号 nmId 和条码必须区分。

## 本地导出

Python 3.10+；先安装依赖：

```bash
python3 -m pip install -r requirements.txt
python3 scripts/fission_exporter.py --json examples/sample_fission_data.json --sku DEMO --out ./output
```

示例是虚构教学资料，图片链接为占位地址，只能作为草稿演示。默认导出缺项清单，不自动补尺寸、重量、价格、折扣、品牌、原产国或条码。

实际商品资料完整后运行严格校验：

```bash
python3 scripts/fission_exporter.py --json /absolute/path/variants.json --sku SELLER_SKU --out ./output/validated --strict
```

数量不是十套时加 `--expected-count N`。图片相对路径按输入 JSON 所在目录解析。输出目录已存在时拒绝覆盖。

输出 `wb_fission_<SKU>/` 中包含：

- `WB_Listing_Review_<SKU>.xlsx`：内部审查工作簿与 QA 清单。
- `images/`：归档本地图像，保留实际文件格式。
- `wb_fission_<SKU>_manifest.json`：版本、缺项、相对路径与草稿/校验状态。

工作簿不是 WB 官方导入模板。正式导入必须下载卖家后台当前类目模板并验证字段映射。严格模式通过仅代表脚本校验通过，商品真实性、图像一致性与平台发布需分别验证。输入合同见 [references/export-contract.md](references/export-contract.md)。

## 飞书网关

### Cloudflare Worker

源码见 `cloudflare-worker/src/index.js`。识别 WB 商品链接和平台货号，把每条请求保存到独立 KV 键；“进度”显示最近请求的真实待执行状态。不会根据耗时伪造进度，也不会保存聊天中的 WB Token 或声称店铺授权有效。

部署前在 Cloudflare 受保护的 Secret 配置中设置：

- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`

保留正确的 `FEISHU_APP_ID`、`WB_FISSION_KV` 绑定和域名配置。Webhook 当前支持未加密事件的 Verification Token 与 app_id 校验；加密事件会拒绝，解密及签名验证尚未实现。没有必要配置时拒绝处理事件。

源码修改不会更新线上服务。本轮没有重新部署、发送飞书消息或创建 WB 商品。

KV 中 `task:<sender>:<message>` 保存独立请求，`latest_task:<sender>` 仅是最近请求的指针。顺序重试可复用已保存请求；KV 最终一致性不能保证并发幂等、原子锁或消息必达。后续正式任务队列应使用持久队列与具备事务/租约的状态存储。

### 本地长连接

```bash
python3 scripts/feishu_bot_service.py
```

启动前通过进程环境配置 `FEISHU_APP_SECRET` 和可选的 `FEISHU_APP_ID`。本地模式只演示消息接收，不持久化任务或令牌；自动生成和店铺发布尚未接通。

## 已暴露凭证的处理

旧版本在源码及配置中包含应用密钥。本轮已移除当前工作文件中的密钥并忽略本地凭证与用户数据目录，但 Git 历史和已部署服务没有因此改变。上线前必须在飞书后台轮换密钥，并更新受保护的环境配置。历史 Token 存储与日志是否存在应由维护者另行检查；本轮没有访问或删除线上数据。

## 验证与协同

```bash
python3 -m unittest discover -s tests -v
node --test tests/test_worker.mjs
```

测试均使用临时目录或模拟飞书服务，没有外部消息和商品发布。

Antigravity 与 Codex 的共享进度、兼容性变更及下一步任务见 [CODEX_CONTEXT.md](CODEX_CONTEXT.md)。读取该文件与当前差异后再编辑；同一文件同时变化时合并处理，避免覆盖另一方的更新。

[MIT License](LICENSE)
