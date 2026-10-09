import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// No package.json is required by Wrangler; load Worker ESM from a data URL.
const source = await readFile(new URL("../cloudflare-worker/src/index.js", import.meta.url), "utf8");
const { default: worker, resolveProduct, buildReply, handleFeishuEvent } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
class KV {
  data = new Map();
  async get(key, type) { const value = this.data.get(key); return value ? (type === "json" ? JSON.parse(value) : value) : null; }
  async put(key, value) { this.data.set(key, value); }
  async list({ prefix } = {}) {
    const keys = [];
    for (const k of this.data.keys()) {
      if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
    }
    return { keys, list_complete: true };
  }
}
const envForTest = () => ({ FEISHU_APP_ID: "test_app", FEISHU_APP_SECRET: "dummy_secret", FEISHU_VERIFICATION_TOKEN: "dummy_verification", EXECUTOR_SECRET: "test_executor_secret", WB_FISSION_KV: new KV() });
const request = body => new Request("https://example.test", { method: "POST", body: JSON.stringify(body) });

test("only WB platform IDs and exact hosts resolve", () => {
  assert.equal(resolveProduct("211832049").nmId, "211832049");
  assert.equal(resolveProduct("货号: 211832049").nmId, "211832049");
  assert.equal(resolveProduct("https://www.wildberries.ru/catalog/211832049/detail.aspx").nmId, "211832049");
  for (const text of ["SKU: 211832049", "barcode: 211832049", "https://wildberries.ru.evil.test/catalog/211832049/detail.aspx", "https://wildberries.ru/catalog/not-a-number/detail.aspx"]) assert.equal(resolveProduct(text), null);
});
test("distinct requests survive and serial delivery retry reuses the record", async () => {
  const env = envForTest();
  await buildReply("211832049", "user", "message1", env);
  await buildReply("311832049", "user", "message2", env);
  await buildReply("211832049", "user", "message1", env);
  assert.equal([...env.WB_FISSION_KV.data.keys()].filter(k => k.startsWith("task:")).length, 2);
  assert.equal((await env.WB_FISSION_KV.get("task:user:message1", "json")).status, "waiting_executor");
  const progress = await buildReply("进度", "user", "query", env);
  assert.match(progress, /311832049/);
  assert.match(progress, /尚未接通/);
});
test("elapsed time never changes receipt into generated or published", async () => {
  const env = envForTest();
  await buildReply("211832049", "user", "message", env);
  const task = await env.WB_FISSION_KV.get("task:user:message", "json");
  task.timestamp = Date.now() - 24 * 3600 * 1000;
  await env.WB_FISSION_KV.put("task:user:message", JSON.stringify(task));
  assert.match(await buildReply("进度", "user", "query", env), /待执行/);
  assert.equal((await env.WB_FISSION_KV.get("task:user:message", "json")).status, "waiting_executor");
});
test("empty and legacy progress records are explicit", async () => {
  const env = envForTest();
  assert.match(await buildReply("进度", "user", "query", env), /尚未找到/);
  await env.WB_FISSION_KV.put("latest_task:user", JSON.stringify({ status: "processing" }));
  assert.match(await buildReply("进度", "user", "query", env), /没有可验证的执行结果/);
});
test("chat tokens are not stored or advertised as authorized", async () => {
  const env = envForTest();
  assert.match(await buildReply("绑定API: dummy_token", "user", "message", env), /没有保存令牌/);
  assert.equal(env.WB_FISSION_KV.data.size, 0);
});
test("unverified webhook requests fail before scheduling work", async () => {
  let scheduled = false;
  const ctx = { waitUntil() { scheduled = true; } };
  const env = envForTest();
  assert.equal((await worker.fetch(request({ header: { token: "wrong" } }), env, ctx)).status, 403);
  assert.equal((await worker.fetch(request({ type: "url_verification", token: "dummy_verification", challenge: "challenge" }), {}, ctx)).status, 503);
  assert.equal((await worker.fetch(request({ encrypt: "encrypted" }), env, ctx)).status, 400);
  assert.equal(scheduled, false);
});
test("verified challenge echoes and wrong application fails", async () => {
  const env = envForTest();
  const ctx = { waitUntil() { throw new Error("must not schedule"); } };
  const challenge = await worker.fetch(request({ type: "url_verification", token: "dummy_verification", challenge: "echo" }), env, ctx);
  assert.deepEqual(await challenge.json(), { challenge: "echo" });
  const response = await worker.fetch(request({ header: { token: "dummy_verification", event_type: "im.message.receive_v1", app_id: "other_app" } }), env, ctx);
  assert.equal(response.status, 403);
});
test("mock Feishu delivery reports only a receipt and checks fallback result", async () => {
  const env = envForTest();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return Response.json(url.includes("auth/v3") ? { code: 0, tenant_access_token: "dummy_access" } : { code: 0 });
  };
  try {
    await handleFeishuEvent({ event: { sender: { sender_type: "user", sender_id: { open_id: "user" } }, message: { message_type: "text", message_id: "message", chat_id: "chat", content: JSON.stringify({ text: "211832049" }) } } }, env);
    assert.equal(calls.length, 2);
    assert.match(JSON.parse(calls[1].body.content).text, /待执行/);
    globalThis.fetch = async url => Response.json(url.includes("auth/v3") ? { code: 0, tenant_access_token: "dummy_access" } : { code: 999 });
    await assert.rejects(handleFeishuEvent({ event: { sender: { sender_type: "user", sender_id: { open_id: "user" } }, message: { message_type: "text", message_id: "message", chat_id: "chat", content: JSON.stringify({ text: "进度" }) } } }, env), /delivery failed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("executor API requires auth, lists tasks, and updates task state", async () => {
  const env = envForTest();
  const ctx = { waitUntil() {} };
  
  // 1. Unauthorized access fails
  const unauthResp = await worker.fetch(new Request("https://example.test/api/tasks"), env, ctx);
  assert.equal(unauthResp.status, 401);

  // 2. Put a pending task into KV
  await env.WB_FISSION_KV.put("task:user1:msg1", JSON.stringify({
    task_id: "msg1",
    nmId: "211832049",
    status: "waiting_executor"
  }));

  // 3. Authorized GET lists the task
  const authHeaders = { Authorization: "Bearer test_executor_secret" };
  const listResp = await worker.fetch(new Request("https://example.test/api/tasks?status=waiting_executor", { headers: authHeaders }), env, ctx);
  assert.equal(listResp.status, 200);
  const listData = await listResp.json();
  assert.equal(listData.count, 1);
  assert.equal(listData.tasks[0].nmId, "211832049");

  // 4. Update task status to processing
  const updateReq = new Request("https://example.test/api/tasks/update", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      key: "task:user1:msg1",
      status: "processing",
      summary: "正在生成 10 套素材"
    })
  });
  const updateResp = await worker.fetch(updateReq, env, ctx);
  assert.equal(updateResp.status, 200);

  // 5. Verify KV state has updated
  const updatedTask = await env.WB_FISSION_KV.get("task:user1:msg1", "json");
  assert.equal(updatedTask.status, "processing");
  assert.equal(updatedTask.summary, "正在生成 10 套素材");
});
