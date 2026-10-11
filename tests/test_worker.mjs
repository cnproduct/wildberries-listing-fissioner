import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const coordinatorSource = await readFile(new URL("../cloudflare-worker/src/task-coordinator.js", import.meta.url), "utf8");
const coordinatorURL = "data:text/javascript;base64," + Buffer.from(coordinatorSource).toString("base64");
const { TaskCoordinator } = await import(coordinatorURL);
const source = (await readFile(new URL("../cloudflare-worker/src/index.js", import.meta.url), "utf8")).replace('"./task-coordinator.js"', JSON.stringify(coordinatorURL));
const { default: worker, resolveProduct, buildReply, handleFeishuEvent } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

class Storage {
  data = new Map();
  tail = Promise.resolve();
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, val) { this.data.set(key, structuredClone(val)); }
  async list({ prefix = "" } = {}) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).map(([k,v]) => [k, structuredClone(v)])); }
  transaction(fn) {
    const promise = this.tail.then(() => fn(this));
    this.tail = promise.catch(() => {});
    return promise;
  }
}
class KV {
  data = new Map();
  async get(key, type) { const v = this.data.get(key); return v ? type === "json" ? JSON.parse(v) : v : null; }
  async list({prefix} = {}) { return { keys: [...this.data.keys()].filter(k => k.startsWith(prefix)).map(name => ({name})), list_complete: true }; }
}
function fixture() {
  const storage = new Storage();
  const coordinator = new TaskCoordinator({ storage });
  const env = { FEISHU_APP_ID: "test_app", FEISHU_APP_SECRET: "dummy_secret", FEISHU_VERIFICATION_TOKEN: "dummy_verification",
    EXECUTOR_SECRET: "test_executor", WB_FISSION_KV: new KV(), TASK_COORDINATOR: {idFromName: x => x, get: () => coordinator } };
  const call = (path, data) => coordinator.fetch(new Request("https://coordinator" + path, data === undefined ? {} : {method:"POST", body:JSON.stringify(data)}));
  return {storage, env, call};
}
async function put(f, key="task:user:message") {
  return f.call("/put", {key, task: {sender_id:"user", task_id:key.split(":").at(-1), nmId:"1520898783"}});
}
const ctx = {waitUntil() {}};
const authRequest = (path,data) => new Request("https://example.test"+path,{...(data === undefined ? {} : {method:"POST",body:JSON.stringify(data)}), headers:{Authorization:"Bearer test_executor"}});
const request = body => new Request("https://example.test",{method:"POST",body:JSON.stringify(body)});

test("platform identifiers are distinct from seller SKU and barcode", () => {
  assert.equal(resolveProduct("1520898783").nmId,"1520898783");
  for (const x of ["SKU: 1520898783","barcode: 1520898783","https://wildberries.ru.evil.test/catalog/1520898783/detail.aspx"]) assert.equal(resolveProduct(x),null);
});
test("duplicate event creates one durable record and multiple requests survive", async () => {
  const f=fixture();
  await Promise.all([buildReply("1520898783","user","m1",f.env),buildReply("1520898783","user","m1",f.env)]);
  await buildReply("211832049","user","m2",f.env);
  assert.equal((await f.storage.list({prefix:"task:"})).size,2);
  assert.match(await buildReply("进度","user","q",f.env),/211832049/);
});
test("health reports actual heartbeat and generation capability", async () => {
  const f=fixture();
  let h=await (await worker.fetch(new Request("https://example.test/"),f.env,ctx)).json();
  assert.equal(h.executor_online,false); assert.equal(h.generation_enabled,false); assert.equal(h.publishing_enabled,false);
  await f.call("/heartbeat",{worker_id:"w",capabilities:{generation:true}});
  h=await (await worker.fetch(new Request("https://example.test/"),f.env,ctx)).json();
  assert.equal(h.executor_online,true); assert.equal(h.generation_enabled,true);
  await f.storage.put("executor:w",{last_seen:Date.now()-60000,capabilities:{generation:true}});
  h=await (await worker.fetch(new Request("https://example.test/"),f.env,ctx)).json();
  assert.equal(h.executor_online,false); assert.equal(h.generation_enabled,false);
});
test("two executors cannot claim one task", async () => {
  const f=fixture(); await put(f);
  const replies=await Promise.all([f.call("/claim",{key:"task:user:message",worker_id:"one"}),f.call("/claim",{key:"task:user:message",worker_id:"two"})]);
  assert.deepEqual(replies.map(x=>x.status).sort(),[200,409]);
});
test("expired lease requeues; exhausted retries terminate", async () => {
  const f=fixture(); await put(f);
  await f.call("/claim",{key:"task:user:message",worker_id:"one"});
  let task=await f.storage.get("task:user:message"); task.lease_expires_at=Date.now()-1000;
  await f.storage.put("task:user:message",task);
  const list=await (await f.call("/list?status=waiting_executor")).json(); assert.equal(list.count,1);
  task={...task,attempts:3};
  await f.storage.put("task:user:message",task);
  await f.call("/recover");
  assert.equal((await f.storage.get("task:user:message")).status,"failed");
});
test("stale ownership cannot update or renew a task", async () => {
  const f=fixture(); await put(f);
  const {task}=await (await f.call("/claim",{key:"task:user:message",worker_id:"one"})).json();
  assert.equal((await f.call("/update",{key:"task:user:message",worker_id:"two",lease_id:task.lease_id,status:"ready"})).status,409);
  assert.equal((await f.call("/heartbeat",{key:"task:user:message",worker_id:"two",lease_id:task.lease_id})).status,409);
});
test("ready requires reviewed artifacts and cannot mean published", async () => {
  const f=fixture(); await put(f);
  const {task}=await (await f.call("/claim",{key:"task:user:message",worker_id:"one"})).json();
  const identity={key:"task:user:message",worker_id:"one",lease_id:task.lease_id,status:"ready"};
  assert.equal((await f.call("/update",identity)).status,400);
  assert.equal((await f.call("/update",{...identity,details:{artifacts_verified:true,manifest_path:"manifest.json",published:true}})).status,400);
  assert.equal((await f.call("/update",{...identity,details:{artifacts_verified:true,manifest_path:"manifest.json",published:false}})).status,200);
  assert.match(await buildReply("进度","user","q",f.env),/尚未上架/);
});
test("supplemental facts merge and requeue needs-input task", async () => {
  const f=fixture(); await put(f);
  let t=await f.storage.get("task:user:message"); t.status="needs_input";t.facts={brand:"Confirmed"};await f.storage.put("task:user:message",t);
  await f.call("/input",{sender_id:"user",facts:{composition:"Steel"}});
  t=await f.storage.get("task:user:message");
  assert.equal(t.status,"waiting_executor"); assert.equal(t.facts.brand,"Confirmed");assert.equal(t.facts.composition,"Steel");
});
test("legacy ready status is not trusted and newest task pointer is preserved", async () => {
  const f=fixture();
  await f.call("/import",{tasks:[{key:"task:user:old",task_id:"old",timestamp:1,status:"ready",nmId:"1520898783"},
    {key:"task:user:new",task_id:"new",timestamp:2,status:"waiting_executor",nmId:"1520898783"}]});
  assert.equal((await f.storage.get("task:user:old")).status,"needs_input");
  assert.equal((await (await f.call("/latest?sender=user")).json()).task.task_id,"new");
});
test("compact JSON facts are accepted but cannot choose local files or other messages", async () => {
  const f=fixture();await put(f);
  const data={brand:"Confirmed",composition:"Steel",source_images:["/private/secret"],source_image_key:"other",source_image_message_id:"other"};
  const reply=await buildReply("资料:"+JSON.stringify(data),"user","input",f.env);
  assert.match(reply,/已保存/);
  const task=await f.storage.get("task:user:message");
  assert.equal(task.facts.brand,"Confirmed");assert.equal(task.facts.source_images,undefined);assert.equal(task.facts.source_image_key,undefined);
});
test("executor endpoints fail closed when secret missing or wrong", async () => {
  const f=fixture();
  assert.equal((await worker.fetch(new Request("https://example.test/api/tasks"),f.env,ctx)).status,401);
  delete f.env.EXECUTOR_SECRET;
  assert.equal((await worker.fetch(authRequest("/api/tasks"),f.env,ctx)).status,503);
});
test("verified executor route supports claim and owned update", async () => {
  const f=fixture();await put(f);
  const data=await (await worker.fetch(authRequest("/api/tasks"),f.env,ctx)).json();assert.equal(data.count,1);
  const {task}=await (await worker.fetch(authRequest("/api/tasks/claim",{key:"task:user:message",worker_id:"one"}),f.env,ctx)).json();
  const res=await worker.fetch(authRequest("/api/tasks/update",{key:"task:user:message",worker_id:"one",lease_id:task.lease_id,status:"needs_input",summary:"Missing real photo"}),f.env,ctx);
  assert.equal(res.status,200);assert.equal((await f.storage.get("task:user:message")).status,"needs_input");
});
test("webhook rejects invalid events and validates challenge before processing", async () => {
  const f=fixture();
  assert.equal((await worker.fetch(request({header:{token:"wrong"}}),f.env,ctx)).status,403);
  assert.equal((await worker.fetch(request({encrypt:"encrypted"}),f.env,ctx)).status,400);
  const r=await worker.fetch(request({type:"url_verification",token:"dummy_verification",challenge:"echo"}),f.env,ctx);
  assert.deepEqual(await r.json(),{challenge:"echo"});
});
test("tokens and shop credentials are saved and persisted to coordinator storage on demand", async () => {
  const f=fixture();
  const reply = await buildReply("店铺名：RR010\n仓库ID：2200772\nAPI令牌：dummy_token", "user", "m", f.env);
  assert.match(reply, /成功记录并落盘/);
  const creds = await f.storage.get("credentials:user");
  assert.equal(creds.shop_name, "RR010");
  assert.equal(creds.warehouse_id, "2200772");
  assert.equal(creds.api_token, "dummy_token");
});
test("mock Feishu reply contains actual receipt state", async () => {
  const f=fixture(); const calls=[];const saved=globalThis.fetch;
  globalThis.fetch=async (url,opt)=>{calls.push(JSON.parse(opt.body));return Response.json(url.includes("auth/")?{code:0,tenant_access_token:"test_access"}:{code:0});};
  try {
    await handleFeishuEvent({event:{sender:{sender_type:"user",sender_id:{open_id:"user"}},message:{message_type:"text",message_id:"m",chat_id:"chat",content:JSON.stringify({text:"1520898783"})}}},f.env);
    assert.match(JSON.parse(calls[1].content).text,/执行服务暂时离线/);
  } finally {globalThis.fetch=saved;}
});

 test("prose product reference selects one exact WB ID, ambiguous requests do not", () => {
   assert.equal(resolveProduct("原图参考WB 货号 1879785812的图片，然后生成不同场景").nmId,"1879785812");
   assert.equal(resolveProduct("货号1879785812和货号1520898783都做"),null);
 });
 test("retry requeues exact previous task while preserving conversation", async () => {
   const f=fixture(); await put(f);
   let t=await f.storage.get("task:user:message");t.status="needs_input";t.chat_id="original";await f.storage.put("task:user:message",t);
   const r=await worker.fetch(authRequest("/api/tasks/retry",{key:"task:user:message"}),f.env,ctx);
   assert.equal(r.status,200);t=await f.storage.get("task:user:message");
   assert.equal(t.mode,"creative");assert.equal(t.status,"waiting_executor");assert.equal(t.chat_id,"original");
   await f.call("/claim",{key:"task:user:message",worker_id:"w"});
   assert.equal((await f.call("/retry",{key:"task:user:message"})).status,409);
 });

 test("creative ready requires actual ten-scene delivery and archive receipt",async()=>{
   const f=fixture();await buildReply("1879785812","user","creative",f.env,"chat");
   const {task}=await (await f.call("/claim",{key:"task:user:creative",worker_id:"w"})).json();
   const base={key:"task:user:creative",worker_id:"w",lease_id:task.lease_id,status:"ready"};
   const details={artifacts_verified:true,manifest_path:"manifest.json",published:false};
   assert.equal((await f.call("/update",{...base,details})).status,400);
   assert.equal((await f.call("/update",{...base,details:{...details,delivery_verified:true,delivered_scenes:10,archive_message_id:"filemsg"}})).status,200);
 });
 test("WB resource proxy rejects foreign hosts and uses supported manual redirects",async()=>{
   const f=fixture();const saved=globalThis.fetch;let checked=false;
   globalThis.fetch=async(url,options)=>{assert.equal(options.redirect,"manual");checked=true;return new Response("source");};
   try{
     assert.equal((await worker.fetch(authRequest("/api/wb-resource?url="+encodeURIComponent("https://evil.test/private")),f.env,ctx)).status,400);
     const res=await worker.fetch(authRequest("/api/wb-resource?url="+encodeURIComponent("https://basket-52.wbbasket.ru/vol18797/part1879785/1879785812/info/ru/card.json")),f.env,ctx);
     assert.equal(res.status,200);assert.equal(await res.text(),"source");assert.equal(checked,true);
   }finally{globalThis.fetch=saved;}
 });

test('progress, supplementation and retry are isolated by conversation',async()=>{
 const f=fixture();
 await buildReply('1879785812','user','a',f.env,'chatA');
 await buildReply('1520898783','user','b',f.env,'chatB');
 assert.match(await buildReply('进度','user','q',f.env,'chatA'),/1879785812/);
 assert.doesNotMatch(await buildReply('进度','user','q',f.env,'chatC'),/1879785812|1520898783/);
 await buildReply('资料:{"brand":"Brand A"}','user','input',f.env,'chatA');
 assert.equal((await f.storage.get('task:user:a')).facts.brand,'Brand A');
 assert.equal((await f.storage.get('task:user:b')).facts,undefined);
 assert.equal((await f.call('/input',{sender_id:'other',chat_id:'chatA',facts:{brand:'wrong'}})).status,404);
});
test('legacy conversation pointers cannot leak into another conversation',async()=>{
 const f=fixture();await put(f);const t=await f.storage.get('task:user:message');t.chat_id='original';await f.storage.put('task:user:message',t);
 assert.equal((await (await f.call('/latest?sender=user&chat=other')).json()).task,null);
 assert.equal((await (await f.call('/latest?sender=user&chat=original')).json()).task.task_id,'message');
});
test('new and legacy task responses never contain seller tokens',async()=>{
 const f=fixture();await f.call('/credentials',{sender_id:'user',credentials:{api_token:'secret-test'}});await put(f);
 assert.equal((await f.storage.get('task:user:message')).credentials,undefined);
 const t=await f.storage.get('task:user:message');t.credentials={api_token:'legacy-secret'};await f.storage.put('task:user:message',t);
 for(const endpoint of ['/list','/latest?sender=user'])assert.doesNotMatch(await (await f.call(endpoint)).text(),/legacy-secret|api_token/);
 const claimed=await (await f.call('/claim',{key:'task:user:message',worker_id:'w'})).text();assert.doesNotMatch(claimed,/legacy-secret|api_token/);
});
test('credential read route is GET, rejects invalid fields, and never promises publication',async()=>{
 const f=fixture();
 const reply=await buildReply('API令牌: dummy','user','m',f.env,'chat');
 assert.match(reply,/尚未验证/);assert.doesNotMatch(reply,/自动关联此店铺凭据执行上架/);
 const response=await worker.fetch(authRequest('/api/credentials?sender=user'),f.env,ctx);
 assert.equal(response.status,200);assert.equal((await response.json()).credentials.api_token,'dummy');
 assert.equal((await f.call('/credentials',{sender_id:'user',credentials:{unknown:'x'}})).status,400);
});
test('source JSON is not parsed as a credential-binding command',async()=>{
 const f=fixture();await put(f);
 await buildReply('资料:{"source_description":"shop: marketing","source_verified":true}','user','i',f.env);
 assert.equal(await f.storage.get('credentials:user'),undefined);
 assert.equal((await f.storage.get('task:user:message')).facts.source_verified,undefined);
});
test('ambiguous URLs or URL plus conflicting product ID require clarification',()=>{
 assert.equal(resolveProduct('https://www.wildberries.ru/catalog/1879785812/detail.aspx https://www.wildberries.ru/catalog/1520898783/detail.aspx'),null);
 assert.equal(resolveProduct('https://www.wildberries.ru/catalog/1879785812/detail.aspx 货号1520898783'),null);
});
test('proxy strips seller authorization on public hosts and refuses redirects',async()=>{
 const f=fixture(),saved=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push(options);return new Response(null,{status:302,headers:{Location:'https://evil.test'}});};
 try{
  const req=new Request('https://example.test/api/wb-proxy?url='+encodeURIComponent('https://cdn.wbbasket.ru/api/v3/upstreams'),{headers:{Authorization:'Bearer test_executor','X-WB-Token':'seller-secret'}});
  assert.equal((await worker.fetch(req,f.env,ctx)).status,502);
  assert.equal(calls[0].headers.has('Authorization'),false);assert.equal(calls[0].redirect,'manual');
  assert.equal((await worker.fetch(authRequest('/api/wb-proxy?url='+encodeURIComponent('https://content-api.wildberries.ru:444/')),f.env,ctx)).status,403);
 }finally{globalThis.fetch=saved;}
});
test('stale lease heartbeat does not replace healthy executor capability',async()=>{
 const f=fixture();await put(f);const {task}=await(await f.call('/claim',{key:'task:user:message',worker_id:'good'})).json();
 await f.call('/heartbeat',{worker_id:'good',capabilities:{generation:true}});
 await f.call('/heartbeat',{worker_id:'bad',key:'task:user:message',lease_id:task.lease_id,capabilities:{generation:false}});
 assert.equal((await(await f.call('/health')).json()).capabilities.generation,true);
});
test('durable inbox claims once, retries on expiry and discards sensitive payload after completion',async()=>{
 const f=fixture(), payload={event:{message:{message_id:'m',content:'sensitive data'}}};
 await f.call('/events',{id:'m',payload});await f.call('/events',{id:'m',payload});
 assert.equal((await(await f.call('/events')).json()).events.length,1);
 const claims=await Promise.all([f.call('/events/claim',{id:'m'}),f.call('/events/claim',{id:'m'})]);
 assert.deepEqual(claims.map(x=>x.status).sort(),[200,409]);
 let entry=await f.storage.get('event:m');entry.expires_at=Date.now()-1;await f.storage.put('event:m',entry);
 const resumed=await(await f.call('/events/claim',{id:'m'})).json();
 await f.call('/events/done',{id:'m',lease:resumed.lease});
 assert.equal((await f.storage.get('event:m')).payload,undefined);
 assert.equal((await(await f.call('/events',{id:'m',payload})).json()).event,null);
});
test('replayed input cannot undo later facts or requeue completed tasks',async()=>{
 const f=fixture();await put(f);
 await f.call('/input',{sender_id:'user',message_id:'first',facts:{brand:'old'}});
 await f.call('/input',{sender_id:'user',message_id:'second',facts:{brand:'new'}});
 const t=await f.storage.get('task:user:message');t.status='ready';await f.storage.put('task:user:message',t);
 await f.call('/input',{sender_id:'user',message_id:'first',facts:{brand:'old'}});
 const after=await f.storage.get('task:user:message');assert.equal(after.status,'ready');assert.equal(after.facts.brand,'new');
});
test('multiple executors preserve available generation capability; receipt-only worker cannot claim',async()=>{
 const f=fixture();await put(f);
 await f.call('/heartbeat',{worker_id:'generator',capabilities:{generation:true}});
 await f.call('/heartbeat',{worker_id:'receipt-only',capabilities:{generation:false}});
 assert.equal((await(await f.call('/health')).json()).capabilities.generation,true);
 assert.equal((await f.call('/claim',{key:'task:user:message',worker_id:'receipt-only'})).status,409);
});
test('webhook persists event before acknowledgement and background processing',async()=>{
 const f=fixture();let pending;
 const body={header:{event_type:'im.message.receive_v1',token:'dummy_verification',app_id:'test_app'},event:{sender:{sender_type:'user',sender_id:{open_id:'user'}},message:{message_type:'text',message_id:'queued',chat_id:'chat',content:JSON.stringify({text:'1879785812'})}}};
 const saved=globalThis.fetch;globalThis.fetch=async()=>{throw Error('offline');};
 try{
  const response=await worker.fetch(request(body),f.env,{waitUntil(p){pending=p;}});
  assert.equal(response.status,200);assert.ok(await f.storage.get('event:queued'));
  await pending;assert.equal((await f.storage.get('task:user:queued')).nmId,'1879785812');
  assert.equal((await f.storage.get('event:queued')).done,undefined);
 }finally{globalThis.fetch=saved;}
});
test('recovery builds per-chat pointers for older conversations without selecting another chat',async()=>{
 const f=fixture();
 await f.storage.put('task:user:oldA',{sender_id:'user',chat_id:'a',task_id:'oldA',status:'ready',timestamp:1});
 await f.storage.put('task:user:oldB',{sender_id:'user',chat_id:'b',task_id:'oldB',status:'ready',timestamp:2});
 await f.storage.put('latest:user','task:user:oldB');await f.call('/recover');
 assert.equal((await(await f.call('/latest?sender=user&chat=a')).json()).task.task_id,'oldA');
 assert.equal((await(await f.call('/latest?sender=user&chat=b')).json()).task.task_id,'oldB');
});
test('authenticated task snapshots cannot be cached by intermediaries',async()=>{
 const f=fixture();await put(f);
 const response=await worker.fetch(authRequest('/api/tasks'),f.env,ctx);
 assert.match(response.headers.get('Cache-Control'),/no-store/);
 assert.equal(response.headers.get('Vary'),'Authorization');
});
