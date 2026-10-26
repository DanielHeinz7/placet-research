'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const host = require('../hooks/lib/host');

test('normalizePath strips spaces and one pair of quotes, nothing else', () => {
  assert.equal(host.normalizePath('  "C:\\Users\\x\\paper"  '), 'C:\\Users\\x\\paper');
  assert.equal(host.normalizePath('/home/x/paper'), '/home/x/paper');
  assert.equal(host.normalizePath('"/home/x/my "paper""'), '/home/x/my "paper"');
  assert.equal(host.normalizePath('"'), '"');
  assert.equal(host.normalizePath(undefined), undefined);
});

test('oneDriveOf finds a folder inside OneDrive on Windows only', () => {
  const env = { OneDrive: 'C:\\Users\\x\\OneDrive - University', OneDriveConsumer: 'C:\\Users\\x\\OneDrive' };
  assert.equal(host.oneDriveOf('C:\\Users\\x\\OneDrive - University\\Documents\\paper', { platform: 'win32', env }), 'C:\\Users\\x\\OneDrive - University');
  assert.equal(host.oneDriveOf('c:\\users\\X\\onedrive\\p', { platform: 'win32', env }), 'C:\\Users\\x\\OneDrive');
  assert.equal(host.oneDriveOf('C:\\Users\\x\\research', { platform: 'win32', env }), null);
  assert.equal(host.oneDriveOf('C:\\Users\\x\\OneDriveX\\p', { platform: 'win32', env: { OneDrive: 'C:\\Users\\x\\OneDrive' } }), null);
  assert.equal(host.oneDriveOf('/home/x/OneDrive/p', { platform: 'darwin', env: { OneDrive: '/home/x/OneDrive' } }), null);
});

test('hostInfo carries the separator the page joins paths with', () => {
  assert.deepEqual(host.hostInfo({ platform: 'win32', home: 'C:\\Users\\x' }), { platform: 'win32', home: 'C:\\Users\\x', sep: '\\' });
  assert.deepEqual(host.hostInfo({ platform: 'darwin', home: '/home/x' }), { platform: 'darwin', home: '/home/x', sep: '/' });
});

test('startNotes: Node below the floor refuses; git missing is a line, not a refusal', () => {
  assert.match(host.startNotes({ platform: 'win32', nodeVersion: '20.11.0', gitFound: true }).refuse, /needs Node\.js 22 or newer/);
  const noGit = host.startNotes({ platform: 'win32', nodeVersion: '22.0.0', gitFound: false });
  assert.equal(noGit.refuse, null);
  assert.ok(noGit.lines.some((l) => l.includes('https://git-scm.com/download/win')));
  const fine = host.startNotes({ platform: 'darwin', nodeVersion: '24.16.0', gitFound: true });
  assert.deepEqual(fine, { refuse: null, lines: [host.KEEP_OPEN] });
  assert.ok(host.startNotes({ platform: 'darwin', nodeVersion: '24.0.0', gitFound: false }).lines.some((l) => /Git was not found/.test(l)));
});

test('install-cli refuses on Windows only; the git hint is Windows only', () => {
  assert.match(host.installCliRefusal('win32'), /Start placet-research\.cmd/);
  assert.equal(host.installCliRefusal('darwin'), null);
  assert.match(host.gitMissingHint('win32'), /git-scm\.com\/download\/win/);
  assert.equal(host.gitMissingHint('linux'), '');
});
