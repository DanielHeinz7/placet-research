'use strict';
// Where the git that ships with the app lives. dugite unpacks a full git
// into its package folder; the app passes this path to the server as
// PLACET_RESEARCH_GIT so a Mac without developer tools can clone.
const childProcess = require('node:child_process');
const path = require('node:path');

function gitPath() {
  return path.join(path.dirname(require.resolve('dugite/package.json')), 'git', 'bin', 'git');
}

function credentialHelper() {
  try {
    return childProcess.execFileSync(gitPath(), ['config', '--get', 'credential.helper'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

module.exports = { gitPath, credentialHelper };
