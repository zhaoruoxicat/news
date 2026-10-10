'use strict';

// 注意：window.hotspot 是 contextBridge 暴露的不可配置全局属性，
// 这里必须换一个名字（API），否则顶层 const 声明会抛 SyntaxError 导致脚本整体失效。
const API = window.hotspot;

const AUTO_INTERVAL = 5 * 60 * 1000;
const CARD_PREVIEW = 8;
const SEARCH_LIMIT = 200;
const LS_AUTO = 'hotspot.autoRefresh';
const LS_VIEW = 'hotspot.view';

const state = {
  metas: [],
  groups: [],
  data: new Map(), // id -> { id, name, color, initial, homepage, items, error, at, elapsed }
  view: 'all',
  query: '',
  loading: false,
  auto: true,
  lastAt: 0,
  nextAt: 0,
  ready: false,
};

const el = {
  sideList: document.getElementById('side-list'),
  sideTotal: document.getElementById('side-total'),
  content: document.getElementById('content'),
  viewHead: document.getElementById('view-head'),
  search: document.getElementById('search'),
  searchBox: document.querySelector('.search'),
  searchClear: document.getElementById('search-clear'),
  autoRefresh: document.getElementById('auto-refresh'),
  refreshBtn: document.getElementById('btn-refresh'),
  refreshText: document.getElementById('refresh-text'),
  refreshAll: document.getElementById('btn-refresh-all'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  statusMeta: document.getElementById('status-meta'),
  toast: document.getElementById('toast'),
};

// ---------------------------------------------------------------- 基础工具

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 转义后再把命中的关键词包成 <mark> */
function highlight(text, query) {
  const safe = escapeHtml(text);
  const q = String(query || '').trim();
  if (!q) return safe;
  try {
    return safe.replace(new RegExp(`(${escapeRegExp(escapeHtml(q))})`, 'gi'), '<mark>$1</mark>');
  } catch {
    return safe;
  }
}

function timeText(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function tagClass(tag) {
  const t = String(tag || '').trim();
  if (!t) return '';
  if (['爆', '沸', '热', '新', '置顶'].includes(t)) return t;
  return '';
}

let toastTimer = null;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => {
      el.toast.hidden = true;
    }, 220);
  }, 2200);
}

// ---------------------------------------------------------------- 渲染调度

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderSidebar();
    renderHead();
    renderContent();
    renderStatus();
  });
}

// ---------------------------------------------------------------- 侧边栏

function visibleMetas() {
  return state.metas;
}

/** 把平台按分组切好，分组顺序与主进程给出的保持一致 */
function groupedMetas() {
  const groups = state.groups.length
    ? state.groups
    : [{ id: '', name: '', desc: '' }];
  const out = [];
  for (const g of groups) {
    const metas = g.id ? state.metas.filter((m) => m.group === g.id) : state.metas;
    if (metas.length) out.push({ group: g, metas });
  }
  // 兜底：分组信息缺失时仍要能看到全部平台
  const covered = new Set(out.flatMap((o) => o.metas.map((m) => m.id)));
  const rest = state.metas.filter((m) => !covered.has(m.id));
  if (rest.length) out.push({ group: { id: '_rest', name: '其它', desc: '' }, metas: rest });
  return out;
}

function navItemHtml(m) {
  const rec = state.data.get(m.id);
  const count = rec?.items?.length || 0;
  const err = Boolean(rec?.error);
  const loading = state.loading && !rec;
  return `
    <button class="nav-item ${state.view === m.id ? 'active' : ''} ${err ? 'error' : ''}"
            data-view="${escapeHtml(m.id)}" title="${escapeHtml(m.name)}" role="tab">
      <span class="nav-badge" style="background:${escapeHtml(m.color)}">${escapeHtml(m.initial)}</span>
      <span class="nav-name">${escapeHtml(m.name)}</span>
      <span class="nav-count">${err ? '失败' : loading ? '…' : count || '—'}</span>
    </button>
  `;
}

function renderSidebar() {
  const totalItems = [...state.data.values()].reduce((s, r) => s + (r.items?.length || 0), 0);
  el.sideTotal.textContent = totalItems ? `${totalItems} 条` : '—';

  const parts = [];

  parts.push(`
    <button class="nav-item ${state.view === 'all' ? 'active' : ''}" data-view="all" role="tab">
      <span class="nav-badge all">全</span>
      <span class="nav-name">全部热点</span>
      <span class="nav-count">${totalItems || '—'}</span>
    </button>
  `);

  for (const { group, metas } of groupedMetas()) {
    if (group.name) {
      parts.push(
        `<div class="nav-group">${escapeHtml(group.name)}<span>${metas.length}</span></div>`
      );
    }
    for (const m of metas) parts.push(navItemHtml(m));
  }

  el.sideList.innerHTML = parts.join('');
}

// ---------------------------------------------------------------- 标题区

function renderHead() {
  if (state.query.trim()) {
    el.viewHead.hidden = false;
    const n = collectSearch().length;
    el.viewHead.innerHTML = `
      <h2>搜索结果</h2>
      <span class="vh-meta">关键词“${escapeHtml(state.query.trim())}”命中 ${n} 条</span>
      <a class="vh-link" href="#" data-clear="1">清空搜索</a>
    `;
    return;
  }

  if (state.view === 'all') {
    el.viewHead.hidden = true;
    el.viewHead.innerHTML = '';
    return;
  }

  const meta = state.metas.find((m) => m.id === state.view);
  const rec = state.data.get(state.view);
  if (!meta) {
    el.viewHead.hidden = true;
    return;
  }
  el.viewHead.hidden = false;
  el.viewHead.innerHTML = `
    <h2><span class="vh-dot" style="background:${escapeHtml(meta.color)}"></span>${escapeHtml(meta.name)}</h2>
    <span class="vh-meta">${rec?.items?.length || 0} 条 · ${rec?.at ? '更新于 ' + timeText(rec.at) : '尚未抓取'}${
      rec?.elapsed ? ` · 耗时 ${rec.elapsed}ms` : ''
    }</span>
    <a class="vh-link" href="${escapeHtml(meta.homepage)}" data-ext="${escapeHtml(
      meta.homepage
    )}">前往官网榜单 ↗</a>
  `;
}

// ---------------------------------------------------------------- 条目渲染

function rowHtml(item, opts = {}) {
  const tag = tagClass(item.tag);
  const rankCls = item.rank <= 3 ? ` r${item.rank}` : '';
  const heat = item.heatText ? ` <span class="heat">${escapeHtml(item.heatText)}</span>` : '';
  return `
    <div class="row" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}" tabindex="0">
      <span class="rk${rankCls}">${item.rank}</span>
      <span class="title" title="${escapeHtml(item.title)}">${highlight(item.title, opts.query)}</span>
      ${tag ? `<span class="tag ${tag}">${escapeHtml(tag)}</span>` : ''}
      ${heat}
      <span class="open-ext" data-ext="${escapeHtml(item.url)}" title="用系统默认浏览器打开">
        <svg viewBox="0 0 14 14"><path d="M5.5 3H11v5.5"/><path d="M11 3L4.5 9.5"/><path d="M9 8.5V11H3V5h2.5"/></svg>
      </span>
    </div>
  `;
}

function rowLgHtml(item, opts = {}) {
  const tag = tagClass(item.tag);
  const rankCls = item.rank <= 3 ? ` r${item.rank}` : '';
  const cover = item.cover
    ? `<span class="cover" style="background-image:url('${escapeHtml(item.cover).replace(/'/g, '%27')}')"></span>`
    : '';
  const metaBits = [];
  if (item.heatText) {
    metaBits.push(`<span class="heat">${escapeHtml(item.heatLabel || '热度')} ${escapeHtml(item.heatText)}</span>`);
  }
  if (item.extra) metaBits.push(`<span>${escapeHtml(item.extra)}</span>`);
  if (opts.sourceName) metaBits.push(`<span>${escapeHtml(opts.sourceName)}</span>`);

  return `
    <div class="row-lg" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(item.title)}" tabindex="0">
      <span class="rk${rankCls}">${item.rank}</span>
      <div class="main-col">
        <div class="line1">
          <span class="title">${highlight(item.title, opts.query)}</span>
          ${tag ? `<span class="tag ${tag}">${escapeHtml(tag)}</span>` : ''}
        </div>
        ${item.desc ? `<p class="desc">${highlight(item.desc, opts.query)}</p>` : ''}
        ${metaBits.length ? `<div class="meta">${metaBits.join('')}</div>` : ''}
      </div>
      ${cover}
    </div>
  `;
}

function skeletonHtml(n = 6) {
  return Array.from({ length: n }, () => '<div class="skeleton-row"></div>').join('');
}

function cardHtml(meta, rec) {
  const items = rec?.items || [];
  const head = `
    <div class="card-head">
      <span class="dot" style="background:${escapeHtml(meta.color)}"></span>
      <h3>${escapeHtml(meta.name)}</h3>
      <span class="count">${items.length} 条</span>
      <button class="more" data-goto="${escapeHtml(meta.id)}">查看全部 →</button>
    </div>
  `;

  if (rec?.error) {
    return `
      <section class="card" data-source="${escapeHtml(meta.id)}">
        ${head}
        <div class="card-error">
          <div class="err-title">抓取失败</div>
          <div class="err-msg">${escapeHtml(rec.error)}</div>
          <button class="retry" data-retry="${escapeHtml(meta.id)}">重试</button>
        </div>
      </section>
    `;
  }

  if (!rec) {
    return `<section class="card" data-source="${escapeHtml(meta.id)}">${head}<div class="card-body">${skeletonHtml(
      CARD_PREVIEW
    )}</div></section>`;
  }

  if (!items.length) {
    return `<section class="card" data-source="${escapeHtml(meta.id)}">${head}<div class="card-error"><div class="err-msg">该平台本次没有返回内容。</div></section>`;
  }

  const preview = items.slice(0, CARD_PREVIEW).map((it) => rowHtml(it)).join('');
  return `
    <section class="card" data-source="${escapeHtml(meta.id)}">
      ${head}
      <div class="card-body">${preview}</div>
    </section>
  `;
}

// ---------------------------------------------------------------- 内容视图

function renderContent() {
  const q = state.query.trim();

  if (q) {
    renderSearchContent(q);
    return;
  }

  if (state.view === 'all') {
    const blocks = groupedMetas()
      .map(({ group, metas }) => {
        const cards = metas.map((m) => cardHtml(m, state.data.get(m.id))).join('');
        if (!cards) return '';
        const done = metas.filter((m) => state.data.get(m.id)).length;
        const head = group.name
          ? `<div class="group-head">
               <h2>${escapeHtml(group.name)}</h2>
               <span>${escapeHtml(group.desc || '')}</span>
               <em>${done}/${metas.length}</em>
             </div>`
          : '';
        return `<section class="group-block">${head}<div class="grid">${cards}</div></section>`;
      })
      .join('');
    el.content.innerHTML = blocks;
    return;
  }

  const meta = state.metas.find((m) => m.id === state.view);
  if (!meta) {
    el.content.innerHTML = emptyHtml('未选择平台', '请在左侧选择一个平台。');
    return;
  }

  const rec = state.data.get(state.view);

  if (rec?.error) {
    el.content.innerHTML = `
      <div class="list">
        <div class="card-error" style="padding:26px 22px">
          <div class="err-title">抓取 ${escapeHtml(meta.name)} 失败</div>
          <div class="err-msg">${escapeHtml(rec.error)}</div>
          <div style="margin-top:12px;font-size:12.5px;color:#5a6472;line-height:1.7">
            常见原因：该平台临时风控、接口改版，或本机网络无法直连该站点。<br />
            可点击重试，或前往官网榜单直接查看。
          </div>
          <button class="retry" data-retry="${escapeHtml(meta.id)}">重试</button>
        </div>
      </div>
    `;
    return;
  }

  if (!rec) {
    el.content.innerHTML = `<div class="list">${skeletonHtml(10)}</div>`;
    return;
  }

  if (!rec.items.length) {
    el.content.innerHTML = emptyHtml('暂无内容', `${meta.name} 本次没有返回条目。`);
    return;
  }

  const rows = rec.items.map((it) => rowLgHtml(it)).join('');
  el.content.innerHTML = `<div class="list">${rows}</div>`;
}

function collectSearch() {
  const q = state.query.trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const m of state.metas) {
    const rec = state.data.get(m.id);
    if (!rec?.items?.length) continue;
    for (const it of rec.items) {
      const hay = `${it.title} ${it.desc} ${it.extra}`.toLowerCase();
      if (hay.includes(q)) out.push({ item: it, meta: m });
    }
  }
  return out;
}

function renderSearchContent(q) {
  const hits = collectSearch();
  if (!hits.length) {
    el.content.innerHTML = emptyHtml(
      '没有匹配的热点',
      `当前已加载的内容里没有包含“${escapeHtml(q)}”的条目，试试其它关键词，或先刷新一次。`
    );
    return;
  }

  const shown = hits.slice(0, SEARCH_LIMIT);
  const rows = shown
    .map(({ item, meta }, i) =>
      rowLgHtml({ ...item, rank: i + 1 }, { query: q, sourceName: meta.name })
    )
    .join('');

  const more =
    hits.length > SEARCH_LIMIT
      ? `<div class="card-error" style="color:#5a6472">仅展示前 ${SEARCH_LIMIT} 条，共命中 ${hits.length} 条。</div>`
      : '';

  el.content.innerHTML = `<div class="list">${rows}${more}</div>`;
}

function emptyHtml(title, desc) {
  return `
    <div class="empty">
      <svg class="empty-icon" viewBox="0 0 48 48">
        <circle cx="21" cy="21" r="13" />
        <path d="M31 31l9 9" />
      </svg>
      <h3>${escapeHtml(title)}</h3>
      <p>${desc}</p>
    </div>
  `;
}

// ---------------------------------------------------------------- 状态栏

function renderStatus() {
  const records = [...state.data.values()];
  const okCount = records.filter((r) => !r.error).length;
  const errCount = records.filter((r) => r.error).length;
  const total = records.reduce((s, r) => s + (r.items?.length || 0), 0);
  const expected = state.metas.length;

  el.statusDot.className = 'status-dot';
  if (state.loading) {
    el.statusDot.classList.add('busy');
    el.statusText.textContent = `正在抓取…（已完成 ${records.length}/${expected}）`;
  } else if (errCount && !okCount) {
    el.statusDot.classList.add('error');
    el.statusText.textContent = '全部平台抓取失败，请检查网络';
  } else if (errCount) {
    el.statusDot.classList.add('error');
    el.statusText.textContent = `${okCount} 个平台正常，${errCount} 个失败`;
  } else {
    el.statusText.textContent = '就绪';
  }

  const bits = [];
  if (total) bits.push(`共 ${total} 条热点`);
  if (state.lastAt) bits.push(`更新于 ${timeText(state.lastAt)}`);
  if (state.auto && state.nextAt) {
    const left = Math.max(0, Math.round((state.nextAt - Date.now()) / 1000));
    bits.push(`下次刷新 ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`);
  } else if (!state.auto) {
    bits.push('自动刷新已关闭');
  }
  el.statusMeta.textContent = bits.join(' · ');
}

// ---------------------------------------------------------------- 数据流

function applyResult(res) {
  if (!res || !res.id) return;
  const prev = state.data.get(res.id);
  state.data.set(res.id, {
    ...res,
    // 抓取失败但之前有内容时，保留旧内容，仅标记错误
    items: res.items?.length || !prev ? res.items || [] : prev.items,
    staleItems: Boolean(res.error && prev?.items?.length),
  });
  if (!res.error) state.lastAt = Math.max(state.lastAt, res.at || Date.now());
}

async function refresh({ force = false, silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  el.refreshBtn.classList.add('loading');
  el.refreshBtn.disabled = true;
  el.refreshAll.disabled = true;
  el.refreshText.textContent = '抓取中…';
  if (!silent) scheduleRender();

  try {
    const results = await API.fetchHot(null, force);
    for (const r of results) applyResult(r);
    const failed = results.filter((r) => r.error).length;
    if (!silent && failed) toast(`${failed} 个平台抓取失败，其余已更新`);
  } catch (err) {
    toast(`刷新失败：${err.message}`);
  } finally {
    state.loading = false;
    el.refreshBtn.classList.remove('loading');
    el.refreshBtn.disabled = false;
    el.refreshAll.disabled = false;
    el.refreshText.textContent = '刷新';
    state.nextAt = state.auto ? Date.now() + AUTO_INTERVAL : 0;
    scheduleRender();
  }
}

async function refreshOne(id) {
  try {
    const res = await API.fetchHot([id], true);
    for (const r of res) applyResult(r);
    const rec = res[0];
    toast(rec?.error ? `${rec.name} 仍然失败` : `${rec.name} 已更新 ${rec.items.length} 条`);
  } catch (err) {
    toast(`重试失败：${err.message}`);
  } finally {
    scheduleRender();
  }
}

async function openItem(url, title) {
  if (!url) {
    toast('该条目没有可用链接');
    return;
  }
  try {
    await API.openItem({ url, title });
  } catch (err) {
    toast(`打开失败：${err.message}`);
  }
}

async function openExternal(url) {
  try {
    await API.openExternal(url);
  } catch (err) {
    toast(`无法打开：${err.message}`);
  }
}

// ---------------------------------------------------------------- 事件绑定

function bindEvents() {
  // 窗口按钮
  document.getElementById('btn-min').addEventListener('click', () => API.win.min());
  document.getElementById('btn-max').addEventListener('click', () => API.win.max());
  document.getElementById('btn-close').addEventListener('click', () => API.win.close());

  // 侧边栏切换
  el.sideList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    setView(btn.dataset.view);
  });

  // 内容区点击（事件委托）
  el.content.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-ext]');
    if (ext) {
      e.preventDefault();
      e.stopPropagation();
      openExternal(ext.dataset.ext);
      return;
    }

    const retry = e.target.closest('[data-retry]');
    if (retry) {
      e.preventDefault();
      refreshOne(retry.dataset.retry);
      return;
    }

    const goto = e.target.closest('[data-goto]');
    if (goto) {
      e.preventDefault();
      setView(goto.dataset.goto);
      return;
    }

    const row = e.target.closest('[data-url]');
    if (row) openItem(row.dataset.url, row.dataset.title);
  });

  // 键盘：回车打开聚焦的条目
  el.content.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const row = e.target.closest('[data-url]');
      if (row) {
        e.preventDefault();
        openItem(row.dataset.url, row.dataset.title);
      }
    }
  });

  // 标题区的“清空搜索”
  el.viewHead.addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear]');
    if (clear) {
      e.preventDefault();
      setQuery('');
      return;
    }
    const ext = e.target.closest('[data-ext]');
    if (ext) {
      e.preventDefault();
      openExternal(ext.dataset.ext);
    }
  });

  // 搜索（防抖）
  let searchTimer = null;
  el.search.addEventListener('input', () => {
    el.searchBox.classList.toggle('has-value', Boolean(el.search.value));
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery(el.search.value), 140);
  });

  el.searchClear.addEventListener('click', () => {
    setQuery('');
    el.search.focus();
  });

  // 刷新
  el.refreshBtn.addEventListener('click', () => refresh({ force: true }));
  el.refreshAll.addEventListener('click', () => refresh({ force: true }));

  // 自动刷新
  el.autoRefresh.addEventListener('change', () => {
    setAuto(el.autoRefresh.checked);
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      refresh({ force: true });
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      el.search.focus();
      el.search.select();
    } else if (e.key === 'Escape' && document.activeElement === el.search) {
      setQuery('');
    }
  });

  // 详情窗口的抓取进度推送
  API.onProgress((res) => {
    applyResult(res);
    scheduleRender();
  });

  // 每秒刷新状态栏倒计时
  setInterval(() => {
    if (!state.loading && state.auto && state.nextAt && Date.now() >= state.nextAt) {
      refresh({ silent: true });
    } else {
      renderStatus();
    }
  }, 1000);
}

function setView(view) {
  state.view = view;
  if (state.query) setQuery('', false);
  try {
    localStorage.setItem(LS_VIEW, view);
  } catch {
    /* 忽略存储失败 */
  }
  el.content.scrollTop = 0;
  scheduleRender();
}

function setQuery(q, render = true) {
  state.query = q;
  el.search.value = q;
  el.searchBox.classList.toggle('has-value', Boolean(q));
  if (render) scheduleRender();
  else scheduleRender();
}

function setAuto(on) {
  state.auto = on;
  el.autoRefresh.checked = on;
  state.nextAt = on ? Date.now() + AUTO_INTERVAL : 0;
  try {
    localStorage.setItem(LS_AUTO, on ? '1' : '0');
  } catch {
    /* 忽略存储失败 */
  }
  scheduleRender();
}

// ---------------------------------------------------------------- 启动

async function init() {
  // 恢复本地偏好
  try {
    const savedAuto = localStorage.getItem(LS_AUTO);
    state.auto = savedAuto === null ? true : savedAuto === '1';
    const savedView = localStorage.getItem(LS_VIEW);
    if (savedView) state.view = savedView;
  } catch {
    state.auto = true;
  }
  el.autoRefresh.checked = state.auto;
  state.nextAt = state.auto ? Date.now() + AUTO_INTERVAL : 0;

  bindEvents();

  try {
    const res = await API.listSources();
    // 主进程返回 { groups, sources }；兼容旧的纯数组形式
    if (Array.isArray(res)) {
      state.metas = res;
      state.groups = [];
    } else {
      state.metas = res?.sources || [];
      state.groups = res?.groups || [];
    }
  } catch (err) {
    el.content.innerHTML = emptyHtml('初始化失败', `无法读取平台列表：${escapeHtml(err.message)}`);
    return;
  }

  if (!state.metas.some((m) => m.id === state.view)) state.view = 'all';

  state.ready = true;
  scheduleRender();
  await refresh({ force: false });
}

init();
