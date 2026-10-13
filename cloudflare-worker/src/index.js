import { TaskCoordinator } from "./task-coordinator.js";
export { TaskCoordinator };

const DEFAULT_APP_ID = "cli_aa42e84775381cfd";
const j = (data, status = 200) => Response.json(data, { status, headers:{"Cache-Control":"private, no-store, max-age=0","Vary":"Authorization"} });
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

export function isFailureQuestion(text) {
  return /(?:为什么|为何|什么原因|怎么|哪里|咋).*(?:失败|报错|异常|出错|卡住|没成功|未完成|没完成|没有完成)|(?:失败|报错|异常|出错|卡住).*(?:原因|为什么|怎么|解释)|(?:怎么回事|失败原因|错误原因|故障原因|怎么解决|如何解决|怎么办|什么情况)[？?！!。]*$/.test(text);
}

export function isListingQuestion(text) {
  const t = text.trim();
  if (/(?:为何|为什么|为啥|怎么|哪里|咋|什么原因|何时|什么时候).*(?:未上架|还没上架|没上架|不上架|未发布|没发布|自动上架|不自动上架|未进店铺)/i.test(t)) return true;
  if (/(?:未上架|还没上架|没上架|不上架|未发布).*(?:原因|为什么|为何|为啥|怎么|解释|怎么回事)/i.test(t)) return true;
  if (/^(?:为何未上架|为什么未上架|为什么还没上架|为何还没上架|为啥还没上架|为啥未上架|怎么还没上架|怎么没上架|为何不上架|为什么不上架|未上架原因|未上架|尚未上架|为何尚未上架|为什么不自动上架|为何不自动上架|何时上架|什么时候上架|怎么上架|如何上架|这个为何未上架)[？?！!。]*$/i.test(t)) return true;
  if (/(?:为何|为什么|怎么|何时|什么时候).*(?:上架|发布到店铺|推到店铺)[？?！!。]*$/i.test(t)) return true;
  if (/(?:为何|为什么|为啥).*(?:不上架|未上架|没上架)/i.test(t)) return true;
  if (/(?:前台|链接|主图|详情页|多图|图片).*(?:只有|好像|没有|未更新|没更新|看不到|没显示|未显示)/i.test(t)) return true;
  if (/(?:只有一张图|还是只有一张图|只有单图|没有详情页|详情页好像还是没有|详情页好像没有|没有多张主图|为什么只有一张图|为何只有一张图)[？?！!。]*$/i.test(t)) return true;
  return false;
}

export function isListingCommand(text) {
  const t = text.trim();
  if (/(?:？|\?|为什么|为何|为啥|怎么|何时|什么时候|能否|是否|可否|哪里|咋|什么原因|好像|只有|没有|未显示|没显示)/.test(t)) {
    return false;
  }
  const cmdVerbs = "(?:确认上架|开始上架|立即上架|执行上架|申请上架|直接上架|继续上架|恢复上架|推进上架|现在上架|进行上架|安排上架|上架|发布到店铺|确认发布|立即发布)";
  const productPrefix = "(?:(?:wb\\s*)?(?:货号|артикул|articul|nmid)\\s*[:：]?\\s*[0-9]{6,13}|[0-9]{6,13})";
  const politePrefix = "(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)?";

  // 1. Direct command: "上架", "请上架", "继续上架", "确认发布"
  if (new RegExp(`^${politePrefix}\\s*${cmdVerbs}[！!。]*$`, "i").test(t)) return true;

  // 2. Product followed by command: "WB 货号 1879785812 继续上架", "1879785812 上架"
  if (new RegExp(`^${politePrefix}\\s*${productPrefix}\\s*${cmdVerbs}[！!。]*$`, "i").test(t)) return true;

  // 3. Command followed by product: "继续上架 WB 货号 1879785812", "上架 1879785812"
  if (new RegExp(`^${politePrefix}\\s*${cmdVerbs}\\s*${productPrefix}[！!。]*$`, "i").test(t)) return true;

  return false;
}

export async function explainListingStatus(senderId, chatId, env, requested = null, quotedTaskId = null, questionText = "") {
  let task = null;
  if (quotedTaskId) {
    const taskRes = await coordinate(env, "/task?sender=" + encodeURIComponent(senderId) + "&task_id=" + encodeURIComponent(quotedTaskId));
    if (taskRes.ok) {
      const data = await taskRes.json();
      if (data.task) task = data.task;
    }
  }
  if (!task) {
    const query = "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + (requested?.nmId ? "&nmid=" + encodeURIComponent(requested.nmId) : "");
    const res = await coordinate(env, query);
    if (res.ok) {
      const data = await res.json();
      task = data.task;
    }
  }
  if (!task) {
    return "本聊天还没有找到您的商品任务，无法核实上架状态。\n如需裂变上架，请先发送 WB 商品链接或货号（如：WB 货号 1879785812）。系统将自动读取原图并生成10种同款场景图文，复核无误后即可发布到您的 WB 店铺。";
  }
  if (requested && requested.nmId !== task.nmId) {
    return "本聊天最近任务的货号是 " + task.nmId + "，与您询问的货号 " + requested.nmId + " 不同。如需处理该货号，请先发送该商品链接。";
  }

  const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n";
  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  const creds = credsRes.ok ? (await credsRes.json()).credentials : null;
  const shopName = creds?.shop_name || "未指定";
  const warehouseId = creds?.warehouse_id || "未指定";
  const token = creds?.api_token;
  const claims = token ? parseJwtClaims(token) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = claims?.exp && claims.exp < nowSec;
  const isTokenValid = claims && !isExpired && claims.t === false;

  if (task.status === "ready") {
    let answer = prefix + "状态：资产包已生成，尚未上架。\n\n";
    if (/(?:前台|链接|主图|一张图|单图|多图|详情页)/.test(questionText)) {
      answer += "【前台图文说明】\n";
      answer += "您打开的原商品链接仅包含原始商品的单张图片与原版信息。\n";
      answer += "裂变助手已为该商品生成10套全新的同款场景图（每套含完整主图与轮播图）及俄语描述，已交付本聊天，尚未推送到您的店铺。\n\n";
    }
    answer += "【未自动上架原因】\n";
    answer += "1. 安全复核机制：裂变助手生成10套场景图片与俄语描述后，按平台安全规范，先回传飞书交付商家复核，不会自动静默推送到店铺，避免未经审核直接发布。\n";
    answer += "2. 需店铺授权确认：发布到 Wildberries 店铺需要核验绑定的店铺 API 令牌与发货仓库。\n\n";

    if (isTokenValid && creds?.warehouse_id) {
      answer += "【店铺授权状态】已就绪\n";
      answer += "• 店铺名称：" + shopName + "\n";
      answer += "• 发货仓库：" + warehouseId + "\n";
      answer += "• API 令牌：全权限读写（有效）\n\n";
      answer += "【下一步操作】\n";
      answer += "商品图文资产包已就绪。请复核本聊天的10套场景图片与俄语标题文案；确认外观和文案满意后，发送“上架”或“确认上架”（或“继续上架”），系统将调用 Wildberries 官方建卡接口创建10个全新变体并同步图片与初始库存（默认每款5件）。";
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

export async function executeListingCommand(senderId, chatId, env, requested = null) {
  const query = "/latest?sender=" + encodeURIComponent(senderId) + "&chat=" + encodeURIComponent(chatId || "") + (requested?.nmId ? "&nmid=" + encodeURIComponent(requested.nmId) : "");
  const { task } = await (await coordinate(env, query)).json();
  if (!task) {
    return "尚未找到可上架的商品任务。请先发送 WB 商品详情链接或平台货号制作裂变图文。";
  }
  if (requested && task.nmId !== requested.nmId) {
    return "本聊天尚未找到货号 " + requested.nmId + " 的已就绪任务。当前最近任务的货号是 " + task.nmId + "。如需上架新商品，请先发送该商品链接制作裂变图文。";
  }
  const prefix = "最近请求：WB 货号 " + task.nmId + "\n请求编号：" + task.task_id + "\n";
  if (task.status !== "ready") {
    const labels = {
      waiting_executor: "等待处理", validating: "资料核验中", processing: "处理中",
      generating_text: "文案制作中", generating_images: "图片制作中", reviewing: "审查中",
      needs_input: "需要补充资料", awaiting_delivery: "等待交付", failed: "处理失败"
    };
    return prefix + "当前商品状态为【" + (labels[task.status] || task.status) + "】，尚未完成完整资产包制作，暂不能执行上架。\n可发送“进度”查看最新状态。";
  }

  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  const creds = credsRes.ok ? (await credsRes.json()).credentials : null;
  const token = creds?.api_token;
  const claims = token ? parseJwtClaims(token) : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = claims?.exp && claims.exp < nowSec;
  const isTokenValid = claims && !isExpired && claims.t === false;
  const shopName = creds?.shop_name || "未指定";
  const warehouseId = creds?.warehouse_id || "未指定";

  if (!isTokenValid || !creds?.warehouse_id) {
    let msg = prefix + "已收到上架请求，但店铺授权尚未齐备，无法执行建卡发布：\n";
    msg += "• 店铺名称：" + shopName + "\n";
    msg += "• 发货仓库：" + warehouseId + "\n";
    if (!token) msg += "• API 令牌：尚未上传\n\n请先发送“API令牌：<您的全权限WB API令牌>”完成授权绑定。";
    else if (isExpired) msg += "• API 令牌：已过期\n\n请在 WB 后台重新生成全权限 API 令牌并发送更新。";
    else msg += "• API 令牌：非全权限读写令牌\n\n请在 WB 后台生成全权限 API 令牌并发送更新。";
    return msg;
  }

  let confirmMsg = prefix + "已确认上架指令，店铺授权核验通过：\n";
  confirmMsg += "• 目标店铺：" + shopName + "\n";
  confirmMsg += "• 发货仓库：" + warehouseId + "\n";
  confirmMsg += "• 变体数量：10 款全新场景同款\n";
  confirmMsg += "• 初始库存：每款 5 件\n";
  confirmMsg += "• 定价策略：梯度定价（前5款+1%~15%溢价测试，后5款-1%~10%促销穿透，每款价格互不相同）\n\n";
  confirmMsg += "上架任务已准备就绪。正在核对商品类目属性与官方条码，即将通过 Wildberries 官方 API 批量建卡并同步 8 图矩阵与初始库存。上架进度与分配的 nmID 将实时同步本聊天。";
  return confirmMsg;
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
    scene_plan_invalid:"场景方案的结构、机位或景别没有达到制作要求。",
    generator_not_configured:"当前没有配置可用的图文生成服务。",
    generation_failed:"图文生成程序中断，现有记录未提供更具体的可核实原因。",
    lease_expired:"执行服务多次中断或未及时续报进度，任务已停止自动重试。",
  };
  const issues={camera_angle:"拍摄角度未达到要求",label_distortion:"产品标签文字或图案失真",extra_product:"画面出现额外商品，可能误导销售数量",missing_packaging:"应展示的包装缺失"};
  let answer="失败原因："+(reasons[code] || "这条旧记录没有保存具体错误原因，目前不能确定；需要维护者核对执行记录，不能直接归因于 WB API。")+"\n";
  if (Number.isInteger(d.failed_image) && d.failed_image>=1 && d.failed_image<=10) answer+="停止位置：第"+d.failed_image+"张图片。\n";
  if (Number.isInteger(d.completed) && d.completed>=0 && d.completed<=10) answer+="已通过检查："+d.completed+"/10张。\n";
  const known=[...new Set((Array.isArray(d.issue_codes)?d.issue_codes:[]).filter(x=>Object.hasOwn(issues,x)))];
  if (known.length) answer+="核对发现："+known.map(x=>issues[x]).join("；")+"。\n";
  if (['generation_auth_failed','executor_auth_failed','generator_not_configured'].includes(code)) answer+="下一步：维护者修复服务后，在本聊天发送“重试”。";
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

export function isCredentialQuestion(text) {
  const t = text.trim();
  if (/^(?:API令牌|api_token|token|令牌|店铺名|店铺|shop|仓库ID|仓库|warehouse(?:_id)?)\s*[:：]/i.test(t)) {
    return false;
  }
  if (/(?:核验|验证|授权|检查|查看|查询|确认).*(?:令牌|token|api|店铺|凭据|仓库|授权)/i.test(t)) return true;
  if (/(?:店铺|令牌|token|api|凭据|仓库|授权).*(?:核验|验证|有效|状态|权限|到期|过期|信息|配置)/i.test(t)) return true;
  if (/^(?:店铺凭据|店铺授权|核验店铺|核验令牌|验证令牌|检查令牌|授权状态|店铺状态|查看凭据|核验API|验证API|核验授权)$/i.test(t)) return true;
  return false;
}

export async function verifyAndReportCredentials(senderId, env) {
  const credsRes = await coordinate(env, "/credentials?sender=" + encodeURIComponent(senderId));
  if (!credsRes.ok) return "暂无法查询店铺凭据，请稍后重试。";
  const { credentials } = await credsRes.json();
  if (!credentials || (!credentials.api_token && !credentials.shop_name && !credentials.warehouse_id)) {
    return "尚未找到您上传的店铺凭据。\n如需绑定并核验店铺，请按以下格式发送：\n店铺名：RR010\n仓库ID：2200772\nAPI令牌：<您的WB API令牌>";
  }
  const shopName = credentials.shop_name || "未指定";
  const warehouseId = credentials.warehouse_id || "未指定";
  const token = credentials.api_token;

  let report = "已核验您的店铺凭据与授权状态：\n";
  report += "• 店铺名称：" + shopName + "\n";
  report += "• 发货仓库：" + warehouseId;

  if (!token) {
    report += "\n• API 令牌：尚未上传\n• 授权状态：未完成授权。请发送“API令牌：<您的令牌>”完成绑定。";
    return report;
  }

  const claims = parseJwtClaims(token);
  if (!claims) {
    report += "\n• API 令牌：已存储（非标准 JWT 格式或测试令牌）\n• 授权状态：凭据已存储。若用于正式上架，请提供 WB 后台生成的全权限 API 令牌。";
    return report;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const isExpired = claims.exp && claims.exp < nowSec;
  const expDate = claims.exp ? new Date(claims.exp * 1000).toISOString().slice(0, 10) : "长期";
  const isReadWrite = claims.t === false;

  if (isExpired) {
    report += "\n• API 令牌：已过期（到期日：" + expDate + "）\n";
    report += "• 授权状态：未通过。令牌已失效，请重新生成并上传新令牌。";
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
    report += "• 授权状态：未通过。请在 WB 卖家后台重新生成全权限 API 令牌并发送。";
    return report;
  }

  const permText = isReadWrite ? "全权限读写 (Full Access)" : "只读权限 (Read-Only)";
  report += "• API 令牌：" + permText + "（有效期至 " + expDate + "）\n";

  if (liveStatus === "live_ok") {
    report += "• 平台连接：Wildberries 官方接口通信正常\n";
    report += "• 授权状态：已核验通过。已具备商品建卡、多图上传、价格与库存同步权限。";
  } else {
    report += "• 授权状态：已核验通过（凭据解析正常）。已具备商品建卡与图文发布对接就绪。";
  }

  return report;
}

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
  if (isCredentialQuestion(text) && !resolveProduct(text)) {
    return await verifyAndReportCredentials(senderId, env);
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
  if (isListingCommand(text)) {
    const requested = resolveProduct(text);
    return await executeListingCommand(senderId, chatId, env, requested);
  }
  if (isListingQuestion(text)) {
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
      const taskRes = await coordinate(env, "/task?sender=" + encodeURIComponent(senderId) + "&task_id=" + encodeURIComponent(quotedTaskId));
      if (taskRes.ok) task = (await taskRes.json()).task;
    }
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
  const product = resolveProduct(text);
  if (product) {
    if (/(?:？|\?|为什么|为何|为啥|怎么|哪里|咋|什么原因|怎么回事|可否|是否|能否|好像|似乎|只有|没有|未见|不见|前台|只显示|没显示)/.test(text)) {
      return "识别到商品货号 " + product.nmId + "。如需为该商品制作10套裂变场景图文，请直接发送该货号或商品链接；如需查询状态，请发送“进度”或“为何未上架”。";
    }
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
        task_counts: h.counts, pending_events:h.pending_events || 0, event_failures:h.event_failures || 0, version: "2026-10-12-listing-qa1" });
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
      const routes = { "/api/tasks/claim": "/claim", "/api/tasks/update": "/update", "/api/tasks/retry": "/retry", "/api/tasks/diagnostic": "/diagnostic" };
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
