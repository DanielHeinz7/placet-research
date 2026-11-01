'use strict';
// Electron glue for the agent column: one WebContentsView over the slot the
// shell page reports, the controller behind it, the relay for statement
// numbers, Ctrl+` and Present.
const path = require('node:path');

function columnBounds(rect, zoom) {
  if (!rect) return null;
  const z = zoom || 1;
  return { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) };
}

// The live column, left here by setUpAgent. The SDK way reaches the column
// only through the functions exported at the bottom of this file.
let current = null;

function setUpAgent({ win, pluginRoot, pluginVersion, gitEnv, dataDir, shimsDir }) {
  const { app, dialog, ipcMain, Menu, WebContentsView, shell } = require('electron');
  const { run } = require('./run');
  const { locate, loginPath } = require('./locate');
  const { authStatus } = require('./auth');
  const { createSession } = require('./session');
  const { createController } = require('./controller');
  const { readAgentStore } = require('./store');

  const g = gitEnv();
  const controller = createController({
    dataDir, pluginRoot, pluginVersion, shimsDir, electronPath: process.execPath,
    git: { bin: g.PLACET_RESEARCH_GIT, execPath: g.GIT_EXEC_PATH, configSystem: g.GIT_CONFIG_SYSTEM, templateDir: g.GIT_TEMPLATE_DIR },
    baseEnv: process.env,
    loginPath: () => loginPath({ shell: process.env.SHELL || '/bin/zsh', run }),
    locate: () => locate({ home: app.getPath('home'), shell: process.env.SHELL || '/bin/zsh', run }),
    authStatus: (claude) => authStatus(claude, { run }),
    spawn: createSession,
    screenReaderMode: () => app.accessibilitySupportEnabled,
  });

  // The column keeps its own session, so the SDK way's bridge (agent/panel/
  // preload.js) can be registered on it alone and the shell page never gets
  // it. That preload runs for every page the column shows and exposes
  // window.agentPanel to the panel page only; sub-project 2's preload and its
  // page are unchanged.
  const view = new WebContentsView({
    webPreferences: { partition: 'agent-column', preload: path.join(__dirname, 'column', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  view.webContents.session.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'panel', 'preload.js') });
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  view.webContents.loadFile(path.join(__dirname, 'column', 'column.html'));

  let slot = null;
  let attached = false;
  let fullScreen = false;
  let shown = false;

  function place() {
    const want = shown && slot && !fullScreen;
    if (want && !attached) { win.contentView.addChildView(view); attached = true; }
    if (!want && attached) { win.contentView.removeChildView(view); attached = false; }
    if (want) view.setBounds(columnBounds(slot, win.webContents.getZoomFactor()));
  }
  function show(next) {
    shown = next;
    win.webContents.send('agent:shown', shown);
    place();
  }
  // Sub-project 2's "Not now" hides the column this way.
  function hide() { show(false); }
  // Load a page into the column view and show it. Task 8 names the settings
  // page with a '#settings' fragment; loadFile takes the fragment apart.
  function showPage(file) {
    const hashAt = file.indexOf('#');
    view.webContents.loadFile(hashAt === -1 ? file : file.slice(0, hashAt), hashAt === -1 ? {} : { hash: file.slice(hashAt + 1) });
    show(true);
  }

  controller.on('state', (s) => view.webContents.send('column:state', { ...s, fontUrl: `file://${path.join(pluginRoot, 'dashboard', 'fonts')}/` }));
  controller.on('data', (d) => view.webContents.send('column:data', d));
  controller.on('clear', () => view.webContents.send('column:clear'));
  view.webContents.on('did-finish-load', () => view.webContents.send('column:state', { ...controller.state(), fontUrl: `file://${path.join(pluginRoot, 'dashboard', 'fonts')}/` }));

  ipcMain.on('agent:bounds', (e, rect) => {
    if (e.sender !== win.webContents) return;
    slot = rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ? rect : null;
    place();
  });
  ipcMain.on('agent:project', async (e, folder) => {
    if (e.sender !== win.webContents || typeof folder !== 'string' || !path.isAbsolute(folder)) return;
    if (controller.sessionRunning() && controller.state().sessionProject !== folder) {
      const old = path.basename(controller.state().sessionProject);
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['End the session', 'Keep it running'], defaultId: 0, cancelId: 1,
        message: `End the agent session in "${old}"?`,
        detail: 'If you keep it running, the agent keeps working in that folder, not in the project you just opened.',
      });
      if (response === 1) return;
      controller.dispose();
    }
    await controller.setProject(folder);
    // The SDK way shows its own page in the column, so this first run stays off.
    const stored = readAgentStore(dataDir);
    if (stored.way !== 'sdk' && !stored.notNow) show(true);
  });
  ipcMain.on('agent:setup', (e) => { if (e.sender === win.webContents) { show(true); controller.refresh(); } });

  // Statement numbers: the column asks, the shell page answers from the session view.
  let lookupSeq = 0;
  const pending = new Map();
  function lookupStatement(num) {
    const id = ++lookupSeq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      setTimeout(() => { if (pending.delete(id)) resolve(null); }, 2000);
      win.webContents.send('agent:lookup', { id, num });
    });
  }
  function revealStatement(num) {
    win.webContents.send('agent:reveal', num);
    win.webContents.focus();
  }
  ipcMain.handle('column:lookup', (e, num) => {
    if (e.sender !== view.webContents || typeof num !== 'string') return null;
    return lookupStatement(num);
  });
  ipcMain.on('agent:lookup-result', (e, { id, words } = {}) => {
    if (e.sender !== win.webContents || !pending.has(id)) return;
    const resolve = pending.get(id);
    pending.delete(id);
    resolve(typeof words === 'string' ? words : null);
  });
  ipcMain.on('column:reveal', (e, num) => {
    if (e.sender !== view.webContents || typeof num !== 'string') return;
    revealStatement(num);
  });
  ipcMain.on('column:run', (e, step) => {
    if (e.sender !== view.webContents) return;
    if (step === 'not-now') show(false);
    controller.run(step);
  });
  ipcMain.on('column:write', (e, data) => { if (e.sender === view.webContents && typeof data === 'string') controller.write(data); });
  ipcMain.on('column:resize', (e, { cols, rows } = {}) => { if (e.sender === view.webContents && Number.isInteger(cols) && Number.isInteger(rows)) controller.resize(cols, rows); });

  // The menu accelerator and the terminal's own key handler may both fire for
  // one Ctrl+`; the second call within 150 ms is the same key press.
  let lastToggle = 0;
  function toggleFocus() {
    if (!attached || Date.now() - lastToggle < 150) return;
    lastToggle = Date.now();
    if (view.webContents.isFocused()) { win.webContents.focus(); win.webContents.send('agent:focus-view'); }
    else { view.webContents.focus(); view.webContents.send('column:focus'); }
  }
  ipcMain.on('column:focus-view', (e) => { if (e.sender === view.webContents) toggleFocus(); });

  // Present asks for fullscreen; the column must not sit over the projector view.
  win.webContents.on('enter-html-full-screen', () => { fullScreen = true; place(); });
  win.webContents.on('leave-html-full-screen', () => { fullScreen = false; place(); });
  win.webContents.on('zoom-changed', () => setTimeout(place, 0));
  app.on('accessibility-support-changed', () => controller.refresh());

  // The default menu's items, with the focus switch added to View (spec §6:
  // "Ctrl+` (shown in the app menu)").
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { type: 'separator' },
      { label: 'Move Focus Between Session View and Agent', accelerator: 'Ctrl+`', click: toggleFocus },
    ] },
    { role: 'windowMenu' },
  ]));

  app.on('before-quit', () => controller.dispose());
  current = {
    showPage, hide, lookupStatement, revealStatement,
    currentProject: () => controller.state().project,
    onProjectChange: (cb) => controller.on('project', cb),
  };
  return controller;
}

// The contact points the SDK way uses (agent/sdk/column.js). They need the
// live column, so each one goes through the handle setUpAgent left behind.
module.exports = {
  setUpAgent, columnBounds,
  showPage: (file) => current.showPage(file),
  hide: () => current.hide(),
  lookupStatement: (num) => current.lookupStatement(num),
  revealStatement: (num) => current.revealStatement(num),
  currentProject: () => current.currentProject(),
  onProjectChange: (cb) => current.onProjectChange(cb),
};
