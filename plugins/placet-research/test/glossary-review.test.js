'use strict';

// SQ-204, package 3 of the construct glossary design
// (docs/superpowers/specs/construct-glossary-design.md, § Mechanical review and
// its limits): the read-only `review` gains a `Glossary mechanics` group. What
// it can decide is entry structure and provenance, declared canvas coverage in
// elements 3, 4, 7 and 8, declared manuscript coverage, the lexical cross-check
// and accepted text stability. What it cannot decide — whether a definition
// fits the study, whether an undeclared construct appeared — is printed with
// every report, and a check that could not run says `not checked`, never zero
// findings. Every construct in these fixtures (speaking frequency, dissent,
// proposal uptake, felt safety) is invented for this file and supports no
// empirical claim.

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
const fixtureDir = path.join(__dirname, 'fixtures', 'construct-glossary');
const EXPLAINED = 'I accept this because the fieldnotes use the term this way.';

// The library runs in this process, so the process gets the isolation the CLI
// tests give their children: no ambient project, a private key directory.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
process.env.PLACET_RESEARCH_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');

// A plugin root whose only profile is this fixture's: element 4 depends on
// nothing, so nothing but the case a test is about stops an acceptance. `init`
// runs against the real plugin root, before the canvas points here.
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

const file = (root, name) => path.join(root, name);
const read = (root, name) => fs.readFileSync(file(root, name), 'utf8');
const write = (root, name, text) => fs.writeFileSync(file(root, name), text);

// A copy of the fixture project with a key of its own, pointed at the
// no-dependency profile. The copy is what tests edit; the fixture stays clean.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-glossary-review-'));
  for (const name of fs.readdirSync(fixtureDir)) {
    fs.cpSync(path.join(fixtureDir, name), path.join(root, name), { recursive: true });
  }
  const out = run(root, ['init', '--project', 'construct-glossary', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  write(root, 'research/canvas.md', read(root, 'research/canvas.md').replace('profile: is-qualitative', 'profile: glossary-deps'));
  return root;
}

// The first occurrence of `from` is replaced; a test that edits a line it did
// not find would otherwise pass on a fixture that no longer says it.
function edit(root, name, from, to) {
  const text = read(root, name);
  assert.ok(text.includes(from), `the fixture holds ${JSON.stringify(from)}`);
  write(root, name, text.replace(from, to));
}

const review = (root) => {
  const out = run(root, ['review'], PROFILE_ROOT);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return out.stdout;
};

// The library call the CLI makes, so a test can read the structured group
// instead of matching lines of text.
function mechanicsOf(root, overrides = {}) {
  const state = stateLib.loadState(root, { pluginRoot: PROFILE_ROOT });
  assert.equal(state.error, undefined, state.error);
  const report = mechanicalReview({
    parsed: canvasLib.parseCanvas(state.canvasText),
    graph: state.graph,
    checks: state.checks,
    decisionsText: state.decisionsText,
    glossaryText: 'glossaryText' in overrides ? overrides.glossaryText : read(root, 'research/glossary.md'),
    key: 'key' in overrides ? overrides.key : state.key,
    root,
    stateDir: path.dirname(state.paths.canvas),
    canvasFile: state.paths.canvas,
    glossaryFile: state.paths.glossary,
    glossaryReadError: overrides.glossaryReadError || null,
  });
  return report.glossaryMechanics;
}

function accept(root, id) {
  const result = acceptGlossaryEntry({ root, id, why: 'the construct drives the coding', explained: EXPLAINED, pluginRoot: PROFILE_ROOT });
  assert.equal(result.ok, true, result.error);
  return result;
}

const FIXTURE_FILES = ['research/canvas.md', 'research/glossary.md', 'research/decisions.md', 'paper.md', 'sections/theory.md'];
const snapshot = (root) => Object.fromEntries(FIXTURE_FILES.map((name) => [name, read(root, name)]));

const entryRow = (id, line) => ({ id, line, marker: 'proposed', state: 'proposed', incomplete: [] });
const whereOf = (list) => list.map((l) => l.where);

// The statements of the fixture that cite this entry, in canvas order, then
// the manuscript locations.
const PROPOSAL_UPTAKE_DEPENDENTS = ['3.1', '3.3', '4.2', '4.3', '7.1', '8.2', '8.3', 'paper.md', 'sections/theory.md'];

test('a clean fixture prints the inspected files, the bounded inventory and both boundary sentences', () => {
  const root = project();
  const before = snapshot(root);
  const g = mechanicsOf(root);

  assert.deepEqual(g.notChecked, []);
  assert.deepEqual(g.inspected, [
    { path: 'research/glossary.md', status: 'read' },
    { path: 'research/canvas.md', status: 'read' },
    { path: 'sources/interview-guide.md', status: 'read' },
    { path: 'paper.md', status: 'read' },
    { path: 'sections/theory.md', status: 'read' },
  ]);
  assert.deepEqual(g.structure.entries, [
    entryRow('speaking-frequency', 6),
    entryRow('dissent', 15),
    entryRow('proposal-uptake', 24),
    entryRow('felt-safety', 33),
  ]);
  assert.deepEqual(g.structure.findings, []);

  // Every reference in elements 3, 4, 7 and 8 resolves, and an existing
  // proposal counts as an entry.
  assert.deepEqual(g.canvas.findings, []);
  assert.deepEqual(g.canvas.statements.map((s) => s.question),
    ['3.1', '3.3', '4.1', '4.1', '4.1', '4.2', '4.2', '4.3', '7.1', '7.1', '7.2', '8.1', '8.2', '8.3']);
  for (const s of g.canvas.statements) for (const r of s.refs) assert.equal(r.state, 'proposed', JSON.stringify(r));

  // All four voice entries across the declared manuscripts: links in the
  // introduction and the nested theory section, and hidden declarations too.
  assert.deepEqual(g.manuscripts.declared, ['paper.md', 'sections/theory.md']);
  assert.deepEqual(g.manuscripts.references.map((r) => `${r.path}:${r.line}:${r.kind}:${r.id}`), [
    'paper.md:11:link:proposal-uptake',
    'paper.md:13:link:dissent',
    'paper.md:15:link:felt-safety',
    'paper.md:20:declaration:speaking-frequency',
    'sections/theory.md:4:link:speaking-frequency',
    'sections/theory.md:12:link:proposal-uptake',
    'sections/theory.md:17:link:felt-safety',
    'sections/theory.md:9:declaration:dissent',
  ]);
  assert.deepEqual(g.manuscripts.notChecked, []);
  assert.deepEqual(g.manuscripts.findings, []);

  // The lexical cross-check reads the fixture's prose, and the fixture puts
  // label words in the three regions it must not read: a fenced code example,
  // a bibliography and a link destination.
  assert.equal(g.lexical.checked, true);
  const paper = read(root, 'paper.md');
  assert.ok(paper.includes('uptake = 1 if a later meeting revisits the proposal, else 0'));
  assert.ok(paper.includes('Uptake in organizational talk.'));
  assert.ok(paper.includes('https://osf.example/registrations/uptake-2026'));
  assert.deepEqual(g.lexical.occurrences, []);
  assert.deepEqual(g.stability, []);

  const out = review(root);
  assert.match(out, /## Glossary mechanics\nInspected: research\/glossary\.md \(read\), research\/canvas\.md \(read\), sources\/interview-guide\.md \(read\), paper\.md \(read\), sections\/theory\.md \(read\)\n/);
  assert.ok(out.includes('Declared construct coverage checked; undeclared constructs require human inspection.'));
  assert.ok(out.includes('Human construct judgment: not performed by this check'));
  assert.ok(out.includes('4 entries: speaking-frequency [proposed], dissent [proposed], proposal-uptake [proposed], felt-safety [proposed]'));
  assert.ok(out.includes('declared: paper.md; sections/theory.md'));
  assert.ok(!out.includes('not checked:'), 'a clean run claims nothing as not checked');

  // Read-only, all the way through: the run leaves every input byte as it was.
  assert.deepEqual(snapshot(root), before);
});

test('an unknown id fails resolution in elements 3, 4, 7 and 8, naming question, statement and id', () => {
  const root = project();
  edit(root, 'research/canvas.md', '[stated, src: glossary.md#proposal-uptake]', '[stated, src: glossary.md#turn-taking]');
  edit(root, 'research/canvas.md', '[proposed, src: glossary.md#speaking-frequency, src: glossary.md#dissent]', '[proposed, src: glossary.md#turn-share, src: glossary.md#dissent]');
  edit(root, 'research/canvas.md', 'The members who spoke most often were not the ones whose objections were recorded. [stated, src: glossary.md#speaking-frequency]', 'The members who spoke most often were not the ones whose objections were recorded. [stated, src: glossary.md#turns-counted]');
  edit(root, 'research/canvas.md', 'after the meeting ends. [stated, src: glossary.md#proposal-uptake]', 'after the meeting ends. [stated, src: glossary.md#afterlife]');

  const g = mechanicsOf(root);
  assert.deepEqual(g.canvas.findings.map((f) => `${f.question}:${f.id}`),
    ['3.1:turn-taking', '4.2:turn-share', '7.1:turns-counted', '8.3:afterlife']);
  for (const f of g.canvas.findings) assert.match(f.reason, /^no entry has the id /);
  assert.equal(g.manuscripts.findings.length, 0);
  assert.deepEqual(g.lexical.occurrences, [], 'the fixture prose is untouched by the canvas edits');

  const out = review(root);
  assert.ok(out.includes('3.1 [stated] (line 46): Which meeting conditions separate a proposal that is taken up later from one that is not? — cites turn-taking — no entry has the id "turn-taking"'));
  assert.equal(out.split('no entry has the id').length - 1, 4, 'four unresolved ids, one line each');
});

test('a pending definition stays visible as incomplete at every reference', () => {
  const root = project();
  edit(root, 'research/glossary.md',
    'Definition: The extent to which a proposal made in one meeting becomes a topic of work in a later one.',
    'Definition: pending');

  const g = mechanicsOf(root);
  assert.deepEqual(g.structure.entries[2], { id: 'proposal-uptake', line: 24, marker: 'proposed', state: 'proposed, incomplete: definition is pending', incomplete: ['definition is pending'] });
  assert.deepEqual(g.structure.findings, [{ id: 'proposal-uptake', line: 24, text: 'definition is pending' }]);
  const refs = g.canvas.statements.flatMap((s) => s.refs).filter((r) => r.id === 'proposal-uptake');
  assert.ok(refs.length >= 7);
  for (const r of refs) assert.equal(r.state, 'proposed, incomplete: definition is pending');
  const linked = g.manuscripts.references.filter((r) => r.id === 'proposal-uptake');
  for (const r of linked) assert.equal(r.state, 'proposed, incomplete: definition is pending');

  const out = review(root);
  assert.ok(out.includes('- proposal-uptake: line 24: definition is pending'));
  assert.ok(out.includes('proposal-uptake [proposed, incomplete: definition is pending]'));
});

test('entry structure reports a missing source, a duplicated field and a missing definition', () => {
  const root = project();

  edit(root, 'research/glossary.md', 'Origin: src: sources/interview-guide.md#turns', 'Origin: src: sources/field-notes.md#turns');
  let g = mechanicsOf(root);
  assert.deepEqual(g.structure.findings, [
    { id: 'speaking-frequency', line: 6, text: 'Origin src: sources/field-notes.md#turns — "sources/field-notes.md" does not exist' },
  ]);
  assert.ok(g.inspected.some((f) => f.path === 'sources/field-notes.md' && f.status === 'missing'));
  let out = review(root);
  assert.ok(out.includes('sources/field-notes.md (missing)'));
  assert.ok(out.includes('- speaking-frequency: line 6: Origin src: sources/field-notes.md#turns — "sources/field-notes.md" does not exist'));

  edit(root, 'research/glossary.md', 'Origin: src: sources/field-notes.md#turns', 'Origin: src: sources/interview-guide.md#turns');
  edit(root, 'research/glossary.md', 'Aliases: expressed disagreement', 'Aliases: expressed disagreement\nAliases: disagreement');
  g = mechanicsOf(root);
  const duplicate = 'line 19: Aliases appears more than once (first at line 18); the first one is read';
  assert.deepEqual(g.structure.findings.map((f) => `${f.id}:${f.line}:${f.text}`),
    [`dissent:15:${duplicate}`],
    'the missing source is gone once the origin is restored: the earlier finding belonged to the file, not to the check');
  out = review(root);
  assert.ok(out.includes(`- dissent: ${duplicate}`));

  edit(root, 'research/glossary.md', "Definition: A participant's reported expectation that raising a concern will not expose them to interpersonal harm.", 'Definition:');
  g = mechanicsOf(root);
  // The earlier alias duplicate is still in the file, so both findings stand:
  // the check reports the state of the glossary, not the latest edit.
  assert.deepEqual(g.structure.findings.map((f) => `${f.id}:${f.text}`),
    [`dissent:${duplicate}`, 'felt-safety:definition is missing']);
  assert.equal(g.structure.entries[3].state, 'proposed, incomplete: definition is missing');
});

test('manuscript links and `constructs:` declarations resolve, and an unknown id fails in both', () => {
  const root = project();
  edit(root, 'sections/theory.md', '<!-- constructs: dissent -->', '<!-- constructs: dissent, uptake-measure -->');
  edit(root, 'paper.md', '[Dissent](research/glossary.md#dissent)', '[Dissent](research/glossary.md#dissent-measure)');

  const g = mechanicsOf(root);
  assert.deepEqual(g.manuscripts.findings, [
    { path: 'paper.md', line: 13, id: 'dissent-measure', kind: 'link', reason: 'no entry has the id "dissent-measure"' },
    { path: 'sections/theory.md', line: 9, id: 'uptake-measure', kind: 'declaration', reason: 'no entry has the id "uptake-measure"' },
  ]);
  // The declaration still covers its paragraph for the entry it does name.
  assert.ok(g.manuscripts.references.some((r) => r.path === 'sections/theory.md' && r.kind === 'declaration' && r.id === 'dissent' && r.state === 'proposed'));
  // A link the glossary does not resolve is not a citation, so the word in the
  // paragraph becomes an occurrence for inspection.
  assert.deepEqual(g.lexical.occurrences.map((o) => `${o.where}:${o.line}:${o.label}:${o.ambiguous}:${o.ids.join('+')}`),
    ['paper.md:11:Dissent:false:dissent']);

  const out = review(root);
  assert.ok(out.includes('sections/theory.md (line 9) declaration: uptake-measure — no entry has the id "uptake-measure"'));
  assert.ok(out.includes('paper.md (line 13) link: dissent-measure — no entry has the id "dissent-measure"'));
  assert.ok(out.includes('paper.md (line 11): "Dissent" occurs but nothing here names dissent'));
});

test('a declared manuscript that is missing, unsupported or a directory is not checked, never clean', () => {
  const root = project();
  edit(root, 'research/glossary.md', 'manuscripts: paper.md; sections/theory.md',
    'manuscripts: paper.md; sections/discussion.md; sections/notes.txt; sources');
  write(root, 'sections/notes.txt', 'not a manuscript\n');

  const g = mechanicsOf(root);
  assert.deepEqual(g.manuscripts.declared, ['paper.md', 'sections/discussion.md', 'sections/notes.txt', 'sources']);
  assert.deepEqual(g.manuscripts.notChecked, [
    { path: 'sections/discussion.md', reason: '"sections/discussion.md" does not exist' },
    { path: 'sections/notes.txt', reason: '"sections/notes.txt" is not a Markdown manuscript this check reads' },
    { path: 'sources', reason: '"sources" is not a file' },
  ]);
  assert.ok(g.manuscripts.references.length > 0);
  assert.ok(g.manuscripts.references.every((r) => r.path === 'paper.md'));
  assert.ok(g.inspected.some((f) => f.path === 'sections/discussion.md' && f.status === 'missing'));
  assert.ok(g.inspected.some((f) => f.path === 'sections/notes.txt' && f.status === 'unsupported'));
  assert.ok(g.inspected.some((f) => f.path === 'sources' && f.status === 'unreadable'));
  assert.deepEqual(g.notChecked, [], 'the group itself still ran');

  const out = review(root);
  assert.ok(out.includes('not checked: sections/discussion.md — "sections/discussion.md" does not exist'));
  assert.ok(out.includes('not checked: sections/notes.txt — "sections/notes.txt" is not a Markdown manuscript this check reads'));
  assert.ok(out.includes('not checked: sources — "sources" is not a file'));
});

test('an absent manuscript list leaves manuscript coverage not checked', () => {
  const root = project();
  edit(root, 'research/glossary.md', 'manuscripts: paper.md; sections/theory.md\n', '');

  const g = mechanicsOf(root);
  assert.deepEqual(g.manuscripts.declared, []);
  assert.deepEqual(g.manuscripts.notChecked, [
    { path: null, reason: 'the glossary frontmatter declares no manuscripts, so manuscript coverage was not requested' },
  ]);
  assert.deepEqual(g.manuscripts.references, []);
  assert.equal(g.lexical.checked, true, 'the canvas and the entries are still read');
  assert.deepEqual(g.canvas.findings, []);

  const out = review(root);
  assert.ok(out.includes('not checked: manuscript coverage — the glossary frontmatter declares no manuscripts, so manuscript coverage was not requested'));
});

test('a glossary that is absent, or exists and cannot be read, is not checked and never zero findings', () => {
  const root = project();
  fs.rmSync(file(root, 'research/glossary.md'));
  let out = review(root);
  assert.ok(out.includes('not checked: glossary mechanics — there is no research/glossary.md'));
  assert.ok(out.includes('research/glossary.md (absent)'));
  assert.ok(out.includes('Declared construct coverage checked; undeclared constructs require human inspection.'));
  assert.ok(out.includes('Human construct judgment: not performed by this check'));
  assert.ok(!out.includes('### Entry structure and provenance'), 'no inventory is invented for a glossary that is not there');

  fs.mkdirSync(file(root, 'research/glossary.md'));
  out = review(root);
  assert.ok(out.includes('not checked: glossary mechanics — research/glossary.md exists but cannot be read (EISDIR)'));
  assert.ok(out.includes('research/glossary.md (unreadable)'));
  assert.ok(!out.includes('### Entry structure and provenance'));
});

test('the lexical cross-check lists an unlinked occurrence and does not stem', () => {
  const root = project();
  edit(root, 'research/canvas.md', 'A count of turns does not establish that anyone disagreed. [proposed',
    'A count of turns does not establish that anyone disagreed, and nothing was said about uptake. [proposed');
  edit(root, 'research/canvas.md', 'Turn counts alone do not settle whether a group heard its junior members.',
    'Turn counts alone do not settle whether a group heard its junior members. Proposal uptakes were counted twice.');

  const g = mechanicsOf(root);
  assert.deepEqual(g.lexical.occurrences.map((o) => `${o.where}:${o.label}:${o.ambiguous}:${o.ids.join('+')}`),
    ['4.2:uptake:false:proposal-uptake']);
  assert.equal(g.lexical.occurrences[0].line, 66);
  assert.ok(g.lexical.occurrences[0].text.includes('nothing was said about uptake'));

  const out = review(root);
  assert.ok(out.includes('4.2 (line 66): "uptake" occurs but nothing here names proposal-uptake'));
});

test('a label two entries claim is listed under both, never resolved to one reading', () => {
  const root = project();
  edit(root, 'research/glossary.md', 'Aliases: expressed disagreement', 'Aliases: expressed disagreement, uptake');
  edit(root, 'research/canvas.md', 'Turn counts alone do not settle whether a group heard its junior members.',
    'Turn counts alone do not settle whether a group heard its junior members. Nothing was said about uptake.');

  const g = mechanicsOf(root);
  assert.ok(g.structure.findings.some((f) => f.text.includes('the alias "uptake" is claimed by dissent and proposal-uptake')));
  const ambiguous = g.lexical.occurrences.filter((o) => o.ambiguous);
  assert.equal(ambiguous.length, 1);
  assert.deepEqual({ where: ambiguous[0].where, line: ambiguous[0].line, ids: ambiguous[0].ids }, { where: '8.1', line: 116, ids: ['dissent', 'proposal-uptake'] });
  // 4.3 cites proposal-uptake, so only the other reading of `uptake` is open.
  const one = g.lexical.occurrences.find((o) => o.where === '4.3');
  assert.deepEqual(one.ids, ['dissent']);
  assert.equal(one.ambiguous, false);

  const out = review(root);
  assert.ok(out.includes('8.1 (line 116): "uptake" occurs but is ambiguous — dissent and proposal-uptake both claim it'));
  assert.ok(out.includes('4.3 (line 71): "uptake" occurs but nothing here names dissent'));
});

test('an accepted entry with a verified decision reports no drift, and reflow alone passes', () => {
  const root = project();
  const result = accept(root, 'proposal-uptake');
  assert.equal(result.seq, 1, 'the fixture log holds no entries yet');

  const g = mechanicsOf(root);
  assert.deepEqual(g.stability, []);
  assert.equal(g.structure.entries[2].state, 'accepted');
  const refs = g.canvas.statements.flatMap((s) => s.refs).filter((r) => r.id === 'proposal-uptake');
  for (const r of refs) assert.equal(r.state, 'accepted');
  for (const r of g.manuscripts.references.filter((r) => r.id === 'proposal-uptake')) assert.equal(r.state, 'accepted');

  // Reflow: the same payload typed across lines and with doubled spaces. The
  // hash is the normalized text, so nothing here is drift.
  edit(root, 'research/glossary.md',
    'Definition: The extent to which a proposal made in one meeting becomes a topic of work in a later one.',
    'Definition: The extent to which a proposal made in one meeting\n  becomes a topic of work in a later one.  ');
  const after = mechanicsOf(root);
  assert.deepEqual(after.stability, []);
  const reflowed = glossary.entryById(glossary.parseGlossary(read(root, 'research/glossary.md')), 'proposal-uptake');
  assert.equal(glossary.payloadHash(reflowed), result.hash);

  const out = review(root);
  assert.match(out, /### Accepted text stability and cover\n[^\n]+\nnone/);
});

test('a changed definition, source or distinction names its dependents and invalidates nothing', () => {
  const root = project();
  accept(root, 'proposal-uptake');
  const canvasBefore = read(root, 'research/canvas.md');
  const decisionsBefore = read(root, 'research/decisions.md');

  edit(root, 'research/glossary.md',
    'Definition: The extent to which a proposal made in one meeting becomes a topic of work in a later one.',
    'Definition: The extent to which a proposal, or a related topic, becomes a topic of work in a later meeting.');
  let g = mechanicsOf(root);
  assert.equal(g.stability.length, 1);
  assert.deepEqual(
    { kind: g.stability[0].kind, id: g.stability[0].id, seq: g.stability[0].seq, state: g.stability[0].state },
    { kind: 'changed', id: 'proposal-uptake', seq: 1, state: 'verified' });
  assert.deepEqual(whereOf(g.stability[0].locations), PROPOSAL_UPTAKE_DEPENDENTS);
  assert.ok(g.stability[0].locations[0].text.startsWith('Which meeting conditions separate'));
  assert.deepEqual(g.structure.findings, []);
  let out = review(root);
  assert.ok(out.includes('proposal-uptake: definition changed since acceptance (#1 bound '));
  assert.ok(out.includes('dependent locations:'));
  assert.ok(out.includes('3.1 (line 46): Which meeting conditions separate a proposal that is taken up later from one that is not?'));
  assert.ok(!out.includes('does not verify'), 'a verified cover is not complained about');
  assert.ok(!out.includes('no single entry carries'));
  assert.equal(out.split('nothing here names').length - 1, 0, 'the changed definition is still cited, so no label is unlinked');

  edit(root, 'research/glossary.md', 'Origin: own-definition\nDistinctions: Unlike [dissent](#dissent)',
    'Origin: src: sources/interview-guide.md#uptake\nDistinctions: Unlike [dissent](#dissent)');
  g = mechanicsOf(root);
  assert.equal(g.stability.length, 1);
  assert.equal(g.stability[0].kind, 'changed');
  assert.deepEqual(whereOf(g.stability[0].locations), PROPOSAL_UPTAKE_DEPENDENTS);
  assert.deepEqual(g.structure.findings, [], 'the new source resolves');

  edit(root, 'research/glossary.md', 'uptake is about what the group did with a proposal rather than about who disagreed.',
    'uptake is about what the group did with a proposal, not about who disagreed.');
  g = mechanicsOf(root);
  assert.equal(g.stability[0].kind, 'changed');

  // Naming a dependent is not a rejection: the canvas and the log keep the
  // bytes they had, and the entry keeps its marker.
  assert.equal(read(root, 'research/canvas.md'), canvasBefore);
  assert.equal(read(root, 'research/decisions.md'), decisionsBefore);
  assert.ok(read(root, 'research/glossary.md').includes('\n[accepted]\n'));
});

test('an [accepted] marker with no decision, and a deleted accepted entry, stay visible', () => {
  const uncoveredRoot = project();
  edit(uncoveredRoot, 'research/glossary.md', '\n[proposed]\n\n## dissent', '\n[accepted]\n\n## dissent');
  const uncovered = mechanicsOf(uncoveredRoot);
  assert.equal(uncovered.stability.length, 1);
  assert.deepEqual(
    { kind: uncovered.stability[0].kind, id: uncovered.stability[0].id, line: uncovered.stability[0].line, hash: uncovered.stability[0].hash },
    { kind: 'uncovered', id: 'speaking-frequency', line: 6, hash: null });
  assert.ok(whereOf(uncovered.stability[0].locations).includes('4.1'));
  assert.ok(whereOf(uncovered.stability[0].locations).includes('sections/theory.md'));
  const uncoveredOut = review(uncoveredRoot);
  assert.ok(uncoveredOut.includes('speaking-frequency (line 6): [accepted] with no decision naming it'));

  const deletedRoot = project();
  accept(deletedRoot, 'felt-safety');
  const text = read(deletedRoot, 'research/glossary.md');
  write(deletedRoot, 'research/glossary.md', `${text.slice(0, text.indexOf('## felt-safety')).trimEnd()}\n`);
  const deleted = mechanicsOf(deletedRoot);
  assert.equal(deleted.stability.length, 1);
  assert.deepEqual(
    { kind: deleted.stability[0].kind, id: deleted.stability[0].id, seq: deleted.stability[0].seq },
    { kind: 'deleted', id: 'felt-safety', seq: 1 });
  // The statements that rest on the deleted entry are named where they are
  // read: the canvas references no longer resolve.
  assert.deepEqual(deleted.canvas.findings.map((f) => `${f.question}:${f.id}`), ['4.1:felt-safety', '7.2:felt-safety']);
  const deletedOut = review(deletedRoot);
  assert.ok(deletedOut.includes('felt-safety: no single entry carries this id; #1 accepted payload '));
});

test('a cover that does not verify reports its state: unverifiable here, legacy, broken', () => {
  const noKey = project();
  accept(noKey, 'dissent');
  fs.rmSync(seal.keyPath(noKey));
  const unverifiable = mechanicsOf(noKey);
  assert.deepEqual({ kind: unverifiable.stability[0].kind, state: unverifiable.stability[0].state, id: unverifiable.stability[0].id },
    { kind: 'state', state: 'unverifiable', id: 'dissent' });
  assert.ok(review(noKey).includes('dissent: [accepted], covered only by #1, unverifiable here'));

  const legacy = project();
  accept(legacy, 'dissent');
  const sealed = read(legacy, 'research/decisions.md');
  const unsealed = sealed.replace(/ · seal [0-9a-f]{16}/, '');
  assert.notEqual(unsealed, sealed, 'the fixture log has a seal to strip');
  write(legacy, 'research/decisions.md', unsealed);
  const legacyState = mechanicsOf(legacy);
  assert.deepEqual({ kind: legacyState.stability[0].kind, state: legacyState.stability[0].state, id: legacyState.stability[0].id },
    { kind: 'state', state: 'legacy', id: 'dissent' });
  assert.ok(review(legacy).includes('dissent: [accepted], covered only by #1, legacy (no seal)'));

  const broken = project();
  accept(broken, 'dissent');
  accept(broken, 'felt-safety');
  const log = read(broken, 'research/decisions.md');
  const second = log.indexOf('## [#2]');
  assert.ok(second > 0, 'the second acceptance is entry #2');
  write(broken, 'research/decisions.md', `${log.slice(0, second)}${log.slice(second).replace('**Why:** the construct drives the coding', '**Why:** reworded after the seal')}`);
  const brokenState = mechanicsOf(broken);
  assert.deepEqual([brokenState.stability.length, brokenState.stability[0].kind, brokenState.stability[0].state, brokenState.stability[0].id],
    [1, 'state', 'broken', 'felt-safety'], 'the entry before the break still verifies');
  assert.ok(review(broken).includes('felt-safety: [accepted], covered only by #2, broken'));
});
