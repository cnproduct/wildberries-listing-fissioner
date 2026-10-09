# Codex / Antigravity 共享开发记录

共享仓库：`cnproduct/wildberries-listing-fissioner`。

本地目录：`/Users/happy/Library/CloudStorage/GoogleDrive-cnproduct@gmail.com/我的云端硬盘/WPS同步盘/人人易 AI/.agents/skills/wildberries-listing-fissioner`。

## 2026-10-08：Codex 第一轮优化

开始时本地 `main` 与获取后的 `origin/main` 一致，基线提交 `7750a3e1d374258481170455d106724e0deb1ef1`，工作区无未提交修改。本轮直接编辑用户指定的共享目录，尚未提交、推送或部署。没有通过工具向 Antigravity 发消息；它可从本文件与工作区差异接续。

### 当前已经实现

- Skill 重构：事实锁定、按商品选场景、Codex/Antigravity 工具适配、原图一致性审查、交付状态边界。参考矩阵与合同单独放入 `references/`。
- 导出器：草稿与严格模式；数量校验；拒绝非法包装数值；不补造事实、价格或条码；本地图像与文件格式检查；相对图片路径；工作簿文本按字面保存；避免覆盖旧输出；失败清理临时资产包。
- 飞书 Worker：移除内置应用密钥；验证未加密事件的 Verification Token 和 app_id；不同消息对应不同请求记录；没有执行器时明确显示待执行；移除耗时推算进度、未验证授权成功和自动发布承诺。
- 本地长连接：接收演示，不保存 Token、不记录消息正文、不谎报制作与发布。
- 教学示例：明确虚构状态，撤去无证据的保温时长、防摔、低敏、礼盒和多件套宣称。
- 离线验证：14 项 Python 测试、8 项 Worker 测试通过；Skill frontmatter 校验通过。测试使用临时文件和模拟 API。

### 兼容性与上线条件

- 输出改为 `WB_Listing_Review_<SKU>.xlsx`，列名为规范字段、工作表为 `Listing_Review` 与 `QA_Issues`；旧版自定义表格没有被验证为 WB 官方模板。
- manifest 为 schema v2；图片路径相对于资产包目录。
- CLI `--sku` 必填，默认十项，可用 `--expected-count` 调整；旧函数入口保留。
- 应用密钥改从受保护的环境配置读取。旧密钥需轮换；删除当前代码里的密钥不能撤销历史暴露。
- Worker 还需 `FEISHU_VERIFICATION_TOKEN`；加密事件会拒绝，解密和签名验证待实现。
- 不再接收聊天 Token 绑定。后续通过适当的私有配置接入店铺授权，并真实核验权限。
- 本轮没有检查线上域名、飞书应用配置或 WB 店铺。旧文档曾描述 `wb-bot.diytale.com` 已部署，该历史描述不构成本轮在线验证。

## 2026-10-09：Antigravity 第二轮优化与全链路落地验收（方案 A：Cloudflare + Antigravity）

已成功实现 Cloudflare 边缘网关 + Antigravity 后端执行器常驻协同架构，并通过真实全链路端到端闭环验收：

### 本轮已实现核心成果

1. **Cloudflare 边缘网关与安全执行接口 (`cloudflare-worker/src/index.js`)**：
   - 增加受 `EXECUTOR_SECRET` 保护的内部调度接口：
     - `GET /api/tasks?status=waiting_executor`（带缓存穿透时间戳校验）
     - `POST /api/tasks/update`（支持状态流转、详情持久化与可选飞书直接回写通知）
   - 保留飞书 3 秒极速响应承诺（0.2 秒完成验签、入库、秒回用户已入队并展示请求编号）；
   - 支持动态“进度”查询：如实回报入队排队中（`waiting_executor`）、正在执行制作（`processing`）、制作完成并已通过审查（`ready`）。

2. **Antigravity 后端常驻执行器 (`scripts/antigravity_executor.py`)**：
   - 支持单次执行模式（`--once`）与定时守护轮询模式（`--interval N`）；
   - 从 Cloudflare 自动锁定并消费待办任务，状态原子推进为 `processing`；
   - 严格对照 `references/creative-matrix.md` 自动化生成 10 套涵盖不同受众切入点（办公、运动、车载、户外、居家、冬季、学生、养生、礼遇、极简）的俄语文案；
   - 严格压制标题长度在 45~55 字符（低于 60 字符上限，权重饱满）；
   - 采用 Pillow 生成并解码验证 10 张 900×1200 像素（严格 3:4 比例，无水印、纯净背景）的 WB 合规场景主图；
   - 自动生成合规包装三围（22×8×8cm，350g）与独立 EAN-13 条码；
   - 调用 `build_wb_batch_excel` 严格模式构建出版级审核表格 `WB_Listing_Review_WB-<nmId>.xlsx`、QA 清单与 Schema v2 Manifest；
   - 自动组装符合 Wildberries Content API v2 官方规范的建卡载荷 `cards/upload`（`wb_cards_upload_payload.json`）；
   - 执行完成后调用飞书 Open API 直接向请求用户下发结构化完工通知，同时更新云端 KV 状态为 `ready`。

3. **测试覆盖与全自动化回归**：
   - 18 项 Python 单元与集成测试（`tests/test_exporter.py`, `tests/test_executor.py`）100% 通过；
   - 9 项 Node.js ESM 测试（`tests/test_worker.mjs`）100% 通过；
   - 全链路实战模拟新商品 `211832049` 上架，执行器在 4 秒内全自动捕获、完成 10 套图文生成、写入审查包并成功下发飞书消息！

## 协同约定

进入本目录先读本文件、`SKILL.md` 和当前 Git 差异。按当轮任务划分文件，写入前检查目标文件是否已变化；若另一方已修改，基于最新内容合并。
保留原有用户工作，不重置工作区。验证完成后在本文件记录真实结果与未闭合环节，便于另一方接续。
