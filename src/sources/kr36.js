'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

module.exports = {
  id: 'kr36',
  name: '36氪热榜',
  color: '#1e6fff',
  initial: '36',
  homepage: 'https://36kr.com/hot-list/catalog',
  limit: 50,
  async fetchItems() {
    const json = await getJSON('https://gateway.36kr.com/api/mis/nav/home/nav/rank/hot', {
      method: 'POST',
      headers: { Referer: 'https://36kr.com/' },
      body: JSON.stringify({
        partner_id: 'wap',
        param: { siteId: 1, platformId: 2 },
        timestamp: Date.now(),
      }),
    });

    const list = json?.data?.hotRankList;
    if (!Array.isArray(list)) throw new Error('36氪接口返回结构异常');

    return finalize(
      list.map((it) => {
        const m = it.templateMaterial || {};
        const read = Number(m.statRead) || null;
        return {
          title: m.widgetTitle,
          url: it.itemId ? `https://36kr.com/p/${it.itemId}` : 'https://36kr.com/hot-list/catalog',
          heat: read,
          heatText: formatHeat(read),
          heatLabel: '阅读',
          tag: '',
          cover: m.widgetImage || '',
          extra: m.statFormat || '',
        };
      }),
      this.limit
    );
  },
};
