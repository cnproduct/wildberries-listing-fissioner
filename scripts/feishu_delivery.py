"""Deliver generated assets only to the originating Feishu conversation."""
import hashlib
import json
import mimetypes
import uuid
import urllib.request
import urllib.error
from pathlib import Path

BASE = 'https://open.feishu.cn/open-apis'


class DeliveryError(RuntimeError):
    pass


class FeishuDelivery:
    def __init__(self, config):
        self.config = config
        self.token = None

    def authenticate(self):
        result = self.request('/auth/v3/tenant_access_token/internal', {
            'app_id': self.config['FEISHU_APP_ID'], 'app_secret': self.config['FEISHU_APP_SECRET']}, authenticated=False)
        self.token = result.get('tenant_access_token')
        if not self.token:
            raise DeliveryError('Feishu authentication returned no token')

    def request(self, path, data, authenticated=True, content_type='application/json'):
        if authenticated and not self.token:
            self.authenticate()
        headers = {'Content-Type': content_type}
        if authenticated:
            headers['Authorization'] = 'Bearer ' + self.token
        body = json.dumps(data, ensure_ascii=False).encode() if isinstance(data, dict) else data
        req = urllib.request.Request(BASE + path, data=body, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                result = json.loads(error.read())
            except ValueError:
                raise DeliveryError('Feishu HTTP ' + str(error.code)) from None
            raise DeliveryError('Feishu HTTP ' + str(error.code) + ' API code ' + str(result.get('code'))) from None
        except (OSError, ValueError) as error:
            raise DeliveryError('Feishu transport failed: ' + type(error).__name__) from None
        if result.get('code') != 0:
            raise DeliveryError('Feishu API code ' + str(result.get('code')))
        return result

    def upload(self, path, kind):
        path = Path(path)
        boundary = 'wb-fission-' + uuid.uuid4().hex
        parts = []
        fields = {'image_type': 'message'} if kind == 'image' else {'file_type': 'stream', 'file_name': path.name}
        for key, value in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{kind}"; filename="{path.name}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + path.read_bytes() + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        result = self.request('/im/v1/' + ('images' if kind == 'image' else 'files'), b''.join(parts),
                              content_type='multipart/form-data; boundary=' + boundary)
        key = result.get('data', {}).get(kind + '_key')
        if not key:
            raise DeliveryError('Feishu upload returned no resource key')
        return key

    def send(self, task, kind, content, label):
        # UUID makes a network retry of this exact asset idempotent on Feishu.
        stable = str(uuid.uuid5(uuid.NAMESPACE_URL, task['task_id'] + ':' + label))
        result = self.request('/im/v1/messages?receive_id_type=chat_id', {
            'receive_id': task['chat_id'], 'msg_type': kind, 'content': json.dumps(content, ensure_ascii=False), 'uuid': stable})
        message_id = result.get('data', {}).get('message_id')
        if not message_id:
            raise DeliveryError('Feishu send returned no message receipt')
        return message_id

    def deliver(self, task, bundle, checkpoint, before_send=lambda: None):
        if not task.get('chat_id'):
            raise DeliveryError('Originating conversation missing')
        checkpoint = Path(checkpoint)
        receipt = json.loads(checkpoint.read_text()) if checkpoint.exists() else {'scenes': {}, 'uploads': {}}
        def persist():
            checkpoint.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
            checkpoint.chmod(0o600)
        manifest = bundle['manifest']
        revision = hashlib.sha256(json.dumps(manifest,sort_keys=True,ensure_ascii=False).encode()).hexdigest()[:16]
        task = {**task, 'task_id':task['task_id'] + ':' + revision}
        base = Path(bundle['manifest_path']).parent
        for item in manifest['items']:
            index = str(item['index'])
            if index in receipt['scenes']:
                continue
            before_send()
            key = receipt['uploads'].get(index)
            if not key:
                key = self.upload(base / item['image_path'], 'image')
                receipt['uploads'][index] = key
                persist()
            content = {'zh_cn': {'title': f"WB {task['nmId']} · {item['index']:02d}/10 · {item['scene_name']}", 'content': [
                [{'tag': 'text', 'text': '受众：' + item['persona']}],
                [{'tag': 'text', 'text': item['title']}],
                [{'tag': 'text', 'text': item['description']}],
                [{'tag': 'img', 'image_key': key}]]}}
            receipt['scenes'][index] = self.send(task, 'post', content, 'scene:' + index)
            persist()
        if not receipt.get('archive_message_id'):
            before_send()
            key = receipt.get('archive_key') or self.upload(bundle['archive_path'], 'file')
            receipt['archive_key'] = key
            persist()
            receipt['archive_message_id'] = self.send(task, 'file', {'file_key': key}, 'archive')
            persist()
        before_send()
        if not receipt.get('completion_message_id'):
            receipt['completion_message_id'] = self.send(task, 'text', {'text':
                f"WB {task['nmId']} 的10套同款场景图片与俄语标题、描述已完成，已发送上方10条图文和完整压缩包（含图片、Excel与文案）。正式使用前请复核商品外观和文案。"}, 'completion')
            persist()
        return receipt
