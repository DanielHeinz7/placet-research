'use strict';
// The switch between local ad-hoc builds and Developer ID builds (spec 4.1),
// and what it means for electron-builder. desktop/distribution.json holds
// nothing secret: a certificate's name, a team ID and the name of a notarytool
// keychain profile. The private key and the notarization password stay in the
// login keychain of the release Mac.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST_FILE = path.join(ROOT, 'distribution.json');
const LOGIN_KEYCHAIN = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
const PREFIX = 'Developer ID Application: ';
const FIELDS = { none: ['signing'], 'developer-id': ['signing', 'identity', 'teamId', 'notaryProfile', 'releases'] };
// GitHub's rules for an account and a repository name.
const RELEASES = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const RUNBOOK = 'docs/desktop-signing.md';

// What electron-builder.yml held when this sub-project replaced it with this
// file, except the name: an app program called placet-research looks like the
// CLI to the plugin's guard, which then refuses the rest of the line. The
// agent's own files, the shims and node-pty come from sub-project 2's
// packaging; they moved here when Task 4 deleted the yml.
const BASE = {
  appId: 'org.research-harness.desktop',
  productName: 'Placet',
  files: ['main.js', 'preload.js', 'server.js', 'git-path.js', 'updater.js', 'package.json', 'agent/**', '!agent/shims/**'],
  extraResources: [
    { from: 'build/plugin', to: 'plugin' },
    { from: 'askpass.sh', to: 'askpass.sh' },
    { from: 'agent/shims', to: 'shims' },
  ],
  // The agent SDK's Claude Code binary is a program the app starts, so it stays
  // outside app.asar like dugite's git; agent/sdk/binary.js looks for it under
  // app.asar.unpacked.
  asarUnpack: ['node_modules/dugite/**', 'node_modules/node-pty/**', 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/**'],
  // electron-builder 26 drops dugite's `.dll` files on macOS, and the credential
  // manager does not start without them; see scripts/after-pack.js.
  afterPack: path.join(ROOT, 'scripts', 'after-pack.js'),
};

// The agent SDK ships its Claude Code binary as one package per processor, and
// npm installs only this Mac's. scripts/dist.js fetches the package for the
// processor it is building; the packages for the others stay out of the app.
const PROCESSORS = ['arm64', 'x64'];

function agentBinaryExcludes(arch) {
  return PROCESSORS.filter((p) => p !== arch).map((p) => `!node_modules/@anthropic-ai/claude-agent-sdk-darwin-${p}/**`);
}

class DistributionError extends Error {}

function readDistribution(file = DIST_FILE) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new DistributionError(`${file} is not readable JSON: ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DistributionError(`${file} must hold one JSON object.`);
  const allowed = FIELDS[raw.signing];
  if (!allowed) throw new DistributionError(`${file}: "signing" must be "none" or "developer-id".`);
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new DistributionError(`${file}: unknown field "${key}" for signing "${raw.signing}". Secrets belong in the keychain, never in this file.`);
  }
  for (const key of allowed) {
    if (typeof raw[key] !== 'string' || raw[key].trim() === '') throw new DistributionError(`${file}: "${key}" is missing.`);
  }
  if (raw.signing === 'developer-id') {
    if (!/^[A-Z0-9]{10}$/.test(raw.teamId)) throw new DistributionError(`${file}: "teamId" must be the 10-character team ID.`);
    if (!raw.identity.startsWith(PREFIX) || !raw.identity.endsWith(` (${raw.teamId})`)) {
      throw new DistributionError(`${file}: "identity" must read "Developer ID Application: <name> (${raw.teamId})", as Keychain Access shows it.`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(raw.notaryProfile)) throw new DistributionError(`${file}: "notaryProfile" may hold letters, digits, dot, dash and underscore only.`);
    if (!RELEASES.test(raw.releases)) throw new DistributionError(`${file}: "releases" must read "<owner>/<repository>", the GitHub repository the updates are published to.`);
  }
  return raw;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `arch` is the processor this build is for. With one, the app carries the agent
// SDK's binary for that processor only; without one, the settings leave the
// packages node_modules holds alone.
function builderSettings(dist, { version, keep, outDir, arch, keychain = LOGIN_KEYCHAIN }) {
  const signed = dist.signing === 'developer-id';
  const entitlements = path.join(ROOT, signed ? 'entitlements.mac.plist' : 'entitlements.adhoc.plist');
  // electron-builder rewrites config.files in place, replacing the patterns
  // with objects; a copy keeps BASE whole for the second processor, whose
  // build would otherwise read `.from` on the nulls it left behind.
  const config = {
    ...structuredClone(BASE),
    files: [...BASE.files, ...(arch ? agentBinaryExcludes(arch) : [])],
    directories: { output: outDir },
    extraMetadata: { version, harnessSigning: dist.signing },
    mac: {
      // ${version}, ${arch} and ${ext} are electron-builder's macros, not template literals.
      artifactName: 'research-harness-${version}-mac-${arch}.${ext}',
      // electron-builder 26 refuses the "Developer ID Application: " prefix.
      identity: signed ? dist.identity.slice(PREFIX.length) : '-',
      hardenedRuntime: true,
      entitlements,
      entitlementsInherit: entitlements,
      signIgnore: keep.map((rel) => `${escapeRegex(`/node_modules/dugite/git/${rel}`)}$`),
      notarize: signed,
    },
    dmg: { artifactName: 'research-harness-mac-${arch}.${ext}' },
    publish: signed ? [{ provider: 'github', owner: dist.releases.split('/')[0], repo: dist.releases.split('/')[1], releaseType: 'release' }] : null,
  };
  // electron-builder 26 notarizes with a keychain profile when both are set.
  const env = signed
    ? { APPLE_KEYCHAIN: keychain, APPLE_KEYCHAIN_PROFILE: dist.notaryProfile }
    : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  return { config, env };
}

function runTool(cmd, args, opts = {}) {
  const r = childProcess.spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? r.error.message : '') };
}

// Before a developer-id build: are the certificate and the notarization
// profile on this Mac? Both are looked up by name; neither secret is read.
function preflight(dist, { run = runTool, keychain = LOGIN_KEYCHAIN } = {}) {
  if (dist.signing !== 'developer-id') return [];
  const problems = [];
  const ids = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (ids.status !== 0 || !ids.stdout.includes(`"${dist.identity}"`)) {
    problems.push(`The certificate "${dist.identity}" is not in this Mac's keychain (security find-identity -v -p codesigning). See ${RUNBOOK}, "Certificate".`);
  }
  const notary = run('xcrun', ['notarytool', 'history', '--keychain-profile', dist.notaryProfile, '--keychain', keychain]);
  if (notary.status !== 0) {
    problems.push(`The notarization profile "${dist.notaryProfile}" does not work (xcrun notarytool history). See ${RUNBOOK}, "Notarization".`);
  }
  return problems;
}

module.exports = { readDistribution, builderSettings, preflight, runTool, DistributionError, DIST_FILE, LOGIN_KEYCHAIN, BASE };
