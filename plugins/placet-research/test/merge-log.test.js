'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const seal = require('../hooks/lib/seal');
const decisions = require('../hooks/lib/decisions');
const { mergeLogs } = require('../hooks/lib/merge');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');
const GIT_ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd, ...args) {
  return childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
}
function rh(cwd, state, args) {
  const { CLAUDE_PROJECT_DIR: _p, PLACET_RESEARCH_DIR: _d, ...ambient } = process.env;
  return childProcess.spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...ambient, ...GIT_ENV, CLAUDE_PLUGIN_ROOT: pluginRoot, PLACET_RESEARCH_STATE_DIR: state } });
}
function keyPathIn(state, root) {
  const saved = process.env.PLACET_RESEARCH_STATE_DIR;
  process.env.PLACET_RESEARCH_STATE_DIR = state;
  try { return seal.keyPath(root); } finally { if (saved === undefined) delete process.env.PLACET_RESEARCH_STATE_DIR; else process.env.PLACET_RESEARCH_STATE_DIR = saved; }
}

// A bare origin, clone A (who inits and holds the key) and clone B (who gets
// a copy of the key file), each with its own state dir and name. By default
// the project starts from the fixture and the shared log holds one sealed
// entry; `empty` starts a new project instead and shares its log empty.
function twoClones({ empty = false } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-merge-'));
  const origin = path.join(top, 'origin.git');
  git(top, 'init', '-q', '--bare', '-b', 'main', origin);
  const A = path.join(top, 'a');
  const B = path.join(top, 'b');
  const sa = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
  git(top, 'clone', '-q', origin, A);
  if (!empty) {
    fs.mkdirSync(path.join(A, 'research'));
    fs.copyFileSync(path.join(fixtureDir, 'canvas.md'), path.join(A, 'research', 'canvas.md'));
    fs.copyFileSync(path.join(fixtureDir, 'decisions.md'), path.join(A, 'research', 'decisions.md'));
  }
  const init = rh(A, sa, ['init', '--project', 'voice-uptake', '--mode', empty ? 'brainstorming' : 'seed']);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const named = rh(A, sa, ['name', 'A. Researcher']);
  assert.equal(named.status, 0, named.stdout + named.stderr);
  if (!empty) {
    const logged = rh(A, sa, ['log', 'DISCOVERY', '7', '--body', 'Shared finding.']);
    assert.equal(logged.status, 0, logged.stdout + logged.stderr);
  }
  git(A, 'add', '-A'); git(A, 'commit', '-qm', 'start'); git(A, 'push', '-q', 'origin', 'HEAD:main');
  git(top, 'clone', '-q', origin, B);
  git(B, 'config', 'pull.rebase', 'false');
  git(A, 'config', 'pull.rebase', 'false');
  const kb = keyPathIn(sb, B);
  fs.mkdirSync(path.dirname(kb), { recursive: true });
  fs.copyFileSync(keyPathIn(sa, A), kb);
  const namedB = rh(B, sb, ['name', 'B. Supervisor']);
  assert.equal(namedB.status, 0, namedB.stdout + namedB.stderr);
  return { A, B, sa, sb, key: fs.readFileSync(kb, 'utf8').trim() };
}

test('two clones log in parallel, pull conflicts, merge-log joins the logs, both verify after the round trip', () => {
  const { A, B, sa, sb, key } = twoClones();
  rh(A, sa, ['log', 'DISCOVERY', '7', '--body', 'From A.']);
  git(A, 'commit', '-qam', 'a'); git(A, 'push', '-q', 'origin', 'HEAD:main');
  rh(B, sb, ['log', 'DISCOVERY', '6', '--body', 'From B.']);
  git(B, 'commit', '-qam', 'b');
  const pull = git(B, 'pull', '--no-rebase', '-q', 'origin', 'main');
  assert.notEqual(pull.status, 0, 'the pull conflicts on decisions.md');

  const out = rh(B, sb, ['merge-log']);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /git add research\/decisions\.md/);
  const merged = fs.readFileSync(path.join(B, 'research', 'decisions.md'), 'utf8');
  assert.doesNotMatch(merged, /^<<<<<<<|^>>>>>>>/m);
  assert.equal(seal.verifyChain(merged, Buffer.from(key, 'hex')).status, 'verified');
  assert.match(merged, /· MERGE · from [0-9a-f]{7,}/);
  assert.match(merged, /\*\*By:\*\* B\. Supervisor/);

  git(B, 'add', 'research/decisions.md'); git(B, 'commit', '-qm', 'merge'); git(B, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(git(A, 'pull', '--no-rebase', '-q', 'origin', 'main').status, 0);
  const atA = fs.readFileSync(path.join(A, 'research', 'decisions.md'), 'utf8');
  assert.equal(atA, merged);
  assert.equal(seal.verifyChain(atA, Buffer.from(key, 'hex')).status, 'verified');
});

// SQ-249: a new project is shared while its log is still empty, then both log.
// The logs share no entry, but both grew from the same empty sealed log.
test('a log shared empty, then logged on both sides, merges and verifies', () => {
  const { A, B, sa, sb, key } = twoClones({ empty: true });
  const file = path.join(B, 'research', 'decisions.md');
  assert.equal(decisions.parseDecisions(fs.readFileSync(file, 'utf8')).entries.length, 0, 'the shared log is empty');
  assert.equal(rh(A, sa, ['log', 'DISCOVERY', '1.1', '--body', 'From A.']).status, 0);
  git(A, 'commit', '-qam', 'a'); git(A, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(rh(B, sb, ['log', 'DISCOVERY', '1.1', '--body', 'From B.']).status, 0);
  git(B, 'commit', '-qam', 'b');
  assert.notEqual(git(B, 'pull', '--no-rebase', '-q', 'origin', 'main').status, 0, 'the pull conflicts on decisions.md');

  const out = rh(B, sb, ['merge-log']);
  assert.equal(out.status, 0, out.stdout);
  const merged = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(merged, /^<<<<<<<|^>>>>>>>/m);
  assert.equal(seal.verifyChain(merged, Buffer.from(key, 'hex')).status, 'verified');
  const entries = decisions.parseDecisions(merged).entries;
  assert.deepEqual(entries.map((e) => [e.seq, e.kind, e.body.split('\n')[0]]).slice(0, 2), [[1, 'DISCOVERY', 'From A.'], [2, 'DISCOVERY', 'From B.']]);
  assert.equal(entries[2].kind, 'MERGE');
  const status = rh(B, sb, ['status']);
  assert.equal(status.status, 0, status.stdout + status.stderr);
});

// What "share no entry" still refuses: logs that did not grow from one empty
// sealed log. Built in memory, since unrelated projects share no git history.
test('logs of different origin that share no entry are still refused', () => {
  const KEY = Buffer.alloc(32, 9);
  const append = (text, body, key = KEY, sealed = true) => {
    const fields = { seq: decisions.parseDecisions(text).maxSeq + 1, date: '2026-10-15', kind: 'DISCOVERY', ref: '1.1', body, by: 'A' };
    const entry = sealed ? seal.sealEntry(seal.lastSealOf(text), fields, key).text : decisions.formatEntry(fields);
    return text + decisions.separatorAfter(text) + entry;
  };
  const header = '# Decision log — voice-uptake\n';
  const ours = append(header, 'Ours.');
  const opts = { by: 'A', theirsCommit: 'abc1234' };
  const same = mergeLogs(ours, append(header, 'Theirs.'), KEY, opts);
  assert.equal(same.ok, true, same.error);
  assert.equal(seal.verifyChain(same.text, KEY).status, 'verified');

  const otherProject = mergeLogs(ours, append('# Decision log — other\n', 'Theirs.'), KEY, opts);
  assert.equal(otherProject.code, 'no-prefix');
  assert.match(otherProject.error, /share no entry/);
  assert.equal(mergeLogs(ours, append(header, 'Theirs.', Buffer.alloc(32, 7)), KEY, opts).code, 'broken', 'sealed under another key');
  const legacyFirst = append(append(header, 'Legacy.', KEY, false), 'Theirs.');
  assert.equal(mergeLogs(ours, legacyFirst, KEY, opts).code, 'no-prefix', 'theirs starts with an unsealed entry ours does not have');
});

test('merge-log refuses outside a merge and during a rebase', () => {
  const { B, sb } = twoClones();
  const none = rh(B, sb, ['merge-log']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no merge in progress/);
  fs.mkdirSync(path.join(B, '.git', 'rebase-merge'));
  const rebasing = rh(B, sb, ['merge-log']);
  assert.equal(rebasing.status, 1);
  assert.match(rebasing.stdout, /git pull --no-rebase/);
});

test('--skip-decision needs a value, and a bare one (the shell ate "#12") is refused before anything runs', () => {
  const { B, sb } = twoClones();
  const bare = rh(B, sb, ['merge-log', '--skip-decision']);
  assert.equal(bare.status, 2);
  assert.match(bare.stdout, /--skip-decision needs a value/);
  assert.equal(rh(B, sb, ['merge-log', '--skip-decision', 'x']).status, 2);
});

test('--skip-decision=5 and a repeated --skip-decision are refused, not ignored', () => {
  const { B, sb } = twoClones();
  const glued = rh(B, sb, ['merge-log', '--skip-decision=5']);
  assert.equal(glued.status, 2, glued.stdout);
  assert.match(glued.stdout, /--skip-decision takes its number after a space/);
  const twice = rh(B, sb, ['merge-log', '--skip-decision', '5', '--skip-decision', '6']);
  assert.equal(twice.status, 2, twice.stdout);
  assert.match(twice.stdout, /more than once/);
});

// SQ-192 end to end: the fixture's #1-#3 predate the seal and #4 is sealed and
// shared. Someone without the key pushes a copy that swaps the sealed #4 for an
// unsealed acceptance; merging it would re-anchor ours onto the forgery.
test('a pushed copy that replaced a sealed entry with an unsealed one is refused, and nothing is written', () => {
  const { A, B, sb } = twoClones();
  const forged = `${fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8')}\n## [#4] 2026-09-16 · DECISION · 1.2 accepted · text deadbeef\nForged statement. [accepted]\n**By:** B. Supervisor\n`;
  fs.writeFileSync(path.join(A, 'research', 'decisions.md'), forged);
  git(A, 'commit', '-qam', 'rewrite'); git(A, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(rh(B, sb, ['log', 'DISCOVERY', '7', '--body', 'From B.']).status, 0);
  git(B, 'commit', '-qam', 'b');
  assert.notEqual(git(B, 'pull', '--no-rebase', '-q', 'origin', 'main').status, 0, 'the pull conflicts on decisions.md');
  const file = path.join(B, 'research', 'decisions.md');
  const before = fs.readFileSync(file, 'utf8');

  const out = rh(B, sb, ['merge-log']);
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stdout, /theirs carries no seal that verifies/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the refusal writes nothing');
});

// The check refusal end to end, against the fixture canvas: their check on a
// question our moved acceptance closes. The fixture's 7.1 is empty, so the
// acceptance picks 1.2 — element 1 has no dependency and the [stated]
// statement is a single candidate with --match.
test('the check refusal names --skip-decision, and the skip drops the acceptance and points at the marker', () => {
  const { A, B, sa, sb, key } = twoClones();
  const check = rh(A, sa, ['log', 'DISCOVERY', '1.2 check', '--body', 'The framing needs a decision before the finding is read.']);
  assert.equal(check.status, 0, check.stdout);
  git(A, 'commit', '-qam', 'a-check'); git(A, 'push', '-q', 'origin', 'HEAD:main');
  const accepted = rh(B, sb, ['accept', '1.2', '--match', 'Speaking frequency', '--explained', 'The frequency claim holds for the twelve recorded meetings.']);
  assert.equal(accepted.status, 0, accepted.stdout);
  git(B, 'commit', '-qam', 'b-accept');
  assert.notEqual(git(B, 'pull', '--no-rebase', '-q', 'origin', 'main').status, 0, 'the pull conflicts on decisions.md');

  const refused = rh(B, sb, ['merge-log']);
  assert.equal(refused.status, 1, refused.stdout);
  const named = refused.stdout.match(/--skip-decision (\d+)/);
  assert.ok(named, refused.stdout);
  assert.match(refused.stdout, /git merge --abort/);
  assert.match(fs.readFileSync(path.join(B, 'research', 'decisions.md'), 'utf8'), /^<<<<<<</m, 'the refusal writes nothing');

  assert.equal(git(B, 'merge', '--abort').status, 0);
  assert.notEqual(git(B, 'pull', '--no-rebase', '-q', 'origin', 'main').status, 0, 'the second pull conflicts again');
  const skipped = rh(B, sb, ['merge-log', '--skip-decision', `#${named[1]}`]);
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /research\/canvas\.md/);
  assert.match(skipped.stdout, /set its marker back by hand/);
  const merged = fs.readFileSync(path.join(B, 'research', 'decisions.md'), 'utf8');
  assert.doesNotMatch(merged, /^<<<<<<<|^>>>>>>>/m);
  assert.equal(seal.verifyChain(merged, Buffer.from(key, 'hex')).status, 'verified');
});

// SQ-196 end to end: ours carries no seals (the fixture's legacy log) and theirs
// has no entries (a log reset to its header). The merged text would be ours,
// which cannot verify, so merge-log refuses before the write and the conflicted
// working file stays byte-identical instead of failing only afterwards.
test('ours without a seal and a theirs without entries is refused before the write', () => {
  const { A, B, sb } = twoClones();
  fs.writeFileSync(path.join(A, 'research', 'decisions.md'), '# Decision log — voice-uptake\n');
  git(A, 'commit', '-qam', 'empty'); git(A, 'push', '-q', 'origin', 'HEAD:main');
  fs.copyFileSync(path.join(fixtureDir, 'decisions.md'), path.join(B, 'research', 'decisions.md'));
  git(B, 'commit', '-qam', 'unsealed');
  assert.notEqual(git(B, 'pull', '--no-rebase', '-q', 'origin', 'main').status, 0, 'the pull conflicts on decisions.md');
  const file = path.join(B, 'research', 'decisions.md');
  const before = fs.readFileSync(file, 'utf8');
  assert.match(before, /^<<<<<<</m, 'the working file holds the conflict');

  const out = rh(B, sb, ['merge-log']);
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stdout, /no seal that verifies/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the refusal writes nothing');
});

// SQ-286: a log that names its key in a `Seal key:` line refuses a merge under
// another key and says so in a sentence, before any seal is compared.
test('merge-log refuses a key the Seal key line does not name', () => {
  const KEY = Buffer.alloc(32, 9);
  const wrong = Buffer.from('ab'.repeat(32), 'hex');
  const header = seal.withKeyLine('# Decision log — voice-uptake\n', KEY);
  const append = (text, body) => {
    const fields = { seq: decisions.parseDecisions(text).maxSeq + 1, date: '2026-10-15', kind: 'DISCOVERY', ref: '1.1', body, by: 'A' };
    return text + decisions.separatorAfter(text) + seal.sealEntry(seal.lastSealOf(text), fields, KEY).text;
  };
  const opts = { by: 'A', theirsCommit: 'abc1234' };
  const ok = mergeLogs(append(header, 'Ours.'), append(header, 'Theirs.'), KEY, opts);
  assert.equal(ok.ok, true, ok.error);
  const refused = mergeLogs(append(header, 'Ours.'), append(header, 'Theirs.'), wrong, opts);
  assert.equal(refused.code, 'broken');
  assert.equal(refused.error, 'The sealing key on this machine is not the one ours was started with: its Seal key line names a different key; nothing is merged.');
});
