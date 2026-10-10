'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res || res.ok !== true) throw new Error((res && res.error) || `调用 ${channel} 失败`);
  return res.data;
}

contextBridge.exposeInMainWorld('detailBridge', {
  control: (action) => invoke('detail:control', action),
  current: () => invoke('detail:current'),
  win: {
    min: () => invoke('win:min'),
    max: () => invoke('win:max'),
    close: () => invoke('win:close'),
  },
  onInit: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('detail:init', l);
    return () => ipcRenderer.removeListener('detail:init', l);
  },
  onState: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('detail:state', l);
    return () => ipcRenderer.removeListener('detail:state', l);
  },
});
