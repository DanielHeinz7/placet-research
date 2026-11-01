'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appIn, notaryHint } = require('../scripts/dist');
const { builderSettings } = require('../lib/distribution');

const DIST = path.join(__dirname, '..', 'scripts', 'dist.js');

function stubs(t, scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-diststub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

test('wrong arguments: exit 2 before anything is built', () => {
  const r = childProcess.spawnSync(process.execPath, [DIST, '--arch', 'ppc'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: node scripts\/dist\.js \[--arch arm64\|x64\]/);
});

test('developer-id without certificate and profile: exit 2, both named, nothing built', (t) => {
  const bin = stubs(t, { security: 'echo "     0 valid identities found"', xcrun: 'echo "No Keychain password item found" >&2; exit 69' });
  const switchFile = path.join(bin, 'distribution.json');
  fs.writeFileSync(switchFile, JSON.stringify({ signing: 'developer-id', identity: 'Developer ID Application: A. Researcher (AB12CD34EF)', teamId: 'AB12CD34EF', notaryProfile: 'research-harness-notary', releases: 'example-owner/placet-research' }));
  const before = fs.existsSync(path.join(__dirname, '..', 'dist', 'arm64')) ? fs.statSync(path.join(__dirname, '..', 'dist', 'arm64')).mtimeMs : null;
  const r = childProcess.spawnSync(process.execPath, [DIST], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLACET_RESEARCH_TEST_DISTRIBUTION: switchFile } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not in this Mac's keychain/);
  assert.match(r.stderr, /"research-harness-notary" does not work/);
  const after = fs.existsSync(path.join(__dirname, '..', 'dist', 'arm64')) ? fs.statSync(path.join(__dirname, '..', 'dist', 'arm64')).mtimeMs : null;
  assert.equal(after, before);
});

test('a rejected notarization names the command that shows Apple\'s log', () => {
  const signed = { signing: 'developer-id', notaryProfile: 'research-harness-notary' };
  const msg = 'Failed to notarize via notarytool\n\nid: 2efe2717-52ef-43a5-96dc-0797e4ca1041\nstatus: Invalid';
  assert.match(notaryHint(msg, signed), /xcrun notarytool log 2efe2717-52ef-43a5-96dc-0797e4ca1041 --keychain-profile research-harness-notary$/);
  assert.equal(notaryHint(msg, { signing: 'none' }), msg);
  assert.equal(notaryHint('ENOSPC: no space left on device', signed), 'ENOSPC: no space left on device');
});

test('a build carries the agent binary for its own processor only', () => {
  const filesFor = (arch) => builderSettings({ signing: 'none' }, { version: '0.6.0', keep: [], outDir: '/nowhere', arch }).config.files;
  const agent = (files) => files.filter((f) => f.includes('claude-agent-sdk'));
  assert.deepEqual(agent(filesFor('x64')), ['!node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**']);
  assert.deepEqual(agent(filesFor('arm64')), ['!node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/**']);
});

test('appIn finds the app in mac-arm64/ and in mac/', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-appin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'arm64', 'mac-arm64', 'Placet.app'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'x64', 'mac', 'Placet.app'), { recursive: true });
  assert.equal(appIn(path.join(dir, 'arm64')), path.join(dir, 'arm64', 'mac-arm64', 'Placet.app'));
  assert.equal(appIn(path.join(dir, 'x64')), path.join(dir, 'x64', 'mac', 'Placet.app'));
  assert.throws(() => appIn(dir), /no Placet\.app under/);
});
