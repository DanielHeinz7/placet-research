'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createController } = require('../agent/controller');
const { readAgentStore, writeAgentStore } = require('../agent/store');

function fakeSession() {
  const ev = new EventEmitter();
  return { pid: 1, written: [], onData: (cb) => ev.on('data', cb), onExit: (cb) => ev.on('exit', cb), write(d) { this.written.push(d); }, resize() {}, kill() { this.killed = true; }, emitData: (d) => ev.emit('data', d), exit: (code) => ev.emit('exit', code, 0) };
}

async function waitUntil(what, ok, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`the state did not reach ${what}`);
}

function setup(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ctl-'));
  const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-plugin-'));
  const spawned = [];
  const deps = {
    dataDir, pluginRoot: bundled, pluginVersion: '0.5.0', shimsDir: '/app/shims', electronPath: '/app/Electron',
    git: { bin: '/g/bin/git', execPath: '/g/libexec', configSystem: '/g/etc/gitconfig', templateDir: '/g/share' },
    baseEnv: { HOME: '/home/p' }, loginPath: async () => '/usr/bin:/bin',
    locate: async () => ({ path: '/home/p/.local/bin/claude', version: '2.1.300', supported: true }),
    authStatus: async () => ({ loggedIn: true, method: 'claude.ai', plan: 'pro' }),
    spawn: (opts) => { const s = fakeSession(); s.opts = opts; spawned.push(s); return s; },
    markerTimeoutMs: 300, markerIntervalMs: 10, screenReaderMode: () => false,
    ...over,
  };
  return { ctl: createController(deps), deps, spawned, dataDir, bundled };
}

test('no project: nothing is checked or started', async () => {
  const { ctl, spawned } = setup();
  await ctl.refresh();
  assert.equal(ctl.state().phase, 'no-project');
  assert.equal(spawned.length, 0);
});

test('missing, outdated, signed out, ready', async () => {
  for (const [over, phase] of [
    [{ locate: async () => null }, 'missing'],
    [{ locate: async () => ({ path: '/c', version: '2.1.200', supported: false }) }, 'outdated'],
    [{ authStatus: async () => ({ loggedIn: false, method: null, plan: null }) }, 'signed-out'],
    [{}, 'ready'],
  ]) {
    const { ctl } = setup(over);
    await ctl.setProject('/papers/a');
    assert.equal(ctl.state().phase, phase);
  }
});

test('the plan label shows only for a claude.ai sign-in', async () => {
  const a = setup();
  await a.ctl.setProject('/papers/a');
  assert.equal(a.ctl.state().plan, 'Claude Pro');
  const b = setup({ authStatus: async () => ({ loggedIn: true, method: 'api-key', plan: 'pro' }) });
  await b.ctl.setProject('/papers/a');
  assert.equal(b.ctl.state().plan, null);
});

test('start: the spec argv in the project folder, a fresh marker path, the guard confirmed', async () => {
  const { ctl, spawned, bundled, dataDir } = setup();
  await ctl.setProject('/papers/a');
  await ctl.run('start');
  const s = spawned[0];
  assert.equal(s.opts.file, '/home/p/.local/bin/claude');
  assert.deepEqual(s.opts.args.slice(0, 2), ['--plugin-dir', bundled]);
  assert.equal(s.opts.cwd, '/papers/a');
  assert.equal(s.opts.env.PATH, '/app/shims:/usr/bin:/bin');
  const marker = s.opts.env.PLACET_RESEARCH_APP_MARKER;
  assert.ok(marker.startsWith(path.join(dataDir, 'agent')));
  fs.writeFileSync(marker, JSON.stringify({ pluginRoot: bundled, version: '0.5.0', pid: 9 }));
  await ctl.markerSettled();
  assert.equal(ctl.state().phase, 'running');
  assert.equal(ctl.state().guard.text, 'Guard on · placet-research 0.5.0');
  assert.equal(readAgentStore(dataDir).way, 'claude-code');
  assert.deepEqual(readAgentStore(dataDir).started, ['/papers/a']);
});

test('a marker that arrives after the timeout turns the warning into Guard on', async () => {
  const { ctl, spawned, bundled } = setup();
  await ctl.setProject('/papers/a');
  await ctl.run('start');
  const marker = spawned[0].opts.env.PLACET_RESEARCH_APP_MARKER;
  await waitUntil('the unconfirmed guard line', () => ctl.state().guard.warn === true);
  assert.equal(ctl.state().guard.text, "Guard not confirmed. The agent's writes may not be checked in this session.");
  assert.match(ctl.state().guard.detail, /trust this folder/);
  fs.writeFileSync(marker, JSON.stringify({ pluginRoot: bundled, version: '0.5.0', pid: 9 }));
  await ctl.markerSettled();
  assert.equal(ctl.state().guard.text, 'Guard on · placet-research 0.5.0');
  assert.equal(ctl.state().guard.warn, false);
});

test('a marker from the previous session does not confirm the next one', async () => {
  const { ctl, spawned, bundled } = setup();
  await ctl.setProject('/papers/a');
  await ctl.run('start');
  const first = spawned[0].opts.env.PLACET_RESEARCH_APP_MARKER;
  fs.writeFileSync(first, JSON.stringify({ pluginRoot: bundled, version: '0.5.0', pid: 9 }));
  await ctl.markerSettled();
  spawned[0].exit(0);
  await ctl.run('restart');
  const second = spawned[1].opts.env.PLACET_RESEARCH_APP_MARKER;
  assert.notEqual(second, first);
  assert.equal(fs.existsSync(first), false, 'the old marker is removed');
  spawned[1].exit(0);
  await ctl.markerSettled();
  assert.equal(ctl.state().guard.warn, true);
  assert.equal(ctl.state().guard.detail, 'The session did not start.');
});

test('continue is offered only for a folder the app started a session in, and passes --continue', async () => {
  const { ctl, spawned } = setup();
  await ctl.setProject('/papers/a');
  assert.equal(ctl.state().canContinue, false);
  await ctl.run('start');
  spawned[0].exit(0);
  await ctl.setProject('/papers/a');
  assert.equal(ctl.state().canContinue, true);
  await ctl.run('continue');
  assert.ok(spawned[1].opts.args.includes('--continue'));
  spawned[1].exit(0);
});

test('one session at a time: starting again ends the running one', async () => {
  const { ctl, spawned } = setup();
  await ctl.setProject('/papers/a');
  await ctl.run('start');
  await ctl.run('new');
  assert.equal(spawned[0].killed, true);
  assert.equal(spawned.length, 2);
  spawned[1].exit(0);
});

test('install, sign-in and update run in the pty; a failed step keeps its output and says so', async () => {
  const { ctl, spawned } = setup({ locate: async () => null });
  await ctl.setProject('/papers/a');
  await ctl.run('install');
  assert.deepEqual([spawned[0].opts.file, ...spawned[0].opts.args], ['/bin/bash', '-c', 'curl -fsSL https://claude.ai/install.sh | bash']);
  assert.equal(ctl.state().phase, 'step-running');
  spawned[0].exit(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(ctl.state().phase, 'step-failed');
  assert.equal(ctl.state().exit.code, 1);

  const b = setup({ authStatus: async () => ({ loggedIn: false, method: null, plan: null }) });
  await b.ctl.setProject('/papers/a');
  await b.ctl.run('login');
  assert.deepEqual(b.spawned[0].opts.args, ['auth', 'login', '--claudeai']);
  const c = setup({ locate: async () => ({ path: '/c', version: '2.1.200', supported: false }) });
  await c.ctl.setProject('/papers/a');
  await c.ctl.run('update');
  assert.deepEqual([c.spawned[0].opts.file, ...c.spawned[0].opts.args], ['/c', 'update']);
});

test('claude exiting shows the code in plain words', async () => {
  const { ctl, spawned } = setup();
  await ctl.setProject('/papers/a');
  await ctl.run('start');
  spawned[0].exit(2);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ctl.state().exit, { code: 2, words: 'Claude Code stopped with exit code 2.' });
  assert.equal(ctl.state().phase, 'exited');
});

test('not now and the screen-reader setting are remembered; the store holds no secrets', async () => {
  const { ctl, dataDir } = setup();
  await ctl.setProject('/papers/a');
  await ctl.run('screen-reader-on');
  await ctl.run('start');
  await ctl.run('not-now');
  const stored = readAgentStore(dataDir);
  assert.equal(stored.notNow, true);
  assert.equal(stored.screenReader, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'agent.json'), 'utf8'), /@|org|token/i);
});

test('the SDK way: Claude Code is not checked or started, and the first run is skipped', async () => {
  let located = 0;
  let checked = 0;
  const { ctl, dataDir, spawned } = setup({
    locate: async () => { located += 1; return { path: '/c', version: '2.1.300', supported: true }; },
    authStatus: async () => { checked += 1; return { loggedIn: true, method: 'claude.ai', plan: 'pro' }; },
  });
  writeAgentStore(dataDir, { way: 'sdk' });
  await ctl.setProject('/papers/a');
  assert.equal(located, 0, 'Claude Code is not looked for');
  assert.equal(checked, 0, 'the sign-in is not checked');
  assert.equal(spawned.length, 0, 'nothing is started');
  assert.equal(ctl.state().phase, 'no-project', 'the state stays idle');
  assert.equal(ctl.state().project, '/papers/a', 'the project is still recorded for the column');
});

test('the project event fires when the folder actually changes', async () => {
  const { ctl } = setup();
  const seen = [];
  ctl.on('project', (folder) => seen.push(folder));
  await ctl.setProject('/papers/a');
  await ctl.setProject('/papers/a');
  await ctl.setProject('/papers/b');
  assert.deepEqual(seen, ['/papers/a', '/papers/b']);
});

test('the column view follows the slot, scaled by the page zoom', () => {
  const { columnBounds } = require('../agent/index');
  assert.deepEqual(columnBounds({ x: 900, y: 0, width: 540, height: 900 }, 1), { x: 900, y: 0, width: 540, height: 900 });
  assert.deepEqual(columnBounds({ x: 900, y: 0, width: 540, height: 900 }, 1.25), { x: 1125, y: 0, width: 675, height: 1125 });
  assert.equal(columnBounds(null, 1), null);
});
