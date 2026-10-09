/**
 * Feishu receipt gateway. Generation and WB publishing executors are not connected.
 * KV stores separate requests, but does not provide an atomic queue or execution lock.
 */
const DEFAULT_APP_ID = "cli_aa42e84775381cfd";

export function resolveProduct(text) {
  const urlText = text.match(/https?:\/\/[^\s<>]+/i)?.[0];
  if (urlText) {
    try {
      const url = new URL(urlText);
      if (!["wildberries.ru", "www.wildberries.ru", "wb.ru", "www.wb.ru"].includes(url.hostname) || url.username || url.password) return null;
      const match = url.pathname.match(/^\/catalog\/([0-9]{1,13})\/detail\.aspx\/?$/i);
      if (!match) return null;
      return { nmId: match[1], url: "https://www.wildberries.ru/catalog/" + match[1] + "/detail.aspx" };
    } catch { return null; }
  }
  // Seller SKU and barcode are not WB platform identifiers.
  const match = text.match(/^(?:(?:货号|артикул|articul|nmid)\s*[:：]?\s*|(?:裂变|上架)\s*[:：]?\s*)?([0-9]{6,13})$/i);
  return match ? { nmId: match[1], url: "https://www.wildberries.ru/catalog/" + match[1] + "/detail.aspx" } : null;
}

async function getTenantAccessToken(env) {
  if (!env.FEISHU_APP_SECRET) throw new Error("FEISHU_APP_SECRET is not configured");
  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID || DEFAULT_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) throw new Error("Feishu authentication failed");
  return data.tenant_access_token;
}

async function sendFeishuReply(token, messageId, chatId, text) {
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const content = JSON.stringify({ text });
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
    method: "POST", headers, body: JSON.stringify({ content, msg_type: "text" })
  });
  const data = await response.json();
  if (response.ok && data.code === 0) return;
  if (!chatId) throw new Error("Feishu reply failed");
  const fallback = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST", headers, body: JSON.stringify({ receive_id: chatId, content, msg_type: "text" })
  });
  const fallbackData = await fallback.json();
  if (!fallback.ok || fallbackData.code !== 0) throw new Error("Feishu message delivery failed");
}

export async function buildReply(text, senderId, messageId, env) {
  // 1. 拦截实现原理、架构等内部技术询问
  const techKeywords = ["原理", "怎么实现", "如何实现", "什么模型", "架构", "源码", "代码", "提示词", "prompt", "技术", "cloudflare", "antigravity", "生图工具", "comfyui", "内部规则"];
  if (techKeywords.some(kw => text.toLowerCase().includes(kw))) {
    return "这部分属于内部实现资料，无法在客户对话中提供。我可以介绍可用功能、所需资料，或帮您查看上架结果。";
  }

  // 2. 拦截明文 API Token 避免日志泄露
  if (/^(?:绑定api|api)\s*[:：]/i.test(text) || (text.length > 80 && !/\s/.test(text) && !/^https?:/i.test(text))) {
    return "当前尚未开通店铺授权核验与直传，请勿在聊天中发送 API Token。本次没有保存令牌，也没有验证店铺权限。";
  }

  // 3. 商品解析与请求记录
  const product = resolveProduct(text);
  if (product) {
    if (!env.WB_FISSION_KV) return "已识别 WB 货号 " + product.nmId + "，但请求保存服务未配置，请稍后重试。尚未开始生成或发布。";
    const taskKey = "task:" + encodeURIComponent(senderId) + ":" + encodeURIComponent(messageId);
    let task = await env.WB_FISSION_KV.get(taskKey, "json");
    if (!task) {
      task = { task_id: messageId, nmId: product.nmId, url: product.url, timestamp: Date.now(), status: "waiting_executor" };
      await env.WB_FISSION_KV.put(taskKey, JSON.stringify(task));
      await env.WB_FISSION_KV.put("latest_task:" + senderId, JSON.stringify({ task_key: taskKey }));
    }
    return "已记录商品请求：WB 货号 " + task.nmId + "\n商品链接：" + task.url +
      "\n请求编号：" + task.task_id + "\n当前状态：待执行。自动制作与店铺发布尚未接通，暂无完成时间。可发送“进度”查看最近请求。";
  }

  // 4. 进度查询
  if (/(进度|多久|完成了吗|好了吗|有在执行吗|在做吗|开始了吗|状态|排队|完成了没)/.test(text)) {
    if (!env.WB_FISSION_KV) return "请求保存服务未配置，无法查询进度。尚未开始自动生成或发布。";
    const latest = await env.WB_FISSION_KV.get("latest_task:" + senderId, "json");
    if (!latest) return "尚未找到您的商品请求，请发送 WB 详情页链接或平台货号。";
    if (!latest.task_key) return "发现旧版请求记录，但没有可验证的执行结果。请重新提交商品链接；尚不能确认已生成或上架。";
    const task = await env.WB_FISSION_KV.get(latest.task_key, "json");
    if (!task) return "暂未读取到请求记录，请稍后重试。";
    return "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id +
      "\n状态：" + (task.status === "waiting_executor" ? "待执行，自动制作与店铺发布尚未接通" : "执行状态尚未核验") +
      "。\n暂无可验证的生成文件或上架结果，也暂无完成时间。";
  }

  // 5. 出单发货与履约指引 (保留实用干货并提醒以订单合同为准)
  if (/(发货|出单|打单|物流|集运|贴标|条码|fbs|fbo|fbw|运费)/i.test(text)) {
    return "📦 **Wildberries 履约发货实操指引 (FBS 跨境集运)**\n\n" +
      "1️⃣ **出单确认**：在卖家后台「Сборочные задания」接单并生成拣货任务。\n" +
      "2️⃣ **打印标签**：单个内包装贴商品条码标签 (Штрихкод 58×40mm)，外箱贴订单 QR 扫描码。\n" +
      "3️⃣ **集运交接**：寄往官方认证国内集运仓（东莞/义乌/深圳等），扫码入库即履约成功。\n\n" +
      "💡 交付地址、标签格式、时限（通常 72~120h）和履约完成条件请以具体订单与合同核验；请勿把商品条码当作 WB 平台货号。";
  }

  // 6. 运营与结算建议
  if (/(运营|排名|权重|定价|改价|活动|促销|回款|提现|结算|退货|销量|推广)/.test(text)) {
    return "📈 **Wildberries 运营与结算建议**\n\n" +
      "1️⃣ **多方案对比**：可比较不同文案与主图在曝光、点击率、加购率上的表现；差异化素材本身不承诺平台排名或销量。\n" +
      "2️⃣ **提报官方活动**：在后台「Календарь акций」提报大促，获取活动加权。\n" +
      "3️⃣ **回款账期**：以店铺后台与销售合同约定的结算周期为准，通过合规跨境渠道提现。";
  }

  // 7. 卖家 SKU 与条码区分提示
  if (/^(?:sku|条形码|barcode|商品编码)\s*[:：]/i.test(text)) {
    return "这是卖家 SKU 或条码，无法直接定位 WB 商品。请提供 WB 详情页链接或平台货号 nmId。";
  }

  // 8. 默认引导
  return "我是 WB 商品资料助手。请发送 WB 商品详情链接或平台货号，并准备原图、真实规格与包装测量。\n目前可以记录商品请求、查询待执行状态；自动制作和店铺发布尚未接通。请勿发送 API Token。";
}

export async function handleFeishuEvent(payload, env) {
  const { message, sender } = payload.event || {};
  if (!message || sender?.sender_type === "app" || message.message_type !== "text") return;
  const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id;
  if (!senderId || !message.message_id) return;
  let text;
  try { text = JSON.parse(message.content).text?.trim(); } catch { return; }
  if (!text) return;
  const token = await getTenantAccessToken(env);
  const reply = await buildReply(text, senderId, message.message_id, env);
  await sendFeishuReply(token, message.message_id, message.chat_id, reply);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") return json({ status: "online", service: "WB request receipt", generation_enabled: false, publishing_enabled: false });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("Invalid event", { status: 400 });
    if (body.encrypt) return new Response("Encrypted events are not supported", { status: 400 });
    if (!env.FEISHU_VERIFICATION_TOKEN) return new Response("Webhook verification is not configured", { status: 503 });
    const incomingToken = body.type === "url_verification" ? body.token : body.header?.token;
    if (incomingToken !== env.FEISHU_VERIFICATION_TOKEN) return new Response("Forbidden", { status: 403 });
    if (body.type === "url_verification") {
      if (typeof body.challenge !== "string") return new Response("Invalid challenge", { status: 400 });
      return json({ challenge: body.challenge });
    }
    if (body.header?.event_type === "im.message.receive_v1") {
      if (body.header.app_id !== (env.FEISHU_APP_ID || DEFAULT_APP_ID)) return new Response("Wrong app", { status: 403 });
      if (!env.FEISHU_APP_SECRET || !env.WB_FISSION_KV) return new Response("Receipt service is not configured", { status: 503 });
      ctx.waitUntil(handleFeishuEvent(body, env).catch(() => {
        console.error("Feishu event processing failed");
      }));
    }
    return json({ code: 0 });
  }
};
