'use strict';

const { parseDecisions } = require('./decisions');
const { statusByNumber } = require('./profile');

// The question each element answers, in the reading views' words
// (references/canvas-elements.md). Moved here from the view so the agenda the
// CLI prints and the tab the view shows cannot drift apart (spec §6).
const HUMAN_QUESTIONS = {
  1: 'What puzzles us?',
  2: 'Who cares, and what do they already know?',
  3: 'What exactly do we ask?',
  4: 'What is it made of?',
  5: 'Where do we look?',
  6: 'How do we look?',
  7: 'What did we find?',
  8: 'What does it change?',
  9: 'Where does it stop?',
};

const elementOf = (ref) => {
  const m = /^(\d+)/.exec(ref || '');
  return m ? Number(m[1]) : null;
};

// The state before a session: every field not yet accepted that has a
// finding, with its findings, and every question nobody has answered.
function agendaOf(parsed, decisionsText) {
  const statuses = statusByNumber(parsed);
  const { entries } = parseDecisions(decisionsText || '');
  const fields = [];
  const gaps = [];
  for (const e of parsed.elements) {
    const question = HUMAN_QUESTIONS[e.number] || e.title;
    const accepted = statuses[e.number] && statuses[e.number].status === 'accepted';
    const findings = accepted ? [] : entries
      .filter((d) => d.kind === 'DISCOVERY' && elementOf(d.ref) === e.number)
      .map((d) => ({ seq: d.seq, ref: d.ref, date: d.date, body: d.body, by: d.by, why: d.why }));
    if (findings.length) fields.push({ number: e.number, question, findings });
    for (const q of e.questions) {
      if (!q.statements.length) gaps.push({ number: e.number, question, questionId: q.id, text: q.text });
    }
  }
  return { fields, gaps };
}

function agendaMarkdown(agenda, { title, date, seal }) {
  const out = [`# Agenda — ${title}`, '', `Date: ${date}`, `Seal: ${seal}`, ''];
  for (const f of agenda.fields) {
    out.push(`## ${f.number} · ${f.question}`, '');
    for (const d of f.findings) out.push(`- #${d.seq} ${d.body.split('\n')[0]} (By: ${d.by || 'unknown'})`);
    out.push('');
  }
  if (agenda.gaps.length) {
    out.push('## Not answered yet', '');
    for (const g of agenda.gaps) out.push(`- ${g.number} · ${g.question} — ${g.questionId} ${g.text}`);
    out.push('');
  }
  if (!agenda.fields.length && !agenda.gaps.length) out.push('Nothing to talk about right now.', '');
  return out.join('\n');
}

module.exports = { HUMAN_QUESTIONS, agendaOf, agendaMarkdown };
