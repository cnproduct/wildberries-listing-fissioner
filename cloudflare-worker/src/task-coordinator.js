/**
 * Transactional task ownership and executor heartbeat.
 * One coordinator handles this small queue; KV is only a legacy migration source.
 */
const ACTIVE = new Set(["processing", "validating", "generating_text", "generating_images", "reviewing"]);
const STATES = new Set(["waiting_executor", ...ACTIVE, "needs_input", "ready", "failed", "cancelled", "awaiting_delivery"]);
const LEASE_MS = 180000;
const MAX_ATTEMPTS = 3;
const j = (data, status = 200) => Response.json(data, { status });

export class TaskCoordinator {
  constructor(ctx) { this.storage = ctx.storage; }

  async recover(tx, now) {
    const tasks = await tx.list({ prefix: "task:" });
    for (const [key, task] of tasks) {
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
    if (url.pathname === "/health") {
      const executor = await this.storage.get("executor");
      const online = !!executor && now - executor.last_seen < 45000;
      const tasks = await this.storage.list({ prefix: "task:" });
      const counts = {};
      for (const task of tasks.values()) counts[task.status] = (counts[task.status] || 0) + 1;
      return j({ online, last_seen: executor?.last_seen || null, capabilities: online ? executor.capabilities || {} : {}, counts });
    }
    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (typeof body.worker_id !== "string" || !body.worker_id) return j({ error: "worker_id required" }, 400);
      await this.storage.put("executor", { worker_id: body.worker_id, last_seen: now, capabilities: body.capabilities || {} });
      if (body.key && body.lease_id) {
        return this.storage.transaction(async tx => {
          const task = await tx.get(body.key);
          if (!task || !ACTIVE.has(task.status) || task.lease_id !== body.lease_id || task.worker_id !== body.worker_id || task.lease_expires_at <= now) return j({ error: "Lease lost" }, 409);
          task.lease_expires_at = now + LEASE_MS;
          await tx.put(body.key, task);
          return j({ code: 0 });
        });
      }
      return j({ code: 0 });
    }
    if (url.pathname === "/credentials" && request.method === "POST") {
      if (!body.sender_id) return j({ error: "sender_id required" }, 400);
      const key = "credentials:" + body.sender_id;
      const existing = (await this.storage.get(key)) || {};
      const updated = { ...existing, ...body.credentials, updated_at: now };
      await this.storage.put(key, updated);
      return j({ code: 0, credentials: { ...updated, api_token: updated.api_token ? true : false } });
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
        if (prior) return j({ task: prior, created: false });
        const creds = await tx.get("credentials:" + body.task.sender_id);
        const task = { ...body.task, credentials: creds || null, status: "waiting_executor", timestamp: now, attempts: 0 };
        await tx.put(body.key, task);
        await tx.put("latest:" + task.sender_id, body.key);
        return j({ task, created: true });
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
          delete updated.key; delete updated.lease_id; delete updated.lease_expires_at;
          await tx.put(key, updated);
          const latestKey = await tx.get("latest:" + senderId);
          const latest = latestKey ? await tx.get(latestKey) : null;
          if (!latest || updated.timestamp >= latest.timestamp) await tx.put("latest:" + senderId, key);
          count++;
        }
        return j({ code: 0, imported: count });
      });
    }
    if (url.pathname === "/latest") {
      const key = await this.storage.get("latest:" + url.searchParams.get("sender"));
      return j({ key: key || null, task: key ? await this.storage.get(key) || null : null });
    }
    if (url.pathname === "/list" || url.pathname === "/recover") {
      return this.storage.transaction(async tx => {
        await this.recover(tx, now);
        const entries = await tx.list({ prefix: "task:" });
        const filter = url.searchParams.get("status");
        const tasks = [...entries].filter(([, t]) => !filter || t.status === filter).map(([key, t]) => ({ ...t, key }));
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
        task.status = "validating"; task.worker_id = body.worker_id;
        task.lease_id = crypto.randomUUID(); task.lease_expires_at = now + LEASE_MS;
        task.attempts = (task.attempts || 0) + 1; task.updated_at = now;
        task.summary = "正在获取原商品资料并核验，尚未生成或发布。";
        await tx.put(body.key, task);
        return j({ code: 0, task: { ...task, key: body.key } });
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
        return j({ code: 0, task });
      });
    }
    if (url.pathname === "/retry" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        const task = await tx.get(body.key);
        if (!task) return j({ error:"No task" },404);
        if (ACTIVE.has(task.status)) return j({ error:"Task is processing" },409);
        task.status="waiting_executor"; task.attempts=0; task.mode="creative";
        task.summary="正在重新获取原商品，制作10套场景图文。"; task.updated_at=now;
        task.details={};
        await tx.put(body.key,task);
        return j({code:0,task});
      });
    }
    if (url.pathname === "/input" && request.method === "POST") {
      return this.storage.transaction(async tx => {
        const key = await tx.get("latest:" + body.sender_id);
        const task = key ? await tx.get(key) : null;
        if (!task) return j({ error: "No task" }, 404);
        if (ACTIVE.has(task.status)) return j({ error: "Task is processing" }, 409);
        if (!body.facts || typeof body.facts !== "object" || Array.isArray(body.facts)) return j({ error: "Invalid facts" }, 400);
        task.facts = { ...(task.facts || {}), ...body.facts }; task.status = "waiting_executor"; task.attempts = 0;
        task.summary = "已收到补充资料，等待核验。"; task.updated_at = now;
        await tx.put(key, task);
        return j({ code: 0, task });
      });
    }
    return j({ error: "Not found" }, 404);
  }
}
