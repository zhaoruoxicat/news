'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

module.exports = {
  id: 'weibo',
  name: '微博热搜',
  color: '#e6162d',
  initial: '微',
  homepage: 'https://s.weibo.com/top/summary',
  limit: 50,
  async fetchItems() {
    const json = await getJSON('https://weibo.com/ajax/side/hotSearch', {
      headers: { Referer: 'https://weibo.com/' },
    });
    const realtime = json?.data?.realtime;
    if (!Array.isArray(realtime)) throw new Error('微博接口返回结构异常');

    // is_ad / topic_ad 是商业推广位，直接从热搜榜里剔除
    const list = realtime.filter((x) => !x.is_ad && !x.topic_ad && (x.word || x.note));

    return finalize(
      list.map((x) => {
        const word = x.word || x.note;
        const heat = Number.isFinite(x.num) ? x.num : null;
        return {
          title: word,
          url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + word + '#')}`,
          heat,
          heatText: formatHeat(heat),
          heatLabel: '热度',
          tag: x.label_name || x.icon_desc || '',
          desc: x.note && x.note !== word ? x.note : '',
        };
      }),
      this.limit
    );
  },
};
