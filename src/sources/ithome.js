'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

function toUrl(it) {
  const raw = it.url || '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw) return 'https://www.ithome.com' + (raw.startsWith('/') ? raw : '/' + raw);
  return it.newsid ? `https://www.ithome.com/0/0/${it.newsid}.htm` : 'https://www.ithome.com/';
}

module.exports = {
  id: 'ithome',
  name: 'IT之家',
  color: '#e60012',
  initial: 'IT',
  homepage: 'https://www.ithome.com/',
  limit: 40,
  async fetchItems() {
    const json = await getJSON('https://api.ithome.com/json/newslist/news', {
      headers: { Referer: 'https://www.ithome.com/' },
    });

    const top = Array.isArray(json?.toplist) ? json.toplist : [];
    const news = Array.isArray(json?.newslist) ? json.newslist : [];
    if (!top.length && !news.length) throw new Error('IT之家接口返回结构异常');

    const rows = [
      ...top.map((it) => ({ ...it, __top: true })),
      ...news.filter((n) => !top.some((t) => t.newsid === n.newsid)),
    ];

    return finalize(
      rows.map((it) => {
        const heat = Number(it.hitcount) || null;
        const comments = Number(it.commentcount) || 0;
        return {
          title: it.title,
          url: toUrl(it),
          heat,
          heatText: formatHeat(heat),
          heatLabel: '阅读',
          tag: it.__top ? '置顶' : '',
          desc: it.description || '',
          cover: it.image || '',
          extra: comments ? `${comments} 评论` : '',
        };
      }),
      this.limit
    );
  },
};
