'use strict';

// SQ-203, package 2 of the construct glossary design
// (docs/superpowers/specs/construct-glossary-design.md, § Authorization and
// text binding): accepting an entry is the researcher's act, it binds the
// entry's payload hash, and a failed accept leaves neither a marker without a
// decision nor a decision without its text. Every construct in these fixtures
// is invented for this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const glossary = require('../hooks/lib/glossary');
const seal = require('../hooks/lib/seal');
const canvasLib = require('../hooks/lib/canvas');
const stateLib = require('../hooks/lib/state');
const { mechanicalReview } = require('../hooks/lib/review');
const { acceptGlossaryEntry } = require('../hooks/lib/accept');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');

// The library runs in this process, so the process gets the isolation the CLI
// tests give their children: no ambient project, a private key directory.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
process.env.PLACET_RESEARCH_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');

// A plugin root whose only profile is this fixture's: element 4 depends on
// nothing, so nothing but the case a test is about stops an acceptance. `init`
// runs against the real plugin root, before the canvas is pointed at this one.
function fixturePluginRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-plugin-'));
  const dir = path.join(root, 'references', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'glossary-deps.md'), '# Profile: glossary-deps\n\nA fixture graph.\n\n```graph\n4 <-\n```\n');
  return root;
}

const PROFILE_ROOT = fixturePluginRoot();

function run(root, args, plugin = pluginRoot) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin },
    encoding: 'utf8',
  });
}

const HEADER = '---\nglossary-schema: 1\nmanuscripts: paper.md\n---\n\n';

function entryText(id, changes = {}) {
  const f = {
    term: 'Quiet window',
    definition: "An observer's report that a signal was expected and did not arrive.",
    origin: 'own-definition',
    distinctions: 'Unlike [handoff lag](#handoff-lag), this is an expectation rather than a measured delay.',
    marker: '[proposed]',
    ...changes,
  };
  const lines = [`## ${id}`, '', `Term: ${f.term}`];
  if (f.aliases !== undefined) lines.push(`Aliases: ${f.aliases}`);
  lines.push(`Definition: ${f.definition}`, `Origin: ${f.origin}`, `Distinctions: ${f.distinctions}`);
  if (f.marker !== null) lines.push(f.marker);
  return lines.join('\n');
}

const LAG = entryText('handoff-lag', {
  term: 'Handoff lag',
  definition: 'The interval between a request being made and its next visible acknowledgement.',
  distinctions: 'Unlike [quiet window](#quiet-window), this is measured in time rather than reported as an expectation.',
});

const doc = (...entries) => `${HEADER}${entries.join('\n\n')}\n`;

// The seed fixture with a key on this machine and a glossary holding the two
// fixture entries. `profile: 'is-qualitative'` keeps the shipped graph.
function keyedProject({ profile = 'glossary-deps', glossaryText = doc(entryText('quiet-window'), LAG) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-glossary-accept-'));
  fs.mkdirSync(path.join(root, 'research'));
  for (const f of ['canvas.md', 'decisions.md']) fs.copyFileSync(path.join(fixtureDir, f), path.join(root, 'research', f));
  fs.writeFileSync(path.join(root, 'research', 'glossary.md'), glossaryText);
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  if (profile !== 'is-qualitative') {
    const canvasFile = file(root, 'canvas.md');
    fs.writeFileSync(canvasFile, fs.readFileSync(canvasFile, 'utf8').replace('profile: is-qualitative', `profile: ${profile}`));
  }
  return root;
}

const file = (root, name) => path.join(root, 'research', name);
const read = (root, name) => fs.readFileSync(file(root, name), 'utf8');
const EXPLAINED = 'I accept this because both fieldnotes use the term this way.';
const hashOf = (text, id) => glossary.bindingDigest(glossary.entryById(glossary.parseGlossary(text), id));

function reviewOf(root) {
  const state = stateLib.loadState(root, { pluginRoot: PROFILE_ROOT });
  return mechanicalReview({
    parsed: canvasLib.parseCanvas(state.canvasText),
    graph: state.graph,
    decisionsText: state.decisionsText,
    glossaryText: read(root, 'glossary.md'),
    key: state.key,
  });
}

// The marker line and nothing else is what an acceptance rewrites.
function unmark(text, markerLine, marker) {
  const lines = text.split('\n');
  assert.equal(lines[markerLine - 1], marker, `line ${markerLine} is the marker`);
  lines[markerLine - 1] = '[proposed]';
  return lines.join('\n');
}

test('accepting an entry marks it accepted and seals a DECISION bound to its payload hash', () => {
  const root = keyedProject();
  const before = read(root, 'glossary.md');
  const entry = glossary.entryById(glossary.parseGlossary(before), 'quiet-window');
  const hash = glossary.payloadHash(entry);
  const logBefore = read(root, 'decisions.md');

  const result = acceptGlossaryEntry({
    root,
    id: 'quiet-window',
    why: 'the construct drives the coding',
    explained: EXPLAINED,
    pluginRoot: PROFILE_ROOT,
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.seq, 4, 'the seed log holds #1 to #3');
  assert.equal(result.hash, hash);
  assert.equal(result.was, 'proposed');
  assert.equal(result.term, 'Quiet window');
  assert.deepEqual(result.payload, ['quiet-window', 'Quiet window', null, entry.definition, 'own-definition', entry.distinctions]);

  // The glossary: the marker line moved, every other byte is the file it was.
  const after = read(root, 'glossary.md');
  assert.equal(unmark(after, entry.markerLine, '[accepted]'), before, 'nothing but the marker line changed');
  assert.match(after.slice(after.indexOf('## quiet-window')), /\n\[accepted\]\n/);

  // The log: one DECISION, named by the entry id, holding the payload and the
  // researcher's sentence, sealed and verifiable under this machine's key.
  const log = read(root, 'decisions.md');
  assert.equal(log.slice(0, logBefore.length), logBefore, 'the earlier entries are untouched');
  const entryText = log.slice(log.indexOf('## [#4]'));
  assert.match(entryText, /^## \[#4\] \d{4}-\d{2}-\d{2} · DECISION · glossary quiet-window accepted · text [0-9a-f]{8} · seal [0-9a-f]{16}\n/);
  assert.ok(entryText.includes(`· text ${hash} ·`), 'the entry binds the payload hash');
  assert.ok(entryText.includes(`**Why:** the construct drives the coding`));
  assert.ok(entryText.includes(`**Explained:** ${EXPLAINED}`));
  assert.ok(entryText.includes('**By:** A. Researcher'));
  assert.deepEqual(JSON.parse(entryText.split('\n')[1]), result.payload, 'the body is the accepted payload');
  assert.doesNotMatch(log, /4\.1 accepted/, 'a glossary acceptance is never logged as a canvas acceptance');
  const chain = seal.verifyChain(log, seal.readKey(root));
  assert.ok(chain.verified.has(4), `#4 verifies (${chain.status})`);
});

test('the CLI and the library write the same glossary and decisions.md bytes', () => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };

  const out = run(root, ['glossary', 'accept', 'quiet-window', '--hash', hashOf(before.glossary, 'quiet-window'), '--explained', EXPLAINED], PROFILE_ROOT);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Accepted glossary entry quiet-window \(was \[proposed\]\): Quiet window/);
  assert.match(out.stdout, /Logged as #4 with payload [0-9a-f]{8}/);
  const viaCli = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };

  fs.writeFileSync(file(root, 'glossary.md'), before.glossary);
  fs.writeFileSync(file(root, 'decisions.md'), before.decisions);
  const result = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(result.ok, true, result.error);
  assert.equal(read(root, 'glossary.md'), viaCli.glossary);
  assert.equal(read(root, 'decisions.md'), viaCli.decisions);
});

test('SQ-210: public show binds acceptance to the displayed payload, refusing a rewritten proposal', () => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
  const shown = run(root, ['glossary', 'show', 'quiet-window'], PROFILE_ROOT);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const [payloadText, hashLine] = shown.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(payloadText), ['quiet-window', 'Quiet window', null,
    "An observer's report that a signal was expected and did not arrive.", 'own-definition',
    'Unlike [handoff lag](#handoff-lag), this is an expectation rather than a measured delay.']);
  const oldHash = /^Binding digest: ([0-9a-f]{64})$/.exec(hashLine)?.[1];
  assert.ok(oldHash, 'show prints a full SHA-256 binding digest');
  assert.equal(read(root, 'glossary.md'), before.glossary, 'show is read-only');
  assert.equal(read(root, 'decisions.md'), before.decisions, 'show does not log');

  fs.writeFileSync(file(root, 'glossary.md'), before.glossary.replace("An observer's report", "An observer's expectation"));
  const rewritten = read(root, 'glossary.md');
  const stale = run(root, ['glossary', 'accept', 'quiet-window', '--hash', oldHash, '--explained', EXPLAINED], PROFILE_ROOT);
  assert.equal(stale.status, 1, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /no longer holds the text you saw/);
  assert.equal(read(root, 'glossary.md'), rewritten, 'stale acceptance leaves glossary byte-identical');
  assert.equal(read(root, 'decisions.md'), before.decisions, 'stale acceptance leaves ledger byte-identical');

  const current = run(root, ['glossary', 'show', 'quiet-window'], PROFILE_ROOT);
  assert.equal(current.status, 0, current.stdout);
  const currentHash = /Binding digest: ([0-9a-f]{64})/.exec(current.stdout)[1];
  assert.notEqual(currentHash, oldHash);
  const accepted = run(root, ['glossary', 'accept', 'quiet-window', '--hash', currentHash, '--explained', EXPLAINED], PROFILE_ROOT);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.match(read(root, 'glossary.md'), /\[accepted\]/);
  assert.match(read(root, 'decisions.md'), new RegExp(`glossary quiet-window accepted · text ${currentHash.slice(0, 8)}`));
  assert.ok(seal.verifyChain(read(root, 'decisions.md'), seal.readKey(root)).verified.has(4));
});

test('SQ-212: public acceptance requires the full displayed binding digest', () => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
  for (const hashArgs of [[], ['--hash'], ['--hash', 'wrong'], ['--hash', '12345678'], ['--hash', 'a'.repeat(32)], ['--hash', 'a'.repeat(65)]]) {
    const out = run(root, ['glossary', 'accept', 'quiet-window', ...hashArgs, '--explained', EXPLAINED], PROFILE_ROOT);
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stdout, /--hash/);
    assert.equal(read(root, 'glossary.md'), before.glossary);
    assert.equal(read(root, 'decisions.md'), before.decisions);
  }
});

test('SQ-210: an append I/O failure rolls back the marker and any partial ledger append', (t) => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
  const append = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (target, ...args) => {
    if (target !== file(root, 'decisions.md')) return append(target, ...args);
    append(target, args[0].slice(0, 30));
    throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
  });
  assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }), { code: 'EIO' });
  assert.equal(read(root, 'glossary.md'), before.glossary, 'append failure leaves glossary byte-identical');
  assert.equal(read(root, 'decisions.md'), before.decisions, 'append failure leaves no new DECISION');
});

test('SQ-212: a partial temporary write never exposes a partial glossary', (t) => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (typeof target !== 'string' || !path.basename(target).startsWith('.glossary.md.')) return write(target, ...args);
    write(target, 'partial glossary');
    assert.equal(read(root, 'glossary.md'), before.glossary, 'partial temp bytes never replace the glossary');
    throw Object.assign(new Error('injected glossary write failure'), { code: 'EIO' });
  });
  assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }), { code: 'EIO' });
  assert.equal(read(root, 'glossary.md'), before.glossary, 'a failed temp write leaves the glossary unchanged');
  assert.equal(read(root, 'decisions.md'), before.decisions, 'marker write failure leaves no new DECISION');
  assert.deepEqual(fs.readdirSync(path.dirname(file(root, 'glossary.md'))).filter(n => n.startsWith('.glossary.md.')), [], 'failed atomic writes clean up temporary files');
});

test('an accept without the researcher\'s sentence, or without a known complete entry, writes nothing', () => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
  const attempt = (changes) => acceptGlossaryEntry({ root, explained: EXPLAINED, pluginRoot: PROFILE_ROOT, ...changes });

  assert.equal(attempt({ id: 'quiet-window', explained: undefined }).code, 'explanation-required');
  assert.equal(attempt({ id: 'quiet-window', explained: '   ' }).code, 'explanation-required');
  assert.equal(attempt({ id: 'not an id' }).code, 'invalid');
  assert.equal(attempt({ id: 'wrong-shape' }).code, 'not-found', 'there is no such entry in this glossary');
  assert.equal(attempt({ id: 'quiet-window', expectedHash: 7 }).code, 'invalid');

  // A refusal is not a partial write: both files are the bytes they were.
  assert.equal(read(root, 'glossary.md'), before.glossary);
  assert.equal(read(root, 'decisions.md'), before.decisions);
});

test('an incomplete entry, a dangling origin, an unjudgeable glossary or an already accepted entry each refuse', () => {
  const cases = [
    ['incomplete', doc(entryText('quiet-window', { origin: 'unverified' }), LAG), 'quiet-window'],
    ['origin', doc(entryText('quiet-window', { origin: 'src: notes/absent.md#nowhere' }), LAG), 'quiet-window'],
    ['unjudgeable', doc(entryText('quiet-window'), entryText('quiet-window', { term: 'Quiet window (again)' }), LAG), 'quiet-window'],
    ['already', doc(entryText('quiet-window', { marker: '[accepted]' }), LAG), 'quiet-window'],
  ];
  for (const [code, glossaryText, id] of cases) {
    const root = keyedProject({ glossaryText });
    const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
    const result = acceptGlossaryEntry({ root, id, explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
    assert.equal(result.ok, false, `${code} must refuse`);
    assert.equal(result.code, code, result.error);
    assert.equal(read(root, 'glossary.md'), before.glossary, `${code} left the glossary alone`);
    assert.equal(read(root, 'decisions.md'), before.decisions, `${code} left the log alone`);
  }
});

test('element 4\'s profile dependencies stop a glossary acceptance before anything is written', () => {
  const root = keyedProject({ profile: 'is-qualitative' });
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };

  const result = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dependency');
  assert.match(result.error, /element 4 depends on element 2 is [a-z]+, element 7 is [a-z]+/);
  assert.equal(read(root, 'glossary.md'), before.glossary);
  assert.equal(read(root, 'decisions.md'), before.decisions);

  // The shipped graph is the one that refuses: the same entry, in the same
  // project, accepted once the canvas names the fixture graph instead.
  const canvasFile = file(root, 'canvas.md');
  fs.writeFileSync(canvasFile, fs.readFileSync(canvasFile, 'utf8').replace('profile: is-qualitative', 'profile: glossary-deps'));
  const ok = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(ok.ok, true, ok.error);
});

test('a payload changed since it was displayed is refused as stale, and nothing is written', () => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), decisions: read(root, 'decisions.md') };
  const seen = hashOf(before.glossary, 'quiet-window');
  const other = hashOf(before.glossary, 'handoff-lag');

  const stale = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, expectedHash: other, pluginRoot: PROFILE_ROOT });
  assert.equal(stale.code, 'stale');
  assert.equal(read(root, 'glossary.md'), before.glossary);
  assert.equal(read(root, 'decisions.md'), before.decisions);

  const fresh = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, expectedHash: seen, pluginRoot: PROFILE_ROOT });
  assert.equal(fresh.ok, true, fresh.error);
});

test('no key and a broken chain refuse before the glossary is touched', () => {
  // No key on this machine: the log cannot take a DECISION, so no marker.
  const noKey = keyedProject();
  const noKeyBefore = { glossary: read(noKey, 'glossary.md'), decisions: read(noKey, 'decisions.md') };
  fs.rmSync(seal.keyPath(noKey));
  const refused = acceptGlossaryEntry({ root: noKey, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(refused.code, 'ledger');
  assert.match(refused.error, /No sealing key for this project on this machine/);
  assert.equal(read(noKey, 'glossary.md'), noKeyBefore.glossary);
  assert.equal(read(noKey, 'decisions.md'), noKeyBefore.decisions);

  // A sealed log whose chain is broken: the same refusal, the same silence.
  const broken = keyedProject();
  const first = acceptGlossaryEntry({ root: broken, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(first.ok, true, first.error);
  const tampered = read(broken, 'decisions.md').replace(`text ${first.hash} ·`, `text ${'0'.repeat(8)} ·`);
  fs.writeFileSync(file(broken, 'decisions.md'), tampered);
  const before = read(broken, 'glossary.md');
  const second = acceptGlossaryEntry({ root: broken, id: 'handoff-lag', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(second.code, 'ledger');
  assert.match(second.error, /broken at #4/);
  assert.equal(read(broken, 'decisions.md'), tampered, 'the harness never repairs a ledger');
  assert.equal(read(broken, 'glossary.md'), before);
});

test('review covers an accepted entry only by a verified decision naming its payload', () => {
  // A marker written by hand, with no decision at all: unlogged, no cover.
  const handMade = keyedProject({ glossaryText: doc(entryText('quiet-window', { marker: '[accepted]' }), LAG) });
  let report = reviewOf(handMade);
  assert.equal(report.glossaryStaleAcceptances.length, 0);
  assert.equal(report.glossaryUnloggedAcceptances.length, 1);
  assert.equal(report.glossaryUnloggedAcceptances[0].id, 'quiet-window');
  assert.equal(report.glossaryUnloggedAcceptances[0].coveredBy, null);

  // A DECISION that claims the payload but does not verify gives no cover.
  const forged = keyedProject();
  const entry = glossary.parseGlossary(read(forged, 'glossary.md')).entries[0];
  const hash = glossary.payloadHash(entry);
  fs.appendFileSync(file(forged, 'decisions.md'), `\n## [#4] 2026-10-05 · DECISION · glossary quiet-window accepted · text ${hash}\n${JSON.stringify(glossary.entryPayload(entry))}\n**Explained:** forged\n**By:** A. Researcher\n`);
  fs.writeFileSync(file(forged, 'glossary.md'), doc(entryText('quiet-window', { marker: '[accepted]' }), LAG));
  report = reviewOf(forged);
  assert.equal(report.glossaryUnloggedAcceptances.length, 1);
  assert.deepEqual(report.glossaryUnloggedAcceptances[0].coveredBy, { seq: 4, state: 'legacy' });

  // The real acceptance covers it, and keeps covering exactly that payload.
  const root = keyedProject();
  const accepted = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(accepted.ok, true, accepted.error);
  report = reviewOf(root);
  assert.equal(report.glossaryUnloggedAcceptances.length, 0);
  assert.equal(report.glossaryStaleAcceptances.length, 0);

  const edited = read(root, 'glossary.md').replace("An observer's report", "An observer's expectation");
  fs.writeFileSync(file(root, 'glossary.md'), edited);
  report = reviewOf(root);
  assert.equal(report.glossaryStaleAcceptances.length, 1);
  assert.deepEqual(report.glossaryStaleAcceptances[0], { seq: 4, ref: 'glossary quiet-window accepted', hash: accepted.hash });
  assert.equal(report.glossaryUnloggedAcceptances.length, 1, 'the edited entry answers to no decision');
  assert.equal(report.glossaryUnloggedAcceptances[0].coveredBy, null);
});


test('SQ-212: a short-hash collision cannot accept swapped text with the displayed digest', () => {
  const original = doc(entryText('quiet-window', { definition: 'Invented definition 22373.' }), LAG);
  const swapped = doc(entryText('quiet-window', { definition: 'Invented definition 37527.' }), LAG);
  const a = glossary.parseGlossary(original).entries[0];
  const b = glossary.parseGlossary(swapped).entries[0];
  assert.equal(glossary.payloadHash(a), '13575256', 'the first fixture has the known short hash');
  assert.equal(glossary.payloadHash(b), '13575256', 'the swapped fixture collides in the ledger hash');
  const root = keyedProject({ glossaryText: original });
  const ledger = read(root, 'decisions.md');
  const shown = run(root, ['glossary', 'show', 'quiet-window'], PROFILE_ROOT);
  const digest = /^Binding digest: ([0-9a-f]{64})$/m.exec(shown.stdout)?.[1];
  assert.ok(digest, 'show exposes a full binding digest');
  fs.writeFileSync(file(root, 'glossary.md'), swapped);
  const out = run(root, ['glossary', 'accept', 'quiet-window', '--hash', digest, '--explained', EXPLAINED], PROFILE_ROOT);
  assert.equal(out.status, 1, 'swapped colliding payload is refused as stale');
  assert.equal(read(root, 'glossary.md'), swapped, 'collision refusal preserves the swapped proposal');
  assert.equal(read(root, 'decisions.md'), ledger, 'collision refusal does not append a decision');
});

test('SQ-218: review rejects verified cover when the live payload collides with the accepted hash', () => {
  const original = doc(entryText('quiet-window', { definition: 'Invented definition 22373.' }), LAG);
  const root = keyedProject({ glossaryText: original });
  const accepted = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(accepted.ok, true, accepted.error);
  assert.equal(accepted.hash, '13575256');
  assert.equal(reviewOf(root).glossaryAcceptances.length, 1, 'the original payload has verified cover');
  const ledger = read(root, 'decisions.md');
  const swapped = read(root, 'glossary.md').replace('Invented definition 22373.', 'Invented definition 37527.');
  assert.equal(glossary.payloadHash(glossary.parseGlossary(swapped).entries[0]), '13575256');
  fs.writeFileSync(file(root, 'glossary.md'), swapped);

  const report = reviewOf(root);
  assert.equal(report.ledger.status, 'verified', 'the original sealed decision still verifies');
  assert.equal(report.glossaryAcceptances.length, 0, 'colliding text has no verified cover');
  assert.equal(report.glossaryUnloggedAcceptances[0].coveredBy, null);
  assert.equal(report.glossaryStaleAcceptances[0].seq, 4);
  const out = run(root, ['review'], PROFILE_ROOT);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /quiet-window: definition changed since acceptance/);
  assert.equal(read(root, 'glossary.md'), swapped, 'review preserves the accepted marker and changed payload');
  assert.equal(read(root, 'decisions.md'), ledger, 'review leaves the sealed ledger intact');
});

test('SQ-218: publication refuses a glossary changed while the temporary file was prepared', (t) => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), ledger: read(root, 'decisions.md') };
  // Even an edit to another entry must not be overwritten by acceptance.
  const concurrent = before.glossary.replace('Handoff lag', 'Handoff gap');
  const chmod = fs.chmodSync;
  t.mock.method(fs, 'chmodSync', (target, ...args) => {
    const result = chmod(target, ...args);
    if (typeof target === 'string' && path.basename(target).startsWith('.glossary.md.')) {
      fs.writeFileSync(file(root, 'glossary.md'), concurrent);
    }
    return result;
  });
  // SQ-220: the lost update is a refusal like every other, not a fault — the
  // caller gets the one line the CLI prints, with no usage text behind it.
  const lost = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(lost.ok, false, 'a changed glossary refuses the acceptance');
  assert.equal(lost.code, 'stale');
  assert.equal(lost.usage, undefined, 'a refusal without usage is one line');
  assert.match(lost.error, /glossary.*changed.*nothing is accepted/i);
  assert.equal(read(root, 'glossary.md'), concurrent, 'publication preserves the concurrent edit');
  assert.equal(read(root, 'decisions.md'), before.ledger, 'lost-update refusal adds no DECISION');
  assert.deepEqual(fs.readdirSync(path.dirname(file(root, 'glossary.md'))).filter(n => n.startsWith('.glossary.md.')), [], 'refusal removes the prepared temporary file');
});

// The CLI test below needs the lost-update window open inside a child process.
// NODE_OPTIONS loads this before the CLI, so it edits glossary.md at the moment
// publication sets the temporary file's mode: after the accept read the entry
// and prepared its decision, before the file's bytes are rechecked.
const LOST_UPDATE_PRELOAD = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const chmod = fs.chmodSync;
fs.chmodSync = (target, ...args) => {
  const result = chmod(target, ...args);
  if (typeof target === 'string' && path.basename(target).startsWith('.glossary.md.')) {
    const file = path.join(path.dirname(target), 'glossary.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Quiet window', 'Other window'));
  }
  return result;
};
`;

test('SQ-220: the CLI prints a lost update as one refusal line, not a stack trace', () => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), ledger: read(root, 'decisions.md') };
  const concurrent = before.glossary.replace('Quiet window', 'Other window');
  const preload = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-preload-')), 'lost-update.js');
  fs.writeFileSync(preload, LOST_UPDATE_PRELOAD);
  const out = childProcess.spawnSync(
    process.execPath,
    [cli, 'glossary', 'accept', 'quiet-window', '--hash', hashOf(before.glossary, 'quiet-window'), '--explained', EXPLAINED],
    { cwd: root, env: { ...process.env, CLAUDE_PLUGIN_ROOT: PROFILE_ROOT, NODE_OPTIONS: `--require ${preload}` }, encoding: 'utf8' },
  );
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.equal(out.stderr, '', 'a refusal is not a stack trace');
  assert.equal(out.stdout.trim(), 'The glossary changed during acceptance; reload and look again. Nothing is accepted.', 'exactly one refusal line on stdout');
  assert.equal(read(root, 'glossary.md'), concurrent, 'the concurrent edit stands untouched');
  assert.equal(read(root, 'decisions.md'), before.ledger, 'nothing is appended to the ledger');
  assert.deepEqual(fs.readdirSync(path.dirname(file(root, 'glossary.md'))).filter(n => n.startsWith('.glossary.md.')), [], 'the prepared temporary file is removed');
});

test('SQ-220: two headings sharing an id give cover to neither, even when the first collides', () => {
  const original = doc(entryText('quiet-window', { definition: 'Invented definition 22373.' }), LAG);
  const root = keyedProject({ glossaryText: original });
  const accepted = acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(accepted.ok, true, accepted.error);
  // The same id twice: a colliding swap of the accepted payload first, the
  // accepted payload itself last — the order under which the last heading
  // decides what the sealed body is compared with.
  const duplicated = doc(
    entryText('quiet-window', { definition: 'Invented definition 37527.', marker: '[accepted]' }),
    entryText('quiet-window', { definition: 'Invented definition 22373.', marker: '[accepted]' }),
    LAG,
  );
  const readings = glossary.parseGlossary(duplicated).entries.filter((e) => e.id === 'quiet-window');
  assert.equal(readings.length, 2, 'the fixture has two headings with the id');
  assert.equal(glossary.payloadHash(readings[0]), accepted.hash, 'the swapped payload collides in the ledger hash');
  assert.notEqual(JSON.stringify(glossary.entryPayload(readings[0])), JSON.stringify(glossary.entryPayload(readings[1])), 'and it is a different payload');

  fs.writeFileSync(file(root, 'glossary.md'), duplicated);
  const report = reviewOf(root);
  assert.equal(report.glossaryAcceptances.length, 0, 'a duplicated id covers none of its blocks');
  assert.equal(report.glossaryUnloggedAcceptances.length, 2, 'both readings are unlogged');
  for (const a of report.glossaryUnloggedAcceptances) assert.equal(a.coveredBy, null, 'neither reading has cover');
  assert.equal(report.glossaryStaleAcceptances.length, 0, 'the accepted payload itself did not move');
});

test('SQ-212: glossary publication replaces the file atomically by rename', (t) => {
  const root = keyedProject();
  fs.chmodSync(file(root, 'glossary.md'), 0o660);
  const before = read(root, 'glossary.md');
  const fd = fs.openSync(file(root, 'glossary.md'), 'r');
  t.after(() => fs.closeSync(fd));
  const rename = fs.renameSync;
  let published = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file(root, 'glossary.md')) {
      assert.equal(read(root, 'glossary.md'), before, 'the original stays complete until rename');
      assert.match(fs.readFileSync(from, 'utf8'), /\[accepted\]/, 'rename publishes a complete accepted document');
      published = true;
    }
    return rename(from, to);
  });
  assert.equal(acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }).ok, true);
  assert.equal(published, true, 'publication uses rename');
  assert.equal(fs.statSync(file(root, 'glossary.md')).mode & 0o777, 0o660, 'atomic publication preserves original permission bits');
  assert.equal(fs.readFileSync(fd, 'utf8'), before, 'the old inode was never overwritten in place');
});

test('SQ-212: ledger rollback precedes a failing glossary restore', (t) => {
  const root = keyedProject();
  const before = read(root, 'decisions.md');
  const append = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (target, bytes, ...args) => {
    if (target !== file(root, 'decisions.md')) return append(target, bytes, ...args);
    append(target, bytes.slice(0, 40));
    throw new Error('injected append failure');
  });
  const rename = fs.renameSync;
  let publications = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file(root, 'glossary.md') && ++publications === 2) {
      assert.equal(read(root, 'decisions.md'), before, 'ledger is truncated before attempting glossary restore');
      throw new Error('injected restore failure');
    }
    return rename(from, to);
  });
  assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }));
  assert.equal(publications, 2, 'rollback attempted the atomic glossary restore');
  assert.equal(read(root, 'decisions.md'), before, 'a restore failure cannot skip ledger rollback');
});

for (const interference of ['extra append', 'same-size rewrite']) {
  test('SQ-212: ledger rollback preserves a concurrent ' + interference, (t) => {
    const root = keyedProject();
    const append = fs.appendFileSync;
    let concurrent;
    t.mock.method(fs, 'appendFileSync', (target, bytes, ...args) => {
      if (target !== file(root, 'decisions.md')) return append(target, bytes, ...args);
      append(target, bytes);
      if (interference === 'extra append') append(target, 'foreign writer');
      else fs.writeFileSync(target, read(root, 'decisions.md').slice(0, -1) + '!');
      concurrent = read(root, 'decisions.md');
      throw new Error('injected append failure after concurrent change');
    });
    assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }));
    assert.equal(read(root, 'decisions.md'), concurrent, 'rollback does not truncate foreign ledger bytes');
  });
}

test('SQ-212: glossary rollback preserves a concurrent same-size rewrite', (t) => {
  const root = keyedProject();
  const ledger = read(root, 'decisions.md');
  const append = fs.appendFileSync;
  let concurrent;
  t.mock.method(fs, 'appendFileSync', (target, bytes, ...args) => {
    if (target !== file(root, 'decisions.md')) return append(target, bytes, ...args);
    append(target, bytes.slice(0, 40));
    concurrent = read(root, 'glossary.md').replace('Quiet window', 'Other window');
    fs.writeFileSync(file(root, 'glossary.md'), concurrent);
    throw new Error('injected append failure after glossary changed');
  });
  assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }));
  assert.equal(read(root, 'glossary.md'), concurrent, 'rollback does not restore over foreign glossary bytes');
  assert.equal(read(root, 'decisions.md'), ledger, 'owned partial ledger bytes are still removed');
});

test('SQ-212: review labels the marker-only crash window unlogged, not a glossary acceptance', () => {
  const root = keyedProject({ glossaryText: doc(entryText('quiet-window', { marker: '[accepted]' }), LAG) });
  const out = run(root, ['review'], PROFILE_ROOT);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const logged = /## Glossary acceptances\n([\s\S]*?)(?=\n## |$)/.exec(out.stdout)?.[1];
  const unlogged = /## Unlogged glossary acceptances\n([\s\S]*?)(?=\n## |$)/.exec(out.stdout)?.[1];
  assert.equal(logged?.trim(), 'none', 'marker-only entry is excluded from Glossary acceptances');
  assert.match(unlogged || '', /quiet-window.*unlogged/, 'marker-only entry is explicitly labeled unlogged');

  // Follow the skill's recovery: reset only the marker, show and read again,
  // then make a new acceptance rather than fabricating a missing decision.
  fs.writeFileSync(file(root, 'glossary.md'), read(root, 'glossary.md').replace('[accepted]', '[proposed]'));
  const shown = run(root, ['glossary', 'show', 'quiet-window'], PROFILE_ROOT);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  const digest = /^Binding digest: ([0-9a-f]{64})$/m.exec(shown.stdout)?.[1];
  assert.ok(digest);
  const recovered = run(root, ['glossary', 'accept', 'quiet-window', '--hash', digest, '--explained', EXPLAINED], PROFILE_ROOT);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.equal(reviewOf(root).glossaryAcceptances.length, 1, 'reset/show/accept restores verified cover');
  assert.equal(reviewOf(root).glossaryUnloggedAcceptances.length, 0);
});


test('SQ-212: rollback rechecks ledger size after reading its bytes', (t) => {
  const root = keyedProject();
  const append = fs.appendFileSync;
  const stat = fs.statSync;
  let rollingBack = false;
  let concurrent;
  t.mock.method(fs, 'appendFileSync', (target, bytes, ...args) => {
    if (target !== file(root, 'decisions.md')) return append(target, bytes, ...args);
    append(target, bytes.slice(0, 40));
    rollingBack = true;
    throw new Error('injected append failure');
  });
  t.mock.method(fs, 'statSync', (target, ...args) => {
    if (rollingBack && target === file(root, 'decisions.md')) {
      append(target, 'foreign bytes after rollback read');
      concurrent = read(root, 'decisions.md');
    }
    return stat(target, ...args);
  });
  assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }));
  assert.equal(read(root, 'decisions.md'), concurrent, 'a changed ledger size refuses truncation');
});

test('SQ-212: a failed publication rename leaves both files unchanged', (t) => {
  const root = keyedProject();
  const before = { glossary: read(root, 'glossary.md'), ledger: read(root, 'decisions.md') };
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); });
  assert.throws(() => acceptGlossaryEntry({ root, id: 'quiet-window', explained: EXPLAINED, pluginRoot: PROFILE_ROOT }), { code: 'EIO' });
  assert.equal(read(root, 'glossary.md'), before.glossary, 'failed rename keeps the original complete document');
  assert.equal(read(root, 'decisions.md'), before.ledger, 'failed publication does not append a DECISION');
  assert.deepEqual(fs.readdirSync(path.dirname(file(root, 'glossary.md'))).filter(n => n.startsWith('.glossary.md.')), [], 'rename failure cleans up its temporary file');
});
