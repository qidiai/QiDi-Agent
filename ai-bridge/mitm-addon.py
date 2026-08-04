#!/usr/bin/env python3
"""
mitmproxy addon: 捕获 AI 工具的 API 请求/响应，转发到 ai-bridge
启动: mitmdump -s mitm-addon.py --listen-port 8888
"""

import json
import time
import urllib.request
from mitmproxy import http

# AI 工具的 API 域名列表(只抓这些)
AI_DOMAINS = [
    "api-agnes-code.agnes-ai.com",
    "llm-api.atomgit.com",
    "api.openai.com",
    "api.anthropic.com",
    "api.deepseek.com",
    "dashscope.aliyuncs.com",
    "open.bigmodel.cn",
    "api.minimax.chat",
    "api.mistral.ai",
    "generativelanguage.googleapis.com",
    "api.groq.com",
    "api.together.xyz",
    "api.cloudflare.com",
    "api.cursor.sh",
    "api.windsurf.com",
    "codeium-api",
    "api.gitcode.com",
    "llm-api.atomgit.com",
    "api.agnes-ai.com",
    "agnes-ai.com",
    "atomgit.com",
    # 腾讯混元 / WorkBuddy(腾讯云 coding-copilot 封装)
    "hunyuan.tencentcloudapi.com",
    "hunyuan.cloud.tencent.com",
    "api.hunyuan.cloud.tencent.com",
    "tencentcloudapi.com",
    "tencentcs.com",
    "coding.net",
    "cloud.tencent.com",
    "woa.com",
    "tencent-cloud",
]

# URL 路径含这些关键字也抓(跨域名兜底,便于发现未知 LLM 端点)
PATH_HINTS = ["chat/completions", "/completions", "/messages", "/generate",
              "chatcompletion", "hunyuan", "/v1/", "textgeneration"]

BRIDGE_URL = "http://127.0.0.1:9800/api/traffic/capture"
_capture_enabled = True

# 域名发现:把所有见过的 host 写到本地文件,用于摸清 WorkBuddy 实际连哪个端点
import os
_HOSTS_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mitm-hosts.log")
_seen_hosts = set()


def _note_host(host: str, url: str) -> None:
    if host in _seen_hosts:
        return
    _seen_hosts.add(host)
    try:
        with open(_HOSTS_LOG, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%H:%M:%S')}  {host}  {url[:160]}\n")
    except Exception:
        pass


def should_capture(host: str, url: str = "") -> bool:
    if not _capture_enabled:
        return False
    host_lower = host.lower()
    if any(d in host_lower for d in AI_DOMAINS):
        return True
    url_lower = url.lower()
    return any(h in url_lower for h in PATH_HINTS)


def request(flow: http.HTTPFlow) -> None:
    """请求发出时记录"""
    _note_host(flow.request.pretty_host, flow.request.pretty_url)
    if not should_capture(flow.request.pretty_host, flow.request.pretty_url):
        return

    body = ""
    if flow.request.content:
        try:
            body = flow.request.content.decode("utf-8", errors="replace")
        except:
            body = f"<binary {len(flow.request.content)} bytes>"

    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "direction": "out",
        "tool": flow.request.pretty_host,
        "taskId": f"mitm_{int(time.time()*1000)}",
        "type": "mitm-proxy",
        "source": "mitm",
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "content": body[:20000],
        "headers": dict(flow.request.headers),
    }
    _send_to_bridge(entry)


def response(flow: http.HTTPFlow) -> None:
    """响应返回时记录"""
    if not should_capture(flow.request.pretty_host, flow.request.pretty_url):
        return

    body = ""
    if flow.response.content:
        try:
            body = flow.response.content.decode("utf-8", errors="replace")
        except:
            body = f"<binary {len(flow.response.content)} bytes>"

    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "direction": "in",
        "tool": flow.request.pretty_host,
        "taskId": f"mitm_{int(time.time()*1000)}",
        "type": "mitm-proxy",
        "source": "mitm",
        "method": flow.request.method,
        "url": flow.request.pretty_url,
        "status_code": flow.response.status_code,
        "content": body[:20000],
        "headers": dict(flow.response.headers),
    }
    _send_to_bridge(entry)


def _send_to_bridge(entry: dict) -> None:
    try:
        data = json.dumps(entry).encode("utf-8")
        req = urllib.request.Request(BRIDGE_URL, data=data, headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3)
    except Exception as e:
        # 静默失败:mitmproxy 不应因 bridge 不可用而崩溃
        pass


class TrafficCapture:
    """mitmproxy addon 类(用于更精细的控制)"""

    def request(self, flow: http.HTTPFlow) -> None:
        request(flow)

    def response(self, flow: http.HTTPFlow) -> None:
        response(flow)


addons = [TrafficCapture()]
