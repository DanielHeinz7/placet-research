#!/usr/bin/env node
'use strict';
// Checks a built app as desktop/distribution.json says it should be signed.
//
//   node scripts/verify-app.js <Placet.app> <arm64|x64>
//
// Exit 0 every check passed, 1 a check failed, 2 wrong arguments or switch.
const fs = require('node:fs');
const { readDistribution, DistributionError } = require('../lib/distribution');
const { verifyApp } = require('../lib/verify');

const ROSETTA = '/Library/Apple/usr/share/rosetta/rosetta';
const [app, arch] = process.argv.slice(2);
if (!app || !['arm64', 'x64'].includes(arch) || !fs.existsSync(app)) {
  console.error('usage: node scripts/verify-app.js <Placet.app> <arm64|x64>');
  process.exit(2);
}
let dist;
try {
  dist = readDistribution();
} catch (err) {
  if (!(err instanceof DistributionError)) throw err;
  console.error(err.message);
  process.exit(2);
}
const rosetta = process.arch === arch || fs.existsSync(ROSETTA);
const { problems, notes } = verifyApp(app, { dist, arch, rosetta });
for (const n of notes) console.log(`note: ${n}`);
for (const p of problems) console.error(`problem: ${p}`);
console.log(problems.length ? `${app}: ${problems.length} problem(s)` : `${app}: all checks passed`);
process.exit(problems.length ? 1 : 0);
