# -*- coding: utf-8 -*-
"""统一数据模型与文本处理工具（移植自 news/src/sources/util.js）。"""

from __future__ import annotations

import html
import math
import re
import urllib.parse

_TAG_RE = re.compile(r"<[^>]*>")


def trim_zero(v: float) -> str:
    s = "%.1f" % v
    return s[:-2] if s.endswith(".0") else s


def format_heat(n) -> str:
    """把数字热度格式化成中文习惯的「万 / 亿」。"""
    if n is None or isinstance(n, bool):
        return ""
    try:
        v = float(n)
    except (TypeError, ValueError):
        return ""
    if not math.isfinite(v) or v < 0:
        return ""
    if v >= 1e8:
        return _dot_one(v / 1e8) + "亿"
    if v >= 1e4:
        return _dot_one(v / 1e4) + "万"
    return str(int(round(v)))


def _dot_one(v: float) -> str:
    s = ("%.1f" % v)
    return s[:-2] if s.endswith(".0") else s


def parse_heat_text(text):
    """从「1234 万热度」「1.2亿热度」这类文本里还原数字。"""
    if not text:
        return None
    m = re.search(r"([\d.]+)\s*([万亿])?", str(text))
    if not m:
        return None
    try:
        base = float(m.group(1))
    except ValueError:
        return None
    if not math.isfinite(base):
        return None
    if m.group(2) == "万":
        return int(round(base * 1e4))
    if m.group(2) == "亿":
        return int(round(base * 1e8))
    return int(round(base))


def clean_text(s) -> str:
    """去掉 HTML 标签与多余空白，并还原实体。"""
    if s is None:
        return ""
    t = _TAG_RE.sub("", str(s))
    t = html.unescape(t)
    return re.sub(r"\s+", " ", t).strip()


def abs_url(base: str, u: str) -> str:
    if not u:
        return ""
    s = str(u).strip()
    if re.match(r"^https?://", s, re.I):
        return s
    if s.startswith("//"):
        return "https:" + s
    if not base:
        return s
    return base.rstrip("/") + "/" + s.lstrip("/")


def https_image(u: str) -> str:
    if not u:
        return ""
    return re.sub(r"^http://", "https://", str(u).strip(), flags=re.I)


def _finite(n):
    if isinstance(n, bool) or n is None:
        return None
    try:
        v = float(n)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(v) else None


def finalize(items, limit: int = 60):
    """按顺序赋 rank、过滤空标题、统一字段，最多保留 limit 条。"""
    out = []
    for it in items:
        if not it:
            continue
        title = clean_text(it.get("title"))
        if not title:
            continue
        out.append({
            "rank": len(out) + 1,
            "title": title,
            "url": it.get("url") or "",
            "heat": _finite(it.get("heat")),
            "heatText": it.get("heatText") or "",
            "heatLabel": it.get("heatLabel") or "",
            "tag": clean_text(it.get("tag")) if it.get("tag") else "",
            "desc": clean_text(it.get("desc") or ""),
            "cover": https_image(it.get("cover") or ""),
            "extra": clean_text(it.get("extra") or ""),
        })
        if len(out) >= limit:
            break
    return out


def quote(s: str) -> str:
    """等价于 JS 的 encodeURIComponent。"""
    return urllib.parse.quote(s, safe="")
