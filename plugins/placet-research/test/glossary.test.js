'use strict';

// SQ-202, package 1 of the construct glossary design
// (docs/superpowers/specs/construct-glossary-design.md, § Entry format and
// references and § Authorization and text binding): the entry parser, the
// payload hash and the selected-state paths. Every construct in these
// fixtures is invented for this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const glossary = require('../hooks/lib/glossary');
const project = require('../hooks/lib/project');

const HEADER = '---\nglossary-schema: 1\nmanuscripts: paper.md; sections/theory.md\n---\n\n';

// A complete entry: term, aliases (optional), definition, origin, distinctions,
// then the marker on its own line.
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

const LAG_ENTRY = entryText('handoff-lag', {
  term: 'Handoff lag',
  definition: 'The interval between a request being made and its next visible acknowledgement.',
  distinctions: 'Unlike [quiet window](#quiet-window), this is measured in time rather than reported as an expectation.',
});

function doc(...entries) {
  return `${HEADER}${entries.join('\n\n')}\n`;
}

function makeProject({ stateDir } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-glossary-'));
  const dir = stateDir ? path.resolve(root, stateDir) : path.join(root, 'research');
  fs.mkdirSync(dir, { recursive: true });
  return root;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function canSymlink(root) {
  const probe = path.join(root, '.symlink-probe');
  try {
    fs.symlinkSync(path.join(root, 'research'), probe);
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

test('parseGlossary reads the header, the fixed field order and the marker', () => {
  const parsed = glossary.parseGlossary(doc(entryText('quiet-window'), LAG_ENTRY));
  assert.equal(parsed.schema, '1');
  assert.equal(parsed.schemaSupported, true);
  assert.deepEqual(parsed.manuscripts, ['paper.md', 'sections/theory.md']);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.judgeable, true);
  assert.equal(parsed.entries.length, 2);

  const entry = glossary.entryById(parsed, 'quiet-window');
  assert.equal(entry.line, 6);
  assert.equal(entry.term, 'Quiet window');
  assert.equal(entry.aliases, null);
  assert.equal(entry.definition, "An observer's report that a signal was expected and did not arrive.");
  assert.deepEqual(entry.origin, { kind: 'own-definition', text: 'own-definition', file: null, anchor: null });
  assert.equal(entry.marker, 'proposed');
  assert.deepEqual(entry.incomplete, []);
  assert.deepEqual(entry.problems, []);
  assert.deepEqual(entry.references, [{ text: 'handoff lag', id: 'handoff-lag' }]);
  assert.match(entry.raw, /^## quiet-window/, 'the raw block is kept');

  // Aliases are declared labels, in declared order.
  const withAliases = glossary.parseGlossary(doc(entryText('quiet-window', { aliases: 'perceived quiet,  expected quiet' }), LAG_ENTRY));
  assert.deepEqual(glossary.entryById(withAliases, 'quiet-window').aliases, ['perceived quiet', 'expected quiet']);
});

test('a reflow of an entry leaves the payload hash unchanged', () => {
  const plain = glossary.parseGlossary(doc(entryText('quiet-window'), LAG_ENTRY));
  const wrapped = glossary.parseGlossary(doc(
    entryText('quiet-window', {
      definition: "An observer's report that a signal was expected\n\tand did not arrive.",
      distinctions: 'Unlike [handoff lag](#handoff-lag), this is an expectation\n    rather than a measured delay.',
    }),
    LAG_ENTRY,
  ));
  const a = glossary.entryById(plain, 'quiet-window');
  const b = glossary.entryById(wrapped, 'quiet-window');
  assert.equal(b.definition, a.definition);
  assert.equal(b.distinctions, a.distinctions);
  assert.equal(glossary.payloadHash(b), glossary.payloadHash(a));
  // The marker is the one thing the payload excludes.
  const accepted = glossary.parseGlossary(doc(entryText('quiet-window', { marker: '[accepted]' }), LAG_ENTRY));
  assert.equal(glossary.payloadHash(glossary.entryById(accepted, 'quiet-window')), glossary.payloadHash(a));
});

test('editing any bound field changes the payload hash', () => {
  const base = glossary.parseGlossary(doc(entryText('quiet-window'), LAG_ENTRY));
  const baseHash = glossary.payloadHash(glossary.entryById(base, 'quiet-window'));
  const variants = {
    term: entryText('quiet-window', { term: 'Quiet interval' }),
    aliases: entryText('quiet-window', { aliases: 'perceived quiet' }),
    definition: entryText('quiet-window', { definition: "An observer's report that a signal was expected and never arrived." }),
    origin: entryText('quiet-window', { origin: 'src: notes/source.md#quiet' }),
    distinctions: entryText('quiet-window', { distinctions: 'Unlike [handoff lag](#handoff-lag), this is an expectation rather than a turnaround time.' }),
  };
  for (const [field, text] of Object.entries(variants)) {
    const parsed = glossary.parseGlossary(doc(text, LAG_ENTRY));
    assert.notEqual(glossary.payloadHash(glossary.entryById(parsed, 'quiet-window')), baseHash, `${field} is bound into the payload`);
  }
});

test('duplicate ids leave the document unjudgeable and both blocks stay', () => {
  const parsed = glossary.parseGlossary(doc(entryText('quiet-window'), entryText('quiet-window', { term: 'Quiet window (again)' }), LAG_ENTRY));
  assert.equal(parsed.entries.length, 3);
  assert.equal(parsed.judgeable, false);
  assert.match(parsed.problems.join('\n'), /the id "quiet-window" has 2 headings \(lines 6, 14\)/);
  assert.equal(parsed.entries.filter((e) => e.id === 'quiet-window').length, 2, 'both readings are kept, neither is resolved');
});

test('a malformed block is reported, and its text is never dropped', () => {
  const duplicated = `${HEADER}## quiet-window\n\nTerm: Quiet window\nTerm: Quiet interval\nDefinition: x.\nOrigin: own-definition\nDistinctions: [handoff lag](#handoff-lag).\n[proposed]\n`;
  const parsed = glossary.parseGlossary(`${duplicated}\n## Quiet Window\n\nTerm: Loud window\nDefinition: y.\nOrigin: own-definition\nDistinctions: none relevant.\n[proposed]\n\nstray prose\n`);
  assert.equal(parsed.judgeable, false);
  const [entry, badHeading] = parsed.entries;
  assert.match(entry.problems.join('\n'), /Term appears more than once \(first at line 8\)/);
  assert.equal(entry.term, 'Quiet window', 'the first reading of a duplicated field is kept');
  assert.match(entry.raw, /Term: Quiet interval/, 'the malformed line stays in the raw block');
  assert.match(badHeading.problems.join('\n'), /"Quiet Window" is not a lowercase hyphenated id/);
  assert.match(badHeading.problems.join('\n'), /line \d+: text outside any field/, 'the stray line after the marker is reported');
  assert.match(glossary.parseGlossary(`${HEADER}stray prose\n\n## quiet-window\n\nTerm: Quiet window\nDefinition: x.\nOrigin: own-definition\nDistinctions: none relevant.\n[proposed]\n`).problems.join('\n'), /line 6: text outside any entry/);

  // Field order is part of the grammar, and so is a field declared empty.
  const outOfOrder = glossary.parseGlossary(`${HEADER}## quiet-window\n\nTerm: Quiet window\nDefinition: x.\nOrigin: own-definition\nAliases: perceived quiet\nDistinctions: [handoff lag](#handoff-lag).\n[proposed]\n`);
  assert.match(outOfOrder.entries[0].problems.join('\n'), /Aliases is out of order/);
  const missing = glossary.parseGlossary(`${HEADER}## quiet-window\n\nTerm:\nDefinition: x.\nOrigin: own-definition\nDistinctions: [handoff lag](#handoff-lag).\n[proposed]\n`);
  assert.deepEqual(missing.entries[0].incomplete, ['term is missing']);
});

test('a markdown link to no entry id is an entry problem', () => {
  const parsed = glossary.parseGlossary(doc(entryText('quiet-window'), LAG_ENTRY));
  assert.deepEqual(glossary.entryById(parsed, 'handoff-lag').problems, []);
  const dangling = glossary.parseGlossary(doc(entryText('quiet-window', { distinctions: 'Unlike [a neighbour](#no-such-entry), this is an expectation.' }), LAG_ENTRY));
  assert.match(glossary.entryById(dangling, 'quiet-window').problems.join('\n'), /links to #no-such-entry, which is no entry id/);
});

test('a pending definition is incomplete, not a malformed block', () => {
  const parsed = glossary.parseGlossary(doc(entryText('quiet-window', { definition: 'pending' }), LAG_ENTRY));
  assert.deepEqual(parsed.problems, []);
  const entry = glossary.entryById(parsed, 'quiet-window');
  assert.deepEqual(entry.problems, []);
  assert.deepEqual(entry.incomplete, ['definition is pending']);
  assert.equal(parsed.judgeable, true, 'judgeable is not acceptable');
  assert.equal(glossary.resolveOrigin('/nowhere', entry).status, 'ok', 'own-definition still resolves');

  const unmarked = glossary.parseGlossary(doc(entryText('quiet-window', { marker: null }), LAG_ENTRY));
  assert.deepEqual(glossary.entryById(unmarked, 'quiet-window').incomplete, ['no authorization marker']);
});

test('own-definition and src: are told apart, and a source target is resolved', () => {
  const root = makeProject();
  writeFile(path.join(root, 'notes', 'source.md'), '# Notes\n\n## Entry 2\n\nA passage.\n');
  const parsed = glossary.parseGlossary(doc(
    entryText('quiet-window', { origin: 'src: notes/source.md#entry-2' }),
    entryText('handoff-lag', { origin: 'src: notes/absent.md#nowhere' }),
    entryText('second-window', { origin: 'unverified' }),
  ));
  const [sourced, missing, unverified] = parsed.entries;
  assert.deepEqual(sourced.origin, { kind: 'source', text: 'src: notes/source.md#entry-2', file: 'notes/source.md', anchor: 'entry-2' });
  assert.equal(glossary.resolveOrigin(root, sourced).status, 'ok');
  assert.equal(glossary.resolveOrigin(root, sourced).anchor, 'entry-2');
  assert.equal(glossary.resolveOrigin(root, missing).status, 'missing');
  assert.match(glossary.resolveOrigin(root, missing).reason, /notes\/absent\.md/);
  assert.equal(glossary.resolveOrigin(root, unverified).status, 'unverified');
  assert.deepEqual(unverified.incomplete, ['origin is unverified']);
  const own = glossary.entryById(glossary.parseGlossary(doc(entryText('quiet-window'), LAG_ENTRY)), 'quiet-window');
  assert.equal(glossary.resolveOrigin(root, own).status, 'ok');
  assert.equal(glossary.resolveOrigin(root, own).path, null);
});

test('a source path that climbs out of the project, or leaves it through a symlink, is refused', (t) => {
  const root = makeProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-glossary-outside-'));
  writeFile(path.join(outside, 'source.md'), 'outside\n');
  assert.equal(glossary.resolveLocal(root, '../outside.md').status, 'outside-project');
  assert.equal(glossary.resolveLocal(root, path.join(outside, 'source.md')).status, 'not-relative');
  if (!canSymlink(root)) return t.skip('this platform does not allow symlinks');
  fs.symlinkSync(path.join(outside, 'source.md'), path.join(root, 'notes-link.md'));
  const escape = glossary.resolveLocal(root, 'notes-link.md');
  assert.equal(escape.status, 'outside-project');
  assert.match(escape.reason, /symlink to a path outside the project/);
  return undefined;
});

test('an unreadable source target is unreadable, not absent', (t) => {
  const root = makeProject();
  const file = path.join(root, 'notes', 'source.md');
  writeFile(file, 'A passage.\n');
  fs.chmodSync(file, 0o000);
  try {
    fs.readFileSync(file);
    fs.chmodSync(file, 0o644);
    return t.skip('this process reads a mode 000 file');
  } catch (_) {
    // As intended: the resolver is about to meet the same EACCES.
  }
  assert.equal(glossary.resolveLocal(root, 'notes/source.md').status, 'unreadable');
  fs.chmodSync(file, 0o644);
  return undefined;
});

test('an alias claimed by two entries is reported and never resolved', () => {
  const parsed = glossary.parseGlossary(doc(
    entryText('quiet-window', { aliases: 'perceived quiet' }),
    entryText('handoff-lag', { aliases: 'perceived quiet, measured lag' }),
  ));
  assert.equal(parsed.judgeable, false);
  assert.match(parsed.problems.join('\n'), /the alias "perceived quiet" is claimed by quiet-window and handoff-lag/);
  assert.deepEqual(glossary.entryById(parsed, 'quiet-window').aliases, ['perceived quiet']);
  assert.deepEqual(glossary.entryById(parsed, 'handoff-lag').aliases, ['perceived quiet', 'measured lag']);
});

test('an unsupported schema, a missing schema and an unterminated header are unjudgeable', () => {
  const unsupported = glossary.parseGlossary(doc(entryText('quiet-window'), LAG_ENTRY).replace('glossary-schema: 1', 'glossary-schema: 2'));
  assert.equal(unsupported.schemaSupported, false);
  assert.equal(unsupported.judgeable, false);
  assert.match(unsupported.problems.join('\n'), /glossary-schema is "2"; this reader reads glossary-schema: 1/);

  const missing = glossary.parseGlossary('## quiet-window\n\nTerm: Quiet window\nDefinition: x.\nOrigin: own-definition\nDistinctions: none relevant.\n[proposed]\n');
  assert.equal(missing.schema, null);
  assert.equal(missing.judgeable, false);
  assert.match(missing.problems.join('\n'), /declares no glossary-schema/);

  const open = glossary.parseGlossary('---\nglossary-schema: 1\n');
  assert.match(open.problems.join('\n'), /frontmatter is not terminated/);
});

test('loadGlossary reads the configured state directory, and an absent glossary is absent', () => {
  const projectRoot = makeProject({ stateDir: 'notes/paper' });
  const saved = process.env.PLACET_RESEARCH_DIR;
  process.env.PLACET_RESEARCH_DIR = 'notes/paper';
  try {
    assert.equal(project.glossaryPath(projectRoot), path.join(projectRoot, 'notes', 'paper', 'glossary.md'));
    const absent = glossary.loadGlossary(projectRoot);
    assert.equal(absent.text, null);
    assert.equal(absent.parsed, null);
    assert.equal(absent.path, path.join(projectRoot, 'notes', 'paper', 'glossary.md'));

    writeFile(absent.path, doc(entryText('quiet-window'), LAG_ENTRY));
    const loaded = glossary.loadGlossary(projectRoot);
    assert.equal(loaded.text.startsWith('---'), true);
    assert.deepEqual(loaded.parsed.entries.map((e) => e.id), ['quiet-window', 'handoff-lag']);

    // The default state directory is not consulted when one is configured.
    assert.equal(fs.existsSync(path.join(projectRoot, 'research', 'glossary.md')), false);
  } finally {
    if (saved === undefined) delete process.env.PLACET_RESEARCH_DIR;
    else process.env.PLACET_RESEARCH_DIR = saved;
  }
});

test('a variant reads its own glossary and never the main one', (t) => {
  const root = makeProject();
  writeFile(path.join(root, 'research', 'glossary.md'), doc(entryText('quiet-window'), LAG_ENTRY));
  const variantFile = path.join(root, 'research', 'variants', 'lens-b', 'glossary.md');
  writeFile(variantFile, doc(entryText('lens-b-window', { term: 'Lens-b window', distinctions: 'No neighbouring construct is named yet.' })));

  const main = glossary.loadGlossary(root);
  const variant = glossary.loadGlossary(root, { variant: 'lens-b' });
  assert.equal(variant.path, variantFile);
  assert.deepEqual(variant.parsed.entries.map((e) => e.id), ['lens-b-window']);
  assert.deepEqual(main.parsed.entries.map((e) => e.id), ['quiet-window', 'handoff-lag'], 'the main file is untouched by the variant read');
  assert.notEqual(glossary.payloadHash(variant.parsed.entries[0]), glossary.payloadHash(main.parsed.entries[0]));
  assert.throws(() => project.glossaryPath(root, '../escape'), /not a variant name/);
  return undefined;
});

test('the state a write reads first carries the glossary path', () => {
  const root = makeProject();
  const canvas = '---\nproject: t\nprofile: is-qualitative\n---\n\n# 1 · Puzzle\n\n## 1.1 Question\n\n_(empty)_\n';
  writeFile(path.join(root, 'research', 'canvas.md'), canvas);
  writeFile(path.join(root, 'research', 'variants', 'lens-b', 'canvas.md'), canvas);
  const state = require('../hooks/lib/state').loadState(root);
  assert.equal(state.error, undefined, state.error);
  assert.equal(state.paths.glossary, path.join(root, 'research', 'glossary.md'));
  assert.equal(require('../hooks/lib/state').loadState(root, { variant: 'lens-b' }).paths.glossary, path.join(root, 'research', 'variants', 'lens-b', 'glossary.md'));
});
