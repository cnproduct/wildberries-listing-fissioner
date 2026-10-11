import { TaskCoordinator } from "./task-coordinator.js";
export { TaskCoordinator };

const DEFAULT_APP_ID = "cli_aa42e84775381cfd";
const j = (data, status = 200) => Response.json(data, { status, headers:{"Cache-Control":"private, no-store, max-age=0","Vary":"Authorization"} });
export async function coordinate(env, path, body) {
  if (!env.TASK_COORDINATOR) throw new Error("Task coordinator is not configured");
  const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName("wb-fission"));
  return stub.fetch(new Request("https://coordinator" + path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }));
}
export function resolveProduct(text) {
  if (/^(?:sku|条形码|barcode|商品编码)\s*[:：]/i.test(text)) return null;
  const ids = [...text.matchAll(/(?:货号|артикул|articul|nmid)\s*[:：]?\s*([0-9]{6,13})(?![0-9])/gi)].map(m => m[1]);
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (!["wildberries.ru", "www.wildberries.ru", "wb.ru", "www.wb.ru"].includes(url.hostname) || url.username || url.password || url.port) return null;
      const product = url.pathname.match(/^\/catalog\/([0-9]{6,13})\/detail\.aspx\/?$/i);
      if (!product) return null;
      ids.push(product[1]);
    } catch { return null; }
  }
  const raw = text.match(/^(?:(?:裂变|上架|生成)\s*[:：]?\s*)?([0-9]{6,13})$/);
  if (raw) ids.push(raw[1]);
  const unique = [...new Set(ids)];
  return unique.length === 1 ? { nmId: unique[0], url: "https://www.wildberries.ru/catalog/" + unique[0] + "/detail.aspx" } : null;
}

async function getTenantAccessToken(env) {
  if (!env.FEISHU_APP_SECRET) throw new Error("Feishu secret missing");
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(messageId + ":reply"));
  const uuid = Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
    method: "POST", headers, body: JSON.stringify({ content, msg_type: "text", uuid })
  });
  const data = await response.json();
  if (response.ok && data.code === 0) return;
  if (!chatId) throw new Error("Feishu reply failed");
  const fallback = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
    method: "POST", headers, body: JSON.stringify({ receive_id: chatId, content, msg_type: "text", uuid })
  });
  const fallbackData = await fallback.json();
  if (!fallback.ok || fallbackData.code !== 0) throw new Error("Feishu message delivery failed");
}
async function health(env) { return (await coordinate(env, "/health")).json(); }

export async function buildReply(text, senderId, messageId, env, chatId = null) {
  const credentialText = /^资料\s*[:：]/.test(text) ? "" : text;
  const hasTokenMatch = credentialText.match(/(?:API令牌|api_token|token|令牌)\s*[:：]\s*([^\s]+)/i) ||
    credentialText.match(/^(?:绑定api|api)\s*[:：]\s*([^\s]+)/i) ||
    (credentialText.match(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) ? [null, credentialText] : null);
  const hasShopMatch = credentialText.match(/(?:店铺名|店铺|shop)\s*[:：]\s*([^\s]+)/i);
  const hasWarehouseMatch = credentialText.match(/(?:仓库ID|仓库|warehouse(?:_id)?)\s*[:：]\s*([^\s]+)/i);

  if (hasTokenMatch || hasShopMatch || hasWarehouseMatch) {
    const creds = {};
    if (hasTokenMatch) creds.api_token = hasTokenMatch[1].trim();
    if (hasShopMatch) creds.shop_name = hasShopMatch[1].trim();
    if (hasWarehouseMatch) creds.warehouse_id = hasWarehouseMatch[1].trim();
    const stored = await coordinate(env, "/credentials", { sender_id: senderId, credentials: creds });
    if (!stored.ok) return "店铺资料未保存，请检查输入后重试。";
    let replyText = "已成功记录并落盘店铺凭据：\n";
    if (creds.shop_name) replyText += "• 店铺名称：" + creds.shop_name + "\n";
    if (creds.warehouse_id) replyText += "• 发货仓库：" + creds.warehouse_id + "\n";
    if (creds.api_token) replyText += "• WB API 令牌：已成功落盘存储\n";
    replyText += "已保存到您的账号；尚未验证令牌权限。图文制作不会自动上架，发布店铺商品需另行核验与授权。";
    return replyText;
  }
  if (/^资料\s*[:：]/.test(text)) {
    let facts;
    try { facts = JSON.parse(text.replace(/^资料\s*[:：]\s*/, "")); } catch { return "资料格式无效。请发送“资料:”后附 JSON 格式的真实商品规格，或先发送原图。"; }
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) return "商品资料必须是 JSON 对象。";
    // Image resource references come only from signed image events, never user JSON.
    for (const key of Object.keys(facts)) {
      if (!['product_name','brand','category','composition','country','sales_quantity','verified_features','source_description','length_cm','width_cm','height_cm','weight_kg','barcode','barcodes'].includes(key)) delete facts[key];
    }
    const valid = Object.entries(facts).every(([key,value]) => {
      if (['length_cm','width_cm','height_cm','weight_kg','sales_quantity'].includes(key)) return typeof value === 'number' && Number.isFinite(value) && value>0;
      if (['verified_features','barcodes'].includes(key)) return Array.isArray(value) && value.every(v=>typeof v==='string' && v.trim());
      return typeof value === 'string' && !!value.trim();
    });
    if (!Object.keys(facts).length || !valid) return "资料字段或格式无效：商品名称等使用文字，包装测量与数量使用正数，功能与条码列表使用数组。";
    const response = await coordinate(env, "/input", { sender_id: senderId, chat_id: chatId, message_id: messageId, facts });
    return response.ok ? "已保存补充资料，系统会重新核验并继续处理。尚未确认上架。" : "暂不能补充资料，请先提交商品链接，或等待当前处理结束。";
  }
  if (/^(?:重试|继续制作|重新发送|retry)$/i.test(text)) {
    const latest = await (await coordinate(env,"/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || ""))).json();
    if (!latest.key) return "请先发送一个 WB 商品链接。";
    if (latest.task?.status === "ready") return "该请求的10套图文及压缩包已交付本聊天，无需重试。制作新一批请重新提交商品链接。";
    const resumed = await coordinate(env,"/retry",{key:latest.key,message_id:messageId});
    return resumed.ok ? "已恢复该商品请求，已有通过检查的图片会继续使用，完成后回传本聊天。" : "当前请求正在执行，可发送“进度”查看。";
  }
  const product = resolveProduct(text);
  if (product) {
    const key = "task:" + encodeURIComponent(senderId) + ":" + encodeURIComponent(messageId);
    const response = await coordinate(env, "/put", { key, task: { task_id: messageId, sender_id: senderId, chat_id: chatId, mode: "creative", ...product } });
    if (!response.ok) throw new Error("Task persistence failed");
    const h = await health(env);
    return "已记录商品请求：WB 货号 " + product.nmId + "\n请求编号：" + messageId +
      "\n当前状态：" + (h.online ? "等待处理，执行服务在线。" : "等待处理，执行服务暂时离线；恢复后会继续处理。") +
      "\n系统会自动读取原图和商品信息，制作10种应用场景的图片、俄语标题和描述，完成后回传本聊天。可发送“进度”查看。";
  }
  if (/(进度|多久|完成了吗|好了吗|有在执行吗|在做吗|开始了吗|状态|排队|完成了没)/.test(text)) {
    const { task } = await (await coordinate(env, "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || ""))).json();
    if (!task) return "尚未找到您的商品请求，请发送 WB 商品详情链接或平台货号。";
    const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n";
    if (task.status === "waiting_executor") {
      const h = await health(env);
      return prefix + (h.online ? "状态：等待处理，执行服务在线。" : "状态：执行服务暂时离线，请求已保存，恢复后继续。") + "\n尚未确认生成或上架。";
    }
    const labels = { validating: "资料核验中", processing: "处理中", generating_text: "文案制作中", generating_images: "图片制作中", reviewing: "审查中",
      needs_input: "需要补充资料", awaiting_delivery: "图文已生成，等待飞书交付", failed: "处理失败，需检查", ready: "资产包已生成，尚未上架", cancelled: "已取消" };
    return prefix + "状态：" + (labels[task.status] || "待核验") + "。\n" + (task.summary || "");
  }
  if (/^(?:sku|条形码|barcode|商品编码)\s*[:：]/i.test(text)) return "卖家 SKU 或条码不能直接定位 WB 商品，请提供平台货号 nmId 或详情链接。";
  if (/(发货|出单|打单|物流|集运|贴标|条码|fbs|fbo|fbw|运费)/i.test(text)) return "发货地址、标签、时限与履约条件请按具体订单和店铺合同核验。请提供店铺市场、销售模式与后台发货要求。";
  return "请发送一个 WB 商品链接或“WB 货号 123456789”。系统自动读取原图，生成10种同款产品的场景图片、俄语标题和描述，并回传飞书。可发送“进度”查看状态。";
}
export async function handleFeishuEvent(payload, env) {
  const { message, sender } = payload.event || {};
  if (!message || sender?.sender_type === "app") return;
  const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id;
  if (!senderId || !message.message_id) return;
  let content;
  try { content = JSON.parse(message.content); } catch { return; }
  let reply;
  if (message.message_type === "text" && typeof content.text === "string") {
    reply = await buildReply(content.text.trim(), senderId, message.message_id, env, message.chat_id);
  } else if (message.message_type === "image" && typeof content.image_key === "string") {
    const response = await coordinate(env, "/input", { sender_id: senderId, chat_id: message.chat_id, message_id:message.message_id, facts: { source_image_key: content.image_key, source_image_message_id: message.message_id } });
    reply = response.ok ? "已收到商品原图，将继续制作10套场景图片与描述。" : "请先提交商品链接，或等待当前处理结束后再发送原图。";
  } else return;
  const token = await getTenantAccessToken(env);
  await sendFeishuReply(token, message.message_id, message.chat_id, reply);
}

async function processStoredEvent(entry,env){
  const claimed=await coordinate(env,"/events/claim",{id:entry.id});
  if (!claimed.ok) return;
  const claim=await claimed.json();
  try{
    await handleFeishuEvent(claim.event.payload,env);
    await coordinate(env,"/events/done",{id:entry.id,lease:claim.lease});
  }catch{console.error("Feishu event deferred; persistent inbox will retry");}
}

export default {
  async scheduled(event, env, ctx) {
    env={...env, FEISHU_APP_SECRET:env.FEISHU_APP_SECRET_V2 || env.FEISHU_APP_SECRET};
    ctx.waitUntil((async()=>{
      await coordinate(env, "/recover");
      const events = await (await coordinate(env, "/events")).json();
      for (const entry of events.events || []) await processStoredEvent(entry, env);
    })());
  },
  async fetch(request, env, ctx) {
    // Normalize new Secret bindings without preserving old plaintext config.
    env = { ...env,
      EXECUTOR_SECRET: env.EXECUTOR_SECRET_V2 || env.EXECUTOR_SECRET,
      FEISHU_APP_SECRET: env.FEISHU_APP_SECRET_V2 || env.FEISHU_APP_SECRET,
      FEISHU_VERIFICATION_TOKEN: env.FEISHU_VERIFICATION_TOKEN_V2 || env.FEISHU_VERIFICATION_TOKEN };
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      let h;
      try { h = await health(env); } catch { h = { online: false, capabilities: {}, counts: {} }; }
      return j({ status: "online", service: "WB task gateway", queue_backend: "durable-object",
        executor_online: h.online, executor_last_seen: h.last_seen || null,
        generation_enabled: h.online && !!h.capabilities.generation, publishing_enabled: false,
        task_counts: h.counts, pending_events:h.pending_events || 0, event_failures:h.event_failures || 0, version: "2026-10-10-audit2" });
    }
    if (url.pathname.startsWith("/media/") && request.method === "GET") {
      const key = url.pathname.slice("/media/".length);
      if (!env.WB_FISSION_KV) return j({ error: "KV not configured" }, 503);
      const data = await env.WB_FISSION_KV.get("media:" + key, { type: "arrayBuffer" });
      if (!data) return new Response("Not found", { status: 404 });
      const ext = key.split(".").pop().toLowerCase();
      const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      return new Response(data, {
        headers: {
          "Content-Type": ct,
          "Cache-Control": "public, max-age=86400, s-maxage=86400"
        }
      });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!env.EXECUTOR_SECRET) return j({ error: "Executor authentication not configured" }, 503);
      if (request.headers.get("Authorization") !== "Bearer " + env.EXECUTOR_SECRET) return j({ error: "Unauthorized" }, 401);
      if (url.pathname.startsWith("/api/media/") && request.method === "PUT") {
        const key = url.pathname.slice("/api/media/".length);
        if (!env.WB_FISSION_KV) return j({ error: "KV not configured" }, 503);
        if (!/^[A-Za-z0-9_-]{1,120}\.(png|jpe?g|webp)$/i.test(key)) return j({error:"Invalid image key"},400);
        const body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > 32*1024*1024) return j({error:"Image size invalid"},413);
        const bytes = new Uint8Array(body);
        const png = bytes[0]===137 && bytes[1]===80 && bytes[2]===78 && bytes[3]===71;
        const jpg = bytes[0]===255 && bytes[1]===216;
        const webp = new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP';
        if (!(png && /\.png$/i.test(key) || jpg && /\.jpe?g$/i.test(key) || webp && /\.webp$/i.test(key))) return j({error:"Image format mismatch"},400);
        await env.WB_FISSION_KV.put("media:" + key, body);
        return j({ success: true, key, url: url.origin + "/media/" + key, size: body.byteLength });
      }
      if (url.pathname === "/api/wb-resource" && request.method === "GET") {
        let resource;
        try { resource = new URL(url.searchParams.get("url")); } catch { return j({error:"Invalid URL"},400); }
        const allowed = resource.hostname === "www.wildberries.ru" || resource.hostname === "static.wbstatic.net" || resource.hostname === "cdn.wbbasket.ru" || /^[a-z]{3}-basket-cdn-[0-9]+\.geobasket\.ru$/.test(resource.hostname) ||
          /^(?:static-)?basket-[0-9]+\.(?:wbbasket|wb)\.ru$/.test(resource.hostname);
        if (!allowed || resource.protocol !== "https:" || resource.username || resource.password || resource.port) return j({error:"Forbidden resource"},400);
        try {
          const upstream = await fetch(resource.href,{signal:AbortSignal.timeout(10000),redirect:"manual",headers:{"User-Agent":"Mozilla/5.0","Referer":"https://www.wildberries.ru/"}});
          if (!upstream.ok) return j({error:"WB resource unavailable",upstream_status:upstream.status},502);
          return new Response(upstream.body,{headers:{"Content-Type":upstream.headers.get("Content-Type") || "application/octet-stream","Cache-Control":"private, no-store"}});
        } catch (error) { return j({error:"WB resource unavailable",reason:error.name + ": " + error.message},502); }
      }
      if (url.pathname === "/api/credentials") {
        if (!["GET", "POST"].includes(request.method)) return j({error:"Method not allowed"},405);
        return coordinate(env, "/credentials" + url.search, request.method === "POST" ? await request.json() : undefined);
      }
      if (url.pathname === "/api/wb-proxy" && ["GET", "POST", "PUT", "PATCH"].includes(request.method)) {
        let target;
        try { target = new URL(url.searchParams.get("url")); } catch { return j({ error: "Invalid URL" }, 400); }
        const allowedHosts = [
          "content-api.wildberries.ru",
          "marketplace-api.wildberries.ru",
          "discounts-prices-api.wildberries.ru",
          "card.wb.ru",
          "cdn.wbbasket.ru"
        ];
        const isAllowed = allowedHosts.includes(target.hostname) ||
          /^[a-z]{3}-basket-cdn-[0-9]+\.geobasket\.ru$/.test(target.hostname) ||
          /^(?:static-)?basket-[0-9]+\.(?:wbbasket|wb)\.ru$/.test(target.hostname);
        if (!isAllowed || target.protocol !== "https:" || target.username || target.password || target.port) return j({ error: "Forbidden host: " + target.hostname }, 403);
        const headers = new Headers();
        const wbToken = request.headers.get("X-WB-Token");
        const sellerHost = ["content-api.wildberries.ru", "marketplace-api.wildberries.ru", "discounts-prices-api.wildberries.ru"].includes(target.hostname);
        if (!sellerHost && request.method !== "GET") return j({error:"Public resources are read-only"},400);
        if (wbToken && sellerHost) headers.set("Authorization", wbToken);
        const ct = request.headers.get("Content-Type");
        if (ct) headers.set("Content-Type", ct);
        for (const [k, v] of request.headers.entries()) {
          const lower = k.toLowerCase();
          if (lower.startsWith("x-nm-") || lower.startsWith("x-photo-")) {
            headers.set(k, v);
          }
        }
        headers.set("User-Agent", "WB-Fission/2.0");
        try {
          const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
          const upstream = await fetch(target.href, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(35000) });
          if (upstream.status >= 300 && upstream.status < 400) return j({error:"Upstream redirect rejected"},502);
          const resBody = await upstream.arrayBuffer();
          return new Response(resBody, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", "Cache-Control": "private, no-store" } });
        } catch (error) {
          return j({ error: "WB proxy error", reason: error.name + ": " + error.message }, 502);
        }
      }
      if (url.pathname === "/api/source" && request.method === "POST") {
        const { nmId } = await request.json();
        if (!/^[0-9]{6,13}$/.test(String(nmId))) return j({ error: "Invalid nmId" }, 400);
        const errors = [];
        for (const version of ["v4", "v2"]) {
          const sourceUrl = `https://card.wb.ru/cards/${version}/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${nmId}`;
          try {
            const response = await fetch(sourceUrl, {signal: AbortSignal.timeout(12000)});
            if (!response.ok) { errors.push("HTTP " + response.status); continue; }
            const data = await response.json();
            const product = (data.products || data.data?.products || []).find(p => String(p.id) === String(nmId));
            if (product) return j({ product, url:sourceUrl, retrieved_at:Date.now() });
            errors.push("product_not_found");
          } catch { errors.push("source_unavailable"); }
        }
        return j({ product:null, errors });
      }
      if (url.pathname === "/api/tasks" && request.method === "GET") {
        return coordinate(env, "/list" + url.search);
      }
      if (url.pathname === "/api/executor/heartbeat" && request.method === "POST") {
        return coordinate(env, "/heartbeat", await request.json());
      }
      if (url.pathname === "/api/tasks/import" && request.method === "POST") {
        // Preserve legacy records; do not trust the old hardcoded demo's ready status.
        const tasks = [];
        let cursor;
        do {
          const page = await env.WB_FISSION_KV.list({ prefix: "task:", ...(cursor ? { cursor } : {}) });
          for (const key of page.keys) {
            const task = await env.WB_FISSION_KV.get(key.name, "json");
            if (task) tasks.push({ ...task, key: key.name });
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor);
        return coordinate(env, "/import", { tasks });
      }
      const routes = { "/api/tasks/claim": "/claim", "/api/tasks/update": "/update", "/api/tasks/retry": "/retry" };
      if (routes[url.pathname] && request.method === "POST") {
        let payload;
        try { payload = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }
        // State updates do not send messages to other users.
        return coordinate(env, routes[url.pathname], payload);
      }
      return j({ error: "Not found" }, 404);
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    let body;
    try { body = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.encrypt) return j({ error: "Invalid or encrypted event" }, 400);
    if (!env.FEISHU_VERIFICATION_TOKEN) return j({ error: "Verification not configured" }, 503);
    const incomingToken = body.type === "url_verification" ? body.token : body.header?.token;
    if (incomingToken !== env.FEISHU_VERIFICATION_TOKEN) return j({ error: "Forbidden" }, 403);
    if (body.type === "url_verification") {
      return typeof body.challenge === "string" ? j({ challenge: body.challenge }) : j({ error: "Invalid challenge" }, 400);
    }
    if (body.header?.event_type === "im.message.receive_v1") {
      if (body.header.app_id !== (env.FEISHU_APP_ID || DEFAULT_APP_ID)) return j({ error: "Wrong app" }, 403);
      if (!env.FEISHU_APP_SECRET || !env.TASK_COORDINATOR) return j({ error: "Service not configured" }, 503);
      const stored = await coordinate(env, "/events", {id:body.event?.message?.message_id, payload:body});
      if (!stored.ok) return j({error:"Event persistence failed"},503);
      const entry=await stored.json();
      if (entry.event) ctx.waitUntil(processStoredEvent(entry.event,env));
    }
    return j({ code: 0 });
  }
};
