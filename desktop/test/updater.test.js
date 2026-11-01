'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdater, fileSettings, plainError, DAY } = require('../updater');

function fakeUpdater() {
  const u = new EventEmitter();
  u.checks = 0;
  u.installs = 0;
  u.offer = null;
  u.fail = null;
  u.checkForUpdates = async () => {
    u.checks += 1;
    if (u.fail) { const err = new Error(u.fail); u.emit('error', err); throw err; }
    if (u.offer) { u.emit('update-available', { version: u.offer }); u.emit('update-downloaded', { version: u.offer }); }
    else u.emit('update-not-available', { version: '0.6.0' });
    return null;
  };
  u.quitAndInstall = () => { u.installs += 1; };
  return u;
}
const memory = (value = true) => ({ value, get() { return this.value; }, set(v) { this.value = v; } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(over = {}) {
  const autoUpdater = fakeUpdater();
  const sent = [];
  const timers = [];
  const updater = createUpdater({ signing: 'developer-id', autoUpdater, settings: memory(), send: (m) => sent.push(m), every: (fn, ms) => timers.push({ fn, ms }), ...over });
  return { autoUpdater, sent, timers, updater };
}

test('a build whose signing is none gets no updater and never checks', () => {
  const autoUpdater = fakeUpdater();
  assert.equal(createUpdater({ signing: 'none', autoUpdater, settings: memory(), send: () => {} }), null);
  assert.equal(createUpdater({ signing: undefined, autoUpdater, settings: memory(), send: () => {} }), null);
  assert.equal(autoUpdater.checks, 0);
});

test('downloads in the background, installs on quit, no prereleases, no downgrades', () => {
  const { autoUpdater } = setup();
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(autoUpdater.allowPrerelease, false);
  assert.equal(autoUpdater.allowDowngrade, false);
});

test('checks at start and once a day while the setting is on', async () => {
  const { autoUpdater, timers, updater } = setup();
  updater.start();
  await tick();
  assert.equal(autoUpdater.checks, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, DAY);
  timers[0].fn();
  await tick();
  assert.equal(autoUpdater.checks, 2);
});

test('with the setting off it checks neither at start nor daily', async () => {
  const settings = memory(false);
  const { autoUpdater, timers, updater } = setup({ settings });
  updater.start();
  timers[0].fn();
  await tick();
  assert.equal(autoUpdater.checks, 0);
});

test('automatic checks are quiet unless an update is ready', async () => {
  const { autoUpdater, sent, updater } = setup();
  autoUpdater.fail = 'net::ERR_INTERNET_DISCONNECTED';
  updater.start();
  await tick();
  autoUpdater.fail = null;
  updater.start();
  await tick();
  assert.deepEqual(sent, []);
  autoUpdater.offer = '0.7.0';
  updater.start();
  await tick();
  assert.deepEqual(sent, [{ state: 'ready', version: '0.7.0' }]);
});

test('a check by hand always answers', async () => {
  const { autoUpdater, sent, updater } = setup();
  await updater.checkNow();
  autoUpdater.fail = 'getaddrinfo ENOTFOUND github.com';
  await updater.checkNow();
  autoUpdater.fail = null;
  autoUpdater.offer = '0.7.0';
  await updater.checkNow();
  assert.deepEqual(sent, [
    { state: 'current', version: '0.6.0' },
    { state: 'error', message: 'No connection to GitHub. Check again when you are online.' },
    { state: 'downloading', version: '0.7.0' },
    { state: 'ready', version: '0.7.0' },
  ]);
  assert.deepEqual(updater.last(), { state: 'ready', version: '0.7.0' });
  updater.restart();
  assert.equal(autoUpdater.installs, 1);
});

test('other errors are cut to their first line', () => {
  assert.equal(plainError(new Error(`Cannot find latest-mac.yml\n${'x'.repeat(500)}`)), 'The update check did not work: Cannot find latest-mac.yml');
  assert.ok(plainError(new Error('y'.repeat(500))).length <= 'The update check did not work: '.length + 200);
});

test('the setting lives in the app data folder and defaults to on', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = fileSettings(dir);
  assert.equal(s.get(), true);
  s.set(false);
  assert.equal(fileSettings(dir).get(), false);
  fs.writeFileSync(path.join(dir, 'updates.json'), '{ broken');
  assert.equal(fileSettings(dir).get(), true);
});
