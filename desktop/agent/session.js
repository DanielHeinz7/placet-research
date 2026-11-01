'use strict';
// One process in a pseudo-terminal. The argument vector goes to the program
// directly; there is no shell in between.
const pty = require('node-pty');

function createSession({ file, args, cwd, env, cols = 80, rows = 24 }) {
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
  let exited = false;
  proc.onExit(() => { exited = true; });
  return {
    pid: proc.pid,
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(({ exitCode, signal }) => cb(exitCode, signal)),
    write: (data) => { if (!exited) proc.write(data); },
    resize: (c, r) => { if (!exited && c > 0 && r > 0) proc.resize(c, r); },
    kill: () => { if (!exited) { exited = true; try { proc.kill(); } catch (_) { /* already gone */ } } },
  };
}

module.exports = { createSession };
