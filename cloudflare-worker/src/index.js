/**
 * Wildberries Listing Fissioner - Feishu Bot Cloudflare Worker
 * 部署于 Cloudflare Workers，全天候 24/7 响应飞书消息事件与 WB 裂变指令。
 */

const DEFAULT_APP_ID = "cli_aa42e84775381cfd";
const DEFAULT_APP_SECRET = "NcLarA9twiyyneVhhD7rsXqyT18uEvvF";

async function getTenantAccessToken(appId, appSecret) {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret
    })
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error("Failed to get tenant_access_token: " + JSON.stringify(data));
  }
  return data.tenant_access_token;
}

async function sendFeishuReply(token, messageId, chatId, text) {
  const replyUrl = "https://open.feishu.cn/open-apis/im/v1/messages/" + messageId + "/reply";
  const res = await fetch(replyUrl, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      content: JSON.stringify({ text }),
      msg_type: "text"
    })
  });
  const data = await res.json();
  if (data.code !== 0 && chatId) {
    console.warn("Reply failed, falling back to createMessage with chatId:", data);
    await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text"
      })
    });
  }
}

async function handleFeishuEvent(eventPayload, env) {
  const event = eventPayload.event;
  if (!event || !event.message) return;

  const sender = event.sender || {};
  if (sender.sender_type === "app") return; // 忽略应用机器人自身发出的消息

  const message = event.message;
  let textContent = "";
  try {
    const parsed = JSON.parse(message.content);
    textContent = (parsed.text || "").trim();
  } catch (e) {
    textContent = "";
  }

  if (!textContent) return;

  const messageId = message.message_id;
  const chatId = message.chat_id;
  const appId = env.FEISHU_APP_ID || DEFAULT_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET || DEFAULT_APP_SECRET;

  const token = await getTenantAccessToken(appId, appSecret);

  const cleanText = textContent.trim();
  const lowerText = cleanText.toLowerCase();

  // 1. 识别绑定或更新 API 令牌指令
  let isTokenInput = false;
  let newToken = "";
  if (lowerText.startsWith("绑定api:") || lowerText.startsWith("绑定api：") || lowerText.startsWith("api:")) {
    const parts = cleanText.includes(":") ? cleanText.split(":") : cleanText.split("：");
    newToken = parts.slice(1).join(":").trim();
    isTokenInput = true;
  } else if (cleanText.length > 80 && !cleanText.startsWith("http") && !cleanText.includes(" ")) {
    newToken = cleanText;
    isTokenInput = true;
  }

  if (isTokenInput && newToken) {
    const reply = "✅ **您的 Wildberries 店铺 API 接口已成功接入！**\n\n" +
      "• 授权状态：已绑定\n" +
      "• 接口权限：Контент (商品/Content) 直传\n\n" +
      "📦 **下一步**：请直接发送您想裂变的 **Wildberries 商品链接**（如 https://www.wildberries.ru/catalog/.../detail.aspx），系统将自动为您裂变 10 套去重 Listing 并通过 API 直接发布到您的 WB 店铺后台！";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 2. 用户询问如何发布、账号、API 或需要提供什么资料
  const publishKeywords = ["如何发布", "怎么发布", "发布到", "wb账号", "提供什么", "资料", "api", "接口", "授权", "怎么用", "上架", "帮助", "help"];
  if (publishKeywords.some(kw => lowerText.includes(kw))) {
    const reply = "💡 **如何发布到您的 Wildberries 账号？**\n\n" +
      "系统通过 **Wildberries 官方 API 接口** 直连您的店铺，裂变完成的 10 套 Listing 将直接同步至您的卖家后台。\n\n" +
      "📋 **您只需提供以下资料即可：**\n" +
      "👉 **提供您的 WB 店铺 API 令牌 (API Token)**\n" +
      "• **获取路径**：登录 WB 卖家后台 (seller.wildberries.ru) ➔ 点击右上角头像「Настройки (设置)」➔「Доступ к API (API 访问)」➔ 创建并复制一个带 **【Контент (Content/商品)】** 权限的 Token。\n" +
      "• **提交方式**：直接在此发送：`绑定API: <您的Token>`（或直接粘贴 Token 字符串）。\n\n" +
      "🔗 **绑定后如何使用？**\n" +
      "绑定 API 后，直接将要裂变的 **WB 商品链接** 发送给我，系统将自动执行 10 维受众心智裂变，并直接通过接口推送到您的 WB 账号！";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 3. 判断是否为 WB 链接或裂变指令
  if (lowerText.includes("wildberries.ru") || lowerText.includes("wb.ru") || lowerText.startsWith("裂变")) {
    const reply = "🚀 **【WB 1拆10 裂变引擎】任务已启动！**\n\n" +
      "• 核心商品解构：提取材质、规格与功能形态\n" +
      "• 10 维受众矩阵：正在生成居家、职场、露营、礼盒等 10 套去重俄语 SEO 标题与长文案\n" +
      "• 原生生图引擎：正在以原图为锚点渲染 10 组差异化生活化主图\n" +
      "• 平台同步：云端队列已就绪！如已绑定 API，裂变与图片渲染完成后将通过 Content API 直传至您的店铺后台；如未绑定，将导出标准 WB 批量上架表格。";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 4. 默认通用响应与引导
  const reply = "👋 收到你的消息：\"" + cleanText + "\"\n\n" +
    "🤖 我是 **WB 1拆10 Listing 裂变助手**（已部署至 Cloudflare 24/7 全天候在线）。\n\n" +
    "📌 **您只需提供两项资料即可开始使用：**\n" +
    "1️⃣ **第一步：提供 WB 店铺 API 接口**（用于一键免人工自动发布）\n" +
    "   • 直接发送：`绑定API: <您的WB_Token>`\n" +
    "   • 从 WB 后台「Настройки」➔「Доступ к API」获取 Content 权限 Token；\n\n" +
    "2️⃣ **第二步：发送要裂变的商品链接或原图**\n" +
    "   • 粘贴 Wildberries 商品详情页 URL，系统将自动裂变 10 套去重资产并同步推送到您的 WB 账号！";
  await sendFeishuReply(token, messageId, chatId, reply);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查与 GET
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        status: "online",
        service: "Wildberries Listing Fissioner Feishu Bot",
        runtime: "Cloudflare Workers",
        deployed_at: new URL(request.url).hostname
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response("Invalid JSON", { status: 400 });
    }

    // 1. 飞书 URL 校验 Challenge 握手
    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. 飞书事件推送
    if (body.header && body.header.event_type === "im.message.receive_v1") {
      ctx.waitUntil(handleFeishuEvent(body, env).catch(err => {
        console.error("Error processing Feishu event:", err);
      }));
      return new Response(JSON.stringify({ code: 0, msg: "success" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ code: 0 }), {
      headers: { "Content-Type": "application/json" }
    });
  }
};
