'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

module.exports = {
  id: 'bilibili',
  name: 'B站排行',
  color: '#fb7299',
  initial: 'B',
  homepage: 'https://www.bilibili.com/v/popular/rank/all',
  limit: 60,
  async fetchItems() {
    const json = await getJSON('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
      headers: { Referer: 'https://www.bilibili.com/' },
    });
    if (json?.code !== 0) throw new Error(`B站接口返回错误码 ${json?.code}`);
    const list = json?.data?.list;
    if (!Array.isArray(list)) throw new Error('B站接口返回结构异常');

    return finalize(
      list.map((it) => {
        const view = Number(it.stat?.view) || null;
        const author = it.owner?.name || '';
        return {
          title: it.title,
          url: it.bvid ? `https://www.bilibili.com/video/${it.bvid}` : it.short_link_v2 || '',
          heat: view,
          heatText: formatHeat(view),
          heatLabel: '播放',
          tag: it.tname || '',
          desc: it.desc || '',
          cover: it.pic || '',
          extra: author ? `${author} · ${it.tname || ''}`.replace(/ · $/, '') : it.tname || '',
        };
      }),
      this.limit
    );
  },
};
