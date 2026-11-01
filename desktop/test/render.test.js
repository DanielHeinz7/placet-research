'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.statementLinks = require('../agent/statement-links');
const { renderBlocks, guardLine } = require('../agent/panel/render');

test('the guard-off line: a cause that says what happened stands alone, a hook that did not run gets the sentence before it', () => {
  const noPaper = 'The placet-research guard started but found no paper project here. Open a folder made with New project… or Clone…';
  assert.equal(guardLine(noPaper), noPaper);                              // no "did not start" in front of "started"
  assert.equal(guardLine('The placet-research plugin did not load.'), 'The placet-research plugin did not load.');
  assert.equal(guardLine('The agent did not start within 30 seconds.'), 'The agent did not start within 30 seconds.');
  assert.equal(guardLine('The placet-research start hook failed.'), 'The guard did not start, so the agent stays off. The placet-research start hook failed.');
  assert.match(guardLine('The guard’s start hook did not run. Settings installed on this Mac by your organisation may turn hooks off.'), /^The guard did not start, so the agent stays off\. The guard’s start hook did not run\./);
  assert.equal(guardLine('sandbox'), 'The agent’s sandbox could not start, so the agent stays off.');
});

test('paragraphs, lists, emphasis and code', () => {
  assert.deepEqual(renderBlocks('One **two** *three* `four`\n\n- a\n- b\n\n1. c'), [
    { tag: 'p', items: [[{ type: 'text', value: 'One ' }, { type: 'strong', value: 'two' }, { type: 'text', value: ' ' }, { type: 'em', value: 'three' }, { type: 'text', value: ' ' }, { type: 'code', value: 'four' }]] },
    { tag: 'ul', items: [[{ type: 'text', value: 'a' }], [{ type: 'text', value: 'b' }]] },
    { tag: 'ol', items: [[{ type: 'text', value: 'c' }]] },
  ]);
});

test('statement numbers and web addresses become their own pieces', () => {
  assert.deepEqual(renderBlocks('See 3.4 and https://example.org/a.'), [{ tag: 'p', items: [[
    { type: 'text', value: 'See ' }, { type: 'number', value: '3.4' }, { type: 'text', value: ' and ' }, { type: 'url', value: 'https://example.org/a' }, { type: 'text', value: '.' },
  ]] }]);
  assert.deepEqual(renderBlocks('`3.4` stays code'), [{ tag: 'p', items: [[{ type: 'code', value: '3.4' }, { type: 'text', value: ' stays code' }]] }]);
});

test('HTML in model output is text', () => {
  const blocks = renderBlocks('<img src=x onerror=alert(1)> <script>x</script>');
  assert.deepEqual(blocks, [{ tag: 'p', items: [[{ type: 'text', value: '<img src=x onerror=alert(1)> <script>x</script>' }]] }]);
});

test('an underscore inside a word is not emphasis, one at a word edge is', () => {
  assert.deepEqual(renderBlocks('see research_harness_core and _this_'), [{ tag: 'p', items: [[
    { type: 'text', value: 'see research_harness_core and ' }, { type: 'em', value: 'this' },
  ]] }]);
});

test('a number inside a web address stays part of the address', () => {
  assert.deepEqual(renderBlocks('https://example.org/3.4/x'), [{ tag: 'p', items: [[{ type: 'url', value: 'https://example.org/3.4/x' }]] }]);
});
