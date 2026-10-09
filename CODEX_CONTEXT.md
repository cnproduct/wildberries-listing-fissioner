# Wildberries Listing Fissioner - Codex 协同开发与优化指南

本文档用于在 **Antigravity** 与 **Codex** 之间实现上下文无缝共享与协同开发，共同优化 `wildberries-listing-fissioner` 批量上架技能。

---

## 1. 项目全貌与当前进度

本项目旨在为跨境卖家提供一站式 **Wildberries 1 拆 10 裂变上架引擎**，通过飞书机器人（已部署于 Cloudflare Workers，24/7 全天候在线）实现全自动化业务闭环。

### 已完成模块：
1. **技能规约核心 (`SKILL.md`)**：
   - 包含 10 维完全解耦的受众心智定位（极简居家、商务办公、差旅户外、节日礼盒、极客防护等）。
   - 包含 10 组差异化生活化场景与光影指令（以原图为锚点，保持主体一致）。
   - 批量数据导出器：`scripts/fission_exporter.py`，支持输出标准 WB 批量导入表格。
2. **边缘端交互网关 (`cloudflare-worker/src/index.js`)**：
   - 部署于 Cloudflare Workers，绑定全球加速域名 `https://wb-bot.diytale.com/`。
   - 接入飞书开放平台 Webhook (`im.message.receive_v1`)，免审极速发布至 v1.0.1。
   - 绑定 Cloudflare KV (`WB_FISSION_KV`)，实现用户 Token 与商品任务状态持久化存储。
   - 支持直接识别 **纯数字货号 (Артикул / nmId)**、`SKU: xxx`、`货号: xxx` 以及完整详情页 URL。
   - 支持 **多轮业务问答**（进度查询、FBS 跨境集运发货、打单贴标规范、多 Listing 矩阵运营与回款）。
3. **私有仓库沉淀**：
   - GitHub: `cnproduct/wildberries-listing-fissioner` (状态: `PRIVATE`)。

---

## 2. 待与 Codex 共同优化的核心方向 (Optimization Backlog)

请在 Codex 对话中重点针对以下 3 个深水区进行架构升级与代码补充：

### 🎯 优化点 1：真机执行队列与异步调度打通 (Async Job Queue)
* **现状**：目前 Cloudflare Edge Worker 完成了消息接收、参数核验与即时进度反馈，但尚未触发真正的 10 套图文生成与 WB API 直传。
* **目标**：设计由 Cloudflare Worker 接收任务后触发后端执行器（例如通过 Webhook 唤起本地守护脚本、Cloudflare Queue 或轻量云主机任务）：
  - 抓取目标商品规格与类目属性 (`card.wb.ru`)；
  - 调用生图工具链以原图为基准批量重绘 10 张差异化主图；
  - 自动将制作完成的状态与预览回推至飞书客户端。

### 🎯 优化点 2：Wildberries 官方 Content API 直传组包 (`cards/upload`)
* **现状**：目前支持本地 Excel 导出，需补全通过 WB 官方 API 直接创建商品卡片的能力。
* **目标**：完善直接组装 `POST https://content-api.wildberries.ru/content/v2/cards/upload` 规范 JSON 载荷（包含 `subjectId`, `vendorCode`, `characteristics`, `photos` 等字段），实现真正的一键免人工直传店铺后台。

### 🎯 优化点 3：多商品任务并发与持久化队列锁
* **现状**：单个用户仅存 `latest_task`，多商品连续提交易覆盖。
* **目标**：在 KV 中将任务升级为任务列表队列 (`tasks:user_id = [...]`)，支持批量提交多个 SKU 逐一出单。

---

## 3. 本地与代码库快速映射

- **代码根目录**：`.agents/skills/wildberries-listing-fissioner`
- **核心文件路径**：
  - `SKILL.md`：10 维受众文案与生图控制核心规约
  - `cloudflare-worker/src/index.js`：线上运行的飞书交互与网关逻辑
  - `cloudflare-worker/wrangler.toml`：Cloudflare 环境变量与 KV 绑定配置
  - `scripts/fission_exporter.py`：WB 批量导出表格处理脚本
