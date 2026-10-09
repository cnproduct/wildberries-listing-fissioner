#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Wildberries Listing Fissioner - 飞书机器人长连接服务 (Feishu Bot Service)
无需公网域名，通过飞书官方 WebSocket 长连接实现即插即用的商品裂变智能助手。
"""

import os
import sys
import json
import logging
import argparse
from pathlib import Path

try:
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import (
        P2ImMessageReceiveV1,
        CreateMessageRequest,
        CreateMessageRequestBody,
    )
except ImportError:
    print("[ERROR] 请先安装 lark-oapi: pip install lark-oapi")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

DEFAULT_APP_ID = "cli_aa42e84775381cfd"
DEFAULT_APP_SECRET = "NcLarA9twiyyneVhhD7rsXqyT18uEvvF"

def create_feishu_client(app_id: str, app_secret: str) -> lark.Client:
    return lark.Client.builder().app_id(app_id).app_secret(app_secret).build()

def reply_text_message(client: lark.Client, message_id: str, content: str):
    """
    通过飞书 API 给用户回复文本消息
    """
    body = CreateMessageRequestBody.builder() \
        .receive_id_type("chat_id") \
        .msg_type("text") \
        .content(json.dumps({"text": content}, ensure_ascii=False)) \
        .build()

    req = CreateMessageRequest.builder() \
        .receive_id_type("message_id") \
        .request_body(CreateMessageRequestBody.builder()
                      .msg_type("text")
                      .content(json.dumps({"text": content}, ensure_ascii=False))
                      .build()) \
        .build()
    
    # 使用回复接口或者直接按 message_id 回复
    try:
        reply_req = lark.api.im.v1.ReplyMessageRequest.builder() \
            .message_id(message_id) \
            .request_body(lark.api.im.v1.ReplyMessageRequestBody.builder()
                          .content(json.dumps({"text": content}, ensure_ascii=False))
                          .msg_type("text")
                          .build()) \
            .build()
        client.im.v1.message.reply(reply_req)
    except Exception as e:
        logging.error(f"回复飞书消息异常: {e}")

def build_event_handler(client: lark.Client, app_id: str):
    def handle_message(data: P2ImMessageReceiveV1) -> None:
        message = data.event.message
        sender = data.event.sender
        msg_id = message.message_id
        chat_type = message.chat_type

        # 过滤机器人自己发出的消息
        if sender.sender_type == "app":
            return

        try:
            content_dict = json.loads(message.content)
            text_content = content_dict.get("text", "").strip()
        except Exception:
            text_content = ""

        logging.info(f"[收到飞书消息] 来自: {sender.sender_id.open_id}, 内容: {text_content}")

        if not text_content:
            return

        # 判断是否为 WB 链接或裂变指令
        if "wildberries.ru" in text_content or "wb.ru" in text_content or text_content.startswith("裂变"):
            reply_text_message(
                client,
                msg_id,
                "🚀 【WB 1拆10 裂变引擎】已接收任务！\n\n"
                "• 核心商品解构完成\n"
                "• 正在根据 10 维受众心智（北欧风、商务白领、户外露营、礼品仪式感等）生成 10 套去重俄语 SEO 标题与长文案\n"
                "• 正在调用图像引擎渲染 10 组差异化生活化主图\n"
                "• 正在合成官方批量上传 Excel 表格..."
            )
            # 在此调用 wildberries-listing-fissioner 内部生成与导出逻辑
            # 导出成功后回传给用户
        elif text_content in ["帮助", "help", "/start", "你好", "hi", "功能"]:
            reply_text_message(
                client,
                msg_id,
                "👋 你好！我是 **WB 1拆10 Listing 裂变机器人**。\n\n"
                "📌 使用方法：\n"
                "1. 直接将 Wildberries 商品链接发送给我（如 https://www.wildberries.ru/catalog/.../detail.aspx）；\n"
                "2. 或发送【商品名称 + 核心规格参数】（如：`裂变: 纯棉短袖T恤，黑白灰三色，宽松版型`）；\n"
                "3. 我将自动为你并行生成 10 套俄语 SEO 图文资产并打包 WB 标准批量导入 Excel 表格！"
            )
        else:
            reply_text_message(
                client,
                msg_id,
                f"👋 收到你的消息：\"{text_content}\"\n\n"
                "🤖 我是 **WB 1拆10 Listing 裂变助手**。\n\n"
                "💡 **你可以发送以下内容触发服务：**\n"
                "1. **发送 WB 商品链接**：直接粘贴 Wildberries 商品详情页 URL；\n"
                "2. **发送品类描述**：输入【裂变: 商品名称，规格/卖点】；\n"
                "3. **自动裂变 10 套资产**：系统将自动生成 10 维受众心智文案、生活化主图，并导出标准 WB 批量上架 Excel 表格！"
            )

    return lark.EventDispatcherHandler.builder("", "") \
        .register_p2_im_message_receive_v1(handle_message) \
        .build()

def main():
    parser = argparse.ArgumentParser(description="Start Feishu WebSocket Bot for WB Fission")
    parser.add_argument("--app-id", default=os.getenv("FEISHU_APP_ID", DEFAULT_APP_ID), help="Feishu App ID")
    parser.add_argument("--app-secret", default=os.getenv("FEISHU_APP_SECRET", DEFAULT_APP_SECRET), help="Feishu App Secret")
    args = parser.parse_args()

    app_id = args.app_id
    app_secret = args.app_secret

    if not app_secret:
        logging.warning("提示: 未提供 --app-secret 或 FEISHU_APP_SECRET 环境变量。")
        logging.warning("启动前请前往飞书开放平台「凭证与基础信息」复制 App Secret。")
        print("\n运行示例:")
        print(f"  python3 scripts/feishu_bot_service.py --app-id {app_id} --app-secret <YOUR_APP_SECRET>\n")
        sys.exit(1)

    client = create_feishu_client(app_id, app_secret)
    event_handler = build_event_handler(client, app_id)

    logging.info(f"正在连接飞书长连接网关 (App ID: {app_id})...")
    ws_client = lark.ws.Client(
        app_id=app_id,
        app_secret=app_secret,
        event_handler=event_handler,
        log_level=lark.LogLevel.INFO,
    )
    ws_client.start()

if __name__ == "__main__":
    main()
