'use strict';
// Main-process side of the SDK way: loads the panel into the agent column,
// keeps the connection, reads the secret from the Keychain and hands it to
// the host over its message port, and forwards events to the panel.
const os = require('node:os');
const path = require('node:path');
const { readAgentStore, writeAgentStore } = require('../store');
const { findStatementTokens } = require('../statement-links');
const { readSettings, writeSettings } = require('./settings');
const keychain = require('./keychain');
const connection = require('./connection');
const { binaryPath } = require('./binary');

// What the person reads when the Keychain says no. Chosen by the error's code,
// never taken from its message: a raw `security` error can echo its input, key
// included. keychain.js sets no timeout of its own (a Keychain prompt may need
// the person at the Mac), and nothing here adds one.
const KEYCHAIN_WORDS = {
  'bad-secret': 'The key is empty, contains a line break, or is longer than about 4 KB. Paste only the key.',
  'keychain-write': 'The key could not be stored in the Keychain. Unlock the login Keychain, then try again.',
  'keychain-denied': 'The app was not allowed to read the key from the Keychain. Allow it when the Keychain asks, or connect again.',
};
const keychainWords = (err) => KEYCHAIN_WORDS[err && err.code] || 'The Keychain did not answer as expected. Try again.';
const REMOVE_FAILED = 'The saved key could not be removed from the Keychain. Try again, or delete it in Keychain Access.';
const TEST_FAILED = 'The connection test could not run. Try again.';
const MODELS_FAILED = 'The model list could not be loaded. Type the model name instead.';
// Early check, so a key that cannot be stored is not sent to a model first.
// keychain.js stays the authority: its line limit (about 4 KB) is exact, this
// one only needs to be no looser than the shortest case.
const unstorable = (key) => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(key) || Buffer.byteLength(key) > 4000;

const asDraft = (draft) => (draft && typeof draft === 'object' ? draft : {});
const asSecret = (secret) => (typeof secret === 'string' ? secret : '');

function registerAgentSdk({ app, ipcMain, utilityProcess, column, dataDir, pluginRoot, keychainOpts = {} }) {
  const panelPage = path.join(__dirname, '..', 'panel', 'panel.html');
  const base = { binary: binaryPath(), configDir: path.join(dataDir, 'agent-sdk'), home: os.homedir(), appVersion: app.getVersion() };
  let host = null;
  let panel = null;

  const toPanel = (event) => { if (panel && !panel.isDestroyed()) panel.send('sdk:event', event); };

  // The environment holds the search path and nothing else, and the arguments
  // none: the secret goes in a message afterwards, never here.
  function forkHost() {
    const child = utilityProcess.fork(path.join(__dirname, 'host.js'), [], { env: { PATH: '/usr/bin:/bin' }, serviceName: 'placet-research agent' });
    child.on('exit', (code) => { if (host === child) { host = null; toPanel({ kind: 'stopped', reason: `code ${code}` }); } });
    return child;
  }

  function endConversation() {
    if (!host) return;
    const h = host;
    host = null;
    h.postMessage({ type: 'close' });
    const timer = setTimeout(() => h.kill(), 3000);
    h.once('exit', () => clearTimeout(timer));
  }

  // Switching kind leaves the old kind's Keychain item behind, so a removed or
  // replaced connection takes every kind's item with it (all but `keep`). A
  // kind that was never stored is not an error. Failures are shown in the
  // fixed words, never what security printed.
  async function removeSecrets(keep) {
    for (const kind of keychain.KINDS) if (kind !== keep) await keychain.removeSecret(kind, keychainOpts);
  }

  async function secretFor(conn) {
    return connection.needsSecret(conn) ? keychain.readSecret(connection.secretKind(conn), keychainOpts) : null;
  }

  const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => { panel = e.sender; return fn(...args); });

  handle('sdk:state', () => {
    const { connection: conn, sessions } = readSettings(dataDir);
    const project = column.currentProject();
    return { way: readAgentStore(dataDir).way, connection: conn, kindName: conn ? connection.KIND_NAMES[conn.kind] : null, project, canResume: Boolean(project && sessions[project]) };
  });

  handle('sdk:choose-way', (way) => {
    if (way !== 'claude-code' && way !== 'sdk') return { ok: false };
    writeAgentStore(dataDir, { way });
    if (way === 'claude-code') { endConversation(); column.showPage(path.join(__dirname, '..', 'column', 'column.html')); }  // sub-project 2's page, per Task 0
    return { ok: true };
  });

  handle('sdk:hide', () => column.hide());

  handle('sdk:list-models', async (draft, secret) => {
    const v = connection.validate({ ...asDraft(draft), model: asDraft(draft).model || '-' });
    if (!v.ok) return { ok: false, field: v.field, error: v.error };
    try { return { ok: true, models: await connection.listModels(v.conn, asSecret(secret)) }; } catch (err) {
      // listModels words its own failures; anything else gets fixed words.
      return { ok: false, error: err && (err.code === 'unreachable' || err.code === 'authentication_failed') ? err.message : MODELS_FAILED };
    }
  });

  handle('sdk:connect', async (draft, secret) => {
    const v = connection.validate(asDraft(draft));
    if (!v.ok) return v;
    const kept = connection.needsSecret(v.conn);
    const key = kept ? asSecret(secret) : null;
    if (kept && !key) return { ok: false, field: 'secret', error: 'Paste the key or token.' };
    if (kept && unstorable(key)) return { ok: false, field: 'secret', error: KEYCHAIN_WORDS['bad-secret'] };
    const tester = forkHost();
    tester.postMessage({ type: 'test', conn: v.conn, secret: key, base });
    const result = await new Promise((resolve) => {
      tester.once('message', resolve);
      tester.once('exit', () => resolve({ ok: false, error: TEST_FAILED }));
    });
    tester.kill();
    if (!result.ok) return { ok: false, error: result.error };
    try { if (kept) await keychain.saveSecret(connection.secretKind(v.conn), key, keychainOpts); } catch (err) {
      return { ok: false, ...(err && err.code === 'bad-secret' ? { field: 'secret' } : {}), error: keychainWords(err) };
    }
    // The new key is stored; the old kind's key goes before the connection is switched.
    try { await removeSecrets(kept ? connection.secretKind(v.conn) : null); } catch { return { ok: false, error: REMOVE_FAILED }; }
    writeSettings(dataDir, { connection: v.conn });
    return { ok: true };
  });

  handle('sdk:remove-connection', async () => {
    endConversation();
    // removeSecret passes security's own error on; none of it is shown.
    try { await removeSecrets(null); } catch { return { ok: false, error: REMOVE_FAILED }; }
    writeSettings(dataDir, { connection: null });
    return { ok: true };
  });

  handle('sdk:start', async (opts) => {
    const resume = Boolean(opts && opts.resume);
    endConversation();
    const { connection: conn, sessions } = readSettings(dataDir);
    const cwd = column.currentProject();
    if (!conn) return { ok: false, error: 'connect' };
    if (!cwd) return { ok: false, error: 'Open a project first.' };
    let secret;
    try { secret = await secretFor(conn); } catch (err) { return { ok: false, error: keychainWords(err), next: 'connect' }; }
    if (connection.needsSecret(conn) && !secret) return { ok: false, error: 'The key is no longer in the Keychain.', next: 'connect' };
    endConversation();                                   // a second start may have run while the Keychain answered
    host = forkHost();
    const mine = host;
    host.on('message', (m) => {
      if (m.type !== 'event' || host !== mine) return;
      if (m.event.kind === 'session') writeSettings(dataDir, { sessions: { ...readSettings(dataDir).sessions, [cwd]: m.event.sessionId } });
      toPanel({ ...m.event, connKind: conn.kind });
    });
    host.postMessage({ type: 'start', conn, secret, base, cwd, pluginRoot, shimsDir: path.join(__dirname, '..', 'shims'), shimEnv: column.shimEnv(), resume: resume ? sessions[cwd] : undefined });
    return { ok: true, model: conn.model, kindName: connection.KIND_NAMES[conn.kind] };
  });

  handle('sdk:send', (text) => { if (host) host.postMessage({ type: 'send', text: String(text) }); });
  handle('sdk:stop', () => { if (host) host.postMessage({ type: 'stop' }); });
  handle('sdk:answer', (id, allow) => { if (host) host.postMessage({ type: 'answer', id: String(id), allow: allow === true }); });
  const isNumber = (n) => { const t = findStatementTokens(String(n)); return t.length === 1 && t[0].num === n; };
  handle('sdk:lookup', (number) => (isNumber(number) ? column.lookupStatement(number) : null));
  handle('sdk:reveal', (number) => (isNumber(number) ? column.revealStatement(number) : undefined));
  handle('sdk:pick-file', async () => {
    const { BrowserWindow, dialog } = require('electron');
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ['openFile'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('sdk:open-external', (url) => { if (typeof url === 'string' && url.startsWith('https://')) require('electron').shell.openExternal(url); });

  column.onProjectChange(() => { endConversation(); toPanel({ kind: 'project-changed' }); });

  return {
    panelPage,
    shutdown: async () => { endConversation(); },
  };
}

module.exports = { registerAgentSdk };
