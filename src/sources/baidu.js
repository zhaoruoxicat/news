'use strict';

const { getText, getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

// 百度 top.baidu.com 的公开 JSON 接口不返回热度值，
// 完整数据（hotScore/desc/img/hotTag）内嵌在榜单页面的 <!--s-data:...--> 注释里。
const PAGE_URL = 'https://top.baidu.com/board?tab=realtime';
const API_URL = 'https://top.baidu.com/api/board?platform=wise&tab=realtime';

// 已实测确认的枚举：1=新，3=热（0 表示无标签）
const TAG_MAP = { 1: '新', 3: '热' };

function extractEmbedded(html) {
  const m = html.match(/<!--s-data:([\s\S]*?)-->/);
  if (!m) return null;
  try {
    const json = JSON.parse(m[1]);
    const cards = json?.data?.cards;
    if (!Array.isArray(cards)) return null;
    for (const card of cards) {
      const rows = card?.content;
      if (Array.isArray(rows) && rows.length && rows[0]?.word) return rows;
    }
    return null;
  } catch {
    return null;
  }
}

function extractFromApi(json) {
  const cards = json?.data?.cards;
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    const content = card?.content;
    if (!Array.isArray(content)) continue;
    if (content.length && content[0]?.word) return content;
    for (const wrap of content) {
      if (Array.isArray(wrap?.content) && wrap.content.length && wrap.content[0]?.word) {
        return wrap.content;
      }
    }
  }
  return null;
}

module.exports = {
  id: 'baidu',
  name: '百度热搜',
  color: '#2932e1',
  initial: '百',
  homepage: PAGE_URL,
  limit: 51,
  async fetchItems() {
    let rows = null;

    // 主通道：页面内嵌数据，带真实热度
    try {
      const html = await getText(PAGE_URL, {
        headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://www.baidu.com/' },
      });
      rows = extractEmbedded(html);
    } catch {
      rows = null;
    }

    // 兜底通道：官方 JSON 接口（无热度值，但至少能出榜单）
    if (!rows || !rows.length) {
      const json = await getJSON(API_URL, { headers: { Referer: PAGE_URL } });
      rows = extractFromApi(json);
    }
    if (!rows || !rows.length) throw new Error('百度热搜返回结构异常');

    return finalize(
      rows.map((it) => {
        const heat = Number(it.hotScore) || null;
        return {
          title: it.word,
          url: it.url || it.rawUrl || `https://www.baidu.com/s?wd=${encodeURIComponent(it.word || '')}`,
          heat,
          heatText: formatHeat(heat),
          heatLabel: '搜索指数',
          tag: it.isTop ? '置顶' : TAG_MAP[Number(it.hotTag)] || '',
          desc: it.desc || '',
          cover: it.img || '',
        };
      }),
      this.limit
    );
  },
};
