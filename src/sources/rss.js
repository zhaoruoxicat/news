'use strict';

// 通用 RSS / Atom / RDF 解析器：不依赖任何第三方 XML 库。
// 各站 RSS 的脏数据很多（CDATA 嵌套、HTML 摘要、实体未转义、字段名五花八门），
// 这里用宽松正则取值并统一清洗，保证任何一个源出问题都不会拖垮其它源。

const { getText } = require('./http');
const { httpsImage, finalize } = require('./util');

const NAMED_ENTITIES = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  ge: '≥',
  le: '≤',
  ne: '≠',
  bull: '•',
  permil: '‰',
  prime: '′',
  Prime: '″',
};

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 展开 CDATA、还原 HTML 实体 */
function decodeEntities(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => fromCodePoint(parseInt(h, 16)));
  s = s.replace(/&#(\d+);/g, (_m, d) => fromCodePoint(Number(d)));
  s = s.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m
  );
  s = s.replace(/&amp;/g, '&');
  return s;
}

/** 把 HTML 摘要压成纯文本一行 */
function stripHtml(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  // 行内标签直接去掉（不该在文字中间插空格），块级标签才当分隔符
  s = s.replace(/<\/?(?:a|b|strong|em|i|u|s|span|font|small|sub|sup|code|abbr|mark)\b[^>]*>/gi, '');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article|blockquote|table|ul|ol)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function pickTag(block, tags) {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = block.match(re);
    if (m && m[1].trim()) return m[1];
  }
  return '';
}

/** RSS 的 <link> 与 Atom 的 <link href> 都要支持 */
function pickLink(block) {
  const inline = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (inline && inline[1].trim()) return decodeEntities(inline[1]).trim();

  let fallback = '';
  for (const m of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attrs = m[1] || '';
    const href = (attrs.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const rel = (attrs.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (rel && !/alternate/i.test(rel)) continue;
    if (/alternate/i.test(rel)) return decodeEntities(href).trim();
    fallback = fallback || decodeEntities(href).trim();
  }
  if (fallback) return fallback;

  const guid = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) {
    const g = decodeEntities(guid[1]).trim();
    if (/^https?:\/\//i.test(g)) return g;
  }
  return '';
}

/** 封面：优先媒体扩展字段，其次正文里的第一张图 */
function pickCover(block) {
  const media = block.match(/<media:(?:content|thumbnail)[^>]*\surl=["']([^"']+)["']/i);
  if (media) return media[1];
  const enclosure = block.match(/<enclosure[^>]*\surl=["']([^"']+)["'][^>]*>/i);
  if (enclosure) return enclosure[1];
  const body = pickTag(block, ['content:encoded', 'content', 'description', 'summary', 'info']);
  const img = body.match(/<img[^>]+src=["']([^"']+)["']/i);
  return img ? img[1] : '';
}

function pickDate(block) {
  const raw = pickTag(block, ['pubDate', 'published', 'updated', 'dc:date', 'date', 'lastBuildDate']);
  if (!raw) return 0;
  const t = Date.parse(decodeEntities(raw).trim());
  return Number.isFinite(t) ? t : 0;
}

/** 相对时间，用于“3 小时前”这类展示 */
function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 把一段 XML 拆成条目块 */
function splitEntries(xml) {
  const blocks = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(xml))) blocks.push(m[0]);
  if (blocks.length) return blocks;

  // 少数源用自闭合条目
  const re2 = /<(item|entry)\b[^>]*\/>/gi;
  while ((m = re2.exec(xml))) blocks.push(m[0]);
  return blocks;
}

/** 解析 RSS/Atom 文本为条目数组 */
function parseFeed(xml) {
  const blocks = splitEntries(xml);
  const items = [];

  for (const block of blocks) {
    const rawTitle = pickTag(block, ['title']);
    const title = stripHtml(rawTitle) || decodeEntities(rawTitle).trim();
    if (!title) continue;

    const url = pickLink(block);
    const rawDesc = pickTag(block, ['description', 'summary', 'content:encoded', 'content']);
    let desc = stripHtml(rawDesc);
    if (desc === title) desc = '';
    if (desc.length > 160) desc = desc.slice(0, 160).trim() + '…';

    const category = stripHtml(pickTag(block, ['category', 'tags'])).slice(0, 12);
    const author = stripHtml(
      pickTag(block, ['dc:creator', 'author', 'name', 'creator'])
    ).slice(0, 20);
    const ts = pickDate(block);

    const bits = [];
    if (relTime(ts)) bits.push(relTime(ts));
    if (author && author !== title) bits.push(author);

    items.push({
      title,
      url,
      heat: null,
      heatText: '',
      heatLabel: '',
      tag: category,
      desc,
      cover: pickCover(block),
      extra: bits.join(' · '),
      // 供排序使用：越新越靠前
      __ts: ts,
    });
  }

  return items;
}

/**
 * 抓取并解析一个 RSS 源。
 * @param {string} feedUrl
 * @param {{limit?:number, headers?:object}} [opts]
 */
async function fetchFeed(feedUrl, opts = {}) {
  const { limit = 40, headers = {} } = opts;
  const xml = await getText(feedUrl, {
    timeout: 20000,
    retries: 1,
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      ...headers,
    },
  });

  const items = parseFeed(xml);
  if (!items.length) {
    throw new Error('该源没有返回可解析的条目（可能是空列表或格式变更）');
  }

  // 少数源（如 Steam）会重复推送同一条内容，按链接去重；没有链接时退回标题
  const seen = new Set();
  const unique = items.filter((it) => {
    const key = (it.url || it.title).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 有发布时间的按时间倒序，没有的保持原始顺序
  const dated = unique.filter((it) => it.__ts);
  const ordered =
    dated.length >= Math.max(3, unique.length * 0.5)
      ? [...unique].sort((a, b) => (b.__ts || 0) - (a.__ts || 0))
      : unique;

  return finalize(
    ordered.map((it) => ({ ...it, cover: httpsImage(it.cover) })),
    limit
  );
}

/**
 * 由配置批量生成数据源对象。
 * @param {{id:string,name:string,group:string,color:string,initial:string,homepage:string,feed:string,limit?:number,tag?:string,headers?:object}[]} configs
 */
function buildSources(configs) {
  return configs.map((cfg) => ({
    id: cfg.id,
    name: cfg.name,
    group: cfg.group,
    color: cfg.color,
    initial: cfg.initial,
    homepage: cfg.homepage,
    limit: cfg.limit || 40,
    kind: 'feed',
    async fetchItems() {
      const items = await fetchFeed(cfg.feed, { limit: cfg.limit, headers: cfg.headers });
      if (cfg.tag) {
        for (const it of items) if (!it.tag) it.tag = cfg.tag;
      }
      return items;
    },
  }));
}

module.exports = { fetchFeed, parseFeed, buildSources, decodeEntities, stripHtml, relTime };
