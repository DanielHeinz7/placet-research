'use strict';

// SQ-116. Two doors onto one program. The bare command `bin/placet-research`
// is what a session can call, because Claude Code puts this plugin's bin/ on the
// Bash tool's PATH — and nowhere else. The researcher's own terminal is reached
// by `install-cli`, which writes a shim that resolves the plugin directory at
// every run. Every test here keeps its own HOME and CLAUDE_CONFIG_DIR: the real
// ~/.local/bin and ~/.claude are never written to.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const bare = path.join(pluginRoot, 'bin', 'placet-research');
// The shim runs `node`, so the PATH a test hands it must still find this one.
const nodeDir = path.dirname(process.execPath);
const MARKER = '# placet-research install-cli shim';
const NOT_INSTALLED = 'placet-research: the plugin is not installed for Claude Code; install it with /plugin install placet-research@placet-research.';

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A config directory of this test's own. `entries === undefined` leaves
// installed_plugins.json absent, which is Claude Code before the plugin is
// installed at all.
function configDirWith(entries) {
  const dir = scratch('rh-cli-config-');
  if (entries !== undefined) {
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'placet-research@placet-research': entries } }),
    );
  }
  return dir;
}

function entry(installPath) {
  return [{ scope: 'user', installPath, version: '0.0.0', installedAt: '2026-01-01T00:00:00.000Z' }];
}

function cleanEnv(env) {
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  return { ...ambient, ...env };
}

// install-cli is run from a directory that is no paper project: it must not
// need one. `--dir` and HOME are always given, so nothing here can reach the
// machine's own ~/.local/bin.
function runCli(args, env) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: scratch('rh-cli-cwd-'),
    env: cleanEnv({ CLAUDE_PLUGIN_ROOT: pluginRoot, PATH: nodeDir, ...env }),
    encoding: 'utf8',
  });
}

function runShim(shim, args, env) {
  return childProcess.spawnSync(shim, args, {
    env: cleanEnv({ PATH: nodeDir, ...env }),
    encoding: 'utf8',
  });
}

// What install-cli prints: the path it wrote, then whether that directory is
// one the terminal would already look in.
function installOutput(bin, onPath) {
  const tail = onPath
    ? `${bin} is on PATH.\n`
    : `${bin} is not on PATH. Add this line to ~/.zshrc:\nexport PATH="${bin}:$PATH"\n`;
  return `Wrote ${path.join(bin, 'placet-research')}.\n${tail}`;
}

test('the bare command is executable and hands the CLI its argv, exit code and output', () => {
  const mode = fs.statSync(bare).mode;
  assert.notEqual(mode & 0o111, 0, `${bare} must be executable`);
  assert.equal(path.basename(bare), 'placet-research', 'the bare command carries no extension');

  for (const args of [['--help'], ['nope']]) {
    const through = childProcess.spawnSync(bare, args, { cwd: pluginRoot, encoding: 'utf8' });
    const direct = childProcess.spawnSync(process.execPath, [cli, ...args], { cwd: pluginRoot, encoding: 'utf8' });
    assert.equal(through.stdout, direct.stdout, args.join(' '));
    assert.equal(through.stderr, direct.stderr, args.join(' '));
    assert.equal(through.status, direct.status, args.join(' '));
  }
  assert.match(childProcess.spawnSync(bare, ['--help'], { cwd: pluginRoot, encoding: 'utf8' }).stdout, /^placet-research init --project /);
});

test('install-cli writes a shim into --dir and it runs the CLI from the install path', () => {
  const home = scratch('rh-cli-home-');
  const config = configDirWith(entry(pluginRoot));
  const bin = path.join(scratch('rh-cli-bin-'), 'bin');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config };

  const out = runCli(['install-cli', '--dir', bin], env);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.stdout, installOutput(bin, false));
  assert.doesNotMatch(out.stdout, /not a paper project/, 'install-cli must not need a paper project');

  const shim = path.join(bin, 'placet-research');
  assert.notEqual(fs.statSync(shim).mode & 0o111, 0, 'the shim must be executable');
  assert.match(fs.readFileSync(shim, 'utf8'), new RegExp(MARKER));

  const viaShim = runShim(shim, ['--help'], env);
  assert.equal(viaShim.status, 0, viaShim.stdout + viaShim.stderr);
  assert.match(viaShim.stdout, /^placet-research init --project /);

  // A second run rewrites its own shim rather than refusing it.
  const again = runCli(['install-cli', '--dir', bin], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, installOutput(bin, false));
});

test('install-cli with no --dir writes into the home directory it is given', () => {
  const home = scratch('rh-cli-home-');
  const bin = path.join(home, '.local', 'bin');
  const out = runCli(['install-cli'], { HOME: home, CLAUDE_CONFIG_DIR: configDirWith(entry(pluginRoot)) });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.stdout, installOutput(bin, false));
  assert.ok(fs.existsSync(path.join(bin, 'placet-research')));
});

test('install-cli says what to add when --dir is not on PATH, and stops saying it once it is', () => {
  const home = scratch('rh-cli-home-');
  const bin = path.join(scratch('rh-cli-bin-'), 'bin');
  const earlier = scratch('rh-cli-elsewhere-');
  const config = configDirWith(entry(pluginRoot));
  const out = runCli(['install-cli', '--dir', bin], { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: `${nodeDir}${path.delimiter}${earlier}` });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.stdout, installOutput(bin, false));

  const onPath = runCli(['install-cli', '--dir', bin], { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: [nodeDir, bin, earlier].join(path.delimiter) });
  assert.equal(onPath.status, 0, onPath.stdout + onPath.stderr);
  assert.equal(onPath.stdout, installOutput(bin, true));
});

test('the shim resolves the plugin directory at every run, not at install time', () => {
  const home = scratch('rh-cli-home-');
  const config = configDirWith(entry(pluginRoot));
  const bin = path.join(scratch('rh-cli-bin-'), 'bin');
  assert.equal(runCli(['install-cli', '--dir', bin], { HOME: home, CLAUDE_CONFIG_DIR: config }).status, 0);
  const shim = path.join(bin, 'placet-research');
  assert.match(runShim(shim, ['--help'], { HOME: home, CLAUDE_CONFIG_DIR: config }).stdout, /^placet-research init --project /);

  // A second installation of the plugin, as a version update leaves behind. It
  // answers with its own words, so the shim's output says which one ran.
  const second = scratch('rh-cli-plugin-');
  fs.mkdirSync(path.join(second, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(second, 'bin', 'placet-research.js'), "process.stdout.write('the second install\\n');\n");
  fs.writeFileSync(
    path.join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'placet-research@placet-research': entry(second) } }),
  );
  const after = runShim(shim, ['--help'], { HOME: home, CLAUDE_CONFIG_DIR: config });
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.equal(after.stdout, 'the second install\n');

  // Several entries: the first whose installPath exists is the one that runs.
  fs.writeFileSync(
    path.join(config, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'placet-research@placet-research': [...entry(path.join(scratch('rh-cli-gone-'), 'nowhere')), ...entry(second)] } }),
  );
  assert.equal(runShim(shim, ['--help'], { HOME: home, CLAUDE_CONFIG_DIR: config }).stdout, 'the second install\n');
});

test('the shim says the plugin is not installed and exits 1', () => {
  const home = scratch('rh-cli-home-');
  const bin = path.join(scratch('rh-cli-bin-'), 'bin');
  const config = configDirWith(entry(pluginRoot));
  assert.equal(runCli(['install-cli', '--dir', bin], { HOME: home, CLAUDE_CONFIG_DIR: config }).status, 0);
  const shim = path.join(bin, 'placet-research');

  for (const [label, dir] of [
    ['no installed_plugins.json', configDirWith()],
    ['an installPath that is gone', configDirWith(entry(path.join(scratch('rh-cli-gone-'), 'nowhere')))],
  ]) {
    const out = runShim(shim, ['--help'], { HOME: home, CLAUDE_CONFIG_DIR: dir });
    assert.equal(out.status, 1, label);
    assert.equal(out.stdout, `${NOT_INSTALLED}\n`, label);
    assert.equal(out.stdout.trim().split('\n').length, 1, `${label}: one line`);
  }
});

// A terminal whose PATH has no node (nvm loaded only in some shells) must hear
// that, not that the plugin is missing.
test('the shim says node is missing when PATH has none, and exits 1', () => {
  const home = scratch('rh-cli-home-');
  const bin = path.join(scratch('rh-cli-bin-'), 'bin');
  const config = configDirWith(entry(pluginRoot));
  assert.equal(runCli(['install-cli', '--dir', bin], { HOME: home, CLAUDE_CONFIG_DIR: config }).status, 0);
  const out = childProcess.spawnSync('/bin/sh', [path.join(bin, 'placet-research'), '--help'], {
    env: { HOME: home, CLAUDE_CONFIG_DIR: config, PATH: scratch('rh-cli-empty-path-') },
    encoding: 'utf8',
  });
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^placet-research: node is not on this terminal's PATH;/);
  assert.equal(out.stdout.trim().split('\n').length, 1);
});

test('install-cli refuses to overwrite a file that is not its shim', () => {
  const home = scratch('rh-cli-home-');
  const bin = path.join(scratch('rh-cli-bin-'), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'placet-research');
  const foreign = '#!/bin/sh\necho some other tool\n';
  fs.writeFileSync(shim, foreign);

  const out = runCli(['install-cli', '--dir', bin], { HOME: home, CLAUDE_CONFIG_DIR: configDirWith(entry(pluginRoot)) });
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.equal(out.stdout, `${shim} already exists and is not the shim this command writes; refusing to overwrite it. Remove or rename that file first.\n`);
  assert.equal(fs.readFileSync(shim, 'utf8'), foreign, 'the foreign file is untouched');

  // A directory of that name is not a shim either.
  const dirBin = scratch('rh-cli-bin-');
  fs.mkdirSync(path.join(dirBin, 'placet-research'));
  const asDir = runCli(['install-cli', '--dir', dirBin], { HOME: home, CLAUDE_CONFIG_DIR: configDirWith(entry(pluginRoot)) });
  assert.equal(asDir.status, 1, asDir.stdout + asDir.stderr);
  assert.match(asDir.stdout, /already exists and is not the shim this command writes/);

  // `--dir` without a value is a malformed call, not a refusal to write.
  const bareFlag = runCli(['install-cli', '--dir'], { HOME: home, CLAUDE_CONFIG_DIR: configDirWith(entry(pluginRoot)) });
  assert.equal(bareFlag.status, 2, bareFlag.stdout + bareFlag.stderr);
  assert.match(bareFlag.stdout, /--dir needs a path/);
});
