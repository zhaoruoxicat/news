'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

// 头条标签位：接口给的是英文枚举
const LABEL_MAP = {
  new: '新',
  hot: '热',
  boom: '爆',
  fevertime: '沸',
  top: '置顶',
  novel: '小说',
  n1: '热',
};

module.exports = {
  id: 'toutiao',
  name: '今日头条',
  color: '#ed4040',
  initial: '头',
  homepage: 'https://www.toutiao.com/',
  limit: 50,
  async fetchItems() {
    const json = await getJSON('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
      headers: { Referer: 'https://www.toutiao.com/' },
    });
    const list = json?.data;
    if (!Array.isArray(list)) throw new Error('头条接口返回结构异常');

    return finalize(
      list.map((it) => {
        const heat = Number(it.HotValue) || null;
        const labelKey = String(it.Label || '').toLowerCase();
        return {
          title: it.Title,
          url: it.ClusterIdStr
            ? `https://www.toutiao.com/trending/${it.ClusterIdStr}/`
            : it.Url || 'https://www.toutiao.com/',
          heat,
          heatText: formatHeat(heat),
          heatLabel: '热度',
          tag: LABEL_MAP[labelKey] || it.LabelDesc || '',
          desc: it.LabelDesc || '',
          cover: it.Image || '',
        };
      }),
      this.limit
    );
  },
};
