#!/usr/bin/env bash
# 在无 root、无显示的沙箱里验证 newscli 的 .deb。
#
#   ./verify-deb.sh
#
# 思路: 不真装到系统，用 dpkg-deb -x 解包后直接跑「包里的那份代码」，
#       从而验证交付物本身（而不是源码树）能被真实使用。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export TMPDIR="$HERE/.tmp"
mkdir -p "$TMPDIR"

WORK="$HERE/.verify"
if [ -e "$WORK" ]; then
    TRASH="${HOME}/.local/share/Trash/files"
    mkdir -p "$TRASH"
    mv "$WORK" "$TRASH/newscli-verify-$(date +%s)"
fi
mkdir -p "$WORK"

PASS=0
FAIL=0
ok()  { echo "  [ok] $*"; PASS=$((PASS + 1)); }
bad() { echo "  [!!] $*"; FAIL=$((FAIL + 1)); }
head_() { echo; echo "== $* =="; }

DEB="$(ls -1 "$HERE"/packaging/build/*.deb 2>/dev/null | head -1)"
if [ -z "$DEB" ]; then
    echo "找不到 .deb，请先执行 ./build-deb.sh"
    exit 1
fi
echo "待验证的包：$DEB"

# ---------------------------------------------------------------- 1. 控制字段
head_ "1. 控制字段与依赖"
FIELD_PKG="$(dpkg-deb -f "$DEB" Package)"
FIELD_VER="$(dpkg-deb -f "$DEB" Version)"
FIELD_ARCH="$(dpkg-deb -f "$DEB" Architecture)"
FIELD_DEP="$(dpkg-deb -f "$DEB" Depends)"

[ "$FIELD_PKG" = "newscli" ] && ok "Package=$FIELD_PKG" || bad "Package 异常: $FIELD_PKG"
[ -n "$FIELD_VER" ] && ok "Version=$FIELD_VER" || bad "Version 为空"
[ "$FIELD_ARCH" = "all" ] && ok "Architecture=all" || bad "Architecture 异常: $FIELD_ARCH"

case "$FIELD_DEP" in
    *python3*) ok "依赖包含 python3: $FIELD_DEP" ;;
    *) bad "依赖里缺少 python3: $FIELD_DEP" ;;
esac
if echo "$FIELD_DEP" | grep -Eq 'requests|urllib3|beautifulsoup|bs4|lxml|pyyaml|httpx|aiohttp'; then
    bad "依赖里混入了第三方 Python 包: $FIELD_DEP"
else
    ok "依赖中没有第三方 Python 包（纯标准库承诺成立）"
fi

# ---------------------------------------------------------------- 2. 包内布局
head_ "2. 包内文件布局"
CONTENT="$(dpkg-deb -c "$DEB")"
for want in "./usr/bin/newscli" "./opt/newscli/newscli/cli.py" \
            "./opt/newscli/newscli/article.py" "./opt/newscli/newscli/net.py" \
            "./usr/share/man/man1/newscli.1.gz"; do
    echo "$CONTENT" | grep -q "$want" && ok "包含 $want" || bad "缺少 $want"
done
if echo "$CONTENT" | grep -q "__pycache__\|\.pyc"; then
    bad "包里混入了 __pycache__ / .pyc"
else
    ok "没有混入 __pycache__ / .pyc"
fi
if echo "$CONTENT" | grep -q "Trash-0"; then
    bad "包里混入了 .Trash-0（沙箱 rm 的残留）"
else
    ok "没有混入 .Trash-0 残留"
fi

# ---------------------------------------------------------------- 3. 维护脚本
head_ "3. 维护脚本"
dpkg-deb -e "$DEB" "$WORK/DEBIAN"
for s in postinst prerm postrm; do
    if [ -x "$WORK/DEBIAN/$s" ]; then
        ok "$s 存在且可执行"
    else
        bad "$s 缺失或不可执行"
    fi
done
if grep -q "rm -rf" "$WORK/DEBIAN/prerm" 2>/dev/null; then
    bad "prerm 里出现 rm -rf，可能误删用户数据"
else
    ok "prerm 不会自作主张删除用户数据"
fi
if grep -Eq 'rm -rf .*(/home|\$HOME|\.config|\.local)' "$WORK/DEBIAN/postrm" 2>/dev/null; then
    bad "postrm 触碰了用户目录"
else
    ok "postrm 不触碰用户目录"
fi

# ---------------------------------------------------------------- 4. 解包后运行
head_ "4. 解包后直接运行包内代码"
dpkg-deb -x "$DEB" "$WORK/root"
INSTALL_DIR="$WORK/root/opt/newscli"
LAUNCHER="$WORK/root/usr/bin/newscli"

if [ -x "$LAUNCHER" ]; then
    ok "启动器具备可执行位"
else
    bad "启动器缺少可执行位"
fi
grep -q "/opt/newscli" "$LAUNCHER" && ok "启动器指向 /opt/newscli" || bad "启动器未指向 /opt/newscli"
grep -q "Trash-0" -r "$INSTALL_DIR" 2>/dev/null && bad "包内代码含 Trash-0 残留" || ok "包内代码干净"

# 源码里不得出现第三方库 import
if grep -RInE '^\s*(import|from)\s+(requests|bs4|lxml|urllib3|yaml|httpx|aiohttp)\b' "$INSTALL_DIR" >/dev/null 2>&1; then
    bad "包内代码引用了第三方库"
else
    ok "包内代码只依赖标准库"
fi

cd "$INSTALL_DIR" || exit 1

VERSION_OUT="$(python3 -m newscli -v 2>&1)"
case "$VERSION_OUT" in
    newscli*) ok "版本输出: $VERSION_OUT" ;;
    *) bad "版本输出异常: $VERSION_OUT" ;;
esac

HELP_OUT="$(python3 -m newscli -h 2>&1)"
if echo "$HELP_OUT" | grep -q "回车" && echo "$HELP_OUT" | grep -q -- "-N"; then
    ok "-h 输出了交互说明"
else
    bad "-h 输出不完整"
fi

python3 -m newscli --definitely-not-an-option >/dev/null 2>&1
[ $? -eq 2 ] && ok "非法参数以退出码 2 退出" || bad "非法参数退出码不是 2"

# ---------------------------------------------------------------- 5. 启动不联网
head_ "5. 启动只提示，不联网抓取"
START_OUT="$(printf '0\n' | timeout 60 python3 -m newscli -only weibo,ithome,chinanews -no-color 2>&1)"
echo "$START_OUT" | sed 's/^/    /'
if echo "$START_OUT" | grep -q "已启动"; then
    ok "启动时提示了「已启动」"
else
    bad "启动未提示「已启动」"
fi
if echo "$START_OUT" | grep -qE "^g[0-9]+\." || echo "$START_OUT" | grep -q "正在抓取"; then
    bad "启动时就抓取/显示了内容（应等回车）"
else
    ok "启动时没有抓取任何平台（无分组、无抓取日志）"
fi
echo "$START_OUT" | grep -q "按回车" && ok "提示了「按回车才抓取」" || bad "未提示按回车抓取"

# ---------------------------------------------------------------- 6. 逐平台抓取
head_ "6. 按回车逐个平台抓取（一次只抓一个）"
ONE_OUT="$(printf '\n0\n' | timeout 180 python3 -m newscli -only weibo,ithome,chinanews -no-color -page 200 2>&1)"
echo "$ONE_OUT" | grep -q "正在抓取第 1/3 个平台" && ok "回车后抓取了第 1 个平台" || bad "回车未触发抓取"
echo "$ONE_OUT" | grep -q "^g1\." && ok "显示了 g1 平台" || bad "未显示 g1"
if echo "$ONE_OUT" | grep -q "^g2\."; then
    bad "一次回车抓取了多个平台"
else
    ok "一次回车只抓取一个平台"
fi
echo "$ONE_OUT" | grep -qE "^[0-9]+\. .+" && ok "标题列表带有编号" || bad "未看到编号标题"

TWO_OUT="$(printf '\n\n0\n' | timeout 200 python3 -m newscli -only weibo,ithome,chinanews -no-color -page 200 2>&1)"
echo "$TWO_OUT" | grep -q "正在抓取第 2/3 个平台" && ok "第二次回车抓取了第 2 个平台" || bad "第二次回车未抓取"
echo "$TWO_OUT" | grep -q "^g2\." && ok "显示了 g2 平台" || bad "未显示 g2"

# ---------------------------------------------------------------- 7. 分屏与滚动
head_ "7. 分屏显示与回车滚动"

# (a) 按终端高度自动分屏：LINES=24 时每屏 18 行（先回车抓一个平台）
AUTO_OUT="$(printf '\n0\n' | LINES=24 COLUMNS=80 timeout 180 python3 -m newscli -only weibo -no-color 2>&1)"
AUTO_CNT="$(printf '%s\n' "$AUTO_OUT" | grep -cE '^[0-9]+\. ')"
if [ "$AUTO_CNT" -eq 18 ]; then
    ok "按终端高度自动分屏：LINES=24 时首屏 18 条"
else
    bad "自动分屏条数异常: $AUTO_CNT（期望 18）"
fi
echo "$AUTO_OUT" | grep -q "第 1/3 屏" && ok "50 条被切成 3 屏" || bad "页码信息异常"

# (b) 回车优先向下滚动，滚到底才抓下一个平台
SCROLL_OUT="$(printf '\n\n0\n' | timeout 180 python3 -m newscli -only weibo -no-color -page 5 2>&1)"
echo "$SCROLL_OUT" | grep -q "第 1/10 屏" && ok "首屏为 第 1/10 屏" || bad "首屏页码异常"
echo "$SCROLL_OUT" | grep -q "第 2/10 屏" && ok "按回车后滚动到 第 2/10 屏" || bad "回车未滚动"
echo "$SCROLL_OUT" | grep -q "还有" && ok "提示了本平台剩余屏数" || bad "未提示剩余屏数"

NAV_OUT="$(printf '\n\n0\n' | timeout 200 python3 -m newscli -only weibo,ithome -no-color -page 200 2>&1)"
echo "$NAV_OUT" | grep -q "^g2\." && ok "滚到底后回车抓取并显示下一个平台 g2" || bad "滚到底后未显示 g2"

# ---------------------------------------------------------------- 8. 正文抓取
head_ "8. -N 抓取正文并输出到终端（同样分屏）"
GUARD_OUT="$(printf -- '-1\n0\n' | timeout 60 python3 -m newscli -only weibo -no-color 2>&1)"
echo "$GUARD_OUT" | grep -q "还没有抓取任何平台" && ok "未抓取前输入 -N 有提示" || bad "未抓取前 -N 无提示"

ART_OUT="$(printf -- '\n-1\n0\n' | timeout 180 python3 -m newscli -only ithome -no-color -page 10 2>&1)"
echo "$ART_OUT" | grep -q "正在用本机网络抓取正文" && ok "触发了正文抓取" || bad "未触发正文抓取"
if echo "$ART_OUT" | grep -q "正文抓取失败"; then
    bad "正文抓取失败"
else
    ok "正文抓取没有报错"
fi
echo "$ART_OUT" | grep -qE "第 1 条 · 第 1/[0-9]+ 屏" && ok "正文分屏并带页码" || bad "正文缺少分屏页码"

# ---------------------------------------------------------------- 9. 浏览器与边界
head_ "9. 浏览器打开、越界与退出"
BROWSE_OUT="$(printf -- '\n-1 b\n0\n' | timeout 120 python3 -m newscli -only weibo -no-color 2>&1)"
echo "$BROWSE_OUT" | grep -q "在系统浏览器中打开" && ok "-N b 输出了待打开的链接" || bad "-N b 未输出链接"

OOB_OUT="$(printf -- '\n-9999\n0\n' | timeout 180 python3 -m newscli -only weibo -no-color 2>&1)"
echo "$OOB_OUT" | grep -q "越界" && ok "越界输入有提示" || bad "越界输入无提示"

QUIT_OUT="$(printf '0\n' | timeout 60 python3 -m newscli -only weibo -no-color 2>&1)"
echo "$QUIT_OUT" | grep -q "已退出 newscli" && ok "输入 0 可正常退出" || bad "输入 0 未能退出"

# ---------------------------------------------------------------- 汇总
head_ "验证结果"
echo "  通过 $PASS 项，失败 $FAIL 项"
if [ "$FAIL" -eq 0 ]; then
    echo "  ✅ 全部通过"
    exit 0
fi
echo "  ❌ 存在失败项，请检查上面的 [!!] 行"
exit 1
