# -*- coding: utf-8 -*-
"""9 个平台实时热榜源（移植自 news/src/sources/*.js）。

全部为本机直连各平台官方公开接口，不含任何第三方中转。
每个源的 ``fetch`` 返回统一模型的条目列表。
"""

from __future__ import annotations

import json
import math
import re
import time

from .net import HttpError, get_json, get_text
from .util import finalize, format_heat, parse_heat_text, quote


def _n(v):
    """把接口里的数值字段归一化；无法解析或为 0 时返回 None。

    源程序用 ``Number(x) || null``，会把 0 视作「无此数据」，这里保持一致，
    避免列表里出现「0阅读」这类噪声。
    """
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f) or f == 0:
        return None
    return v


# ------------------------------------------------------------------ 微博热搜
WEIBO = {
    "id": "weibo", "name": "微博热搜", "color": "#e6162d", "initial": "微",
    "homepage": "https://s.weibo.com/top/summary", "limit": 50,
}


def fetch_weibo():
    data = get_json("https://weibo.com/ajax/side/hotSearch",
                    headers={"Referer": "https://weibo.com/"})
    realtime = (data.get("data") or {}).get("realtime")
    if not isinstance(realtime, list):
        raise HttpError("微博接口返回结构异常")

    # is_ad / topic_ad 是商业推广位，直接从热搜榜里剔除
    rows = [x for x in realtime
            if not x.get("is_ad") and not x.get("topic_ad") and (x.get("word") or x.get("note"))]

    items = []
    for x in rows:
        word = x.get("word") or x.get("note")
        heat = _n(x.get("num"))
        items.append({
            "title": word,
            "url": "https://s.weibo.com/weibo?q=" + quote("#" + word + "#"),
            "heat": heat,
            "heatText": format_heat(heat),
            "heatLabel": "热度",
            "tag": x.get("label_name") or x.get("icon_desc") or "",
            "desc": x.get("note") if x.get("note") != word else "",
        })
    return finalize(items, WEIBO["limit"])


# ------------------------------------------------------------------ 知乎热榜
ZHIHU = {
    "id": "zhihu", "name": "知乎热榜", "color": "#0084ff", "initial": "知",
    "homepage": "https://www.zhihu.com/hot", "limit": 50,
}


def fetch_zhihu():
    # 网页版 /api/v3 需要登录 cookies；移动端接口可匿名访问
    data = get_json("https://api.zhihu.com/topstory/hot-lists/total?limit=50",
                    headers={"Accept": "application/json", "Referer": "https://www.zhihu.com/hot"})
    rows = data.get("data")
    if not isinstance(rows, list):
        raise HttpError("知乎接口返回结构异常")

    items = []
    for entry in rows:
        t = entry.get("target") or {}
        raw_url = str(t.get("url") or "")
        m = re.search(r"/questions?/(\d+)", raw_url)
        if m:
            url = "https://www.zhihu.com/question/" + m.group(1)
        elif t.get("id"):
            url = "https://www.zhihu.com/question/%s" % t["id"]
        else:
            url = "https://www.zhihu.com/hot"

        heat = _n(parse_heat_text(entry.get("detail_text")))
        answers = int(t.get("answer_count") or 0)
        card_label = entry.get("card_label") or {}
        items.append({
            "title": t.get("title"),
            "url": url,
            "heat": heat,
            "heatText": format_heat(heat) if heat
                        else str(entry.get("detail_text") or "").replace("热度", "").strip(),
            "heatLabel": "热度",
            "tag": "沸" if card_label.get("type") == "boiling" else "",
            "desc": t.get("excerpt") or "",
            "extra": ("%d 个回答" % answers) if answers else "",
        })
    return finalize(items, ZHIHU["limit"])


# ------------------------------------------------------------------ 今日头条
TOUTIAO = {
    "id": "toutiao", "name": "今日头条", "color": "#ed4040", "initial": "头",
    "homepage": "https://www.toutiao.com/", "limit": 50,
}

# 头条标签位：接口给的是英文枚举
_TOUTIAO_LABEL = {
    "new": "新", "hot": "热", "boom": "爆", "fevertime": "沸",
    "top": "置顶", "novel": "小说", "n1": "热",
}


def fetch_toutiao():
    data = get_json("https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
                    headers={"Referer": "https://www.toutiao.com/"})
    rows = data.get("data")
    if not isinstance(rows, list):
        raise HttpError("头条接口返回结构异常")

    items = []
    for it in rows:
        heat = _n(it.get("HotValue"))
        label_key = str(it.get("Label") or "").lower()
        items.append({
            "title": it.get("Title"),
            "url": ("https://www.toutiao.com/trending/%s/" % it["ClusterIdStr"])
                   if it.get("ClusterIdStr") else (it.get("Url") or "https://www.toutiao.com/"),
            "heat": heat,
            "heatText": format_heat(heat),
            "heatLabel": "热度",
            "tag": _TOUTIAO_LABEL.get(label_key) or it.get("LabelDesc") or "",
            "desc": it.get("LabelDesc") or "",
            "cover": it.get("Image") or "",
        })
    return finalize(items, TOUTIAO["limit"])


# ------------------------------------------------------------------ 百度热搜
BAIDU = {
    "id": "baidu", "name": "百度热搜", "color": "#2932e1", "initial": "百",
    "homepage": "https://top.baidu.com/board?tab=realtime", "limit": 51,
}

_BAIDU_PAGE = "https://top.baidu.com/board?tab=realtime"
_BAIDU_API = "https://top.baidu.com/api/board?platform=wise&tab=realtime"
# 已实测确认的枚举：1=新，3=热（0 表示无标签）
_BAIDU_TAG = {"1": "新", "3": "热"}


def _baidu_extract_embedded(html):
    m = re.search(r"<!--s-data:([\s\S]*?)-->", html)
    if not m:
        return None
    try:
        cards = (json.loads(m.group(1)).get("data") or {}).get("cards")
    except ValueError:
        return None
    if not isinstance(cards, list):
        return None
    for card in cards:
        rows = card.get("content")
        if isinstance(rows, list) and rows and rows[0].get("word"):
            return rows
    return None


def _baidu_extract_api(data):
    cards = (data.get("data") or {}).get("cards")
    if not isinstance(cards, list):
        return None
    for card in cards:
        content = card.get("content")
        if not isinstance(content, list):
            continue
        if content and content[0].get("word"):
            return content
        for wrap in content:
            inner = wrap.get("content") if isinstance(wrap, dict) else None
            if isinstance(inner, list) and inner and inner[0].get("word"):
                return inner
    return None


def fetch_baidu():
    rows = None
    # 主通道：页面内嵌数据，带真实热度
    try:
        html = get_text(_BAIDU_PAGE, headers={
            "Accept": "text/html,application/xhtml+xml", "Referer": "https://www.baidu.com/"})
        rows = _baidu_extract_embedded(html)
    except Exception:  # noqa: BLE001 - 主通道失败即走兜底
        rows = None

    # 兜底通道：官方 JSON 接口（无热度值，但至少能出榜单）
    if not rows:
        data = get_json(_BAIDU_API, headers={"Referer": _BAIDU_PAGE})
        rows = _baidu_extract_api(data)
    if not rows:
        raise HttpError("百度热搜返回结构异常")

    items = []
    for it in rows:
        heat = _n(it.get("hotScore"))
        items.append({
            "title": it.get("word"),
            "url": it.get("url") or it.get("rawUrl")
                   or ("https://www.baidu.com/s?wd=" + quote(it.get("word") or "")),
            "heat": heat,
            "heatText": format_heat(heat),
            "heatLabel": "搜索指数",
            "tag": "置顶" if it.get("isTop") else _BAIDU_TAG.get(str(it.get("hotTag")), ""),
            "desc": it.get("desc") or "",
            "cover": it.get("img") or "",
        })
    return finalize(items, BAIDU["limit"])


# ------------------------------------------------------------------ 抖音热搜
DOUYIN = {
    "id": "douyin", "name": "抖音热搜", "color": "#fe2c55", "initial": "抖",
    "homepage": "https://www.douyin.com/hot", "limit": 50,
}


def fetch_douyin():
    data = get_json(
        "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383"
        "&channel=channel_pc_web&detail_list=1&source=6",
        headers={"Referer": "https://www.douyin.com/"},
    )
    rows = (data.get("data") or {}).get("word_list")
    if not isinstance(rows, list):
        raise HttpError("抖音接口返回结构异常（可能触发了风控）")

    items = []
    for it in rows:
        heat = _n(it.get("hot_value"))
        cover = ((it.get("word_cover") or {}).get("url_list") or [None])[0]
        items.append({
            "title": it.get("word"),
            "url": ("https://www.douyin.com/hot/%s" % it["sentence_id"])
                   if it.get("sentence_id")
                   else ("https://www.douyin.com/search/" + quote(it.get("word") or "")),
            "heat": heat,
            "heatText": format_heat(heat),
            "heatLabel": "热度",
            "tag": "置顶" if it.get("is_n1") else "",
            "cover": cover or "",
        })
    return finalize(items, DOUYIN["limit"])


# ------------------------------------------------------------------ B站排行
BILIBILI = {
    "id": "bilibili", "name": "B站排行", "color": "#fb7299", "initial": "B",
    "homepage": "https://www.bilibili.com/v/popular/rank/all", "limit": 60,
}


def fetch_bilibili():
    data = get_json("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all",
                    headers={"Referer": "https://www.bilibili.com/"})
    if data.get("code") != 0:
        raise HttpError("B站接口返回错误码 %s" % data.get("code"))
    rows = (data.get("data") or {}).get("list")
    if not isinstance(rows, list):
        raise HttpError("B站接口返回结构异常")

    items = []
    for it in rows:
        view = _n((it.get("stat") or {}).get("view"))
        author = (it.get("owner") or {}).get("name") or ""
        tname = it.get("tname") or ""
        items.append({
            "title": it.get("title"),
            "url": ("https://www.bilibili.com/video/%s" % it["bvid"])
                   if it.get("bvid") else (it.get("short_link_v2") or ""),
            "heat": view,
            "heatText": format_heat(view),
            "heatLabel": "播放",
            "tag": tname,
            "desc": it.get("desc") or "",
            "cover": it.get("pic") or "",
            "extra": ("%s · %s" % (author, tname)).rstrip(" ·") if author else tname,
        })
    return finalize(items, BILIBILI["limit"])


# ------------------------------------------------------------------ IT之家
ITHOME = {
    "id": "ithome", "name": "IT之家", "color": "#e60012", "initial": "IT",
    "homepage": "https://www.ithome.com/", "limit": 40,
}


def _ithome_url(it):
    raw = it.get("url") or ""
    if re.match(r"^https?://", raw, re.I):
        return raw
    if raw:
        return "https://www.ithome.com" + (raw if raw.startswith("/") else "/" + raw)
    if it.get("newsid"):
        return "https://www.ithome.com/0/0/%s.htm" % it["newsid"]
    return "https://www.ithome.com/"


def fetch_ithome():
    data = get_json("https://api.ithome.com/json/newslist/news",
                    headers={"Referer": "https://www.ithome.com/"})
    top = data.get("toplist") if isinstance(data.get("toplist"), list) else []
    news = data.get("newslist") if isinstance(data.get("newslist"), list) else []
    if not top and not news:
        raise HttpError("IT之家接口返回结构异常")

    top_ids = {t.get("newsid") for t in top}
    rows = [{**it, "__top": True} for it in top]
    rows += [n for n in news if n.get("newsid") not in top_ids]

    items = []
    for it in rows:
        heat = _n(it.get("hitcount"))
        comments = int(it.get("commentcount") or 0)
        items.append({
            "title": it.get("title"),
            "url": _ithome_url(it),
            "heat": heat,
            "heatText": format_heat(heat),
            "heatLabel": "阅读",
            "tag": "置顶" if it.get("__top") else "",
            "desc": it.get("description") or "",
            "cover": it.get("image") or "",
            "extra": ("%d 评论" % comments) if comments else "",
        })
    return finalize(items, ITHOME["limit"])


# ------------------------------------------------------------------ 36氪热榜
KR36 = {
    "id": "kr36", "name": "36氪热榜", "color": "#1e6fff", "initial": "36",
    "homepage": "https://36kr.com/hot-list/catalog", "limit": 50,
}


def fetch_kr36():
    body = json.dumps({
        "partner_id": "wap",
        "param": {"siteId": 1, "platformId": 2},
        "timestamp": int(time.time() * 1000),
    })
    data = get_json("https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot",
                    method="POST", headers={"Referer": "https://36kr.com/"}, body=body)
    rows = (data.get("data") or {}).get("hotRankList")
    if not isinstance(rows, list):
        raise HttpError("36氪接口返回结构异常")

    items = []
    for it in rows:
        m = it.get("templateMaterial") or {}
        read = _n(m.get("statRead"))
        items.append({
            "title": m.get("widgetTitle"),
            "url": ("https://36kr.com/p/%s" % it["itemId"]) if it.get("itemId")
                   else "https://36kr.com/hot-list/catalog",
            "heat": read,
            "heatText": format_heat(read),
            "heatLabel": "阅读",
            "tag": "",
            "cover": m.get("widgetImage") or "",
            "extra": m.get("statFormat") or "",
        })
    return finalize(items, KR36["limit"])


# ------------------------------------------------------------------ 掘金热榜
JUEJIN = {
    "id": "juejin", "name": "掘金热榜", "color": "#1e80ff", "initial": "掘",
    "homepage": "https://juejin.cn/hot/articles/1", "limit": 50,
}


def fetch_juejin():
    data = get_json(
        "https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot&spider=0",
        headers={"Referer": "https://juejin.cn/"},
    )
    rows = data.get("data")
    if not isinstance(rows, list):
        raise HttpError("掘金接口返回结构异常")

    items = []
    for it in rows:
        c = it.get("content") or {}
        counter = it.get("content_counter") or {}
        view = _n(counter.get("view"))
        author = (it.get("author") or {}).get("name") or ""
        items.append({
            "title": c.get("title"),
            "url": ("https://juejin.cn/post/%s" % c["content_id"]) if c.get("content_id")
                   else "https://juejin.cn/hot/articles/1",
            "heat": view,
            "heatText": format_heat(view),
            "heatLabel": "阅读",
            "tag": "",
            "desc": c.get("brief") or "",
            "extra": ("%s · %s 赞" % (author, counter.get("like") or 0)) if author else "",
        })
    return finalize(items, JUEJIN["limit"])


# ------------------------------------------------------------------ 注册表

HOT_DEFS = [
    (WEIBO, fetch_weibo),
    (ZHIHU, fetch_zhihu),
    (TOUTIAO, fetch_toutiao),
    (BAIDU, fetch_baidu),
    (DOUYIN, fetch_douyin),
    (BILIBILI, fetch_bilibili),
    (ITHOME, fetch_ithome),
    (KR36, fetch_kr36),
    (JUEJIN, fetch_juejin),
]

__all__ = ["HOT_DEFS", "fetch_weibo", "fetch_zhihu", "fetch_toutiao", "fetch_baidu",
           "fetch_douyin", "fetch_bilibili", "fetch_ithome", "fetch_kr36", "fetch_juejin"]
