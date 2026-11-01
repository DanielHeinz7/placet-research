'use strict';
// Runs a program without a shell and always resolves, so callers decide what
// a failure means. Output is capped at 1 MB.
const childProcess = require('node:child_process');

function run(file, args, { timeout = 10000, env } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { timeout, env, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = { run };
