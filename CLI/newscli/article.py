# -*- coding: utf-8 -*-
"""正文抓取：用本机网络模拟浏览器取回文章页，再把 HTML 压成可读纯文本。

思路与浏览器「阅读模式」一致：
1. 去掉脚本、样式、注释与导航/页脚/评论等噪声容器；
2. 在带内容语义的容器里挑出文字量最大的那个作为正文；
3. 按块级标签断行、还原实体，得到段落列表。
纯标准库实现，不依赖第三方解析库。
"""

from __future__ import annotations

import html as _html
import re
from urllib.parse import urlsplit

from .net import get_text

# 通用标签扫描：属性段允许出现引号包裹的 ">"，避免误截断
_TAG_RE = re.compile(r"<(/?)([a-zA-Z][\w:.-]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*)>")

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
         "meta", "param", "source", "track", "wbr"}

# 这些容器整体丢弃（与正文无关）
_ALWAYS_DROP = {"script", "style", "noscript", "template", "svg", "iframe", "form",
                "button", "select", "textarea", "input", "nav", "footer", "aside"}

# 无论类名怎么写都绝不整段丢弃的标签（丢了就没正文了）
_PROTECTED_TAGS = {"html", "body", "article", "main"}

# 内容容器的类名/ID 线索
_CONTENT_HINT = frozenset({
    "article", "artical", "content", "post", "detail", "entry", "story", "main",
    "body", "text", "newsbody", "richtext", "markdown", "editor", "wznr", "zhengwen",
})

# 噪声容器的类名/ID 线索（按「词元」匹配，避免 no-navbar 这类否定命名误伤）
_NEGATIVE_TOKENS = frozenset({
    "comment", "comments", "remark", "remarks", "pinglun",
    "sidebar", "footer", "foot",
    "nav", "navbar", "navigation", "menu", "menubar",
    "breadcrumb", "breadcrumbs", "crumb",
    "related", "recommend", "recommended", "recommendation",
    "ad", "ads", "advert", "advertisement", "adsense", "banner", "promo", "promotion",
    "popup", "modal", "dialog",
    "share", "sharing", "social", "toolbar",
    "login", "signin", "signup", "register", "subscribe", "newsletter",
    "copyright", "tag", "tags", "widget", "meta", "byline",
    "rank", "ranking", "hot", "hotlist", "topbar",
    "search", "print", "qrcode", "pagination", "pager",
    "reward", "donate", "sponsor",
})

# 否定前缀：紧跟其后的词元不算噪声线索
_NEGATION = frozenset({"no", "not", "without", "non"})

# 这些收尾标签在文本里当换行处理
_BLOCK_CLOSE = re.compile(
    r"</(?:p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|blockquote|table|figure|"
    r"figcaption|dd|dt|dl|pre|address|main|aside|header|footer|nav)\s*>", re.I)
_BR = re.compile(r"<br\s*/?>", re.I)
_ANY_TAG = re.compile(r"<[^>]+>")
_WORD_RE = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+")


def _attr(attrs: str, name: str) -> str:
    m = (re.search(r'(?<![\w-])%s\s*=\s*"([^"]*)"' % re.escape(name), attrs, re.I)
         or re.search(r"(?<![\w-])%s\s*=\s*'([^']*)'" % re.escape(name), attrs, re.I))
    return m.group(1) if m else ""


def _tokens(ident: str):
    """把 class/id 串拆成小写词元，兼容 kebab-case 与 camelCase。"""
    out = []
    for raw in re.split(r"[^A-Za-z0-9]+", ident or ""):
        if not raw:
            continue
        out.extend(p.lower() for p in _WORD_RE.findall(raw))
    return out


def _is_noise(ident: str) -> bool:
    """判断类名/ID 是否指向噪声容器。"""
    tokens = _tokens(ident)
    for i, tok in enumerate(tokens):
        if i > 0 and tokens[i - 1] in _NEGATION:
            continue          # no-navbar → 不当作 navbar
        if tok in _NEGATIVE_TOKENS:
            return True
    return False


def _has_content_hint(ident: str) -> bool:
    return any(tok in _CONTENT_HINT or tok in ("content", "article") for tok in _tokens(ident))


def _origin(url: str) -> str:
    p = urlsplit(url)
    return "%s://%s/" % (p.scheme, p.netloc) if p.scheme and p.netloc else ""


def _text_len(fragment: str) -> int:
    return len(re.sub(r"\s+", " ", _ANY_TAG.sub("", fragment)).strip())


def _inner_html(html: str, start) -> str:
    """返回 ``start`` 这个开始标签所对应元素的内部 HTML。"""
    tag = start.group(2).lower()
    depth = 1
    pos = start.end()
    for m in _TAG_RE.finditer(html, pos):
        if m.group(2).lower() != tag:
            continue
        if m.group(1) == "/":
            depth -= 1
            if depth == 0:
                return html[pos:m.start()]
        elif (m.group(3) or "").rstrip().endswith("/"):
            continue
        else:
            depth += 1
    return html[pos:]


def _find_close(html: str, start, tag: str) -> int:
    """返回匹配结束标签之后的偏移；找不到则返回开始标签结束处。"""
    depth = 1
    for m in _TAG_RE.finditer(html, start.end()):
        if m.group(2).lower() != tag:
            continue
        if m.group(1) == "/":
            depth -= 1
            if depth == 0:
                return m.end()
        elif (m.group(3) or "").rstrip().endswith("/"):
            continue
        else:
            depth += 1
    return start.end()


def _prune(html: str, is_noise) -> str:
    """按「标签名黑名单 + 类名/ID 噪声线索」整段移除节点。"""
    out = []
    i = 0
    n = len(html)
    while i < n:
        m = _TAG_RE.search(html, i)
        if not m:
            out.append(html[i:])
            break
        out.append(html[i:m.start()])
        tag = m.group(2).lower()
        if m.group(1) == "/" or tag in _VOID or (m.group(3) or "").rstrip().endswith("/"):
            out.append(m.group(0))
            i = m.end()
            continue
        attrs = m.group(3) or ""
        ident = (_attr(attrs, "class") + " " + _attr(attrs, "id")).strip()
        droppable = tag not in _PROTECTED_TAGS
        if droppable and (tag in _ALWAYS_DROP or (ident and is_noise(ident))):
            i = _find_close(html, m, tag)
            continue
        out.append(m.group(0))
        i = m.end()
    return "".join(out)


def _pick_title(html: str) -> str:
    for pat in (r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)',
                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']'):
        m = re.search(pat, html, re.I)
        if m:
            return _clean(m.group(1))
    m = re.search(r"<h1[^>]*>([\s\S]*?)</h1>", html, re.I)
    if m:
        t = _clean(m.group(1))
        if t:
            return t
    m = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I)
    return _clean(m.group(1)) if m else ""


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", _html.unescape(_ANY_TAG.sub("", text))).strip()


def _promote(html: str) -> str:
    """去掉脚本/样式/注释与全局噪声容器，返回用于挑选正文的 HTML。

    注意顺序：先删 ``<script>`` 再删注释——很多老页面在脚本里写
    ``<!-- ... //-->``，先删注释会把脚本之间的大段正文一起吞掉。
    """
    for tag in ("script", "style", "noscript", "template", "svg"):
        html = re.sub(r"<%s\b[\s\S]*?</%s>" % (tag, tag), " ", html, flags=re.I)
    html = re.sub(r"<!--[\s\S]*?-->", " ", html)
    html = re.sub(r"<head\b[\s\S]*?</head>", " ", html, flags=re.I)
    return _prune(html, _is_noise)


def _span(html: str, start):
    """返回 ``(元素起点, 元素终点, 内部起点, 内部终点)``。"""
    tag = start.group(2).lower()
    depth = 1
    pos = start.end()
    for m in _TAG_RE.finditer(html, pos):
        if m.group(2).lower() != tag:
            continue
        if m.group(1) == "/":
            depth -= 1
            if depth == 0:
                return start.start(), m.end(), pos, m.start()
        elif (m.group(3) or "").rstrip().endswith("/"):
            continue
        else:
            depth += 1
    return start.start(), len(html), pos, len(html)


def _pick_content(html: str):
    """挑出最合适的正文容器。

    在所有带内容语义的候选里，优先选「信息量最大且没有嵌套着同等信息量容器」
    的那个——否则外层包裹（面包屑 + 标题 + 正文）会一起被选中，把噪声也带进来。
    """
    cands = []
    for m in _TAG_RE.finditer(html):
        if m.group(1) == "/":
            continue
        tag = m.group(2).lower()
        if tag not in ("article", "main", "div", "section", "td"):
            continue
        attrs = m.group(3) or ""
        if attrs.rstrip().endswith("/"):
            continue
        ident = (_attr(attrs, "class") + " " + _attr(attrs, "id")).strip()
        if tag not in ("article", "main"):
            if not (ident and _has_content_hint(ident)):
                continue
            if _is_noise(ident):
                continue
        start, end, inner_start, inner_end = _span(html, m)
        length = _text_len(html[inner_start:inner_end])
        if length:
            cands.append((start, end, inner_start, inner_end, length))

    if not cands:
        return "", 0

    cands.sort(key=lambda c: -c[4])
    chosen = cands[0]
    for c in cands:
        nested_peer = any(
            o is not c and o[0] >= c[0] and o[1] <= c[1] and o[4] >= 0.7 * c[4]
            for o in cands
        )
        if not nested_peer:
            chosen = c
            break
    return html[chosen[2]:chosen[3]], chosen[4]


def html_to_paragraphs(fragment: str):
    """把一段 HTML 压成段落列表。"""
    s = _BR.sub("\n", fragment)
    s = _BLOCK_CLOSE.sub("\n", s)
    s = _ANY_TAG.sub("", s)
    s = _html.unescape(s)
    s = s.replace("\u00a0", " ").replace("\u3000", " ")

    out = []
    for raw in s.split("\n"):
        line = re.sub(r"[ \t\r\f\v]+", " ", raw).strip()
        if not line:
            continue
        if len(line) == 1 and not re.search(r"[\w\u4e00-\u9fff]", line):
            continue
        if out and out[-1] == line:
            continue
        out.append(line)
    return out


def parse_article(html: str):
    """解析文章页，返回 ``(标题, 段落列表)``。"""
    title = _pick_title(html)
    cleaned = _promote(html)
    inner, size = _pick_content(cleaned)
    if size < 200:  # 没有明显的内容容器，退回整页正文
        m = re.search(r"<body[^>]*>([\s\S]*)</body>", cleaned, re.I)
        inner = m.group(1) if m else cleaned

    paras = html_to_paragraphs(inner)
    if title and paras and paras[0] == title:
        paras = paras[1:]
    return title, paras


def fetch_html(url: str) -> str:
    """模拟浏览器取回文章页 HTML。"""
    return get_text(url, timeout=20, retries=1, headers={
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": _origin(url),
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
    })


def extract(url: str):
    """抓取并抽取正文，返回 ``(标题, 段落列表)``。"""
    return parse_article(fetch_html(url))
