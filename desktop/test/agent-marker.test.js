'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMarker, classify, waitForMarker, guardLine } = require('../agent/marker');

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rh-mk-'));

test('the three outcomes of spec §5.4', () => {
  const bundled = dir();
  const other = dir();
  assert.deepEqual(classify({ pluginRoot: bundled, version: '0.5.0' }, { bundledRoot: bundled }), { kind: 'bundled', version: '0.5.0' });
  assert.deepEqual(classify({ pluginRoot: other, version: '0.4.2' }, { bundledRoot: bundled }), { kind: 'other', version: '0.4.2' });
  assert.deepEqual(classify(null, { bundledRoot: bundled }), { kind: 'missing', version: null });
});

test('a symlinked path to the bundled copy still counts as the bundled copy', () => {
  const bundled = dir();
  const link = path.join(dir(), 'link');
  fs.symlinkSync(bundled, link);
  assert.equal(classify({ pluginRoot: link, version: '0.5.0' }, { bundledRoot: bundled }).kind, 'bundled');
});

test('a malformed marker is no marker', () => {
  const d = dir();
  for (const body of ['', 'not json', '{"version":"1"}', '{"pluginRoot":42}']) {
    fs.writeFileSync(path.join(d, 'm.json'), body);
    assert.equal(readMarker(path.join(d, 'm.json')), null, body);
  }
});

test('waits for the marker, and stops early when the session ended', async () => {
  const d = dir();
  const file = path.join(d, 'm.json');
  setTimeout(() => fs.writeFileSync(file, JSON.stringify({ pluginRoot: d, version: '0.5.0', pid: 1 })), 100);
  assert.equal((await waitForMarker(file, { timeoutMs: 2000, intervalMs: 20 })).pluginRoot, d);
  const started = Date.now();
  assert.equal(await waitForMarker(path.join(d, 'never.json'), { timeoutMs: 5000, intervalMs: 20, exited: () => true }), null);
  assert.ok(Date.now() - started < 1000);
});

test('a marker that arrives after the timeout still counts, and the timeout is reported once', async () => {
  const d = dir();
  const file = path.join(d, 'm.json');
  let told = 0;
  setTimeout(() => fs.writeFileSync(file, JSON.stringify({ pluginRoot: d, version: '0.5.0', pid: 1 })), 200);
  const marker = await waitForMarker(file, { timeoutMs: 50, intervalMs: 20, onTimeout: () => { told += 1; } });
  assert.deepEqual(marker, { pluginRoot: d, version: '0.5.0' });
  assert.equal(told, 1);
});

test('after the timeout the watch keeps going until the session exits', async () => {
  const d = dir();
  let exited = false;
  const watching = waitForMarker(path.join(d, 'never.json'), { timeoutMs: 30, intervalMs: 20, exited: () => exited });
  const settled = await Promise.race([watching.then(() => 'settled'), new Promise((r) => setTimeout(() => r('watching'), 150))]);
  assert.equal(settled, 'watching', 'the timeout alone does not end the watch');
  exited = true;
  assert.equal(await watching, null);
});

test('the guard lines say what the spec says', () => {
  assert.deepEqual(guardLine({ kind: 'bundled', version: '0.5.0' }, {}), { text: 'Guard on · placet-research 0.5.0', detail: null, warn: false });
  assert.deepEqual(guardLine({ kind: 'other', version: '0.4.2' }, {}), { text: 'Guard on · placet-research 0.4.2 from your Claude Code settings', detail: null, warn: false });
  const missing = guardLine({ kind: 'missing', version: null }, { exited: false });
  assert.equal(missing.text, "Guard not confirmed. The agent's writes may not be checked in this session.");
  assert.match(missing.detail, /^Claude Code may be asking whether to trust this folder; the answer goes in the terminal below\./);
  assert.match(missing.detail, /organisation's settings may turn hooks off.*The app cannot stop Claude Code/);
  assert.match(guardLine({ kind: 'missing', version: null }, { exited: true }).detail, /The session did not start/);
});
