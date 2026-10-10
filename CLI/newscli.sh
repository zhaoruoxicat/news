#!/bin/sh
# 源码树里的启动脚本：等价于 `python3 -m newscli`。
# 安装 deb 之后，系统里用的是 /usr/bin/newscli（见 packaging/debian/newscli-launcher）。
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec env PYTHONPATH="$DIR${PYTHONPATH:+:$PYTHONPATH}" python3 -m newscli "$@"
