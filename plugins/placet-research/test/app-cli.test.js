'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../hooks/lib/app-cli');

// The same isolation test/serve.test.js uses: init writes the sealing key
// under the state directory, so point it at a temporary one rather than the
// real home folder of the machine running the tests.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
process.env.PLACET_RESEARCH_STATE_DIR = stateDir;

const roots = [stateDir];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-app-cli-'));
  roots.push(root);
  return root;
}
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

test('init through runCli creates the canvas in the given folder', async () => {
  const root = tempRoot();
  const r = await runCli(root, ['init', '--project', 'demo', '--mode', 'brainstorming']);
  assert.equal(r.ok, true, r.error);
  assert.ok(fs.existsSync(path.join(root, 'research', 'canvas.md')));
});

test('a usage error comes back as invalid with the CLI message', async () => {
  const root = tempRoot();
  const r = await runCli(root, ['init', '--project', 'demo', '--mode', 'nope']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.match(r.error, /--mode must be one of/);
});

test('arguments are not interpreted by a shell', async () => {
  const root = tempRoot();
  const marker = path.join(root, 'pwned');
  await runCli(root, ['init', '--project', `x; touch ${marker}`, '--mode', 'brainstorming']);
  assert.equal(fs.existsSync(marker), false);
});
