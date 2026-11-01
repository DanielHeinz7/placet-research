'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveSecret, readSecret, removeSecret } = require('../agent/sdk/keychain');
const { fakeSecurity, trackDir } = require('./support/fake-security');

// An error's stack and own properties as one text, to search for the key.
const errorText = (err) => [err.stack, ...Object.values(err)].map(String).join('\n');

test('a secret round-trips and never appears in an argument list', async () => {
  const sec = fakeSecurity();
  const secret = 'sk-a b"c\\d ü';
  await saveSecret('anthropic', secret, { security: sec.bin });
  assert.equal(await readSecret('anthropic', { security: sec.bin }), secret);
  assert.ok(!sec.log().includes('sk-a'), sec.log());
  await removeSecret('anthropic', { security: sec.bin });
  assert.equal(await readSecret('anthropic', { security: sec.bin }), null);
});

test('a secret with a line break or control character is refused before security runs', async () => {
  const sec = fakeSecurity();
  await assert.rejects(saveSecret('gateway', 'abc\ndef', { security: sec.bin }), { code: 'bad-secret' });
  await assert.rejects(saveSecret('gateway', '', { security: sec.bin }), { code: 'bad-secret' });
  for (const secret of ['abc\r', '\tabc', 'abc\u0085def', 'abc def']) {
    await assert.rejects(saveSecret('gateway', secret, { security: sec.bin }), { code: 'bad-secret' });
  }
  assert.throws(() => fs.readFileSync(path.join(path.dirname(sec.bin), 'log')), { code: 'ENOENT' });
});

test('an unknown kind is refused', async () => {
  await assert.rejects(saveSecret('vertex', 'x'), /Unknown connection kind/);
});

test('keys with quotes, backslashes, spaces, non-ASCII letters or a break-out attempt round-trip unchanged', async () => {
  for (const secret of ["it's", 'ends in a backslash \\', '\\"\\\\"', 'x" -s other -a gateway -w "y', 'non-ASCII é ü ж キ ']) {
    const sec = fakeSecurity();
    await saveSecret('anthropic', secret, { security: sec.bin });
    assert.equal(await readSecret('anthropic', { security: sec.bin }), secret);
    assert.equal(await readSecret('gateway', { security: sec.bin }), null);
  }
});

test('a key too long for one security -i line is refused before security runs', async () => {
  // security -i reads at most 4095 bytes of a line, newline included, and runs
  // the rest as a command of its own. With the default service and
  // 'anthropic', that leaves 4024 bytes inside the quotes.
  const sec = fakeSecurity();
  const longest = 'k'.repeat(4024);
  await saveSecret('anthropic', longest, { security: sec.bin });
  assert.equal(await readSecret('anthropic', { security: sec.bin }), longest);
  const unused = fakeSecurity();
  // One byte more; quotes doubled by escaping; letters of two bytes each.
  for (const secret of [`${longest}k`, '"'.repeat(2013), 'ü'.repeat(2013)]) {
    await assert.rejects(saveSecret('anthropic', secret, { security: unused.bin }), { code: 'bad-secret' });
  }
  assert.throws(() => unused.log(), { code: 'ENOENT' });
});

test('the key reaches security on stdin only: not in arguments, environment, a temp file or the console', async (t) => {
  const marker = `rh-${crypto.randomBytes(12).toString('hex')}`;
  const sec = fakeSecurity({ watch: marker });
  const tmp = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sec-tmp-')));
  const consoleMocks = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map((name) => t.mock.method(console, name, () => {}));
  const tmpBefore = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    await saveSecret('gateway', `${marker} "q" \\`, { security: sec.bin });
    await readSecret('gateway', { security: sec.bin });
    await removeSecret('gateway', { security: sec.bin });
  } finally {
    if (tmpBefore === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmpBefore;
  }
  const calls = sec.io();
  assert.deepEqual(calls.map((c) => c.args[0]), ['-i', 'find-generic-password', 'find-generic-password', 'delete-generic-password']);
  assert.ok(calls[0].input.includes(marker), 'the key went to security -i on stdin');
  for (const c of calls) {
    assert.ok(!JSON.stringify(c.args).includes(marker), c.args.join(' '));
    assert.equal(c.envHasWatch, false);
  }
  assert.deepEqual(fs.readdirSync(tmp), []);
  for (const mock of consoleMocks) assert.equal(mock.mock.callCount(), 0);
});

test('refusals and failures never repeat the key', async () => {
  const marker = `rh-${crypto.randomBytes(12).toString('hex')}`;
  const sec = fakeSecurity();
  const refusals = [
    () => saveSecret('gateway', `${marker}\nsecond line`, { security: sec.bin }),
    () => saveSecret('gateway', marker.repeat(200), { security: sec.bin }),
    () => saveSecret(marker, 'anthropic', { security: sec.bin }), // arguments swapped
  ];
  for (const refusal of refusals) {
    const err = await refusal().then(() => assert.fail('not refused'), (e) => e);
    assert.ok(!errorText(err).includes(marker), errorText(err));
  }
  // security's own output can repeat what it got: a `security -i` line over
  // 4095 bytes ends in `unknown command "<the rest of the line>"`.
  await saveSecret('bedrock', marker, { security: sec.bin });
  sec.fail();
  await assert.rejects(saveSecret('bedrock', `${marker}-new`, { security: sec.bin }), (err) => err.code === 'keychain-write' && !errorText(err).includes(marker));
  await assert.rejects(readSecret('bedrock', { security: sec.bin }), (err) => err.code === 'keychain-denied' && !errorText(err).includes(marker));
  const [write, read] = sec.io().slice(-2);
  assert.ok(write.stderr.includes(marker) && read.stderr.includes(marker), 'the fake security repeated the key on stderr');
});
