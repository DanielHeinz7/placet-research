'use strict';

const fs = require('node:fs');

const KINDS = ['DECISION', 'CONSTRAINT', 'DISCOVERY', 'SESSION', 'MERGE'];
// Written only by their own commands (session start, merge-log); never a
// finding, a cover or an open check (§4).
const MARKER_KINDS = new Set(['SESSION', 'MERGE']);
// The heading grammar of §4.7: seq, date, kind, ref, then an optional `text`
// hash (the §4.4 binding of an acceptance) and an optional `seal` (the §4.7
// chain). The two hashes have two jobs and are never folded into one.
const ENTRY_RE = new RegExp(`^## \\[#(\\d+)\\] (\\d{4}-\\d{2}-\\d{2}) · (${KINDS.join('|')}) · (.+?)(?: · text ([0-9a-f]{8}))?(?: · seal ([0-9a-f]{16}))?$`);

function header(project) {
  return `# Decision log — ${project}\n`;
}

// Every entry carries its body — everything from the line after its heading
// up to the next heading, trimmed — and the character offset of its heading,
// because the seal of the first sealed entry covers every byte before it.
function parseDecisions(text) {
  const entries = [];
  const lines = String(text).split('\n');
  let offset = 0;
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = ENTRY_RE.exec(lines[i]);
    if (m) {
      entries.push({ seq: Number(m[1]), date: m[2], kind: m[3], ref: m[4], hash: m[5] || null, seal: m[6] || null, line: i + 1, offset, body: '' });
      bodies.push([]);
    } else if (bodies.length) {
      bodies[bodies.length - 1].push(lines[i]);
    }
    offset += lines[i].length + 1;
  }
  entries.forEach((e, k) => {
    e.body = bodies[k].join('\n').trim();
    Object.assign(e, bodyFields(e.body));
  });
  const maxSeq = entries.reduce((max, e) => Math.max(max, e.seq), 0);
  return { entries, maxSeq };
}

// The labelled lines formatEntry writes after the text, in their pinned order.
// `By` is first because it names the person, not the entry: it is read as the
// author of what follows, and every entry written here carries it (§3 of the
// 0.5 spec). `By` is a statement, never proof — the seal covers it like the
// rest of the body, so it cannot change afterwards, but anyone holding the key
// can write any name.
const FIELDS = [
  ['by', 'By'],
  ['why', 'Why'],
  ['explained', 'Explained'],
  ['rejected', 'Rejected'],
  ['openAtAccept', 'Open at acceptance'],
  ['supersedes', 'Supersedes'],
];
const FIELD_RE = /^\*\*(By|Why|Explained|Rejected|Open at acceptance|Supersedes):\*\* ?(.*)$/;

// The label a value opens a line with, or null. A line that reads as one of the
// fields is not free text wherever it sits in a body, so every write refuses
// such a value before it lands — the check and the parser ask FIELD_RE, so the
// two can never drift apart (SQ-133).
function fieldLabelIn(text) {
  for (const line of String(text).split('\n')) {
    const m = FIELD_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}

// The first line of an entry's body is its text — the statement an acceptance
// binds, the question a check asks — never one of those labels, however it
// reads. A text of `**Supersedes:** #2` is the researcher's own words about
// something else, and reading it as a field would put a supersede in the record
// that the approval path never wrote (SQ-133).
function bodyFields(body) {
  const found = {};
  let current = null;
  const lines = String(body).split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const m = FIELD_RE.exec(line);
    if (m) {
      current = FIELDS.find(([, label]) => label === m[1])[0];
      found[current] = [m[2]];
    } else if (current) {
      found[current].push(line);
    }
  }
  const value = (key) => (found[key] ? found[key].join('\n').trim() : null);
  const supersedes = /^#(\d+)$/.exec(value('supersedes') || '');
  const open = value('openAtAccept');
  return {
    by: value('by'),
    why: value('why'),
    explained: value('explained'),
    rejected: value('rejected'),
    openAtAccept: open ? open.split(',').map((s) => Number(s.trim().replace(/^#/, ''))).filter(Number.isInteger) : [],
    supersedes: supersedes ? Number(supersedes[1]) : null,
  };
}

function formatEntry({ seq, date, kind, ref, hash, seal, body, by, why, explained, rejected, openAtAccept, supersedes }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown decision kind: ${kind}`);
  const heading = `## [#${seq}] ${date} · ${kind} · ${ref}${hash ? ` · text ${hash}` : ''}${seal ? ` · seal ${seal}` : ''}`;
  const lines = [heading, String(body).trim()];
  if (by) lines.push(`**By:** ${by}`);
  if (why) lines.push(`**Why:** ${why}`);
  if (explained) lines.push(`**Explained:** ${explained}`);
  if (rejected) lines.push(`**Rejected:** ${rejected}`);
  if (openAtAccept && openAtAccept.length) lines.push(`**Open at acceptance:** ${openAtAccept.map((n) => `#${n}`).join(', ')}`);
  if (supersedes) lines.push(`**Supersedes:** #${supersedes}`);
  return `${lines.join('\n')}\n`;
}

// What appending to `current` puts between it and the new entry: exactly one
// blank line. Exported because the seal of a first sealed entry is computed
// over the file content that precedes it, separator included.
function separatorAfter(current) {
  return current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
}

// The only write this module performs. Never rewrites what is there.
function appendEntry(filePath, entryText) {
  let current = '';
  try {
    current = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    current = '';
  }
  fs.appendFileSync(filePath, `${separatorAfter(current)}${entryText}`);
}

module.exports = { KINDS, MARKER_KINDS, header, parseDecisions, formatEntry, separatorAfter, appendEntry, fieldLabelIn };
