'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readAgentStore, writeAgentStore } = require('../agent/store');
const { findStatementTokens } = require('../agent/statement-links');

test('the store keeps the SDK way as well as Claude Code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-way-'));
  assert.equal(readAgentStore(dir).way, null);
  writeAgentStore(dir, { way: 'sdk' });
  assert.equal(readAgentStore(dir).way, 'sdk');
  writeAgentStore(dir, { way: 'claude-code' });
  assert.equal(readAgentStore(dir).way, 'claude-code');
  writeAgentStore(dir, { way: 'cloud' });
  assert.equal(readAgentStore(dir).way, null);
});

test('the matcher finds the numbers the SDK thread links', () => {
  assert.deepEqual(findStatementTokens('See 3.4.'), [{ num: '3.4', start: 4, end: 7 }]);
  assert.deepEqual(findStatementTokens('version 2.1.300 and 0.5.0'), []);
});
