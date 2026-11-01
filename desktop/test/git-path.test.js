'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { gitPath } = require('../git-path');

test('the bundled git exists and runs', () => {
  const bin = gitPath();
  assert.ok(fs.existsSync(bin), bin);
  const out = childProcess.execFileSync(bin, ['--version'], { encoding: 'utf8' });
  assert.match(out, /^git version \d+\.\d+/);
});
