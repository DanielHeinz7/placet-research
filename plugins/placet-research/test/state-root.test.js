'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = path.join(__dirname, '..', 'hooks', 'lib', 'ledger.js');

// A fresh process per case: stateRoot reads HOME and the environment.
function stateRootFor(home) {
  const env = Object.assign({}, process.env, { HOME: home });
  delete env.PLACET_RESEARCH_STATE_DIR;
  return cp.execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(LEDGER)}).stateRoot())`], { env, encoding: 'utf8' });
}

function homeWith(t, names) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-state-root-'));
  t.after(() => {
    fs.chmodSync(path.join(home, '.claude'), 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  });
  for (const name of names) fs.mkdirSync(path.join(home, '.claude', name, 'project'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

test('the state root moves the pre-0.7.0 research-harness folder, key and all, to placet-research', function (t) {
  const home = homeWith(t, ['research-harness']);
  fs.writeFileSync(path.join(home, '.claude', 'research-harness', 'project', 'key'), 'k');
  assert.strictEqual(stateRootFor(home), path.join(home, '.claude', 'placet-research'));
  assert.strictEqual(fs.readFileSync(path.join(home, '.claude', 'placet-research', 'project', 'key'), 'utf8'), 'k');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'research-harness')));
});

test('the state root leaves an old folder alone once placet-research exists, and is placet-research without either', function (t) {
  const both = homeWith(t, ['research-harness', 'placet-research']);
  assert.strictEqual(stateRootFor(both), path.join(both, '.claude', 'placet-research'));
  assert.ok(fs.existsSync(path.join(both, '.claude', 'research-harness')));
  const neither = homeWith(t, []);
  assert.strictEqual(stateRootFor(neither), path.join(neither, '.claude', 'placet-research'));
});

test('the state root keeps the old folder when it cannot be moved', { skip: process.platform === 'win32' || process.getuid() === 0 }, function (t) {
  const home = homeWith(t, ['research-harness']);
  fs.chmodSync(path.join(home, '.claude'), 0o500);
  assert.strictEqual(stateRootFor(home), path.join(home, '.claude', 'research-harness'));
});

test('an explicit state directory wins over both names', function () {
  const env = Object.assign({}, process.env, { PLACET_RESEARCH_STATE_DIR: '/somewhere/else' });
  assert.strictEqual(cp.execFileSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(LEDGER)}).stateRoot())`], { env, encoding: 'utf8' }), '/somewhere/else');
});
