'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
  clipboard,
  session,
} = require('electron');

const sources = require('./sources');
const { CHROME_UA } = require('./sources/http');

const CACHE_TTL = 3 * 60 * 1000; // 3 分钟内切换平台/刷新走内存缓存
const DETAIL_PARTITION = 'persist:hotspot-detail'; // 详情窗口独立持久分区，登录态可保留
const TOOLBAR_HEIGHT = 46;

let mainWindow = null;
const cache = new Map(); // id -> { items, error, at, elapsed }
const inflight = new Map(); // id -> Promise（同一平台的并发请求合并）
const detailWindows = new Map(); // url -> entry
const detailBySender = new Map(); // 工具条 webContents.id -> entry

// ---------------------------------------------------------------- 基础工具

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, data: await fn(event, ...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

async function pool(items, size, worker) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await worker(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, list.length)) }, run));
  return out;
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------- 封面图防盗链

// 各平台图床普遍校验 Referer，主窗口里直接 <img>/<div> 加载会拿到 403，
// 这里按图床域名补上对应站点的 Referer。
const IMAGE_REFERER_RULES = [
  [/(^|\.)ithome\.com$/i, 'https://www.ithome.com/'],
  [/(^|\.)toutiaoimg\.com$/i, 'https://www.toutiao.com/'],
  [/(^|\.)hdslb\.com$/i, 'https://www.bilibili.com/'],
  [/(^|\.)36krcdn\.com$/i, 'https://36kr.com/'],
  [/(^|\.)(byteacctimg|byteimg)\.com$/i, 'https://juejin.cn/'],
  [/(^|\.)zhimg\.com$/i, 'https://www.zhihu.com/'],
  [/(^|\.)(douyinpic|douyinstatic)\.com$/i, 'https://www.douyin.com/'],
  [/(^|\.)(bdstatic|bcebos)\.com$/i, 'https://top.baidu.com/'],
  [/(^|\.)(sinaimg|weibo)\.(cn|com)$/i, 'https://weibo.com/'],
  // ---- 新增资讯源 ----
  [/(^|\.)chinanews\.com(\.cn)?$/i, 'https://www.chinanews.com.cn/'],
  [/(^|\.)people\.com\.cn$/i, 'http://www.people.com.cn/'],
  [/(^|\.)(news|xinhuanet|xhscdn)\.cn$/i, 'http://www.news.cn/'],
  [/(^|\.)jiemian\.com$/i, 'https://www.jiemian.com/'],
  [/(^|\.)yna\.co\.kr$/i, 'https://cn.yna.co.kr/'],
  [/(^|\.)stheadline\.com$/i, 'https://www.stheadline.com/'],
  [/(^|\.)sputniknews\.cn$/i, 'https://sputniknews.cn/'],
  [/(^|\.)cnbcfm\.com$/i, 'https://www.cnbc.com/'],
  [/(^|\.)sspai\.com$/i, 'https://sspai.com/'],
  [/(^|\.)ifanr\.com$/i, 'https://www.ifanr.com/'],
  [/(^|\.)tmtpost\.com$/i, 'https://www.tmtpost.com/'],
  [/(^|\.)leiphone\.com$/i, 'https://www.leiphone.com/'],
  [/(^|\.)(oschina|oscdn)\.net$/i, 'https://www.oschina.net/'],
  [/(^|\.)infoq\.(cn|com)$/i, 'https://www.infoq.cn/'],
  [/(^|\.)cnblogs\.com$/i, 'https://www.cnblogs.com/'],
  [/(^|\.)(techcrunch|wordpress)\.com$/i, 'https://techcrunch.com/'],
  [/(^|\.)theverge\.com$/i, 'https://www.theverge.com/'],
  [/(^|\.)arstechnica\.(net|com)$/i, 'https://arstechnica.com/'],
  [/(^|\.)wired\.com$/i, 'https://www.wired.com/'],
  [/(^|\.)yystv\.(cn|com)$/i, 'https://www.yystv.cn/'],
  [/(^|\.)gcores\.com$/i, 'https://www.gcores.com/'],
  [/(^|\.)chuapp\.com$/i, 'https://www.chuapp.com/'],
  [/(^|\.)gamelook\.com\.cn$/i, 'http://www.gamelook.com.cn/'],
  [/(^|\.)ign\.com\.cn$/i, 'https://www.ign.com.cn/'],
  [/(^|\.)(steamstatic|steamcommunity|akamaihd)\.(com|net)$/i, 'https://store.steampowered.com/'],
];

function refererForHost(hostname) {
  if (!hostname) return null;
  for (const [re, ref] of IMAGE_REFERER_RULES) {
    if (re.test(hostname)) return ref;
  }
  return null;
}

function setupImageReferers(sess) {
  if (!sess || !sess.webRequest) return;
  try {
    sess.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const requestHeaders = details.requestHeaders;
      if (details.resourceType === 'image') {
        const ref = refererForHost(hostOf(details.url));
        if (ref) requestHeaders.Referer = ref;
      }
      callback({ requestHeaders });
    });
  } catch (err) {
    // 拦截失败只影响封面图显示，不影响榜单本身
    console.warn('[图片 Referer] 设置失败：', (err && err.message) || err);
  }
}

// ---------------------------------------------------------------- 抓取调度

function cachedRecord(id, force) {
  const rec = cache.get(id);
  if (!rec || force) return null;
  if (rec.error) return null; // 失败结果不复用，下次刷新会重试
  if (Date.now() - rec.at > CACHE_TTL) return null;
  return rec;
}

async function loadSource(id, force) {
  const hit = cachedRecord(id, force);
  if (hit) return { ...hit, cached: true };

  const running = inflight.get(id);
  if (running) return running;

  const task = sources
    .fetchSource(id)
    .then((res) => {
      const rec = { ...res, at: Date.now() };
      if (!res.error) cache.set(id, rec);
      return { ...rec, cached: false };
    })
    .finally(() => inflight.delete(id));

  inflight.set(id, task);
  return task;
}

// ---------------------------------------------------------------- 主窗口

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    backgroundColor: '#f2f4f7',
    show: false,
    title: '热点聚合查看器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 主窗口内任何 window.open 都交给详情窗口处理
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openDetailWindow({ url });
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------- 详情窗口

function openDetailWindow({ url, title } = {}) {
  const target = String(url || '').trim();
  if (!isHttpUrl(target)) throw new Error('无效的链接地址');

  const exist = detailWindows.get(target);
  if (exist && !exist.win.isDestroyed()) {
    if (exist.win.isMinimized()) exist.win.restore();
    exist.win.show();
    exist.win.focus();
    return { reused: true, id: exist.win.id };
  }

  const win = new BrowserWindow({
    width: 1140,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    show: false,
    backgroundColor: '#ffffff',
    title: title || '详情',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'detail-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  const detailSession = session.fromPartition(DETAIL_PARTITION);
  detailSession.setUserAgent(CHROME_UA);

  const view = new WebContentsView({
    webPreferences: {
      partition: DETAIL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    view.setBackgroundColor('#ffffff');
  } catch {
    /* 个别版本无此 API，忽略 */
  }
  view.webContents.setUserAgent(CHROME_UA);
  win.contentView.addChildView(view);

  const entry = { win, view, url: target, title: title || '', lastError: null };
  detailWindows.set(target, entry);

  // 必须提前记住工具条的 webContents id：窗口 closed 之后 win.webContents 已不可访问
  const toolbarWcId = win.webContents.id;
  detailBySender.set(toolbarWcId, entry);

  const send = (channel, payload) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  /** 把内嵌视图的当前状态整体快照出来，工具条据此渲染 */
  const snapshot = (extra = {}) => {
    const wc = view.webContents;
    const current = wc.isDestroyed() ? target : wc.getURL() || target;
    return {
      url: current,
      host: hostOf(current),
      title: wc.isDestroyed() ? title || '' : wc.getTitle(),
      loading: wc.isDestroyed() ? false : wc.isLoading(),
      canGoBack: wc.isDestroyed() ? false : wc.navigationHistory.canGoBack(),
      canGoForward: wc.isDestroyed() ? false : wc.navigationHistory.canGoForward(),
      error: entry.lastError,
      ...extra,
    };
  };

  const pushState = (extra) => send('detail:state', snapshot(extra));

  // 加载失败时把内嵌视图收成 0 高，露出窗口自带的错误提示界面
  const layout = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    if (entry.lastError) {
      view.setBounds({ x: 0, y: h, width: 0, height: 0 });
    } else {
      view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) });
    }
  };
  layout();
  win.on('resize', layout);

  // 供 IPC 在重试/回到首页时清除错误状态
  entry.clearError = () => {
    entry.lastError = null;
    layout();
    pushState({ loading: true, error: null });
  };
  entry.snapshot = snapshot;
  entry.send = send;

  view.webContents.on('did-start-loading', () => {
    entry.lastError = null;
    layout();
    pushState({ loading: true, error: null });
  });
  view.webContents.on('did-stop-loading', () => pushState({ loading: false }));
  view.webContents.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 是页面主动中断，不算失败
    entry.lastError = `${desc || '加载失败'}（${code}）`;
    layout();
    pushState({ loading: false, error: entry.lastError });
  });
  view.webContents.on('page-title-updated', (e, t) => {
    e.preventDefault();
    if (!win.isDestroyed()) win.setTitle(t);
    pushState();
  });
  view.webContents.on('did-navigate', () => pushState());
  view.webContents.on('did-navigate-in-page', () => pushState());
  view.webContents.on('will-navigate', () => pushState());

  // 详情页内的新窗口链接：留在同一个窗口里打开，避免窗口失控
  view.webContents.setWindowOpenHandler(({ url: inner }) => {
    if (isHttpUrl(inner)) {
      setImmediate(() => {
        if (!view.webContents.isDestroyed()) view.webContents.loadURL(inner).catch(() => {});
      });
    }
    return { action: 'deny' };
  });

  win.on('closed', () => {
    // 此处 win 已销毁，任何 win.webContents / win.setTitle 之类的访问都会抛
    // “Object has been destroyed”，并把窗口留在半销毁的僵尸状态。
    try {
      detailWindows.delete(target);
      detailBySender.delete(toolbarWcId);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      /* 窗口销毁过程中的清理失败可安全忽略 */
    }
  });

  // 工具条页面就绪后补发一次完整状态，避免早于工具条加载的事件丢失
  win.webContents.once('did-finish-load', () => send('detail:init', snapshot()));

  win.loadFile(path.join(__dirname, 'renderer', 'detail.html'));
  win.once('ready-to-show', () => win.show());
  view.webContents.loadURL(target, { userAgent: CHROME_UA }).catch(() => {});

  return { reused: false, id: win.id };
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  handle('app:info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  handle('sources:list', () => ({ groups: sources.getGroups(), sources: sources.getMeta() }));

  handle('hot:fetch', async (event, payload = {}) => {
    const wanted = Array.isArray(payload.ids) && payload.ids.length ? payload.ids : sources.ids();
    const force = Boolean(payload.force);
    const sender = event.sender;

    // 资讯类 RSS 源普遍很快，8 路并发能在几秒内抓完整个列表
    return pool(wanted, 8, async (id) => {
      const res = await loadSource(id, force);
      // 每抓完一个平台立刻推给界面，做到“边抓边显示”
      if (!sender.isDestroyed()) sender.send('hot:progress', res);
      return res;
    });
  });

  handle('hot:open', (_event, payload) => openDetailWindow(payload || {}));

  handle('hot:openExternal', async (_event, url) => {
    if (!isHttpUrl(url)) throw new Error('无效的链接地址');
    await shell.openExternal(String(url).trim());
    return true;
  });

  handle('hot:copy', (_event, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  // 主窗口 / 详情窗口通用窗口控制
  handle('win:min', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.minimize();
    return true;
  });
  handle('win:max', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  handle('win:close', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.close();
    return true;
  });
  handle('win:isMax', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    return Boolean(w && w.isMaximized());
  });

  // 详情窗口工具条
  handle('detail:control', (event, action) => {
    const entry = detailBySender.get(event.sender.id);
    if (!entry || entry.win.isDestroyed()) throw new Error('详情窗口已关闭');
    const wc = entry.view.webContents;

    switch (action) {
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case 'reload':
        entry.clearError(); // 重试前先清掉上一次的失败态
        wc.reload();
        break;
      case 'stop':
        wc.stop();
        pushLater(entry);
        break;
      case 'home':
        entry.clearError();
        wc.loadURL(entry.url, { userAgent: CHROME_UA }).catch(() => {});
        break;
      case 'external':
        shell.openExternal(wc.getURL()).catch(() => {});
        break;
      case 'copy':
        clipboard.writeText(wc.getURL());
        break;
      default:
        throw new Error(`未知的详情操作：${action}`);
    }
    return true;
  });

  handle('detail:current', (event) => {
    const entry = detailBySender.get(event.sender.id);
    if (!entry || entry.win.isDestroyed()) return null;
    return entry.snapshot();
  });
}

function pushLater(entry) {
  setTimeout(() => {
    if (entry && !entry.win.isDestroyed()) entry.send('detail:state', entry.snapshot());
  }, 60);
}

// ---------------------------------------------------------------- 生命周期

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('local.hotspot.viewer');
    setupImageReferers(session.defaultSession);
    registerIpc();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
