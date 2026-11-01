'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnessHost', {
  pickFolder: () => ipcRenderer.invoke('host:pick-folder'),
  pickFile: (opts) => ipcRenderer.invoke('host:pick-file', opts),
  saveFile: (opts) => ipcRenderer.invoke('host:save-file', opts),
  reveal: (p) => ipcRenderer.invoke('host:reveal', p),
  openExternal: (url) => ipcRenderer.invoke('host:open-external', url),
  // Updates exist only in Developer ID builds; elsewhere nothing is ever sent.
  onUpdate: (callback) => {
    ipcRenderer.on('host:update', (_event, msg) => callback(msg));
    ipcRenderer.invoke('host:update-state').then((msg) => { if (msg) callback(msg); });
  },
  restartToUpdate: () => ipcRenderer.invoke('host:restart-to-update'),
  agentBounds: (rect) => ipcRenderer.send('agent:bounds', rect),
  agentProject: (folder) => ipcRenderer.send('agent:project', folder),
  setUpAgent: () => ipcRenderer.send('agent:setup'),
  onAgentShown: (cb) => ipcRenderer.on('agent:shown', (e, shown) => cb(shown === true)),
  onAgentLookup: (cb) => ipcRenderer.on('agent:lookup', async (e, { id, num }) => {
    let words = null;
    try { words = await cb(String(num)); } catch (_) { words = null; }
    ipcRenderer.send('agent:lookup-result', { id, words });
  }),
  onAgentReveal: (cb) => ipcRenderer.on('agent:reveal', (e, num) => cb(String(num))),
  onAgentFocusView: (cb) => ipcRenderer.on('agent:focus-view', () => cb()),
});
