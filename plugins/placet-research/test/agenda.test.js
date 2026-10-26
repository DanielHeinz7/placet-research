'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const canvas = require('../hooks/lib/canvas');
const profile = require('../hooks/lib/profile');
const { findQuestion } = require('../hooks/lib/state');
const { HUMAN_QUESTIONS, agendaOf, agendaMarkdown } = require('../hooks/lib/agenda');

const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');
const canvasText = fs.readFileSync(path.join(fixtureDir, 'canvas.md'), 'utf8');
const decisionsText = fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8');

test('agendaOf: open fields with their findings and By, unanswered questions, accepted fields left out', () => {
  const parsed = canvas.parseCanvas(canvasText);
  const a = agendaOf(parsed, decisionsText);
  // The fixture's one DISCOVERY is on element 1; the empty questions of every
  // field are the gaps.
  assert.ok(a.fields.some((f) => f.number === 1), 'the fixture puts a finding on element 1');
  assert.ok(a.gaps.some((g) => g.questionId === '1.3'), 'the fixture leaves 1.3 unanswered');
  // every listed field has findings, none is accepted
  for (const f of a.fields) {
    assert.ok(f.findings.length);
    assert.notEqual(profile.statusByNumber(parsed)[f.number].status, 'accepted');
    assert.equal(f.question, HUMAN_QUESTIONS[f.number]);
    for (const d of f.findings) assert.ok('by' in d);
  }
  // every gap is a question without statements
  for (const g of a.gaps) assert.equal(findQuestion(parsed, g.questionId).question.statements.length, 0);
});

test('a field leaves the agenda once accepted', () => {
  const before = agendaOf(canvas.parseCanvas(canvasText), decisionsText);
  const field = before.fields[0];
  assert.ok(field, 'the fixture puts a field on the agenda');
  const number = field.number;

  // The accept path changes the marker and keeps the text; here every
  // statement of that field is accepted at once, scoped to the field's own
  // slice of the canvas so no other field is touched.
  const from = canvasText.indexOf(`# ${number} · `);
  const next = canvasText.indexOf(`# ${number + 1} · `);
  const to = next === -1 ? canvasText.length : next;
  assert.ok(from >= 0 && to > from, 'the field is one section of the canvas');
  const acceptedText = canvasText.slice(0, from)
    + canvasText.slice(from, to).replace(/\[(stated|proposed)\]/g, '[accepted]')
    + canvasText.slice(to);

  const parsed = canvas.parseCanvas(acceptedText);
  assert.equal(profile.statusByNumber(parsed)[number].status, 'accepted', 'the edited field is accepted now');
  const after = agendaOf(parsed, decisionsText);
  assert.equal(after.fields.find((f) => f.number === number), undefined, 'the accepted field is off the agenda');
});

test('agendaMarkdown: header, per field the human question and findings with By, then Not answered yet', () => {
  const md = agendaMarkdown({ fields: [{ number: 7, question: 'What did we find?', findings: [{ seq: 4, ref: '7', date: '2026-10-08', body: 'A finding.\n**By:** B. Supervisor', by: 'B. Supervisor', why: null }] }], gaps: [{ number: 9, question: 'Where does it stop?', questionId: '9.1', text: 'What are the limits?' }] }, { title: 'Voice Uptake', date: '2026-10-08', seal: 'ledger: 4 entries, all verified' });
  assert.equal(md, [
    '# Agenda — Voice Uptake', '',
    'Date: 2026-10-08', 'Seal: ledger: 4 entries, all verified', '',
    '## 7 · What did we find?', '',
    '- #4 A finding. (By: B. Supervisor)', '',
    '## Not answered yet', '',
    '- 9 · Where does it stop? — 9.1 What are the limits?', '',
  ].join('\n'));
});
