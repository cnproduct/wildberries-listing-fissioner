"""Convert private execution failures to bounded, customer-safe diagnostics."""
import json
import re
from pathlib import Path

ISSUES = {
    'camera_angle': r'camera angle|front-facing|predominantly frontal|ракурс|угол.*съем',
    'label_distortion': r'garbled|distorted.*(?:characters|text|label)|typography|altered.*artwork|label.*distort|promotional overlay|advertisement.*(?:carton|packag)',
    'extra_product': r'extra (?:product )?unit|additional (?:product )?unit',
    'composition_mismatch': r'carton.*behind.*bottle|primary subject|main subject|composition verification failed|copied.*composition',
    'missing_packaging': r'box.*missing|missing.*(?:box|packag)',
}


def failure_details(exc, output=None):
    result = {'reason_code': 'unknown_failure', 'stage': 'processing', 'published': False}
    message = str(exc)
    if 'time limit exceeded' in message:
        result['reason_code'] = 'generation_timeout'
    elif type(exc).__name__ in ('TimeoutError', 'URLError', 'ConnectionError') or message in ('TimeoutError', 'URLError'):
        result['reason_code'] = 'connection_failed'
    elif re.fullmatch(r'HTTP (401|403)', message):
        result['reason_code'] = 'executor_auth_failed'
    elif 'facts' in message or 'requested product' in message or 'source-product consistency' in message:
        result['reason_code'] = 'product_validation_failed'
    # Only inspect generator logs for a generator failure. Never attribute stale
    # image review files to a later, unrelated network or packaging error.
    if output and 'Generation program failed' in message:
        folder = Path(output)
        log = folder / 'generator.err.log'
        try:
            lines = log.read_text(errors='replace').splitlines()
            line = lines[-1] if lines else ''
        except OSError:
            line = ''
        match = re.fullmatch(r'Source consistency review failed after retries at image (\d+)', line)
        if match and 1 <= int(match[1]) <= 10:
            index = int(match[1])
            result.update(reason_code='image_quality_failed', stage='generating_images', failed_image=index, total=10)
            accepted = 0
            for n in range(1, index):
                file = folder / 'generated' / f'{n:02d}-accepted.json'
                try:
                    review = json.loads(file.read_text())['review']
                    if review.get('passed') is True and review.get('issues') == []: accepted += 1
                except (OSError, ValueError, KeyError, TypeError): pass
            codes = set(); attempts = 0
            for attempt in range(1,4):
                file = folder / 'generated' / f'{index:02d}-try{attempt}-review.json'
                try:
                    issues = json.loads(file.read_text()).get('issues', [])
                    if not isinstance(issues, list): continue
                    attempts += 1
                    for issue in issues:
                        if isinstance(issue, str):
                            for code, pattern in ISSUES.items():
                                if re.search(pattern, issue, re.I): codes.add(code)
                except (OSError, ValueError, TypeError): pass
            result.update(completed=accepted, image_attempts=attempts, issue_codes=sorted(codes))
        elif 'No supported camera view' in line:
            result.update(reason_code='product_validation_failed', stage='source_analysis')
        elif re.search(r'Structured generation invalid:|Invalid source camera evidence|Invalid structured image review|Invalid camera review|not valid JSON|Unexpected (?:token|end)|Unterminated string', line):
            result['reason_code'] = 'generation_response_invalid'
            stage = re.search(r'Structured generation invalid: (source_analysis|scene_plan|image_review)', line)
            result['stage'] = stage[1] if stage else ('source_analysis' if 'source camera evidence' in line else 'generating_text')
        elif re.search(r'Native generation.*(?:HTTP 404|model unavailable)', line):
            result['reason_code'] = 'generation_model_unavailable'
        elif re.search(r'HTTP (429|5\d\d)|timeout|aborted', line, re.I):
            result['reason_code'] = 'generation_service_unavailable'
        elif 'authentication' in line.lower() or 'login missing' in line.lower() or 'HTTP 401' in line:
            result['reason_code'] = 'generation_auth_failed'
        elif 'proposal' in line.lower() or 'camera and framing' in line.lower() or 'generated copy' in line.lower():
            result['reason_code'] = 'scene_plan_invalid'
        else:
            result['reason_code'] = 'generation_failed'
    return result


def failure_summary(details):
    if details['reason_code'] == 'image_quality_failed':
        return f"第{details['failed_image']}张图片未通过商品与拍摄要求核对，已通过{details.get('completed',0)}/10张。可问“为什么失败”查看原因，或发送“重试”继续；尚未交付本批成品。"
    return '本次处理未完成。可发送“为什么失败”查看已记录原因及下一步；尚未确认交付或上架。'
