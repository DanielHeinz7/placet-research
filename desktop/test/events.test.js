'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMapper, toolLine } = require('../agent/sdk/events');

const recorded = fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-messages', 'guard.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const all = () => { const map = createMapper({ cwd: '/project' }); return recorded.flatMap(map); };

test('the recorded guard denials become refusal lines', () => {
  const refusals = all().filter((e) => e.kind === 'refusal');
  assert.equal(refusals.length, 2);
  assert.equal(refusals[0].tool, 'Bash');
  assert.equal(refusals[0].statement, '3.2');
  assert.match(refusals[0].reason, /^Accepting a statement is the researcher's act/);
  assert.equal(refusals[1].tool, 'Edit');
  assert.equal(refusals[1].statement, null);
  assert.match(refusals[1].reason, /cannot be promoted to \[accepted\]/);
});

test('session, tool lines, usage and turn end come out of the recording', () => {
  const ev = all();
  assert.equal(ev[0].kind, 'session');
  assert.ok(ev.some((e) => e.kind === 'tool' && e.line === 'Ran placet-research accept 3.2 --explained "x"'));
  assert.ok(ev.some((e) => e.kind === 'tool' && e.line === 'Edited research/canvas.md'));
  assert.ok(ev.some((e) => e.kind === 'usage' && e.tokens > 0));
  assert.equal(ev.at(-1).kind, 'turn-end');
});

test('tool lines in plain words', () => {
  assert.equal(toolLine('Read', { file_path: '/project/research/canvas.md' }, '/project'), 'Read research/canvas.md');
  assert.equal(toolLine('Read', { file_path: '/etc/hosts' }, '/project'), 'Read /etc/hosts');
  assert.equal(toolLine('Write', { file_path: '/project/a.md' }, '/project'), 'Wrote a.md');
  assert.equal(toolLine('Bash', { command: 'placet-research status\nmore' }, '/project'), 'Ran placet-research status');
  assert.equal(toolLine('WebSearch', { query: 'voice uptake' }, '/project'), 'Searched the web for “voice uptake”');
  assert.equal(toolLine('WebFetch', { url: 'https://example.org/x' }, '/project'), 'Fetched https://example.org/x');
  assert.equal(toolLine('Grep', { pattern: 'uptake' }, '/project'), 'Searched the project for “uptake”');
  assert.equal(toolLine('Skill', { skill: 'placet-research:canvas' }, '/project'), 'Used the skill placet-research:canvas');
  assert.equal(toolLine('Task', { description: 'Check sources' }, '/project'), 'Started a helper: Check sources');
  // C8: the binary lists the subagent tool as `Task`, the model calls it `Agent`.
  assert.equal(toolLine('Agent', { description: 'Check sources' }, '/project'), 'Started a helper: Check sources');
  assert.equal(toolLine('Other', {}, '/project'), 'Used Other');
});

test('streamed fragments are deltas; the finished block carries the whole text', () => {
  const map = createMapper({ cwd: '/project' });
  const delta = (t) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
  assert.deepEqual([...map(delta('see 3.')), ...map(delta('4'))], [{ kind: 'delta', text: 'see 3.' }, { kind: 'delta', text: '4' }]);
  assert.deepEqual(map({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'see 3.4' }] } }), [{ kind: 'text', text: 'see 3.4' }]);
});

test('subagent text stays out of the thread; errors are named', () => {
  const map = createMapper({ cwd: '/project' });
  assert.deepEqual(map({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'inner' }] } }), []);
  assert.deepEqual(map({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { content: [] } }), [{ kind: 'error', code: 'rate_limit' }]);
});
