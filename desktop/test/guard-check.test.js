'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGuardCheck } = require('../agent/sdk/guard-check');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'placet-research');
const COMMANDS = [{ name: 'placet-research:canvas' }, { name: 'help' }];
const PLUGIN_CAUSE = 'The placet-research plugin did not load.';
const HOOK_CAUSE = 'The guard’s start hook did not run. Settings installed on this Mac by your organisation may turn hooks off.';
// The recording scrubbed the plugin's folder to /plugin. The check compares the
// folder init names with the bundled one, so the tests put the real one back.
const recorded = fs.readFileSync(path.join(__dirname, 'fixtures', 'sdk-messages', 'guard.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  .map((m) => (m.subtype === 'init' ? { ...m, plugins: m.plugins.map((p) => (p.path === '/plugin' ? { ...p, path: PLUGIN } : p)) } : m));
const [started, ours, init] = recorded; // hook_started, our SessionStart hook_response, init
const run = (msgs, opts = {}) => { const feed = createGuardCheck({ pluginRoot: PLUGIN, commands: COMMANDS, ...opts }); let d = null; for (const m of msgs) d = feed(m) || d; return d; };
// The answer after each message: null, 'on', or the cause of an off.
const trace = (msgs, opts = {}) => { const feed = createGuardCheck({ pluginRoot: PLUGIN, commands: COMMANDS, ...opts }); return msgs.map((m) => { const d = feed(m); return d && (d.state === 'on' ? 'on' : d.cause); }); };
const withOurs = (fields) => recorded.map((m) => (m === ours ? { ...m, ...fields } : m));
const context = (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
// Another source's SessionStart hook (managed settings, another plugin), shaped like ours.
const otherStarted = { ...started, hook_id: 'other-hook', uuid: 'other-started' };
const other = { ...ours, hook_id: 'other-hook', uuid: 'other-answer', output: context('org policy: audit on'), stdout: context('org policy: audit on') };
const otherFailed = { ...other, output: 'policy server down', stdout: '', stderr: 'policy server down', exit_code: 1, outcome: 'error' };

test('the recorded start shows the guard on, with the plugin version', () => {
  const d = run(recorded);
  assert.equal(d.state, 'on');
  assert.match(d.version, /^\d+\.\d+\.\d+$/);
});

test('the decision is made before the first message goes out', () => {
  const d = run(recorded.slice(0, 2));
  assert.equal(d.state, 'on');
  assert.match(d.version, /^\d+\.\d+\.\d+$/);
});

test('a start hook that succeeded without our commands: off', () => {
  assert.deepEqual(run(recorded, { commands: [{ name: 'help' }] }), { state: 'off', cause: PLUGIN_CAUSE });
});

test('plugin from another path: off', () => {
  const elsewhere = recorded.map((m) => (m === init
    ? { ...m, plugins: m.plugins.map((p) => (p.name === 'placet-research' ? { ...p, path: '/elsewhere', source: 'placet-research@elsewhere' } : p)) }
    : m));
  assert.deepEqual(run(elsewhere), { state: 'off', cause: PLUGIN_CAUSE });
});

test('no SessionStart hook result (hooks turned off): off', () => {
  const d = run(recorded.filter((m) => m !== ours));
  assert.equal(d.state, 'off');
  assert.match(d.cause, /start hook did not run/);
});

test('our start hook failed: off, with a cause that names it', () => {
  const d = run(withOurs({ output: 'boom', stdout: '', stderr: 'boom', exit_code: 1, outcome: 'error' }));
  assert.deepEqual(d, { state: 'off', cause: 'The placet-research start hook failed.' });
});

test('our start hook ran but printed nothing: off, and the cause does not blame the settings', () => {
  const d = run(withOurs({ output: '', stdout: '' }));
  assert.deepEqual(d, { state: 'off', cause: 'The placet-research guard started but found no paper project here. Open a folder made with New project… or Clone…' });
});

test('an init that arrives without the plugin: off', () => {
  const d = run(recorded.map((m) => (m === init ? { ...m, plugins: [] } : m)));
  assert.deepEqual(d, { state: 'off', cause: PLUGIN_CAUSE });
});

test('"off" is final: a later init that lists the plugin does not turn it back on', () => {
  assert.deepEqual(trace([started, ours, { ...init, plugins: [] }, init]), [null, 'on', PLUGIN_CAUSE, PLUGIN_CAUSE]);
});

test('"off" is final: our hook arriving after init does not turn it on', () => {
  assert.deepEqual(trace([started, init, ours]), [null, HOOK_CAUSE, HOOK_CAUSE]);
});

test('another source’s SessionStart hook in place of ours decides nothing; init then shows ours did not run', () => {
  assert.deepEqual(trace([started, { ...other, hook_id: started.hook_id }, init]), [null, null, HOOK_CAUSE]);
});

test('another source’s SessionStart hook after ours leaves the guard on', () => {
  assert.deepEqual(trace([started, ours, other]), [null, 'on', 'on']);
});

test('another source’s SessionStart hook before ours decides nothing', () => {
  assert.deepEqual(trace([started, other, ours]), [null, null, 'on']);
});

test('another source’s failed SessionStart hook does not turn the guard off', () => {
  assert.deepEqual(trace([started, otherStarted, otherFailed, ours]), [null, null, null, 'on']);
});

test('our failed hook is named even when another source’s hook succeeded', () => {
  const oursFailed = { ...ours, output: 'boom', stdout: '', stderr: 'boom', exit_code: 1, outcome: 'error' };
  assert.deepEqual(trace([started, otherStarted, other, oursFailed]), [null, null, null, 'The placet-research start hook failed.']);
});

test('the hook’s JSON is read from stdout, so a line on stderr does not matter', () => {
  const warning = '(node:4242) Warning: something on stderr\n';
  const d = run(withOurs({ output: ours.stdout + warning, stderr: warning }));
  assert.equal(d.state, 'on');
});

test('a context from a plugin whose name only starts with placet-research is not ours', () => {
  const lite = context('placet-research-lite · paper project "x"');
  const answers = trace(withOurs({ output: lite, stdout: lite }));
  assert.equal(answers.includes('on'), false);
  assert.equal(answers.at(-1), HOOK_CAUSE);
});
