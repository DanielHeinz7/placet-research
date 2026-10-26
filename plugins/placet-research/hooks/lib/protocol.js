'use strict';

const canvas = require('./canvas');
const { parseDecisions } = require('./decisions');
const { verifyChain, logAnchor, WRONG_KEY } = require('./seal');
const { textHash } = require('./hash');
const { findQuestion } = require('./state');
const { openChecks } = require('./accept');

function refuse(code, error) {
  return { ok: false, code, error };
}

const ACCEPT_REF = /^([1-9]\.\d+) accepted$/;
// A glossary acceptance is named by the entry id, and its body is the accepted
// payload (§ Authorization and text binding), so the section can show it
// without reading the glossary the section was written against.
const GLOSSARY_ACCEPT_REF = /^glossary ([a-z0-9]+(?:-[a-z0-9]+)*) accepted$/;
const CHECK_REF = /^([1-9]\.\d+) check$/;
const firstLine = (body) => String(body || '').split('\n')[0];
const who = (e) => e.by || 'unknown';

// What happened in one session (spec §5): the entries from its SESSION marker
// to the next marker or the end of the log. Read-only.
function protocolOf({ decisionsText, canvasText, key = null, seq } = {}) {
  const text = String(decisionsText || '');
  const { entries } = parseDecisions(text);
  const markers = entries.filter((e) => e.kind === 'SESSION');
  if (!markers.length) return refuse('not-found', 'The log has no session marker. Start one with placet-research session start "<occasion>".');
  const marker = seq === undefined ? markers[markers.length - 1] : markers.find((m) => m.seq === seq);
  if (!marker) return refuse('not-found', `#${seq} is not a session marker; the markers are ${markers.map((m) => `#${m.seq}`).join(', ')}.`);
  const start = entries.indexOf(marker);
  const nextMarker = markers[markers.indexOf(marker) + 1];
  const end = nextMarker ? entries.indexOf(nextMarker) : entries.length;
  const section = entries.slice(start, end);
  const upTo = text.slice(0, nextMarker ? nextMarker.offset : text.length).replace(/\n+$/, '\n');
  const last = section[section.length - 1];

  const chain = verifyChain(text, key);
  // A wrong key breaks no entry: the section is not checked on this machine
  // rather than broken at an entry, and no entry number is named (SQ-294).
  const keyBreak = !!(chain.broken && chain.broken.why === 'key');
  const brokenHere = !keyBreak && chain.broken && chain.broken.seq <= last.seq;
  const sealLine = keyBreak
    ? `not checked here (${WRONG_KEY})`
    : brokenHere
      ? `broken at #${chain.broken.seq} (${chain.broken.why})`
      : section.every((e) => chain.verified.has(e.seq)) ? 'verified' : 'unverifiable here (no key)';

  const parsed = canvasText ? canvas.parseCanvas(canvasText) : null;
  const statementOf = (e, questionId) => {
    const q = parsed ? findQuestion(parsed, questionId).question : null;
    const found = q ? q.statements.find((s) => textHash(s.text) === e.hash) : null;
    return found ? found.text : `text changed since (text ${e.hash})`;
  };

  const out = [];
  if (keyBreak) out.push(`**Not checked on this computer** — ${WRONG_KEY}; read what follows as unconfirmed.`, '');
  else if (brokenHere) out.push(`**BROKEN at #${chain.broken.seq}** — the log does not verify from this entry on; read what follows as unconfirmed.`, '');
  out.push(`# Session protocol — ${marker.ref}`, '', `Date: ${marker.date}`, `Participants: ${[...new Set(section.map(who))].join(', ')}`, '');

  const accepted = section.filter((e) => e.kind === 'DECISION');
  out.push('## Accepted', '');
  if (!accepted.length) out.push('Nothing was accepted.');
  for (const e of accepted) {
    const q = ACCEPT_REF.exec(e.ref);
    const g = q ? null : GLOSSARY_ACCEPT_REF.exec(e.ref);
    if (q) out.push(`- **${q[1]}** (#${e.seq}) — ${statementOf(e, q[1])}`);
    else if (g) out.push(`- **glossary ${g[1]}** (#${e.seq}) — accepted payload ${firstLine(e.body)}`);
    else out.push(`- **${e.ref}** (#${e.seq}) — ${firstLine(e.body)}`);
    if (e.explained) out.push(`  Explained: ${e.explained}`);
    out.push(`  By: ${who(e)}`);
    if (e.supersedes) out.push(`  Supersedes: #${e.supersedes}`);
  }
  out.push('');

  const noted = section.filter((e) => e.kind === 'DISCOVERY' || e.kind === 'CONSTRAINT');
  out.push('## Noted', '');
  if (!noted.length) out.push('Nothing was noted.');
  for (const e of noted) {
    out.push(`- ${e.kind} ${e.ref} (#${e.seq}) — ${firstLine(e.body)}`);
    if (e.why) out.push(`  Why: ${e.why}`);
    out.push(`  By: ${who(e)}`);
  }
  out.push('');

  const questions = [...new Set(parseDecisions(upTo).entries.map((e) => CHECK_REF.exec(e.ref.trim())).filter(Boolean).map((m) => m[1]))];
  const open = questions.flatMap((q) => openChecks(upTo, q));
  out.push('## Open at the end', '');
  if (!open.length) out.push('No check question was open.');
  for (const e of open) out.push(`- ${e.ref} #${e.seq} — ${firstLine(e.body)}`);
  out.push('', '---', '', `Seal: ${sealLine}. Entries #${marker.seq}–#${last.seq}.`, `Anchor: ${logAnchor(upTo)}`, '');
  return { ok: true, markdown: out.join('\n') };
}

module.exports = { protocolOf };
