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
const j = (data, status = 200) => Response.json(data, { status, headers:{"Cache-Control":"private, no-store, max-age=0","Vary":"Authorization","X-WB-Coordinator-Version":"2026-10-14-upload-first"} });
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
      if(task.publication?.state==='checking' && task.publication.lease_expires_at<=now){
        Object.assign(task.publication,{state:'failed',summary:'发布核验或执行中断；需检查已保存的发布断点，避免重复建卡。'});
        delete task.publication.worker_id;delete task.publication.lease_id;delete task.publication.lease_expires_at;
        await tx.put(key,task);
      }
      if (task.credentials) {delete task.credentials;await tx.put(key,task);}
      if (task.sender_id && task.chat_id) {
        const pointerKey=latestKey(task.sender_id,task.chat_id);
        const pointer=await tx.get(pointerKey), previous=pointer ? await tx.get(pointer) : null;
        if (!previous || (task.timestamp || 0) > (previous.timestamp || 0)) await tx.put(pointerKey,key);
      }
      if (ACTIVE.has(task.status) && (!task.lease_expires_at || task.lease_expires_at <= now)) {
        task.status = (task.attempts || 0) >= MAX_ATTEMPTS ? "failed" : "waiting_executor";
        task.summary = task.status === "failed" ? "执行多次中断，已停止重试，请检查执行服务。" : "上次执行中断，请求已恢复到待处理队列。";
        if (task.status === 'failed') task.details = {...task.details, reason_code:'lease_expired',published:false};
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
      capabilities.publishing = active.some(e=>e.capabilities?.publishing);
      const tasks = await this.storage.list({ prefix: "task:" });
      const counts = {};
      for (const task of tasks.values()) counts[task.status] = (counts[task.status] || 0) + 1;
      const inbox = [...(await this.storage.list({prefix:'event:'})).values()];
      const activeExecutors = active.map(e => ({ worker_id: e.worker_id, store: e.store || null, last_seen: e.last_seen }));
      return j({ version:"2026-10-14-upload-first", event_failures:inbox.filter(e=>e.failed).length, pending_events:inbox.filter(e=>!e.done && !e.failed).length, online, last_seen: executor?.last_seen || null, active_executors: activeExecutors, capabilities: online ? capabilities : {}, counts });
    }
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (typeof body.worker_id !== "string" || !body.worker_id) return j({ error: "worker_id required" }, 400);
      if (body.key && body.lease_id) {
        return this.storage.transaction(async tx => {
          const task = await tx.get(body.key);
          if (!task || !ACTIVE.has(task.status) || task.lease_id !== body.lease_id || task.worker_id !== body.worker_id || task.lease_expires_at <= now) return j({ error: "Lease lost" }, 409);
          await tx.put("executor:" + body.worker_id, { worker_id: body.worker_id, store: body.store || null, last_seen: now, capabilities: body.capabilities || {} });
          task.lease_expires_at = now + LEASE_MS;
          await tx.put(body.key, task);
          return j({ code: 0 });
        });
      }
      await this.storage.put("executor:" + body.worker_id, { worker_id: body.worker_id, store: body.store || null, last_seen: now, capabilities: body.capabilities || {} });
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
      if (updated.shop_name) {
        await this.storage.put("store_credentials:" + updated.shop_name.toUpperCase(), updated);
      }
      return j({ code: 0, credentials: { shop_name: updated.shop_name, warehouse_id: updated.warehouse_id, has_api_token: !!updated.api_token } });
    }
    if (url.pathname === "/credentials" && request.method === "GET") {
      const sender = url.searchParams.get("sender");
      const storeParam = url.searchParams.get("store");
      let creds = null;
      if (storeParam) creds = await this.storage.get("store_credentials:" + storeParam.toUpperCase());
      if (!creds && sender) creds = await this.storage.get("credentials:" + sender);
      return j({ credentials: creds || null });
    }
    if (url.pathname === "/put" && request.method === "POST") {
      if (!body.key?.startsWith("task:") || !body.task?.task_id || !body.task?.sender_id) return j({ error: "Invalid task" }, 400);
      return this.storage.transaction(async tx => {
        const prior = await tx.get(body.key);
        if (prior) return j({ task: publicTask(prior), created: false });
        const task = { ...body.task, status: "waiting_executor", timestamp: now, attempts: 0 };
        delete task.credentials;
        if (task.target_store) task.target_store = String(task.target_store).toUpperCase();
        await tx.put(body.key, task);
        await tx.put(latestKey(task.sender_id, task.chat_id), body.key);
        return j({ task: publicTask(task), created: true });
      });
    }
    if (url.pathname === '/restore-failure' && request.method === 'POST') {
      // Maintenance reconstruction from verified original Feishu message, never enqueue.
      const t=body.task || {};
      if (!/^ou_[A-Za-z0-9]+$/.test(t.sender_id || '') || !/^oc_[A-Za-z0-9]+$/.test(t.chat_id || '') ||
          !/^om_[A-Za-z0-9]+$/.test(t.task_id || '') || !/^[0-9]{6,13}$/.test(t.nmId || '') ||
          !Number.isSafeInteger(t.timestamp) || t.timestamp<=0 || t.timestamp>now) return j({error:'Invalid historical identity'},400);
      const key='task:'+encodeURIComponent(t.sender_id)+':'+encodeURIComponent(t.task_id);
      return this.storage.transaction(async tx=>{
        if (await tx.get(key)) return j({error:'Existing task must not be replaced'},409);
        const restored={task_id:t.task_id,sender_id:t.sender_id,chat_id:t.chat_id,nmId:t.nmId,timestamp:t.timestamp,
          mode:'creative',status:'failed',attempts:0,updated_at:now,restored_at:now,
          summary:'历史失败记录已按原消息恢复；尚未重新执行。',details:{reason_code:'unknown_failure',published:false}};
        await tx.put(key,restored);
        const pointer=latestKey(t.sender_id,t.chat_id), priorKey=await tx.get(pointer),prior=priorKey?await tx.get(priorKey):null;
        if (!prior || prior.timestamp<t.timestamp) await tx.put(pointer,key);
        return j({code:0});
      });
    }
    if (url.pathname === '/diagnostic' && request.method === 'POST') {
      // Authenticated maintenance may annotate a terminal failure; never change
      // task ownership, status, customer identity or trigger any message.
      const allowed=['image_quality_failed','generation_timeout','generation_service_unavailable','generation_auth_failed','executor_auth_failed','connection_failed','product_validation_failed','scene_plan_invalid','generation_response_invalid','generator_not_configured','generation_failed','generation_model_unavailable','lease_expired','unknown_failure'];
      const d=body.details || {};
      if (!allowed.includes(d.reason_code)) return j({error:'Invalid diagnostic'},400);
      const clean={reason_code:d.reason_code,published:false};
      if (d.stage!==undefined) {
        if (!['processing','source_analysis','scene_plan','image_review','generating_text','generating_images'].includes(d.stage)) return j({error:'Invalid diagnostic stage'},400);
        clean.stage=d.stage;
      }
      for (const k of ['completed','failed_image','image_attempts','total']) {
        if (d[k]!==undefined) {
          if (!Number.isInteger(d[k]) || d[k]<0 || d[k]>10) return j({error:'Invalid diagnostic count'},400);
          clean[k]=d[k];
        }
      }
      if (d.issue_codes!==undefined) {
        if (!Array.isArray(d.issue_codes) || d.issue_codes.some(x=>!['camera_angle','label_distortion','extra_product','missing_packaging','composition_mismatch'].includes(x))) return j({error:'Invalid issue code'},400);
        clean.issue_codes=[...new Set(d.issue_codes)];
      }
      return this.storage.transaction(async tx=>{
        const task=await tx.get(body.key);
        if (!task || task.status!=='failed') return j({error:'Only failed tasks can be annotated'},409);
        task.details={...task.details,...clean};task.diagnostic_updated_at=now;
        await tx.put(body.key,task);return j({code:0});
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
      const sender = url.searchParams.get("sender");
      const chat = url.searchParams.get("chat");
      const nmId = url.searchParams.get("nmid");
      let latest = await latestInChat(this.storage, sender, chat);
      if (nmId && (!latest.task || latest.task.nmId !== nmId)) {
        const tasks = await this.storage.list({ prefix: "task:" + (sender ? encodeURIComponent(sender) + ":" : "") });
        const matches = [...tasks.entries()].filter(([, t]) => t && t.nmId === nmId && (!chat || t.chat_id === chat));
        if (matches.length) {
          matches.sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
          const chosen = matches[0];
          latest = { key: chosen[0], task: chosen[1] };
        } else latest = {key:null,task:null};
      }
      return j({ key: latest.key, task: publicTask(latest.task) });
    }
    if (url.pathname === "/task" && request.method === "GET") {
      const key = url.searchParams.get("key");
      const sender = url.searchParams.get("sender");
      const taskId = url.searchParams.get("task_id");
      const taskKey = key || (sender && taskId ? "task:" + encodeURIComponent(sender) + ":" + encodeURIComponent(taskId) : null);
      if (!taskKey) return j({ error: "key or sender+task_id required" }, 400);
      const task = await this.storage.get(taskKey);
      const chat = url.searchParams.get("chat");
      const allowed = task && (!sender || task.sender_id === sender) && (!chat || task.chat_id === chat);
      return j({ key: allowed ? taskKey : null, task: allowed ? publicTask(task) : null });
    }
    if (url.pathname === "/task" && request.method === "DELETE") {
      return j({error:"Task history must be retained; deletion is disabled"},409);
    }

    if (url.pathname === "/list" || url.pathname === "/recover") {
      return this.storage.transaction(async tx => {
        await this.recover(tx, now);
        const entries = await tx.list({ prefix: "task:" });
        const filter = url.searchParams.get("status");
        const storeFilter = url.searchParams.get("store");
        const tasks = [...entries].filter(([, t]) => {
          if (filter && t.status !== filter) return false;
          if (storeFilter && t.target_store && t.target_store.toUpperCase() !== storeFilter.toUpperCase()) return false;
          return true;
        }).map(([key, t]) => ({ ...publicTask(t), key }));
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
        if (task.target_store && body.store && task.target_store.toUpperCase() !== body.store.toUpperCase()) {
          return j({ error: "Task target store mismatch" }, 409);
        }
        task.status = "validating"; task.worker_id = body.worker_id;
        if (body.store) task.claimed_by_store = body.store.toUpperCase();
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
        if (body.status === "ready" && task.mode === "creative" && (!body.details?.delivery_verified || ![5, 10].includes(body.details?.delivered_scenes) || !body.details?.archive_message_id)) {
          return j({error:"Five scene deliveries and archive receipt required"},400);
        }
        task.status = body.status; task.summary = body.summary || task.summary;
        task.details = body.details || {}; task.updated_at = now;
        if (ACTIVE.has(task.status)) task.lease_expires_at = now + LEASE_MS;
        else { delete task.lease_id; delete task.lease_expires_at; delete task.worker_id; }
        await tx.put(body.key, task);
        return j({ code: 0, task: publicTask(task) });
      });
    }
    if (url.pathname === "/publication" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        const key=body.key || "task:"+encodeURIComponent(body.sender_id || "")+":"+encodeURIComponent(body.task_id || "");
        const task=await tx.get(key);
        if(!key.startsWith('task:') || !task || task.sender_id!==body.sender_id || task.task_id!==body.task_id || !body.chat_id || task.chat_id!==body.chat_id) return j({error:"No task in this conversation"},404);
        const creds=await tx.get("credentials:"+body.sender_id);
        const store=String(body.store || '').toUpperCase();
        if(!store || store!==creds?.shop_name?.toUpperCase()) return j({error:"Store binding mismatch"},409);
        if(task.status!=="ready" || !task.details?.delivery_verified || ![5, 10].includes(task.details?.delivered_scenes) || !task.details?.archive_message_id) return j({error:"Verified creative delivery required"},409);
        if(task.publication && task.publication.store!==store) return j({error:"Publication already bound to another store"},409);
        if(!task.publication){
          task.publication={state:"requested",store,requested_at:now,authorized_by:body.sender_id,
            request_message_id:body.message_id || null,published:false,
            missing_fields:["store_authorization","complete_gallery","verified_package_specs"],
            summary:"已保存上架指令；核实目标账户和建卡必需资料后优先上传，图片精修与定价库存随后完善。"};
          await tx.put(key,task);
        } else if(body.message_id && body.message_id!==task.publication.request_message_id && ['needs_input','failed'].includes(task.publication.state)){
          task.publication.state='requested';task.publication.request_message_id=body.message_id;task.publication.summary='已收到继续上架指令，正在重新核验本批发布资料。';
          await tx.put(key,task);
        }
        return j({key,publication:task.publication});
      });
    }
    if (url.pathname === "/publication/claim" && request.method === "POST") {
      return this.storage.transaction(async tx=>{
        const task=await tx.get(body.key),p=task?.publication;
        if(!p || p.state!=="requested" || p.resume_at>now || !body.worker_id || body.store && body.store!==p.store) return j({error:"Publication unavailable"},409);
        p.state="checking";p.worker_id=body.worker_id;p.lease_id=crypto.randomUUID();p.lease_expires_at=now+LEASE_MS;
        await tx.put(body.key,task);return j({task:publicTask(task),publication:p});
      });
    }
    if (url.pathname === "/publication/update" && request.method === "POST") {
      return this.storage.transaction(async tx=>{
        const task=await tx.get(body.key),p=task?.publication;
        if(!p || p.worker_id!==body.worker_id || p.lease_id!==body.lease_id || p.lease_expires_at<=now || !['requested','checking','needs_input','submitted','failed'].includes(body.state)) return j({error:"Publication lease lost or invalid state"},409);
        if(typeof body.summary!=='string' || body.summary.length>1500) return j({error:'Summary required'},400);
        if(body.upload_verified===true && (!Array.isArray(body.nm_ids) || ![5, 10].includes(body.nm_ids.length) || new Set(body.nm_ids).size!==body.nm_ids.length || body.nm_ids.some(x=>!Number.isSafeInteger(x)||x<=0) || body.card_media_readback_verified!==true)) return j({error:'Upload readback receipts required'},400);
        if(body.pending_improvements!==undefined && (!Array.isArray(body.pending_improvements) || body.pending_improvements.length>10 || body.pending_improvements.some(x=>typeof x!=='string'||x.length>200))) return j({error:'Bounded improvement items required'},400);
        if(body.state==='submitted' && (!Array.isArray(body.nm_ids) || ![5, 10].includes(body.nm_ids.length) || new Set(body.nm_ids).size!==body.nm_ids.length || body.nm_ids.some(x=>!Number.isSafeInteger(x)||x<=0) || body.media_verified!==true || body.price_verified!==true || body.stock_verified!==true)) return j({error:'Publication receipts required'},400);
        p.state=body.state;p.summary=body.summary;p.checked_at=now;
        if(body.upload_verified===true) Object.assign(p,{upload_verified:true,card_media_readback_verified:true,nm_ids:body.nm_ids,uploaded_at:p.uploaded_at||now});
        if(body.pending_improvements!==undefined) p.pending_improvements=body.pending_improvements;
        if(body.state==='requested'){
          if(!Number.isSafeInteger(body.resume_at) || body.resume_at<=now || body.resume_at>now+3600000) return j({error:'Bounded synchronization time required'},400);
          p.resume_at=body.resume_at;
        }
        if(body.state==='submitted'){Object.assign(p,{nm_ids:body.nm_ids,media_verified:true,price_verified:true,stock_verified:true,storefront_verified:false});delete p.missing_fields;}
        if(body.state==='checking') p.lease_expires_at=now+LEASE_MS;
        else {delete p.worker_id;delete p.lease_id;delete p.lease_expires_at;}
        await tx.put(body.key,task);return j({publication:p});
      });
    }
    if (url.pathname === "/publication/preflight" && request.method === "POST") {
      const allowed=["complete_gallery","verified_package_specs","visual_review","verified_price","publisher_not_configured","brand","category_attributes","store_authorization"];
      if(!Array.isArray(body.missing_fields) || body.missing_fields.some(x=>!allowed.includes(x)) || !body.missing_fields.length || typeof body.summary!=="string" || body.summary.length>1500) return j({error:"Bounded missing fields and summary required"},400);
      return this.storage.transaction(async tx=>{
        const task=await tx.get(body.key);
        if(!task?.publication || task.publication.store!==body.store || task.publication.published || ['checking','submitted'].includes(task.publication.state)) return j({error:"No matching pending publication"},409);
        task.publication={...task.publication,state:"needs_input",missing_fields:[...new Set(body.missing_fields)],summary:body.summary,checked_at:now};
        await tx.put(body.key,task);return j({publication:task.publication});
      });
    }
    if (url.pathname === "/retry" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        const task = await tx.get(body.key);
        if (!task) return j({ error:"No task" },404);
        if (body.message_id && await tx.get('mutation:retry:'+body.message_id)) return j({code:0,task:publicTask(task)});
        if (task.status === "ready") return j({error:"Already delivered; retry would duplicate delivery"},409);
        if (ACTIVE.has(task.status)) return j({ error:"Task is processing" },409);
        if (body.message_id) await tx.put('mutation:retry:'+body.message_id,{key:body.key});
        task.status="waiting_executor"; task.attempts=0; task.mode="creative";
        task.summary="正在重新获取原商品，制作5套场景图文。"; task.updated_at=now;
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
