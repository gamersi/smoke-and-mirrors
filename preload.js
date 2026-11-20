'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sm', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (data) => ipcRenderer.invoke('state:save', data),
  getDisplays: () => ipcRenderer.invoke('displays:get'),
  identifyDisplays: () => ipcRenderer.invoke('displays:identify'),
  setOutputVisible: (v) => ipcRenderer.invoke('output:setVisible', v),
  pickMedia: () => ipcRenderer.invoke('dialog:media'),
  mediaExists: (p) => ipcRenderer.invoke('media:exists', p),
  listSources: () => ipcRenderer.invoke('capture:list'),
  selectSource: (id) => ipcRenderer.invoke('capture:select', id),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  on: (channel, fn) => {
    if (!['displays:changed', 'hotkey', 'output:failed', 'output:warning', 'output:userClosed'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
