'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const canvas = require('../hooks/lib/canvas');
const numbers = require('../hooks/lib/numbers');

const fixture = (name) => canvas.parseCanvas(fs.readFileSync(path.join(__dirname, 'fixtures', name, 'research', 'canvas.md'), 'utf8'));

test('a statement is numbered by its question, further statements get b, c', () => {
  assert.equal(numbers.statementNumber({ id: '3.1' }, 0), '3.1');
  assert.equal(numbers.statementNumber({ id: '3.1' }, 1), '3.1b');
  assert.equal(numbers.statementNumber({ id: '3.1' }, 2), '3.1c');
});

test('numbers follow file order in the fixture', () => {
  assert.deepEqual(numbers.numberedStatements(fixture('voice-uptake')).map((s) => s.num), ['1.1', '1.2', '1.2b', '2.2', '3.1', '5.1']);
  assert.deepEqual(numbers.openProposalNumbers(fixture('voice-uptake')), ['1.2b', '2.2']);
});

test('the session view carries the same function, character for character', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'canvas.html'), 'utf8');
  assert.ok(html.includes(numbers.statementNumber.toString()), 'canvas.html statementNumber differs from hooks/lib/numbers.js');
});
