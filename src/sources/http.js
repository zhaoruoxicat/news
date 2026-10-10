'use strict';

// 统一的网络请求层：伪装成桌面 Chrome，带超时与重试。
// 所有抓取都从本机网络直连各平台官方接口，不经过任何第三方中转。

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': CHROME_UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

// 部分老站（新浪、太平洋电脑网等）仍用 GB2312/GBK 输出，必须按声明解码，
// 否则中文会整片乱码。Node 自带完整 ICU，TextDecoder 支持 gbk。
const CHARSET_ALIASES = {
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  'gb_2312-80': 'gbk',
  'utf8': 'utf-8',
  'utf-8bom': 'utf-8',
};

function detectCharset(buffer, headers) {
  const ct = headers.get('content-type') || '';
  let cs = (ct.match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1];
  if (!cs) {
    const head = buffer.subarray(0, 220).toString('latin1');
    cs = (head.match(/encoding\s*=\s*["']([\w-]+)["']/i) || [])[1];
  }
  return (cs || 'utf-8').toLowerCase();
}

function decodeBody(buffer, headers) {
  const name = CHARSET_ALIASES[detectCharset(buffer, headers)] || detectCharset(buffer, headers);
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 发起一次请求，失败按 backoff 重试。
 * @returns {Promise<{status:number, text:string, headers:Headers}>}
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = 15000,
    retries = 1,
    backoff = 400,
  } = opts;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...DEFAULT_HEADERS,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body,
        signal: controller.signal,
        redirect: 'follow',
      });

      // 读取正文（Node 的 fetch 会自动解压 gzip/br）
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = decodeBody(buffer, res.headers);

      if (!res.ok) {
        throw new HttpError(
          `HTTP ${res.status} ${res.statusText || ''}`.trim(),
          res.status
        );
      }
      return { status: res.status, text, buffer, headers: res.headers };
    } catch (err) {
      lastError =
        err.name === 'AbortError'
          ? new HttpError(`请求超时（${timeout}ms）`, 0)
          : err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoff * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('请求失败');
}

/** 请求并解析 JSON，解析失败时抛出可读错误 */
async function getJSON(url, opts = {}) {
  const { text } = await request(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(
      `返回内容不是合法 JSON（前 80 字符：${text.slice(0, 80).replace(/\s+/g, ' ')})`,
      0
    );
  }
}

/** 请求纯文本（HTML / XML） */
async function getText(url, opts = {}) {
  const { text } = await request(url, opts);
  return text;
}

/** 请求并带回 Cookie（用于需要两步握手的站点） */
async function requestWithCookies(url, opts = {}) {
  const res = await request(url, opts);
  const setCookie =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { ...res, setCookie };
}

module.exports = { request, getJSON, getText, requestWithCookies, CHROME_UA, HttpError };
