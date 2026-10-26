'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The isolation of test/app-git.test.js and test/app-cli.test.js: no global
// git identity (Review Focus 1: update and send must work without one), the
// sealing key and the name under a temporary state directory, and file://
// links allowed so a bare remote on disk can be cloned.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
process.env.PLACET_RESEARCH_STATE_DIR = stateDir;
process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';

const appGit = require('../hooks/lib/app-git');
const seal = require('../hooks/lib/seal');
const { runCli } = require('../hooks/lib/app-cli');
const { routes, appRefusal } = require('../hooks/lib/app-api');

const roots = [stateDir];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-app-api-'));
  roots.push(dir);
  return dir;
}
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function sh(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function context(dataDir, root = null) {
  let current = root;
  return { dataDir, getRoot: () => current, setRoot: (r) => { current = r; } };
}

// A creates the project, logs one shared entry, commits, pushes to a bare
// remote. B clones and joins with A's exported key. With `empty`, A shares
// the log before anything is logged, the usual path for a new project.
async function twoPeopleSharingOneProject({ empty = false } = {}) {
  const parent = tmp();
  const created = await routes.init({ parent, folder: 'shared', mode: 'brainstorming', title: 'Shared' }, context(tmp()));
  assert.equal(created.ok, true, created.error);
  const a = created.current;
  const named = await runCli(a, ['name', 'A. Author']);
  assert.equal(named.ok, true, named.error);
  if (!empty) {
    const shared = await runCli(a, ['log', 'DISCOVERY', '1.1', '--body', 'Shared finding']);
    assert.equal(shared.ok, true, shared.error);
  }
  // New project already made the repository and its first commit. A keeps no
  // user.email, so A's commits and later sends run without a git identity.
  assert.equal(sh(a, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  assert.equal((await appGit.commit(a, ['research'], 'Start the project', 'A. Author')).ok, true);
  const remote = path.join(tmp(), 'remote.git');
  sh(path.dirname(remote), 'init', '--bare', '-b', 'main', 'remote.git');
  sh(a, 'remote', 'add', 'origin', remote);
  sh(a, 'push', '-u', 'origin', 'main');
  const keyFile = path.join(tmp(), 'a.seal.key');
  const exported = await runCli(a, ['key', 'export', '--out', keyFile]);
  assert.equal(exported.ok, true, exported.error);
  const cloned = await appGit.clone({ url: `file://${remote}`, parent: tmp(), folder: 'shared' });
  assert.equal(cloned.ok, true, cloned.error);
  const b = cloned.root;
  const joined = await runCli(b, ['join', '--key-file', keyFile, '--name', 'B. Supervisor']);
  assert.equal(joined.ok, true, joined.error);
  // join keeps the key and the name under the state directory: nothing new
  // in B's working copy that would need a .gitignore entry.
  assert.equal(sh(b, 'status', '--porcelain'), '');
  return { a, b, remote };
}

test('open refuses a folder without a canvas and remembers a real project', async () => {
  const ctx = context(tmp());
  assert.equal((await routes.open({ root: tmp() }, ctx)).code, 'not-project');
  const root = tmp();
  await runCli(root, ['init', '--project', 'demo', '--mode', 'brainstorming']);
  const r = await routes.open({ root }, ctx);
  assert.equal(r.ok, true);
  assert.equal(ctx.getRoot(), root);
  assert.deepEqual((await routes.projects({}, ctx)).recent, [root]);
});

test('init creates a project in a new folder and makes it current', async () => {
  const ctx = context(tmp());
  const parent = tmp();
  const r = await routes.init({ parent, folder: 'voice-uptake', mode: 'brainstorming', title: 'Voice uptake' }, ctx);
  assert.equal(r.ok, true, r.error);
  assert.equal(ctx.getRoot(), path.join(parent, 'voice-uptake'));
});

test('update merges two people appending to the decision log at once', async () => {
  // A creates the project, commits, pushes to a bare remote. B clones and
  // joins with A's exported key. Both log a DISCOVERY. A sends; B updates.
  const { a, b } = await twoPeopleSharingOneProject();
  await runCli(a, ['log', 'DISCOVERY', '1.1', '--body', 'from A']);
  await runCli(b, ['log', 'DISCOVERY', '1.1', '--body', 'from B']);
  assert.equal((await routes.send({}, context(tmp(), a))).ok, true);
  const r = await routes.update({}, context(tmp(), b));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.merged, true);
  assert.equal((await runCli(b, ['status'])).ok, true);
  assert.equal(fs.existsSync(path.join(b, '.git', 'MERGE_HEAD')), false);
});

test('update merges two people who both log after sharing an empty log', async () => {
  const { a, b } = await twoPeopleSharingOneProject({ empty: true });
  assert.equal((await runCli(a, ['log', 'DISCOVERY', '1.1', '--body', 'from A'])).ok, true);
  assert.equal((await runCli(b, ['log', 'DISCOVERY', '1.1', '--body', 'from B'])).ok, true);
  assert.equal((await routes.send({}, context(tmp(), a))).ok, true);
  const r = await routes.update({}, context(tmp(), b));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.merged, true);
  assert.equal((await runCli(b, ['status'])).ok, true);
  const log = fs.readFileSync(path.join(b, 'research', 'decisions.md'), 'utf8');
  assert.match(log, /from A[\s\S]*from B/);
  assert.equal(fs.existsSync(path.join(b, '.git', 'MERGE_HEAD')), false);
});

test('a conflict outside decisions.md aborts the merge and names the file', async () => {
  const { a, b } = await twoPeopleSharingOneProject();
  fs.appendFileSync(path.join(a, 'research', 'canvas.md'), '\nA edit\n');
  fs.appendFileSync(path.join(b, 'research', 'canvas.md'), '\nB edit\n');
  await routes.send({}, context(tmp(), a));
  const before = fs.readFileSync(path.join(b, 'research', 'canvas.md'), 'utf8');
  const r = await routes.update({}, context(tmp(), b));
  assert.equal(r.code, 'conflict');
  assert.match(r.error, /research\/canvas\.md/);
  assert.equal(fs.readFileSync(path.join(b, 'research', 'canvas.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(b, '.git', 'MERGE_HEAD')), false);
});

test('send after a co-author pushed gets updates first, then sends', async () => {
  const { a, b } = await twoPeopleSharingOneProject();
  await runCli(a, ['log', 'DISCOVERY', '1.1', '--body', 'A first']);
  await routes.send({}, context(tmp(), a));
  await runCli(b, ['log', 'DISCOVERY', '1.1', '--body', 'B second']);
  const r = await routes.send({}, context(tmp(), b));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.updated, true);
});

test('invite, join and session refuse bad paths and texts before running the CLI', async () => {
  const ctx = context(tmp(), tmp());
  assert.equal((await routes.invite({ out: 'relative.seal.key' }, ctx)).code, 'invalid');
  assert.equal((await routes.invite({ out: '/tmp/x.txt' }, ctx)).code, 'invalid');
  assert.equal((await routes.join({ keyFile: 'k', name: 'B' }, ctx)).code, 'invalid');
  assert.equal((await routes.session({ action: 'start', occasion: 'two\nlines' }, ctx)).code, 'invalid');
  assert.equal((await routes.session({ action: 'other' }, ctx)).code, 'invalid');
  assert.equal((await routes.update({}, context(tmp()))).code, 'no-project');
});

// -- The first author shares a project (spec 4.1) ----------------------------

// A message the shell shows names no terminal command and is not git's text.
function assertPlain(r) {
  assert.equal(r.ok, false, 'a refusal');
  assert.equal(typeof r.error, 'string');
  assert.doesNotMatch(r.error, /placet-research [a-z]/, r.error);
  assert.doesNotMatch(r.error, /fatal:/i, r.error);
  assert.doesNotMatch(r.error, /Do not run init/i, r.error);
}

// A computer with an empty home folder: no name, no keys, no git identity.
function freshComputer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-computer-'));
  roots.push(dir);
  process.env.PLACET_RESEARCH_STATE_DIR = dir;
  t.after(() => { process.env.PLACET_RESEARCH_STATE_DIR = stateDir; });
  return dir;
}

function bareRemote(withCommit = false) {
  const dir = tmp();
  sh(dir, 'init', '--bare', '-b', 'main', 'remote.git');
  const url = `file://${path.join(dir, 'remote.git')}`;
  if (withCommit) {
    sh(dir, 'clone', url, 'seed');
    fs.writeFileSync(path.join(dir, 'seed', 'README.md'), 'someone else\'s files\n');
    sh(path.join(dir, 'seed'), 'add', '.');
    sh(path.join(dir, 'seed'), '-c', 'user.name=S', '-c', 'user.email=s@example.invalid', 'commit', '-m', 'readme');
    sh(path.join(dir, 'seed'), 'push', 'origin', 'main');
  }
  return { url, path: path.join(dir, 'remote.git') };
}

test('a person with no stored name creates a project, names themself, and starts a session', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  assert.deepEqual(await routes.status({}, ctx), { ok: true, name: null }, 'no name and no project');
  const parent = tmp();
  // A name that cannot be written is refused before anything is created.
  const bad = await routes.init({ parent, folder: 'paper', mode: 'brainstorming', name: 'A # B' }, ctx);
  assert.equal(bad.code, 'invalid');
  assert.equal(bad.field, 'name');
  assert.equal(fs.existsSync(path.join(parent, 'paper')), false, 'nothing created');

  const made = await routes.init({ parent, folder: 'paper', mode: 'brainstorming', title: 'Paper', name: 'F. Author' }, ctx);
  assert.equal(made.ok, true, made.error);
  assert.equal(made.repoError, undefined);
  const root = made.current;
  assert.equal(require('../hooks/lib/identity').readName(root).name, 'F. Author', 'written by the code path of `placet-research name`');
  assert.equal(sh(root, 'rev-list', '--count', 'HEAD').trim(), '1', 'one commit of the research files');
  assert.match(sh(root, 'ls-tree', '-r', '--name-only', 'HEAD'), /research\/canvas\.md/);
  assert.deepEqual(await routes.status({}, ctx), { ok: true, name: 'F. Author', hasKey: true, shared: false, origin: null });

  const started = await routes.session({ action: 'start', occasion: 'Supervision' }, ctx);
  assert.equal(started.ok, true, started.error);
  const log = fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8');
  assert.match(log, /SESSION · Supervision/);
  assert.match(log, /F\. Author/, 'the entry carries the name given in the dialog');
});

test('Start session asks for a name only where this computer has none, and never sends the person to a terminal', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const made = await routes.init({ parent: tmp(), folder: 'paper', mode: 'seed' }, ctx);
  assert.equal(made.ok, true, made.error);
  assert.equal((await routes.status({}, ctx)).name, null);
  const asked = await routes.session({ action: 'start', occasion: 'Supervision' }, ctx);
  assert.equal(asked.code, 'invalid');
  assert.equal(asked.field, 'name');
  assertPlain(asked);
  assert.equal((await routes.session({ action: 'start', occasion: 'Supervision', name: 'a\nb' }, ctx)).code, 'invalid');
  assert.equal((await routes.session({ action: 'start', occasion: 'Supervision', name: 'F. Author' }, ctx)).ok, true);
  assert.equal((await routes.status({}, ctx)).name, 'F. Author');
});

test('share into an empty remote, then a second person clones, joins and works', async (t) => {
  freshComputer(t);
  const ctxA = context(tmp());
  const a = (await routes.init({ parent: tmp(), folder: 'shared', mode: 'brainstorming', title: 'Shared', name: 'A. Author' }, ctxA)).current;
  const remote = bareRemote();
  const empty = await routes.share({ url: remote.url }, ctxA);
  assert.equal(empty.ok, true, empty.error);
  assert.equal(empty.origin, remote.url);
  const sharedStatus = await routes.status({}, ctxA);
  assert.equal(sharedStatus.shared, true);
  assert.equal(sharedStatus.origin, remote.url);
  assert.equal(sh(a, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/main');
  assert.equal(sh(remote.path, 'rev-list', '--count', 'main').trim(), '1');
  assert.equal((await routes.share({ url: remote.url }, ctxA)).code, 'shared', 'a project with a shared copy is not shared twice');

  // B: another computer. The log is still empty, and B has no key.
  const keyFile = path.join(tmp(), 'a.seal.key');
  assert.equal((await routes.invite({ out: keyFile }, ctxA)).ok, true);
  const computerA = process.env.PLACET_RESEARCH_STATE_DIR;
  freshComputer(t);
  const cloned = await routes.clone({ url: remote.url, parent: tmp(), folder: 'shared' }, context(tmp()));
  assert.equal(cloned.ok, true, cloned.error);
  const b = cloned.current;
  const ctxB = context(tmp(), b);
  assert.equal(fs.readFileSync(path.join(b, 'research', 'decisions.md'), 'utf8').includes('## [#'), false, 'the log is empty');
  const before = await routes.status({}, ctxB);
  assert.equal(before.hasKey, false, 'no key here, although the ledger has nothing to verify');
  assert.equal(before.shared, true);
  assert.equal(before.name, null);

  const first = await routes.session({ action: 'start', occasion: 'Supervision', name: 'B. Supervisor' }, ctxB);
  assert.equal(first.code, 'no-key');
  assert.match(first.error, /^Join this project first\./);
  assert.match(first.error, /key file/);
  assertPlain(first);
  assert.equal(fs.existsSync(require('../hooks/lib/seal').keyPath(b)), false, 'it never creates a key');
  assert.equal(require('../hooks/lib/identity').readName(b).name, null, 'and writes no name');
  const noExport = await routes.invite({ out: path.join(tmp(), 'b.seal.key') }, ctxB);
  assert.equal(noExport.code, 'no-key');
  assertPlain(noExport);

  assert.equal((await routes.join({ keyFile, name: 'B. Supervisor' }, ctxB)).ok, true);
  assert.equal((await routes.status({}, ctxB)).hasKey, true);
  const worked = await routes.session({ action: 'start', occasion: 'Supervision' }, ctxB);
  assert.equal(worked.ok, true, worked.error);
  const sent = await routes.send({}, ctxB);
  assert.equal(sent.ok, true, sent.error);

  process.env.PLACET_RESEARCH_STATE_DIR = computerA;
  const got = await routes.update({}, ctxA);
  assert.equal(got.ok, true, got.error);
  assert.match(fs.readFileSync(path.join(a, 'research', 'decisions.md'), 'utf8'), /SESSION · Supervision/);
});

test('share into a remote that already has commits is refused and changes nothing', async (t) => {
  freshComputer(t);
  const remote = bareRemote(true);
  const heads = sh(remote.path, 'for-each-ref');

  // A project made in the app: a repository without a shared copy.
  const ctx = context(tmp());
  const made = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  const head = sh(made, 'rev-parse', 'HEAD');
  const refused = await routes.share({ url: remote.url }, ctx);
  assert.equal(refused.code, 'not-empty');
  assert.equal(refused.field, 'url');
  assert.match(refused.error, /already holds files/);
  assert.match(refused.error, /nothing was changed/);
  assertPlain(refused);
  assert.equal(sh(made, 'remote').trim(), '', 'no origin was added');
  assert.equal(sh(made, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(remote.path, 'for-each-ref'), heads, 'the other repository is as it was');

  // A folder opened with Open project…: no repository, and still none after the refusal.
  const plain = tmp();
  assert.equal((await runCli(plain, ['init', '--project', 'plain', '--mode', 'seed'])).ok, true);
  const opened = context(tmp());
  assert.equal((await routes.open({ root: plain }, opened)).ok, true);
  assert.equal(fs.existsSync(path.join(plain, '.git')), false, 'Open project… does not init');
  assert.equal((await routes.share({ url: remote.url }, opened)).code, 'not-empty');
  assert.equal(fs.existsSync(path.join(plain, '.git')), false, 'a refused share leaves the folder without a repository');
});

test('share turns a folder without a repository into one, and a failed upload takes the link away again', async (t) => {
  freshComputer(t);
  const plain = tmp();
  assert.equal((await runCli(plain, ['init', '--project', 'plain', '--mode', 'seed'])).ok, true);
  assert.equal((await runCli(plain, ['name', 'A. Author'])).ok, true);
  const ctx = context(tmp(), plain);
  const remote = bareRemote();
  const shared = await routes.share({ url: remote.url }, ctx);
  assert.equal(shared.ok, true, shared.error);
  assert.equal(sh(plain, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.equal(sh(remote.path, 'rev-list', '--count', 'main').trim(), '1');

  // A link that is not a repository: the answer says so and no origin stays.
  const other = context(tmp());
  const second = tmp();
  assert.equal((await runCli(second, ['init', '--project', 'second', '--mode', 'seed'])).ok, true);
  assert.equal((await routes.open({ root: second }, other)).ok, true);
  const lost = await routes.share({ url: `file://${path.join(tmp(), 'nowhere.git')}` }, other);
  assertPlain(lost);
  assert.equal(lost.field, 'url');
  assert.equal(fs.existsSync(path.join(second, '.git')), false, 'nothing was set up for a link that does not work');
  assert.equal((await routes.share({ url: 'ext::sh -c x' }, other)).code, 'invalid');
});

test('Get updates and Send answer in plain words where there is no shared copy or no repository', async (t) => {
  freshComputer(t);
  // A repository without origin.
  const ctx = context(tmp());
  const made = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  for (const route of [routes.update, routes.send]) {
    const r = await route({}, ctx);
    assertPlain(r);
    assert.match(r.error, /Share with co-authors/);
  }
  // A folder that is not a repository.
  const plain = tmp();
  assert.equal((await runCli(plain, ['init', '--project', 'plain', '--mode', 'seed'])).ok, true);
  const opened = context(tmp(), plain);
  for (const route of [routes.update, routes.send]) {
    const r = await route({}, opened);
    assertPlain(r);
    assert.match(r.error, /Share with co-authors/);
  }
  // An origin that cannot be reached.
  sh(made, 'remote', 'add', 'origin', `file://${path.join(tmp(), 'gone.git')}`);
  sh(made, 'config', 'branch.main.remote', 'origin');
  sh(made, 'config', 'branch.main.merge', 'refs/heads/main');
  for (const route of [routes.update, routes.send]) assertPlain(await route({}, ctx));
  // A clone from a link that leads nowhere.
  assertPlain(await routes.clone({ url: `file://${path.join(tmp(), 'gone.git')}`, parent: tmp(), folder: 'x' }, context(tmp())));
});

// -- The hardening from the review of SQ-279 (SQ-288) ------------------------

test('a share that stopped after the link was stored is finished by sharing again', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const a = (await routes.init({ parent: tmp(), folder: 'shared', mode: 'brainstorming', title: 'Shared', name: 'A. Author' }, ctx)).current;
  const remote = bareRemote();
  // What an interrupted Share leaves behind: the link, without the upload.
  sh(a, 'remote', 'add', 'origin', remote.url);
  const before = await routes.status({}, ctx);
  assert.equal(before.shared, false, 'a stored link alone is not a shared copy');
  assert.equal(before.origin, null, 'so there is no link to hand a co-author yet');
  for (const route of [routes.update, routes.send]) assertPlain(await route({}, ctx));

  // Another repository: refused, and the link the project is connected to stays.
  const other = bareRemote();
  const refused = await routes.share({ url: other.url }, ctx);
  assertPlain(refused);
  assert.equal(refused.code, 'shared');
  assert.equal(refused.field, 'url');
  assert.match(refused.error, /connected to a shared copy already/);
  assert.match(refused.error, /finish the upload/);
  assert.equal(sh(a, 'remote', 'get-url', 'origin').trim(), remote.url);
  assert.equal(sh(other.path, 'for-each-ref').trim(), '', 'the other repository stays empty');

  // The same link finishes the job the interrupted share started.
  const resumed = await routes.share({ url: remote.url }, ctx);
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(resumed.origin, remote.url);
  assert.equal(sh(remote.path, 'rev-list', '--count', 'main').trim(), '1', 'the project is up');
  const after = await routes.status({}, ctx);
  assert.equal(after.shared, true);
  assert.equal(after.origin, remote.url);
  assert.equal(sh(a, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/main');
});

test('a resumed share still refuses a repository that already holds files', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const a = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  const full = bareRemote(true);
  const heads = sh(full.path, 'for-each-ref');
  sh(a, 'remote', 'add', 'origin', full.url);
  const refused = await routes.share({ url: full.url }, ctx);
  assert.equal(refused.code, 'not-empty');
  assert.equal(refused.field, 'url');
  assert.match(refused.error, /already holds files/);
  assertPlain(refused);
  assert.equal(sh(full.path, 'for-each-ref'), heads, 'the other repository is as it was');
});

test('Share refuses a link that carries a password, and stores nothing', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const a = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  const r = await routes.share({ url: 'https://me:secret@github.com/a/b.git' }, ctx);
  assert.equal(r.code, 'invalid');
  assert.equal(r.field, 'url');
  assertPlain(r);
  assert.match(r.error, /without your password/);
  assert.doesNotMatch(r.error, /secret/, 'the password is not repeated back');
  assert.equal(sh(a, 'remote').trim(), '', 'nothing was stored in .git/config');
  assert.equal((await routes.status({}, ctx)).shared, false);
});

test('Send commits the research files only, also in a repository that holds other work', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const a = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  const remote = bareRemote();
  assert.equal((await routes.share({ url: remote.url }, ctx)).ok, true);
  // The folder is a repository someone also works in: work outside the
  // research folder sits in the same index.
  fs.writeFileSync(path.join(a, 'notes.txt'), 'other work\n');
  sh(a, 'add', '--', 'notes.txt');
  fs.appendFileSync(path.join(a, 'research', 'canvas.md'), '\ncanvas edit\n');
  const sent = await routes.send({}, ctx);
  assert.equal(sent.ok, true, sent.error);
  assert.equal(sh(a, 'show', '--name-only', '--format=', 'HEAD').trim(), 'research/canvas.md');
  assert.equal(sh(a, 'status', '--porcelain').trim(), 'A  notes.txt', 'the other staged work is untouched');
  assert.deepEqual(sh(remote.path, 'ls-tree', '-r', '--name-only', 'main').trim().split('\n'),
    ['research/.gitattributes', 'research/canvas.md', 'research/decisions.md'], 'and the work outside the research folder was not uploaded');
});

test('a project inside another repository does not inherit that repository\'s shared copy', async (t) => {
  freshComputer(t);
  const outer = tmp();
  sh(outer, 'init', '-b', 'main');
  sh(outer, 'remote', 'add', 'origin', 'https://example.invalid/outer.git');
  sh(outer, 'config', 'branch.main.remote', 'origin');
  sh(outer, 'config', 'branch.main.merge', 'refs/heads/main');
  const inner = path.join(outer, 'paper');
  fs.mkdirSync(path.join(inner, 'research'), { recursive: true });
  fs.writeFileSync(path.join(inner, 'research', 'canvas.md'), 'canvas\n');
  const ctx = context(tmp());
  assert.equal((await routes.open({ root: inner }, ctx)).ok, true);
  const opened = await routes.status({}, ctx);
  assert.equal(opened.shared, false, 'the parent repository is not this project\'s shared copy');
  assert.equal(opened.origin, null);
  // With its own repository, too.
  sh(inner, 'init', '-b', 'main');
  const own = await routes.status({}, ctx);
  assert.equal(own.shared, false);
  assert.equal(own.origin, null);
});

test('an unreadable key reads as no key, names no path, and offers Join', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const a = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  assert.equal((await routes.status({}, ctx)).hasKey, true);
  // A key file that is there but cannot be read.
  fs.rmSync(seal.keyPath(a));
  fs.mkdirSync(seal.keyPath(a));
  assert.equal((await routes.status({}, ctx)).hasKey, false, 'the sidebar offers Join');
  const answers = [
    await routes.session({ action: 'start', occasion: 'First' }, ctx),
    await routes.invite({ out: path.join(tmp(), 'a.seal.key') }, ctx),
    await routes.join({ keyFile: path.join(tmp(), 'a.seal.key'), name: 'B. Supervisor' }, ctx),
    appRefusal({ ok: false, code: 'ledger', error: 'No sealing key for this project on this machine; run placet-research init --project <slug> --mode <mode> once here.' }, a),
  ];
  for (const r of answers) {
    assert.equal(r.code, 'no-key', r.error);
    assertPlain(r);
    assert.match(r.error, /key for the project cannot be read/);
    assert.doesNotMatch(r.error, /seal\.key/, 'the path inside the app\'s state folder is not named');
  }
});

test('a broken log refuses a session without telling the person to run a command', async (t) => {
  freshComputer(t);
  const ctx = context(tmp());
  const root = (await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming', name: 'A. Author' }, ctx)).current;
  assert.equal((await routes.session({ action: 'start', occasion: 'First' }, ctx)).ok, true);
  const file = path.join(root, 'research', 'decisions.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('First', 'Altered'));
  const r = await routes.session({ action: 'start', occasion: 'Second' }, ctx);
  assertPlain(r);
  assert.match(r.error, /broken/);
});

// The view's own write routes refuse through the ledger (SQ-282), whose
// sentences name commands. In app mode those two become the app's words; every
// other refusal is left exactly as it stands.
test('appRefusal: a ledger refusal without a key and a missing name become the app\'s sentences', (t) => {
  freshComputer(t);
  const root = tmp();
  const ledger = {
    ok: false,
    code: 'ledger',
    error: 'No sealing key for this project on this machine, so nothing is written: an entry counts only if it verifies (§4.7). Run `placet-research init --project <slug> --mode <mode>` once here to create the key, then retry.',
  };
  const noKey = appRefusal(ledger, root);
  assert.equal(noKey.code, 'no-key');
  assertPlain(noKey);
  assert.match(noKey.error, /^Join this project first\./);

  const named = appRefusal({ ok: false, code: 'name', error: 'no name is set for the decision log on this machine; run placet-research name "<your name>" once; nothing is written.' }, root);
  assert.equal(named.code, 'name');
  assertPlain(named);

  // With the key here, a ledger refusal is a broken chain: no window action
  // helps, and the sentence says what happened.
  seal.createKey(root);
  assert.equal(appRefusal(ledger, root), ledger);

  const success = { ok: true, seq: 4, seal: 'abc' };
  assert.equal(appRefusal(success, root), success);
  const invalid = { ok: false, code: 'invalid', error: 'The body may not contain a line that starts like an entry heading (`## [#`).' };
  assert.equal(appRefusal(invalid, root), invalid);
});

// SQ-313 (Windows in the browser): paths, host, OneDrive.
async function newProject() {
  const r = await routes.init({ parent: tmp(), folder: 'paper', mode: 'brainstorming' }, context(tmp()));
  assert.equal(r.ok, true, r.error);
  return r.current;
}

test('a quoted, padded path reaches the same check as a clean one', async () => {
  const root = await newProject();
  const ctx = context(tmp());
  assert.equal((await routes.open({ root: `  "${root}"  ` }, ctx)).ok, true);
  assert.equal(ctx.getRoot(), root, 'the project that opens is the clean path');
});

test('projects carries the host: platform, home and separator', async () => {
  const res = await routes.projects({}, { ...context(tmp()), platform: 'win32' });
  assert.equal(res.host.platform, 'win32');
  assert.equal(res.host.sep, '\\');
  assert.equal(typeof res.host.home, 'string');
  const here = await routes.projects({}, context(tmp()));
  assert.equal(here.host.platform, process.platform);
});

test('on Windows, init and clone refuse a folder inside OneDrive; open warns', async () => {
  const parent = tmp();
  const ctx = { ...context(tmp()), platform: 'win32', env: { OneDrive: parent } };
  const made = await routes.init({ parent, folder: 'paper', mode: 'brainstorming' }, ctx);
  assert.equal(made.code, 'onedrive');
  assert.match(made.error, /synced by OneDrive/);
  assert.equal(fs.existsSync(path.join(parent, 'paper')), false);
  const cloned = await routes.clone({ url: 'https://example.invalid/a.git', parent, folder: 'p2' }, ctx);
  assert.equal(cloned.code, 'onedrive');
  const root = await newProject();
  const opened = await routes.open({ root }, { ...context(tmp()), platform: 'win32', env: { OneDrive: path.dirname(root) } });
  assert.equal(opened.ok, true);
  assert.match(opened.warning, /OneDrive/);
});

test('off Windows, OneDrive in the environment changes nothing', async () => {
  const parent = tmp();
  const ctx = { ...context(tmp()), platform: 'darwin', env: { OneDrive: parent } };
  const made = await routes.init({ parent, folder: 'paper', mode: 'brainstorming' }, ctx);
  assert.equal(made.ok, true, made.error);
  assert.equal(made.warning, undefined);
  assert.equal((await routes.open({ root: made.current }, ctx)).warning, undefined);
});
