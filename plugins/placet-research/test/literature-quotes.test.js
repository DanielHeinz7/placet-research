'use strict';

// SQ-214, package 2 of docs/superpowers/specs/literature-note-design.md: the
// fail-closed quotation check. The paper pages come from the invented PDFs in
// test/fixtures/literature-note (extracted by scripts/extract-paper.py), and the
// note fixtures beside them were written for these tests; no publisher text is
// involved.
//
// The assertions are the named ones from the design's package 2: exact
// normalized wording matches the claimed mapped page, wrong page and invented
// word fail, malformed and empty quote inventories cannot pass, substring and
// changed word boundaries fail, reversed stitched runs and page zero fail, a
// repeated passage matches its cited page, Unicode words remain distinct,
// unsupported omissions and page ranges require inspection, and note or source
// edits invalidate a prior result.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const checker = path.join(pluginRoot, 'scripts', 'verify-quotes.py');
const extractor = path.join(pluginRoot, 'scripts', 'extract-paper.py');
const fixtures = path.join(__dirname, 'fixtures', 'literature-note');
const notes = path.join(fixtures, 'quote-notes');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rh-quotes-'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pdf = (name) => path.join(fixtures, name);
const note = (name) => path.join(notes, name);
const pageMap = (dir, stem) => path.join(dir, `${stem}.page-map.json`);
const report = (out, stem) => readJson(path.join(out, `${stem}.quote-check.json`));
const statuses = (rep) => rep.quotations.map((quotation) => quotation.status);

// `python3` is the entry point for both scripts; if it is missing the spawn
// itself reports it, and a missing tool must not read as a passing check.
function run(script, args, options = {}) {
  const out = childProcess.spawnSync(process.env.PYTHON || 'python3', [script, ...args], {
    cwd: options.cwd || fixtures,
    encoding: 'utf8',
    env: options.env || process.env,
  });
  if (out.error) assert.fail(`python3 could not be started: ${out.error.message}`);
  return out;
}

function extract(out, source, args = ['--offset', '40']) {
  const done = run(extractor, [pdf(source), ...args, '--out', out]);
  assert.equal(done.status, 0, `extraction of ${source} failed: ${done.stdout}${done.stderr}`);
  return out;
}

// One extraction per paper for the assertions that only read it.
const papers = new Map();
function paper(source, args = ['--offset', '40']) {
  const key = [source, ...args].join(' ');
  if (!papers.has(key)) papers.set(key, extract(scratch(), source, args));
  return papers.get(key);
}

const check = (notePath, out, mapPath) => run(checker, [notePath, '--page-map', mapPath, '--out', out]);

test('exact normalized wording matches the claimed mapped page', () => {
  const out = scratch();
  const dir = paper('regular.pdf');
  const done = check(note('exact.md'), out, pageMap(dir, 'regular'));

  assert.equal(done.status, 0, done.stdout + done.stderr);
  const rep = report(out, 'exact');
  assert.equal(rep.schema, 'literature-note/quote-check@1');
  assert.equal(rep.result, 'verified');
  assert.deepEqual(rep.inventory, { found: 4, parsed: 4, checked: 4, rejected: 0 });
  assert.deepEqual(statuses(rep), ['verified', 'verified', 'verified', 'verified']);
  assert.deepEqual(rep.quotations.map((q) => q.printed), [42, 41, 41, 43]);
  assert.deepEqual(rep.quotations.map((q) => q.physical), [2, 1, 1, 3]);

  // The result is bound to the note, the extraction, the PDF and the map it was
  // checked against.
  assert.equal(rep.noteSha256, sha256(note('exact.md')));
  assert.equal(rep.extractionSha256, sha256(path.join(dir, 'regular.full.txt')));
  assert.equal(rep.pageMapSha256, sha256(pageMap(dir, 'regular')));
  assert.equal(rep.pdfSha256, sha256(pdf('regular.pdf')));

  // The download banner is in the full extraction and gone from the lossy
  // request view, so quoting it proves the check read the page's own text.
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'regular.request.txt'), 'utf8'), /example\.invalid/);

  // The inventory and the narrow disclaimer are reported on success too.
  assert.match(done.stdout, /^ok: 4 quotations verified on their claimed printed pages$/m);
  assert.match(done.stdout, /quotations: 4 found, 4 parsed, 4 checked, 0 rejected/);
  assert.match(done.stdout, /does not accept a research claim/);
  assert.match(rep.disclaimer, /remain \[proposed\] for human review/);
});

test('wrong page and invented word fail', () => {
  const out = scratch();
  const dir = paper('regular.pdf');
  const done = check(note('mismatch.md'), out, pageMap(dir, 'regular'));

  assert.equal(done.status, 1, done.stdout + done.stderr);
  const rep = report(out, 'mismatch');
  assert.equal(rep.result, 'failed');
  assert.deepEqual(statuses(rep), ['failed', 'failed', 'rejected']);

  const [wrongPage, inventedWord, unmapped] = rep.quotations;
  // A passage from printed page 42, claimed on page 41: the check reads the
  // page the note claims and never searches the rest of the paper.
  assert.deepEqual([wrongPage.printed, wrongPage.physical], [41, 1]);
  assert.match(wrongPage.reason, /not in the source text of printed page 41 \(physical page 1\)/);
  // One invented word in an otherwise verbatim passage.
  assert.deepEqual([inventedWord.printed, inventedWord.physical], [41, 1]);
  assert.match(inventedWord.reason, /not in the source text of printed page 41/);
  // A page the map does not number is refused, not guessed at.
  assert.match(unmapped.reason, /printed page 99 is not in the page map/);

  // Every failed quotation is reported with its note location and reason.
  assert.match(done.stderr, new RegExp(`line ${wrongPage.line} \\(p\\. 41\\): not in the source text`));
});

test('malformed and empty quote inventories cannot pass', () => {
  const dir = paper('regular.pdf');

  const malformedOut = scratch();
  const malformed = check(note('malformed.md'), malformedOut, pageMap(dir, 'regular'));
  assert.equal(malformed.status, 1, malformed.stdout + malformed.stderr);
  const rep = report(malformedOut, 'malformed');
  assert.equal(rep.result, 'failed');
  assert.deepEqual(rep.inventory, { found: 4, parsed: 0, checked: 0, rejected: 4 });
  assert.match(rep.quotations[0].reason, /a blockquote outside the quotation section/);
  assert.match(rep.quotations[1].reason, /not a quotation block: expected > "\.\.\." \(p\. N\)/);
  assert.match(rep.quotations[2].reason, /not a quotation block/);
  assert.match(rep.quotations[3].reason, /an inline quotation; the note template allows the blockquote form/);

  // A quotation section with nothing in it is "not checked", never green.
  const emptyOut = scratch();
  const empty = check(note('empty.md'), emptyOut, pageMap(dir, 'regular'));
  assert.equal(empty.status, 1, 'an empty quotation section must not pass');
  assert.match(empty.stdout, /^not checked: no quotations$/m);
  assert.match(empty.stdout, /that is not a passing check/);
  const emptyRep = report(emptyOut, 'empty');
  assert.equal(emptyRep.result, 'not-checked');
  assert.deepEqual(emptyRep.inventory, { found: 0, parsed: 0, checked: 0, rejected: 0 });
});

test('substring and changed word boundaries fail', () => {
  const out = scratch();
  const dir = paper('verbatim.pdf');
  const done = check(note('boundaries.md'), out, pageMap(dir, 'verbatim'));

  assert.equal(done.status, 1, done.stdout + done.stderr);
  const rep = report(out, 'boundaries');
  assert.deepEqual(statuses(rep), ['failed', 'failed', 'verified']);
  // `art` is inside `cart` and `car t` squashes back into it; neither is the
  // word the page carries, and neither may pass as a quotation.
  assert.match(rep.quotations[0].reason, /not in the source text of printed page 41/);
  assert.match(rep.quotations[1].reason, /not in the source text of printed page 41/);
  // The word itself is on the page, so the two failures are about the boundary
  // and the substring rather than about a page the check cannot read.
  assert.deepEqual([rep.quotations[2].printed, rep.quotations[2].physical], [41, 1]);
});

test('reversed stitched runs and page zero fail', () => {
  const out = scratch();
  const dir = paper('regular.pdf');
  const done = check(note('stitched.md'), out, pageMap(dir, 'regular'));

  assert.equal(done.status, 1, done.stdout + done.stderr);
  const rep = report(out, 'stitched');
  assert.deepEqual(statuses(rep), ['failed', 'rejected']);
  // The same words as the page, stitched in a different order.
  assert.match(rep.quotations[0].reason, /not in the source text of printed page 42/);
  assert.deepEqual([rep.quotations[0].printed, rep.quotations[0].physical], [42, 2]);
  assert.match(rep.quotations[1].reason, /page 0 is not a printed page/);
});

test('repeated passage matches its cited page', () => {
  const out = scratch();
  const dir = paper('repeated-body.pdf');
  const done = check(note('repeated.md'), out, pageMap(dir, 'repeated-body'));

  assert.equal(done.status, 0, done.stdout + done.stderr);
  const rep = report(out, 'repeated');
  assert.equal(rep.result, 'verified');
  assert.deepEqual(statuses(rep), ['verified', 'verified']);
  // The sentence is body text on all three pages: the check reads the page the
  // note claims and never assigns the first occurrence's page.
  assert.deepEqual(rep.quotations.map((q) => [q.printed, q.physical]), [[42, 2], [43, 3]]);
});

test('Unicode words remain distinct', () => {
  const out = scratch();
  const dir = paper('verbatim.pdf');
  const done = check(note('unicode.md'), out, pageMap(dir, 'verbatim'));

  assert.equal(done.status, 1, done.stdout + done.stderr);
  const rep = report(out, 'unicode');
  assert.deepEqual(statuses(rep), ['verified', 'failed', 'failed', 'verified']);

  // The page carries those words, so the failures below are the comparison's.
  const full = fs.readFileSync(path.join(dir, 'verbatim.full.txt'), 'utf8');
  assert.match(full, /café’s reading room/);
  assert.match(full, /naïve committee/);

  // Normalization folds the typographic apostrophe, the ligature and the em
  // dash — and nothing else. `cafe` is not `café` and `naive` is not `naïve`.
  assert.match(rep.quotations[1].reason, /not in the source text of printed page 41/);
  assert.match(rep.quotations[2].reason, /not in the source text of printed page 41/);
  assert.deepEqual(
    rep.quotations.map((q) => q.printed),
    [41, 41, 41, 41]
  );
});

test('unsupported omissions and page ranges require inspection', () => {
  const out = scratch();
  const dir = paper('regular.pdf');
  const done = check(note('unsupported.md'), out, pageMap(dir, 'regular'));

  assert.equal(done.status, 1, done.stdout + done.stderr);
  const rep = report(out, 'unsupported');
  assert.deepEqual(statuses(rep), ['rejected', 'rejected']);
  assert.deepEqual(rep.inventory, { found: 2, parsed: 0, checked: 0, rejected: 2 });
  assert.match(rep.quotations[0].reason, /an omission \(an ellipsis\) requires manual inspection/);
  assert.match(rep.quotations[1].reason, /a page range \(pp\.\) requires manual inspection/);
});

test('note or source edits invalidate a prior result', () => {
  const work = scratch();
  const dir = extract(scratch(), 'regular.pdf');
  const edited = path.join(work, 'exact.md');
  fs.copyFileSync(note('exact.md'), edited);
  const map = pageMap(dir, 'regular');

  const first = check(edited, work, map);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const reportPath = path.join(work, 'exact.quote-check.json');
  const fresh = run(checker, ['--verify', reportPath]);
  assert.equal(fresh.status, 0, 'a fresh report did not verify');

  // A corrected page number is an edit to the note: the recorded result no
  // longer covers what the note says.
  fs.writeFileSync(edited, fs.readFileSync(note('exact.md'), 'utf8').replace('(p. 42)', '(p. 43)'));
  const afterNote = run(checker, ['--verify', reportPath]);
  assert.equal(afterNote.status, 5, afterNote.stdout + afterNote.stderr);
  assert.match(afterNote.stderr, /the note changed since this report was written/);

  // And re-checking the edited note is a fresh check that fails on its own
  // terms rather than inheriting the earlier green result.
  const rechecked = check(edited, scratch(), map);
  assert.equal(rechecked.status, 1, 'the edited note still passed');
  assert.match(rechecked.stdout, /failed: 1 of 4 quotations/);

  fs.writeFileSync(edited, fs.readFileSync(note('exact.md'), 'utf8'));
  fs.appendFileSync(path.join(dir, 'regular.full.txt'), '\nedited\n');
  const afterSource = run(checker, ['--verify', reportPath]);
  assert.equal(afterSource.status, 5, afterSource.stdout + afterSource.stderr);
  assert.match(afterSource.stderr, /the full extraction changed since this report was written/);

  // A changed extraction is refused outright, not silently re-checked.
  const unbound = check(edited, scratch(), map);
  assert.equal(unbound.status, 5, unbound.stdout + unbound.stderr);
  assert.match(unbound.stderr, /not the one the page map recorded/);
});

test('a page map without printed pages refuses the check', () => {
  const out = scratch();
  const dir = paper('regular.pdf', []);
  const done = check(note('exact.md'), out, pageMap(dir, 'regular'));

  assert.equal(done.status, 4, done.stdout + done.stderr);
  assert.match(done.stderr, /establishes no printed pages/);
  assert.ok(
    !fs.existsSync(path.join(out, 'exact.quote-check.json')),
    'a refused run still wrote a quote report'
  );
});
