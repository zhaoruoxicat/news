'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

module.exports = {
  id: 'douyin',
  name: '抖音热搜',
  color: '#fe2c55',
  initial: '抖',
  homepage: 'https://www.douyin.com/hot',
  limit: 50,
  async fetchItems() {
    const json = await getJSON(
      'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1&source=6',
      { headers: { Referer: 'https://www.douyin.com/' } }
    );
    const list = json?.data?.word_list;
    if (!Array.isArray(list)) throw new Error('抖音接口返回结构异常（可能触发了风控）');

    return finalize(
      list.map((it) => {
        const heat = Number(it.hot_value) || null;
        return {
          title: it.word,
          url: it.sentence_id
            ? `https://www.douyin.com/hot/${it.sentence_id}`
            : `https://www.douyin.com/search/${encodeURIComponent(it.word || '')}`,
          heat,
          heatText: formatHeat(heat),
          heatLabel: '热度',
          tag: it.is_n1 ? '置顶' : '',
          cover: it.word_cover?.url_list?.[0] || '',
        };
      }),
      this.limit
    );
  },
};
