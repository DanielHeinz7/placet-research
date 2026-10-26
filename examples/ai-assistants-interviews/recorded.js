#!/usr/bin/env node
'use strict';

// Stands in for the model's part of the multiverse step, so the walkthrough
// prints the same numbers every time. For each file in recorded/ it runs
// `placet-research init --variant <name> --lens <text>` in the current project,
// exactly as a multiverse subagent would, and then writes the recorded
// statements under the canvas frontmatter that init made.
//
//   node recorded.js
//
// Run it in the project directory, after `placet-research init --project ...`.
// It is the researcher's own terminal step: the variants it writes are
// proposals and tentative findings only, never [stated] or [accepted].

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(here, '..', '..', 'plugins', 'placet-research');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const stateDir = path.resolve(process.env.PLACET_RESEARCH_DIR || 'research');

// Order fixed so the log and the view read the same on every run.
const NAMES = ['workflow', 'trust', 'role'];

function recorded(name) {
  const text = fs.readFileSync(path.join(here, 'recorded', `${name}.md`), 'utf8');
  const m = /^---\nlens: (".*")\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`recorded/${name}.md has no lens line`);
  return { lens: JSON.parse(m[1]), body: m[2] };
}

function main() {
  if (!fs.existsSync(path.join(stateDir, 'canvas.md'))) {
    console.log(`No ${path.join(stateDir, 'canvas.md')} here: run placet-research init --project <slug> --mode import first, in this directory.`);
    return 1;
  }
  for (const name of NAMES) {
    const { lens, body } = recorded(name);
    const made = childProcess.spawnSync(process.execPath, [cli, 'init', '--variant', name, '--lens', lens], { encoding: 'utf8' });
    if (made.status !== 0) {
      console.log(made.stdout + made.stderr);
      return 1;
    }
    const canvasFile = path.join(stateDir, 'variants', name, 'canvas.md');
    const text = fs.readFileSync(canvasFile, 'utf8');
    const end = text.indexOf('\n---\n', 4);
    fs.writeFileSync(canvasFile, `${text.slice(0, end + 5)}${body}`);
    console.log(`Wrote the recorded statements into ${path.relative(process.cwd(), canvasFile)} (lens: ${lens}).`);
  }
  return 0;
}

process.exitCode = main();
