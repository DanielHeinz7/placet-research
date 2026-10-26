'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const appGit = require('../hooks/lib/app-git');

const cli = path.join(__dirname, '..', 'bin', 'placet-research.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const globalConfig = path.join(tmp('rh-autocrlf-'), 'gitconfig');
fs.writeFileSync(globalConfig, '[core]\n\tautocrlf = true\n[user]\n\tname = Seed\n\temail = seed@example.invalid\n');
process.env.GIT_CONFIG_GLOBAL = globalConfig;   // inherited by git and by the CLI below
process.env.GIT_CONFIG_NOSYSTEM = '1';

function sh(cwd, ...args) { return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }); }
function rh(cwd, stateDir, ...args) {
  const { CLAUDE_PROJECT_DIR: _p, PLACET_RESEARCH_DIR: _d, ...env } = process.env;
  return childProcess.spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env, PLACET_RESEARCH_STATE_DIR: stateDir }, encoding: 'utf8' });
}
const hasCr = (file) => fs.readFileSync(file, 'utf8').includes('\r\n');

// A project made by init, one sealed finding, pushed to a bare remote.
// `withAttributes: false` removes research/.gitattributes before the commit,
// which is what a project made before this change looks like.
function sharedProject({ withAttributes }) {
  const dir = tmp('rh-crlf-git-');
  const stateDir = path.join(dir, 'state');
  sh(dir, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  const a = path.join(dir, 'a');
  fs.mkdirSync(a);
  sh(a, 'init', '-q', '-b', 'main');
  assert.equal(rh(a, stateDir, 'init', '--project', 'crlf-probe', '--mode', 'brainstorming').status, 0);
  assert.equal(rh(a, stateDir, 'log', 'DISCOVERY', '1.1', '--body', 'A finding.').status, 0);
  if (!withAttributes) fs.rmSync(path.join(a, 'research', '.gitattributes'), { force: true });
  sh(a, 'add', '-A');
  sh(a, 'commit', '-q', '-m', 'project');
  sh(a, 'remote', 'add', 'origin', path.join(dir, 'remote.git'));
  sh(a, 'push', '-q', 'origin', 'main');
  return { dir, stateDir, remote: path.join(dir, 'remote.git') };
}

test('init writes research/.gitattributes, and a hand clone under autocrlf=true stays LF and verifies', () => {
  const p = sharedProject({ withAttributes: true });
  sh(p.dir, 'clone', '-q', p.remote, 'b');
  const b = path.join(p.dir, 'b');
  assert.equal(hasCr(path.join(b, 'research', 'decisions.md')), false);
  assert.equal(hasCr(path.join(b, 'research', 'canvas.md')), false);
  assert.equal(fs.readFileSync(path.join(b, 'research', '.gitattributes'), 'utf8'), '* text eol=lf\n');
  const r = rh(b, p.stateDir, 'review');   // same state dir: the clone holds the project key
  assert.doesNotMatch(r.stdout + r.stderr, /Windows line endings/);
});

test('an older project cloned by hand gets CRLF, is refused, and the README repair makes it readable', () => {
  const p = sharedProject({ withAttributes: false });
  sh(p.dir, 'clone', '-q', p.remote, 'b');
  const b = path.join(p.dir, 'b');
  assert.equal(hasCr(path.join(b, 'research', 'decisions.md')), true);
  for (const cmd of ['status', 'review']) assert.match(((r) => r.stdout + r.stderr)(rh(b, p.stateDir, cmd)), /Windows line endings \(CRLF\)/, cmd);
  // A clone a second old: its index entries are no longer racily clean, so git
  // skips files it thinks unchanged. Right after a clone it would rewrite them on
  // any checkout, and a weaker repair would pass by timing alone.
  const past = new Date(Date.now() - 10_000);
  for (const f of ['canvas.md', 'decisions.md']) fs.utimesSync(path.join(b, 'research', f), past, past);
  assert.equal(sh(b, 'status', '--porcelain'), '');            // the README's precondition
  sh(b, 'config', 'core.autocrlf', 'false');                   // the README's three commands
  sh(b, 'rm', '-r', '-q', '--cached', 'research');
  sh(b, 'checkout', 'HEAD', '--', 'research');
  assert.equal(hasCr(path.join(b, 'research', 'decisions.md')), false);
  assert.equal(hasCr(path.join(b, 'research', 'canvas.md')), false);
  assert.equal(sh(b, 'status', '--porcelain'), '');
  assert.doesNotMatch(((r) => r.stdout + r.stderr)(rh(b, p.stateDir, 'review')), /Windows line endings/);
});

test('the app clones an older project with LF', async () => {
  const before = process.env.PLACET_RESEARCH_GIT_PROTOCOLS;
  process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';
  try {
    const p = sharedProject({ withAttributes: false });
    const r = await appGit.clone({ url: `file://${p.remote}`, parent: p.dir, folder: 'c' });
    assert.equal(r.ok, true, r.error);
    assert.equal(hasCr(path.join(p.dir, 'c', 'research', 'decisions.md')), false);
    assert.equal(sh(path.join(p.dir, 'c'), 'config', '--local', 'core.autocrlf').trim(), 'false');
  } finally {
    if (before === undefined) delete process.env.PLACET_RESEARCH_GIT_PROTOCOLS;
    else process.env.PLACET_RESEARCH_GIT_PROTOCOLS = before;
  }
});

test('init leaves an existing research/.gitattributes and a root .gitattributes alone', () => {
  const root = tmp('rh-attrs-');
  fs.mkdirSync(path.join(root, 'research'));
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.pdf binary\n');
  fs.writeFileSync(path.join(root, 'research', '.gitattributes'), '# mine\n');
  assert.equal(rh(root, path.join(root, '.state'), 'init', '--project', 'x', '--mode', 'import').status, 0);
  assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), '*.pdf binary\n');
  assert.equal(fs.readFileSync(path.join(root, 'research', '.gitattributes'), 'utf8'), '# mine\n');
});
