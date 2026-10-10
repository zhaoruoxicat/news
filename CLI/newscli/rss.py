# -*- coding: utf-8 -*-
"""通用 RSS / Atom / RDF 解析器（移植自 news/src/sources/rss.js，零依赖）。

各站 RSS 的脏数据很多（CDATA 嵌套、HTML 摘要、实体未转义、字段名五花八门），
这里用宽松正则取值并统一清洗，保证任何一个源出问题都不会拖垮其它源。
"""

from __future__ import annotations

import datetime
import email.utils
import html
import re

from .net import get_text
from .util import finalize, https_image

_CDATA_RE = re.compile(r"<!\[CDATA\[([\s\S]*?)\]\]>")

# 行内标签直接去掉（不该在文字中间插空格），块级标签才当分隔符
_INLINE_TAG_RE = re.compile(
    r"</?(?:a|b|strong|em|i|u|s|span|font|small|sub|sup|code|abbr|mark)\b[^>]*>", re.I
)
_BLOCK_CLOSE_RE = re.compile(
    r"</(?:p|div|li|h[1-6]|tr|td|th|section|article|blockquote|table|ul|ol)>", re.I
)
_ANY_TAG_RE = re.compile(r"<[^>]+>")

_DATE_FORMATS = (
    "%a, %d %b %Y %H:%M:%S %z",
    "%a, %d %b %Y %H:%M:%S %Z",
    "%a, %d %b %Y %H:%M %z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
)


def decode_entities(text) -> str:
    """展开 CDATA 并还原 HTML 实体。"""
    s = _CDATA_RE.sub(r"\1", "" if text is None else str(text))
    return html.unescape(s)


def strip_html(raw) -> str:
    """把 HTML 摘要压成纯文本一行。"""
    s = _CDATA_RE.sub(r"\1", "" if raw is None else str(raw))
    s = re.sub(r"<script[\s\S]*?</script>", " ", s, flags=re.I)
    s = re.sub(r"<style[\s\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", " ", s, flags=re.I)
    s = _INLINE_TAG_RE.sub("", s)
    s = _BLOCK_CLOSE_RE.sub(" ", s)
    s = _ANY_TAG_RE.sub(" ", s)
    return re.sub(r"\s+", " ", decode_entities(s)).strip()


def parse_date(text) -> int:
    """解析发布时间，返回毫秒时间戳（无法解析返回 0）。"""
    s = decode_entities(text).strip() if text else ""
    if not s:
        return 0
    try:
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(s)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp() * 1000)
    except (TypeError, ValueError):
        pass
    for fmt in _DATE_FORMATS:
        try:
            dt = datetime.datetime.strptime(s, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return 0


def rel_time(ts: int) -> str:
    """相对时间，用于「3 小时前」这类展示。"""
    if not ts:
        return ""
    diff = int(datetime.datetime.now().timestamp() * 1000) - ts
    if diff < 0:
        return "刚刚"
    minute = diff // 60000
    if minute < 1:
        return "刚刚"
    if minute < 60:
        return "%d 分钟前" % minute
    hour = minute // 60
    if hour < 24:
        return "%d 小时前" % hour
    day = hour // 24
    if day < 30:
        return "%d 天前" % day
    d = datetime.datetime.fromtimestamp(ts / 1000)
    return "%d 月 %d 日" % (d.month, d.day)


def pick_tag(block: str, tags) -> str:
    for tag in tags:
        t = re.escape(tag)
        m = re.search(r"<%s(?:\s[^>]*)?>([\s\S]*?)</%s>" % (t, t), block, re.I)
        if m and m.group(1).strip():
            return m.group(1)
    return ""


def pick_link(block: str) -> str:
    """RSS 的 ``<link>`` 与 Atom 的 ``<link href>`` 都要支持。"""
    inline = re.search(r"<link(?:\s[^>]*)?>([\s\S]*?)</link>", block, re.I)
    if inline and inline.group(1).strip():
        return decode_entities(inline.group(1)).strip()

    fallback = ""
    for m in re.finditer(r"<link\b([^>]*?)/?>", block, re.I):
        attrs = m.group(1) or ""
        href = re.search(r"href\s*=\s*[\"']([^\"']+)[\"']", attrs, re.I)
        if not href:
            continue
        value = href.group(1)
        rel = re.search(r"rel\s*=\s*[\"']([^\"']+)[\"']", attrs, re.I)
        rel = rel.group(1) if rel else ""
        if rel and "alternate" not in rel.lower():
            continue
        if "alternate" in rel.lower():
            return decode_entities(value).strip()
        fallback = fallback or decode_entities(value).strip()
    if fallback:
        return fallback

    guid = re.search(r"<guid[^>]*>([\s\S]*?)</guid>", block, re.I)
    if guid:
        g = decode_entities(guid.group(1)).strip()
        if re.match(r"^https?://", g, re.I):
            return g
    return ""


def pick_cover(block: str) -> str:
    """封面：优先媒体扩展字段，其次正文里的第一张图。"""
    media = re.search(r"<media:(?:content|thumbnail)[^>]*\surl=[\"']([^\"']+)[\"']", block, re.I)
    if media:
        return media.group(1)
    enclosure = re.search(r"<enclosure[^>]*\surl=[\"']([^\"']+)[\"'][^>]*>", block, re.I)
    if enclosure:
        return enclosure.group(1)
    body = pick_tag(block, ["content:encoded", "content", "description", "summary", "info"])
    img = re.search(r"<img[^>]+src=[\"']([^\"']+)[\"']", body, re.I)
    return img.group(1) if img else ""


def split_entries(xml: str):
    """把一段 XML 拆成条目块。"""
    blocks = [m.group(0) for m in re.finditer(r"<(item|entry)\b[\s\S]*?</\1>", xml, re.I)]
    if blocks:
        return blocks
    return [m.group(0) for m in re.finditer(r"<(item|entry)\b[^>]*/>", xml, re.I)]


def parse_feed(xml: str):
    items = []
    for block in split_entries(xml):
        raw_title = pick_tag(block, ["title"])
        title = strip_html(raw_title) or decode_entities(raw_title).strip()
        if not title:
            continue

        url = pick_link(block)
        raw_desc = pick_tag(block, ["description", "summary", "content:encoded", "content"])
        desc = strip_html(raw_desc)
        if desc == title:
            desc = ""
        if len(desc) > 160:
            desc = desc[:160].strip() + "…"

        category = strip_html(pick_tag(block, ["category", "tags"]))[:12]
        author = strip_html(pick_tag(block, ["dc:creator", "author", "name", "creator"]))[:20]
        ts = parse_date(pick_tag(block, ["pubDate", "published", "updated", "dc:date", "date",
                                         "lastBuildDate"]))

        bits = []
        if rel_time(ts):
            bits.append(rel_time(ts))
        if author and author != title:
            bits.append(author)

        items.append({
            "title": title,
            "url": url,
            "heat": None,
            "heatText": "",
            "heatLabel": "",
            "tag": category,
            "desc": desc,
            "cover": pick_cover(block),
            "extra": " · ".join(bits),
            "__ts": ts,
        })
    return items


def fetch_feed(feed_url: str, limit: int = 40, headers=None):
    xml = get_text(
        feed_url,
        timeout=20,
        retries=1,
        headers={
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            **(headers or {}),
        },
    )

    items = parse_feed(xml)
    if not items:
        raise ValueError("该源没有返回可解析的条目（可能是空列表或格式变更）")

    # 按链接去重；没有链接时退回标题
    seen = set()
    unique = []
    for it in items:
        key = (it.get("url") or it["title"]).lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(it)

    # 有发布时间的按时间倒序，没有的保持原始顺序
    dated = [it for it in unique if it["__ts"]]
    if len(dated) >= max(3, len(unique) * 0.5):
        ordered = sorted(unique, key=lambda it: it["__ts"] or 0, reverse=True)
    else:
        ordered = unique

    return finalize(
        [{**it, "cover": https_image(it["cover"])} for it in ordered],
        limit,
    )


def build_sources(configs):
    """由配置批量生成数据源对象。"""
    out = []
    for cfg in configs:
        def _make(cfg=cfg):
            def fetch():
                items = fetch_feed(
                    cfg["feed"], limit=cfg.get("limit", 40), headers=cfg.get("headers")
                )
                tag = cfg.get("tag")
                if tag:
                    for it in items:
                        if not it["tag"]:
                            it["tag"] = tag
                return items

            return fetch

        out.append({
            "id": cfg["id"],
            "name": cfg["name"],
            "group": cfg["group"],
            "color": cfg["color"],
            "initial": cfg["initial"],
            "homepage": cfg["homepage"],
            "limit": cfg.get("limit", 40),
            "kind": "feed",
            "fetch": _make(),
        })
    return out
