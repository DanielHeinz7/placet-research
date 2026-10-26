'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { textHash } = require('../hooks/lib/hash');
const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');

const fixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'decisions.md'),
  'utf8',
);

test('textHash is 8 hex chars and ignores whitespace differences', () => {
  const a = textHash('When do members\'  suggestions\nget taken up?');
  const b = textHash('When do members\' suggestions get taken up?');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, b);
  assert.notEqual(a, textHash('When do members\' suggestions get taken up'));
});

test('parseDecisions reads seq, date, kind, ref and optional hash', () => {
  const parsed = decisions.parseDecisions(fixture);
  assert.equal(parsed.maxSeq, 3);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(
    parsed.entries.map((e) => [e.seq, e.kind, e.ref, e.hash]),
    [
      [1, 'CONSTRAINT', '5 Research Setting', null],
      [2, 'DISCOVERY', '1 Puzzle', null],
      [3, 'DECISION', '1.1 accepted', '3b7a1c9e'],
    ],
  );
  assert.equal(parsed.entries[2].date, '2026-09-15');
});

test('parseDecisions on an empty or header-only file has maxSeq 0', () => {
  assert.equal(decisions.parseDecisions('').maxSeq, 0);
  assert.equal(decisions.parseDecisions(decisions.header('x')).maxSeq, 0);
});

test('formatEntry renders the heading grammar and optional fields', () => {
  const text = decisions.formatEntry({
    seq: 4,
    date: '2026-09-16',
    kind: 'DECISION',
    ref: '3.1 accepted',
    hash: 'deadbeef',
    body: 'Under what conditions ... [accepted]',
    why: 'because',
    rejected: 'the alternative',
  });
  assert.equal(
    text,
    '## [#4] 2026-09-16 · DECISION · 3.1 accepted · text deadbeef\n' +
      'Under what conditions ... [accepted]\n' +
      '**Why:** because\n' +
      '**Rejected:** the alternative\n',
  );
  const plain = decisions.formatEntry({ seq: 5, date: '2026-09-16', kind: 'DISCOVERY', ref: '2 Audience and Prior Research', body: 'x [tentative]', supersedes: 2 });
  assert.equal(plain, '## [#5] 2026-09-16 · DISCOVERY · 2 Audience and Prior Research\nx [tentative]\n**Supersedes:** #2\n');
  assert.throws(() => decisions.formatEntry({ seq: 6, date: '2026-09-16', kind: 'VERDICT', ref: 'x', body: 'y' }), /kind/);
});

test('an entry formatted with a hash round-trips through the parser', () => {
  const entry = decisions.formatEntry({
    seq: 7,
    date: '2026-09-17',
    kind: 'DECISION',
    ref: '1.1 accepted',
    hash: textHash('When do members\' suggestions get taken up?'),
    body: 'When do members\' suggestions get taken up? [accepted]',
  });
  const parsed = decisions.parseDecisions(entry);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].ref, '1.1 accepted');
  assert.equal(parsed.entries[0].hash, textHash('When do members\'  suggestions\n  get taken up?'));
});

test('the labelled fields are written in the pinned order and parse back as fields, alongside body', () => {
  const fields = {
    why: 'because\nit holds across both sites',
    explained: 'I accept that uptake, not voice, is the gap.',
    rejected: 'voice as the gap',
    openAtAccept: [4, 12],
    supersedes: 3,
  };
  const text = decisions.formatEntry({ seq: 13, date: '2026-09-30', kind: 'DECISION', ref: '1.2 accepted', hash: 'deadbeef', body: 'Text. [accepted]', ...fields });
  assert.equal(
    text,
    '## [#13] 2026-09-30 · DECISION · 1.2 accepted · text deadbeef\n' +
      'Text. [accepted]\n' +
      '**Why:** because\nit holds across both sites\n' +
      '**Explained:** I accept that uptake, not voice, is the gap.\n' +
      '**Rejected:** voice as the gap\n' +
      '**Open at acceptance:** #4, #12\n' +
      '**Supersedes:** #3\n',
  );
  const [entry] = decisions.parseDecisions(text).entries;
  for (const [k, v] of Object.entries(fields)) assert.deepEqual(entry[k], v, k);
  assert.equal(entry.body, text.split('\n').slice(1).join('\n').trim(), 'body is still the whole text under the heading');
  // Formatting the parsed fields again gives the same bytes.
  assert.equal(decisions.formatEntry({ seq: 13, date: '2026-09-30', kind: 'DECISION', ref: '1.2 accepted', hash: 'deadbeef', body: 'Text. [accepted]', ...Object.fromEntries(Object.keys(fields).map((k) => [k, entry[k]])) }), text);

  // An entry without labelled lines has no fields; the fixture's #3 has a Why.
  const plain = decisions.parseDecisions(decisions.formatEntry({ seq: 1, date: '2026-09-30', kind: 'DISCOVERY', ref: '1.2 check', body: 'Which meetings?' })).entries[0];
  assert.deepEqual([plain.why, plain.explained, plain.rejected, plain.openAtAccept, plain.supersedes], [null, null, null, [], null]);
  assert.equal(plain.body, 'Which meetings?');
});

test('the entry\'s own first line is its text, never a field label', () => {
  const text = decisions.formatEntry({
    seq: 9,
    date: '2026-09-30',
    kind: 'DECISION',
    ref: '1.2 accepted',
    hash: 'deadbeef',
    body: '**Supersedes:** #1 [accepted]',
  });
  const [entry] = decisions.parseDecisions(text).entries;
  assert.equal(entry.body, '**Supersedes:** #1 [accepted]');
  assert.equal(entry.supersedes, null, 'a statement that reads as a label forges nothing');
  // The labelled line the approval path writes below the text still parses.
  const [both] = decisions.parseDecisions(decisions.formatEntry({
    seq: 10,
    date: '2026-09-30',
    kind: 'DECISION',
    ref: '1.2 accepted',
    body: '**Supersedes:** #1 [accepted]',
    supersedes: 2,
    explained: 'because',
  })).entries;
  assert.equal(both.supersedes, 2);
  assert.equal(both.explained, 'because');
  // What the parser would read back as a field is what a write refuses to
  // build out of a value that is not the entry text (SQ-133).
  assert.equal(decisions.fieldLabelIn('a finding\n**Open at acceptance:** #1'), 'Open at acceptance');
  assert.equal(decisions.fieldLabelIn('**Supersedes:** #1 [accepted]'), 'Supersedes');
  assert.equal(decisions.fieldLabelIn('Which meetings show the uptake in #4?'), null);
});

test('the fixture log, written before labels were refused, still parses to the same fields', () => {
  const [constraint, discovery, decision] = decisions.parseDecisions(fixture).entries;
  assert.equal(constraint.body, 'Only the twelve recorded meetings may be used; no additional fieldwork before submission. [stated]');
  assert.equal(constraint.supersedes, null);
  assert.equal(discovery.why, null);
  assert.equal(decision.body.split('\n').length, 3, 'the text, the Why and the Rejected line — body is the whole text');
  assert.equal(decision.why, 'the phenomenon, not a gap, drives the study.');
  assert.equal(decision.rejected, 'framing it as a voice-frequency question.');
  assert.equal(decision.explained, null, 'no one explained this acceptance; the log does not claim otherwise');
  assert.deepEqual(decision.openAtAccept, []);
  assert.equal(decision.supersedes, null);
});

test('appendEntry only ever appends, with exactly one blank line between entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, decisions.header('voice-uptake'));
  const before = fs.readFileSync(file, 'utf8');
  decisions.appendEntry(file, decisions.formatEntry({ seq: 1, date: '2026-09-16', kind: 'CONSTRAINT', ref: '5 Research Setting', body: 'x [stated]' }));
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.startsWith(before));
  assert.equal(after, '# Decision log — voice-uptake\n\n## [#1] 2026-09-16 · CONSTRAINT · 5 Research Setting\nx [stated]\n');
  decisions.appendEntry(file, decisions.formatEntry({ seq: 2, date: '2026-09-16', kind: 'DISCOVERY', ref: '1 Puzzle', body: 'y [tentative]' }));
  const twice = fs.readFileSync(file, 'utf8');
  assert.ok(twice.startsWith(after));
  assert.equal(decisions.parseDecisions(twice).maxSeq, 2);
  assert.doesNotMatch(twice, /\n\n\n/);
});

test('By is a field: formatEntry writes it first, parseDecisions reads it back, old entries read null', () => {
  const text = decisions.formatEntry({ seq: 1, date: '2026-10-08', kind: 'DISCOVERY', ref: '7', body: 'A finding.', by: 'A. Researcher', why: 'Because.' });
  assert.equal(text, '## [#1] 2026-10-08 · DISCOVERY · 7\nA finding.\n**By:** A. Researcher\n**Why:** Because.\n');
  const [e] = decisions.parseDecisions(text).entries;
  assert.equal(e.by, 'A. Researcher');
  assert.equal(e.why, 'Because.');
  const [old] = decisions.parseDecisions('## [#1] 2026-10-08 · DISCOVERY · 7\nA finding.\n').entries;
  assert.equal(old.by, null);
  assert.equal(decisions.fieldLabelIn('**By:** someone'), 'By');
});

test('SESSION and MERGE parse, format and verify in one chain', () => {
  const key = Buffer.alloc(32, 3);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-')), 'decisions.md');
  fs.writeFileSync(file, '# Decision log — t\n');
  seal.sealedAppend(file, { date: '2026-10-08', kind: 'SESSION', ref: 'Supervision with B. Supervisor', body: 'Session started.', by: 'A. Researcher' }, key);
  seal.sealedAppend(file, { date: '2026-10-08', kind: 'MERGE', ref: 'from abc1234', body: 'Taken up to #1.', by: 'A. Researcher' }, key);
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(decisions.parseDecisions(text).entries.map((e) => [e.seq, e.kind, e.ref]), [[1, 'SESSION', 'Supervision with B. Supervisor'], [2, 'MERGE', 'from abc1234']]);
  assert.equal(seal.verifyChain(text, key).status, 'verified');
  assert.deepEqual([...decisions.MARKER_KINDS], ['SESSION', 'MERGE']);
  assert.equal(decisions.parseDecisions(text).entries[0].by, 'A. Researcher');
});
