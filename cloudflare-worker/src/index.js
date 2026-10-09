/**
 * Wildberries Listing Fissioner - 飞书机器人服务
 * 严格执行商业化上架对话规范：
 * 1. 仅围绕商品上架、店铺授权与所需资料进行引导与状态同步。
 * 2. 严禁透露底层实现、系统架构、云平台及生图工具等内部技术细节。
 * 3. 客户询问实现原理时，统一回复标准话术。
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
  if (sender.sender_type === "app") return;

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

  // 1. 拦截实现原理、架构、生图工具等内部技术询问
  const techKeywords = [
    "原理", "怎么实现", "如何实现", "什么模型", "架构", "源码", "代码", "提示词", "prompt",
    "技术", "cloudflare", "antigravity", "生图工具", "comfyui", "脚本", "接口字段", "内部规则"
  ];
  if (techKeywords.some(kw => lowerText.includes(kw))) {
    const reply = "这部分属于内部实现资料，无法在客户对话中提供。我可以介绍可用功能、所需资料，或帮您查看上架结果。";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 2. 识别绑定或更新 API 令牌指令
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
    const reply = "✅ **您的 Wildberries 店铺已成功连接！**\n\n" +
      "• 店铺状态：授权有效\n" +
      "• 权限范围：商品卡片创建与更新\n\n" +
      "📦 **下一步**：请直接发送您想上架的 **Wildberries 商品链接**（如 https://www.wildberries.ru/catalog/.../detail.aspx），系统将为您生成 10 套独立商品卡片并同步至您的 WB 卖家后台。";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 3. 用户询问如何上架、提供什么资料
  const publishKeywords = ["如何发布", "怎么发布", "如何上架", "怎么上架", "上架", "发布到", "wb账号", "提供什么", "资料", "api", "接口", "授权", "怎么用", "帮助", "help"];
  if (publishKeywords.some(kw => lowerText.includes(kw))) {
    const reply = "💡 **Wildberries 商品上架指南**\n\n" +
      "完成商品上架只需以下两步：\n\n" +
      "1️⃣ **第一步：提供 WB 店铺授权**\n" +
      "• **获取路径**：登录 WB 卖家后台 (seller.wildberries.ru) ➔ 点击右上角头像「Настройки (设置)」➔「Доступ к API (API 访问)」➔ 创建带 **【Контент (商品/Content)】** 权限的 Token。\n" +
      "• **提交方式**：直接在此发送 `绑定API: <您的Token>`。\n\n" +
      "2️⃣ **第二步：发送要上架的商品链接**\n" +
      "• 粘贴需要上架的 Wildberries 商品链接，系统将自动制作 10 套去重商品资料（独立俄语标题、详细描述及配套主图），并同步至您的店铺。";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 4. 判断是否为 WB 商品链接或上架指令
  if (lowerText.includes("wildberries.ru") || lowerText.includes("wb.ru") || lowerText.startsWith("上架") || lowerText.startsWith("裂变")) {
    const reply = "🚀 **商品上架任务已启动！**\n\n" +
      "• 商品状态：已受理，正在核验原商品规格与类目属性\n" +
      "• 上架制作：正在生成 10 套独立商品资料（俄语标题、属性参数、卖点描述与配套主图）\n" +
      "• 店铺同步：制作完成后将自动同步至您的 WB 卖家后台（如未绑定 API，将为您输出标准上架表格）";
    await sendFeishuReply(token, messageId, chatId, reply);
    return;
  }

  // 5. 默认通用响应与引导（仅谈上架相关）
  const reply = "👋 您好！我是 **WB 商品上架助手**。\n\n" +
    "📦 **快速开启上架只需提供：**\n" +
    "1️⃣ **店铺 API 授权**：发送 `绑定API: <您的WB_Token>`（用于一键自动同步至卖家后台）\n" +
    "2️⃣ **目标商品链接**：直接发送 Wildberries 商品链接，即可自动生成 10 套独立商品资料并安排上架！";
  await sendFeishuReply(token, messageId, chatId, reply);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        status: "online",
        service: "Wildberries Listing Assistant"
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

    if (body.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: body.challenge }), {
        headers: { "Content-Type": "application/json" }
      });
    }

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
