'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');
const { startSession } = require('../hooks/lib/session');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');

// The library runs in this process, so the process gets the same isolation the
// CLI tests give their children: no ambient project, a private state root.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
process.env.PLACET_RESEARCH_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));

function run(root, args) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    encoding: 'utf8',
  });
}

// The fixture project as `placet-research init` leaves it: the canvas and the
// legacy log in place, a key under the private state root.
function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  fs.mkdirSync(path.join(root, 'research'));
  for (const f of ['canvas.md', 'decisions.md']) fs.copyFileSync(path.join(fixtureDir, f), path.join(root, 'research', f));
  return root;
}

// The same project with a key on this machine and a name of its own, set the
// way the CLI sets both, so the expected bytes are the same everywhere.
function keyedProject() {
  const root = fixtureProject();
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');
  return root;
}

const logOf = (root) => fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8');
const OCCASION = 'Supervision with B. Supervisor';

test('startSession appends one sealed SESSION entry: the occasion as ref, the name as By', () => {
  const root = keyedProject();
  const before = logOf(root);
  const result = startSession({ root, occasion: OCCASION, pluginRoot });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.seq, 4, 'the fixture log ends at #3');
  const text = logOf(root);
  assert.ok(text.startsWith(before), 'nothing before the marker changed');
  assert.match(text, /## \[#4\] \d{4}-\d{2}-\d{2} · SESSION · Supervision with B\. Supervisor · seal [0-9a-f]{16}\nSession started\.\n\*\*By:\*\* A\. Researcher\n$/);
  assert.equal(seal.verifyChain(text, seal.readKey(root)).status, 'verified');
  assert.deepEqual(
    decisions.parseDecisions(text).entries.map((e) => [e.seq, e.kind, e.by]),
    [[1, 'CONSTRAINT', null], [2, 'DISCOVERY', null], [3, 'DECISION', null], [4, 'SESSION', 'A. Researcher']],
  );
});

test('an occasion that is empty, two lines, dotted or too long is refused and writes nothing', () => {
  const root = keyedProject();
  const before = logOf(root);
  const occasions = ['', '   ', 'a\nb', 'a · b', 'x'.repeat(121), undefined];
  for (const occasion of occasions) {
    const result = startSession({ root, occasion, pluginRoot });
    assert.equal(result.ok, false, String(occasion));
    assert.equal(result.code, 'invalid');
    assert.match(result.error, /one line of at most 120 characters/);
  }
  assert.equal(logOf(root), before);
});

test('an occasion that reads as an entry heading or as a field label is refused', () => {
  const root = keyedProject();
  const before = logOf(root);
  for (const occasion of ['## [#9] supervision', '**By:** A. Researcher']) {
    const result = startSession({ root, occasion, pluginRoot });
    assert.equal(result.ok, false, occasion);
    assert.equal(result.code, 'invalid');
  }
  assert.equal(logOf(root), before);
});

test('without a key on this machine, startSession refuses and writes nothing', () => {
  const root = fixtureProject();
  fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');
  const before = logOf(root);
  const result = startSession({ root, occasion: OCCASION, pluginRoot });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ledger');
  assert.match(result.error, /No sealing key for this project on this machine/);
  assert.equal(logOf(root), before);
});

test('without a name, startSession refuses and names the command that fixes it', () => {
  const root = keyedProject();
  const before = logOf(root);
  fs.rmSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'));
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    const result = startSession({ root, occasion: OCCASION, pluginRoot });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'name');
    assert.match(result.error, /placet-research name "<your name>"/);
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GIT_CONFIG_NOSYSTEM;
  }
  assert.equal(logOf(root), before);
});
