'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appGit = require('../hooks/lib/app-git');

// The clones below have no user.name or user.email: commit and merge succeed
// only through identityArgs (Review Focus 1), so a global identity on the
// machine running the tests must not leak in. The seed sets its own locally.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';

function sh(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-app-git-'));
}
// A bare remote with one commit, and a clone of it named `name`.
function remoteWithClone(name) {
  const dir = tmp();
  sh(dir, 'init', '--bare', '-b', 'main', 'remote.git');
  sh(dir, 'clone', path.join(dir, 'remote.git'), 'seed');
  const seed = path.join(dir, 'seed');
  sh(seed, 'config', 'user.name', 'Seed');
  sh(seed, 'config', 'user.email', 'seed@example.invalid');
  fs.mkdirSync(path.join(seed, 'research'));
  fs.writeFileSync(path.join(seed, 'research', 'canvas.md'), 'line one\n');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-m', 'seed');
  sh(seed, 'push', 'origin', 'main');
  sh(dir, 'clone', path.join(dir, 'remote.git'), name);
  return { dir, remote: path.join(dir, 'remote.git'), seed, clone: path.join(dir, name) };
}

test('links: https, ssh and scp form pass; flags and other transports do not', () => {
  delete process.env.PLACET_RESEARCH_GIT_PROTOCOLS;
  for (const ok of ['https://github.com/a/b.git', 'ssh://git@host/a/b.git', 'git@github.com:a/b.git']) assert.equal(appGit.isLink(ok), true, ok);
  for (const bad of ['--upload-pack=touch /tmp/x', 'ext::sh -c touch% /tmp/x', 'file:///etc', '/tmp/repo', 'https://a b', '']) assert.equal(appGit.isLink(bad), false, bad);
});

test('links whose user or host is an option are refused', () => {
  delete process.env.PLACET_RESEARCH_GIT_PROTOCOLS;
  for (const bad of ['-oProxyCommand@host:a/b.git', 'git@-oProxyCommand:a/b.git', 'ssh://-oProxyCommand=touch/a.git', 'ssh://git@-oProxyCommand=touch/a.git', 'https://-x/a.git']) {
    assert.equal(appGit.isLink(bad), false, bad);
  }
  assert.equal(appGit.isLink('https://github.com/a-b/c-d.git'), true);
});

test('clone refuses a bad link, a bad folder name and a non-empty target before running git', async () => {
  delete process.env.PLACET_RESEARCH_GIT_PROTOCOLS;
  const parent = tmp();
  assert.equal((await appGit.clone({ url: 'ext::sh -c x', parent, folder: 'p' })).code, 'invalid');
  assert.equal((await appGit.clone({ url: 'https://h/a.git', parent, folder: '../up' })).code, 'invalid');
  fs.mkdirSync(path.join(parent, 'full'));
  fs.writeFileSync(path.join(parent, 'full', 'x'), '');
  assert.equal((await appGit.clone({ url: 'https://h/a.git', parent, folder: 'full' })).code, 'exists');
  fs.writeFileSync(path.join(parent, 'afile'), '');
  assert.equal((await appGit.clone({ url: 'https://h/a.git', parent, folder: 'afile' })).code, 'exists');
});

test('clone, pull with new commits, commit and push between two clones', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const r = remoteWithClone('a');
  const b = await appGit.clone({ url: `file://${r.remote}`, parent: r.dir, folder: 'b' });
  assert.equal(b.ok, true, b.error);
  fs.appendFileSync(path.join(r.clone, 'research', 'canvas.md'), 'from a\n');
  assert.deepEqual(await appGit.commit(r.clone, ['research'], 'a writes', 'A. Researcher'), { ok: true, committed: true });
  assert.equal(sh(r.clone, 'log', '-1', '--format=%an <%ae>').trim(), 'A. Researcher <noreply@placet-research.invalid>');
  assert.deepEqual(await appGit.commit(r.clone, ['research'], 'again', 'A. Researcher'), { ok: true, committed: false });
  assert.deepEqual(await appGit.push(r.clone), { ok: true });
  const pulled = await appGit.pull(b.root, 'B. Supervisor');
  assert.deepEqual(pulled, { ok: true, newCommits: 1 });
});

test('a pull that merges without conflict commits the merge as the named person', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const r = remoteWithClone('a');
  fs.writeFileSync(path.join(r.seed, 'research', 'other.md'), 'seed\n');
  sh(r.seed, 'add', '.');
  sh(r.seed, 'commit', '-m', 'seed adds a file');
  sh(r.seed, 'push');
  fs.appendFileSync(path.join(r.clone, 'research', 'canvas.md'), 'a\n');
  await appGit.commit(r.clone, ['research'], 'a edit', 'A. Researcher');
  assert.deepEqual(await appGit.pull(r.clone, 'A. Researcher'), { ok: true, newCommits: 2 });
  assert.equal(sh(r.clone, 'log', '-1', '--format=%P').trim().split(' ').length, 2);
  assert.equal(sh(r.clone, 'log', '-1', '--format=%an <%ae>').trim(), 'A. Researcher <noreply@placet-research.invalid>');
});

test('a conflicting pull reports the files and abortMerge restores the copy', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const r = remoteWithClone('a');
  fs.writeFileSync(path.join(r.seed, 'research', 'canvas.md'), 'seed changed\n');
  sh(r.seed, 'commit', '-am', 'seed edit');
  sh(r.seed, 'push');
  fs.writeFileSync(path.join(r.clone, 'research', 'canvas.md'), 'a changed\n');
  await appGit.commit(r.clone, ['research'], 'a edit', 'A. Researcher');
  const pulled = await appGit.pull(r.clone, 'A. Researcher');
  assert.deepEqual(pulled, { ok: false, code: 'conflict', files: ['research/canvas.md'] });
  assert.deepEqual(await appGit.abortMerge(r.clone), { ok: true });
  assert.equal(fs.readFileSync(path.join(r.clone, 'research', 'canvas.md'), 'utf8'), 'a changed\n');
  assert.equal(fs.existsSync(path.join(r.clone, '.git', 'MERGE_HEAD')), false);
});

test('a pull whose merge stops without a conflict leaves no merge in progress', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const r = remoteWithClone('a');
  fs.writeFileSync(path.join(r.seed, 'research', 'other.md'), 'seed\n');
  sh(r.seed, 'add', '.');
  sh(r.seed, 'commit', '-m', 'seed adds a file');
  sh(r.seed, 'push');
  fs.appendFileSync(path.join(r.clone, 'research', 'canvas.md'), 'a\n');
  await appGit.commit(r.clone, ['research'], 'a edit', 'A. Researcher');
  const head = sh(r.clone, 'rev-parse', 'HEAD');
  // A hook that refuses every merge commit: git stops after merging the files.
  const hook = path.join(r.clone, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  const pulled = await appGit.pull(r.clone, 'A. Researcher');
  assert.equal(pulled.ok, false);
  assert.equal(pulled.code, 'git');
  assert.equal(fs.existsSync(path.join(r.clone, '.git', 'MERGE_HEAD')), false);
  assert.equal(sh(r.clone, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(r.clone, 'status', '--porcelain'), '');
});

test('a rejected push says so', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const r = remoteWithClone('a');
  fs.appendFileSync(path.join(r.seed, 'research', 'canvas.md'), 'seed\n');
  sh(r.seed, 'commit', '-am', 'seed');
  sh(r.seed, 'push');
  fs.appendFileSync(path.join(r.clone, 'research', 'canvas.md'), 'a\n');
  await appGit.commit(r.clone, ['research'], 'a', 'A. Researcher');
  assert.equal((await appGit.push(r.clone)).code, 'rejected');
});

test('a missing git binary is named, not thrown', async () => {
  process.env.PLACET_RESEARCH_GIT = '/nonexistent/git';
  try {
    const r = await appGit.pull(tmp(), 'x');
    assert.equal(r.code, 'git-missing');
    assert.match(r.error, /\/nonexistent\/git/);
  } finally {
    delete process.env.PLACET_RESEARCH_GIT;
  }
});

test('a missing project folder or bad arguments resolve with an error, never throw', async () => {
  const gone = path.join(tmp(), 'gone');
  const r = await appGit.pull(gone, 'x');
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 'git-missing');
  const root = tmp();
  assert.equal((await appGit.commit(root, undefined, 'm', 'x')).ok, false);
  assert.equal((await appGit.commit(root, ['a'], undefined, 'x')).ok, false);
});

test('git failures become a sentence with the next step; git\'s own line is only a detail', () => {
  const cases = [
    ['fatal: not a git repository (or any of the parent directories): .git', /Share with co-authors/],
    ['fatal: could not read Username for \'https://h\': terminal prompts disabled', /did not accept your login/],
    ['remote: Invalid username or password.\nfatal: Authentication failed for \'https://h/a.git/\'', /did not accept your login/],
    ['git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.', /did not accept your login/],
    ['remote: Repository not found.\nfatal: repository \'https://h/a.git/\' not found', /No repository was found/],
    ['fatal: unable to access \'https://h/\': Could not resolve host: h', /could not reach the shared copy/],
    ['fatal: refusing to merge unrelated histories', /started separately/],
    ['error: Your local changes to the following files would be overwritten by merge:\n\tx', /outside the research folder/],
    ['There is no tracking information for the current branch.', /not connected to a shared copy/],
    ['fatal: No configured push destination.', /not connected to a shared copy/],
    ['error: src refspec main does not match any', /no saved history/],
    ['something git never said before', /Getting updates did not work\./],
  ];
  for (const [stderr, expected] of cases) {
    const text = appGit.explain(stderr, 'Getting updates');
    assert.match(text, expected, stderr);
    assert.doesNotMatch(text, /^fatal|^error|fatal:|placet-research [a-z]/i, `git's text is not the message: ${text}`);
    assert.match(text, /\(Git said: .+\)$/, 'git\'s line follows as a detail');
  }
});

test('a link shows without the password or token in front of its host', () => {
  assert.equal(appGit.displayLink('https://me:secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(appGit.displayLink('https://github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(appGit.displayLink('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(appGit.displayLink('ssh://me:secret@host/a/b.git'), 'ssh://host/a/b.git', 'whatever the scheme');
  assert.equal(appGit.displayLink('https://user@host/a.git'), 'https://host/a.git');
  assert.equal(appGit.displayLink('https://me:p@ss@host/a.git'), 'https://host/a.git', 'up to the last @ of the host part');
  assert.equal(appGit.displayLink(null), null);
});

test('a link that carries a password or token is recognised; a plain user name is not', () => {
  for (const bad of ['https://me:secret@github.com/a/b.git', 'ssh://git:token@host/a.git', 'http://x:y@h/a.git']) {
    assert.equal(appGit.linkCarriesPassword(bad), true, bad);
  }
  for (const ok of ['https://github.com/a/b.git', 'git@github.com:a/b.git', 'ssh://git@host/a.git', 'https://user@host/a.git', '', null]) {
    assert.equal(appGit.linkCarriesPassword(ok), false, String(ok));
  }
});

test('clone refuses a link with a password in it, so no token reaches .git/config', async () => {
  const parent = tmp();
  const r = await appGit.clone({ url: 'https://me:secret@host/a.git', parent, folder: 'paper' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.match(r.error, /without your password/);
  assert.doesNotMatch(r.error, /secret/);
  assert.equal(fs.existsSync(path.join(parent, 'paper')), false, 'nothing was set up');
});

test('a project becomes a repository with one commit; a link is added, checked and pushed with upstream', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const dir = tmp();
  const project = path.join(dir, 'paper');
  fs.mkdirSync(path.join(project, 'research'), { recursive: true });
  fs.writeFileSync(path.join(project, 'research', 'canvas.md'), 'canvas\n');
  fs.writeFileSync(path.join(project, 'notes.txt'), 'outside the research files\n');
  assert.equal(appGit.hasRepo(project), false);
  assert.deepEqual(await appGit.initRepo(project, ['research'], 'Start the project', 'A. Author'), { ok: true, committed: true });
  assert.equal(appGit.hasRepo(project), true);
  assert.equal(sh(project, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  assert.equal(sh(project, 'ls-files').trim(), 'research/canvas.md', 'only the research files are committed');
  assert.equal(await appGit.originOf(project), null);

  sh(dir, 'init', '--bare', '-b', 'main', 'empty.git');
  const empty = `file://${path.join(dir, 'empty.git')}`;
  assert.deepEqual(await appGit.remoteIsEmpty(empty), { ok: true, empty: true });
  assert.deepEqual(await appGit.addOrigin(project, empty), { ok: true });
  assert.equal(await appGit.originOf(project), empty);
  assert.deepEqual(await appGit.push(project, { upstream: true }), { ok: true });
  assert.equal(sh(project, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/main');
  assert.deepEqual(await appGit.remoteIsEmpty(empty), { ok: true, empty: false }, 'after the push the repository holds the project');

  await appGit.removeOrigin(project);
  assert.equal(await appGit.originOf(project), null);
  const missing = await appGit.remoteIsEmpty(`file://${path.join(dir, 'nowhere.git')}`);
  assert.equal(missing.ok, false);
  assert.doesNotMatch(missing.error, /fatal:/);
});

test('a project inside another repository reads its own origin, never the parent\'s', async () => {
  const dir = tmp();
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'remote', 'add', 'origin', 'https://example.invalid/outer.git');
  const inner = path.join(dir, 'paper');
  fs.mkdirSync(inner);
  assert.equal(await appGit.originOf(inner), null, 'a folder without its own repository has no origin');
  sh(inner, 'init', '-b', 'main');
  assert.equal(await appGit.originOf(inner), null, 'its own repository without an origin');
  assert.equal(await appGit.hasUpstream(inner), false);
  sh(inner, 'remote', 'add', 'origin', 'https://example.invalid/inner.git');
  assert.equal(await appGit.originOf(inner), 'https://example.invalid/inner.git', 'its own origin');
});

test('hasUpstream tells a stored link from an upload that went through', async () => {
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  const dir = tmp();
  const project = path.join(dir, 'paper');
  fs.mkdirSync(path.join(project, 'research'), { recursive: true });
  fs.writeFileSync(path.join(project, 'research', 'canvas.md'), 'canvas\n');
  await appGit.initRepo(project, ['research'], 'Start the project', 'A. Author');
  sh(dir, 'init', '--bare', '-b', 'main', 'empty.git');
  const url = `file://${path.join(dir, 'empty.git')}`;
  assert.equal(await appGit.hasUpstream(project), false, 'no link at all');
  assert.deepEqual(await appGit.addOrigin(project, url), { ok: true });
  assert.equal(await appGit.originOf(project), url);
  assert.equal(await appGit.hasUpstream(project), false, 'a stored link is not an upload');
  assert.deepEqual(await appGit.push(project, { upstream: true }), { ok: true });
  assert.equal(await appGit.hasUpstream(project), true);
});

test('commit sends the named paths only, not other work staged in the same repository', async () => {
  const dir = tmp();
  const project = path.join(dir, 'paper');
  fs.mkdirSync(path.join(project, 'research'), { recursive: true });
  fs.writeFileSync(path.join(project, 'research', 'canvas.md'), 'canvas\n');
  fs.writeFileSync(path.join(project, 'notes.txt'), 'notes\n');
  await appGit.initRepo(project, ['research'], 'Start the project', 'A. Author');
  assert.equal(sh(project, 'ls-files').trim(), 'research/canvas.md');
  // Someone staged work outside the research folder in the same repository.
  fs.writeFileSync(path.join(project, 'notes.txt'), 'notes, changed\n');
  sh(project, 'add', '--', 'notes.txt');
  fs.appendFileSync(path.join(project, 'research', 'canvas.md'), 'edit\n');
  assert.deepEqual(await appGit.commit(project, ['research'], 'Research canvas changes', 'A. Author'), { ok: true, committed: true });
  assert.equal(sh(project, 'show', '--name-only', '--format=', 'HEAD').trim(), 'research/canvas.md');
  assert.equal(sh(project, 'status', '--porcelain').trim(), 'A  notes.txt', 'the other staged change is still there');

  // Nothing changed in the research folder: no commit is made for it.
  fs.appendFileSync(path.join(project, 'notes.txt'), 'more\n');
  sh(project, 'add', '--', 'notes.txt');
  assert.deepEqual(await appGit.commit(project, ['research'], 'Research canvas changes', 'A. Author'), { ok: true, committed: false });
  assert.equal(sh(project, 'rev-list', '--count', 'HEAD').trim(), '2');
});

// A stand-in git that says nothing and never ends, so the deadline is what
// ends it: on a machine without the developer tools the real git at /usr/bin
// opens the system installer instead, which is what SQ-282 is about.
function quietGit(file) {
  fs.writeFileSync(file, '#!/bin/sh\nexec sleep 30\n');
  fs.chmodSync(file, 0o755);
  return file;
}

test('a network command that says nothing for too long gives up with a sentence', { skip: process.platform === 'win32' }, async () => {
  const stub = quietGit(path.join(tmp(), 'quiet-git'));
  process.env.PLACET_RESEARCH_GIT = stub;
  process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS = '1000';
  try {
    const started = Date.now();
    const r = await appGit.push(tmp());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'timeout');
    assert.match(r.error, /stopped answering/);
    assert.doesNotMatch(r.error, /fatal:|placet-research [a-z]|quiet-git/);
    assert.ok(Date.now() - started < 20000, 'it did not wait for the command');
  } finally {
    delete process.env.PLACET_RESEARCH_GIT;
    delete process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS;
  }
});

test('the deadline measures silence, so a command that keeps reporting goes on', { skip: process.platform === 'win32' }, async () => {
  const stub = path.join(tmp(), 'chatty-git');
  fs.writeFileSync(stub, '#!/bin/sh\necho one\nsleep 0.5\necho two\nsleep 0.5\necho three\n');
  fs.chmodSync(stub, 0o755);
  process.env.PLACET_RESEARCH_GIT = stub;
  process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS = '3000';
  try {
    assert.deepEqual(await appGit.push(tmp()), { ok: true });
  } finally {
    delete process.env.PLACET_RESEARCH_GIT;
    delete process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS;
  }
});

test('a local command has no deadline: it is not a network step', { skip: process.platform === 'win32' }, async () => {
  const stub = path.join(tmp(), 'slow-git');
  fs.writeFileSync(stub, '#!/bin/sh\nsleep 1.5\necho main\n');
  fs.chmodSync(stub, 0o755);
  process.env.PLACET_RESEARCH_GIT = stub;
  process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS = '500';
  try {
    const dir = tmp();
    assert.equal(await appGit.hasUpstream(dir), true, 'a slow local answer is waited for');
  } finally {
    delete process.env.PLACET_RESEARCH_GIT;
    delete process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS;
  }
});

// SQ-313: the Windows hint rides on the same sentence; elsewhere it is unchanged.
test('the git-missing sentence ends with the platform hint, and is whole without one', async () => {
  const host = require('../hooks/lib/host');
  process.env.PLACET_RESEARCH_GIT = '/nonexistent/git';
  try {
    const r = await appGit.pull(tmp(), 'x');
    assert.equal(r.code, 'git-missing');
    assert.ok(r.error.endsWith(host.gitMissingHint(process.platform)), r.error);
    if (process.platform !== 'win32') {
      assert.equal(r.error, 'The program git was not found (/nonexistent/git), and this step needs it. The desktop app brings its own; in a browser, install git first.');
    } else {
      assert.match(r.error, /git-scm\.com\/download\/win/);
    }
  } finally {
    delete process.env.PLACET_RESEARCH_GIT;
  }
});
