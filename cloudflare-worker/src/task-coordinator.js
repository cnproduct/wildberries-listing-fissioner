/**
 * Transactional task ownership and executor heartbeat.
 * One coordinator handles this small queue; KV is only a legacy migration source.
 */
const ACTIVE = new Set(["processing", "validating", "generating_text", "generating_images", "reviewing"]);
const STATES = new Set(["waiting_executor", ...ACTIVE, "needs_input", "ready", "failed", "cancelled", "awaiting_delivery"]);
const LEASE_MS = 180000;
const MAX_ATTEMPTS = 3;
// Task responses never carry seller credentials, including legacy records.
const publicTask = task => { if (!task) return task; const { credentials, ...safe } = task; return safe; };
const j = (data, status = 200) => Response.json(data, { status, headers:{"Cache-Control":"private, no-store, max-age=0","Vary":"Authorization"} });
const latestKey = (sender, chat) => 'latest:' + sender + (chat ? ':' + encodeURIComponent(chat) : '');
async function latestInChat(storage, sender, chat) {
  let key = await storage.get(latestKey(sender, chat));
  if (!key && chat) key = await storage.get(latestKey(sender));
  const task = key ? await storage.get(key) : null;
  return task && (!chat || task.chat_id === chat) ? { key, task } : { key: null, task: null };
}

export class TaskCoordinator {
  constructor(ctx) { this.storage = ctx.storage; }

  async recover(tx, now) {
    const inbox = await tx.list({prefix:'event:'});
    for (const [key,event] of inbox) {
      if (!event.done && event.attempts>=5 && event.expires_at<=now && event.payload) await tx.put(key,{id:event.id,failed:true,attempts:5,created_at:event.created_at});
    }
    const tasks = await tx.list({ prefix: "task:" });
    for (const [key, task] of tasks) {
      if (task.credentials) {delete task.credentials;await tx.put(key,task);}
      if (task.sender_id && task.chat_id) {
        const pointerKey=latestKey(task.sender_id,task.chat_id);
        const pointer=await tx.get(pointerKey), previous=pointer ? await tx.get(pointer) : null;
        if (!previous || (task.timestamp || 0) > (previous.timestamp || 0)) await tx.put(pointerKey,key);
      }
      if (ACTIVE.has(task.status) && (!task.lease_expires_at || task.lease_expires_at <= now)) {
        task.status = (task.attempts || 0) >= MAX_ATTEMPTS ? "failed" : "waiting_executor";
        task.summary = task.status === "failed" ? "执行多次中断，已停止重试，请检查执行服务。" : "上次执行中断，请求已恢复到待处理队列。";
        task.updated_at = now;
        delete task.lease_id; delete task.worker_id; delete task.lease_expires_at;
        await tx.put(key, task);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch { return j({ error: "Invalid JSON" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return j({ error: "Invalid object" }, 400);
    }
    // Persist inbound events before webhook acknowledgement; claims prevent parallel replays.
    if (url.pathname === '/events' && request.method === 'POST') {
      if (!body.id || !body.payload?.event?.message) return j({error:'Invalid event'},400);
      return this.storage.transaction(async tx=>{
        const key='event:'+body.id;
        let event=await tx.get(key);
        if (!event) {event={id:body.id,payload:body.payload,created_at:now,attempts:0};await tx.put(key,event);}
        return j({event:event.done || event.attempts>=5 ? null : event});
      });
    }
    if (url.pathname === '/events' && request.method === 'GET') {
      const entries=await this.storage.list({prefix:'event:'});
      return j({events:[...entries.values()].filter(e=>!e.done && e.attempts<5 && (!e.expires_at || e.expires_at<=now)).slice(0,20)});
    }
    if (url.pathname === '/events/claim' && request.method === 'POST') {
      return this.storage.transaction(async tx=>{
        const key='event:'+body.id,event=await tx.get(key);
        if(!event || event.done || event.attempts>=5 || event.expires_at>now) return j({error:'Event unavailable'},409);
        event.attempts++;event.lease=crypto.randomUUID();event.expires_at=now+60000;
        await tx.put(key,event);return j({event,lease:event.lease});
      });
    }
    if (url.pathname === '/events/done' && request.method === 'POST') {
      return this.storage.transaction(async tx=>{
        const key='event:'+body.id,event=await tx.get(key);
        if(!event || event.lease!==body.lease) return j({error:'Event lease lost'},409);
        // Discard message content, which may include a seller token, after processing.
        await tx.put(key,{id:event.id,done:true,created_at:event.created_at});return j({code:0});
      });
    }
    if (url.pathname === "/health") {
      const registered = [...(await this.storage.list({prefix:'executor:'})).values()];
      const legacy = await this.storage.get('executor');
      const active = (registered.length ? registered : legacy ? [legacy] : []).filter(e=>now-e.last_seen<45000);
      const online = active.length>0;
      const executor = active.sort((a,b)=>b.last_seen-a.last_seen)[0];
      const capabilities = Object.assign({},...active.map(e=>e.capabilities || {}));
      capabilities.generation = active.some(e=>e.capabilities?.generation);
      capabilities.publishing = false;
      const tasks = await this.storage.list({ prefix: "task:" });
      const counts = {};
      for (const task of tasks.values()) counts[task.status] = (counts[task.status] || 0) + 1;
      const inbox = [...(await this.storage.list({prefix:'event:'})).values()];
      return j({ event_failures:inbox.filter(e=>e.failed).length, pending_events:inbox.filter(e=>!e.done && !e.failed).length, online, last_seen: executor?.last_seen || null, capabilities: online ? capabilities : {}, counts });
    }
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (typeof body.worker_id !== "string" || !body.worker_id) return j({ error: "worker_id required" }, 400);
      if (body.key && body.lease_id) {
        return this.storage.transaction(async tx => {
          const task = await tx.get(body.key);
          if (!task || !ACTIVE.has(task.status) || task.lease_id !== body.lease_id || task.worker_id !== body.worker_id || task.lease_expires_at <= now) return j({ error: "Lease lost" }, 409);
          await tx.put("executor:" + body.worker_id, { worker_id: body.worker_id, last_seen: now, capabilities: body.capabilities || {} });
          task.lease_expires_at = now + LEASE_MS;
          await tx.put(body.key, task);
          return j({ code: 0 });
        });
      }
      await this.storage.put("executor:" + body.worker_id, { worker_id: body.worker_id, last_seen: now, capabilities: body.capabilities || {} });
      return j({ code: 0 });
    }
    if (url.pathname === "/credentials" && request.method === "POST") {
      if (!body.sender_id || !body.credentials || typeof body.credentials !== 'object' || Array.isArray(body.credentials)) return j({ error: "sender_id and credentials required" }, 400);
      const allowed = ['shop_name', 'warehouse_id', 'api_token'];
      if (Object.entries(body.credentials).some(([k,v]) => !allowed.includes(k) || typeof v !== 'string' || !v.trim() || v.length > 8192)) return j({ error: "Invalid credentials" }, 400);
      const key = "credentials:" + body.sender_id;
      const existing = (await this.storage.get(key)) || {};
      const updated = { ...existing, ...body.credentials, updated_at: now };
      await this.storage.put(key, updated);
      return j({ code: 0, credentials: { shop_name: updated.shop_name, warehouse_id: updated.warehouse_id, has_api_token: !!updated.api_token } });
    }
    if (url.pathname === "/credentials" && request.method === "GET") {
      const sender = url.searchParams.get("sender");
      if (!sender) return j({ error: "sender required" }, 400);
      const creds = await this.storage.get("credentials:" + sender);
      return j({ credentials: creds || null });
    }
    if (url.pathname === "/put" && request.method === "POST") {
      if (!body.key?.startsWith("task:") || !body.task?.task_id || !body.task?.sender_id) return j({ error: "Invalid task" }, 400);
      return this.storage.transaction(async tx => {
        const prior = await tx.get(body.key);
        if (prior) return j({ task: publicTask(prior), created: false });
        const task = { ...body.task, status: "waiting_executor", timestamp: now, attempts: 0 };
        delete task.credentials;
        await tx.put(body.key, task);
        await tx.put(latestKey(task.sender_id, task.chat_id), body.key);
        return j({ task: publicTask(task), created: true });
      });
    }
    if (url.pathname === "/import" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        let count = 0;
        for (const task of body.tasks || []) {
          if (!task.key?.startsWith("task:") || await tx.get(task.key)) continue;
          const key = task.key;
          // Legacy "ready" assets were generated from a hardcoded demo and need revalidation.
          const status = task.status === "waiting_executor" ? "waiting_executor" : "needs_input";
          const senderId = task.sender_id || decodeURIComponent(key.split(":")[1] || "");
          const updated = { ...task, sender_id: senderId, status, attempts: 0,
            summary: status === "needs_input" ? "旧版结果缺少原商品与生成依据，需重新核验资料；尚未确认上架。" : "请求已恢复，等待处理。",
            details: { legacy_result_unverified: task.status !== "waiting_executor" } };
          delete updated.credentials; delete updated.key; delete updated.lease_id; delete updated.lease_expires_at;
          await tx.put(key, updated);
          const pointer = await tx.get(latestKey(senderId, updated.chat_id));
          const latest = pointer ? await tx.get(pointer) : null;
          if (!latest || updated.timestamp >= latest.timestamp) await tx.put(latestKey(senderId, updated.chat_id), key);
          count++;
        }
        return j({ code: 0, imported: count });
      });
    }
    if (url.pathname === "/latest") {
      const latest = await latestInChat(this.storage, url.searchParams.get("sender"), url.searchParams.get("chat"));
      return j({ key: latest.key, task: publicTask(latest.task) });
    }
    if (url.pathname === "/list" || url.pathname === "/recover") {
      return this.storage.transaction(async tx => {
        await this.recover(tx, now);
        const entries = await tx.list({ prefix: "task:" });
        const filter = url.searchParams.get("status");
        const tasks = [...entries].filter(([, t]) => !filter || t.status === filter).map(([key, t]) => ({ ...publicTask(t), key }));
        tasks.sort((a, b) => a.timestamp - b.timestamp);
        return j({ code: 0, count: tasks.length, tasks });
      });
    }
    if (url.pathname === "/claim" && request.method === "POST") {
      if (!body.worker_id) return j({ error: "worker_id required" }, 400);
      return this.storage.transaction(async tx => {
        await this.recover(tx, now);
        const task = await tx.get(body.key);
        if (!task) return j({ error: "Task not found" }, 404);
        if (task.status !== "waiting_executor") return j({ error: "Already claimed or not eligible" }, 409);
        const executor = await tx.get('executor:'+body.worker_id);
        if (executor && !executor.capabilities?.generation) return j({error:'Executor cannot generate'},409);
        task.status = "validating"; task.worker_id = body.worker_id;
        task.lease_id = crypto.randomUUID(); task.lease_expires_at = now + LEASE_MS;
        task.attempts = (task.attempts || 0) + 1; task.updated_at = now;
        task.summary = "正在获取原商品资料并核验，尚未生成或发布。";
        await tx.put(body.key, task);
        return j({ code: 0, task: { ...publicTask(task), key: body.key } });
      });
    }
    if (url.pathname === "/update" && request.method === "POST") {
      if (!STATES.has(body.status) || body.status === "waiting_executor") return j({ error: "Invalid state" }, 400);
      return this.storage.transaction(async tx => {
        const task = await tx.get(body.key);
        if (!task) return j({ error: "Task not found" }, 404);
        if (!ACTIVE.has(task.status) || task.lease_id !== body.lease_id || task.worker_id !== body.worker_id || task.lease_expires_at <= now) return j({ error: "Lease lost" }, 409);
        if (body.status === "ready" && (!body.details?.artifacts_verified || !body.details?.manifest_path || body.details?.published)) {
          return j({ error: "Verified asset evidence required; publishing is separate" }, 400);
        }
        if (body.status === "ready" && task.mode === "creative" && (!body.details?.delivery_verified || body.details?.delivered_scenes !== 10 || !body.details?.archive_message_id)) {
          return j({error:"Ten scene deliveries and archive receipt required"},400);
        }
        task.status = body.status; task.summary = body.summary || task.summary;
        task.details = body.details || {}; task.updated_at = now;
        if (ACTIVE.has(task.status)) task.lease_expires_at = now + LEASE_MS;
        else { delete task.lease_id; delete task.lease_expires_at; delete task.worker_id; }
        await tx.put(body.key, task);
        return j({ code: 0, task: publicTask(task) });
      });
    }
    if (url.pathname === "/retry" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        const task = await tx.get(body.key);
        if (!task) return j({ error:"No task" },404);
        if (body.message_id && await tx.get('mutation:retry:'+body.message_id)) return j({code:0,task:publicTask(task)});
        if (ACTIVE.has(task.status)) return j({ error:"Task is processing" },409);
        if (body.message_id) await tx.put('mutation:retry:'+body.message_id,{key:body.key});
        task.status="waiting_executor"; task.attempts=0; task.mode="creative";
        task.summary="正在重新获取原商品，制作10套场景图文。"; task.updated_at=now;
        task.details={};
        await tx.put(body.key,task);
        return j({code:0,task:publicTask(task)});
      });
    }
    if (url.pathname === "/input" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        if (body.message_id && await tx.get('mutation:input:'+body.message_id)) return j({code:0,duplicate:true});
        const { key, task } = await latestInChat(tx, body.sender_id, body.chat_id);
        if (!task) return j({ error: "No task" }, 404);
        if (ACTIVE.has(task.status)) return j({ error: "Task is processing" }, 409);
        if (!body.facts || typeof body.facts !== "object" || Array.isArray(body.facts)) return j({ error: "Invalid facts" }, 400);
        if (body.message_id) await tx.put("mutation:input:"+body.message_id,{key});
        task.facts = { ...(task.facts || {}), ...body.facts }; task.status = "waiting_executor"; task.attempts = 0;
        task.summary = "已收到补充资料，等待核验。"; task.updated_at = now;
        await tx.put(key, task);
        return j({ code: 0, task: publicTask(task) });
      });
    }
    return j({ error: "Not found" }, 404);
  }
}
