# 平台规则与来源

核查日期：2026-10-08（America/Los_Angeles）。以下是当前查阅到的指导，发布前仍须核验卖家市场、类目、合同及 API 文档。

- [WB 创建商品卡片说明](https://seller.wildberries.ru/instructions/ru/by/material/how-to-create-card)：标题最大 60 字符，标题应准确说明商品；特定类目有单独填写要求。
- [WB Content API](https://dev.wildberries.ru/en/openapi/work-with-products)：创建卡片与上传媒体是不同操作。媒体链接必须直接指向无需授权的文件；图片至少 700×900，最大 32 MB，支持 JPG、PNG、BMP、静态 GIF、WebP。API 成功响应不保证全部媒体实际上传。
- [WB 商品工作流](https://dev.wildberries.ru/knowledge-base/articles/019d49a4-1320-71bb-9dac-8ba07e7177ce)：平台 `nmId`、卖家 `vendorCode` 与条码分别使用，按卡片及媒体工作流处理。

后续 API 模块应读取实时类目属性并准备 Content 创建载荷。不能把 `photos` 随意放入 `cards/upload` 当作已上传图片；需获取创建后的卡片标识，再执行媒体操作。价格、库存和发布结果单独处理。

本仓库没有验证任何“文本相似度小于 20%”“关键词完全不重合”“多个账号隔离可规避风控”等规则。不得据此承诺平台通过或收益。物流地址、交付时限、履约节点和结算周期必须按具体店铺后台及合同回答，不能把固定示例作为所有中国卖家的通则。

飞书 Webhook 当前仅支持未加密事件的 Verification Token 校验；不支持加密事件解密或基于 Encrypt Key 的签名验证。启用相应功能前应按[飞书事件订阅文档](https://open.feishu.cn/document/server-docs/event-subscription-guide/overview)补齐实现。
