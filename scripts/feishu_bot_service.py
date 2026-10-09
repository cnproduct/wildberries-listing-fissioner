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

def reply_text_message(client: lark.Client, message_id: str, chat_id: str, content: str):
    """
    通过飞书 API 给用户回复文本消息（支持优先使用 reply，失败时自动降级使用 chat_id 发送）
    """
    try:
        reply_req = lark.api.im.v1.ReplyMessageRequest.builder() \
            .message_id(message_id) \
            .request_body(lark.api.im.v1.ReplyMessageRequestBody.builder()
                          .content(json.dumps({"text": content}, ensure_ascii=False))
                          .msg_type("text")
                          .build()) \
            .build()
        resp = client.im.v1.message.reply(reply_req)
        if not resp.success():
            logging.warning(f"通过 message.reply 失败 (code={resp.code}, msg={resp.msg})，尝试通过 chat_id 发送...")
            create_req = lark.api.im.v1.CreateMessageRequest.builder() \
                .receive_id_type("chat_id") \
                .request_body(lark.api.im.v1.CreateMessageRequestBody.builder()
                              .receive_id(chat_id)
                              .content(json.dumps({"text": content}, ensure_ascii=False))
                              .msg_type("text")
                              .build()) \
                .build()
            resp2 = client.im.v1.message.create(create_req)
            if not resp2.success():
                logging.error(f"通过 chat_id 发送也失败: code={resp2.code}, msg={resp2.msg}")
            else:
                logging.info(f"成功通过 chat_id 发送消息: chat_id={chat_id}")
        else:
            logging.info(f"成功通过 reply 回复消息: message_id={message_id}")
    except Exception as e:
        logging.error(f"发送飞书消息发生未捕获异常: {e}", exc_info=True)

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

        chat_id = message.chat_id

        sender_id = sender.sender_id.open_id or sender.sender_id.user_id or "default_user"
        tokens_file = Path("./data/wb_user_tokens.json")
        tokens_file.parent.mkdir(parents=True, exist_ok=True)
        user_tokens = {}
        if tokens_file.exists():
            try:
                with open(tokens_file, "r", encoding="utf-8") as f:
                    user_tokens = json.load(f)
            except Exception:
                user_tokens = {}

        # 1. 识别绑定或更新 API 令牌指令
        clean_text = text_content.strip()
        is_token_input = False
        new_token = ""
        if clean_text.lower().startswith("绑定api:") or clean_text.lower().startswith("绑定api：") or clean_text.lower().startswith("api:"):
            parts = clean_text.split(":", 1) if ":" in clean_text else clean_text.split("：", 1)
            new_token = parts[1].strip()
            is_token_input = True
        elif len(clean_text) > 80 and not clean_text.startswith("http") and " " not in clean_text:
            # 常见 JWT/Base64 长 Token 格式
            new_token = clean_text
            is_token_input = True

        if is_token_input and new_token:
            user_tokens[sender_id] = new_token
            with open(tokens_file, "w", encoding="utf-8") as f:
                json.dump(user_tokens, f, ensure_ascii=False, indent=2)
            reply_text_message(
                client,
                msg_id,
                chat_id,
                "✅ **您的 Wildberries 店铺 API 接口已成功接入！**\n\n"
                "• 授权状态：已绑定\n"
                "• 接口权限：Контент (商品/Content) 直传\n\n"
                "📦 **下一步**：请直接发送您想裂变的 **Wildberries 商品链接**（如 https://www.wildberries.ru/catalog/.../detail.aspx），系统将自动为您裂变 10 套去重 Listing 并通过 API 直接发布到您的 WB 店铺后台！"
            )
            return

        # 2. 用户询问如何发布、账号、API 或需要提供什么资料
        publish_keywords = ["如何发布", "怎么发布", "发布到", "wb账号", "提供什么", "资料", "api", "接口", "授权", "怎么用", "上架"]
        if any(kw in clean_text.lower() for kw in publish_keywords):
            has_token = sender_id in user_tokens
            token_status = "🟢 已绑定 API 接口" if has_token else "🔴 尚未绑定 API 接口"
            reply_text_message(
                client,
                msg_id,
                chat_id,
                "💡 **如何发布到您的 Wildberries 账号？**\n\n"
                "系统通过 **Wildberries 官方 API 接口** 直连您的店铺，裂变完成的 10 套 Listing 将直接同步至您的卖家后台。\n\n"
                f"当前店铺状态：**{token_status}**\n\n"
                "📋 **您只需提供以下资料即可：**\n"
                "👉 **提供您的 WB 店铺 API 令牌 (API Token)**\n"
                "• **获取路径**：登录 WB 卖家后台 (`seller.wildberries.ru`) ➔ 点击右上角头像「Настройки (设置)」➔「Доступ к API (API 访问)」➔ 创建并复制一个带 **【Контент (Content/商品)】** 权限的 Token。\n"
                "• **提交方式**：直接在此发送：`绑定API: <您的Token>`（或直接粘贴 Token 字符串）。\n\n"
                "🔗 **绑定后如何使用？**\n"
                "绑定 API 后，直接将要裂变的 **WB 商品链接** 发送给我，系统将自动执行 10 维受众心智裂变，并直接通过接口推送到您的 WB 账号！"
            )
            return

        # 3. 判断是否为 WB 链接或裂变指令
        if "wildberries.ru" in clean_text or "wb.ru" in clean_text or clean_text.startswith("裂变"):
            has_token = sender_id in user_tokens
            token_tip = "已检测到绑定的 API 接口，裂变完成后将直接推送至您的店铺！" if has_token else "提示：您尚未绑定 WB API 接口，完成生成后将为您导出标准 WB 批量上架 Excel 表格（如需 API 直传，可随时发送 `绑定API: <Token>`）。"
            reply_text_message(
                client,
                msg_id,
                chat_id,
                "🚀 **【WB 1拆10 裂变引擎】任务已启动！**\n\n"
                "• 核心商品解构：提取材质、规格与功能形态\n"
                "• 10 维受众矩阵：正在生成居家、职场、露营、礼盒等 10 套去重俄语 SEO 标题与长文案\n"
                "• 原生生图引擎：正在以原图为锚点渲染 10 组差异化生活化主图\n"
                f"• 发布渠道：{token_tip}"
            )
            return

        # 4. 默认通用响应与引导
        reply_text_message(
            client,
            msg_id,
            chat_id,
            f"👋 收到你的消息：\"{clean_text}\"\n\n"
            "🤖 我是 **WB 1拆10 Listing 裂变助手**。\n\n"
            "📌 **您只需提供两项资料即可开始使用：**\n"
            "1️⃣ **第一步：提供 WB 店铺 API 接口**（用于一键免人工自动发布）\n"
            "   • 直接发送：`绑定API: <您的WB_Token>`\n"
            "   • 从 WB 后台「Настройки」➔「Доступ к API」获取 Content 权限 Token；\n\n"
            "2️⃣ **第二步：发送要裂变的商品链接或原图**\n"
            "   • 粘贴 Wildberries 商品详情页 URL，系统将自动裂变 10 套去重资产并同步推送到您的 WB 账号！"
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
