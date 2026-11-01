'use strict';
// Checks one built app before anything can be published (spec 4.3).
const fs = require('node:fs');
const path = require('node:path');
const { machOFiles, signature } = require('./macho');
const { runTool } = require('./distribution');

const FILE_ARCH = { arm64: 'arm64', x64: 'x86_64' };
const DEVELOPER_ID = 'Developer ID Application: ';

function gitDir(app) {
  return path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'dugite', 'git');
}

// The agent SDK's Claude Code binary, the program the app starts as its own
// agent; agent/sdk/binary.js looks for it under app.asar.unpacked. The SDK
// ships one package per processor, and scripts/dist.js fetches the one for the
// processor it is building, so the folder named here has to hold this build's.
function agentBinary(app, arch) {
  return path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`, 'claude');
}

// The environment desktop/main.js gives the bundled git.
function gitEnv(dir) {
  return { ...process.env, GIT_EXEC_PATH: path.join(dir, 'libexec', 'git-core'), GIT_CONFIG_SYSTEM: path.join(dir, 'etc', 'gitconfig'), GIT_TEMPLATE_DIR: path.join(dir, 'share', 'git-core', 'templates') };
}

const firstLine = (text) => text.trim().split('\n')[0];

// node-pty's spawn-helper and pty.node for this build's own processor
// (sub-project 2's packaging). node-pty ships prebuilds for other processors
// and platforms as well and the build carries them all; only the folder named
// after this build's processor has to hold this build's binaries. Empty when
// the module is not in the build.
function nodePtyBinaries(app, arch) {
  const dir = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', `darwin-${arch}`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name === 'spawn-helper' || entry.name === 'pty.node'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

// The agent starts through these two shims; both have to be executable.
const SHIMS = ['node', 'git'];

function verifyApp(app, { dist, arch, run = runTool, rosetta = true }) {
  const problems = [];
  const notes = [];
  const signed = dist.signing === 'developer-id';

  const seal = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  if (seal.status !== 0) problems.push(`codesign --verify failed: ${(seal.stderr || seal.stdout).trim().split('\n').pop()}`);

  const kept = {};
  for (const file of machOFiles(app)) {
    const rel = path.relative(app, file);
    const sig = signature(file, run);
    if (!sig.signed) { problems.push(`${rel} is not signed`); continue; }
    if (!sig.runtime) problems.push(`${rel} has no hardened runtime`);
    if (!signed) continue;
    if (sig.adhoc) { problems.push(`${rel} is only ad-hoc signed`); continue; }
    if (!sig.timestamp) problems.push(`${rel} has no secure timestamp`);
    if (sig.team === dist.teamId) continue;
    if (sig.authority && sig.authority.startsWith(DEVELOPER_ID)) kept[sig.team] = (kept[sig.team] || 0) + 1;
    else problems.push(`${rel} is signed by team ${sig.team || 'none'}, not ${dist.teamId}`);
  }
  for (const [team, n] of Object.entries(kept)) notes.push(`kept ${n} file(s) signed by team ${team}`);

  for (const file of nodePtyBinaries(app, arch)) {
    const kind = run('file', ['-b', file]);
    if (!kind.stdout.includes(FILE_ARCH[arch])) problems.push(`${path.relative(app, file)} is not built for ${arch}: ${firstLine(kind.stdout)}`);
  }
  // Unlike node-pty, a build that carries no agent binary at all is the fault
  // this check is here for; the package's own name carries the processor, so
  // file's error text cannot be asked which processor it is.
  const agent = agentBinary(app, arch);
  if (!fs.existsSync(agent)) {
    problems.push(`${path.relative(app, agent)} is missing: this build carries no agent binary for ${arch}`);
  } else {
    const kind = run('file', ['-b', agent]);
    if (!kind.stdout.includes(FILE_ARCH[arch])) problems.push(`${path.relative(app, agent)} is not built for ${arch}: ${firstLine(kind.stdout)}`);
  }
  for (const name of SHIMS) {
    const file = path.join(app, 'Contents', 'Resources', 'shims', name);
    if (!fs.existsSync(file)) continue;
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o755) problems.push(`${path.join('Contents', 'Resources', 'shims', name)} has mode ${mode.toString(8)}, not 755`);
  }

  const git = path.join(gitDir(app), 'bin', 'git');
  const kind = run('file', ['-b', git]);
  if (!kind.stdout.includes(FILE_ARCH[arch])) problems.push(`the bundled git is not built for ${arch}: ${firstLine(kind.stdout)}`);
  if (rosetta) {
    const env = gitEnv(gitDir(app));
    const version = run(git, ['--version'], { env });
    if (version.status !== 0) problems.push(`the bundled git does not start: ${firstLine(version.stderr || version.stdout)}`);
    const gcm = run(git, ['credential-manager', '--version'], { env });
    if (gcm.status !== 0) problems.push(`the credential manager does not start: ${firstLine(gcm.stderr || gcm.stdout)}`);
  } else {
    notes.push(`git not started: ${arch} build on a Mac without Rosetta`);
  }

  const assess = run('spctl', ['--assess', '--type', 'execute', '-vv', app]);
  const said = `${assess.stdout}${assess.stderr}`.trim().split('\n').join(' ');
  if (signed) {
    if (run('xcrun', ['stapler', 'validate', app]).status !== 0) problems.push('no stapled notarization ticket (xcrun stapler validate)');
    if (!/source=Notarized Developer ID/.test(said)) problems.push(`Gatekeeper does not accept the app: ${said}`);
  } else {
    if (assess.status === 0) problems.push(`Gatekeeper accepts a build whose signing is none: ${said}`);
    notes.push('signing is none: this build is for local tests and cannot be published');
  }
  return { problems, notes };
}

module.exports = { verifyApp, gitDir };
