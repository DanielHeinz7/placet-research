'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isMachO, machOFiles, parseCodesign, keepList, signature } = require('../lib/macho');

const GCM = [
  'Executable=/x/libexec/git-core/git-credential-manager',
  'Identifier=git-credential-manager',
  'Format=Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1346 flags=0x10000(runtime) hashes=31+7 location=embedded',
  'Signature size=9012',
  'Authority=Developer ID Application: Microsoft Corporation (UBF8T346G9)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=19. Jun 2026 at 17:29:36',
  'Info.plist=not bound',
  'TeamIdentifier=UBF8T346G9',
  'Runtime Version=15.5.0',
].join('\n');
const GIT = [
  'Executable=/x/bin/git',
  'Identifier=git',
  'Format=Mach-O thin (arm64)',
  'CodeDirectory v=20400 size=26524 flags=0x20002(adhoc,linker-signed) hashes=826+0 location=embedded',
  'Signature=adhoc',
  'Info.plist=not bound',
  'TeamIdentifier=not set',
].join('\n');

function tree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-macho-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), Buffer.from(bytes));
  }
  return dir;
}
const THIN = [0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1];
const FAT = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2];
const JAVA = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34];

test('Mach-O by magic number; a Java class file and text are not', (t) => {
  const dir = tree(t, { 'a/thin': THIN, 'a/fat': FAT, 'a/Main.class': JAVA, 'a/readme': [0x68, 0x69, 0x0a], 'tiny': [0xcf, 0xfa] });
  assert.deepEqual(machOFiles(dir).map((f) => path.relative(dir, f)), ['a/fat', 'a/thin']);
  assert.equal(isMachO(path.join(dir, 'tiny')), false);
  fs.symlinkSync(path.join(dir, 'a', 'thin'), path.join(dir, 'link'));
  assert.equal(machOFiles(dir).length, 2, 'symlinks are not counted twice');
});

test('codesign output: Developer ID with runtime and timestamp', () => {
  assert.deepEqual(parseCodesign(GCM), { signed: true, adhoc: false, runtime: true, timestamp: true, authority: 'Developer ID Application: Microsoft Corporation (UBF8T346G9)', team: 'UBF8T346G9' });
});

test('codesign output: ad-hoc, linker-signed, no runtime', () => {
  assert.deepEqual(parseCodesign(GIT), { signed: true, adhoc: true, runtime: false, timestamp: false, authority: null, team: null });
});

test('codesign output: not signed', () => {
  assert.deepEqual(parseCodesign('/etc/hosts: code object is not signed at all\n'), { signed: false });
});

test('keepList keeps Developer ID files with runtime and timestamp, nothing else', (t) => {
  const dir = tree(t, { 'bin/git': THIN, 'libexec/git-core/git-credential-manager': THIN, 'libexec/git-core/libcoreclr.dylib': THIN });
  const outputs = { git: GIT, 'git-credential-manager': GCM, 'libcoreclr.dylib': GCM.replace('flags=0x10000(runtime)', 'flags=0x0(none)') };
  const run = (cmd, args) => ({ status: 0, stdout: '', stderr: outputs[path.basename(args[args.length - 1])] });
  assert.deepEqual(keepList(dir, run), ['libexec/git-core/git-credential-manager']);
});

test('the real bundled git is found and read as ad-hoc', () => {
  const git = path.join(path.dirname(require.resolve('dugite/package.json')), 'git', 'bin', 'git');
  assert.equal(isMachO(git), true);
  const sig = signature(git);
  assert.equal(sig.signed, true);
  assert.equal(sig.adhoc, true);
});
