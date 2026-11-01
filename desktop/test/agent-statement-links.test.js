'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findStatementTokens, mapToCells } = require('../agent/statement-links');

const nums = (s) => findStatementTokens(s).map((t) => t.num);

test('matches statement numbers, with and without a letter', () => {
  assert.deepEqual(nums('3.4'), ['3.4']);
  assert.deepEqual(nums('see 3.4.'), ['3.4']);
  assert.deepEqual(nums('(1.2b) and 2.2, then 9.999'), ['1.2b', '2.2', '9.999']);
  assert.deepEqual(nums('3.4-3.6'), ['3.4', '3.6']);
});

test('does not match versions or longer numbers', () => {
  assert.deepEqual(nums('Claude Code 2.1.300'), []);
  assert.deepEqual(nums('version 0.5.0'), []);
  assert.deepEqual(nums('3.4.1'), []);
  assert.deepEqual(nums('v3.4'), []);
  assert.deepEqual(nums('13.4'), []);
  assert.deepEqual(nums('3.1000'), []);
  assert.deepEqual(nums('3.0'), []);
  assert.deepEqual(nums('3.1bc'), []);
});

test('reports string ranges', () => {
  assert.deepEqual(findStatementTokens('see 1.2b now'), [{ num: '1.2b', start: 4, end: 8 }]);
});

test('maps string indices to terminal cells across wide characters', () => {
  // "⏺ 中 1.2": ⏺ is one cell, 中 two cells (xterm gives the second cell empty chars, width 0).
  const cells = [{ chars: '⏺', width: 1 }, { chars: ' ', width: 1 }, { chars: '中', width: 2 }, { chars: '', width: 0 }, { chars: ' ', width: 1 }, { chars: '1', width: 1 }, { chars: '.', width: 1 }, { chars: '2', width: 1 }];
  const { text, cellAt } = mapToCells(cells);
  assert.equal(text, '⏺ 中 1.2');
  const [tok] = findStatementTokens(text);
  assert.equal(cellAt[tok.start], 5);
  assert.equal(cellAt[tok.end - 1], 7);
});
