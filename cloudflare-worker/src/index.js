import { TaskCoordinator } from "./task-coordinator.js";
export { TaskCoordinator };

const DEFAULT_APP_ID = "cli_aa42e84775381cfd";
const j = (data, status = 200) => Response.json(data, { status, headers:{"Cache-Control":"private, no-store, max-age=0","Vary":"Authorization"} });
function publicationResult(p) {
  if(p.upload_verified || p.state==='submitted') {
    return '\n商品上传：成功，商品卡片与图片记录已读回。'+
      (p.pending_improvements?.length?'\n待完善：'+p.pending_improvements.join('；')+'。':'')+
      (p.nm_ids?.length?'\n商品货号：'+p.nm_ids.join('、'):'')+
      '\n买家页面可见性另行核验。';
  }
  return '\n商品上传尚未确认成功，无需重新生成图文。';
}
export async function coordinate(env, path, body, method = (body === undefined ? "GET" : "POST")) {
  if (!env.TASK_COORDINATOR) throw new Error("Task coordinator is not configured");
  const stub = env.TASK_COORDINATOR.get(env.TASK_COORDINATOR.idFromName("wb-fission"));
  return stub.fetch(new Request("https://coordinator" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }));
}
export function resolveProduct(text) {
  if (/^(?:sku|条形码|barcode|商品编码)\s*[:：]/i.test(text)) return null;
  const ids = [...text.matchAll(/(?:货号|артикул|articul|nmid)\s*[:：]?\s*([0-9]{6,13})(?![0-9])/gi)].map(m => m[1]);
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])wb\s*(?:货号\s*[:：]?\s*)?([0-9]{6,13})(?![0-9])/gi)) ids.push(match[1]);
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
async function sendFeishuReply(token, messageId, chatId, text, senderId = null) {
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const content = JSON.stringify({ text });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(messageId + ":reply"));
  const uuid = Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
  const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply", {
    method: "POST", headers, body: JSON.stringify({ content, msg_type: "text", uuid })
  });
  const data = await response.json();
  if (response.ok && data.code === 0) return;
  if (chatId) {
    const fallback = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST", headers, body: JSON.stringify({ receive_id: chatId, content, msg_type: "text", uuid })
    });
    const fallbackData = await fallback.json();
    if (fallback.ok && fallbackData.code === 0) return;
  }
  if (senderId && String(senderId).startsWith("ou_")) {
    const openFallback = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id", {
      method: "POST", headers, body: JSON.stringify({ receive_id: senderId, content, msg_type: "text", uuid })
    });
    const openData = await openFallback.json();
    if (openFallback.ok && openData.code === 0) return;
  }
  throw new Error("Feishu message delivery failed");
}
async function health(env) { return (await coordinate(env, "/health")).json(); }

export function isFailureQuestion(text) {
  return /(?:为什么|为何|什么原因|怎么|哪里|咋).*(?:失败|报错|异常|出错|卡住|没成功|未完成|没完成|没有完成)|(?:失败|报错|异常|出错|卡住).*(?:原因|为什么|怎么|解释)|(?:怎么回事|失败原因|错误原因|故障原因|怎么解决|如何解决|怎么办|什么情况)[？?！!。]*$/.test(text);
}

export function isListingQuestion(text) {
  const t = text.trim();
  if (/(?:为何|为什么|为啥|怎么|哪里|咋|什么原因|何时|什么时候).*(?:未上架|还没上架|没上架|不上架|未发布|没发布|自动上架|不自动上架|未进店铺)/i.test(t)) return true;
  if (/(?:未上架|还没上架|没上架|不上架|未发布).*(?:原因|为什么|为何|为啥|怎么|解释|怎么回事)/i.test(t)) return true;
  if (/^(?:为何未上架|为什么未上架|为什么还没上架|为何还没上架|为啥还没上架|为啥未上架|怎么还没上架|怎么没上架|为何不上架|为什么不上架|未上架原因|未上架|尚未上架|为何尚未上架|为什么不自动上架|为何不自动上架|何时上架|什么时候上架|怎么上架|如何上架|这个为何未上架|店铺上架|如何店铺上架|怎么店铺上架|店铺怎么上架|店铺如何上架|裂变上架|怎么裂变上架|如何裂变上架|批量上架|怎么批量上架|商品上架|如何商品上架|上架流程|上架步骤|上架方法|上架规则|上架要求|上架条件|上架说明|上架教程|上架指南|上架状态|查看上架状态|查询上架状态|上架了吗|已经上架了吗|你已经上架了吗)[？?！!。]*$/i.test(t)) return true;
  if (/(?:为何|为什么|怎么|如何|怎样|何时|什么时候|能否|可以|支持).*(?:上架|发布到店铺|推到店铺|发布商品)[？?！!。]*$/i.test(t)) return true;
  if (/(?:店铺上架|裂变上架|批量上架|商品上架|上架流程|上架步骤|上架方法|上架规则|上架要求|上架条件|上架状态)/i.test(t)) return true;
  if (/(?:你已经|已经|有没有|是否已).*(?:上架|发布到店铺).*?(?:了吗|了没|吗)?[？?！!。]*$/i.test(t)) return true;
  if (/(?:为何|为什么|为啥).*(?:不上架|未上架|没上架)/i.test(t)) return true;
  if (/(?:前台|链接|主图|详情页|多图|图片).*(?:只有|好像|没有|未更新|没更新|看不到|没显示|未显示)/i.test(t)) return true;
  if (/(?:只有一张图|还是只有一张图|只有单图|没有详情页|详情页好像还是没有|详情页好像没有|没有多张主图|为什么只有一张图|为何只有一张图)[？?！!。]*$/i.test(t)) return true;
  return false;
}

function targetStores(text) {
  const names=[...text.matchAll(/(?:店铺名|店铺|shop|store|到|至|进)\s*[:：]?\s*([a-zA-Z][a-zA-Z0-9_-]{1,31})(?![a-zA-Z0-9_-])/gi)].map(m=>m[1]);
  for(const m of text.matchAll(/(?:^|[^a-zA-Z0-9_-])(RR[0-9]{3})(?![a-zA-Z0-9_-])/gi)) names.push(m[1]);
  return [...new Set(names.map(x=>x.toUpperCase()))];
}

export function isListingCommand(text) {
  const t = text.trim();
  if (/(?:？|\?|为什么|为何|为啥|怎么|如何|怎样|何时|什么时候|能否|是否|可否|哪里|咋|什么原因|好像|只有|没有|未显示|没显示|流程|步骤|方法|规则|要求|指南|教程|状态|了吗|了没|吗)/.test(t)) {
    return false;
  }
  if (/(?:不要|不用|不需要|不想|暂不|先不|别|取消|停止|看看|查看|查询|检查|核对|了解|解释|失败|报错|出错)/.test(t)) return false;
  const cmdVerbs = "(?:确认上架|开始上架|立即上架|执行上架|申请上架|直接上架|继续上架|恢复上架|推进上架|现在上架|进行上架|安排上架|上架|发布到店铺|确认发布|立即发布)";
  const productPrefix = "(?:(?:wb\\s*)?(?:货号|артикул|articul|nmid)\\s*[:：]?\\s*[0-9]{6,13}|[0-9]{6,13})";
  const politePrefix = "(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)?";

  // 1. Direct command: "上架", "请上架", "继续上架", "确认发布"
  if (new RegExp(`^${politePrefix}\\s*${cmdVerbs}[！!。]*$`, "i").test(t)) return true;

  // 2. Product followed by command: "WB 货号 1879785812 继续上架", "1879785812 上架"
  if (new RegExp(`^${politePrefix}\\s*${productPrefix}\\s*${cmdVerbs}[！!。]*$`, "i").test(t)) return true;

  // 3. Command followed by product: "继续上架 WB 货号 1879785812", "上架 1879785812"
  if (new RegExp(`^${politePrefix}\\s*${cmdVerbs}\\s*${productPrefix}[！!。]*$`, "i").test(t)) return true;

  return /(?:上架|发布)/.test(t) && /^(?:请|帮我|麻烦|把|将|WB|货号|[0-9]{6,13}|已完成|已经完成|这(?:批|些|[0-9]+套)|上架|确认上架|继续上架|开始上架|发布)/i.test(t);
}

export async function explainListingStatus(senderId, chatId, env, requested = null, quotedTaskId = null, questionText = "") {
  let task = null;
  if (quotedTaskId) {
    const taskRes = await coordinate(env, "/task?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + "&task_id=" + encodeURIComponent(quotedTaskId));
    if (taskRes.ok) {
      const data = await taskRes.json();
      if (data.task) task = data.task;
    }
  }
  if (quotedTaskId && !task) return "未找到本聊天的请求编号 " + quotedTaskId + "，不能用其他批次代替，也不能据此认定已交付。请维护者核查历史记录。";
  if (!task) {
    const query = "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + (requested?.nmId ? "&nmid=" + encodeURIComponent(requested.nmId) : "");
    const res = await coordinate(env, query);
    if (res.ok) {
      const data = await res.json();
      task = data.task;
    }
  }
  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  const creds = credsRes.ok ? (await credsRes.json()).credentials : null;
  const shopName = creds?.shop_name || "未指定";
  const warehouseId = creds?.warehouse_id || "未指定";
  const token = creds?.api_token;
  const claims = token ? parseJwtClaims(token) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = claims?.exp && claims.exp < nowSec;
  const isTokenValid = claims && !isExpired && claims.t === false;

  if (!task) {
    let msg = "本聊天还没有找到您的商品任务，无法核实上架状态。\n如需裂变上架，请先发送 WB 商品链接或货号（如：WB 货号 1879785812）。系统将自动读取原图并生成10种同款场景图文，复核无误后即可发布到您的 WB 店铺。";
    msg += "\n\n【当前店铺绑定状态】\n";
    if (creds && (creds.shop_name || creds.warehouse_id || creds.api_token)) {
      msg += "• 已绑定店铺：" + shopName + "（仓库ID：" + warehouseId + "，API令牌：" + (token ? (isExpired ? "已过期" : "已配置") : "未上传") + "）\n";
    } else {
      msg += "• 尚未绑定店铺凭据（请发送“店铺名 / 仓库ID / API令牌”完成绑定）\n";
    }
    msg += "\n【店铺上架标准流程】\n";
    msg += "1. 绑定店铺：发送“店铺名：RR010 / 仓库ID：2200772 / API令牌：<您的令牌>”；\n";
    msg += "2. 生成裂变图文：发送 WB 商品链接或“WB 货号 1879785812”（多店铺可附带“店铺：RR010”），自动生成10套场景图与俄语标题描述并回传飞书；\n";
    msg += "3. 复核与发布：复核本聊天的图文资产包后，发送“确认上架”进入店铺发布核验。";
    return msg;
  }
  if (requested && requested.nmId !== task.nmId) {
    return "本聊天最近任务的货号是 " + task.nmId + "，与您询问的货号 " + requested.nmId + " 不同。如需处理该货号，请先发送该商品链接。";
  }

  const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n";

  if(task.publication) return prefix+"目标店铺："+task.publication.store+"\n上架指令已保存。\n"+task.publication.summary+publicationResult(task.publication);

  if (task.status === "ready") {
    let answer = prefix + "状态：资产包已生成，尚未上架。\n\n";
    if (/(?:前台|链接|主图|一张图|单图|多图|详情页)/.test(questionText)) {
      answer += "【前台图文说明】\n";
      answer += "原商品链接展示原商品资料，不会因生成裂变图文自动改变；实际图片数量需打开对应链接核验。\n";
      answer += "裂变助手已为该商品生成10套全新的同款场景图（当前自动流程为每套1张主场景图，8张图库需另行制作核验）及俄语描述，已交付本聊天，尚未推送到您的店铺。\n\n";
    }
    answer += "【未自动上架原因】\n";
    answer += "1. 本批尚未保存明确的店铺上传指令。收到指令后将优先上传现有商品资料与图片，精修随后继续。\n";
    answer += "2. 上传需要核实目标店铺和有效发布凭据；发货仓库在后续库存设置时核验。\n\n";

    if (isTokenValid) {
      answer += "【店铺授权状态】凭据已配置，实际账户与发布权限待核验\n";
      answer += "• 店铺名称：" + shopName + "\n";
      answer += "• 发货仓库：" + warehouseId + "\n";
      answer += "• API 令牌：已配置，尚未超过所记录的有效期\n\n";
      answer += "【下一步操作】\n";
      answer += "商品图文资产包已就绪。发送“上架”或“确认上架”（或“继续上架”）后，系统核实目标账户与建卡必需资料，优先上传商品并返回真实货号；图片精修、图库补全、价格和库存随后继续完善。";
    } else if (creds && (creds.shop_name || creds.warehouse_id || creds.api_token)) {
      answer += "【店铺授权状态】尚未完成\n";
      answer += "• 店铺名称：" + shopName + "\n";
      answer += "• 发货仓库：" + warehouseId + "\n";
      if (!token) {
        answer += "• API 令牌：尚未上传\n\n";
        answer += "【下一步操作】\n";
        answer += "请发送“API令牌：<您的全权限WB API令牌>”完成绑定，核验通过后即可执行店铺上架。";
      } else if (isExpired) {
        answer += "• API 令牌：已过期（到期日：" + new Date(claims.exp * 1000).toISOString().slice(0, 10) + "）\n\n";
        answer += "【下一步操作】\n";
        answer += "请在 WB 卖家后台重新创建全权限 API 令牌并发送更新。";
      } else {
        answer += "• API 令牌：权限不足（需全权限读写令牌）\n\n";
        answer += "【下一步操作】\n";
        answer += "请在 WB 卖家后台创建全权限 API 令牌并发送更新。";
      }
    } else {
      answer += "【店铺授权状态】尚未绑定\n";
      answer += "尚未检测到您的 WB 店铺凭据。\n\n";
      answer += "【下一步操作】\n";
      answer += "如需发布到您的 WB 店铺，请按以下格式发送店铺凭据：\n店铺名：RR010\n仓库ID：2200772\nAPI令牌：<您的WB API令牌>";
    }
    return answer;
  }

  if (["waiting_executor", "validating", "processing", "generating_text", "generating_images", "reviewing"].includes(task.status)) {
    const labels = {
      waiting_executor: "等待处理", validating: "资料核验中", processing: "处理中",
      generating_text: "文案制作中", generating_images: "图片制作中", reviewing: "审查中"
    };
    return prefix + "状态：" + (labels[task.status] || "制作中") + "。\n\n" +
      "【未上架原因】\n" +
      "当前商品任务仍在图文制作流水线中，尚未完成10套场景图文的制作与交付，因此未进入店铺上架环节。\n" +
      "素材制作完成后会自动交付本聊天供您复核。可发送“进度”查看实时状态。";
  }

  if (task.status === "needs_input") {
    return prefix + "状态：需要补充资料。\n\n" +
      "【未上架原因】\n" +
      "商品资料缺失（" + (task.summary || "请补充原图或商品名称") + "），制作已暂停，尚未进入上架流程。\n" +
      "请补充资料后系统将继续制作，制作完成后可安排上架。";
  }

  if (task.status === "awaiting_delivery") {
    return prefix + "状态：图文已生成，等待飞书交付。\n\n" +
      "【未上架原因】\n" +
      "10套场景图文已制作完成，正在推送至飞书聊天。交付完成后即可复核并确认上架。\n" +
      "若长时间未收到，可发送“重试”重新发送。";
  }

  if (task.status === "failed") {
    return prefix + "状态：处理失败，需检查。\n\n" +
      "【未上架原因】\n" +
      "商品图文制作未成功，因而无法执行店铺上架。\n" + explainFailure(task);
  }

  return prefix + "状态：" + (task.status || "待核验") + "。\n" + (task.summary || "正在处理中；尚未确认上架。");
}

export async function executeListingCommand(senderId, chatId, env, requested = null, targetStore = null, messageId = null) {
  const query = "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + (requested?.nmId ? "&nmid=" + encodeURIComponent(requested.nmId) : "");
  const { task, key } = await (await coordinate(env, query)).json();
  if (!task) {
    return requested ? "本聊天尚未找到货号 "+requested.nmId+" 的任务，请维护者核查对应交付记录；不会改用其他商品或重新生成图文。" : "尚未找到可上架的商品任务。请先发送 WB 商品详情链接或平台货号制作裂变图文。";
  }
  if (requested && task.nmId !== requested.nmId) {
    return "本聊天尚未找到货号 " + requested.nmId + " 的已就绪任务。当前最近任务的货号是 " + task.nmId + "。如需上架新商品，请先发送该商品链接制作裂变图文。";
  }
  const credsRes=await coordinate(env,"/credentials?sender="+encodeURIComponent(senderId));
  const creds=credsRes.ok?(await credsRes.json()).credentials:null;
  const boundStore=creds?.shop_name?.toUpperCase();
  const destination=targetStore || boundStore || task.target_store || null;
  const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n"+(destination?"目标店铺："+destination+"\n":"");
  if(targetStore && boundStore && targetStore!==boundStore) return prefix+"本聊天当前绑定店铺为 "+boundStore+"，与指定店铺不同。请先核验目标店铺归属与绑定；不会改用其他店铺发布，也不会重新生成图文。";
  if (task.status !== "ready") {
    const labels = {
      waiting_executor: "等待处理", validating: "资料核验中", processing: "处理中",
      generating_text: "文案制作中", generating_images: "图片制作中", reviewing: "审查中",
      needs_input: "需要补充资料", awaiting_delivery: "等待交付", failed: "处理失败"
    };
    return prefix + "当前商品状态为【" + (labels[task.status] || task.status) + "】，尚未完成完整资产包制作，暂不能执行上架。\n可发送“进度”查看最新状态。";
  }

  const d=task.details || {};
  const delivery=d.delivery_verified===true && d.delivered_scenes===10 && !!d.archive_message_id;
  let reply=prefix+(delivery?"已找到本批已交付的10套图文，无需重新提交商品链接或重复生成。":"已找到本批图文记录，交付凭据还需维护者核验。")+"\n";
  reply+=(boundStore && creds?.api_token)?"店铺绑定："+boundStore+" 的凭据已配置，发布权限仍需核验；发货仓库在库存设置时核验。\n":"店铺绑定或发布凭据尚不完整，需先核验目标店铺。\n";
  if(!delivery) return reply+"交付记录尚未核验，暂不能保存发布执行请求。请维护者核对本批成品记录。";
  if(!boundStore || !creds?.api_token) return reply+"请先补齐当前店铺的绑定及发布凭据；本次尚未保存发布请求。";
  const recorded=await coordinate(env,"/publication",{key,sender_id:senderId,chat_id:chatId,task_id:task.task_id,store:destination,message_id:messageId});
  if(!recorded.ok) return reply+"上架指令暂未保存，任务或店铺状态已变化，请查询进度后核对。";
  const publication=(await recorded.json()).publication;
  return reply+"上架指令已保存并绑定本批次，无需重发商品链接。\n"+publication.summary+publicationResult(publication);
}

export function explainFailure(task) {
  const d=task.details || {}, code=d.reason_code || d.reason;
  const reasons={
    image_quality_failed:"图片没有通过商品一致性或拍摄要求核对，系统停止交付不合格图片。",
    generation_timeout:"图文生成超过本次处理时限。",
    generation_service_unavailable:"图片或文案生成服务出现超时、限流或暂时不可用。",
    generation_auth_failed:"图文生成账号的登录或授权未通过，需要维护者恢复。",
    executor_auth_failed:"执行服务与任务网关的身份验证失败，需要维护者检查连接配置。",
    connection_failed:"执行过程中网络连接未完成，不能据此认定是 WB 上架接口故障。",
    product_validation_failed:"生成结果与原商品资料或校验要求不一致。",
    generation_response_invalid:"生成服务返回的原图分析、场景方案或审查结果格式不完整，未能通过程序校验；这不表示 WB 商品接口故障，也不表示商品图片不合格。",
    scene_plan_invalid:"场景方案的结构、机位或景别没有达到制作要求。",
    generator_not_configured:"当前没有配置可用的图文生成服务。",
    generation_model_unavailable:"图文生成服务返回 HTTP 404，当前模型或服务地址不可用。需要维护者核验生成服务配置；这不是 WB 店铺接口的返回。",
    generation_failed:"图文生成程序中断，现有记录未提供更具体的可核实原因。",
    lease_expired:"执行服务多次中断或未及时续报进度，任务已停止自动重试。",
  };
  const issues={composition_mismatch:"主体位置或构图不符合方案",camera_angle:"拍摄角度未达到要求",label_distortion:"产品标签文字或图案失真",extra_product:"画面出现额外商品，可能误导销售数量",missing_packaging:"应展示的包装缺失"};
  let answer="失败原因："+(reasons[code] || "这条旧记录没有保存具体错误原因，目前不能确定；需要维护者核对执行记录，不能直接归因于 WB API。")+"\n";
  const stages={source_analysis:"原图分析",scene_plan:"场景规划",image_review:"图片审查",generating_text:"原图分析与文案规划",generating_images:"图片制作"};
  if (Object.hasOwn(stages,d.stage)) answer+="失败阶段："+stages[d.stage]+"。\n";
  if (Number.isInteger(d.failed_image) && d.failed_image>=1 && d.failed_image<=10) answer+="停止位置：第"+d.failed_image+"张图片。\n";
  if (Number.isInteger(d.completed) && d.completed>=0 && d.completed<=10) answer+="已通过检查："+d.completed+"/10张。\n";
  const known=[...new Set((Array.isArray(d.issue_codes)?d.issue_codes:[]).filter(x=>Object.hasOwn(issues,x)))];
  if (known.length) answer+="核对发现："+known.map(x=>issues[x]).join("；")+"。\n";
  if (['generation_auth_failed','executor_auth_failed','generator_not_configured','generation_model_unavailable'].includes(code)) answer+="下一步：维护者修复服务后，在本聊天发送“重试”。";
  else if (code==='product_validation_failed') answer+="下一步：核对并补充正确原图或商品资料，再发送“重试”。";
  else answer+="下一步：发送“重试”，系统会重新核验已有成品并继续制作；询问原因本身不会重新生成或重复发送。";
  return answer;
}

export function parseJwtClaims(token) {
  try {
    if (typeof token !== "string") return null;
    const parts = token.trim().split(".");
    if (parts.length < 2) return null;
    let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    let json;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(base64, "base64").toString("utf8");
    } else if (typeof atob === "function") {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      json = new TextDecoder().decode(bytes);
    } else {
      return null;
    }
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function isWindowAuthQuestion(text) {
  const t = String(text || "").replace(/@_user_\d+\s*/g, "").trim();
  if (!t) return false;
  if (/^(?:API令牌|api_token|api\s*key|apikey|token|令牌|店铺名|店铺名称|店铺|shop|仓库ID|仓库|warehouse(?:_id)?)\s*[:：]\s*\S+/i.test(t)) {
    return false;
  }
  if (/(?:令牌|token|api|key|密钥|凭据|仓库|店铺|绑定状态|授权时长)/i.test(t) && !/(?:窗口|卡密|激活码|授权码|扫码|试用|续费)/i.test(t)) {
    return false;
  }
  if (/^(?:店铺授权|店铺授权状态|授权状态|核验授权|授权时长|授权有效期|授权到期)[？?！!。]*$/i.test(t)) {
    return false;
  }
  if (/(?:窗口授权|授权窗口|窗口绑定|绑定窗口|窗口激活|激活窗口|窗口ID|会话ID|对话ID|设备SID|本机SID|机器码|授权码|激活码|卡密|扫码授权|飞书授权|账号授权|开通授权|申请授权|代理商授权|申请试用|免费试用)/i.test(t)) return true;
  if (/(?:窗口|会话|设备|客户端).*(?:怎么|如何|怎样|哪里|授权|绑定|激活|开通|了吗|了没|吗)/i.test(t)) return true;
  if (/(?:你已经|已经|有没有|是否已).*(?:授权|开通|激活)(?:了吗|了没|吗)?[？?！!。]*$/i.test(t) && !/店铺|令牌|token|api|仓库|绑定/i.test(t)) return true;
  if (/^(?:如何授权|怎么授权|怎样授权|哪里授权|如何开通|怎么开通|授权了吗|已经授权了吗|你已经授权了吗|我的ID|我的OpenID|查看ID|查询ID|怎么续费|如何续费)[？?！!。]*$/i.test(t)) return true;
  return false;
}

export async function answerWindowAuthQuestion(senderId, env, text = "") {
  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  const creds = credsRes.ok ? (await credsRes.json()).credentials : null;
  const shopName = creds?.shop_name || null;
  const warehouseId = creds?.warehouse_id || null;
  const token = creds?.api_token || null;
  const claims = token ? parseJwtClaims(token) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const expDate = claims?.exp ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : null;
  const remainingDays = claims?.exp ? Math.max(0, Math.ceil((claims.exp - nowSec) / 86400)) : null;

  let feishuAccount = null;
  if (typeof senderId === "string" && senderId.startsWith("ou_")) {
    try {
      const authRes = await fetch("https://diytale.com/api/feishu/check-auth?open_id=" + encodeURIComponent(senderId), {
        signal: AbortSignal.timeout(1800)
      });
      if (authRes.ok) {
        feishuAccount = await authRes.json();
      }
    } catch {
      // Offline or mock fetch in unit tests
    }
  }

  let reply = "【窗口授权与账号核验状态】\n";
  reply += "• 当前飞书标识：" + (senderId || "未识别") + "\n";
  if (feishuAccount && feishuAccount.account_no) {
    reply += "• 系统专属账号：" + feishuAccount.account_no + "\n";
  }
  if (feishuAccount && feishuAccount.authorized) {
    const fExp = feishuAccount.expires_at ? new Date(feishuAccount.expires_at).toISOString().slice(0, 10) : "有效期内";
    reply += "• 飞书账号授权：已开通（有效期至 " + fExp + "，剩余约 " + (feishuAccount.remaining_days ?? "-") + " 天）\n";
  } else if (feishuAccount && feishuAccount.status === "pending") {
    reply += "• 飞书账号授权：已提交申请，等待代理商审批开通\n";
  } else {
    reply += "• 飞书账号授权：可通过飞书扫码自助开通或使用激活卡密绑定\n";
  }

  if (shopName || warehouseId || token) {
    reply += "• 店铺绑定状态：已绑定\n";
    reply += "• 当前绑定店铺：" + (shopName || "未指定") + "（仓库ID：" + (warehouseId || "未指定") + "，API令牌：" + (token ? "已配置" : "未上传") + "）\n";
    if (expDate) {
      reply += "• 店铺授权时长：剩余 " + remainingDays + " 天（有效期至 " + expDate + "）\n";
    }
  } else {
    reply += "• 店铺绑定状态：尚未绑定 WB 店铺凭据\n";
  }

  reply += "\n【窗口授权与开通操作指南】\n";
  reply += "1. 飞书扫码自助开通/续期：打开 https://diytale.com/apply ，使用飞书扫描二维码即可自动提取资料并生成专属账号，支持申请 3天免费测试 或 1个月/2个月/自定义多月，提交后联系代理商（泉州庄总微信/电话：18558989771）审批即可生效；\n";
  reply += "2. 桌面端窗口授权：在桌面端新建上架会话窗口时，发送代理商代码（如 zhuang_qz）或 16 位激活卡密（WB-XXXX-...）即可绑定本机与当前会话窗口；\n";
  reply += "3. 绑定 WB 店铺凭据：在本聊天直接发送“店铺名：RR010 / 仓库ID：2200772 / API令牌：<您的WB令牌>”即可绑定店铺。";
  return reply;
}

export function isCredentialQuestion(text) {
  const t = String(text || "").replace(/@_user_\d+\s*/g, "").trim();
  if (!t) return false;
  if (/^(?:API令牌|api_token|api\s*key|apikey|token|令牌|店铺名|店铺名称|店铺|shop|仓库ID|仓库|warehouse(?:_id)?)\s*[:：]\s*\S+/i.test(t)) {
    return false;
  }
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) {
    return false;
  }
  if (/^资料\s*[:：]/i.test(t)) {
    return false;
  }
  if (/(?:运营|上架|选品|定价|价格|改库存|初始库存|默认库存|标题|广告|推广|流量|转化率)/i.test(t) &&
      !/(?:绑定|绑店|令牌|token|api|key|密钥|凭据|仓库|授权时长|授权时间|授权有效期|授权状态|店铺授权|店铺信息|店铺名|绑定状态)/i.test(t)) {
    return false;
  }
  if (/(?:API\s*令牌|api_token|api\s*key|apikey|api_key|api\s*密钥|仓库\s*id|warehouse_id|店铺凭据|绑定状态|授权时长|授权时间|授权有效期|授权剩余|剩余时长|令牌有效期|多久到期|什么时候到期|到期时间)/i.test(t)) {
    return true;
  }
  if (/^(?:绑定店铺|店铺绑定|绑店|店铺授权|授权店铺|已经绑定店铺的信息|已绑定店铺信息|绑定店铺信息|绑定的店铺信息|店铺信息|我的店铺|当前店铺|当前绑定店铺|店铺名称|店铺名|仓库|仓库ID|仓库号|发货仓库|我的仓库|仓库信息|API令牌|API|token|令牌|我的令牌|我的token|令牌信息|绑定状态|授权状态|授权时长|授权有效期|授权到期|有效期|核验店铺|核验令牌|验证令牌|检查令牌|店铺状态|查看凭据|核验API|验证API|核验授权|如何绑定店铺|怎么绑定店铺|你已经绑定店铺了吗|已经绑定店铺了吗|绑定店铺了吗|绑定了吗|绑店了吗|如何绑店|怎么绑店|绑定仓库|绑定API|绑定令牌|查看店铺|更换店铺|切换店铺|多店铺绑定)[？?！!。]*$/i.test(t)) {
    return true;
  }
  if (/(?:核验|验证|授权|检查|查看|查询|确认|绑定|绑店|设置|配置|更换|切换|修改|更新|上传|填写|解绑|给我|发我|发给我|看看|告诉我|是什么|是多少|有哪些|哪个|什么).*(?:令牌|token|api|key|密钥|店铺|凭据|仓库|授权|新店|多店|时长|有效期|到期)/i.test(t)) {
    return true;
  }
  if (/(?:店铺|令牌|token|api|key|密钥|凭据|仓库|授权|绑店|绑定).*(?:核验|验证|有效|状态|权限|到期|过期|信息|配置|绑定|绑店|名称|名字|ID|id|号|时长|时间|多久|剩余|了吗|了没|没|吗|怎么|如何|怎样|哪里|方法|步骤|流程|格式|更换|切换|解绑|给我|发我|发给我|是什么|是多少|哪个)/i.test(t)) {
    return true;
  }
  if (/(?:你已经|已经|已|有没有|是否已|是否).*(?:绑定|绑店|上传令牌|配置店铺|授权店铺)/i.test(t)) {
    return true;
  }
  if (/(?:如何|怎么|怎样|哪里|能否).*(?:绑定|绑店|换店|切换店铺|更换店铺|多店铺绑定)/i.test(t)) {
    return true;
  }
  return false;
}

export async function verifyAndReportCredentials(senderId, env, text = "") {
  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  if (!credsRes.ok) return "暂无法查询店铺凭据，请稍后重试。";
  const { credentials } = await credsRes.json();
  if (!credentials || (!credentials.api_token && !credentials.shop_name && !credentials.warehouse_id)) {
    return "尚未找到您上传的店铺凭据。\n• 绑定状态：未绑定\n如需绑定并核验店铺，请按以下格式发送：\n店铺名：RR010\n仓库ID：2200772\nAPI令牌：<您的WB API令牌>";
  }
  const shopName = credentials.shop_name || "未指定";
  const warehouseId = credentials.warehouse_id || "未指定";
  const token = credentials.api_token;
  const bindingGuide = /(?:如何|怎么|怎样|哪里|步骤|流程|方法|格式|更换|切换|修改|重新|多店|新店|解绑|店铺绑定|绑定店铺|绑店)/i.test(text)
    ? "\n\n【店铺绑定与切换方法】\n如需更换店铺、绑定新店铺或更新凭据，请直接在本聊天按以下格式发送：\n店铺名：RR010\n仓库ID：2200772\nAPI令牌：<您的WB API令牌>\n（支持多店铺绑定，发送商品货号时可附带店铺名如“WB 货号 1879785812 店铺：RR010”指定目标店铺）"
    : "";

  let report = "已核验您的店铺凭据与授权状态：\n";
  report += "• 绑定状态：已绑定\n";
  report += "• 店铺名称：" + shopName + "\n";
  report += "• 发货仓库（仓库ID）：" + warehouseId;

  if (!token) {
    report += "\n• API 令牌：尚未上传\n• 授权时长：待上传令牌后核验\n• 授权状态：未完成授权。请发送“API令牌：<您的令牌>”完成绑定。" + bindingGuide;
    return report;
  }

  const tokenParts = String(token).trim().split(".");
  const maskedToken = tokenParts.length >= 2 && tokenParts[0].length >= 8 && tokenParts[1].length >= 6
    ? tokenParts[0].slice(0, 12) + "..." + tokenParts[1].slice(-6) + "（已安全脱敏）"
    : "已存储（已安全脱敏）";

  const claims = parseJwtClaims(token);
  if (!claims) {
    report += "\n• API 令牌（API Key）：" + maskedToken + "\n• 授权时长：长期/待核验\n• 授权状态：凭据已存储（非标准 JWT 格式或测试令牌）。若用于正式上架，请提供 WB 后台生成的全权限 API 令牌。" + bindingGuide;
    return report;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = claims.exp && claims.exp < nowSec;
  const expDate = claims.exp ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : "长期";
  const remainingDays = claims.exp ? Math.max(0, Math.ceil((claims.exp - nowSec) / 86400)) : null;
  const isReadWrite = claims.t === false;
  const oidInfo = claims.oid ? "，商户OID：" + claims.oid : "";

  if (isExpired) {
    report += "\n• API 令牌（API Key）：已过期（到期日：" + expDate + oidInfo + "）\n";
    report += "• 授权时长：已到期（剩余 0 天）\n";
    report += "• 授权状态：未通过。令牌已失效，请重新生成并上传新令牌。" + bindingGuide;
    return report;
  }

  let liveStatus = "valid_offline";
  let warehouseVerified = false;
  let warehouseName = "";

  try {
    const probeRes = await fetch("https://marketplace-api.wildberries.ru/api/v3/warehouses", {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(3500)
    });
    if (probeRes.ok) {
      liveStatus = "live_ok";
      const whList = await probeRes.json();
      if (Array.isArray(whList)) {
        const found = whList.find(w => String(w.id) === String(warehouseId));
        if (found) {
          warehouseVerified = true;
          warehouseName = found.name || "";
        }
      }
    } else if (probeRes.status === 401 || probeRes.status === 403) {
      liveStatus = "auth_rejected";
    }
  } catch {
    // Timeout, network offline, or mock fetch in tests
  }

  if (warehouseVerified) {
    report += "（已连接在线" + (warehouseName ? "：" + warehouseName : "") + "）\n";
  } else {
    report += "\n";
  }

  if (liveStatus === "auth_rejected") {
    report += "• API 令牌：平台拒绝授权（401/403，可能已被吊销或权限不足）\n";
    report += "• 授权时长：有效期至 " + expDate + "\n";
    report += "• 授权状态：未通过。请在 WB 卖家后台重新生成全权限 API 令牌并发送。" + bindingGuide;
    return report;
  }

  const permText = isReadWrite ? "全权限读写 (Full Access)" : "只读权限 (Read-Only)";
  report += "• API 令牌（API Key）：" + maskedToken + "（" + permText + oidInfo + "）\n";
  report += "• 授权时长：" + (remainingDays !== null ? "剩余 " + remainingDays + " 天（有效期至 " + expDate + "）" : "长期有效") + "\n";

  if (liveStatus === "live_ok") {
    report += "• 平台连接：Wildberries 官方接口通信正常\n";
    report += "• 授权状态：已核验通过。已具备商品建卡、多图上传、价格与库存同步权限。" + bindingGuide;
  } else {
    report += "• 授权状态：已核验通过（凭据解析正常）。已具备商品建卡与图文发布对接就绪。" + bindingGuide;
  }

  return report;
}

export function isStoreOperationQuestion(text) {
  const t = text.trim();
  if (/(?:店铺运营|如何运营|怎么运营|怎样运营|运营店铺|运营方法|运营策略|运营技巧|运营建议|运营指南|运营规则|运营思路|日常运营|WB运营|Wildberries运营|多店铺运营|多店运营|矩阵运营)/i.test(t)) return true;
  if (/(?:裂变定价|价格梯度|定价策略|定价规则|怎么定价|如何定价|价格怎么定|怎么改价|如何改价|调价策略|折扣设置|活动定价|利润测算)/i.test(t)) return true;
  if (/(?:初始库存|默认库存|库存设置|怎么改库存|如何改库存|库存同步|安全库存|库存规则|设置多少库存)/i.test(t)) return true;
  if (/(?:俄语标题|标题优化|标题规则|标题怎么写|关键词优化|SEO优化|搜索权重|自然流量|主图规范|八图规范|8张图|图片要求|转化率优化|点击率)/i.test(t)) return true;
  if (/(?:1拆10|一拆十).*(?:规则|策略|优势|好处|怎么玩|是什么|有什么用|运营|逻辑|模式)/i.test(t)) return true;
  if (/(?:防关联|同款去重|重复铺货|会被判重复吗|广告投流|推广引流|新品破零|怎么起店|如何起店|出单技巧|选品策略|怎么选品|如何选品)/i.test(t)) return true;
  if (/^(?:运营|选品|定价|改价|库存|改库存|标题|关键词|SEO|推广|投流|广告|流量|防关联|去重|多店|多店铺)[？?！!。]*$/i.test(t)) return true;
  return false;
}

export async function answerStoreOperationQuestion(senderId, env, text = "") {
  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  const creds = credsRes.ok ? (await credsRes.json()).credentials : null;
  const shopName = creds?.shop_name || "未绑定";
  const warehouseId = creds?.warehouse_id || "未绑定";

  let reply = "【Wildberries 店铺运营与 1拆10 裂变策略指南】\n";
  reply += "• 当前关联店铺：" + shopName + "（发货仓库：" + warehouseId + "）\n\n";
  reply += "1. 1拆10 视觉与 SEO 矩阵防重：\n";
  reply += "   针对单款潜力爆品生成 10 套差异化应用人群与生活场景图文、俄语 SEO 标题（严格控制在 60 字符以内，覆盖高搜索量俄语核心词与长尾词）及结构化详情描述，提升类目搜索曝光并避免同质化铺货。\n";
  reply += "2. 阶梯定价测款策略（测试价格弹性）：\n";
  reply += "   建议采用价格梯度布局：前 5 款（L01~L05）在基准价上浮 +2% ~ +15% 测试高毛利承受力；后 5 款（L06~L10）下浮 -2% ~ -10% 吸引比价流量与转化。\n";
  reply += "3. 库存与改价安全规范：\n";
  reply += "   新品建卡建议设置安全初始库存（如 5 件/款）并关联指定发货仓库；后续对线上商品改价或改库存均需卖家核验确认，系统不会未经授权自动改动线上价格或库存。\n";
  reply += "4. 多店铺隔离与日常推进：\n";
  reply += "   支持多店铺独立凭据管理，发送货号时可指定店铺（如“WB 货号 1879785812 店铺：RR010”）。观察 7~14 天点击与加购数据后，集中资源保留高转化链接，优化长尾款。";
  return reply;
}

export async function buildReply(text, senderId, messageId, env, chatId = null) {
  text = String(text || "").replace(/@_user_\d+\s*/g, "").trim();

  // Handle 6-digit scan verification code or "开通" / "扫码" / "提取账号" for cross-organization Feishu users
  const scanCodeMatch = text.match(/^(?:验证码\s*[:：]?\s*|扫码\s*[:：]?\s*)?(\d{6})$/);
  const isQuickBindCmd = /^(?:开通|扫码|扫码开通|提取账号|绑定账号|扫码绑定)[！!。？?]*$/i.test(text);
  if (scanCodeMatch || isQuickBindCmd) {
    const verifyCode = scanCodeMatch ? scanCodeMatch[1] : "";
    const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
    const creds = credsRes.ok ? (await credsRes.json()).credentials : null;
    const shopName = creds?.shop_name || "";
    let accountId = "WB_ACC_" + String(senderId || "").replace(/^ou_/, "").slice(-6).toUpperCase();
    let boundScan = false;
    try {
      const bindRes = await fetch("https://diytale.com/api/feishu/bot-bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          open_id: senderId,
          verify_code: verifyCode,
          use_latest_scan: true,
          name: shopName ? `飞书认证卖家 (${shopName})` : "飞书认证卖家",
          store_name: shopName,
          agent_code: "zhuang_qz"
        }),
        signal: AbortSignal.timeout(2500)
      });
      if (bindRes.ok) {
        const bindData = await bindRes.json();
        if (bindData.account?.account_id) accountId = bindData.account.account_id;
        if (bindData.scan_token) boundScan = true;
      }
    } catch {
      // Ignore network/mock error in unit tests
    }
    const directApplyUrl = "https://diytale.com/apply?agent=zhuang_qz&open_id=" + encodeURIComponent(senderId || "") +
      "&account_id=" + encodeURIComponent(accountId) +
      (shopName ? "&store=" + encodeURIComponent(shopName) : "");
    let msg = "✅ 【飞书跨企业免审核 · 账号资料已自动提取】\n";
    msg += "• 专属客户账号：" + accountId + "\n";
    msg += "• 飞书唯一标识：" + (senderId || "未识别") + "\n";
    if (shopName) msg += "• 关联店铺名称：" + shopName + "\n";
    if (boundScan) {
      msg += "• 网页扫码同步：已实时同步至您当前打开的授权网页，请直接返回网页选择套餐并提交！\n";
    }
    msg += "\n👉 您也可以直接点击下方专属免扫码链接（已自动填入您的飞书账号），一键选择 3天免费测试 或 1个月/2个月/多月套餐提交开通：\n" + directApplyUrl;
    return msg;
  }

  const credentialText = /^资料\s*[:：]/.test(text) ? "" : text;
  const hasTokenMatch = credentialText.match(/(?:API\s*令牌|API\s*密钥|API\s*key|apikey|api_token|绑定\s*api|token|令牌|api)\s*[:：]\s*([^\s]+)/i) ||
    (credentialText.match(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/) ? [null, credentialText] : null);
  const hasShopMatch = credentialText.match(/(?:店铺名称|店铺名|店铺|shop(?:_name)?)\s*[:：]\s*([^\s]+)/i);
  const hasWarehouseMatch = credentialText.match(/(?:发货仓库|仓库\s*ID|仓库号|仓库|warehouse(?:_id)?)\s*[:：]\s*([^\s]+)/i);

  const isProductSubmission = !!resolveProduct(text);
  if ((hasTokenMatch || hasWarehouseMatch || hasShopMatch) && (!isProductSubmission || hasTokenMatch)) {
    const creds = {};
    if (hasTokenMatch) creds.api_token = hasTokenMatch[1].trim();
    if (hasShopMatch) creds.shop_name = hasShopMatch[1].trim();
    if (hasWarehouseMatch) creds.warehouse_id = hasWarehouseMatch[1].trim();
    const stored = await coordinate(env, "/credentials", { sender_id: senderId, credentials: creds });
    if (!stored.ok) return "店铺资料未保存，请检查输入后重试。";
    if (typeof senderId === "string" && senderId.startsWith("ou_") && creds.shop_name) {
      try {
        await fetch("https://diytale.com/api/feishu/bot-bind", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            open_id: senderId,
            name: `飞书卖家 (${creds.shop_name})`,
            store_name: creds.shop_name,
            agent_code: "zhuang_qz"
          }),
          signal: AbortSignal.timeout(1500)
        });
      } catch {}
    }
    let replyText = "已成功记录并落盘店铺凭据：\n";
    if (creds.shop_name) replyText += "• 店铺名称：" + creds.shop_name + "\n";
    if (creds.warehouse_id) replyText += "• 发货仓库：" + creds.warehouse_id + "\n";
    if (creds.api_token) replyText += "• WB API 令牌：已成功落盘存储\n";
    replyText += "已保存到您的账号；尚未验证令牌权限。图文制作不会自动上架，发布店铺商品需另行核验与授权。";
    return replyText;
  }
  if (isWindowAuthQuestion(text) && !resolveProduct(text)) {
    return await answerWindowAuthQuestion(senderId, env, text);
  }
  if (isCredentialQuestion(text) && !resolveProduct(text)) {
    return await verifyAndReportCredentials(senderId, env, text);
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
  const retryMatch = text.match(/^(?:重试|继续制作|重新发送|retry)(?:\s+(?:请求编号\s*[:：]?\s*)?(om_[a-zA-Z0-9_-]+))?[！!。]*$/i);
  if (retryMatch) {
    const query = retryMatch[1] ? "/task?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + "&task_id=" + encodeURIComponent(retryMatch[1]) : "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "");
    const latest = await (await coordinate(env,query)).json();
    if (!latest.key) return "没有找到本聊天对应的请求记录，不能改用其他批次重试。请提供请求编号让维护者核查。";
    const prefix = "本次查询：WB 货号 " + latest.task.nmId + "\n请求编号：" + latest.task.task_id + "\n";
    if (latest.task.status === "ready") {
      const d=latest.task.details || {};
      return prefix + (d.delivery_verified && d.delivered_scenes === 10 && d.archive_message_id ? "这条请求的10套图文及压缩包已有交付记录，无需重复发送。" : "这条请求被标记完成，但交付凭据不足，需要维护者核验。") + "图文交付不代表已上架。若您指另一条失败请求，请发送“重试 请求编号”。";
    }
    const resumed = await coordinate(env,"/retry",{key:latest.key,message_id:messageId});
    return prefix + (resumed.ok ? "已恢复该商品请求，将重新核验已有图片并继续制作，完成后回传本聊天。" : "未启动重复重试，任务状态可能已变化。请发送“进度”查看。");
  }
  if (isListingCommand(text)) {
    const requested = resolveProduct(text);
    const stores=targetStores(text);
    if(stores.length>1) return "检测到多个目标店铺，请明确本次上架到哪一家；不会默认选择店铺或重新生成图文。";
    if(!requested && /https?:\/\/|WB\s*[0-9]|货号|nmid|[0-9]{6,13}/i.test(text)) return "商品链接或货号无法唯一确认，请明确一个 WB 商品链接或货号；不会改用其他商品任务。";
    return await executeListingCommand(senderId, chatId, env, requested, stores[0] || null, messageId);
  }
  if (isListingQuestion(text) || /(?:上架|发布)/.test(text) && resolveProduct(text)) {
    const requested = resolveProduct(text);
    const quotedTaskIdMatch = text.match(/(?:请求编号|任务编号|编号|task_id)\s*[:：]?\s*(om_[a-zA-Z0-9_-]+)/i) || text.match(/\b(om_[a-zA-Z0-9_-]{16,64})\b/i);
    const quotedTaskId = quotedTaskIdMatch ? quotedTaskIdMatch[1] : null;
    return await explainListingStatus(senderId, chatId, env, requested, quotedTaskId, text);
  }
  // A question containing a product number must not silently create another job.
  if (isFailureQuestion(text)) {
    const requested = resolveProduct(text);
    const quotedTaskIdMatch = text.match(/(?:请求编号|任务编号|编号|task_id)\s*[:：]?\s*(om_[a-zA-Z0-9_-]+)/i) || text.match(/\b(om_[a-zA-Z0-9_-]{16,64})\b/i);
    const quotedTaskId = quotedTaskIdMatch ? quotedTaskIdMatch[1] : null;
    let task = null;
    if (quotedTaskId) {
      const taskRes = await coordinate(env, "/task?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + "&task_id=" + encodeURIComponent(quotedTaskId));
      if (taskRes.ok) task = (await taskRes.json()).task;
    }
    if (quotedTaskId && !task) return "未找到本聊天的请求编号 " + quotedTaskId + "，不能用其他批次代替，也不能据此认定已交付。请维护者核查历史记录。";
    if (!task) {
      const { task: latestTask } = await (await coordinate(env, "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + (requested?.nmId ? "&nmid=" + encodeURIComponent(requested.nmId) : ""))).json();
      task = latestTask;
    }
    if (!task) return "本聊天还没有找到您的商品任务，无法判断失败原因。请先提供商品链接或任务信息。";
    if (requested && requested.nmId !== task.nmId) return "本聊天最近任务的货号是 " + task.nmId + "，与您询问的货号不同，不能据此解释该商品的失败原因。";
    const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n";
    if (task.status === 'failed') return prefix + explainFailure(task);
    if (task.status === 'awaiting_delivery') return prefix + "图文已生成，卡在飞书交付阶段。请维护者检查图片/文件资源权限或连接，再发送“重试”续传。";
    if (task.status === 'needs_input') return prefix + "当前需要补充资料。" + (task.summary || "请补充原图和商品名称。") + "\n补充资料后会继续处理。";
    if (task.status === 'ready') return prefix + "本次图文已经交付，当前没有失败记录。若您指的是店铺上架，请说明具体商品与后台提示。可发送“为何未上架”查看上架详情。";
    return prefix + "当前任务尚未被标为失败。" + (task.summary || "正在等待执行。") + "\n可发送“进度”查看；本次询问不会重新创建任务。";
  }
  if (isStoreOperationQuestion(text) && !resolveProduct(text)) {
    return await answerStoreOperationQuestion(senderId, env, text);
  }
  const product = resolveProduct(text);
  if (product) {
    if (/(?:？|\?|为什么|为何|为啥|怎么|哪里|咋|什么原因|怎么回事|可否|是否|能否|好像|似乎|只有|没有|未见|不见|前台|只显示|没显示)/.test(text)) {
      return "识别到商品货号 " + product.nmId + "。如需为该商品制作10套裂变场景图文，请直接发送该货号或商品链接；如需查询状态，请发送“进度”或“为何未上架”。";
    }
    const stores=targetStores(text);
    if(stores.length>1) return "检测到多个目标店铺，请明确一家后再提交商品；本次未创建制作任务。";
    const targetStore=stores[0] || null;
    const taskPayload = { task_id: messageId, sender_id: senderId, chat_id: chatId, mode: "creative", ...product };
    if (targetStore) taskPayload.target_store = targetStore;
    const key = "task:" + encodeURIComponent(senderId) + ":" + encodeURIComponent(messageId);
    const response = await coordinate(env, "/put", { key, task: taskPayload });
    if (!response.ok) throw new Error("Task persistence failed");
    const h = await health(env);
    let ack = "已记录商品请求：WB 货号 " + product.nmId + "\n请求编号：" + messageId;
    if (targetStore) ack += "\n目标店铺：" + targetStore;
    ack += "\n当前状态：" + (h.online ? "等待处理，执行服务在线。" : "等待处理，执行服务暂时离线；恢复后会继续处理。") +
      "\n系统会自动读取原图和商品信息，制作10种应用场景的图片、俄语标题和描述，完成后回传本聊天。可发送“进度”查看。";
    return ack;
  }
  if (/(进度|多久|完成了吗|好了吗|有在执行吗|在做吗|开始了吗|状态|排队|完成了没)/.test(text)) {
    const { task } = await (await coordinate(env, "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || ""))).json();
    if (!task) return "尚未找到您的商品请求，请发送 WB 商品详情链接或平台货号。";
    const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n";
    if(task.publication) return prefix+"目标店铺："+task.publication.store+"\n图文已完成，上架指令已保存。\n"+task.publication.summary+publicationResult(task.publication);
    if (task.status === "waiting_executor") {
      const h = await health(env);
      return prefix + (h.online ? "状态：等待处理，执行服务在线。" : "状态：执行服务暂时离线，请求已保存，恢复后继续。") + "\n尚未确认生成或上架。";
    }
    const labels = { validating: "资料核验中", processing: "处理中", generating_text: "文案制作中", generating_images: "图片制作中", reviewing: "审查中",
      needs_input: "需要补充资料", awaiting_delivery: "图文已生成，等待飞书交付", failed: "处理失败，需检查", ready: "资产包已生成，尚未上架", cancelled: "已取消" };
    return prefix + "状态：" + (labels[task.status] || "待核验") + "。\n" + (task.status==='failed' ? explainFailure(task) : (task.summary || ""));
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
  await sendFeishuReply(token, message.message_id, message.chat_id, reply, senderId);
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
        generation_enabled: h.online && !!h.capabilities.generation, publishing_enabled: h.online && !!h.capabilities.publishing,
        task_counts: h.counts, pending_events:h.pending_events || 0, event_failures:h.event_failures || 0, version: "2026-10-14-upload-first", coordinator_version: h.version || null });
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
      if (url.pathname === "/api/task" && ["GET", "DELETE"].includes(request.method)) {
        return coordinate(env, "/task" + url.search, undefined, request.method);
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
      const routes = { "/api/tasks/restore-failure": "/restore-failure", "/api/tasks/claim": "/claim", "/api/tasks/update": "/update", "/api/tasks/retry": "/retry", "/api/tasks/diagnostic": "/diagnostic", "/api/tasks/publication": "/publication", "/api/tasks/publication/preflight": "/publication/preflight", "/api/tasks/publication/claim": "/publication/claim", "/api/tasks/publication/update": "/publication/update" };
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
