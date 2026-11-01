'use strict';
// The variables sub-project 2's shims read, for tests in plain Node: the
// shim's "Electron" is this Node, and git is the bundled one.
const path = require('node:path');
const { gitPath } = require('../../git-path');
const { agentEnv } = require('../../agent/launch');

function shimEnv() {
  const bin = gitPath();
  const dir = path.resolve(bin, '..', '..');
  const env = agentEnv({ base: {}, loginPath: '', shimsDir: '', electronPath: process.execPath, markerPath: '',
    git: { bin, execPath: path.join(dir, 'libexec', 'git-core'), configSystem: path.join(dir, 'etc', 'gitconfig'), templateDir: path.join(dir, 'share', 'git-core', 'templates') } });
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('RH_')));
}

module.exports = { shimEnv };
