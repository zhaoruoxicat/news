# -*- coding: utf-8 -*-
"""数据源注册表：分组定义、并发调度（移植自 news/src/sources/index.js）。"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor

from .feeds import FEEDS
from .hotsources import HOT_DEFS
from .rss import build_sources

# 分组定义：顺序即界面上的展示顺序
GROUPS = [
    {"id": "hot", "name": "实时热榜", "desc": "微博、知乎、头条等平台实时榜单"},
    {"id": "media", "name": "国内媒体", "desc": "新闻门户要闻"},
    {"id": "global", "name": "国际媒体", "desc": "境外通讯社与媒体（本机可直连的源）"},
    {"id": "tech", "name": "科技媒体", "desc": "国内外科技与开发者资讯"},
    {"id": "game", "name": "游戏", "desc": "游戏媒体与资讯"},
]

# 实时热榜：本机直连各平台官方公开接口
def _hot_sources():
    out = []
    for meta, fetch in HOT_DEFS:
        out.append({**meta, "group": "hot", "kind": "hot", "fetch": fetch})
    return out


FEED_SOURCES = build_sources(FEEDS)

SOURCES = _hot_sources() + FEED_SOURCES

BY_ID = {s["id"]: s for s in SOURCES}


def get_meta():
    """给界面用的平台元信息（不含函数，可安全序列化）。"""
    return [
        {"id": s["id"], "name": s["name"], "group": s["group"], "color": s["color"],
         "initial": s["initial"], "homepage": s["homepage"], "limit": s["limit"]}
        for s in SOURCES
    ]


def get_groups():
    used = {s["group"] for s in SOURCES}
    return [g for g in GROUPS if g["id"] in used]


def ids():
    return [s["id"] for s in SOURCES]


def fetch_source(source_id):
    """抓取单个平台。永不抛异常，失败时把错误文本放进 error 字段，
    这样某个平台挂掉不会影响其它平台展示。"""
    src = BY_ID.get(source_id)
    if not src:
        return {"id": source_id, "name": source_id, "items": [], "error": "未知平台：%s" % source_id}

    started = time.time()
    try:
        items = src["fetch"]()
        return {
            "id": src["id"], "name": src["name"], "group": src["group"],
            "color": src["color"], "initial": src["initial"], "homepage": src["homepage"],
            "items": items, "error": None, "at": time.time(),
            "elapsed": time.time() - started,
        }
    except Exception as err:  # noqa: BLE001 - 单源失败不影响其它源
        return {
            "id": src["id"], "name": src["name"], "group": src["group"],
            "color": src["color"], "initial": src["initial"], "homepage": src["homepage"],
            "items": [], "error": (str(err) or err.__class__.__name__), "at": time.time(),
            "elapsed": time.time() - started,
        }


def fetch_many(source_ids=None, concurrency=8, on_done=None):
    """限制并发的批量抓取；``on_done`` 每完成一个源即回调，便于「边抓边显示」。"""
    wanted = [i for i in (source_ids or ids()) if i in BY_ID]
    results = [None] * len(wanted)
    done = {"n": 0}

    def work(index, sid):
        res = fetch_source(sid)
        results[index] = res
        if on_done:
            done["n"] += 1
            on_done(res, done["n"], len(wanted))
        return res

    size = max(1, min(concurrency, len(wanted))) if wanted else 1
    with ThreadPoolExecutor(max_workers=size) as pool:
        list(pool.map(lambda p: work(*p), list(enumerate(wanted))))
    return results
