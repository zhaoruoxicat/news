# 热点聚合查看器

一个完全本地化的桌面热点查看器：用你自己的网络，直连微博 / 知乎 / 今日头条 / 百度 / 抖音 / B站 / IT之家 / 36氪 / 掘金 的公开热榜接口，以及 26 个国内外媒体与游戏站的官方 RSS，把当天热点汇总到一个界面里，点一下就能进原页面看内容。

**没有任何第三方中转服务，数据全部由本机直连各平台官方接口抓取。**


## 功能

- **35 个数据源、5 个分组**：
  - **实时热榜**（9 个）：微博热搜、知乎热榜、今日头条、百度热搜、抖音热搜、B站排行、IT之家、36氪热榜、掘金热榜
  - **国内媒体**（4 个）：中国新闻网、新华网、人民网、界面新闻
  - **国际媒体**（4 个）：韩联社中文、星岛头条（中国香港）、俄罗斯卫星通讯社中文、CNBC
  - **科技媒体**（12 个）：少数派、爱范儿、钛媒体、雷峰网、新浪科技、开源中国、InfoQ 中文、博客园、TechCrunch、The Verge、Ars Technica、Wired
  - **游戏**（6 个）：游研社、游研社·资讯、机核、触乐、GameLook、IGN 中国
- **两种视图**：「全部热点」按分组分区的卡片式汇总（每源前 8 条）+ 单源完整列表
- **跨平台搜索**：关键词过滤所有已加载的内容，命中部分高亮
- **内置详情窗口**：点击任意条目，在窗口内直接打开原页面（带返回 / 前进 / 刷新 / 浏览器打开 / 复制链接）
- **登录态保留**：详情窗口用独立的持久分区，在窗口里登录一次微博 / 知乎，之后就能直接看全文
- **自动刷新**：默认每 5 分钟一轮，可关闭；抓取是边抓边显示，不用等全部完成
- **容错**：单个源失败不影响其它源，卡片上给出原因和重试按钮；打不开的链接有明确错误界面而不是白屏
- **封面防盗链**：主进程按图床域名补 Referer，缩略图正常显示
- **编码识别**：请求层按 Content-Type / XML 声明自动识别 GBK 等老编码，中文不乱码

## 数据来源（均为本机直连）

### 实时热榜（平台公开接口）

| 平台 | 接口 | 说明 |
| --- | --- | --- |
| 微博热搜 | `weibo.com/ajax/side/hotSearch` | 剔除了广告位 |
| 知乎热榜 | `api.zhihu.com/topstory/hot-lists/total` | 移动端接口，可匿名访问 |
| 今日头条 | `toutiao.com/hot-event/hot-board/` | |
| 百度热搜 | `top.baidu.com/board?tab=realtime` | 从页面内嵌数据解析，拿得到真实搜索指数 |
| 抖音热搜 | `douyin.com/aweme/v1/web/hot/search/list/` | 带封面图 |
| B站排行 | `api.bilibili.com/x/web-interface/ranking/v2` | |
| IT之家 | `api.ithome.com/json/newslist/news` | |
| 36氪热榜 | `gateway.36kr.com/api/mis/nav/home/nav/rank/hot` | |
| 掘金热榜 | `api.juejin.cn/content_api/v1/content/article_rank` | |

### 资讯源（各站点官方 RSS）

26 个 RSS 源的配置集中在 `src/sources/feeds.js`，每个字段（feed 地址、分组、颜色、条数上限）一目了然，加一个源只需要加一段配置。全部经过本机实测：一次完整抓取 35 个源约 1000+ 条内容，耗时 9 秒左右（8 路并发）。

| 分组 | 源 |
| --- | --- |
| 国内媒体 | 中国新闻网、新华网、人民网、界面新闻 |
| 国际媒体 | 韩联社中文、星岛头条、俄罗斯卫星通讯社、CNBC |
| 科技媒体 | 少数派、爱范儿、钛媒体、雷峰网、新浪科技、开源中国、InfoQ 中文、博客园、TechCrunch、The Verge、Ars Technica、Wired |
| 游戏 | 游研社、游研社·资讯、机核、触乐、GameLook、IGN 中国 |

RSS 解析器（`src/sources/rss.js`）零依赖，兼容 RSS 2.0 / Atom / RDF，处理 CDATA、HTML 摘要、数字与命名实体、`media:content` 封面、正文首图封面、相对时间等脏数据场景，并有离线单元测试覆盖。

## 运行

### 开发模式

```bash
npm install        # Electron 二进制走 npmmirror 镜像，见下方环境变量
npm start
```

国内网络建议先设置镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

### 打包成 Windows 程序

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
npm run dist
```

产物在 `dist/`：
- `热点聚合查看器 Setup x64.exe` — 安装版
- `热点聚合查看器-免安装版.exe` — 免安装单文件
- `dist/win-unpacked/热点聚合查看器.exe` — 免解压直接跑，调试打包版用它最快

## 测试

```bash
npm run test:sources   # 数据层：9 个平台真实抓取 + 统一模型断言（node，秒级）
npm run test:smoke     # 端到端：真实启动主/渲染进程，走完整 IPC 与 DOM（electron）
npm run test:shot      # 截图：输出到 shots/
```

在 CI / 宿主进程也是 Electron 的环境里跑测试时，注意清除 `ELECTRON_RUN_AS_NODE`：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe test/smoke.js
```

## 目录结构

```
src/
├── main.js                 主进程：窗口、并发抓取、缓存、IPC、详情窗口（WebContentsView）
├── preload.js              主窗口 contextBridge
├── sources/                数据层（纯 Node，不依赖 electron，可独立单测）
│   ├── http.js             统一请求：UA 伪装 / 超时 / 重试 / GBK 等编码识别
│   ├── util.js             统一模型、热度格式化、文本清洗
│   ├── index.js            数据源注册表 + 分组定义 + 并发调度
│   ├── rss.js              通用 RSS/Atom/RDF 解析器（零依赖）
│   ├── feeds.js            26 个 RSS 资讯源配置（加源就在这里）
│   └── weibo.js / zhihu.js / toutiao.js / baidu.js / douyin.js / bilibili.js / ithome.js / kr36.js / juejin.js
└── renderer/
    ├── index.html / style.css / app.js     主界面（侧边栏与聚合视图均按分组展示）
    └── detail.html / detail.css / detail.js / detail-preload.js   详情窗口
test/
├── sources.test.js         数据层：RSS 解析器离线单测 + 全部源真实抓取断言
├── smoke.js                端到端：真实启动主/渲染进程，走完整 IPC 与 DOM
└── screenshot.js           截图：输出到 shots/
```

## 已知限制

- 抓的是**公开匿名接口与官方 RSS**，站点临时风控或改版会导致单个源抓不到，界面会明确提示原因，重试通常能恢复
- 微博 / 知乎的正文页需要登录才能看全文；详情窗口支持登录且登录态会保留（存在 `userData` 目录）
- **部分境外媒体无法收录**：BBC 中文、纽约时报中文网、FT 中文网、德国之声、卫报、半岛电视台、CNN、南华早报、明报、香港01 等在中国大陆网络下被 DNS 污染或连接阻断（实测均 `fetch failed`），收录的是本机可稳定直连的境外源（韩联社中文、星岛头条、Sputnik 中文、CNBC、TechCrunch、The Verge、Ars Technica、Wired）
- **小黑盒未收录**：其接口有自研签名校验（已在 `tools/` 下完成 hkey + HMAC 算法逆向，但服务端仍有其它参数校验未通过），网页版社区内容需要登录；游戏内容由游研社、机核、触乐、GameLook、IGN 中国覆盖
- **Steam 商店源已移除**：`store.steampowered.com` 在本机网络下被间歇性阻断（实测 5/5 失败），为保证整体体验不纳入
- 极简版**不做本地持久化**：重启后重新抓取，3 分钟内的内存缓存仅在运行期生效
- 内容来自各站点，工具本身不做任何筛选或排序处理，RSS 源按发布时间倒序展示

## 技术要点

- Electron 38 + 主进程抓取：主进程没有浏览器跨域限制，抓取逻辑纯粹是 Node 代码，可以脱离 Electron 单独跑单元测试
- 详情窗口用 `WebContentsView` 而不是 `<webview>`，工具条自绘、内嵌网页独立分区，且登录态持久化
- IPC 统一返回 `{ok, data, error}` 包装，preload 解包后失败即抛错，渲染层不用逐处判空
- 渲染层 CSP 锁死 `script-src 'self'`、`connect-src 'none'`：界面不发起任何网络请求，数据一律走 IPC
- 新增 RSS 源不需要写代码：在 `src/sources/feeds.js` 里加一段配置即可，解析、并发、容错、分组、侧边栏全部自动生效
