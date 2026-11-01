'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDistribution, builderSettings, preflight, DistributionError, DIST_FILE } = require('../lib/distribution');
const afterPack = require('../scripts/after-pack');

const SIGNED = { signing: 'developer-id', identity: 'Developer ID Application: A. Researcher (AB12CD34EF)', teamId: 'AB12CD34EF', notaryProfile: 'research-harness-notary', releases: 'example-owner/placet-research' };

function file(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-dist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'distribution.json');
  fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}

test('the committed switch is "none"', () => {
  assert.deepEqual(readDistribution(DIST_FILE), { signing: 'none' });
});

test('a developer-id file with all five fields is read as it is', (t) => {
  assert.deepEqual(readDistribution(file(t, SIGNED)), SIGNED);
});

for (const [name, content, pattern] of [
  ['not JSON', '{ signing: none', /not readable JSON/],
  ['an array', [], /one JSON object/],
  ['an unknown mode', { signing: 'adhoc' }, /"none" or "developer-id"/],
  ['an extra field in none mode', { signing: 'none', identity: 'x' }, /unknown field "identity"/],
  ['a pasted password', { ...SIGNED, password: 'abcd-efgh-ijkl-mnop' }, /unknown field "password".*keychain/],
  ['a missing notary profile', { ...SIGNED, notaryProfile: '' }, /"notaryProfile" is missing/],
  ['a short team ID', { ...SIGNED, teamId: 'AB12', identity: 'Developer ID Application: A (AB12)' }, /10-character team ID/],
  ['an identity without the prefix', { ...SIGNED, identity: 'A. Researcher (AB12CD34EF)' }, /Developer ID Application: <name> \(AB12CD34EF\)/],
  ['an identity of another team', { ...SIGNED, identity: 'Developer ID Application: A. Researcher (ZZ99ZZ99ZZ)' }, /\(AB12CD34EF\)/],
  ['a profile name with a space', { ...SIGNED, notaryProfile: 'my profile' }, /letters, digits/],
  ['a missing release repository', { ...SIGNED, releases: '' }, /"releases" is missing/],
  ['a release repository without an owner', { ...SIGNED, releases: 'placet-research' }, /"releases" must read "<owner>\/<repository>"/],
  ['a release repository given as a link', { ...SIGNED, releases: 'https://github.com/example-owner/placet-research' }, /"releases" must read/],
]) {
  test(`refuses ${name}`, (t) => {
    assert.throws(() => readDistribution(file(t, content)), (err) => err instanceof DistributionError && pattern.test(err.message));
  });
}

test('none: ad-hoc with hardened runtime, no notarization, no publishing, no Apple variables', () => {
  const { config, env } = builderSettings({ signing: 'none' }, { version: '0.6.0', keep: [], outDir: '/tmp/out' });
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.match(config.mac.entitlements, /entitlements\.adhoc\.plist$/);
  assert.match(config.mac.entitlementsInherit, /entitlements\.adhoc\.plist$/);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.publish, null);
  assert.deepEqual(config.extraMetadata, { version: '0.6.0', harnessSigning: 'none' });
  assert.equal(config.directories.output, '/tmp/out');
  assert.equal(config.appId, 'org.research-harness.desktop');
  assert.equal(config.productName, 'Placet');
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('APPLE_')), []);
});

test('a second build gets fresh patterns, not the ones electron-builder rewrote in place', () => {
  const first = builderSettings({ signing: 'none' }, { version: '0.6.0', keep: [], outDir: '/o' }).config;
  first.files[0] = { filter: ['main.js'] };
  const second = builderSettings({ signing: 'none' }, { version: '0.6.0', keep: [], outDir: '/o' }).config;
  assert.deepEqual(second.files, ['main.js', 'preload.js', 'server.js', 'git-path.js', 'updater.js', 'package.json', 'agent/**', '!agent/shims/**']);
});

test('developer-id: identity without prefix, notarization, GitHub feed, keychain profile only in env', () => {
  const { config, env } = builderSettings(SIGNED, { version: '0.6.0', keep: [], outDir: '/tmp/out', keychain: '/k/login.keychain-db' });
  assert.equal(config.mac.identity, 'A. Researcher (AB12CD34EF)');
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.match(config.mac.entitlements, /entitlements\.mac\.plist$/);
  assert.deepEqual(config.publish, [{ provider: 'github', owner: 'example-owner', repo: 'placet-research', releaseType: 'release' }]);
  assert.deepEqual(config.extraMetadata, { version: '0.6.0', harnessSigning: 'developer-id' });
  assert.deepEqual(env, { APPLE_KEYCHAIN: '/k/login.keychain-db', APPLE_KEYCHAIN_PROFILE: 'research-harness-notary' });
  assert.ok(!JSON.stringify(config).includes('research-harness-notary'), 'the profile name stays out of the config');
});

test('file names: DMG without version, zip with version, both with the processor', () => {
  const { config } = builderSettings({ signing: 'none' }, { version: '0.6.0', keep: [], outDir: '/o' });
  assert.equal(config.dmg.artifactName, 'research-harness-mac-${arch}.${ext}');
  assert.equal(config.mac.artifactName, 'research-harness-${version}-mac-${arch}.${ext}');
});

test('kept signatures become anchored, escaped signIgnore patterns', () => {
  const keep = ['libexec/git-core/git-credential-manager', 'libexec/git-core/libcoreclr.dylib'];
  const { config } = builderSettings({ signing: 'none' }, { version: '0.6.0', keep, outDir: '/o' });
  assert.deepEqual(config.mac.signIgnore, ['/node_modules/dugite/git/libexec/git-core/git-credential-manager$', '/node_modules/dugite/git/libexec/git-core/libcoreclr\\.dylib$']);
  const inApp = '/x/Placet.app/Contents/Resources/app.asar.unpacked/node_modules/dugite/git/libexec/git-core/libcoreclr.dylib';
  assert.match(inApp, new RegExp(config.mac.signIgnore[1]));
  assert.doesNotMatch(inApp.replace('libcoreclr.dylib', 'libcoreclrXdylib'), new RegExp(config.mac.signIgnore[1]));
});

test('preflight: none asks nothing; developer-id names each missing piece', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return cmd === 'security'
      ? { status: 0, stdout: '  1) ABC "Developer ID Application: Someone Else (ZZ99ZZ99ZZ)"\n', stderr: '' }
      : { status: 69, stdout: '', stderr: 'No Keychain password item found for profile' };
  };
  assert.deepEqual(preflight({ signing: 'none' }, { run }), []);
  assert.equal(calls.length, 0);
  const problems = preflight(SIGNED, { run, keychain: '/k' });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"Developer ID Application: A\. Researcher \(AB12CD34EF\)" is not in this Mac's keychain/);
  assert.match(problems[1], /"research-harness-notary" does not work/);
  assert.deepEqual(calls, ['security find-identity -v -p codesigning', 'xcrun notarytool history --keychain-profile research-harness-notary --keychain /k']);
});

test('preflight passes when certificate and profile are there', () => {
  const run = (cmd) => (cmd === 'security'
    ? { status: 0, stdout: `  1) ABC "${SIGNED.identity}"\n     1 valid identities found\n`, stderr: '' }
    : { status: 0, stdout: 'No submission history.\n', stderr: '' });
  assert.deepEqual(preflight(SIGNED, { run }), []);
});

// electron-builder 26 leaves dugite's `.dll` files out of the app on macOS, so
// the packed app is missing what the credential manager loads. scripts/after-pack.js
// copies them back from the installed package.
function packedTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-after-pack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectDir = path.join(dir, 'desktop');
  const git = path.join(projectDir, 'node_modules', 'dugite', 'git');
  const appOutDir = path.join(dir, 'dist', 'mac-arm64');
  const resources = path.join(appOutDir, 'Placet.app', 'Contents', 'Resources');
  return {
    git,
    packed: path.join(resources, 'app.asar.unpacked', 'node_modules', 'dugite', 'git'),
    context: { appOutDir, packager: { projectDir, getResourcesDir: () => resources } },
  };
}

test('the builder settings name the hook that puts dugite\'s dropped files back', () => {
  const { config } = builderSettings({ signing: 'none' }, { version: '0.6.0', keep: [], outDir: '/o' });
  assert.equal(config.afterPack, require.resolve('../scripts/after-pack'));
});

test('after-pack puts back what electron-builder left out, mode included, and leaves what it packed alone', async (t) => {
  const { git, packed, context } = packedTree(t);
  fs.mkdirSync(path.join(git, 'libexec', 'git-core'), { recursive: true });
  fs.mkdirSync(path.join(packed, 'libexec', 'git-core'), { recursive: true });
  fs.mkdirSync(path.join(git, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packed, 'bin'), { recursive: true });
  const dll = path.join(git, 'libexec', 'git-core', 'git-credential-manager.dll');
  fs.writeFileSync(dll, 'Microsoft .NET assembly');
  fs.chmodSync(dll, 0o444);                       // copyFileSync alone would leave 0644 here
  fs.writeFileSync(path.join(git, 'libexec', 'git-core', 'git-credential-manager'), 'apphost');
  fs.writeFileSync(path.join(packed, 'libexec', 'git-core', 'git-credential-manager'), 'apphost');
  fs.writeFileSync(path.join(git, 'bin', 'git'), 'the installed one');
  fs.writeFileSync(path.join(packed, 'bin', 'git'), 'the packed one');

  await afterPack(context);

  const copied = path.join(packed, 'libexec', 'git-core', 'git-credential-manager.dll');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'Microsoft .NET assembly');
  assert.equal(fs.statSync(copied).mode & 0o777, 0o444);
  assert.equal(fs.readFileSync(path.join(packed, 'bin', 'git'), 'utf8'), 'the packed one');
});

test('after-pack refuses when dugite is not unpacked', async (t) => {
  const { git, context } = packedTree(t);
  fs.mkdirSync(git, { recursive: true });
  await assert.rejects(afterPack(context), /app\.asar\.unpacked.*does not exist/);
});
