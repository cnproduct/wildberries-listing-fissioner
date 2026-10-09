#!/usr/bin/env python3
"""Feishu WebSocket receipt demo; no generation, token binding or publishing."""
import argparse
import json
import logging
import os
import re
from urllib.parse import urlparse

try:
    import lark_oapi as lark
except ImportError:
    lark = None

DEFAULT_APP_ID = "cli_aa42e84775381cfd"
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


def resolve_product(text):
    match = re.search(r"https?://[^\s<>]+", text, re.I)
    if match:
        url = urlparse(match.group())
        if url.hostname not in {"wildberries.ru", "www.wildberries.ru", "wb.ru", "www.wb.ru"} or url.username or url.password:
            return None
        product = re.fullmatch(r"/catalog/([0-9]{1,13})/detail\.aspx/?", url.path, re.I)
        return product.group(1) if product else None
    match = re.fullmatch(r"(?:(?:货号|артикул|articul|nmid)\s*[:：]?\s*|(?:裂变|上架)\s*[:：]?\s*)?([0-9]{6,13})", text, re.I)
    return match.group(1) if match else None


def build_local_reply(text):
    if re.match(r"^(?:绑定api|api)\s*[:：]", text, re.I) or (len(text) > 80 and not re.search(r"\s", text) and not text.lower().startswith(("http:", "https:"))):
        return "当前没有店铺授权核验或直传功能，请勿在聊天中发送 API Token。本次没有保存令牌，也没有验证权限。"
    nm_id = resolve_product(text)
    if nm_id:
        return f"已收到 WB 货号 {nm_id}。本地长连接服务仅演示消息接收，未保存持久化任务；自动制作和店铺发布尚未接通，暂无完成时间。请在 Agent 中运行 Skill 制作并审查资产。"
    if re.search(r"进度|多久|完成|状态|执行|排队", text):
        return "本地服务没有持久化执行任务或生成结果，不能提供制作进度。自动制作与店铺发布尚未接通。"
    return "请提供 WB 详情页链接或平台货号 nmId，并准备原图、真实规格和包装测量。卖家 SKU、条码不能直接定位 WB 商品。当前为消息接收演示，请勿发送 API Token。"


def create_feishu_client(app_id, app_secret):
    return lark.Client.builder().app_id(app_id).app_secret(app_secret).build()


def reply_text_message(client, message_id, chat_id, content):
    req = lark.api.im.v1.ReplyMessageRequest.builder().message_id(message_id).request_body(
        lark.api.im.v1.ReplyMessageRequestBody.builder().content(json.dumps({"text": content}, ensure_ascii=False)).msg_type("text").build()
    ).build()
    response = client.im.v1.message.reply(req)
    if response.success():
        return True
    if not chat_id:
        logging.error("Feishu reply failed (code=%s)", response.code)
        return False
    req = lark.api.im.v1.CreateMessageRequest.builder().receive_id_type("chat_id").request_body(
        lark.api.im.v1.CreateMessageRequestBody.builder().receive_id(chat_id).content(json.dumps({"text": content}, ensure_ascii=False)).msg_type("text").build()
    ).build()
    response = client.im.v1.message.create(req)
    if not response.success():
        logging.error("Feishu delivery failed (code=%s)", response.code)
    return response.success()


def build_event_handler(client, app_id):
    def handle_message(data):
        message, sender = data.event.message, data.event.sender
        if sender.sender_type == "app" or message.message_type != "text":
            return
        try:
            text = json.loads(message.content).get("text", "").strip()
            if not text:
                return
            reply_text_message(client, message.message_id, message.chat_id, build_local_reply(text))
        except Exception as exc:
            logging.error("Feishu message processing failed (%s)", type(exc).__name__)

    return lark.EventDispatcherHandler.builder("", "").register_p2_im_message_receive_v1(handle_message).build()


def main():
    parser = argparse.ArgumentParser(description="Start Feishu WebSocket receipt demo")
    parser.add_argument("--app-id", default=os.getenv("FEISHU_APP_ID", DEFAULT_APP_ID))
    parser.add_argument("--app-secret", default=os.getenv("FEISHU_APP_SECRET"), help="Prefer the FEISHU_APP_SECRET environment variable")
    args = parser.parse_args()
    if not args.app_secret:
        parser.exit(2, "FEISHU_APP_SECRET is required; configure it outside source code.\n")
    if lark is None:
        parser.exit(2, "Install the lark-oapi dependency before starting this demo.\n")
    client = create_feishu_client(args.app_id, args.app_secret)
    event_handler = build_event_handler(client, args.app_id)
    logging.info("Connecting Feishu receipt demo")
    lark.ws.Client(app_id=args.app_id, app_secret=args.app_secret, event_handler=event_handler, log_level=lark.LogLevel.INFO).start()


if __name__ == "__main__":
    main()
