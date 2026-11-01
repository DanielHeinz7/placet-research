'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyApp } = require('../lib/verify');

const GITREL = 'Contents/Resources/app.asar.unpacked/node_modules/dugite/git';
const NODEPTY = 'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64';
const SDKPKG = 'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-';
const AGENT = `${SDKPKG}arm64`;
const SIGNED = { signing: 'developer-id', identity: 'Developer ID Application: A. Researcher (AB12CD34EF)', teamId: 'AB12CD34EF', notaryProfile: 'p' };
const ADHOC_RT = 'CodeDirectory v=20500 flags=0x10002(adhoc,runtime)\nSignature=adhoc\nTeamIdentifier=not set\n';
const OURS = 'CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: A. Researcher (AB12CD34EF)\nTimestamp=1. Jan 2027 at 10:00:00\nTeamIdentifier=AB12CD34EF\n';
const MICROSOFT = 'CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Microsoft Corporation (UBF8T346G9)\nTimestamp=19. Jun 2026 at 17:29:36\nTeamIdentifier=UBF8T346G9\n';

const MACHO = [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1];
const SHIM = Buffer.from('#!/bin/sh\nexec true\n');

function fakeApp(t, arch = 'arm64') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'Placet.app');
  for (const rel of ['Contents/MacOS/placet-research', `${GITREL}/bin/git`, `${GITREL}/libexec/git-core/git-credential-manager`, `${SDKPKG}${arch}/claude`]) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]));
  }
  return app;
}

function put(app, rel, bytes, mode) {
  const file = path.join(app, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(bytes));
  if (mode !== undefined) fs.chmodSync(file, mode);
}

// Answers by command and the last argument's base name; `over` replaces answers.
function fakeRun(over = {}) {
  const calls = [];
  const base = {
    'codesign --verify': { status: 0 },
    'codesign -dvvv placet-research': { stderr: ADHOC_RT },
    'codesign -dvvv git': { stderr: ADHOC_RT },
    'codesign -dvvv git-credential-manager': { stderr: MICROSOFT },
    'codesign -dvvv claude': { stderr: ADHOC_RT },
    'file -b': { stdout: 'Mach-O 64-bit executable arm64\n' },
    'git --version': { stdout: 'git version 2.47.1\n' },
    'git credential-manager': { stdout: '2.9.0\n' },
    'spctl --assess': { status: 3, stderr: 'rejected\n' },
    'xcrun stapler': { status: 0 },
    ...over,
  };
  const run = (cmd, args) => {
    const key = `${path.basename(cmd)} ${args[0]}`;
    const named = `${path.basename(cmd)} ${args[0]} ${path.basename(args[args.length - 1])}`;
    calls.push(named);
    const answer = base[named] || base[key] || {};
    return { status: 0, stdout: '', stderr: '', ...answer };
  };
  run.calls = calls;
  return run;
}

test('none: ad-hoc with runtime everywhere passes and says it cannot be published', (t) => {
  const { problems, notes } = verifyApp(fakeApp(t), { dist: { signing: 'none' }, arch: 'arm64', run: fakeRun() });
  assert.deepEqual(problems, []);
  assert.ok(notes.some((n) => /cannot be published/.test(n)));
});

test('a Mach-O file without hardened runtime is a problem', (t) => {
  const run = fakeRun({ 'codesign -dvvv git': { stderr: ADHOC_RT.replace('(adhoc,runtime)', '(adhoc,linker-signed)') } });
  const { problems } = verifyApp(fakeApp(t), { dist: { signing: 'none' }, arch: 'arm64', run });
  assert.ok(problems.some((p) => /bin\/git has no hardened runtime/.test(p)), problems.join('\n'));
});

test('developer-id: own team plus kept Microsoft signature passes; an ad-hoc file does not', (t) => {
  const accepted = { 'spctl --assess': { status: 0, stderr: 'accepted\nsource=Notarized Developer ID\n' } };
  const good = fakeRun({ ...accepted, 'codesign -dvvv placet-research': { stderr: OURS }, 'codesign -dvvv git': { stderr: OURS }, 'codesign -dvvv claude': { stderr: OURS } });
  const app = fakeApp(t);
  const ok = verifyApp(app, { dist: SIGNED, arch: 'arm64', run: good });
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.notes.includes('kept 1 file(s) signed by team UBF8T346G9'));
  const bad = fakeRun({ ...accepted, 'codesign -dvvv placet-research': { stderr: OURS } });
  assert.ok(verifyApp(app, { dist: SIGNED, arch: 'arm64', run: bad }).problems.some((p) => /bin\/git is only ad-hoc signed/.test(p)));
});

test('developer-id: no ticket and no Gatekeeper acceptance are problems', (t) => {
  const run = fakeRun({ 'codesign -dvvv placet-research': { stderr: OURS }, 'codesign -dvvv git': { stderr: OURS }, 'xcrun stapler': { status: 65 } });
  const { problems } = verifyApp(fakeApp(t), { dist: SIGNED, arch: 'arm64', run });
  assert.ok(problems.some((p) => /stapler validate/.test(p)));
  assert.ok(problems.some((p) => /Gatekeeper does not accept/.test(p)));
});

test('git for the wrong processor and a broken credential manager are problems', (t) => {
  const run = fakeRun({ 'file -b': { stdout: 'Mach-O 64-bit executable x86_64\n' }, 'git credential-manager': { status: 134, stderr: 'Abort trap: 6\n' } });
  const { problems } = verifyApp(fakeApp(t), { dist: { signing: 'none' }, arch: 'arm64', run });
  assert.ok(problems.some((p) => /not built for arm64/.test(p)));
  assert.ok(problems.some((p) => /credential manager does not start: Abort trap: 6/.test(p)));
});

test('the agent binary is checked for the processor this build is for', (t) => {
  const app = fakeApp(t);
  const inner = fakeRun();
  const answering = (stdout) => (cmd, args) => {
    const file = args[args.length - 1];
    if (path.basename(cmd) === 'file' && file.includes('claude-agent-sdk')) return { status: 0, stdout, stderr: '' };
    return inner(cmd, args);
  };
  const problems = (stdout) => verifyApp(app, { dist: { signing: 'none' }, arch: 'arm64', run: answering(stdout) }).problems;
  assert.deepEqual(problems('Mach-O 64-bit executable arm64\n'), []);
  const wrong = problems('Mach-O 64-bit executable x86_64\n');
  assert.ok(wrong.some((p) => /claude-agent-sdk-darwin-arm64\/claude is not built for arm64: Mach-O 64-bit executable x86_64/.test(p)), wrong.join('\n'));
  fs.rmSync(path.join(app, `${AGENT}/claude`)); // a build that fetched no binary for its processor
  const missing = problems('Mach-O 64-bit executable arm64\n');
  assert.ok(missing.some((p) => /claude-agent-sdk-darwin-arm64\/claude is missing: this build carries no agent binary for arm64/.test(p)), missing.join('\n'));
});

test('an Intel build on a Mac without Rosetta is checked but not started', (t) => {
  const run = fakeRun({ 'file -b': { stdout: 'Mach-O 64-bit executable x86_64\n' } });
  const { problems, notes } = verifyApp(fakeApp(t, 'x64'), { dist: { signing: 'none' }, arch: 'x64', run, rosetta: false });
  assert.deepEqual(problems, []);
  assert.ok(notes.some((n) => /not started/.test(n)));
  assert.ok(!run.calls.some((c) => c.startsWith('git ')));
});

test('node-pty binaries and the shims are checked when they are in the build', (t) => {
  const app = fakeApp(t);
  put(app, `${NODEPTY}/spawn-helper`, MACHO, 0o755);
  put(app, `${NODEPTY}/pty.node`, MACHO, 0o755);
  put(app, 'Contents/Resources/shims/node', SHIM, 0o755);
  put(app, 'Contents/Resources/shims/git', SHIM, 0o755);
  const sig = { 'codesign -dvvv spawn-helper': { stderr: ADHOC_RT }, 'codesign -dvvv pty.node': { stderr: ADHOC_RT } };
  assert.deepEqual(verifyApp(app, { dist: { signing: 'none' }, arch: 'arm64', run: fakeRun(sig) }).problems, []);
  const wrong = fakeRun({ ...sig, 'file -b': { stdout: 'Mach-O 64-bit executable x86_64\n' } });
  const { problems } = verifyApp(app, { dist: { signing: 'none' }, arch: 'arm64', run: wrong });
  assert.ok(problems.some((p) => /spawn-helper is not built for arm64/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /pty\.node is not built for arm64/.test(p)), problems.join('\n'));
});

test('node-pty prebuilds for other processors are carried but not checked', (t) => {
  const app = fakeApp(t);
  const other = NODEPTY.replace('darwin-arm64', 'darwin-x64');
  for (const dir of [NODEPTY, other]) {
    put(app, `${dir}/spawn-helper`, MACHO, 0o755);
    put(app, `${dir}/pty.node`, MACHO, 0o755);
  }
  const sig = { 'codesign -dvvv spawn-helper': { stderr: ADHOC_RT }, 'codesign -dvvv pty.node': { stderr: ADHOC_RT } };
  const inner = fakeRun(sig);
  const run = (cmd, args) => {
    const file = args[args.length - 1];
    if (path.basename(cmd) === 'file' && file.includes('node-pty')) {
      return { status: 0, stdout: `Mach-O 64-bit executable ${file.includes('darwin-arm64') ? 'arm64' : 'x86_64'}\n`, stderr: '' };
    }
    return inner(cmd, args);
  };
  assert.deepEqual(verifyApp(app, { dist: { signing: 'none' }, arch: 'arm64', run }).problems, []);
});

test('a shim that cannot run is a problem; absent node-pty and shims are skipped', (t) => {
  const app = fakeApp(t);
  assert.deepEqual(verifyApp(app, { dist: { signing: 'none' }, arch: 'arm64', run: fakeRun() }).problems, []);
  put(app, 'Contents/Resources/shims/node', SHIM, 0o644);
  const { problems } = verifyApp(app, { dist: { signing: 'none' }, arch: 'arm64', run: fakeRun() });
  assert.ok(problems.some((p) => /Contents\/Resources\/shims\/node has mode 644, not 755/.test(p)), problems.join('\n'));
});
