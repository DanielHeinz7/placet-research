'use strict';

// SQ-29 regression baseline: re-run the three shipped probe scripts and compare
// every row against the transcript recorded for it in verification/recorded/.
// A row is keyed by its ID; a verdict that moved is a regression, and the
// effect column is compared too, because SQ-26's promotion regression was a
// DENY that became an ALLOW and SQ-21's D3b was an effect that changed size.

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..', '..');
const PROBES = path.join(REPO, 'verification', 'probes');
const RECORDED = path.join(REPO, 'verification', 'recorded');

const ROW_RE = /^([A-Za-z0-9]+) \| ([a-z]+) \| ([A-Z-]+) \| ([\s\S]*?) \| (.*)$/;

function rowsOf(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = ROW_RE.exec(line);
    if (m) out.set(m[1], { verdict: m[3], effect: m[4].trim(), desc: m[5].trim() });
  }
  return out;
}

const PAIRS = [
  ['probe-structural.js', 'structural.txt'],
  ['probe-diff.js', 'diff.txt'],
  ['probe-reconfirm.js', 'reconfirm.txt'],
];

const rows = [];
const notes = [];

for (const [script, recorded] of PAIRS) {
  const ran = cp.spawnSync(process.execPath, [path.join(PROBES, script)], { encoding: 'utf8', timeout: 300000 });
  if (ran.status !== 0) {
    rows.push(`${script} | baseline | SCRIPT-ERROR | exit=${ran.status} | ${String(ran.stderr).split('\n')[0]}`);
    continue;
  }
  fs.writeFileSync(path.join(HERE, `rerun-${recorded}`), ran.stdout);
  const now = rowsOf(ran.stdout);
  const then = rowsOf(fs.readFileSync(path.join(RECORDED, recorded), 'utf8'));
  const ids = [...new Set([...then.keys(), ...now.keys()])].sort();
  let regressions = 0;
  let closed = 0;
  let effects = 0;
  const detail = [];
  for (const id of ids) {
    const a = then.get(id);
    const b = now.get(id);
    if (!a) { detail.push(`${id}: new row (${b.verdict})`); continue; }
    if (!b) { regressions += 1; detail.push(`${id}: row gone (was ${a.verdict})`); continue; }
    if (a.verdict !== b.verdict) {
      // Only one direction is a regression. recorded/ is the SQ-21 pass that
      // found the holes, so ALLOW -> DENY is a hole since closed.
      const closedHole = a.verdict === 'ALLOW' && b.verdict === 'DENY';
      if (closedHole) closed += 1; else regressions += 1;
      detail.push(`${id}: ${a.verdict} -> ${b.verdict} ${closedHole ? '(hole closed since SQ-21)' : '(REGRESSION)'}`);
      continue;
    }
    if (a.effect !== b.effect) { effects += 1; detail.push(`${id}: effect changed\n      recorded: ${a.effect}\n      now:      ${b.effect}`); }
  }
  rows.push(`${recorded.replace('.txt', '')} | baseline | ${regressions ? 'REGRESSION' : 'NO REGRESSION'} `
    + `| ${then.size} recorded rows, ${now.size} now, ${regressions} regressions, ${closed} holes closed, ${effects} effect changes `
    + `| ${script} against recorded/${recorded}`);
  if (detail.length) notes.push(`--- ${recorded} ---`, ...detail.map((d) => `  ${d}`));
}

// recorded/ is the SQ-21 pass, four rewrites ago. The tighter baseline is the
// most recent recorded run of the same three scripts, which SQ-32 left behind.
{
  const after = rowsOf(fs.readFileSync(path.join(REPO, 'verification', 'SQ-32', 'probes-after.txt'), 'utf8'));
  let regressions = 0;
  let effects = 0;
  const detail = [];
  for (const [, recorded] of PAIRS) {
    const now = rowsOf(fs.readFileSync(path.join(HERE, `rerun-${recorded}`), 'utf8'));
    for (const [id, b] of now) {
      const a = after.get(id);
      if (!a) { detail.push(`${id}: not in probes-after.txt`); continue; }
      if (a.verdict !== b.verdict) { regressions += 1; detail.push(`${id}: VERDICT ${a.verdict} -> ${b.verdict}`); continue; }
      if (a.effect !== b.effect) { effects += 1; detail.push(`${id}: effect changed\n      SQ-32: ${a.effect}\n      now:   ${b.effect}`); }
    }
  }
  rows.push(`since-SQ-32 | baseline | ${regressions || effects ? 'DRIFT' : 'IDENTICAL'} `
    + `| ${after.size} rows in SQ-32/probes-after.txt, ${regressions} verdict changes, ${effects} effect changes `
    + '| the same three scripts against the most recent recorded run');
  if (detail.length) notes.push('--- against SQ-32/probes-after.txt ---', ...detail.map((d) => `  ${d}`));
}

// The two SQ-21 classes whose scripts were never vendored exist only as recorded
// rows; they are rebuilt and re-run in probe-recorded.js.
rows.push('bash + path-and-tool | baseline | SEE probe-recorded.js '
  + '| no vendored script; rebuilt from recorded/bash.txt and recorded/path-and-tool.txt '
  + '| node verification/SQ-29/probe-recorded.js');

process.stdout.write([
  'SQ-29 baseline class -- the three shipped probe scripts re-run and diffed against',
  'verification/recorded/. Each re-run transcript is written beside this file as',
  'rerun-<name>.txt. recorded/ is the SQ-21 pass that found the holes, so ALLOW -> DENY there',
  'is a hole since closed and DENY -> ALLOW is a regression.',
  '',
  'ID | class | result | counts | source',
  ...rows,
  '',
  '--- differences ---',
  ...(notes.length ? notes : ['  none']),
  '',
].join('\n'));
