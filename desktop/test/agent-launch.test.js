'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const { claudeArgs, agentEnv, SESSION_SETTINGS, FORBIDDEN_FLAGS } = require('../agent/launch');

const SHIMS = path.join(__dirname, '..', 'agent', 'shims');

test('the argument list is the spec\'s, and never a forbidden flag', () => {
  assert.deepEqual(claudeArgs({ pluginRoot: '/app/plugin' }), ['--plugin-dir', '/app/plugin', '--settings', '{"disableAllHooks":false,"enabledPlugins":{"placet-research@inline":true}}']);
  assert.deepEqual(claudeArgs({ pluginRoot: '/p', resume: true, screenReader: true }).slice(4), ['--continue', '--ax-screen-reader']);
  assert.equal(SESSION_SETTINGS, '{"disableAllHooks":false,"enabledPlugins":{"placet-research@inline":true}}');
  for (const opts of [{}, { resume: true }, { screenReader: true }, { resume: true, screenReader: true }]) {
    const args = claudeArgs({ pluginRoot: '/p', ...opts });
    for (const flag of FORBIDDEN_FLAGS) assert.ok(!args.includes(flag), flag);
  }
  assert.deepEqual(FORBIDDEN_FLAGS, ['--bare', '--safe-mode', '--dangerously-skip-permissions', '--permission-mode', '--system-prompt', '--append-system-prompt']);
});

const GIT = { bin: '/app/git/bin/git', execPath: '/app/git/libexec/git-core', configSystem: '/app/git/etc/gitconfig', templateDir: '/app/git/share/git-core/templates' };

test('PATH has the shims first, then the login PATH; ELECTRON_RUN_AS_NODE never reaches the pty', () => {
  const env = agentEnv({
    base: { HOME: '/home/p', USER: 'p', SHELL: '/bin/zsh', LANG: 'de_DE.UTF-8', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require x', CLAUDECODE: '1', SECRET_TOKEN: 's' },
    loginPath: '/opt/homebrew/bin:/usr/bin:/bin', shimsDir: SHIMS, electronPath: '/app/Electron', git: GIT, markerPath: '/data/agent/marker-1.json',
  });
  assert.equal(env.PATH, `${SHIMS}:/opt/homebrew/bin:/usr/bin:/bin`);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.HOME, '/home/p');
  assert.equal(env.LANG, 'de_DE.UTF-8');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.RH_ELECTRON, '/app/Electron');
  assert.equal(env.RH_GIT, GIT.bin);
  assert.equal(env.PLACET_RESEARCH_APP_MARKER, '/data/agent/marker-1.json');
  assert.equal(env.GIT_EXEC_PATH, undefined, 'git variables are set inside the git shim only');
});

test('the node shim runs Electron as Node and keeps the variable to itself', () => {
  const out = childProcess.execFileSync(path.join(SHIMS, 'node'), ['-e', 'process.stdout.write(JSON.stringify({ e: process.versions.electron || null, v: process.env.ELECTRON_RUN_AS_NODE }))'], {
    env: { PATH: '/usr/bin:/bin', RH_ELECTRON: require('electron') }, encoding: 'utf8',
  });
  const r = JSON.parse(out);
  assert.match(r.e, /^\d+\./);
  assert.equal(r.v, '1');
});

test('the shims fail closed with a message when the app did not set them up', () => {
  for (const name of ['node', 'git']) {
    const r = childProcess.spawnSync(path.join(SHIMS, name), ['--version'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(r.status, 127, name);
    assert.match(r.stderr, /placet-research app/);
  }
});

test('the git shim runs the bundled git with its helper paths', () => {
  const { gitPath } = require('../git-path');
  const bin = gitPath();
  const dir = path.resolve(bin, '..', '..');
  const out = childProcess.execFileSync(path.join(SHIMS, 'git'), ['--exec-path'], {
    env: { PATH: '/usr/bin:/bin', RH_GIT: bin, RH_GIT_EXEC_PATH: path.join(dir, 'libexec', 'git-core'), RH_GIT_CONFIG_SYSTEM: path.join(dir, 'etc', 'gitconfig'), RH_GIT_TEMPLATE_DIR: path.join(dir, 'share', 'git-core', 'templates') },
    encoding: 'utf8',
  });
  assert.equal(out.trim(), path.join(dir, 'libexec', 'git-core'));
});
