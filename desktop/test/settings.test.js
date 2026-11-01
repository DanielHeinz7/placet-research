'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSettings, writeSettings } = require('../agent/sdk/settings');

test('connection and session IDs are kept, a secret field is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-set-'));
  assert.deepEqual(readSettings(dir), { connection: null, sessions: {} });
  writeSettings(dir, { connection: { kind: 'gateway', url: 'https://g', model: 'm' } });
  writeSettings(dir, { sessions: { '/p': 's-1' } });
  assert.deepEqual(readSettings(dir), { connection: { kind: 'gateway', url: 'https://g', model: 'm' }, sessions: { '/p': 's-1' } });
  assert.throws(() => writeSettings(dir, { connection: { kind: 'anthropic', model: 'm', secret: 'x' } }), /secret/);
  // The refused write left the file as it was.
  assert.deepEqual(readSettings(dir).connection, { kind: 'gateway', url: 'https://g', model: 'm' });
});

test('a settings file that is empty, not JSON or not an object reads as no settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-set-'));
  for (const text of ['', '{not json', 'null']) {
    fs.writeFileSync(path.join(dir, 'agent-sdk.json'), text);
    assert.deepEqual(readSettings(dir), { connection: null, sessions: {} });
  }
});
