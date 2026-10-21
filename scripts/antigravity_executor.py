#!/usr/bin/env python3
"""Persistent, leased WB task executor. Never substitute a demo product or picture."""
import argparse
import hashlib
import json
import logging
import os
import shlex
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
from scripts.creative_bundle import build_creative_bundle
from scripts.feishu_delivery import FeishuDelivery, DeliveryError
from scripts.wb_source import acquire_source
from scripts.failure_diagnostics import failure_details, failure_summary
from scripts.publication_executor import execute_publication

try:
    from .runtime_files import write_json, read_cache
    from .creative_bundle import validate_bundle
except ImportError:
    from runtime_files import write_json, read_cache
    from creative_bundle import validate_bundle

logger = logging.getLogger("wb-executor")
CONFIG_PATH = Path.home() / ".config/wb-fission/executor.json"


class GatewayError(RuntimeError):
    pass


def load_config(path=CONFIG_PATH):
    config = json.loads(Path(path).read_text()) if Path(path).exists() else {}
    for key in ("GATEWAY_URL", "EXECUTOR_SECRET", "OUTPUT_ROOT", "FACTS_ROOT", "FISSION_GENERATOR_CMD", "STORE_NAME", "WB_STORE"):
        if os.environ.get(key):
            config[key] = os.environ[key]
    if os.environ.get("WB_STORE"):
        config["STORE_NAME"] = os.environ["WB_STORE"]
    config.setdefault("GATEWAY_URL", "https://wb-bot.diytale.com")
    if not config.get("EXECUTOR_SECRET"):
        raise GatewayError("EXECUTOR_SECRET must be configured outside source code")
    return config


def request_json(url, method="GET", data=None, headers=None, timeout=15, opener=None):
    payload = json.dumps(data, ensure_ascii=False).encode() if data is not None else None
    headers = dict(headers or {})
    headers.update({"Content-Type": "application/json", "User-Agent": "WB-Fission/2.0"})
    req = urllib.request.Request(url, method=method, data=payload, headers=headers)
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise GatewayError(f"HTTP {exc.code}") from None
    except (OSError, ValueError) as exc:
        raise GatewayError(type(exc).__name__) from None


class Gateway:
    def __init__(self, config):
        self.url = config["GATEWAY_URL"].rstrip("/")
        self.secret = config["EXECUTOR_SECRET"]
        # Local system proxies have returned stale task snapshots after deployment.
        # Keep the task-control connection direct; native generation may still use its proxy.
        self.open = None if config.get('GATEWAY_USE_SYSTEM_PROXY') is True else urllib.request.build_opener(urllib.request.ProxyHandler({})).open

    def call(self, path, data=None):
        return request_json(self.url + path, "POST" if data is not None else "GET",
                            data, {"Authorization": "Bearer " + self.secret}, timeout=30 if path == "/api/source" else 15, opener=self.open)


class LeaseSession:
    """Recover transient transport failures only inside acknowledged ownership.

    A timeout is not an ownership rejection. Never extend the local deadline
    without a successful server response, and stop before the server's expiry.
    """
    def __init__(self, gateway, claimed):
        self.gateway = gateway
        self.lost = threading.Event()
        self.lock = threading.Lock()
        expires = claimed.get('lease_expires_at')
        remaining = max(0, expires / 1000 - time.time()) if expires else 180
        self.deadline = time.monotonic() + remaining - 10

    def ensure_owned(self):
        with self.lock:
            expired = time.monotonic() >= self.deadline
        if expired:
            self.lost.set()
        if self.lost.is_set():
            raise GatewayError('Lease lost; stop processing this task')

    def call(self, path, data):
        while True:
            self.ensure_owned()
            started = time.monotonic()
            with self.lock:
                remaining = self.deadline - started
            # The transport has a 15-second timeout. Do not start another
            # attempt close to expiry, where another worker may take ownership.
            if remaining <= 20:
                self.lost.set()
                raise GatewayError('Lease renewal could not be confirmed before expiry')
            try:
                response = self.gateway.call(path, data)
            except GatewayError as exc:
                message = str(exc)
                permanent = message.startswith('HTTP 4') and message not in ('HTTP 408', 'HTTP 429')
                if permanent or 'Lease lost' in message:
                    self.lost.set()
                    raise
                logger.warning('Temporary gateway failure; retrying within the acknowledged lease (%s)', message)
                time.sleep(3)
                continue
            # Heartbeat and active-state update both renew the server lease.
            # Count from request start so response latency cannot overestimate it.
            if path == '/api/executor/heartbeat' or data.get('status') in (
                    'validating', 'generating_text', 'generating_images', 'reviewing'):
                with self.lock:
                    self.deadline = max(self.deadline, started + 170)
            return response


def fetch_product(nm_id):
    """Use public data as evidence only; absent data never becomes guessed facts."""
    errors = []
    for version in ("v4", "v2"):
        url = f"https://card.wb.ru/cards/{version}/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm={nm_id}"
        try:
            data = request_json(url, timeout=8)
            products = data.get("products") or data.get("data", {}).get("products", [])
            product = next((p for p in products if str(p.get("id")) == str(nm_id)), None)
            if product:
                return {"url": url, "retrieved_at": int(time.time()), "product": product}
            errors.append("product_not_found")
        except GatewayError as exc:
            errors.append(str(exc))
    return {"product": None, "errors": errors, "retrieved_at": int(time.time())}


def construct_wb_cards_upload_payload(payload):
    """Offline construction only, using seller-confirmed category and attributes."""
    from scripts.wb_upload_fixed import construct_wb_cards_upload_payload as construct
    return construct(payload, payload.get('subject_id'), [item.get('barcode') for item in payload.get('items', [])])


def download_source_image(facts, config, destination):
    """Fetch an image attached to this task's Feishu message, without storing tokens."""
    key, message_id = facts.get("source_image_key"), facts.get("source_image_message_id")
    if not key or not message_id:
        return None
    auth = request_json("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", "POST",
                        {"app_id": config["FEISHU_APP_ID"], "app_secret": config["FEISHU_APP_SECRET"]})
    if auth.get("code") != 0 or not auth.get("tenant_access_token"):
        raise GatewayError("Feishu image authentication failed")
    from urllib.parse import quote
    url = f"https://open.feishu.cn/open-apis/im/v1/messages/{quote(message_id,safe='')}/resources/{quote(key,safe='')}?type=image"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + auth["tenant_access_token"]})
    with urllib.request.urlopen(req, timeout=15) as response:
        image_bytes = response.read(32 * 1024 * 1024 + 1)
        if len(image_bytes) > 32 * 1024 * 1024:
            raise ValueError("Source image exceeds size limit")
        destination.write_bytes(image_bytes)
    from PIL import Image
    with Image.open(destination) as image:
        image.verify()
    return str(destination)


def get_facts(task, config, output):
    facts = dict(task.get("facts") or {})
    # Arbitrary local paths cannot be selected by a chat sender.
    facts.pop("source_images", None)
    # Local confirmed files are maintained by the owner, never path-selected by chat text.
    facts_root = Path(config.get("FACTS_ROOT", Path.home() / ".config/wb-fission/facts"))
    nm_id = str(task["nmId"])
    if not nm_id.isdigit():
        raise ValueError("Invalid product identifier")
    facts_file = facts_root / (nm_id + ".json")
    if facts_file.is_file():
        facts.update(json.loads(facts_file.read_text()))
    if facts.get("source_image_key"):
        facts["source_images"] = [download_source_image(facts, config, output / "original-image")]
    return facts


def run_generator(task, facts, evidence, output, command, progress=None, check_lease=None, account=None):
    """Adapter uses a configured program argv, never a command supplied by a customer."""
    argv = command if isinstance(command, list) else shlex.split(command)
    if not argv:
        raise ValueError("Generator command missing")
    payload = {"task": {k: task.get(k) for k in ("task_id", "nmId", "url")},
               "facts": facts, "evidence": evidence, "output_dir": str(output)}
    deadline = time.monotonic() + 3600
    with os.fdopen(os.open(output / 'generator.err.log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600), 'a') as error_log:
        os.fchmod(error_log.fileno(), 0o600)
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_log,
                                   text=True, cwd=output, env={**os.environ, **({"ANTIGRAVITY_ACCOUNT":account} if account else {})})
        last_progress = None
        initial_input = json.dumps(payload, ensure_ascii=False)
        try:
            while True:
                try:
                    stdout, _ = process.communicate(input=initial_input, timeout=5)
                    break
                except subprocess.TimeoutExpired:
                    initial_input = None
                    if check_lease:
                        check_lease()
                    if time.monotonic() >= deadline:
                        raise GatewayError('Generator time limit exceeded')
                    marker = output / 'progress.json'
                    if progress and marker.exists():
                        data = json.loads(marker.read_text())
                        signature = (data.get('status'), data.get('summary'))
                        if signature != last_progress:
                            progress(data['status'], data['summary'], {'completed':data.get('completed',0),'total':data.get('total',5),'published':False})
                            last_progress = signature
            if process.returncode:
                raise GatewayError('Generation program failed; see its private diagnostics')
        except BaseException:
            process.kill()
            process.wait()
            raise
    (output / 'generator.err.log').chmod(0o600)
    generated = json.loads(stdout)
    return validate_generated(generated, task, facts)


def validate_generated(generated, task, facts):
    if str(generated.get("source_nm_id")) != str(task["nmId"]):
        raise ValueError("Generated assets do not match the requested product")
    if generated.get("review", {}).get("subject_consistency_verified") is not True:
        raise ValueError("Generated images require source-product consistency review")
    if generated.get("facts_verified") is not True or generated.get("example_only"):
        raise ValueError("Generated product facts are not verified")
    for field in ("product_name", "brand", "category", "composition", "country", "sales_quantity"):
        if field in facts and generated.get(field) != facts[field]:
            raise ValueError("Generated assets differ from confirmed product facts")
    return generated


def execute_task(task, gateway, config, worker_id, store=None):
    claim_payload = {"key": task["key"], "worker_id": worker_id}
    if store:
        claim_payload["store"] = store
    claim = gateway.call("/api/tasks/claim", claim_payload)
    claimed = claim["task"]
    identity = {"key": task["key"], "lease_id": claimed["lease_id"], "worker_id": worker_id}
    if store:
        identity["store"] = store
    stopped = threading.Event()
    lease = LeaseSession(gateway, claimed)
    lost = lease.lost

    def renew():
        while not stopped.wait(15):
            try:
                lease.call("/api/executor/heartbeat", {**identity, "capabilities": capabilities(config)})
            except GatewayError:
                lost.set()
                return

    thread = threading.Thread(target=renew, daemon=True)
    thread.start()

    def update(status, summary, details=None):
        return lease.call("/api/tasks/update", {**identity, "status": status, "summary": summary, "details": details or {}})

    try:
        digest = hashlib.sha256(claimed["task_id"].encode()).hexdigest()[:16]
        output = Path(config.get("OUTPUT_ROOT", Path.home() / ".config/wb-fission/output")) / digest / 'creative'
        output.mkdir(parents=True, exist_ok=True)
        facts = get_facts(claimed, config, output)
        evidence, facts = acquire_source(claimed, gateway, config, output, facts)
        write_json(output / "source-evidence.json", evidence)
        if not facts.get('source_images'):
            summary = '已读取商品名称，但原图暂时无法取得。请在本聊天发送该商品原图，即可继续制作5套场景图文。' if evidence.get('product') else '此链接暂时无法读取。请确认链接，或在本聊天发送商品原图和名称，即可继续。'
            update('needs_input', summary, {'missing_fields':['source_images'], 'source_retrieved':bool(evidence.get('product')), 'source_errors':evidence.get('errors',[]), 'published':False})
            return 'needs_input'
        command = config.get("FISSION_GENERATOR_CMD")
        if not command:
            update("failed", "原商品资料已具备，但当前图文生成服务尚未配置。请求已保存，需接通生成服务后继续；尚未生成或上架。",
                   {"reason": "generator_not_configured", "published": False})
            return "failed"
        fingerprint_data = {k:v for k,v in facts.items() if k not in ('source_images','source_image_key','source_image_message_id')}
        fingerprint_data['original_hashes'] = [hashlib.sha256(Path(file).read_bytes()).hexdigest() for file in facts['source_images']]
        fingerprint = hashlib.sha256(json.dumps(fingerprint_data,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:16]
        output = output / fingerprint
        output.mkdir(parents=True,exist_ok=True)
        generated_path = output / 'generated-assets.json'
        generated = read_cache(generated_path)
        if generated is None:
            update('generating_text', '正在依据原商品规划5种应用场景与俄语文案。')
            generated = run_generator(claimed, facts, evidence, output, command, progress=update, check_lease=lease.ensure_owned, account=config.get("ANTIGRAVITY_ACCOUNT"))
            write_json(generated_path, generated)
        validate_generated(generated, claimed, facts)
        scene_count = len(generated.get('items', [])) or 5
        update('reviewing', f'正在整理{scene_count}套图文与可下载压缩包。', {'completed':scene_count,'total':scene_count,'published':False})
        bundle_path = output / 'bundle-paths.json'
        bundle = read_cache(bundle_path)
        if bundle is None:
            bundle = build_creative_bundle(generated, output / 'bundle')
            write_json(bundle_path, bundle)
        validate_bundle(bundle, claimed["nmId"])
        def owned():
            lease.call('/api/executor/heartbeat', {**identity, 'capabilities':capabilities(config)})
        update('reviewing', f'{scene_count}套图文已生成，正在发送图片、描述与压缩包到本聊天。', {'completed':scene_count,'total':scene_count,'published':False})
        receipt = FeishuDelivery(config).deliver(claimed, bundle, output / 'delivery-receipts.json', before_send=owned)
        update('ready', f'{scene_count}种同款场景图片、俄语标题与描述已发送本聊天，并附完整压缩包。请复核商品外观和文案。',
               {'artifacts_verified':True, 'manifest_path':bundle['manifest_path'], 'excel_path':bundle['excel_path'],
                'archive_path':bundle['archive_path'], 'delivery_verified':True,
                'delivered_scenes':len(receipt['scenes']), 'archive_message_id':receipt['archive_message_id'], 'published':False})
        return "ready"
    except DeliveryError as exc:
        logger.error('Feishu delivery deferred: %s',str(exc))
        if not lost.is_set():
            try:
                update('awaiting_delivery', '5套场景图文已生成，但飞书图片或文件发送暂未完成。请检查机器人资源权限后发送“重试”，会继续发送已生成结果。',
                       {'artifacts_verified':True,'manifest_path':bundle['manifest_path'], 'excel_path':bundle['excel_path'],
                        'archive_path':bundle['archive_path'],'delivery_verified':False,'delivery_error':str(exc),'published':False})
            except GatewayError:
                logger.error('Cannot persist pending delivery; lease will recover')
        return 'awaiting_delivery'
    except Exception as exc:
        logger.error("Task execution failed: %s", type(exc).__name__)
        if not lost.is_set():
            try:
                diagnostic = failure_details(exc, locals().get('output'))
                update("failed", failure_summary(diagnostic), diagnostic)
            except GatewayError:
                logger.error("Cannot update failed task; its lease will be recovered")
        return "failed"
    finally:
        stopped.set()
        thread.join(timeout=2)


def capabilities(config):
    return {"generation": bool(config.get("FISSION_GENERATOR_CMD")), "publishing": True,
            "source_validation": True, "asset_export": True,
            "bound_store": config.get("STORE_NAME")}


def run_daemon(config, interval=5, run_once=False):
    gateway = Gateway(config)
    store = config.get("STORE_NAME")
    if store:
        store = str(store).upper()
        worker_id = f"executor-{store}-{socket.gethostname()}-{os.getpid()}"
    else:
        worker_id = f"{socket.gethostname()}-{os.getpid()}"
    logger.info("Executor started; store=%s; worker_id=%s; interval=%s seconds", store or "all", worker_id, interval)
    while True:
        try:
            gateway.call("/api/executor/heartbeat", {"worker_id": worker_id, "store": store, "capabilities": capabilities(config)})
            publications=gateway.call('/api/tasks?status=ready').get('tasks',[])
            for task in publications:
                p=task.get('publication') or {}
                if p.get('state')=='requested' and p.get('resume_at',0)<=time.time()*1000:
                    try:
                        execute_publication(task,gateway,config,worker_id,store)
                    except GatewayError:
                        logger.warning('Publication claim or lease unavailable')
            query = "/api/tasks?status=waiting_executor" + (f"&store={store}" if store else "")
            tasks = gateway.call(query).get("tasks", []) if capabilities(config)["generation"] else []
            for task in tasks:
                try:
                    execute_task(task, gateway, config, worker_id, store=store)
                except GatewayError:
                    logger.warning("Task not claimed; another executor may own it")
        except GatewayError as exc:
            logger.warning("Gateway unavailable: %s; will retry", str(exc))
        if run_once:
            return
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description="Persistent WB task executor")
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--interval", type=int, default=5)
    parser.add_argument("--store", type=str, default=None, help="Bind executor to a specific WB store (e.g. RR010)")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.interval < 1:
        parser.error("interval must be positive")
    try:
        config = load_config(args.config)
        if args.store:
            config["STORE_NAME"] = args.store
    except (ValueError, OSError, GatewayError) as exc:
        parser.exit(2, f"Cannot load executor configuration: {type(exc).__name__}\n")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run_daemon(config, args.interval, args.once)


if __name__ == "__main__":
    main()
