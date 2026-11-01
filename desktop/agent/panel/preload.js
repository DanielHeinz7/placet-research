'use strict';
// The panel's only door to the app: the sdk:* channels. No write token, no
// route to the local API. The main process registers this file on the
// column's own session (agent/index.js), so it runs for every page the column
// shows; it exposes the bridge to the panel page and to no other.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && location.pathname.endsWith('/agent/panel/panel.html')) {
  contextBridge.exposeInMainWorld('agentPanel', {
    state: () => ipcRenderer.invoke('sdk:state'),
    chooseWay: (way) => ipcRenderer.invoke('sdk:choose-way', way),
    hide: () => ipcRenderer.invoke('sdk:hide'),
    listModels: (draft, secret) => ipcRenderer.invoke('sdk:list-models', draft, secret),
    connect: (draft, secret) => ipcRenderer.invoke('sdk:connect', draft, secret),
    removeConnection: () => ipcRenderer.invoke('sdk:remove-connection'),
    start: (opts) => ipcRenderer.invoke('sdk:start', opts),
    send: (text) => ipcRenderer.invoke('sdk:send', text),
    stop: () => ipcRenderer.invoke('sdk:stop'),
    answer: (id, allow) => ipcRenderer.invoke('sdk:answer', id, allow),
    lookup: (number) => ipcRenderer.invoke('sdk:lookup', number),
    reveal: (number) => ipcRenderer.invoke('sdk:reveal', number),
    pickFile: () => ipcRenderer.invoke('sdk:pick-file'),
    openExternal: (url) => ipcRenderer.invoke('sdk:open-external', url),
    onEvent: (cb) => ipcRenderer.on('sdk:event', (e, ev) => cb(ev)),
  });
}
