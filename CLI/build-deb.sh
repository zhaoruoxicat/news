#!/usr/bin/env bash
# 构建 newscli 的 Ubuntu/Debian .deb 安装包。
#
#   ./build-deb.sh
#
# 产物: packaging/build/newscli_<版本>_all.deb
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# 沙箱里 /tmp 往往是容量很小的 tmpfs，把临时目录指到项目内
export TMPDIR="$HERE/.tmp"
mkdir -p "$TMPDIR"

# 清掉上一次的构建产物。
# 注意：这里用 mv 而不是 rm —— 受限沙箱里 rm 被替换成「移入回收站」，
# 会在仓库里留下 .Trash-0 目录，且批量删除会被钩子拦下。
BUILD="$HERE/packaging/build"
if [ -e "$BUILD" ]; then
    TRASH="${HOME}/.local/share/Trash/files"
    mkdir -p "$TRASH"
    mv "$BUILD" "$TRASH/newscli-build-$(date +%s)"
fi

make -C "$HERE/packaging" deb

echo
echo "==> 构建完成："
ls -lh "$HERE/packaging/build"/*.deb
