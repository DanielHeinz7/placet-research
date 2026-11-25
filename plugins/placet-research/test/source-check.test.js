'use strict';

// The source-check ledger: a verdict that claims support stands only on a
// quotation paperlib found in the paper's PDF text. A stand-in paperlib answers
// FOUND for quotes containing "verbatim" and NOT FOUND otherwise, so these tests
// need neither Josh's paper-library nor any publisher text.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const script = path.join(pluginRoot, 'scripts', 'source-check.js');
const { buildLedger, parseVerifyOutput, settleRow } = require(script);

const fakePaperlib = `#!/usr/bin/env node
const [, , command, citekey, quote] = process.argv;
if (command !== 'verify-quote') process.exit(2);
if (citekey === 'absent') { console.error('Error: no paper absent'); process.exit(1); }
if (quote.includes('verbatim')) console.log('FOUND (similarity 1.0) on page(s) [3, 4]\\n  ' + quote);
else console.log('NOT FOUND (similarity 0.42) on page(s) [7]\\n  something else');
`;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-check-'));
  const bin = path.join(dir, 'paperlib');
  fs.writeFileSync(bin, fakePaperlib, { mode: 0o755 });
  return { dir, bin };
}

const proposal = {
  draft: 'manuscript/draft.md',
  rows: [
    { citation: 'Alpha (2020)', paragraph: 1, claim: 'Alpha says so.', citekey: 'alpha2020', verdict: 'supports', quote: 'a verbatim sentence' },
    { citation: 'Beta (2021)', paragraph: 2, claim: 'Beta says so.', citekey: 'beta2021', verdict: 'partly', quote: 'an invented sentence' },
    { citation: 'Gamma (2022)', paragraph: 2, claim: 'Gamma | pipes.', citekey: null, verdict: 'not checked', note: 'no full text' },
    { citation: 'Delta (2023)', paragraph: 3, claim: 'Delta says so.', citekey: 'delta2023', verdict: 'not found', note: 'no passage' },
  ],
};

test('parseVerifyOutput reads found, similarity and pages', () => {
  assert.deepEqual(parseVerifyOutput('FOUND (similarity 1.0) on page(s) [3, 4]\n  text'), { found: true, similarity: 1, pages: [3, 4] });
  assert.deepEqual(parseVerifyOutput('NOT FOUND (similarity 0.42) on page(s) [7]\n  x'), { found: false, similarity: 0.42, pages: [7] });
  assert.equal(parseVerifyOutput('Error: something'), null);
});

test('a supporting verdict keeps its quote and pages only when paperlib finds it', () => {
  const { bin } = workspace();
  const confirmed = settleRow(proposal.rows[0], bin);
  assert.equal(confirmed.verdict, 'supports');
  assert.deepEqual(confirmed.pages, [3, 4]);
  const unconfirmed = settleRow(proposal.rows[1], bin);
  assert.equal(unconfirmed.verdict, 'not checked');
  assert.equal(unconfirmed.quote, null);
  assert.match(unconfirmed.note, /quote not confirmed by paperlib \(similarity 0\.42\)/);
});

test('a supporting verdict without citekey or quote falls back to not checked', () => {
  const { bin } = workspace();
  const row = settleRow({ citation: 'X', claim: 'x', citekey: 'x2020', verdict: 'supports' }, bin);
  assert.equal(row.verdict, 'not checked');
  assert.match(row.note, /no quote proposed/);
});

test('a paper paperlib does not hold is reported, not trusted', () => {
  const { bin } = workspace();
  const row = settleRow({ citation: 'X', claim: 'x', citekey: 'absent', verdict: 'supports', quote: 'verbatim' }, bin);
  assert.equal(row.verdict, 'not checked');
  assert.match(row.note, /paperlib could not check absent/);
});

test('an unknown verdict is refused', () => {
  const { bin } = workspace();
  assert.throws(() => settleRow({ citation: 'X', claim: 'x', verdict: 'fine' }, bin), /unknown verdict "fine"/);
});

test('the ledger has one row per citation, escapes pipes and states the boundary', () => {
  const { bin } = workspace();
  const ledger = buildLedger(proposal, { paperlib: bin, date: '2026-11-25' });
  const rows = ledger.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(rows.length, 4);
  assert.match(rows[0], /\| supports \| 3, 4 \| “a verbatim sentence” \|/);
  assert.match(rows[1], /\| not checked \| – \| – \|/);
  assert.match(rows[2], /Gamma \\\| pipes\./);
  assert.match(ledger, /proposes; it does not accept/);
  assert.match(ledger, /PDF page/);
  assert.match(ledger, /Draft: manuscript\/draft\.md/);
});

test('the command line writes the ledger file and leaves the draft alone', () => {
  const { dir, bin } = workspace();
  const proposalFile = path.join(dir, 'proposal.json');
  const out = path.join(dir, 'research', 'source-check.md');
  fs.writeFileSync(proposalFile, JSON.stringify(proposal));
  const result = childProcess.spawnSync(process.execPath, [script, proposalFile, '--out', out, '--paperlib', bin], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /\| 1 \| Alpha \(2020\)/);
  assert.match(result.stdout, /4 citations: 1 supports, 0 partly, 0 does not, 1 not found, 2 not checked/);
});

test('the command line refuses without a proposal file', () => {
  const result = childProcess.spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: source-check/);
});

test('the skill drives paperlib, never edits the draft and never grants broad Bash', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'source-check', 'SKILL.md'), 'utf8');
  const tools = /^allowed-tools: (.*)$/m.exec(skill)[1].split(/,\s*(?![^()]*\))/).map((tool) => tool.trim());
  assert.ok(!tools.includes('Bash'), 'bare Bash grants every command');
  assert.ok(!tools.some((tool) => /^Edit\b/.test(tool)), 'the skill has no reason to edit files');
  assert.ok(tools.includes('Bash(paperlib verify-quote:*)'));
  assert.match(skill, /Never edit the draft/);
  assert.match(skill, /Never commit to, push to or open issues on `DSIWI4\/paper-library`/);
  assert.match(skill, /Only a `FOUND` quotation may stand behind a verdict/);
});
