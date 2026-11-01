'use strict';
// One generic-password item per connection kind in the login Keychain. The
// secret never appears in an argument list, which every process on the Mac
// can read: writes go through `security -i` with the command on stdin, and
// reads print the secret to this process only.
const { execFile } = require('node:child_process');

const SERVICE = 'research-harness-desktop';
const KINDS = ['anthropic', 'gateway', 'bedrock'];
const NOT_FOUND = 44;
// `security -i` reads at most 4095 bytes of a line, newline included. The rest
// of a longer line runs as a command of its own, and its error repeats it.
const MAX_LINE = 4095;

const failure = (code, message) => Object.assign(new Error(message), { code });
const writeFailed = () => failure('keychain-write', 'The key could not be stored in the Keychain.');
const readDenied = () => failure('keychain-denied', 'The app was not allowed to read the key from the Keychain.');

function checkKind(kind) {
  // The value stays out of the message: with the arguments swapped, it is the key.
  if (!KINDS.includes(kind)) throw new Error('Unknown connection kind');
}

function quote(secret) {
  if (typeof secret !== 'string' || !secret || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(secret)) {
    throw failure('bad-secret', 'The key is empty or contains a line break.');
  }
  return `"${secret.replace(/[\\"]/g, '\\$&')}"`;
}

function run(security, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(security, args, { encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
    child.stdin.end(input);
  });
}

async function saveSecret(kind, secret, { security = '/usr/bin/security', service = SERVICE } = {}) {
  checkKind(kind);
  const line = `add-generic-password -U -s ${service} -a ${kind} -w ${quote(secret)}\n`;
  if (Buffer.byteLength(line) > MAX_LINE) {
    throw failure('bad-secret', 'The key is too long to store in the Keychain. Check that only the key was pasted.');
  }
  // A failed run's error carries security's stderr, which can repeat the
  // command line, key included, so only the code goes on.
  try { await run(security, ['-i'], line); } catch { throw writeFailed(); }
  // Reading back shows that security stored the key as quoted.
  if ((await readSecret(kind, { security, service })) !== secret) throw writeFailed();
}

// `find-generic-password -w` prints a key with a non-ASCII byte as bare hex,
// which cannot be told from a key that is hex. `-g` prints, on stderr,
// `password: "<key>"` when every byte is printable ASCII other than a
// backslash, and `password: 0x<HEX>  "<key with octal escapes>"` otherwise.
const PASSWORD_LINE = /^password: (?:0x([0-9A-Fa-f]*)(?: |$)|"(.*)"$|$)/m;

async function readSecret(kind, { security = '/usr/bin/security', service = SERVICE } = {}) {
  checkKind(kind);
  let stderr;
  try {
    ({ stderr } = await run(security, ['find-generic-password', '-s', service, '-a', kind, '-g']));
  } catch (err) {
    if (err.code === NOT_FOUND) return null;
    throw readDenied();
  }
  const m = PASSWORD_LINE.exec(stderr);
  if (!m) throw readDenied();
  return m[1] !== undefined ? Buffer.from(m[1], 'hex').toString('utf8') : (m[2] ?? '');
}

async function removeSecret(kind, { security = '/usr/bin/security', service = SERVICE } = {}) {
  checkKind(kind);
  try { await run(security, ['delete-generic-password', '-s', service, '-a', kind]); } catch (err) {
    if (err.code !== NOT_FOUND) throw err;
  }
}

module.exports = { saveSecret, readSecret, removeSecret, SERVICE, KINDS };
