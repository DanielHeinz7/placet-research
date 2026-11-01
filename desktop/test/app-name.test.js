'use strict';
// The app must not share its program name with the CLI: the plugin's guard
// reads a program called placet-research as a CLI call and refuses the
// other commands in the same line. The guard stays as it is; the app is named.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BASE } = require('../lib/distribution');

const PLUGIN = path.join(__dirname, '..', '..', 'plugins', 'placet-research');

function guard(command) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-name-'));
  try {
    const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
    const out = childProcess.spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'guard-promotion.js')], {
      cwd,
      env: { ...ambient, CLAUDE_PLUGIN_ROOT: PLUGIN },
      input: JSON.stringify({ cwd, session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput.permissionDecision : 'allow';
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const startThrice = (name) => `APP="dist/${name}.app/Contents/MacOS/${name}"; for i in $(seq 1 3); do "$APP"; done`;

test('the app is called Placet, not like the CLI', () => {
  assert.equal(BASE.productName, 'Placet');
});

test('the guard lets an agent start the app by its program name', () => {
  assert.equal(guard(startThrice(BASE.productName)), 'allow');
});

test('why the name matters: the same line with the CLI\'s name is refused', () => {
  assert.equal(guard(startThrice('placet-research')), 'deny');
});
