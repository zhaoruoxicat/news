'use strict';

const weibo = require('./weibo');
const zhihu = require('./zhihu');
const toutiao = require('./toutiao');
const baidu = require('./baidu');
const douyin = require('./douyin');
const bilibili = require('./bilibili');
const ithome = require('./ithome');
const kr36 = require('./kr36');
const juejin = require('./juejin');
const { buildSources } = require('./rss');
const FEEDS = require('./feeds');

// 分组定义：顺序即界面上的展示顺序
const GROUPS = [
  { id: 'hot', name: '实时热榜', desc: '微博、知乎、头条等平台实时榜单' },
  { id: 'media', name: '国内媒体', desc: '新闻门户要闻' },
  { id: 'global', name: '国际媒体', desc: '境外通讯社与媒体（本机可直连的源）' },
  { id: 'tech', name: '科技媒体', desc: '国内外科技与开发者资讯' },
  { id: 'game', name: '游戏', desc: '游戏媒体与 Steam' },
];

// 实时热榜：本机直连各平台官方公开接口
const HOT_SOURCES = [weibo, zhihu, toutiao, baidu, douyin, bilibili, ithome, kr36, juejin].map(
  (s) => ({ ...s, group: 'hot', kind: 'hot' })
);

// 资讯源：各站点官方 RSS
const FEED_SOURCES = buildSources(FEEDS);

const SOURCES = [...HOT_SOURCES, ...FEED_SOURCES];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/** 给渲染层的平台元信息（不含函数，可安全序列化） */
function getMeta() {
  return SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    group: s.group,
    color: s.color,
    initial: s.initial,
    homepage: s.homepage,
    limit: s.limit,
  }));
}

function getGroups() {
  const used = new Set(SOURCES.map((s) => s.group));
  return GROUPS.filter((g) => used.has(g.id));
}

/**
 * 抓取单个平台。永不抛异常，失败时把错误文本放进 error 字段，
 * 这样某个平台挂掉不会影响其它平台展示。
 */
async function fetchSource(id) {
  const src = BY_ID.get(id);
  if (!src) return { id, name: id, items: [], error: `未知平台：${id}` };

  const startedAt = Date.now();
  try {
    const items = await src.fetchItems();
    return {
      id: src.id,
      name: src.name,
      group: src.group,
      color: src.color,
      initial: src.initial,
      homepage: src.homepage,
      items,
      error: null,
      at: Date.now(),
      elapsed: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      id: src.id,
      name: src.name,
      group: src.group,
      color: src.color,
      initial: src.initial,
      homepage: src.homepage,
      items: [],
      error: err && err.message ? err.message : String(err),
      at: Date.now(),
      elapsed: Date.now() - startedAt,
    };
  }
}

/** 限制并发的批量抓取。资讯源普遍很快，默认同时打 8 个 */
async function fetchMany(ids, concurrency = 8) {
  const wanted = (ids && ids.length ? ids : SOURCES.map((s) => s.id)).filter((id) =>
    BY_ID.has(id)
  );
  const results = new Array(wanted.length);
  let cursor = 0;

  async function worker() {
    while (cursor < wanted.length) {
      const index = cursor++;
      results[index] = await fetchSource(wanted[index]);
    }
  }

  const size = Math.max(1, Math.min(concurrency, wanted.length));
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

module.exports = {
  SOURCES,
  GROUPS,
  getMeta,
  getGroups,
  fetchSource,
  fetchMany,
  ids: () => SOURCES.map((s) => s.id),
};
