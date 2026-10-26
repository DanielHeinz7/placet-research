'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canvas = require('../hooks/lib/canvas');
const project = require('../hooks/lib/project');
const { statusByNumber } = require('../hooks/lib/profile');

const fixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'canvas.md'),
  'utf8',
);

test('parseCanvas reads frontmatter, nine elements and their questions', () => {
  const parsed = canvas.parseCanvas(fixture);
  assert.equal(parsed.problems.length, 0);
  assert.equal(parsed.frontmatter.project, 'voice-uptake');
  assert.equal(parsed.frontmatter.profile, 'is-qualitative');
  assert.equal(parsed.frontmatter.mode, 'seed');
  assert.equal(parsed.elements.length, 9);
  assert.deepEqual(parsed.elements.map((e) => e.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(parsed.elements[0].title, 'Puzzle');
  assert.deepEqual(parsed.elements[0].questions.map((q) => q.id), ['1.1', '1.2', '1.3']);
});

test('statements carry marker, tags and normalized text; placeholders are not statements', () => {
  const parsed = canvas.parseCanvas(fixture);
  const q12 = parsed.elements[0].questions[1];
  assert.equal(q12.statements.length, 2);
  assert.equal(q12.statements[0].marker, 'stated');
  assert.deepEqual(q12.statements[0].tags, []);
  assert.equal(q12.statements[1].marker, 'proposed');
  const q13 = parsed.elements[0].questions[2];
  assert.equal(q13.statements.length, 0, '_(empty)_ is not a statement');
  const q22 = parsed.elements[1].questions[1];
  assert.deepEqual(q22.statements[0].tags, ['unverified']);
  const q31 = parsed.elements[2].questions[0];
  assert.deepEqual(q31.statements[0].tags, ['src: memo-03']);
  assert.equal(q31.statements[0].text, "Under what meeting conditions does a junior member's proposal get taken up?");
});

test('parseMarkerGroup accepts only known markers', () => {
  assert.deepEqual(canvas.parseMarkerGroup('Claim. [accepted]'), { text: 'Claim.', marker: 'accepted', tags: [] });
  assert.deepEqual(canvas.parseMarkerGroup('Claim. [proposed, src: x, unverified]'), { text: 'Claim.', marker: 'proposed', tags: ['src: x', 'unverified'] });
  assert.equal(canvas.parseMarkerGroup('Claim. [verified]'), null);
  assert.equal(canvas.parseMarkerGroup('Claim without marker.'), null);
});

test('a paragraph without a marker is recorded as unmarked, not dropped', () => {
  const text = fixture.replace('_(empty)_', 'Because meetings are where allocation happens.');
  const parsed = canvas.parseCanvas(text);
  const q13 = parsed.elements[0].questions[2];
  assert.equal(q13.statements.length, 1);
  assert.equal(q13.statements[0].marker, null);
});

test('text outside a question and an unterminated frontmatter are problems', () => {
  const stray = canvas.parseCanvas('---\nproject: x\n---\n\nloose text\n\n# 1 · Puzzle\n');
  assert.match(stray.problems[0], /outside any question/);
  const open = canvas.parseCanvas('---\nproject: x\n');
  assert.match(open.problems[0], /not terminated/);
});

// §4.2's three structural laws. A document that breaks one has two readings,
// and the parser reports the breach rather than merging or preferring one —
// which is what every consumer silently did before.
test('a duplicate element number is a problem, and the element loses its status', () => {
  // SQ-21 S15, 3157 -> 3215 bytes: a second `# 1 · …` heading shadowed element
  // 1 to `empty` while it still held the researcher's accepted statement.
  const text = `${fixture}\n# 1 · Puzzle (working)\n\n## 1.7 Working notes\n\n_(empty)_\n`;
  const parsed = canvas.parseCanvas(text);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /element 1 has 2 headings \(lines \d+, \d+\)/);
  assert.equal(statusByNumber(parsed)[1].status, 'duplicate', 'not the status of whichever heading came last');
});

test('a duplicate question id is a problem wherever the copy is placed', () => {
  const q11 = '## 1.1 What is the broad question this project speaks to?';
  // S5: the copy placed *before* the original. S5b: after it. The first
  // implementation's matching was order-dependent and denied only the second.
  const before = canvas.parseCanvas(fixture.replace(q11, `${q11}\n\nA copy. [proposed]\n\n${q11}`));
  const after = canvas.parseCanvas(`${fixture}\n${q11}\n\nA copy. [proposed]\n`);
  for (const parsed of [before, after]) {
    assert.ok(parsed.problems.some((p) => /question 1\.1 has 2 headings/.test(p)), JSON.stringify(parsed.problems));
  }
});

test('a question sitting under the wrong element is a problem', () => {
  // S1 and S6 re-parented question 1.1, with its accepted statement, under
  // another element — 3157 bytes in, 3157 bytes out.
  const parsed = canvas.parseCanvas(fixture.replace('## 3.1 ', '## 1.9 '));
  assert.ok(parsed.problems.some((p) => /question 1\.9 sits under element 3/.test(p)), JSON.stringify(parsed.problems));
});

// §4.3.1: the commitment is the statement together with everything that gives
// it its meaning. Identity by question id and text alone left all of it free.
test('the canonical commitment carries element, title, question, marker, text and tags', () => {
  const parsed = canvas.parseCanvas(fixture);
  const el = parsed.elements[2];
  const q = el.questions[0];
  const line = canvas.canonicalCommitment(el, q, q.statements[0]);
  assert.deepEqual(line.split(canvas.COMMIT_SEP), [
    '3',
    el.title,
    '3.1',
    q.text,
    'stated',
    "Under what meeting conditions does a junior member's proposal get taken up?",
    'src: memo-03',
  ]);
  assert.match(canvas.commitmentHash(line), /^[0-9a-f]{8}$/);
});

test('each field of the commitment changes the hash; tag order does not', () => {
  const parsed = canvas.parseCanvas(fixture);
  const el = parsed.elements[2];
  const q = el.questions[0];
  const s = q.statements[0];
  const base = canvas.canonicalCommitment(el, q, s);

  const variants = {
    element: canvas.canonicalCommitment({ ...el, number: 4 }, q, s),
    title: canvas.canonicalCommitment({ ...el, title: 'Contributions' }, q, s),
    questionText: canvas.canonicalCommitment(el, { ...q, text: 'A different question?' }, s),
    marker: canvas.canonicalCommitment(el, q, { ...s, marker: 'accepted' }),
    text: canvas.canonicalCommitment(el, q, { ...s, text: 'Something else.' }),
    tag: canvas.canonicalCommitment(el, q, { ...s, tags: ['src: memo-99'] }),
  };
  for (const [field, line] of Object.entries(variants)) {
    assert.notEqual(canvas.commitmentHash(line), canvas.commitmentHash(base), `${field} must change the commitment`);
  }
  const reordered = canvas.canonicalCommitment(el, q, { ...s, tags: ['unverified', 'src: memo-03'] });
  const sorted = canvas.canonicalCommitment(el, q, { ...s, tags: ['src: memo-03', 'unverified'] });
  assert.equal(reordered, sorted, 'evidence tags are sorted, so reordering them is not a change');
});

// The collapse class is exactly space, tab, CR and LF (§4.3.1). JavaScript's
// `\s` also matches U+00A0 and U+FEFF, which is how SQ-21's D5b and D5c pushed
// characters into an accepted statement with the guard seeing no change.
test('normalizeText collapses only the four reflow characters', () => {
  assert.equal(canvas.normalizeText('  a \t b \r\n c  '), 'a b c');
  const nbsp = `a${String.fromCharCode(0x00a0)}b`;
  const bom = `a${String.fromCharCode(0xfeff)}b`;
  assert.equal(canvas.normalizeText(nbsp), nbsp, 'U+00A0 is not a reflow');
  assert.equal(canvas.normalizeText(bom), bom, 'U+FEFF is not a reflow');
  // NFC, not NFKC: compatibility folding would equate these two.
  assert.notEqual(canvas.normalizeText('½'), canvas.normalizeText('1⁄2'));
});

// SQ-29 F9. §4.3.1 justifies U+001F as "a character the researcher cannot have
// typed into Markdown", and that is false: a field holding one reproduces a
// boundary of the canonical line, so a commitment's text and tags can be re-cut
// with the joined line unchanged and `committedSet` reads the re-cut commitment
// as the one it replaced. Any C0 control character does the same job one
// boundary over, so such a commitment has no canonical form at all, and the
// parser says so where `review` and the guard both read it.
test('a control character reaching a commitment field leaves it without a canonical form', () => {
  const sep = String.fromCharCode(0x1f);
  const crafted = fixture.replace('[accepted]', `[accepted, src: interview-07${sep}memo-02]`);
  const parsed = canvas.parseCanvas(crafted);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0], /line 14: the \[accepted\] statement in question 1\.1 carries the control character U\+001F in an evidence tag/);

  // The cut the separator exists to allow: the same content re-cut across the
  // text/tags boundary moves which field carries it without changing the join.
  const el = parsed.elements[0];
  const q = el.questions[0];
  const statement = q.statements[0];
  assert.equal(canvas.controlCharacterField(el, q, statement).where, 'an evidence tag');
  const moved = { ...statement, text: `${statement.text}${sep}src: interview-07`, tags: ['memo-02'] };
  assert.equal(canvas.controlCharacterField(el, q, moved).where, 'the statement text');
  assert.equal(
    canvas.canonicalCommitment(el, q, statement),
    canvas.canonicalCommitment(el, q, moved),
    'the canonical line survives the cut, which is why the field may not carry the separator',
  );

  // A clean commitment is untouched, and the field is named rather than the file.
  assert.deepEqual(canvas.parseCanvas(fixture).problems, []);
  assert.equal(canvas.controlCharacterField(el, q, canvas.parseCanvas(fixture).elements[0].questions[0].statements[0]), null);
});

// Reflow is space, tab, CR and LF, and it is collapsed before a statement's
// fields are read, so ordinary multi-line and tab-carrying content never
// reaches a field as a control character.
test('a tab and a line break in a statement are reflow, not a control character', () => {
  const stated = 'Speaking frequency is well documented; whether a proposal is taken up is not. [stated]';
  const reflowed = fixture.replace(stated, 'Speaking\tfrequency  is\nwell documented. [stated]');
  assert.notEqual(reflowed, fixture);
  const parsed = canvas.parseCanvas(reflowed);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.elements[0].questions[1].statements[0].text, 'Speaking frequency is well documented.');
});

test('committedSet is a set: duplicates collapse, proposals are not members', () => {
  const parsed = canvas.parseCanvas(fixture);
  const set = canvas.committedSet(parsed);
  assert.equal(set.size, 4);
  assert.ok([...set.values()].every((c) => canvas.COMMITTED.has(c.marker)));
  const accepted = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]";
  const twice = canvas.committedSet(canvas.parseCanvas(fixture.replace(accepted, `${accepted}\n${accepted}`)));
  assert.equal(twice.size, 4, 'the same commitment written twice is one commitment');
});

test('elementStatus derives from committed statements only', () => {
  const parsed = canvas.parseCanvas(fixture);
  const [e1, e2, e3, e4, e5] = parsed.elements;
  assert.deepEqual(canvas.elementStatus(e1), { status: 'stated', open: 1 }); // accepted + stated + one proposal → weakest committed is stated
  assert.deepEqual(canvas.elementStatus(e2), { status: 'open', open: 1 });   // only a proposal
  assert.deepEqual(canvas.elementStatus(e3), { status: 'stated', open: 0 });
  assert.deepEqual(canvas.elementStatus(e4), { status: 'empty', open: 0 });
  assert.deepEqual(canvas.elementStatus(e5), { status: 'stated', open: 0 });
});

test('elementStatus is accepted only when every committed statement is accepted', () => {
  const text = fixture.replace(
    'Speaking frequency is well documented; whether a proposal is taken up is not. [stated]',
    'Speaking frequency is well documented; whether a proposal is taken up is not. [accepted]',
  );
  const parsed = canvas.parseCanvas(text);
  assert.deepEqual(canvas.elementStatus(parsed.elements[0]), { status: 'accepted', open: 1 });
});

test('allStatements flattens with element and question ids', () => {
  const all = canvas.allStatements(canvas.parseCanvas(fixture));
  assert.equal(all.length, 6);
  assert.deepEqual(all.map((s) => s.question), ['1.1', '1.2', '1.2', '2.2', '3.1', '5.1']);
  assert.equal(all[0].element, 1);
  assert.equal(typeof all[0].line, 'number');
});

test('project paths honour PLACET_RESEARCH_DIR and default to research/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  const saved = process.env.PLACET_RESEARCH_DIR;
  delete process.env.PLACET_RESEARCH_DIR;
  assert.equal(project.stateDir(root), path.join(root, 'research'));
  assert.equal(project.canvasPath(root), path.join(root, 'research', 'canvas.md'));
  process.env.PLACET_RESEARCH_DIR = 'paper/state';
  assert.equal(project.decisionsPath(root), path.join(root, 'paper', 'state', 'decisions.md'));
  if (saved === undefined) delete process.env.PLACET_RESEARCH_DIR; else process.env.PLACET_RESEARCH_DIR = saved;
  assert.equal(project.readIfExists(path.join(root, 'nope.md')), null);
});

test('projectDir prefers CLAUDE_PROJECT_DIR, then data.cwd, then process.cwd', () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = '/from/env';
  assert.equal(project.projectDir({ cwd: '/from/data' }), '/from/env');
  delete process.env.CLAUDE_PROJECT_DIR;
  assert.equal(project.projectDir({ cwd: '/from/data' }), '/from/data');
  assert.equal(project.projectDir({}), process.cwd());
  if (saved !== undefined) process.env.CLAUDE_PROJECT_DIR = saved;
});

// SQ-20: the parser stays comment-blind on purpose — a statement wrapped in an
// HTML comment is still a commitment and still protected. What changes is that
// the parser now says it would not be visible to a reader, so the review can
// report the divergence between what the file holds and what the eye sees.
test('a committed statement is marked as hidden when it would not render', () => {
  const base = fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'canvas.md'), 'utf8');
  const accepted = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]";
  assert.ok(base.includes(accepted));

  const visible = canvas.parseCanvas(base);
  const plain = canvas.allStatements(visible).find((s) => s.marker === 'accepted');
  assert.equal(plain.hidden, null, 'an ordinary statement renders');

  // The S10 form: comment markers as their own paragraphs, so the statement
  // keeps its text, its marker and its hash, and disappears from the rendering.
  const commented = canvas.parseCanvas(base.replace(accepted, `<!--\n\n${accepted}\n\n-->`));
  const inComment = canvas.allStatements(commented).find((s) => s.marker === 'accepted');
  assert.equal(inComment.text, plain.text, 'the statement is unchanged');
  assert.equal(inComment.hidden, 'comment');
  assert.equal(canvas.committedSet(commented).size, canvas.committedSet(visible).size);

  // A comment opened and closed on one line hides what sits between.
  const oneLine = canvas.parseCanvas(base.replace(accepted, `<!-- ${accepted} -->`));
  assert.equal(canvas.allStatements(oneLine).find((s) => s.marker === 'accepted'), undefined,
    'on one line the comment markers become part of the text, so this is a different statement');

  // S8: indented four spaces is a code block, which renders as code, not prose.
  const indented = canvas.parseCanvas(base.replace(accepted, `    ${accepted}`));
  assert.equal(canvas.allStatements(indented).find((s) => s.marker === 'accepted').hidden, 'code');

  // A fenced block does the same.
  const fenced = canvas.parseCanvas(base.replace(accepted, '```\n\n' + accepted + '\n\n```'));
  assert.equal(canvas.allStatements(fenced).find((s) => s.marker === 'accepted').hidden, 'code');
});

// SQ-169: a fence is not closed by "any three backticks or tildes". The opener
// fixes a character and a length, and CommonMark closes the block only on a run
// of that same character, at least as long, with nothing but whitespace after
// it. Every other fence-shaped line is content of the block, so a statement
// under one renders as code and the review must report it as hidden.
test('a fence closes only on a same-character run at least as long as its opener', () => {
  const base = fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'canvas.md'), 'utf8');
  const accepted = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]";
  const hiddenOf = (source) => canvas.allStatements(canvas.parseCanvas(source)).find((s) => s.marker === 'accepted').hidden;

  assert.ok(base.includes(accepted));
  assert.equal(hiddenOf(base), null, 'the untouched fixture renders');

  // The triple-fence case the existing report rests on stays what it was.
  assert.equal(hiddenOf(base.replace(accepted, '```\n\n' + accepted + '\n\n```')), 'code');

  // A shorter run inside a longer fence does not close it.
  assert.equal(hiddenOf(base.replace(accepted, '````\n\n```\n\n' + accepted + '\n\n````')), 'code');

  // Neither does the other fence character, in either direction.
  assert.equal(hiddenOf(base.replace(accepted, '```\n\n~~~\n\n' + accepted + '\n\n```')), 'code');
  assert.equal(hiddenOf(base.replace(accepted, '~~~\n\n```\n\n' + accepted + '\n\n~~~')), 'code');

  // An info string belongs to an opener; ```js inside the block stays inside.
  assert.equal(hiddenOf(base.replace(accepted, '```\n\n```js\n\n' + accepted + '\n\n```')), 'code');
});
