'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixture = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');
const busy = 'decisions.md is being written by another placet-research process; nothing was appended — try again';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-append-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(root, 'research'));
  for (const name of ['canvas.md', 'decisions.md']) {
    fs.copyFileSync(path.join(fixture, name), path.join(root, 'research', name));
  }
  fs.writeFileSync(path.join(state, 'name'), 'A. Researcher\n');
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  const p = { root, file: path.join(root, 'research', 'decisions.md'), env: {
    ...ambient, CLAUDE_PLUGIN_ROOT: pluginRoot, PLACET_RESEARCH_STATE_DIR: state,
  } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = run(p, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return p;
}

function run(p, args) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: p.root, env: p.env, encoding: 'utf8', timeout: 12000,
  });
}

function logArgs(body) {
  return ['log', 'DISCOVERY', '7', '--body', body];
}

function spawnLog(p, body) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [cli, ...logArgs(body)], {
      cwd: p.root, env: p.env, timeout: 12000,
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

// Derive the public lock location independently; do not export a test-only API.
function lockPath(file) {
  const digest = crypto.createHash('sha256').update(fs.realpathSync(file)).digest('hex');
  return path.join(os.tmpdir(), `rh-append-${digest}.lock`);
}

function holdLock(t, p, pid, old = false) {
  const file = lockPath(p.file);
  fs.writeFileSync(file, JSON.stringify({ pid, time: Date.now() }));
  if (old) {
    const earlier = new Date(Date.now() - 31000);
    fs.utimesSync(file, earlier, earlier);
  }
  t.after(() => fs.rmSync(file, { force: true }));
  return file;
}

// Removing mutual exclusion must break consecutive seqs or the CLI review;
// neither process may silently lose the finding it reported as appended.
test('parallel CLI appends keep both findings and a consecutive verified chain for 20 rounds', async (t) => {
  const p = project(t);
  const initial = decisions.parseDecisions(fs.readFileSync(p.file, 'utf8')).maxSeq;
  const failures = [];
  for (let round = 0; round < 20; round += 1) {
    const bodies = [`Round ${round} finding A.`, `Round ${round} finding B.`];
    const results = await Promise.all(bodies.map((body) => spawnLog(p, body)));
    const text = fs.readFileSync(p.file, 'utf8');
    const entries = decisions.parseDecisions(text).entries;
    const review = run(p, ['review']);
    try {
      for (const result of results) assert.equal(result.code, 0, result.output);
      const seqs = entries.map((e) => e.seq);
      assert.deepEqual(seqs, Array.from({ length: initial + 2 * (round + 1) }, (_, i) => i + 1), 'seqs are unique and consecutive');
      for (const body of bodies) assert.equal(entries.filter((e) => e.body.split('\n')[0] === body).length, 1, 'both findings remain exactly once');
      assert.equal(review.status, 0, review.stdout + review.stderr);
      assert.match(review.stdout, /## Decision log\nverified:/, 'review verifies the chain after each round');
    } catch (err) {
      failures.push(`round ${round}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, [], 'all 20 parallel rounds succeed');
  assert.equal(fs.existsSync(lockPath(p.file)), false, 'successful append releases the lock');
});

test('a stale append lock is reclaimed for both an old mtime and a dead pid', async (t) => {
  const dead = childProcess.spawnSync(process.execPath, ['-e', ''], { timeout: 12000 });
  assert.equal(dead.status, 0);
  for (const scenario of [{ name: 'old mtime', pid: process.pid, old: true }, { name: 'dead pid', pid: dead.pid, old: false }]) {
    await t.test(scenario.name, (t) => {
      const p = project(t);
      const file = holdLock(t, p, scenario.pid, scenario.old);
      const result = run(p, logArgs('A finding after a stale lock.'));
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.existsSync(file), false, 'the reclaimed lock and replacement lock are gone');
      assert.match(run(p, ['review']).stdout, /## Decision log\nverified:/);
    });
  }
});

test('a fresh live append lock times out without changing a byte of the log', (t) => {
  const p = project(t);
  const file = holdLock(t, p, process.pid);
  const before = fs.readFileSync(p.file);
  const started = Date.now();
  const result = run(p, logArgs('This finding must not be appended.'));
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), busy, 'the refusal is one line with retry guidance');
  assert.equal(result.stderr, '');
  assert.ok(elapsed >= 4900 && elapsed < 6500, `bounded five-second wait: ${elapsed} ms`);
  assert.deepEqual(fs.readFileSync(p.file), before, 'held lock leaves the log byte-identical');
  assert.equal(fs.existsSync(file), true, 'a waiting writer never removes a live lock');
});
