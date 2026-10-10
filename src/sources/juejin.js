'use strict';

const { getJSON } = require('./http');
const { finalize, formatHeat } = require('./util');

module.exports = {
  id: 'juejin',
  name: '掘金热榜',
  color: '#1e80ff',
  initial: '掘',
  homepage: 'https://juejin.cn/hot/articles/1',
  limit: 50,
  async fetchItems() {
    const json = await getJSON(
      'https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot&spider=0',
      { headers: { Referer: 'https://juejin.cn/' } }
    );

    const list = json?.data;
    if (!Array.isArray(list)) throw new Error('掘金接口返回结构异常');

    return finalize(
      list.map((it) => {
        const c = it.content || {};
        const counter = it.content_counter || {};
        const view = Number(counter.view) || null;
        return {
          title: c.title,
          url: c.content_id ? `https://juejin.cn/post/${c.content_id}` : 'https://juejin.cn/hot/articles/1',
          heat: view,
          heatText: formatHeat(view),
          heatLabel: '阅读',
          tag: '',
          desc: c.brief || '',
          extra: it.author?.name ? `${it.author.name} · ${counter.like || 0} 赞` : '',
        };
      }),
      this.limit
    );
  },
};
