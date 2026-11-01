'use strict';
// The column page's only bridge. It has no token, no route to the local API,
// and no way to run anything but the column's own steps.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentColumn', {
  onState: (cb) => ipcRenderer.on('column:state', (e, s) => cb(s)),
  onData: (cb) => ipcRenderer.on('column:data', (e, d) => cb(d)),
  onClear: (cb) => ipcRenderer.on('column:clear', () => cb()),
  onFocus: (cb) => ipcRenderer.on('column:focus', () => cb()),
  run: (step) => ipcRenderer.send('column:run', String(step)),
  write: (data) => ipcRenderer.send('column:write', String(data)),
  resize: (cols, rows) => ipcRenderer.send('column:resize', { cols, rows }),
  lookup: (num) => ipcRenderer.invoke('column:lookup', String(num)),
  reveal: (num) => ipcRenderer.send('column:reveal', String(num)),
  focusView: () => ipcRenderer.send('column:focus-view'),
});
