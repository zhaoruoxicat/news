'use strict';

const { getJSON } = require('./http');
const { finalize, parseHeatText, formatHeat } = require('./util');

module.exports = {
  id: 'zhihu',
  name: '知乎热榜',
  color: '#0084ff',
  initial: '知',
  homepage: 'https://www.zhihu.com/hot',
  limit: 50,
  async fetchItems() {
    // 网页版 /api/v3 需要登录 cookies；移动端接口可匿名访问
    const json = await getJSON('https://api.zhihu.com/topstory/hot-lists/total?limit=50', {
      headers: { Accept: 'application/json', Referer: 'https://www.zhihu.com/hot' },
    });
    const list = json?.data;
    if (!Array.isArray(list)) throw new Error('知乎接口返回结构异常');

    return finalize(
      list.map((entry) => {
        const t = entry.target || {};
        // 接口给的是 api.zhihu.com/questions/<id>（复数），网页端路径是 /question/<id>（单数）
        const rawUrl = String(t.url || '');
        const idFromUrl = rawUrl.match(/\/questions?\/(\d+)/)?.[1];
        const url = idFromUrl
          ? `https://www.zhihu.com/question/${idFromUrl}`
          : t.id
            ? `https://www.zhihu.com/question/${t.id}`
            : 'https://www.zhihu.com/hot';

        const heat = parseHeatText(entry.detail_text);
        const answers = Number(t.answer_count) || 0;
        return {
          title: t.title,
          url,
          heat,
          heatText: heat ? formatHeat(heat) : String(entry.detail_text || '').replace(/热度/g, '').trim(),
          heatLabel: '热度',
          tag: entry.card_label?.type === 'boiling' ? '沸' : '',
          desc: t.excerpt || '',
          extra: answers ? `${answers} 个回答` : '',
        };
      }),
      this.limit
    );
  },
};
