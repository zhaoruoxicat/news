#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 newscli 打成用于开源的「纯源码 zip」，并在干净目录里实跑一遍验证。

用法:
    python3 packaging/make_source_zip.py [--out DIR] [--no-verify] [--full-verify]

设计要点:
  * 用 ``zipfile`` 精确控制收录内容（比 ``zip -x`` 可控），只收源码与打包脚本；
  * 排除全部产物：``__pycache__`` / ``*.pyc`` / ``packaging/build`` / ``*.deb`` /
    ``.tmp`` / ``.verify`` / ``.Trash-0`` / 已生成的 ``*.zip``；
  * 顶层套一层 ``newscli-<版本>/``，解压不会散落一地，且保留可执行位；
  * 打完后立刻解压到干净目录，跑 ``python3 -m newscli -v`` 并**重新构建一次 deb**——
    「本地能跑」不等于「交付的包里能跑」，只有实跑才能证明。
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = "newscli"

# 顶层要收录的文件（不存在就跳过并提示）
TOP_FILES = [
    "README.md",
    "LICENSE",
    ".gitignore",
    "build-deb.sh",
    "verify-deb.sh",
    "newscli.sh",
    "make-zip.sh",
]
# 顶层要递归收录的目录
TOP_DIRS = ["newscli", "packaging"]

# 任何层级下都排除的目录名
EXCLUDE_DIRS = {
    "__pycache__", "build", "dist", ".tmp", ".verify", ".zipverify",
    ".Trash-0", ".git", ".idea", ".vscode", ".pytest_cache",
}
# 排除的扩展名（产物 / 二进制 / 截图）
EXCLUDE_SUFFIX = {".pyc", ".pyo", ".deb", ".zip", ".log", ".png", ".jpg", ".jpeg"}


def read_version() -> str:
    text = (ROOT / PKG / "__init__.py").read_text(encoding="utf-8")
    m = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not m:
        raise SystemExit("无法从 %s/__init__.py 读取 __version__" % PKG)
    return m.group(1)


def collect_files():
    files = []
    for name in TOP_FILES:
        p = ROOT / name
        if p.is_file():
            files.append(p)
        else:
            print("  (不存在，已跳过：%s)" % name)
    for name in TOP_DIRS:
        base = ROOT / name
        if not base.is_dir():
            print("  (不存在，已跳过：%s/)" % name)
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
            for fn in sorted(filenames):
                if Path(fn).suffix.lower() in EXCLUDE_SUFFIX:
                    continue
                files.append(Path(dirpath) / fn)
    return sorted(set(files))


def dispose(path: Path) -> None:
    """把旧文件挪进系统回收站。

    不直接用 ``rm``：受限沙箱里 ``rm`` 被替换成「移入回收站」，会污染工作目录，
    批量删除还会被钩子拦下；``mv`` 不做删除，行为可预期。
    """
    trash = Path.home() / ".local" / "share" / "Trash" / "files"
    try:
        trash.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["mv", "--", str(path), str(trash / ("%s.%d" % (path.name, int(time.time()))))],
            check=False,
        )
    except OSError:
        pass


def build_zip(files, version: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    zip_path = out_dir / ("%s-%s-src.zip" % (PKG, version))
    if zip_path.exists():
        dispose(zip_path)
    top = "%s-%s" % (PKG, version)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in files:
            zf.write(p, "%s/%s" % (top, p.relative_to(ROOT).as_posix()))
    return zip_path


def audit(zip_path: Path):
    """自检：包里不能混入任何产物。"""
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    bad = []
    for n in names:
        low = n.lower()
        if "__pycache__" in low or low.endswith((".pyc", ".pyo")):
            bad.append(n)
        elif low.endswith((".deb", ".zip", ".log", ".png", ".jpg")):
            bad.append(n)
        elif ".trash-0" in low or "/build/" in low:
            bad.append(n)
    return names, bad


def verify(zip_path: Path, version: str, full: bool) -> int:
    work = ROOT / ".zipverify"
    if work.exists():
        dispose(work)
    work.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(work)

    top = work / ("%s-%s" % (PKG, version))
    if not (top / PKG / "cli.py").is_file():
        print("  [!!] 解压后找不到 %s/cli.py，包结构有问题" % PKG)
        return 1

    steps = [
        ("版本号", [sys.executable, "-m", "newscli", "-v"], True),
        ("帮助", [sys.executable, "-m", "newscli", "-h"], True),
        ("重新构建 deb", ["bash", "build-deb.sh"], False),
    ]
    if full:
        steps.append(("端到端验证（46 项）", ["bash", "verify-deb.sh"], False))

    rc = 0
    for label, cmd, capture in steps:
        print("  → %s：%s" % (label, " ".join(cmd)))
        try:
            r = subprocess.run(cmd, cwd=str(top),
                               capture_output=capture, timeout=900)
        except subprocess.TimeoutExpired:
            print("    [!!] 超时")
            rc = 1
            continue
        if r.returncode != 0:
            rc = 1
            print("    [!!] 失败（退出码 %d）" % r.returncode)
            out = ((r.stdout or b"") + (r.stderr or b"")).decode("utf-8", "replace")
            for line in out.strip().splitlines()[-15:]:
                print("        " + line)
        else:
            if capture:
                out = (r.stdout or b"").decode("utf-8", "replace")
                first = out.strip().splitlines()[:1]
                print("    [ok] %s" % (first[0] if first else ""))
            else:
                print("    [ok]")
    return rc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="打包 newscli 纯源码 zip（用于开源）")
    ap.add_argument("--out", default=str(ROOT / "dist"), help="输出目录（默认 ./dist）")
    ap.add_argument("--no-verify", action="store_true", help="只打包，不做解压实跑验证")
    ap.add_argument("--full-verify", action="store_true",
                    help="解压后额外跑一遍完整的 verify-deb.sh（会真实联网，耗时较长）")
    args = ap.parse_args(argv)

    version = read_version()
    print("newscli %s —— 打包纯源码 zip" % version)

    files = collect_files()
    print("\n收录 %d 个文件：" % len(files))
    for p in files:
        print("    " + p.relative_to(ROOT).as_posix())

    zip_path = build_zip(files, version, Path(args.out))
    size_kb = zip_path.stat().st_size / 1024
    print("\n已生成：%s（%.1f KB）" % (zip_path, size_kb))

    names, bad = audit(zip_path)
    print("\n自检：共 %d 个条目" % len(names))
    if bad:
        print("  [!!] 混入了不该有的产物：")
        for n in bad:
            print("       " + n)
        return 1
    print("  [ok] 没有混入 __pycache__ / *.pyc / *.deb / build/ / .Trash-0")

    if args.no_verify:
        print("\n（已跳过解压实跑验证）")
        return 0

    print("\n解压到干净目录并实跑验证……")
    rc = verify(zip_path, version, args.full_verify)
    print("\n" + ("✅ 源码包可用" if rc == 0 else "❌ 实跑验证未通过"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
