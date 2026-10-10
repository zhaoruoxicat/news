'use strict';

// 同 app.js：window.detailBridge 是不可配置全局属性，这里必须换个名字
const BRIDGE = window.detailBridge;

const el = {
  back: document.getElementById('btn-back'),
  forward: document.getElementById('btn-forward'),
  reload: document.getElementById('btn-reload'),
  external: document.getElementById('btn-external'),
  copy: document.getElementById('btn-copy'),
  close: document.getElementById('btn-close'),
  host: document.getElementById('host'),
  pageTitle: document.getElementById('page-title'),
  titleSep: document.getElementById('title-sep'),
  siteDot: document.getElementById('site-dot'),
  progress: document.getElementById('progress'),
  hint: document.getElementById('hint'),
  error: document.getElementById('error'),
  errorMsg: document.getElementById('error-msg'),
  retryLoad: document.getElementById('btn-retry-load'),
  extLoad: document.getElementById('btn-ext-load'),
};

// 按域名给地址栏小圆点上色，让用户一眼知道在看哪个站点
const HOST_COLORS = [
  [/weibo\.com/i, '#e6162d'],
  [/zhihu\.com|zhimg\.com/i, '#0084ff'],
  [/toutiao\.com/i, '#ed4040'],
  [/baidu\.com|bdstatic\.com|baidu\.cn/i, '#2932e1'],
  [/douyin\.com|iesdouyin\.com/i, '#fe2c55'],
  [/bilibili\.com|b23\.tv/i, '#fb7299'],
  [/ithome\.com/i, '#e60012'],
  [/36kr\.com/i, '#1e6fff'],
  [/juejin\.cn/i, '#1e80ff'],
];

function colorFor(host) {
  for (const [re, color] of HOST_COLORS) {
    if (re.test(host)) return color;
  }
  return '#c8d0dc';
}

function render(state) {
  if (!state) return;

  const url = state.url || '';
  const host = state.host || '';
  const title = state.title || '';

  el.host.textContent = host || '正在打开…';
  el.siteDot.style.background = colorFor(host);

  // 页面标题里通常已经带了站点名，去掉冗余后缀
  const cleanTitle = title.replace(/\s*[-_|·]\s*(微博|知乎|今日头条|百度|抖音|哔哩哔哩|IT之家|36氪|掘金)\s*$/i, '').trim();
  const showTitle = cleanTitle && cleanTitle !== host;
  el.pageTitle.textContent = showTitle ? cleanTitle : '';
  el.titleSep.hidden = !showTitle;
  document.title = title || host || '详情';

  el.back.disabled = !state.canGoBack;
  el.forward.disabled = !state.canGoForward;

  const loading = Boolean(state.loading);
  el.progress.hidden = !loading;
  el.reload.title = loading ? '停止加载' : '刷新';

  if (state.error) {
    el.error.hidden = false;
    el.hint.hidden = true;
    el.errorMsg.textContent = `${state.error}${url ? '\n' + url : ''}`;
  } else if (loading) {
    el.error.hidden = true;
    el.hint.hidden = false;
  } else {
    el.error.hidden = true;
    el.hint.hidden = true;
  }
}

function bind() {
  el.back.addEventListener('click', () => BRIDGE.control('back'));
  el.forward.addEventListener('click', () => BRIDGE.control('forward'));
  el.reload.addEventListener('click', async () => {
    const cur = await BRIDGE.current().catch(() => null);
    BRIDGE.control(cur && cur.loading ? 'stop' : 'reload');
  });
  el.external.addEventListener('click', () => BRIDGE.control('external'));
  el.copy.addEventListener('click', () => BRIDGE.control('copy'));
  el.close.addEventListener('click', () => BRIDGE.win.close());
  el.retryLoad.addEventListener('click', () => BRIDGE.control('reload'));
  el.extLoad.addEventListener('click', () => BRIDGE.control('external'));

  // 双击空白区域切换最大化，符合桌面习惯（只会落在被覆盖前的短暂瞬间）
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      BRIDGE.control('reload');
    } else if (e.key === 'Escape') {
      BRIDGE.win.close();
    } else if (e.key === 'F5') {
      e.preventDefault();
      BRIDGE.control('reload');
    } else if (mod && e.key.toLowerCase() === 'c' && e.shiftKey) {
      e.preventDefault();
      BRIDGE.control('copy');
    }
  });

  BRIDGE.onInit(render);
  BRIDGE.onState(render);
}

bind();

// 兜底：窗口刚打开时先拉一次当前状态
BRIDGE.current().then(render).catch(() => {});
