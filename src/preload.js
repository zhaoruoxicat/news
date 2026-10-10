'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 统一解包 { ok, data, error } 协议，失败时抛出可读错误 */
async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || `调用 ${channel} 失败`);
  }
  return res.data;
}

contextBridge.exposeInMainWorld('hotspot', {
  appInfo: () => invoke('app:info'),
  listSources: () => invoke('sources:list'),
  fetchHot: (ids, force) => invoke('hot:fetch', { ids, force }),

  openItem: (payload) => invoke('hot:open', payload),
  openExternal: (url) => invoke('hot:openExternal', url),
  copy: (text) => invoke('hot:copy', text),

  // 抓取进度：每个平台抓完即回调一次
  onProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('hot:progress', listener);
    return () => ipcRenderer.removeListener('hot:progress', listener);
  },

  win: {
    min: () => invoke('win:min'),
    max: () => invoke('win:max'),
    close: () => invoke('win:close'),
    isMax: () => invoke('win:isMax'),
  },
});
