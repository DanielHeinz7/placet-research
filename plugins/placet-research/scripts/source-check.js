#!/usr/bin/env node
'use strict';

// Turns a proposed source check into the ledger. The model proposes, per
// citation, a verdict and the passage it rests on; this script asks paperlib
// whether each quoted passage stands in the paper's PDF text and lets only a
// confirmed passage carry a verdict of supports, partly or does not.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERDICTS_NEEDING_PASSAGE = new Set(['supports', 'partly', 'does not']);
const VERDICTS = ['supports', 'partly', 'does not', 'not found', 'not checked'];

const BOUNDARY = 'This ledger proposes; it does not accept. A verdict of supports, partly or does not '
  + 'stands on a passage that paperlib found verbatim in the PDF text; whether the passage carries the '
  + 'claim is a reading for the authors to confirm. Pages are PDF page numbers counted from 1, '
  + 'not the printed page numbers.';

function parseVerifyOutput(stdout) {
  const match = /^(FOUND|NOT FOUND) \(similarity ([\d.]+)\) on page\(s\) \[([\d, ]*)\]/m.exec(stdout);
  if (!match) return null;
  const pages = match[3].split(',').map((page) => page.trim()).filter(Boolean).map(Number);
  return { found: match[1] === 'FOUND', similarity: Number(match[2]), pages };
}

function verifyQuote(paperlib, citekey, quote) {
  const result = childProcess.spawnSync(paperlib, ['verify-quote', citekey, quote], { encoding: 'utf8' });
  return result.status === 0 ? parseVerifyOutput(result.stdout) : null;
}

function fallBack(row, note) {
  return { ...row, verdict: 'not checked', quote: null, pages: [], note };
}

function settleRow(row, paperlib) {
  if (!VERDICTS.includes(row.verdict)) throw new Error(`unknown verdict "${row.verdict}" for ${row.citation}`);
  if (!VERDICTS_NEEDING_PASSAGE.has(row.verdict)) return { ...row, quote: null, pages: [] };
  return checkPassage(row, paperlib);
}

function checkPassage(row, paperlib) {
  if (!row.citekey || !row.quote) return fallBack(row, `${row.verdict} proposed, but no quote proposed`);
  const check = verifyQuote(paperlib, row.citekey, row.quote);
  if (!check) return fallBack(row, `paperlib could not check ${row.citekey}`);
  if (!check.found) return fallBack(row, `quote not confirmed by paperlib (similarity ${check.similarity})`);
  return { ...row, pages: check.pages };
}

function cell(text) {
  return String(text ?? '–').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '–';
}

function ledgerRow(row, index) {
  const pages = row.pages.length ? row.pages.join(', ') : '–';
  const passage = row.quote ? `“${row.quote}”` : '–';
  const claim = row.paragraph ? `¶${row.paragraph}: ${row.claim}` : row.claim;
  return `| ${index + 1} | ${cell(row.citation)} | ${cell(claim)} | ${row.verdict} | ${pages} | ${cell(passage)} | ${cell(row.note)} |`;
}

function tally(rows) {
  const counts = VERDICTS.map((verdict) => `${rows.filter((row) => row.verdict === verdict).length} ${verdict}`);
  return `${rows.length} citations: ${counts.join(', ')}`;
}

function buildLedger(proposal, { paperlib, date }) {
  const rows = proposal.rows.map((row) => settleRow(row, paperlib));
  return [
    '# Source check',
    '',
    `Draft: ${proposal.draft} · Checked: ${date} · ${tally(rows)}`,
    '',
    BOUNDARY,
    '',
    '| # | Citation | Claim in the draft | Verdict | PDF page | Passage (confirmed by paperlib) | Note |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(ledgerRow),
    '',
  ].join('\n');
}

function readArguments(argv) {
  const flags = { out: 'research/source-check.md', paperlib: process.env.PAPERLIB_BIN || 'paperlib' };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[(i += 1)];
    else positional.push(argv[i]);
  }
  return { proposalFile: positional[0], ...flags };
}

function main(argv) {
  const options = readArguments(argv);
  if (!options.proposalFile) {
    process.stderr.write('usage: source-check <proposal.json> [--out research/source-check.md] [--paperlib paperlib]\n');
    return 2;
  }
  const proposal = JSON.parse(fs.readFileSync(options.proposalFile, 'utf8'));
  const date = new Date().toISOString().slice(0, 10);
  const ledger = buildLedger(proposal, { paperlib: options.paperlib, date });
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, ledger);
  process.stdout.write(`${options.out}: ${/\d+ citations: [^\n]*/.exec(ledger)[0]}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { buildLedger, parseVerifyOutput, settleRow };
