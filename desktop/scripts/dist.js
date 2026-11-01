#!/usr/bin/env node
'use strict';
// Builds the app for Apple silicon and Intel, signed as desktop/distribution.json
// says, checks each build, and collects what a release uploads in
// dist/release/ (spec 4.2).
//
//   node scripts/dist.js [--arch arm64|x64]
//
// Exit 0 done, 1 a build or a check failed, 2 refused before building.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDistribution, builderSettings, preflight, runTool, DistributionError } = require('../lib/distribution');
const { keepList } = require('../lib/macho');
const { verifyApp } = require('../lib/verify');
const { mergeFeeds } = require('../lib/update-feed');

const ROOT = path.join(__dirname, '..');
const DUGITE = path.dirname(require.resolve('dugite/package.json'));
const SDK = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const SDK_MODULES = path.dirname(path.dirname(SDK));
const PLUGIN_JSON = path.join(ROOT, '..', 'plugins', 'placet-research', '.claude-plugin', 'plugin.json');
const RELEASE = path.join(ROOT, 'dist', 'release');
const ROSETTA = '/Library/Apple/usr/share/rosetta/rosetta';
const USAGE = 'usage: node scripts/dist.js [--arch arm64|x64]';

function refuse(msg) {
  console.error(`dist: refused: ${msg}`);
  process.exit(2);
}

// dugite keeps one git, for one processor, in its own folder. With no arch it
// fetches the git for this Mac again.
function fetchGit(arch) {
  const env = { ...process.env };
  if (arch) env.npm_config_arch = arch;
  else delete env.npm_config_arch;
  const r = runTool(process.execPath, [path.join(DUGITE, 'script', 'download-git.js')], { env, cwd: DUGITE });
  if (r.status !== 0) throw new Error(`fetching git${arch ? ` for ${arch}` : ''} failed: ${(r.stderr || r.stdout).trim()}`);
}

// The agent SDK keeps its Claude Code binary in one package per processor, and
// npm installs only this Mac's. Like fetchGit, the build for another processor
// needs its own: the package is unpacked into node_modules, where the app looks
// for the binary (agent/sdk/binary.js). Already there means nothing to do.
function fetchAgentBinary(arch) {
  const name = `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  const dir = path.join(SDK_MODULES, '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`);
  if (fs.existsSync(dir)) return;
  const version = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8')).optionalDependencies?.[name];
  if (!version) throw new Error(`${name} is not one of the SDK's packages; run npm ci in ${ROOT}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-agent-binary-'));
  try {
    const pack = runTool('npm', ['pack', `${name}@${version}`, '--pack-destination', tmp], { cwd: ROOT });
    if (pack.status !== 0) throw new Error(`fetching ${name}@${version} failed: ${(pack.stderr || pack.stdout).trim()}`);
    const tarball = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error(`npm pack ${name}@${version} wrote no tarball`);
    fs.mkdirSync(dir, { recursive: true });
    const unpack = runTool('tar', ['-xzf', path.join(tmp, tarball), '-C', dir, '--strip-components=1']);
    if (unpack.status !== 0) throw new Error(`unpacking ${name}@${version} failed: ${(unpack.stderr || unpack.stdout).trim()}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A rejected notarization names its submission; Apple's log says why.
function notaryHint(message, dist) {
  const id = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.exec(message);
  if (dist.signing !== 'developer-id' || !id) return message;
  return `${message}\nApple's log for submission ${id[0]}: xcrun notarytool log ${id[0]} --keychain-profile ${dist.notaryProfile}`;
}

function appIn(dir) {
  for (const sub of fs.readdirSync(dir)) {
    const app = path.join(dir, sub, 'Placet.app');
    if (sub.startsWith('mac') && fs.existsSync(app)) return app;
  }
  throw new Error(`no Placet.app under ${dir}`);
}

async function buildOne(dist, arch, version) {
  const builder = require('electron-builder');
  fetchGit(arch);
  fetchAgentBinary(arch);
  const outDir = path.join(ROOT, 'dist', arch);
  fs.rmSync(outDir, { recursive: true, force: true });
  const { config, env } = builderSettings(dist, { version, keep: keepList(path.join(DUGITE, 'git')), outDir, arch });
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    await builder.build({ projectDir: ROOT, targets: builder.Platform.MAC.createTarget(['dmg', 'zip'], builder.Arch[arch]), config, publish: 'never' });
  } catch (err) {
    err.message = notaryHint(err.message, dist);
    throw err;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return outDir;
}

function collect(dist, outDirs) {
  fs.rmSync(RELEASE, { recursive: true, force: true });
  fs.mkdirSync(RELEASE, { recursive: true });
  const feeds = [];
  for (const dir of Object.values(outDirs)) {
    for (const name of fs.readdirSync(dir)) {
      if (/\.(dmg|zip|blockmap)$/.test(name)) fs.copyFileSync(path.join(dir, name), path.join(RELEASE, name));
      if (name === 'latest-mac.yml') feeds.push(fs.readFileSync(path.join(dir, name), 'utf8'));
    }
  }
  if (dist.signing === 'developer-id') {
    if (feeds.length !== Object.keys(outDirs).length) throw new Error(`expected one latest-mac.yml per processor, found ${feeds.length}`);
    fs.writeFileSync(path.join(RELEASE, 'latest-mac.yml'), mergeFeeds(feeds));
  }
  console.log(`dist: ${fs.readdirSync(RELEASE).length} files in ${RELEASE}`);
}

async function main(argv) {
  const only = argv[0] === '--arch' ? argv[1] : null;
  if (argv.length && !(argv.length === 2 && ['arm64', 'x64'].includes(only))) refuse(USAGE);
  let dist;
  try {
    dist = readDistribution(process.env.PLACET_RESEARCH_TEST_DISTRIBUTION || undefined);
  } catch (err) {
    if (err instanceof DistributionError) refuse(err.message);
    throw err;
  }
  const missing = preflight(dist);
  if (missing.length) refuse(missing.join(' '));
  if (dist.signing === 'developer-id' && only) refuse('a developer-id build makes both processors, so that the update feed lists both');

  const version = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
  const bundle = runTool(process.execPath, [path.join(ROOT, 'scripts', 'bundle-plugin.js')]);
  if (bundle.status !== 0) throw new Error(`bundling the plugin failed: ${bundle.stderr.trim()}`);

  const outDirs = {};
  let failed = 0;
  try {
    for (const arch of only ? [only] : ['arm64', 'x64']) {
      outDirs[arch] = await buildOne(dist, arch, version);
      const rosetta = process.arch === arch || fs.existsSync(ROSETTA);
      const { problems, notes } = verifyApp(appIn(outDirs[arch]), { dist, arch, rosetta });
      for (const n of notes) console.log(`${arch}: note: ${n}`);
      for (const p of problems) console.error(`${arch}: problem: ${p}`);
      failed += problems.length;
    }
  } finally {
    fetchGit(null); // leave this Mac's own git for npm start and the tests
  }
  if (failed) {
    console.error(`dist: ${failed} problem(s); nothing was collected in dist/release`);
    return 1;
  }
  collect(dist, outDirs);
  return 0;
}

module.exports = { appIn, notaryHint };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`dist: ${err.message}`); process.exitCode = 1; },
  );
}
