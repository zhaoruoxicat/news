# newscli —— 命令行热点新闻查看器

基于 `../news`（Electron 版「热点聚合查看器」）的**同一套数据源原理**，用 Python
标准库重写的纯命令行版本：本机网络直连各平台公开热榜接口与官方 RSS，在终端里
逐个平台浏览热点标题，并可直接抓取正文或用系统浏览器打开原链接。

**零第三方依赖**（只用 Python 标准库），已打包为 Ubuntu/deb 安装包。

```
newscli 已启动。
共 35 个数据源。启动时不抓取任何内容，按回车才逐个平台抓取，以节省网络。
回车=抓取下一个平台  -N=看第N条正文  -N b=浏览器打开  0=退出
命令>                      ← 启动只提示，不联网；按回车才开始抓

正在抓取第 1/35 个平台：微博热搜 …
g1.微博热搜  （共 50 条 · 第 1/3 屏）      ← 一次只输出一屏
1. 警方通报王皓被围堵辱骂处理结果  [爆] 1514.4万热度
2. 两名内地女学生在澳门非法旅拍被捕  [热] 224.9万热度
3. 卫星互联网低轨27组卫星成功发射  178.8万热度
...（本屏放 18 条，由终端高度决定，绝不一次刷满 50 条）
回车=向下滚动（还有 2 页）  -N=看第N条正文  -N b=浏览器打开  0=退出
命令>                      ← 本平台翻完后，回车才抓下一个平台
```

## 启动不联网，逐平台抓取

启动时**不发起任何网络请求**，只打印「已启动」和待抓数量。之后每按一次回车，
才**按顺序抓取一个平台**（一次只抓一个，抓不到内容的平台自动跳过并提示原因）：

- 省资源：只为你真正要看的平台付出一次联网开销，不会一上来就并发打 35 个站点；
- 平台编号 `g1` `g2` `g3`… 按**实际抓取成功的顺序**递增，没有空号；
- 全部平台抓完一轮后，再按回车会**重新从第一个平台开始**（相当于刷新）；
- 想只看某几个平台：`-only weibo,ithome`。

## 分屏显示

任何一次输出都只占**一屏**，行数 = 终端高度 − 6（用 `-page N` 可手动指定）：

- 平台内的标题**按屏滚动**，序号是绝对编号（1…50），跨屏不变，`-N` 直接按列表里的编号取；
- 当前平台**滚到底后**再按回车，才抓取并显示下一个平台；
- 标题栏显示 `共 50 条 · 第 2/3 屏`，提示行会告诉你本平台还剩几屏；
- `-N` 抓到的**正文同样分屏**，一屏一屏往下翻，翻完自动回到当前平台的列表。

## 交互命令

| 输入 | 作用 |
| --- | --- |
| `回车` | 当前平台还有下一屏就向下滚动一屏；否则抓取并显示下一个平台 |
| `-N` | 抓取并显示「当前平台第 N 条」的正文（模拟浏览器取回文章页 → 转纯文本、分屏输出） |
| `-N b` | 用系统浏览器打开「当前平台第 N 条」的链接 |
| `0` | 退出程序（也接受 `q` / `quit` / `exit`） |

例如当前停在 `g1.微博热搜` 时：`-1` 看第 1 条正文，`-1 b` 用浏览器打开第 1 条。
尚未抓取任何平台时输入 `-N`，会提示先按回车抓一个平台。

## 运行

### 源码树里直接跑

```bash
cd CLI
./newscli.sh            # 等价于 python3 -m newscli
python3 -m newscli -h   # 查看帮助
```

### 命令行选项

```
-h, --help        显示帮助
-v, --version     显示版本号
-page N           每屏显示 N 行（默认按终端高度自动计算，约「终端行数 − 6」）
-only LIST        只抓取指定数据源（逗号分隔 id），例如 -only weibo,ithome,chinanews
-no-color         关闭彩色输出（输出不是终端时自动关闭）
```

## 安装 deb

```bash
./build-deb.sh                 # 产物：packaging/build/newscli_1.0.0_all.deb
sudo dpkg -i packaging/build/newscli_1.0.0_all.deb
newscli                        # 安装后直接运行
man newscli                    # 查看手册
```

安装布局：

| 路径 | 内容 |
| --- | --- |
| `/usr/bin/newscli` | 启动器（薄壳，把 `/opt/newscli` 加进 `sys.path`） |
| `/opt/newscli/newscli/` | Python 包本体 |
| `/usr/share/man/man1/newscli.1.gz` | 手册页 |
| `/usr/share/doc/newscli/copyright` | 版权信息 |

依赖只有 `python3 (>= 3.8)` 与 `ca-certificates`，没有任何 `python3-*` 第三方包。

## 验证

```bash
./verify-deb.sh
```

在**无 root、无显示**的环境里用 `dpkg-deb -x` 解包，直接运行「包里的那份代码」，
共 46 项断言：控制字段与依赖、包内布局（无 `__pycache__` / `.Trash-0`）、维护脚本
不会误删用户数据、**启动时确实没有联网抓取**、一次回车只抓一个平台、
按终端高度自动分屏、回车滚动与滚到底后抓取下一个平台、`-N` 抓正文（分屏）、
`-N b` 打开链接、未抓取前 `-N` 有提示、越界提示与 `0` 退出。
全部通过后输出 `✅ 全部通过`。

## 打包源码 zip（用于开源分发）

```bash
./make-zip.sh                  # 产物：dist/newscli-1.0.0-src.zip（约 47 KB / 26 个文件）
./make-zip.sh --full-verify    # 额外跑一遍完整 verify-deb.sh（真实联网，较慢）
./make-zip.sh --no-verify      # 只打包
```

- 只收录**源码与打包脚本**，用 `zipfile` 精确控制，自动排除
  `__pycache__` / `*.pyc` / `packaging/build/` / `*.deb` / `.tmp/` / `.verify/` / `.Trash-0`；
- 顶层套一层 `newscli-1.0.0/`，解压不会散落一地，并保留脚本的可执行位；
- 打完先**自检**包内不含任何产物，再**解压到干净目录实跑一遍**：
  `python3 -m newscli -v`、`-h`，并重新构建一次 deb ——
  确保「本地能跑」真的等于「交付的包里能跑」；
- `--full-verify` 还会在解压目录里跑完 46 项端到端验证。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 数据来源（均为本机直连）

### 实时热榜（9 个平台公开接口）

| 平台 | 接口 |
| --- | --- |
| 微博热搜 | `weibo.com/ajax/side/hotSearch`（剔除广告位） |
| 知乎热榜 | `api.zhihu.com/topstory/hot-lists/total` |
| 今日头条 | `toutiao.com/hot-event/hot-board/` |
| 百度热搜 | `top.baidu.com/board?tab=realtime`（页面内嵌数据，含真实搜索指数） |
| 抖音热搜 | `douyin.com/aweme/v1/web/hot/search/list/` |
| B站排行 | `api.bilibili.com/x/web-interface/ranking/v2` |
| IT之家 | `api.ithome.com/json/newslist/news` |
| 36氪热榜 | `gateway.36kr.com/api/mis/nav/home/nav/rank/hot` |
| 掘金热榜 | `api.juejin.cn/content_api/v1/content/article_rank` |

### 资讯源（26 个官方 RSS）

- **国内媒体**：中国新闻网、新华网、人民网、界面新闻
- **国际媒体**：韩联社中文、星岛头条（中国香港）、俄罗斯卫星通讯社中文、CNBC
- **科技媒体**：少数派、爱范儿、钛媒体、雷峰网、新浪科技、开源中国、InfoQ 中文、博客园、TechCrunch、The Verge、Ars Technica、Wired
- **游戏**：游研社、游研社·资讯、机核、触乐、GameLook、IGN 中国

加一个 RSS 源只需在 `newscli/feeds.py` 里加一段配置，解析、并发、容错全部自动生效。

## 目录结构

```
CLI/
├── newscli/
│   ├── __init__.py       版本号唯一来源
│   ├── __main__.py       python3 -m newscli 入口
│   ├── cli.py            交互界面（逐平台抓取 / 分屏滚动 / 命令解析 / 着色与折行）
│   ├── net.py            统一请求层：UA 伪装 / 超时重试 / GBK 编码识别 / gzip / 中文 URL 编码
│   ├── util.py           统一模型、热度格式化、文本清洗
│   ├── rss.py            零依赖 RSS / Atom / RDF 解析器
│   ├── feeds.py          26 个 RSS 资讯源配置
│   ├── hotsources.py     9 个平台热榜源
│   ├── registry.py       数据源注册表 + 分组定义
│   └── article.py        正文抽取（模拟浏览器 + HTML 转终端纯文本）
├── packaging/
│   ├── Makefile          组装目录树 + dpkg-deb
│   ├── debian/           control.in / 维护脚本 / 手册页 / 启动器 / copyright
│   └── make_source_zip.py  纯源码 zip 打包器（含解压实跑自检）
├── newscli.sh            源码树启动脚本
├── build-deb.sh          一键构建 deb → packaging/build/
├── verify-deb.sh         解包后 46 项端到端验证
├── make-zip.sh           一键打包开源源码 zip → dist/
├── LICENSE               MIT
├── .gitignore
└── README.md
```

## 实现要点

- **模块刻意命名为 `net.py` 而非 `http.py`**：`urllib.request` 内部会
  `import http.client`，项目里若有同名 `http.py` 会把标准库遮蔽掉，直接报
  `No module named 'http.client'`。
- **中文 URL 必须先做百分号编码**：`urllib` 构造请求时按 ASCII 编码 URL，
  遇到含中文的路径（如星岛头条的部分链接）会抛 `UnicodeEncodeError`，
  `net._encode_url` 统一处理。
- **正文抽取用「阅读模式」思路**：先删脚本/样式/注释/导航/评论等噪声容器，
  再在带内容语义的容器里选出「信息量最大且没有嵌套同等信息量容器」的那个，
  按块级标签断行、还原实体，得到段落列表。
  - 噪声判定按**词元**匹配并识别否定前缀：`<body class="… no-navbar …">`
    里的 `navbar` 不会被当成导航删掉（这个坑会让整页正文消失）。
  - `html` / `body` / `article` / `main` 被列为受保护标签，任何情况下都不整段丢弃。
- **单个源失败不影响其它源**：抓取失败只在该源上标记原因，其余照常展示。
- **构建刻意不使用 `rm`**：受限沙箱里 `rm` 会被替换成「移入回收站」，既会在仓库里
  留下 `.Trash-0` 又可能被批量删除钩子拦下；`Makefile` 用 `tar --exclude` 做干净
  暂存，`build-deb.sh` 用 `mv` 清理旧产物。

## 已知限制

- 抓的是**公开匿名接口与官方 RSS**，站点临时风控或改版会导致个别源抓不到。
  实测 B站排行经常返回风控码 `-352`，属正常现象，程序会跳过该源并提示原因。
- 完全由脚本渲染的页面（如部分 SPA 站点）取不到正文；此时程序会提示改用
  `-N b` 在浏览器中打开原链接。
- 微博 / 知乎的正文页需要登录才能看全文，命令行版本不做登录态保留。
- 内容来自各站点，工具本身不做筛选或排序处理，RSS 源按发布时间倒序展示。
