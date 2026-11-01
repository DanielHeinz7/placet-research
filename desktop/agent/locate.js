'use strict';
// Finds the person's Claude Code. An app started from Finder gets launchd's
// short PATH, without ~/.local/bin, so the native installer's launcher is
// checked first and the login shell is asked once after that. Never reads
// Claude Code's config, credentials or Keychain item (spec §5.1).
const fs = require('node:fs');
const path = require('node:path');

const MIN_VERSION = '2.1.295';          // first version with onFailure, which the guard needs
const FALLBACK_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function parseVersion(text) {
  const m = /(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// rc files may print anything; the markers keep the answer apart from it.
async function loginShellValue({ shell, script, run }) {
  const res = await run(shell, ['-lc', `printf '__RH__%s__RH_END__' "${script}"`], { timeout: 5000 });
  const m = /__RH__([\s\S]*?)__RH_END__/.exec(res.stdout);
  return m ? m[1].trim() : null;
}

async function loginPath({ shell, run }) {
  const value = await loginShellValue({ shell, script: '$PATH', run });
  return value || FALLBACK_PATH;
}

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; }
}

async function locate({ home, shell, run }) {
  let file = path.join(home, '.local', 'bin', 'claude');
  if (!executable(file)) {
    file = await loginShellValue({ shell, script: '$(command -v claude)', run });
    if (!file || !path.isAbsolute(file) || !executable(file)) return null;
  }
  const res = await run(file, ['--version'], { timeout: 10000 });
  const version = parseVersion(res.stdout);
  if (!version) return null;
  return { path: file, version, supported: compareVersions(version, MIN_VERSION) >= 0 };
}

module.exports = { MIN_VERSION, compareVersions, parseVersion, loginShellValue, loginPath, locate };
