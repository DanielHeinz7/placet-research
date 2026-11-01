'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { startFakeModel } = require('./support/fake-model');
const { shimEnv } = require('./support/shim-env');
const { binaryPath } = require('../agent/sdk/binary');
const { registerAgentSdk } = require('../agent/sdk/controller');
const { readSettings, writeSettings } = require('../agent/sdk/settings');
const { saveSecret, readSecret } = require('../agent/sdk/keychain');

const hostFile = path.join(__dirname, '..', 'agent', 'sdk', 'host.js');
const pluginSrc = path.join(__dirname, '..', '..', 'plugins', 'placet-research');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const baseFor = () => ({ binary: binaryPath(), configDir: tmp('rh-cfg-'), home: os.homedir(), appVersion: '0.0.0-test' });
const hexSecret = () => `fake-secret-${crypto.randomBytes(8).toString('hex')}`;

test('the host runs a connection test and reports it', { timeout: 60000 }, async () => {
  const fake = await startFakeModel({ script: [[{ type: 'text', text: 'ready' }]] });
  const child = fork(hostFile, [], { env: { PATH: '/usr/bin:/bin' } });
  const base = { binary: binaryPath(), configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cfg-')), home: os.homedir(), appVersion: '0.0.0-test' };
  child.send({ type: 'test', conn: { kind: 'gateway', url: fake.url, model: 'fake-model' }, secret: 'tok', base });
  const [reply] = await new Promise((r) => child.once('message', (m) => r([m])));
  assert.deepEqual(reply, { type: 'test-result', ok: true });
  child.kill();
  await fake.close();
});

test('the host reports a refused test connection in words, without the secret', { timeout: 60000 }, async () => {
  const fake = await startFakeModel({ status: { code: 401, type: 'authentication_error', message: 'invalid token' } });
  const secret = hexSecret();
  const child = fork(hostFile, [], { env: { PATH: '/usr/bin:/bin' } });
  child.send({ type: 'test', conn: { kind: 'gateway', url: fake.url, model: 'fake-model' }, secret, base: baseFor() });
  const [reply] = await new Promise((r) => child.once('message', (m) => r([m])));
  assert.equal(reply.type, 'test-result');
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'The token was refused.');
  assert.ok(!JSON.stringify(reply).includes(secret));
  child.kill();
  await fake.close();
});

test('the host runs a conversation: guard, a message, the session ID, and a close', { timeout: 120000 }, async () => {
  const dir = tmp('rh-host-');
  fs.cpSync(path.join(pluginSrc, 'test', 'fixtures', 'voice-uptake'), path.join(dir, 'project'), { recursive: true });
  fs.cpSync(pluginSrc, path.join(dir, 'plugin'), { recursive: true });
  const fake = await startFakeModel({ script: [[{ type: 'text', text: 'Hello back.' }]] });
  const secret = hexSecret();
  const child = fork(hostFile, [], { env: { PATH: '/usr/bin:/bin' } });
  const events = [];
  child.on('message', (m) => { if (m.type === 'event') events.push(m.event); });
  const until = async (pred) => { const end = Date.now() + 90000; while (!events.some(pred)) { if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.kind))}`); await new Promise((r) => setTimeout(r, 100)); } };

  child.send({
    type: 'start', conn: { kind: 'gateway', url: fake.url, model: 'fake-model' }, secret, base: baseFor(),
    cwd: path.join(dir, 'project'), pluginRoot: path.join(dir, 'plugin'), shimsDir: path.join(__dirname, '..', 'agent', 'shims'), shimEnv: shimEnv(),
  });
  await until((e) => e.kind === 'guard');
  assert.equal(events.find((e) => e.kind === 'guard').state, 'on');
  child.send({ type: 'send', text: 'Hello' });
  await until((e) => e.kind === 'turn-end');
  assert.ok(events.some((e) => e.kind === 'session' && typeof e.sessionId === 'string'), JSON.stringify(events));
  assert.ok(events.some((e) => e.kind === 'text' && e.text === 'Hello back.'), JSON.stringify(events));
  // A second message while none is sent is fine; a message the session refuses is reported.
  child.send({ type: 'send', text: '   ' });
  await until((e) => e.kind === 'not-sent');
  child.send({ type: 'close' });
  await until((e) => e.kind === 'ended');
  // The secret reached the binary (the fake model saw it) but no event carries it.
  assert.ok(fake.requests.some((r) => JSON.stringify(r.headers).includes(secret)), 'the model never saw the token');
  assert.ok(!JSON.stringify(events).includes(secret), 'an event carried the secret');
  child.kill();
  await fake.close();
});

// The fake `security`: a script run in a process of its own that keeps items
// in a JSON file. It answers the calls keychain.js makes (`-i` with a command
// on stdin, `find-generic-password -g`, `delete-generic-password`). Once the
// file `fail` exists, every call repeats everything it got on stderr and exits
// 1, the way a real security error can echo its input.
function fakeSecurityMain(dir) {
  const fs = require('node:fs');
  let items = {};
  try { items = JSON.parse(fs.readFileSync(`${dir}/items.json`, 'utf8')); } catch { /* none yet */ }
  const args = process.argv.slice(2);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; }).on('end', () => {
    if (fs.existsSync(`${dir}/fail`)) {
      process.stderr.write(`security: failed: ${input} ${args.join(' ')} ${JSON.stringify(items)}\n`);
      process.exitCode = 1;
      return;
    }
    const words = args[0] === '-i' ? [...input.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2])) : args;
    const at = (flag) => words[words.lastIndexOf(flag) + 1];
    const key = `${at('-s')}/${at('-a')}`;
    const save = () => fs.writeFileSync(`${dir}/items.json`, JSON.stringify(items));
    if (words[0] === 'add-generic-password') { items[key] = at('-w'); save(); }
    else if (!(key in items)) process.exitCode = 44;
    else if (words[0] === 'delete-generic-password') { delete items[key]; save(); }
    else process.stderr.write(`password: "${items[key]}"\n`);
  });
}

function fakeSecurity() {
  const dir = tmp('rh-sec-');
  const bin = path.join(dir, 'security');
  fs.writeFileSync(bin, `#!${process.execPath}\n'use strict';\n(${fakeSecurityMain})(${JSON.stringify(dir)});\n`, { mode: 0o755 });
  return { bin, fail: () => fs.writeFileSync(path.join(dir, 'fail'), ''), items: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8')); } catch { return {}; } } };
}

// The controller with Electron's parts replaced: a utility process that
// records how it was forked and what it was sent, an ipcMain that keeps the
// handlers, and a column with a fixed project.
function controller({ project = '/projects/voice-uptake', testReply = { ok: true } } = {}) {
  const dataDir = tmp('rh-ctl-');
  const sec = fakeSecurity();
  const handlers = new Map();
  const forks = [];
  const panelEvents = [];
  const utilityProcess = {
    fork: (...args) => {
      const child = new EventEmitter();
      Object.assign(child, { args, sent: [], killed: false });
      child.postMessage = (m) => {
        child.sent.push(m);
        if (m.type === 'test') setImmediate(() => child.emit('message', { type: 'test-result', ...testReply }));
        if (m.type === 'close') setImmediate(() => child.emit('exit', 0));
      };
      child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); };
      forks.push(child);
      return child;
    },
  };
  let projectChanged = () => {};
  const column = {
    currentProject: () => project, onProjectChange: (cb) => { projectChanged = cb; }, showPage() {}, hide() {},
    shimEnv: () => ({ RH_ELECTRON: '/electron' }), lookupStatement: async () => 'first words', revealStatement: async () => {},
  };
  const sender = { isDestroyed: () => false, send: (channel, event) => panelEvents.push([channel, event]) };
  registerAgentSdk({ app: { getVersion: () => '1.2.3' }, ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, utilityProcess, column, dataDir, pluginRoot: '/plugin', keychainOpts: { security: sec.bin } });
  const invoke = (channel, ...args) => handlers.get(channel)({ sender }, ...args);
  const files = () => fs.readdirSync(dataDir, { recursive: true }).map((f) => path.join(dataDir, String(f))).filter((f) => fs.statSync(f).isFile());
  return { dataDir, sec, forks, panelEvents, invoke, files, projectChanged: () => projectChanged(), keychainOpts: { security: sec.bin } };
}

const gatewayDraft = { kind: 'gateway', url: 'https://gateway.example', model: 'm-1' };
const noSecretAnywhere = (secret, ...places) => places.forEach((p) => assert.ok(!JSON.stringify(p).includes(secret), 'the secret is in ' + JSON.stringify(p).slice(0, 200)));

test('connect: the secret goes to the test host in a message, not in its arguments or environment', async () => {
  const c = controller();
  const secret = hexSecret();
  const result = await c.invoke('sdk:connect', gatewayDraft, secret);
  assert.deepEqual(result, { ok: true });
  assert.equal(c.forks.length, 1);
  const [modulePath, args, opts] = c.forks[0].args;
  assert.equal(modulePath, hostFile);
  assert.deepEqual(args, []);
  assert.deepEqual(opts.env, { PATH: '/usr/bin:/bin' });
  noSecretAnywhere(secret, c.forks[0].args, result);
  assert.equal(c.forks[0].sent.length, 1);
  assert.equal(c.forks[0].sent[0].type, 'test');
  assert.equal(c.forks[0].sent[0].secret, secret);
  assert.equal(c.forks[0].killed, true);
  // It is in the Keychain, and in no file of the app.
  assert.equal(await readSecret('gateway', c.keychainOpts), secret);
  assert.deepEqual(readSettings(c.dataDir).connection, { kind: 'gateway', url: 'https://gateway.example', model: 'm-1' });
  for (const f of c.files()) assert.ok(!fs.readFileSync(f, 'latin1').includes(secret), f);
});

test('connect: a refused test stores nothing, and a host that dies is told in words', async () => {
  const refused = controller({ testReply: { ok: false, error: 'The token was refused.' } });
  const secret = hexSecret();
  assert.deepEqual(await refused.invoke('sdk:connect', gatewayDraft, secret), { ok: false, error: 'The token was refused.' });
  assert.deepEqual(refused.sec.items(), {});
  assert.equal(readSettings(refused.dataDir).connection, null);

  const dying = controller();
  const pending = dying.invoke('sdk:connect', gatewayDraft, secret);
  // The fake answers a test on the next tick; a host that exits first has no answer.
  dying.forks[0].removeAllListeners('message');
  dying.forks[0].emit('exit', 1);
  assert.deepEqual(await pending, { ok: false, error: 'The connection test could not run. Try again.' });
  assert.deepEqual(dying.sec.items(), {});
});

test('connect: a key that cannot be stored is refused before any host is started', async () => {
  const c = controller();
  for (const secret of ['two\nlines', 'k'.repeat(4001), '']) {
    const r = await c.invoke('sdk:connect', gatewayDraft, secret);
    assert.equal(r.ok, false);
    assert.equal(r.field, 'secret');
  }
  const long = await c.invoke('sdk:connect', gatewayDraft, 'k'.repeat(4001));
  assert.match(long.error, /about 4 KB/);
  assert.equal(c.forks.length, 0);
});

test('connect: a kind without a secret sends none, and an invalid draft starts nothing', async () => {
  const c = controller();
  const vertex = { kind: 'vertex', projectId: 'my-lab-123456', region: 'europe-west1', model: 'm-1' };
  assert.deepEqual(await c.invoke('sdk:connect', vertex, 'ignored-secret'), { ok: true });
  assert.equal(c.forks[0].sent[0].secret, null);
  noSecretAnywhere('ignored-secret', c.forks[0].sent, c.forks[0].args);
  assert.deepEqual(c.sec.items(), {});
  const bad = await c.invoke('sdk:connect', { kind: 'gateway', url: 'nope', model: 'm' }, 'tok');
  assert.equal(bad.ok, false);
  assert.equal(bad.field, 'url');
  assert.equal(c.forks.length, 1);
});

test('start: the key read from the Keychain reaches the host in its start message only', async () => {
  const c = controller();
  const secret = hexSecret();
  await saveSecret('gateway', secret, c.keychainOpts);
  writeSettings(c.dataDir, { connection: { kind: 'gateway', url: 'https://gateway.example', model: 'm-1' } });

  const started = await c.invoke('sdk:start', {});
  assert.equal(started.ok, true);
  assert.equal(started.model, 'm-1');
  const host = c.forks[0];
  assert.deepEqual(host.args[2].env, { PATH: '/usr/bin:/bin' });
  noSecretAnywhere(secret, host.args, started);
  const [start] = host.sent;
  assert.equal(start.type, 'start');
  assert.equal(start.secret, secret);
  assert.equal(start.cwd, '/projects/voice-uptake');
  assert.equal(start.pluginRoot, '/plugin');
  assert.deepEqual(start.shimEnv, { RH_ELECTRON: '/electron' });
  assert.equal(start.resume, undefined);

  // Events go to the panel with the kind of connection; the session ID is kept for the project.
  host.emit('message', { type: 'event', event: { kind: 'session', sessionId: 's-9' } });
  host.emit('message', { type: 'event', event: { kind: 'text', text: 'hi' } });
  assert.deepEqual(c.panelEvents, [['sdk:event', { kind: 'session', sessionId: 's-9', connKind: 'gateway' }], ['sdk:event', { kind: 'text', text: 'hi', connKind: 'gateway' }]]);
  assert.deepEqual(readSettings(c.dataDir).sessions, { '/projects/voice-uptake': 's-9' });
  const state = await c.invoke('sdk:state');
  assert.equal(state.canResume, true);
  assert.equal(state.kindName, 'Institute gateway');
  noSecretAnywhere(secret, state, c.panelEvents);

  // Starting again closes the first conversation and resumes the stored one.
  await c.invoke('sdk:start', { resume: true });
  assert.deepEqual(host.sent.at(-1), { type: 'close' });
  assert.equal(c.forks[1].sent[0].resume, 's-9');
  for (const f of c.files()) assert.ok(!fs.readFileSync(f, 'latin1').includes(secret), f);

  // Messages, stops and answers are passed on as typed messages; nothing else.
  await c.invoke('sdk:send', 'Hello');
  await c.invoke('sdk:stop');
  await c.invoke('sdk:answer', 3, true);
  await c.invoke('sdk:answer', 4, 'yes');
  assert.deepEqual(c.forks[1].sent.slice(1), [{ type: 'send', text: 'Hello' }, { type: 'stop' }, { type: 'answer', id: '3', allow: true }, { type: 'answer', id: '4', allow: false }]);

  // A project switch ends the conversation and tells the panel.
  c.projectChanged();
  assert.deepEqual(c.forks[1].sent.at(-1), { type: 'close' });
  assert.deepEqual(c.panelEvents.at(-1), ['sdk:event', { kind: 'project-changed' }]);
});

test('start: with no connection, no project or no key in the Keychain, nothing is started', async () => {
  const none = controller();
  assert.deepEqual(await none.invoke('sdk:start', {}), { ok: false, error: 'connect' });
  const noProject = controller({ project: null });
  writeSettings(noProject.dataDir, { connection: { kind: 'gateway', url: 'https://gateway.example', model: 'm-1' } });
  assert.deepEqual(await noProject.invoke('sdk:start', {}), { ok: false, error: 'Open a project first.' });
  const gone = controller();
  writeSettings(gone.dataDir, { connection: { kind: 'gateway', url: 'https://gateway.example', model: 'm-1' } });
  assert.deepEqual(await gone.invoke('sdk:start', {}), { ok: false, error: 'The key is no longer in the Keychain.', next: 'connect' });
  assert.equal(none.forks.length + noProject.forks.length + gone.forks.length, 0);
});

test('Keychain failures are shown in fixed words, never in what security printed', async () => {
  // security's error can repeat what it was given, key included.
  const c = controller();
  const secret = hexSecret();
  c.sec.fail();
  const saved = await c.invoke('sdk:connect', gatewayDraft, secret);
  assert.equal(saved.ok, false);
  assert.equal(saved.error, 'The key could not be stored in the Keychain. Unlock the login Keychain, then try again.');
  noSecretAnywhere(secret, saved);
  assert.equal(readSettings(c.dataDir).connection, null);

  // Reading: the key was stored, then the Keychain refuses.
  const r = controller();
  await saveSecret('gateway', secret, r.keychainOpts);
  writeSettings(r.dataDir, { connection: { kind: 'gateway', url: 'https://gateway.example', model: 'm-1' } });
  r.sec.fail();
  const started = await r.invoke('sdk:start', {});
  assert.deepEqual(started, { ok: false, error: 'The app was not allowed to read the key from the Keychain. Allow it when the Keychain asks, or connect again.', next: 'connect' });
  noSecretAnywhere(secret, started);
  assert.equal(r.forks.length, 0);

  // Removing: the connection stays, so the person can try again.
  const removed = await r.invoke('sdk:remove-connection');
  assert.deepEqual(removed, { ok: false, error: 'The saved key could not be removed from the Keychain. Try again, or delete it in Keychain Access.' });
  noSecretAnywhere(secret, removed);
  assert.equal(readSettings(r.dataDir).connection.kind, 'gateway');
});

test('removing the connection deletes the key and the stored connection', async () => {
  const c = controller();
  const secret = hexSecret();
  assert.deepEqual(await c.invoke('sdk:connect', gatewayDraft, secret), { ok: true });
  assert.deepEqual(await c.invoke('sdk:remove-connection'), { ok: true });
  assert.equal(await readSecret('gateway', c.keychainOpts), null);
  assert.equal(readSettings(c.dataDir).connection, null);
});

test('removing or replacing a connection leaves no key of another kind in the Keychain', async () => {
  const kinds = ['anthropic', 'gateway', 'bedrock'];
  const stored = async (c) => (await Promise.all(kinds.map(async (k) => [k, await readSecret(k, c.keychainOpts)]))).filter(([, v]) => v !== null).map(([k]) => k);
  const stale = async (c) => { for (const k of kinds) await saveSecret(k, hexSecret(), c.keychainOpts); };

  // Remove: every kind goes, also the kinds an earlier connection stored.
  const removing = controller();
  await stale(removing);
  writeSettings(removing.dataDir, { connection: gatewayDraft });
  assert.deepEqual(await removing.invoke('sdk:remove-connection'), { ok: true });
  assert.deepEqual(await stored(removing), []);
  assert.equal(readSettings(removing.dataDir).connection, null);

  // Remove with no connection stored, but a key left behind.
  const left = controller();
  await saveSecret('anthropic', hexSecret(), left.keychainOpts);
  assert.deepEqual(await left.invoke('sdk:remove-connection'), { ok: true });
  assert.deepEqual(await stored(left), []);

  // Replace: the new kind's key stays, the others go.
  const replacing = controller();
  await stale(replacing);
  const fresh = hexSecret();
  assert.deepEqual(await replacing.invoke('sdk:connect', gatewayDraft, fresh), { ok: true });
  assert.deepEqual(await stored(replacing), ['gateway']);
  assert.equal(await readSecret('gateway', replacing.keychainOpts), fresh);

  // A kind that keeps no secret leaves none at all.
  const vertex = controller();
  await stale(vertex);
  assert.deepEqual(await vertex.invoke('sdk:connect', { kind: 'vertex', projectId: 'my-lab-123456', region: 'europe-west1', model: 'm-1' }), { ok: true });
  assert.deepEqual(await stored(vertex), []);
});

test('only a statement number is looked up or revealed, and only a known way is stored', async () => {
  const c = controller();
  assert.equal(await c.invoke('sdk:lookup', '3.4'), 'first words');
  assert.equal(await c.invoke('sdk:lookup', '3.4; rm'), null);
  assert.equal(await c.invoke('sdk:lookup', 34), null);
  assert.deepEqual(await c.invoke('sdk:choose-way', 'cloud'), { ok: false });
  assert.deepEqual(await c.invoke('sdk:choose-way', 'sdk'), { ok: true });
  assert.equal((await c.invoke('sdk:state')).way, 'sdk');
});
