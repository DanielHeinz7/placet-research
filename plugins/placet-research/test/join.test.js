'use strict';

// Setting up the second clone (spec §7): the key holder exports the project key
// to a file, the second person joins with it — and neither `init` nor a write
// ever creates a new key on a log that is already sealed elsewhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const seal = require('../hooks/lib/seal');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  fs.mkdirSync(path.join(root, 'research'));
  fs.copyFileSync(path.join(fixtureDir, 'canvas.md'), path.join(root, 'research', 'canvas.md'));
  fs.copyFileSync(path.join(fixtureDir, 'decisions.md'), path.join(root, 'research', 'decisions.md'));
  return root;
}

// One harness state directory per fixture project, so the key `init` creates
// is the key the CLI reads — as on a real machine.
const stateDirs = new Map();
function stateDirOf(root) {
  if (!stateDirs.has(root)) stateDirs.set(root, fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-')));
  return stateDirs.get(root);
}

// The state directory of "the second machine": a plain clone brings no key and
// no name with it, so each one is a fresh empty directory.
function freshState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
}

function run(root, args, env = {}) {
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...ambient,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PLACET_RESEARCH_STATE_DIR: stateDirOf(root),
      ...env,
    },
    encoding: 'utf8',
  });
}

// The project with a key on this machine and a name set: what the key holder
// has before the second person starts.
function keyed() {
  const root = makeProject();
  fs.writeFileSync(path.join(stateDirOf(root), 'name'), 'A. Researcher\n');
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  return root;
}

// The same project after its first sealed entry: this is the log a second
// clone receives, and the one whose missing key on that machine is the trap
// init must not close with a fresh key.
function sealedProject() {
  const root = keyed();
  const out = run(root, ['log', 'DISCOVERY', '7', '--body', 'The first finding, sealed on this machine.']);
  assert.equal(out.status, 0, out.stdout);
  return root;
}

// The key holder's one step, taken: the project key in a file of their own.
function keyedWithExport() {
  const root = sealedProject();
  const exported = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-k-')), 'voice.seal.key');
  const out = run(root, ['key', 'export', '--out', exported]);
  assert.equal(out.status, 0, out.stdout);
  return { root, exported };
}

// The second clone: the same paper tree under a new path, so its state
// directory — and the key in it — are its own (`projectStateDir` hashes the
// path).
function duplicateProject(root) {
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-clone-'));
  fs.cpSync(path.join(root, 'research'), path.join(clone, 'research'), { recursive: true });
  return clone;
}

// Where a project's key lies inside a state directory, derived the way the
// library derives it: the digest directory is the parent `keyPath` names.
function keyFileIn(state, root) {
  return path.join(state, path.basename(path.dirname(seal.keyPath(root))), 'seal.key');
}

test('key export writes the key to a .seal.key file, mode 600, and never prints it', () => {
  const root = keyed();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-k-')), 'voice.seal.key');
  const r = run(root, ['key', 'export', '--out', out]);
  assert.equal(r.status, 0, r.stdout);
  const key = fs.readFileSync(out, 'utf8').trim();
  // Asserted without ever putting the key into an assertion message: a failing
  // test must not print it either.
  assert.equal(key.length, 64);
  assert.equal(/^[0-9a-f]{64}$/.test(key), true);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.equal(r.stdout.includes(key), false, 'the key never reaches stdout');
  assert.match(r.stdout, /not as plain-text mail, not into the repository/);
  const again = run(root, ['key', 'export', '--out', out]);
  assert.equal(again.status, 1, 'an existing file is not overwritten');
  assert.match(again.stdout, /already exists/);
  assert.equal(fs.readFileSync(out, 'utf8').trim() === key, true, 'the file it refused to overwrite is unchanged');
  assert.equal(run(root, ['key', 'export', '--out', out.replace('.seal.key', '.txt')]).status, 2);
  assert.equal(run(root, ['key', 'export']).status, 2);
});

test('join with the matching key copies it, sets the name, says the file can go, runs doctor', () => {
  const { root, exported } = keyedWithExport();
  const clone = duplicateProject(root);
  const state = freshState();
  const r = run(clone, ['join', '--key-file', exported, '--name', 'B. Supervisor'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /can delete .*voice\.seal\.key now/);
  assert.match(r.stdout, /placet-research doctor/);
  assert.equal(fs.existsSync(exported), true, 'join never deletes the key file');
  const keyFile = keyFileIn(state, clone);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim() === fs.readFileSync(exported, 'utf8').trim(), true, 'the clone reads the exported key');
  assert.equal(fs.readFileSync(path.join(state, 'name'), 'utf8').trim(), 'B. Supervisor');
  // With key and name in place the clone writes: the entry seals onto the key
  // holder's chain, which is what the join was for.
  const written = run(clone, ['log', 'DISCOVERY', '7', '--body', 'From the second clone.'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(written.status, 0, written.stdout);
  assert.match(fs.readFileSync(path.join(clone, 'research', 'decisions.md'), 'utf8'), /From the second clone\./);
});

test('join refuses a wrong key and a malformed file, and copies nothing', () => {
  const { root } = keyedWithExport();
  const clone = duplicateProject(root);
  const state = freshState();
  const wrong = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-k-')), 'w.seal.key');
  fs.writeFileSync(wrong, 'ab'.repeat(32));
  const r = run(clone, ['join', '--key-file', wrong, '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not verify/);
  fs.writeFileSync(wrong, 'nothex');
  assert.equal(run(clone, ['join', '--key-file', wrong, '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: state }).status, 1);
  assert.deepEqual(fs.readdirSync(state).filter((n) => n !== 'name'), [], 'no key directory was created');
});

// SQ-294 (F2): the trap this command exists to close is a key of the clone's
// own sitting where the project's key belongs. The log's `Seal key:` line is
// what tells them apart, so the key file that matches the line replaces the
// stored one — loudly — and nothing else does.
test('join replaces a stored key the log\'s Seal key line contradicts, and says so in one sentence', () => {
  // A project whose log names its key, one entry sealed: the clone receives a
  // log that says which key is the project's, which is what the replacement is
  // checked against.
  const holder = freshProject();
  assert.equal(run(holder, ['log', 'DISCOVERY', '7', '--body', 'The first finding.']).status, 0);
  const { exported } = exportFrom(holder);
  assert.notEqual(seal.keyLineOf(logOf(holder)), null);
  const clone = duplicateProject(holder);
  const state = freshState();
  const keyFile = keyFileIn(state, clone);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, 'cd'.repeat(32), { mode: 0o600 });

  // A key file the line does not name replaces nothing.
  const refused = run(clone, ['join', '--key-file', wrongKeyFile(), '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /does not hold the project's key: the Seal key line in research\/decisions\.md names a different key/);
  assert.match(refused.stdout, /Nothing was copied/);
  assert.equal(fs.readFileSync(keyFile, 'utf8') === 'cd'.repeat(32), true, 'the key that was here is kept');

  // The key the line names replaces it, and join says which key it went with.
  const replaced = run(clone, ['join', '--key-file', exported, '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(replaced.status, 0, replaced.stdout);
  assert.ok(replaced.stdout.includes(keyFile), 'the sentence names the file it replaced');
  assert.match(replaced.stdout, /^The key already at .* does not match the Seal key line in research\/decisions\.md; the key file you gave does, so it replaced the stored one\.$/m);
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim() === fs.readFileSync(exported, 'utf8').trim(), true, 'the key file decides which key is the project\'s');
  // The wrong key no longer stands in the way of the write it was blocking.
  const written = run(clone, ['log', 'DISCOVERY', '7', '--body', 'From the second clone.'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(written.status, 0, written.stdout);
  // The same key again is a no-op success, not a second replacement.
  const again = run(clone, ['join', '--key-file', exported, '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /same key was already here/);
  assert.doesNotMatch(again.stdout, /it replaced the stored one/);

  // Without the line there is nothing to check the incoming key against, so a
  // stored key is not replaced even by a key that verifies the whole log.
  const legacy = keyed();
  // Cloned before the export, so the clone's log is the one without the line.
  const legacyClone = duplicateProject(legacy);
  const { exported: legacyKey } = exportFrom(legacy);
  const legacyState = freshState();
  const legacyFile = keyFileIn(legacyState, legacyClone);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(legacyFile, 'cd'.repeat(32), { mode: 0o600 });
  const noLine = run(legacyClone, ['join', '--key-file', legacyKey, '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: legacyState });
  assert.equal(noLine.status, 1, noLine.stdout);
  assert.match(noLine.stdout, /A different key is already at/);
  assert.match(noLine.stdout, /nothing was copied/);
  assert.equal(fs.readFileSync(legacyFile, 'utf8') === 'cd'.repeat(32), true, 'the key that was here is kept');
});

// SQ-294 (F4): a clone of a project whose log names its key has no key of its
// own, and init is the one thing it must not do — the key is held elsewhere
// even when no entry is sealed yet.
test('a keyless clone whose log names the key is sent to join by log and doctor, not to init', () => {
  const root = freshProject();
  assert.notEqual(seal.keyLineOf(logOf(root)), null, 'the log names the key, and no entry is sealed yet');
  const clone = duplicateProject(root);
  const state = freshState();
  const written = run(clone, ['log', 'DISCOVERY', '7', '--body', 'x'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(written.status, 1, written.stdout);
  assert.match(written.stdout, /the project's key is held elsewhere/);
  assert.match(written.stdout, /placet-research join --key-file/);
  assert.doesNotMatch(written.stdout, /placet-research init/, 'init would make the log read as broken');
  const doctor = run(clone, ['doctor'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(doctor.status, 1, doctor.stdout);
  assert.match(doctor.stdout, /^- project state: no sealing key for this project on this machine, and the project's key is held elsewhere; get the key file from the person who shared the project and run `placet-research join --key-file <file> --name "<your name>"`$/m);
  // init refuses here too, so the advice and the command agree.
  assert.equal(run(clone, ['init', '--project', 'voice-uptake', '--mode', 'seed'], { PLACET_RESEARCH_STATE_DIR: state }).status, 1);
});

test('init on a sealed log without a key refuses and points to join', () => {
  const { root } = keyedWithExport();
  const clone = duplicateProject(root);
  const r = run(clone, ['init', '--project', 'voice-uptake', '--mode', 'seed'], { PLACET_RESEARCH_STATE_DIR: freshState() });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /sealed on another machine/);
  assert.match(r.stdout, /placet-research join --key-file/);
});

test('a write without a key on a sealed log points to join, not to init', () => {
  const { root } = keyedWithExport();
  const clone = duplicateProject(root);
  const r = run(clone, ['log', 'DISCOVERY', '7', '--body', 'x'], { PLACET_RESEARCH_STATE_DIR: freshState() });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /placet-research join/);
  assert.doesNotMatch(r.stdout, /placet-research init/);
});

test('doctor notes a missing remote and pull.rebase=true, and fails when the key does not verify the log', () => {
  const root = sealedProject();
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  childProcess.spawnSync('git', ['config', 'pull.rebase', 'true'], { cwd: root });
  const out = run(root, ['doctor']);
  assert.match(out.stdout, /^- note: no git remote; a second clone needs one$/m);
  assert.match(out.stdout, /^- note: pull\.rebase is true here, so merge-log would refuse after a pull; run git config pull\.rebase false$/m);
  // A key that does not verify the log: every write here would seal a chain the
  // other clone reports broken, so doctor fails and points at join.
  fs.writeFileSync(keyFileIn(stateDirOf(root), root), 'ef'.repeat(32), { mode: 0o600 });
  const bad = run(root, ['doctor']);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /does not verify/);
  assert.match(bad.stdout, /placet-research join/);
});

// SQ-286: a project init starts names its key in a `Seal key:` line, so an
// empty log tells a wrong key file apart before anything is sealed.
function freshProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-new-'));
  fs.writeFileSync(path.join(stateDirOf(root), 'name'), 'A. Researcher\n');
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  return root;
}

function wrongKeyFile() {
  const wrong = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-k-')), 'w.seal.key');
  fs.writeFileSync(wrong, 'ab'.repeat(32));
  return wrong;
}

function exportFrom(root) {
  const exported = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-k-')), 'voice.seal.key');
  const out = run(root, ['key', 'export', '--out', exported]);
  assert.equal(out.status, 0, out.stdout);
  return { exported, out };
}

const logOf = (root) => fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8');
const keyOf = (file) => Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');

test('init names the new key in a Seal key line under the log title', () => {
  const root = freshProject();
  const key = keyOf(keyFileIn(stateDirOf(root), root));
  assert.equal(logOf(root), `# Decision log — voice-uptake\n\nSeal key: ${seal.keyFingerprint(key)}\n`);
});

test('join on an empty log refuses a key file of ab x 32 and copies nothing; the right key joins without a note', () => {
  const root = freshProject();
  const clone = duplicateProject(root);
  const state = freshState();
  const r = run(clone, ['join', '--key-file', wrongKeyFile(), '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /does not hold the project's key: the Seal key line in research\/decisions\.md names a different key/);
  assert.match(r.stdout, /Nothing was copied/);
  assert.deepEqual(fs.readdirSync(state), [], 'no key and no name were written');
  const { exported } = exportFrom(root);
  // join ends with doctor, which reads the plugin settings and the install-cli
  // shim (SQ-116): the test owns both, or this machine's setup decides the verdict.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-home-'));
  const shimDir = path.join(home, '.local', 'bin');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'placet-research'), '#!/bin/sh\n# placet-research install-cli shim; a test fixture\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'placet-research@placet-research': true } }));
  const machine = { PLACET_RESEARCH_STATE_DIR: state, HOME: home, CLAUDE_CONFIG_DIR: home, PATH: `${process.env.PATH}${path.delimiter}${shimDir}` };
  const ok = run(clone, ['join', '--key-file', exported, '--name', 'B'], machine);
  assert.equal(ok.status, 0, ok.stdout);
  assert.doesNotMatch(ok.stdout, /could not be checked/);
  assert.match(ok.stdout, /placet-research doctor: ok/);
});

test('init on a clone whose log names a key refuses to create a second key and points to join', () => {
  const root = freshProject();
  const clone = duplicateProject(root);
  const state = freshState();
  const before = logOf(clone);
  const r = run(clone, ['init', '--project', 'voice-uptake', '--mode', 'seed'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /names the project's key in its Seal key line/);
  assert.match(r.stdout, /placet-research join --key-file/);
  assert.deepEqual(fs.readdirSync(state), [], 'no key was created');
  assert.equal(logOf(clone), before);
  // The same refusal without a canvas: the new-canvas branch checks the log too.
  fs.rmSync(path.join(clone, 'research', 'canvas.md'));
  const bare = run(clone, ['init', '--project', 'voice-uptake', '--mode', 'seed'], { PLACET_RESEARCH_STATE_DIR: state });
  assert.equal(bare.status, 1, bare.stdout);
  assert.match(bare.stdout, /Seal key line/);
  assert.equal(fs.existsSync(path.join(clone, 'research', 'canvas.md')), false, 'nothing was written');
  assert.deepEqual(fs.readdirSync(state), []);
});

test('an old unsealed log without the line: join notes the key was not checked; key export adds the line', () => {
  const root = keyed();
  const legacy = logOf(root);
  assert.equal(seal.keyLineOf(legacy), null, 'the fixture predates the line');
  const before = duplicateProject(root);
  const noted = run(before, ['join', '--key-file', wrongKeyFile(), '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: freshState() });
  assert.equal(noted.status, 0, noted.stdout);
  assert.match(noted.stdout, /no sealed entry and no Seal key line, so this key could not be checked/);
  const { out } = exportFrom(root);
  assert.match(out.stdout, /line is added now\. Commit and push research\/decisions\.md/);
  const key = keyOf(keyFileIn(stateDirOf(root), root));
  assert.equal(logOf(root), legacy.replace(/\n/, `\n\nSeal key: ${seal.keyFingerprint(key)}\n`));
  // The clone that receives the stamped log refuses the same wrong key.
  const after = duplicateProject(root);
  const refused = run(after, ['join', '--key-file', wrongKeyFile(), '--name', 'B'], { PLACET_RESEARCH_STATE_DIR: freshState() });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /Seal key line/);
  // A second export leaves the log alone.
  const stamped = logOf(root);
  const again = exportFrom(root);
  assert.doesNotMatch(again.out.stdout, /line is added/);
  assert.equal(logOf(root), stamped);
});

test('a sealed log without the line keeps its bytes on key export', () => {
  const root = sealedProject();
  const sealed = logOf(root);
  const { out } = exportFrom(root);
  assert.doesNotMatch(out.stdout, /line is added/);
  assert.equal(logOf(root), sealed);
});

test('a wrong key on a log with the line: writes, doctor and review name the cause', () => {
  const root = freshProject();
  fs.writeFileSync(keyFileIn(stateDirOf(root), root), 'ab'.repeat(32), { mode: 0o600 });
  const before = logOf(root);
  const written = run(root, ['log', 'DISCOVERY', '7', '--body', 'x']);
  assert.equal(written.status, 1, written.stdout);
  assert.match(written.stdout, /The sealing key on this machine is not the project's: the Seal key line in research\/decisions\.md names a different key; nothing is written/);
  assert.equal(logOf(root), before);
  const doctor = run(root, ['doctor']);
  assert.equal(doctor.status, 1, doctor.stdout);
  assert.match(doctor.stdout, /the key here is not the project's: the Seal key line in decisions\.md names a different key/);
  const review = run(root, ['review']);
  assert.match(review.stdout, /BROKEN at #0 \(line 3\): this key is not the project's: the Seal key line in decisions\.md names a different key\./);
  // SQ-294 (F3): the ledger line names the key as the cause and points at the
  // step that fixes it, not at review, and names no entry.
  const status = run(root, ['status']);
  assert.match(status.stdout, /Ledger: this key is not the project's: the Seal key line in decisions\.md names a different key — run placet-research join with the project key/);
  assert.doesNotMatch(status.stdout, /#0/);
});
