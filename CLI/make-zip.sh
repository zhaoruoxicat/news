#!/usr/bin/env bash
# 打包用于开源的纯源码 zip。
#
#   ./make-zip.sh                 打包 + 解压到干净目录实跑一遍（含重建 deb）
#   ./make-zip.sh --full-verify   额外跑一遍完整 verify-deb.sh（真实联网，较慢）
#   ./make-zip.sh --no-verify     只打包
#
# 产物：dist/newscli-<版本>-src.zip
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$HERE/packaging/make_source_zip.py" "$@"
