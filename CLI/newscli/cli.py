# -*- coding: utf-8 -*-
"""newscli 交互式命令行界面。

交互规则：
  回车      当前平台还有下一屏时向下滚动一屏；否则抓取并显示下一个平台
  -N        抓取并显示「当前平台第 N 条」的正文（本机网络模拟浏览器，同样分屏）
  -N b      用系统浏览器打开「当前平台第 N 条」的链接
  0         退出程序

两条「省资源」的设计：
  1. 启动只提示已启动，不联网；按回车才逐个平台抓取，一次只抓一个；
  2. 每次只输出「终端高度放得下」的行数，绝不一次性刷满整个列表。
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import unicodedata
import webbrowser

from . import __version__, article, registry

HELP = """newscli —— 命令行热点新闻查看器

用法: newscli [选项]

选项:
  -h, --help        显示本帮助
  -v, --version     显示版本号
  -page N           每屏显示 N 行（默认按终端高度自动计算）
  -only LIST        只使用指定数据源（逗号分隔的 id），便于快速验证
  -no-color         关闭彩色输出

交互命令（在「命令>」提示符下输入）:
  回车              抓取下一个平台；当前平台还有下一屏时，则向下滚动一屏
  -N                抓取并显示「当前平台第 N 条」的正文（分屏显示）
  -N b              用系统浏览器打开「当前平台第 N 条」的链接
  0                 退出程序

启动行为: 启动时不联网抓取任何内容，只提示已启动；
          按回车才逐个平台抓取并显示，以节省网络资源。

数据来源: 微博 / 知乎 / 今日头条 / 百度 / 抖音 / B站 / IT之家 / 36氪 / 掘金
的公开热榜接口，以及 26 个国内外媒体与游戏站的官方 RSS；
全部由本机网络直连，无任何第三方中转。
"""

# 分屏时留给表头 / 提示 / 提示符的行数，避免提示行被顶出屏幕
_PAGE_OVERHEAD = 6


# ------------------------------------------------------------------ 终端着色

class _Paint:
    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _w(self, code: str, text: str) -> str:
        return "\033[%sm%s\033[0m" % (code, text) if self.enabled else text

    def bold(self, t):
        return self._w("1", t)

    def dim(self, t):
        return self._w("2", t)

    def red(self, t):
        return self._w("31", t)

    def green(self, t):
        return self._w("32", t)

    def yellow(self, t):
        return self._w("33", t)

    def cyan(self, t):
        return self._w("36", t)


# ------------------------------------------------------------------ 宽度与高度

def _char_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def _wrap_line(line: str, width: int):
    """按终端显示宽度折行（中文按 2 列计）。"""
    out, cur, w = [], "", 0
    for ch in line:
        cw = _char_width(ch)
        if w + cw > width and cur:
            out.append(cur)
            cur, w = "", 0
        cur += ch
        w += cw
    if cur:
        out.append(cur)
    return out


def _term_size():
    try:
        size = shutil.get_terminal_size((80, 24))
        return size.columns, size.lines
    except Exception:  # noqa: BLE001 - 取不到就用默认值
        cols, rows = 80, 24
        try:
            cols = int(os.environ.get("COLUMNS") or cols)
            rows = int(os.environ.get("LINES") or rows)
        except ValueError:
            pass
        return cols, rows


def _term_width() -> int:
    cols, _ = _term_size()
    return max(40, min(cols - 2, 100))


def _auto_page_size() -> int:
    """每屏可显示的行数：终端高度减去表头/提示占用。"""
    _, rows = _term_size()
    return max(3, rows - _PAGE_OVERHEAD)


# ------------------------------------------------------------------ 展示逻辑

def _item_suffix(it) -> str:
    bits = []
    if it.get("tag"):
        bits.append("[%s]" % it["tag"])
    if it.get("heatText"):
        bits.append("%s%s" % (it["heatText"], it.get("heatLabel") or ""))
    if it.get("extra"):
        bits.append(it["extra"])
    return " ".join(bits)


def _hint(p: _Paint, more_pages: int) -> str:
    if more_pages > 0:
        return p.dim("回车=向下滚动（还有 %d 页）  -N=看第N条正文  -N b=浏览器打开  0=退出"
                     % more_pages)
    return p.dim("回车=抓取下一个平台  -N=看第N条正文  -N b=浏览器打开  0=退出")


def _show_list_page(groups, idx, page, size, p: _Paint) -> int:
    """显示当前分组的第 ``page`` 屏（页码从 0 起），返回该分组的总屏数。"""
    g = groups[idx]
    items = g["items"]
    total = max(1, (len(items) + size - 1) // size)
    page = max(0, min(page, total - 1))
    chunk = items[page * size:(page + 1) * size]

    meta = "共 %d 条 · 第 %d/%d 屏" % (len(items), page + 1, total)
    print(p.bold(p.cyan("g%d.%s" % (idx + 1, g["name"]))) + p.dim("  （%s）" % meta))
    for it in chunk:
        line = "%d. %s" % (it["rank"], it["title"])
        suffix = _item_suffix(it)
        if suffix:
            line += "  " + p.dim(suffix)
        print(line)
    print(_hint(p, total - page - 1))
    return total


def _article_pages(it, title, paras, width, size, footer, p: _Paint):
    """把正文切成若干屏；每屏结尾带分隔线与页码，保证任何时候都只占一屏。"""
    rule = p.dim("─" * min(width, 60))
    per_page = max(2, size - 2)          # 留出分隔线 + 页码

    content = []
    for i, para in enumerate(paras):
        content.extend(_wrap_line(para, width))
        if i != len(paras) - 1:
            content.append("")

    chunks = [content[i:i + per_page] for i in range(0, len(content), per_page)] or [[]]
    total = len(chunks)

    pages = []
    for k, chunk in enumerate(chunks):
        lines = []
        if k == 0:
            # 标题以列表里的为准（来源可靠），页面标题仅作兜底
            lines.append(p.bold(it["title"] or title))
            lines.append(rule)
        if not content:
            lines.append(p.yellow("未能从该页面提取到正文（可能是动态渲染页面）。"))
        lines.extend(chunk)
        lines.append(rule)
        lines.append(p.dim("（%s · 第 %d/%d 屏）" % (footer, k + 1, total)))
        pages.append(lines)
    return pages


def _render_article_page(art, p: _Paint):
    for line in art["pages"][art["i"]]:
        print(line)


def _open_article(groups, idx, n, size, p: _Paint):
    """抓取正文并切屏；成功返回 ``{"pages": [...], "i": 0}``，失败返回 None。"""
    g = groups[idx]
    it = g["items"][n - 1]
    url = it.get("url") or ""
    if not url:
        print(p.red("该条没有可用的链接，无法抓取正文。"))
        return None

    print(p.dim("正在用本机网络抓取正文：%s" % url))
    try:
        title, paras = article.extract(url)
    except Exception as e:  # noqa: BLE001 - 抓取失败要给出可操作的退路
        print(p.red("正文抓取失败：%s" % e))
        print(p.dim("可改用 -%d b 在浏览器中打开原页面。" % n))
        return None

    footer = "g%d.%s · 第 %d 条" % (idx + 1, g["name"], n)
    pages = _article_pages(it, title, paras, _term_width(), size, footer, p)
    return {"pages": pages, "i": 0}


def _open_browser(groups, idx, n, p: _Paint):
    it = groups[idx]["items"][n - 1]
    url = it.get("url") or ""
    if not url:
        print(p.red("该条没有可用的链接。"))
        return
    print(p.dim("在系统浏览器中打开：%s" % url))
    try:
        ok = webbrowser.open(url)
    except Exception as e:  # noqa: BLE001 - 无图形环境时优雅降级
        ok = False
        print(p.red("调用浏览器失败：%s" % e))
    if not ok:
        print(p.yellow("未能唤起浏览器（可能当前没有图形环境），请手动复制上面的链接打开。"))


# ------------------------------------------------------------------ 主流程

def run(only_ids=None, color: bool = True, page_size=None) -> int:
    p = _Paint(color)
    size = page_size if page_size and page_size > 0 else _auto_page_size()

    ids = registry.ids()
    if only_ids:
        wanted = set(only_ids)
        ids = [i for i in ids if i in wanted]
        if not ids:
            print(p.red("没有匹配的数据源：%s" % ",".join(only_ids)))
            return 2

    # ---------------- 启动：只提示已启动，绝不联网
    print("newscli 已启动。")
    print(p.dim("共 %d 个数据源。启动时不抓取任何内容，按回车才逐个平台抓取，以节省网络。"
                % len(ids)))
    print(p.dim("回车=抓取下一个平台  -N=看第N条正文  -N b=浏览器打开  0=退出"))

    pending = list(range(len(ids)))   # 本轮还没抓过的平台
    groups = []                       # 已抓取并显示过的平台
    idx = 0                           # 当前平台在 groups 里的下标
    page = 0                          # 当前平台内的屏号（从 0 起）
    total_pages = 0                   # 当前平台的总屏数
    art = None                        # 看正文时：{"pages": [...], "i": 屏号}

    def fetch_next_group() -> bool:
        """按顺序抓取下一个平台；抓不到内容的自动跳过。"""
        nonlocal idx, page, total_pages
        if not pending:
            pending.extend(range(len(ids)))
            del groups[:]
            idx = page = total_pages = 0
            print(p.dim("（已抓完一轮，重新从第一个平台开始）"))
        while pending:
            si = pending.pop(0)
            name = registry.BY_ID[ids[si]]["name"]
            print(p.dim("正在抓取第 %d/%d 个平台：%s …" % (si + 1, len(ids), name)))
            res = registry.fetch_source(ids[si])
            if res["items"]:
                groups.append(res)
                idx = len(groups) - 1
                page = 0
                total_pages = _show_list_page(groups, idx, page, size, p)
                return True
            print("  " + p.red("✗") + " %s：%s" % (res["name"], res["error"] or "无数据"))
        print(p.red("所有数据源都没取到内容，请检查本机网络后按回车重试。"))
        return False

    while True:
        try:
            raw = input(p.bold("命令> ")).strip()
        except (EOFError, KeyboardInterrupt):
            sys.stdout.write("\n")
            break

        # ---------------- 回车：翻屏 / 抓取下一个平台
        if raw == "":
            print()
            if art is not None:
                # 正文没翻完就继续往下翻，翻完回到当前平台的列表
                if art["i"] + 1 < len(art["pages"]):
                    art["i"] += 1
                    _render_article_page(art, p)
                else:
                    art = None
                    if groups:
                        _show_list_page(groups, idx, page, size, p)
                    else:
                        print(p.dim("回车=抓取下一个平台  0=退出"))
                continue

            if groups and page + 1 < total_pages:
                page += 1
                _show_list_page(groups, idx, page, size, p)
                continue

            art = None
            fetch_next_group()
            continue

        # ---------------- 退出
        if raw in ("0", "q", "quit", "exit", "退出"):
            break

        # ---------------- -N / -N b
        m = re.match(r"^-(\d+)\s*([bB])?$", raw)
        if m:
            if not groups:
                print(p.yellow("还没有抓取任何平台，先按回车抓取一个平台。"))
                continue
            n = int(m.group(1))
            if n < 1 or n > len(groups[idx]["items"]):
                print(p.red("当前平台只有 %d 条，第 %d 条越界。"
                            % (len(groups[idx]["items"]), n)))
                continue
            if m.group(2):
                _open_browser(groups, idx, n, p)
            else:
                art = _open_article(groups, idx, n, size, p)
                if art is not None:
                    print()
                    _render_article_page(art, p)
            continue

        print(p.yellow("无法识别的命令。可用：回车=抓取下一个平台/向下滚动  "
                       "-N=看第N条正文  -N b=浏览器打开  0=退出"))

    print(p.dim("已退出 newscli。"))
    return 0


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    parser = argparse.ArgumentParser(prog="newscli", add_help=False)
    parser.add_argument("-h", "--help", "-help", action="store_true", dest="show_help")
    parser.add_argument("-v", "--version", action="store_true", dest="show_version")
    parser.add_argument("-only", "--only", default="", dest="only")
    parser.add_argument("-page", "--page", default="", dest="page")
    parser.add_argument("-no-color", "--no-color", action="store_true", dest="no_color")

    try:
        args, unknown = parser.parse_known_args(argv)
    except SystemExit:
        print(HELP)
        return 2

    if unknown:
        sys.stderr.write("无法识别的参数：%s\n\n" % " ".join(unknown))
        sys.stderr.write(HELP)
        return 2
    if args.show_help:
        print(HELP)
        return 0
    if args.show_version:
        print("newscli %s" % __version__)
        return 0

    only = [s.strip() for s in args.only.split(",") if s.strip()] or None

    page_size = None
    if args.page:
        try:
            page_size = int(args.page)
        except ValueError:
            sys.stderr.write("无法识别的参数：-page %s（应为正整数）\n" % args.page)
            return 2
        if page_size <= 0:
            sys.stderr.write("无法识别的参数：-page %s（应为正整数）\n" % args.page)
            return 2

    color = (not args.no_color) and sys.stdout.isatty() and os.environ.get("TERM") != "dumb"

    try:
        return run(only_ids=only, color=color, page_size=page_size)
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        return 130
