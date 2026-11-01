'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../agent/session');

function collect(session) {
  let out = '';
  session.onData((d) => { out += d; });
  return new Promise((resolve) => session.onExit((code) => resolve({ out, code })));
}

test('runs a program in a pty, without a shell, and reports its exit code', async () => {
  const s = createSession({ file: '/bin/echo', args: ['a b', '$HOME', ';', 'ls'], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } });
  const { out, code } = await collect(s);
  assert.match(out, /a b \$HOME ; ls/);
  assert.equal(code, 0);
});

test('a failing program reports its code; kill is safe twice', async () => {
  const s = createSession({ file: '/bin/sh', args: ['-c', 'exit 3'], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } });
  const { code } = await collect(s);
  assert.equal(code, 3);
  s.kill();
  s.kill();
});

test('input reaches the program and resize does not throw', async () => {
  const s = createSession({ file: '/bin/cat', args: [], cwd: '/tmp', env: { PATH: '/usr/bin:/bin' } });
  const done = collect(s);
  s.resize(100, 30);
  s.write('hello\r');
  await new Promise((r) => setTimeout(r, 200));
  s.kill();
  assert.match((await done).out, /hello/);
});
