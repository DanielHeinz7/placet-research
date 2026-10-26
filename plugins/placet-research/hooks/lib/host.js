'use strict';
// What differs by operating system, as pure functions: the caller passes the
// platform, the environment and the versions, so tests on macOS can ask the
// Windows questions (sub-project 5; nothing here has run on Windows).
const path = require('node:path');

const NODE_FLOOR = 22;
const GIT_FOR_WINDOWS = 'https://git-scm.com/download/win';
const KEEP_OPEN = 'placet-research is running in your browser. Keep this window open while you work; close it to stop.';

function normalizePath(p) {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}

function oneDriveOf(p, { platform, env }) {
  if (platform !== 'win32' || typeof p !== 'string') return null;
  for (const name of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const root = env && env[name];
    if (!root) continue;
    const rel = path.win32.relative(root.toLowerCase(), p.toLowerCase());
    if (rel === '' || (!rel.startsWith('..') && !path.win32.isAbsolute(rel))) return root;
  }
  return null;
}

function hostInfo({ platform, home }) {
  return { platform, home, sep: platform === 'win32' ? '\\' : '/' };
}

function startNotes({ platform, nodeVersion, gitFound }) {
  const major = Number(String(nodeVersion).split('.')[0]);
  if (!(major >= NODE_FLOOR)) {
    return { refuse: `placet-research needs Node.js ${NODE_FLOOR} or newer (this is ${nodeVersion}). Install it from https://nodejs.org, then start placet-research again.`, lines: [] };
  }
  const lines = [];
  if (!gitFound) {
    lines.push(platform === 'win32'
      ? `Git was not found. Opening a project and running a meeting work without it; to clone, get updates and send, install Git for Windows from ${GIT_FOR_WINDOWS} and start placet-research again.`
      : 'Git was not found. Opening a project and running a meeting work without it; clone, get updates and send need git.');
  }
  lines.push(KEEP_OPEN);
  return { refuse: null, lines };
}

function installCliRefusal(platform) {
  return platform === 'win32'
    ? 'install-cli writes a shell command for macOS and Linux. On Windows, start placet-research with Start placet-research.cmd.'
    : null;
}

function gitMissingHint(platform) {
  return platform === 'win32' ? ` Install Git for Windows from ${GIT_FOR_WINDOWS} and start placet-research again.` : '';
}

module.exports = { NODE_FLOOR, GIT_FOR_WINDOWS, KEEP_OPEN, normalizePath, oneDriveOf, hostInfo, startNotes, installCliRefusal, gitMissingHint };
