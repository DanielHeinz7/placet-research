'use strict';
// Git for the desktop app's human steps: set up, share, clone, get updates,
// send. Every failure comes back as a sentence with the next step; git's own
// line follows as a detail, never as the message. Runs the
// git the app bundles (PLACET_RESEARCH_GIT) or git from PATH, never through
// a shell, and only over the transports in PLACET_RESEARCH_GIT_PROTOCOLS
// (https and ssh unless a test widens it). Every function resolves.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const host = require('./host');

const LINK_RE = /^(?:https:\/\/|ssh:\/\/|[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:)[^\s]+$/;
// A user or host that starts with a dash would reach ssh as an option.
const OPTION_HOST_RE = /^(?:https|ssh):\/\/(?:[^\s/@]*@)?-/;
const FOLDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const FALLBACK_EMAIL = 'noreply@placet-research.invalid';

function gitBinary() {
  return process.env.PLACET_RESEARCH_GIT || 'git';
}

function protocols() {
  return process.env.PLACET_RESEARCH_GIT_PROTOCOLS || 'https:ssh';
}

// A network command may take a while, and the app must not hang on it forever.
// The deadline measures silence since the last output rather than the whole
// run, so a push that keeps reporting progress is left alone. With a login
// helper configured (GIT_ASKPASS, as the desktop app sets it) git writes
// nothing at all while the person answers the app's own dialog — measured over
// a 13 s askpass wait: no output until the final fatal line — so that case
// gets the longer window instead of being cut off mid-dialog.
const IDLE_MS = 120000;
const PROMPT_IDLE_MS = 600000;
const TIMEOUT_SENTENCE = 'The shared copy stopped answering, so this step was given up. Check your internet connection, then try again.';

function idleLimit() {
  const set = Number(process.env.PLACET_RESEARCH_GIT_TIMEOUT_MS);
  if (Number.isFinite(set) && set > 0) return set;
  return process.env.GIT_ASKPASS || process.env.SSH_ASKPASS ? PROMPT_IDLE_MS : IDLE_MS;
}

function git(cwd, args, { network = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      const child = childProcess.execFile(gitBinary(), args, {
        cwd,
        // English messages whatever the system language: the sentences below match them.
        env: { ...process.env, GIT_ALLOW_PROTOCOL: protocols(), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: 'C' },
        maxBuffer: 4 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          // Node reports a missing working folder the same way as a missing program.
          finish(typeof cwd === 'string' && fs.existsSync(cwd)
            ? { ok: false, code: 'git-missing', error: `The program git was not found (${gitBinary()}), and this step needs it. The desktop app brings its own; in a browser, install git first.${host.gitMissingHint(process.platform)}` }
            : { ok: false, code: 'git', error: `The folder ${cwd} does not exist.` });
          return;
        }
        finish({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
      });
      if (network) {
        const wait = () => {
          timer = setTimeout(() => {
            child.kill();
            finish({ ok: false, code: 'timeout', error: TIMEOUT_SENTENCE });
          }, idleLimit());
        };
        const again = () => { if (!settled) { clearTimeout(timer); wait(); } };
        child.stdout.on('data', again);
        child.stderr.on('data', again);
        wait();
      }
    } catch (err) {
      finish({ ok: false, code: 'git', error: `Git could not be started: ${err.message}` });
    }
  });
}

// What git says, in words a person can act on. The first pattern that fits
// wins, so the specific ones come before the broad ones.
const REASONS = [
  [/not a git repository/i, 'This folder is not set up for sharing yet. Use Share with co-authors… first.'],
  [/terminal prompts disabled|could not read (?:username|password)|authentication failed|invalid username or password|permission denied|access denied|http basic|error: 40[13]\b/i,
    'The shared copy did not accept your login. Check that you may use this repository, then try again and give the login the app asks for.'],
  [/repository .*not found|does not appear to be a git repository|error: 404\b/i,
    'No repository was found at that link, or you may not use it. Check the link and your access to it.'],
  [/could not resolve host|unable to access|could not read from remote|connection (?:refused|timed out|reset)|network is unreachable|timed out|failed to connect|\bssl\b|\btls\b/i,
    'The app could not reach the shared copy. Check your internet connection and the link, then try again.'],
  [/unrelated histories/i,
    'This project and the shared copy were started separately, so they cannot be combined. Nothing was changed. Use Clone from link… to get the shared copy instead.'],
  [/would be overwritten|your local changes|untracked working tree files/i,
    'Some of your files outside the research folder would be overwritten by the update. Nothing was changed. Move those files elsewhere, then get updates again.'],
  [/no tracking information|no upstream|no configured push destination|no remote repository|does not have any upstream/i,
    'This project is not connected to a shared copy yet. Use Share with co-authors… first.'],
  [/src refspec .* does not match|unknown revision|ambiguous argument 'HEAD'|bad default revision|does not have any commits yet/i,
    'This project has no saved history yet. Use Share with co-authors… to start it.'],
  [/already exists and is not an empty directory/i, 'The target folder already exists and is not empty. Choose another name.'],
];

// The line worth showing after the sentence: git's first fatal or error line, else its first line.
function gitDetail(stderr) {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((l) => /^(?:fatal|error):/i.test(l)) || lines[0] || '';
  return pick.replace(/^(?:fatal|error):\s*/i, '').slice(0, 300);
}

function explain(stderr, what) {
  const hit = REASONS.find(([re]) => re.test(stderr));
  const sentence = hit ? hit[1] : `${what} did not work. Check your internet connection and the link, then try again.`;
  const detail = gitDetail(stderr);
  return detail ? `${sentence} (Git said: ${detail})` : sentence;
}

function failed(r, what) {
  return r.code ? r : { ok: false, code: 'git', error: explain(r.stderr, what) };
}

// A link as a person may read it: no user name, password or token in front of
// the host, whatever the scheme. Everything up to the last @ of the authority
// goes, so a pasted https://me:secret@host/… and a stored ssh://user@host/…
// both read as their host alone.
function displayLink(url) {
  return typeof url === 'string' ? url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:[^/?#]*@)/, '$1') : null;
}

// A link that carries a password or token in front of its host. The app asks
// for the login itself, so such a link is refused rather than stored in
// .git/config, where it would sit in plain text. A plain user name — the git@
// of an ssh link — carries no secret and is left alone.
const PASSWORD_IN_LINK_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@]*:[^/?#@]*@/;
const PASSWORD_REFUSAL = 'Paste the link without your password; the app asks for it.';

function linkCarriesPassword(url) {
  return typeof url === 'string' && PASSWORD_IN_LINK_RE.test(url);
}

function isLink(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return false;
  if (LINK_RE.test(url)) return !OPTION_HOST_RE.test(url);
  return protocols().split(':').includes('file') && /^file:\/\/\/\S+$/.test(url);
}

// A person who never used git has no identity, and git refuses to commit or
// merge without one. Use the project name the person gave the harness.
async function identityArgs(root, name) {
  const r = await git(root, ['config', 'user.email']);
  if (r.ok && r.stdout.trim()) return [];
  const who = typeof name === 'string' && name.trim() ? name.trim() : 'Research Harness user';
  return ['-c', `user.name=${who}`, '-c', `user.email=${FALLBACK_EMAIL}`];
}

function isEmptyFolder(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

async function clone({ url, parent, folder }) {
  if (!isLink(url)) return { ok: false, code: 'invalid', error: 'Only https:// and ssh links can be cloned.' };
  if (linkCarriesPassword(url)) return { ok: false, code: 'invalid', error: PASSWORD_REFUSAL };
  if (typeof folder !== 'string' || !FOLDER_RE.test(folder)) {
    return { ok: false, code: 'invalid', error: 'The folder name may use letters, digits, dots, hyphens and underscores.' };
  }
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return { ok: false, code: 'invalid', error: 'The chosen folder does not exist.' };
  }
  const root = path.join(parent, folder);
  if (fs.existsSync(root) && !isEmptyFolder(root)) {
    return { ok: false, code: 'exists', error: `${root} already exists and is not empty.` };
  }
  // -c writes core.autocrlf=false into the new clone's own config before any
  // file is checked out, so this clone and its later pulls keep LF even where
  // Git for Windows set core.autocrlf=true globally (spec 4.2, layer 2).
  const r = await git(parent, ['clone', '-c', 'core.autocrlf=false', '--', url, root], { network: true });
  return r.ok ? { ok: true, root } : failed(r, 'Cloning');
}

async function merging(root) {
  return (await git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok;
}

async function conflictedFiles(root) {
  const r = await git(root, ['diff', '--name-only', '--diff-filter=U']);
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

async function pull(root, name) {
  const before = await git(root, ['rev-parse', 'HEAD']);
  if (!before.ok) return failed(before, 'Reading the project history');
  const wasMerging = await merging(root);
  const r = await git(root, [...(await identityArgs(root, name)), 'pull', '--no-rebase', '--no-edit'], { network: true });
  if (r.ok) {
    const count = await git(root, ['rev-list', '--count', `${before.stdout.trim()}..HEAD`]);
    return { ok: true, newCommits: count.ok ? Number(count.stdout.trim()) : 0 };
  }
  if (r.code) return r;
  const files = await conflictedFiles(root);
  if (files.length) return { ok: false, code: 'conflict', files };
  // A merge that stopped for another reason (a hook, a failed commit) is
  // undone here; only a conflict is left for the caller to resolve or abort.
  if (!wasMerging && await merging(root)) await git(root, ['merge', '--abort']);
  return failed(r, 'Getting updates');
}

async function abortMerge(root) {
  const r = await git(root, ['merge', '--abort']);
  return r.ok ? { ok: true } : failed(r, 'Undoing the merge');
}

async function commit(root, paths, message, name) {
  if (!Array.isArray(paths)) return { ok: false, code: 'invalid', error: 'No files were named to send.' };
  const add = await git(root, ['add', '--', ...paths]);
  if (!add.ok) return failed(add, 'Staging the changes');
  // Only the named paths go in, so only their staged changes count: an opened
  // repository may have other changes staged, and those are not what the
  // person asked to send. A merge is finished whole, with everything in it —
  // and a merge commit cannot take a pathspec at all.
  const merge = await merging(root);
  const staged = await git(root, ['diff', '--cached', '--quiet', ...(merge ? [] : ['--', ...paths])]);
  if (staged.ok && !merge) return { ok: true, committed: false };
  const r = await git(root, [...(await identityArgs(root, name)), 'commit', '-m', message, ...(merge ? [] : ['--', ...paths])]);
  return r.ok ? { ok: true, committed: true } : failed(r, 'Committing');
}

async function push(root, { upstream = false } = {}) {
  let args = ['push'];
  if (upstream) {
    const branch = await git(root, ['symbolic-ref', '--short', 'HEAD']);
    if (!branch.ok) return failed(branch, 'Reading the project history');
    args = ['push', '-u', 'origin', branch.stdout.trim()];
  }
  const r = await git(root, args, { network: true });
  if (r.ok) return { ok: true };
  if (r.code) return r;
  if (/\[rejected\]|non-fast-forward|fetch first/.test(r.stderr)) {
    return { ok: false, code: 'rejected', error: 'The shared copy has changes you do not have yet.' };
  }
  return failed(r, 'Sending');
}

// A project is a repository from its first day: its own history, one commit
// of the research files, on a branch named main.
async function initRepo(root, paths, message, name) {
  const r = await git(root, ['init', '-b', 'main']);
  if (!r.ok) return failed(r, 'Setting up the project history');
  return commit(root, paths, message, name);
}

function hasRepo(root) {
  return fs.existsSync(path.join(root, '.git'));
}

// A question about this project's own repository and nothing above it: a
// project folder inside someone else's repository must not answer with the
// parent's remote. A project without its own .git fails, and the caller reads
// that as "none".
function ownRepo(root, args) {
  return git(root, ['--git-dir', path.join(root, '.git'), ...args]);
}

// The shared copy this project sends to and gets from, or null.
async function originOf(root) {
  const r = await ownRepo(root, ['remote', 'get-url', 'origin']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

// Whether this branch is tracked by the shared copy: the mark of an upload
// that went through. A stored origin alone is not enough — a share that
// stopped between the link and the upload leaves one behind.
async function hasUpstream(root) {
  const r = await ownRepo(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return r.ok && r.stdout.trim() !== '';
}

// Whether the repository behind a link holds nothing yet. Sharing into one
// that has commits would mix two histories, so the caller refuses it.
async function remoteIsEmpty(url) {
  const r = await git(os.tmpdir(), ['ls-remote', '--', url], { network: true });
  return r.ok ? { ok: true, empty: r.stdout.trim() === '' } : failed(r, 'Looking at the repository');
}

async function addOrigin(root, url) {
  const r = await git(root, ['remote', 'add', 'origin', url]);
  return r.ok ? { ok: true } : failed(r, 'Connecting the project to the shared copy');
}

async function removeOrigin(root) {
  await git(root, ['remote', 'remove', 'origin']);
}

module.exports = { isLink, displayLink, linkCarriesPassword, PASSWORD_REFUSAL, explain, clone, pull, abortMerge, commit, push, initRepo, hasRepo, originOf, hasUpstream, remoteIsEmpty, addOrigin, removeOrigin, gitBinary };
