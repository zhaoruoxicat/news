'use strict';

/** 把数字热度格式化成中文习惯的“万/亿” */
function formatHeat(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v >= 1e8) return trimZero(v / 1e8) + '亿';
  if (v >= 1e4) return trimZero(v / 1e4) + '万';
  return String(Math.round(v));
}

function trimZero(v) {
  return v.toFixed(1).replace(/\.0$/, '');
}

/** 从“1234 万热度”“1.2亿热度”这类文本里还原出数字 */
function parseHeatText(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.]+)\s*([万亿])?/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  if (m[2] === '万') return Math.round(base * 1e4);
  if (m[2] === '亿') return Math.round(base * 1e8);
  return Math.round(base);
}

/** 去掉 HTML 标签与多余空白 */
function cleanText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 相对路径补全为绝对地址 */
function absUrl(base, u) {
  if (!u) return '';
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (!base) return s;
  return base.replace(/\/+$/, '') + '/' + s.replace(/^\/+/, '');
}

/** 缩略图统一走 https，避免混合内容被拦 */
function httpsImage(u) {
  if (!u) return '';
  return String(u).trim().replace(/^http:\/\//i, 'https://');
}

/** 按数组顺序赋值 rank，过滤掉空标题，最多保留 limit 条 */
function finalize(items, limit = 60) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const title = cleanText(it.title);
    if (!title) continue;
    out.push({
      rank: out.length + 1,
      title,
      url: it.url || '',
      heat: Number.isFinite(it.heat) ? it.heat : null,
      heatText: it.heatText || '',
      heatLabel: it.heatLabel || '',
      tag: it.tag ? cleanText(it.tag) : '',
      desc: cleanText(it.desc || ''),
      cover: httpsImage(it.cover || ''),
      extra: cleanText(it.extra || ''),
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { formatHeat, trimZero, parseHeatText, cleanText, absUrl, httpsImage, finalize };
