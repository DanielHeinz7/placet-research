'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../agent/run');
const { compareVersions, parseVersion, locate, loginPath, MIN_VERSION } = require('../agent/locate');

function fakeHome(script) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-home-'));
  if (script) {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), script, { mode: 0o755 });
  }
  return home;
}
// A login shell whose rc files print noise around everything.
function noisyShell(dir, answer) {
  const file = path.join(dir, 'noisy-sh');
  fs.writeFileSync(file, `#!/bin/sh\necho "Welcome back"\nprintf '%s' "${answer}"\necho "last login"\n`, { mode: 0o755 });
  return file;
}

test('versions compare numerically', () => {
  assert.equal(compareVersions('2.1.295', '2.1.295'), 0);
  assert.equal(compareVersions('2.1.300', '2.1.295'), 1);
  assert.equal(compareVersions('2.1.29', '2.1.295'), -1);
  assert.equal(compareVersions('10.0.0', '9.9.9'), 1);
  assert.equal(parseVersion('2.1.300 (Claude Code)\n'), '2.1.300');
  assert.equal(parseVersion('garbage'), null);
  assert.equal(MIN_VERSION, '2.1.295');
});

test('finds ~/.local/bin/claude with a launchd PATH and reads its version', async () => {
  const home = fakeHome('#!/bin/sh\necho "2.1.300 (Claude Code)"\n');
  const found = await locate({ home, shell: '/bin/sh', run: (f, a, o) => run(f, a, { ...o, env: { PATH: '/usr/bin:/bin' } }) });
  assert.deepEqual(found, { path: path.join(home, '.local', 'bin', 'claude'), version: '2.1.300', supported: true });
});

test('an old Claude Code is found but not supported', async () => {
  const home = fakeHome('#!/bin/sh\necho "2.1.200 (Claude Code)"\n');
  const found = await locate({ home, shell: '/bin/sh', run });
  assert.equal(found.supported, false);
  assert.equal(found.version, '2.1.200');
});

test('falls back to the login shell, through its noise', async () => {
  const home = fakeHome(null);
  const elsewhere = fakeHome('#!/bin/sh\necho "2.1.296 (Claude Code)"\n');
  const claude = path.join(elsewhere, '.local', 'bin', 'claude');
  const shell = noisyShell(home, `__RH__${claude}__RH_END__`);
  const found = await locate({ home, shell, run });
  assert.equal(found.path, claude);
  assert.equal(found.version, '2.1.296');
});

test('nothing found is null, not an error', async () => {
  const home = fakeHome(null);
  assert.equal(await locate({ home, shell: noisyShell(home, ''), run }), null);
});

test('the login PATH comes through the noise, with a fallback', async () => {
  const home = fakeHome(null);
  assert.equal(await loginPath({ shell: noisyShell(home, '__RH__/opt/homebrew/bin:/usr/bin__RH_END__'), run }), '/opt/homebrew/bin:/usr/bin');
  assert.equal(await loginPath({ shell: path.join(home, 'missing-shell'), run }), '/usr/bin:/bin:/usr/sbin:/sbin');
});
