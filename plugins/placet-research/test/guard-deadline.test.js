'use strict';

// The guard's own deadline. Claude Code cancels a PreToolUse hook at its
// timeout and, on hosts that ignore onFailure, lets the call through; the
// guard therefore denies by itself before that, including while its judging
// is still running.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const script = path.join(pluginRoot, 'hooks', 'guard-promotion.js');
const guard = require('../hooks/guard-promotion');

function runGuard(projectRoot, toolName, toolInput, env) {
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, PLACET_RESEARCH_GUARD_DEADLINE_MS: _deadline, ...ambient } = process.env;
  const out = childProcess.spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...ambient, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env },
    input: JSON.stringify({ cwd: projectRoot, session_id: 's', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null;
}

test('a judge that never yields is cut off at the deadline and the call is denied', () => {
  const started = Date.now();
  const busyForThreeSeconds = () => {
    while (Date.now() - started < 3000) { /* synchronous and CPU-bound: a timer callback could not run */ }
    return null;
  };
  assert.equal(guard.judgeWithin(busyForThreeSeconds, 100), guard.OUT_OF_TIME_DENIAL);
  assert.ok(Date.now() - started < 2000, `the deadline fired after ${Date.now() - started} ms`);
});

test('a judge that finishes in time decides the call', () => {
  assert.equal(guard.judgeWithin(() => null, 1000), null);
  assert.equal(guard.judgeWithin(() => 'denied for a reason', 1000), 'denied for a reason');
});

test('no time left means a denial without judging', () => {
  let judged = false;
  assert.equal(guard.judgeWithin(() => { judged = true; return null; }, 0), guard.OUT_OF_TIME_DENIAL);
  assert.equal(judged, false);
});

test('a judge that throws is denied, not let through', () => {
  const reason = guard.judgeWithin(() => { throw new Error('boom'); }, 1000);
  assert.match(reason, /could not evaluate this write \(boom\); it is denied/);
});

test('the out-of-time denial says what happened and what to do', () => {
  assert.match(guard.OUT_OF_TIME_DENIAL, /ran out of time/);
  assert.match(guard.OUT_OF_TIME_DENIAL, /refuses what it could not judge/);
});

test('the deadline override can only shorten the deadline', () => {
  assert.equal(guard.deadlineMs({}), guard.DEADLINE_MS);
  assert.equal(guard.deadlineMs({ PLACET_RESEARCH_GUARD_DEADLINE_MS: '' }), guard.DEADLINE_MS);
  assert.equal(guard.deadlineMs({ PLACET_RESEARCH_GUARD_DEADLINE_MS: 'soon' }), guard.DEADLINE_MS);
  assert.equal(guard.deadlineMs({ PLACET_RESEARCH_GUARD_DEADLINE_MS: '-5' }), guard.DEADLINE_MS);
  assert.equal(guard.deadlineMs({ PLACET_RESEARCH_GUARD_DEADLINE_MS: '600000' }), guard.DEADLINE_MS);
  assert.equal(guard.deadlineMs({ PLACET_RESEARCH_GUARD_DEADLINE_MS: '50' }), 50);
  assert.equal(guard.deadlineMs({ PLACET_RESEARCH_GUARD_DEADLINE_MS: '0' }), 0);
});

test('the guard decides at least a second before Claude Code cancels it', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  for (const hook of hooks.hooks.PreToolUse.flatMap((group) => group.hooks)) {
    assert.ok(hook.timeout * 1000 - guard.DEADLINE_MS >= 1000, `deadline ${guard.DEADLINE_MS} ms against timeout ${hook.timeout} s`);
  }
});

test('the hook denies a call it would allow once its deadline has passed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-deadline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(runGuard(root, 'Bash', { command: 'ls -la' }, {}), null);
  const late = runGuard(root, 'Bash', { command: 'ls -la' }, { PLACET_RESEARCH_GUARD_DEADLINE_MS: '0' });
  assert.equal(late.permissionDecision, 'deny');
  assert.equal(late.permissionDecisionReason, guard.OUT_OF_TIME_DENIAL);
});
