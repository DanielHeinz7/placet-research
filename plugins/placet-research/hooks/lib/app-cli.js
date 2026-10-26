'use strict';
// Runs the plugin's own command line for the desktop app's human steps, so
// the app takes the same checks and writes the same files as the terminal.
// No shell: node gets the arguments as an array. Inside Electron,
// process.execPath is the app binary, which ELECTRON_RUN_AS_NODE turns into
// plain node; outside Electron the variable does nothing.
const childProcess = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'bin', 'placet-research.js');

function runCli(root, args) {
  return new Promise((resolve) => {
    childProcess.execFile(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, ELECTRON_RUN_AS_NODE: '1' },
      maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      const output = String(stdout).trim();
      if (!err) {
        resolve({ ok: true, output });
        return;
      }
      // err.message is about how node started the command — it carries the
      // whole command line, paths and all — and the command's own sentence is
      // already in stdout (the plugin's fail() writes there). Nothing readable
      // came back, so say that in the app's words rather than repeat node's.
      resolve({ ok: false, code: err.code === 2 ? 'invalid' : 'refused', error: output || 'This step could not be run, and it says nothing about why. Close this window and start the app again.' });
    });
  });
}

module.exports = { runCli, CLI };
