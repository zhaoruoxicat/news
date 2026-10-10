# newscli —— 组装 Debian 包目录树并打包
#
# 用法（在 packaging/ 目录下）:  make deb
# 产物:                        packaging/build/newscli_<版本>_all.deb
#
# 说明: 本 Makefile 刻意不使用 rm/rmtree —— 在受限沙箱里 rm 会被替换成
#       「移入回收站」，既会污染仓库又可能被批量删除钩子拦下。清理旧产物
#       由上层 build-deb.sh 用 mv 完成，因此这里只做「创建 + 覆盖」。

PKG      := newscli
ROOT_SRC := $(abspath $(CURDIR)/..)
VERSION  := $(shell python3 -c "import re,sys;print(re.search(r'__version__\s*=\s*\"([^\"]+)\"', open('$(ROOT_SRC)/$(PKG)/__init__.py').read()).group(1))")
PYSRC    := $(ROOT_SRC)/$(PKG)
BUILD    := $(CURDIR)/build
DEST     := $(BUILD)/$(PKG)_$(VERSION)_all
DEB      := $(BUILD)/$(PKG)_$(VERSION)_all.deb

.PHONY: all deb stage control clean

all: deb

deb: stage control
	dpkg-deb --root-owner-group --build "$(DEST)" "$(DEB)"
	@echo "==> 已生成: $(DEB)"

# 控制文件从 control.in 生成，版本号只在 __init__.py 一处维护
control:
	@mkdir -p "$(DEST)/DEBIAN"
	@sed -e "s/@VERSION@/$(VERSION)/g" debian/control.in > "$(DEST)/DEBIAN/control"

stage:
	@mkdir -p "$(DEST)/DEBIAN" \
	          "$(DEST)/opt/$(PKG)/$(PKG)" \
	          "$(DEST)/usr/bin" \
	          "$(DEST)/usr/share/man/man1" \
	          "$(DEST)/usr/share/doc/$(PKG)"
	tar -C "$(PYSRC)" --exclude='__pycache__' --exclude='*.pyc' -cf - . \
	  | tar -C "$(DEST)/opt/$(PKG)/$(PKG)" -xf -
	install -m 0755 debian/$(PKG)-launcher "$(DEST)/usr/bin/$(PKG)"
	sed -e "s/@VERSION@/$(VERSION)/g" debian/$(PKG).1 | gzip -9cn > "$(DEST)/usr/share/man/man1/$(PKG).1.gz"
	install -m 0644 debian/copyright "$(DEST)/usr/share/doc/$(PKG)/copyright"
	install -m 0755 debian/postinst "$(DEST)/DEBIAN/postinst"
	install -m 0755 debian/prerm    "$(DEST)/DEBIAN/prerm"
	install -m 0755 debian/postrm   "$(DEST)/DEBIAN/postrm"

# 正常系统上的一键清理（沙箱里请用 build-deb.sh，它会改用 mv）
clean:
	rm -rf "$(BUILD)"
