# -*- coding: utf-8 -*-
"""统一网络请求层。

伪装成桌面 Chrome，带超时与重试；按声明识别 GBK 等老编码；
所有抓取均从本机网络直连目标站点，不经任何第三方中转。
仅使用 Python 标准库。

注意：本模块命名为 net（而非 http），避免与标准库的 ``http`` 包同名，
否则 ``urllib.request`` 内部的 ``import http.client`` 会被本模块遮蔽。
"""

from __future__ import annotations

import gzip
import json
import re
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_HEADERS = {
    "User-Agent": CHROME_UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Accept-Encoding": "gzip, deflate",
}

# GB2312/GBK 老站点统一按 gb18030 解码：向后兼容且覆盖面更全
CHARSET_ALIASES = {
    "gb2312": "gb18030",
    "gb-2312": "gb18030",
    "gb_2312-80": "gb18030",
    "gbk": "gb18030",
    "utf8": "utf-8",
    "utf-8bom": "utf-8",
}

_SSL_CTX = ssl.create_default_context()


class HttpError(Exception):
    """网络层统一异常，``status`` 为 HTTP 状态码（0 表示非 HTTP 层错误）。"""

    def __init__(self, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.status = status


class Response:
    __slots__ = ("status", "text", "content", "headers", "url")

    def __init__(self, status, content, headers, url):
        self.status = status
        self.content = content
        self.headers = headers
        self.url = url
        self.text = decode_body(content, headers)


# ------------------------------------------------------------------ 编码识别

def detect_charset(content: bytes, headers) -> str:
    ctype = (headers.get("Content-Type") or "") if headers else ""
    m = re.search(r"charset\s*=\s*[\"']?([\w-]+)", ctype, re.I)
    if m:
        return m.group(1).lower()
    head = content[:1024].decode("latin1", "replace")
    m = re.search(r"<\?xml[^>]*encoding\s*=\s*[\"']([\w-]+)", head, re.I)
    if not m:
        m = re.search(r"<meta[^>]+charset\s*=\s*[\"']?([\w-]+)", head, re.I)
    if not m:
        m = re.search(r"encoding\s*=\s*[\"']([\w-]+)", head, re.I)
    return (m.group(1).lower() if m else "utf-8")


def decode_body(content: bytes, headers) -> str:
    if content[:3] == b"\xef\xbb\xbf":
        return content[3:].decode("utf-8", "replace")
    name = detect_charset(content, headers)
    name = CHARSET_ALIASES.get(name, name)
    try:
        return content.decode(name)
    except (LookupError, UnicodeDecodeError):
        # 声明不可用或与实际内容不符，退回常见编码
        for cand in ("utf-8", "gb18030"):
            try:
                return content.decode(cand)
            except (LookupError, UnicodeDecodeError):
                continue
        return content.decode("utf-8", "replace")


def _decompress(raw: bytes, encoding: str) -> bytes:
    enc = (encoding or "").lower()
    if enc == "gzip" or raw[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(raw)
        except OSError:
            return raw
    if enc == "deflate":
        try:
            return zlib.decompress(raw)
        except zlib.error:
            try:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
            except zlib.error:
                return raw
    if enc == "br":
        try:
            import brotli  # type: ignore

            return brotli.decompress(raw)
        except Exception:
            return raw
    return raw


def _friendly(err: Exception, timeout: float) -> str:
    if isinstance(err, HttpError):
        return str(err)
    if isinstance(err, (TimeoutError, socket.timeout)):
        return "请求超时（%ss）" % timeout
    if isinstance(err, urllib.error.URLError):
        reason = err.reason
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return "请求超时（%ss）" % timeout
        return "%s: %s" % (type(reason).__name__, reason)
    return "%s: %s" % (type(err).__name__, err)


# ------------------------------------------------------------------ 请求入口

def _encode_url(url: str) -> str:
    """把 URL 里的非 ASCII 字符（如中文路径）做百分号编码。

    ``urllib`` 在构造请求时按 ASCII 编码 URL，遇到中文路径会直接抛
    ``UnicodeEncodeError``；这里先规范化，保留已有的转义。
    """
    if not url or url.isascii():
        return url
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    path = urllib.parse.quote(parts.path, safe="/%:@!$&'()*+,;=~")
    query = urllib.parse.quote(parts.query, safe="=&%:@!$'()*+,;/?~")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def request(url, method="GET", headers=None, body=None, timeout=15, retries=1,
            backoff=0.4):
    """发起一次请求，失败按 backoff 重试，返回 :class:`Response`。"""
    url = _encode_url(url)
    hdrs = dict(DEFAULT_HEADERS)
    if body is not None:
        hdrs["Content-Type"] = "application/json"
    if headers:
        for k, v in headers.items():
            if v is None:
                continue
            # Referer 同样可能是含中文的 URL，需要先编码，否则发头时会报 ASCII 错误
            hdrs[k] = _encode_url(v) if k.lower() == "referer" else v
    if isinstance(body, str):
        body = body.encode("utf-8")

    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
            with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CTX) as resp:
                raw = resp.read()
                raw = _decompress(raw, resp.headers.get("Content-Encoding"))
                return Response(resp.status, raw, resp.headers, resp.geturl())
        except urllib.error.HTTPError as e:
            last = HttpError(("HTTP %s %s" % (e.code, e.reason or "")).strip(), e.code)
        except Exception as e:  # noqa: BLE001 - 统一转成可读错误
            last = HttpError(_friendly(e, timeout))
        if attempt < retries:
            time.sleep(backoff * (attempt + 1))

    raise last if last else HttpError("请求失败")


def get_json(url, **opts):
    res = request(url, **opts)
    try:
        return json.loads(res.text)
    except ValueError:
        head = re.sub(r"\s+", " ", res.text[:80])
        raise HttpError("返回内容不是合法 JSON（前 80 字符：%s）" % head)


def get_text(url, **opts):
    return request(url, **opts).text


def get_bytes(url, **opts):
    return request(url, **opts).content
