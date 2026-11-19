const { contextBridge, ipcRenderer } = require('electron');
const call = (n) => (...a) => ipcRenderer.invoke(n, ...a);
contextBridge.exposeInMainWorld('api', {
  ready: call('ready'), toggle: call('toggle'), setLayout: call('setLayout'), setZoom: call('setZoom'),
  toggleSidebar: call('toggleSidebar'), refresh: call('refresh'), newChat: call('newChat'), newChatAll: call('newChatAll'),
  modelMenu: call('modelMenu'), copyAnswer: call('copyAnswer'), send: call('send'), promptMenu: call('promptMenu'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d))
});
