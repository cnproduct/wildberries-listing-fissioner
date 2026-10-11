# Wildberries Listing Fissioner

在飞书发送一个 Wildberries 商品链接，自动读取原商品资料和图片，生成同款产品的10种场景图片、俄语标题与描述，并回传图文和完整压缩包。Skill 与代码可在 Codex、Antigravity 共享目录协作维护。

## 使用

向“WB 1拆10 Listing 裂变助手”发送详情链接、裸平台货号，或自然语言，例如：

> 原图参考 WB 货号 1879785812，生成10种不同应用场景的图片和描述。

系统自动获取该 nmId 的原图、名称与描述，按实际用途规划场景，使用原图编辑并逐张进行多模态对照检查。无需为了制作图文提供条码、包装尺寸、重量或原产国。无法读取原图时，只请求关键缺项；可在同一聊天发送商品原图继续。

发送“进度”查看当前阶段和已完成张数；发送“重试”恢复失败或待交付任务，并复用校验一致的已通过图片；已完成请求保持完成状态，制作新批次请再次发送链接。补充事实可发送 `资料:` 后附 JSON，但不要在聊天发送 API Token。

交付包含10条场景图文及 ZIP，内含图片、俄语文案、Excel 和 manifest。`ready` 必须有10条场景消息及压缩包的真实飞书回执。生成或上传失败会保留成品，不能误报完成。

## 运行结构

Cloudflare Worker → SQLite Durable Object 任务协调器 → 常驻 Python 执行器 → Antigravity 原生图文适配器 → 对照审查 → 飞书交付。

公开商品请求必须返回相同 nmId。WB 图片路由从当前官网使用的 CDN 配置解析，不执行远程脚本，不依赖过期的固定 basket 表。生成图片保持瓶型或其他商品形状、颜色、品牌、原包装和数量，只改变背景、光线与构图；不使用演示产品替代，不绘制占位商品。

部署、私有配置、macOS 服务和恢复机制见 [references/task-runtime.md](references/task-runtime.md)。生成依赖执行电脑保持在线及有效的 Antigravity 登录；休眠、断网或关机时，云端保留任务并显示执行器离线。

飞书应用需要获取与上传图片或文件资源权限 `im:resource`，开通后发布应用版本。缺此权限会返回真实错误 `99991672`，此时图文可生成，但不能自动上传回传。不要把机器人能回复文字视为具备图片上传权限。

## 商品事实与上架

使用前请阅读 [SKILL.md](SKILL.md)。模型对照检查辅助筛查，成品仍需卖家复核。原图和公开描述不能证明未列明的安全、认证或性能。

本流程生成营销资产。实际 WB 店铺发布需独立核验类目属性、卖家货号与条码、包装参数、账号权限、媒体上传、价格库存和可见性，不自动发布同款商品卡。差异化素材不保证流量、审核通过或重复建卡获准。

保留的通用审查导出器支持草稿与卖家资料严格校验：

```bash
python3 -m pip install -r requirements.txt
python3 scripts/fission_exporter.py --json /absolute/path/variants.json --sku SELLER_SKU --out /absolute/path/output
python3 scripts/fission_exporter.py --json /absolute/path/variants.json --sku SELLER_SKU --out /absolute/path/validated --strict
```

`--strict` 的包装参数和条码要求适用于准备店铺资料，飞书创意流程使用独立的 `creative_bundle.py`。审查工作簿不是 WB 官方导入模板。示例 JSON 为教学资料，不能用作真实生成或发布依据。输入合同见 [references/export-contract.md](references/export-contract.md)。

## 验证与协作

```bash
python3 -m unittest discover -s tests -v
node --test tests/test_worker.mjs
```

测试覆盖创意模式无需上架参数、原商品 ID 与动态图片路由、图片和标题去重、真实回执要求、部分交付恢复、并发领取、失效租约、心跳及输入解析。普通测试不发送飞书消息或创建 WB 商品。新增覆盖不同聊天隔离、凭据脱敏、持久收件与事件重放、缓存损坏、原子资产包、发送前失去租约，以及独立 WB 发布模块的参数、multipart 上传和读回边界。

当前运行事实与待办见 [CODEX_CONTEXT.md](CODEX_CONTEXT.md)。

[MIT License](LICENSE)
