'use strict';

const crypto = require('node:crypto');

const lineEndings = require('./line-endings');

const MARKERS = ['proposed', 'tentative', 'stated', 'accepted'];
const COMMITTED = new Set(['stated', 'accepted']);
const EMPTY_PLACEHOLDER = '_(empty)_';

const ELEMENT_RE = /^# ([1-9]) · (.+)$/;
const QUESTION_RE = /^## ([1-9]\.\d+) (.+)$/;
const MARKER_GROUP_RE = /\s*\[([^[\]]+)\]\s*$/;

// The field separator of a canonical commitment (§4.3.1): a character the
// researcher cannot have typed into Markdown.
const COMMIT_SEP = '';

// The collapse class is exactly space, tab, CR and LF — not JavaScript's `\s`,
// which also matches U+00A0 and U+FEFF. A reflow only ever introduces these
// four; anything else a write pushes into a committed statement is a change to
// it, and treating U+00A0 as whitespace is what let SQ-21's D5b and D5c rewrite
// an accepted statement with the guard seeing no difference at all (§4.3.1).
const COLLAPSE_RE = /[ \t\r\n]+/g;

// NFC, never NFKC: compatibility folding would equate `½` with `1⁄2` and let a
// committed statement be rewritten inside its own hash.
function normalizeText(text) {
  return String(text).normalize('NFC').replace(COLLAPSE_RE, ' ').trim();
}

// Which lines would not reach a reader of the rendered Markdown (SQ-20). The
// parser stays blind to comments on purpose: a statement wrapped in one is
// still a commitment and still protected, and stripping comments would put a
// statement the researcher commented out themselves beyond the guard's reach.
// What the harness owes them instead is the truth that the file and the eye
// disagree, so every line gets a reason or null and `canvas-review` reports the
// committed statements that sit on one. Indentation (S8) and a fence hide a
// statement exactly as a comment (S10) does, which is why this is one question
// and not two.
// A fence is not closed by "any three backticks or tildes" (SQ-169). Its opener
// fixes a character and a length, and CommonMark closes the block only on a run
// of that same character, at least as long, with nothing but whitespace after
// it. A shorter run, the other character or a line carrying an info string is
// content of the block, so a statement under one renders as code and is as
// hidden as one under the opener.
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

function hiddenLines(lines) {
  const reasons = new Array(lines.length).fill(null);
  let inComment = false;
  let fenceChar = null;
  let fenceLength = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence && !inComment) {
      reasons[i] = 'code';
      const run = fence[1];
      if (fenceChar === null) {
        fenceChar = run[0];
        fenceLength = run.length;
      } else if (run[0] === fenceChar && run.length >= fenceLength && fence[2].trim() === '') {
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceChar !== null) {
      reasons[i] = 'code';
      continue;
    }
    // A comment can open and close on the same line, so the state is read off
    // the last marker rather than toggled per line.
    const opens = line.lastIndexOf('<!--');
    const closes = line.lastIndexOf('-->');
    const hasMarker = opens >= 0 || closes >= 0;
    if (inComment || hasMarker) reasons[i] = 'comment';
    if (opens > closes) inComment = true;
    else if (closes > opens) inComment = false;
    if (reasons[i] === null && /^(?: {4,}|\t)/.test(line) && line.trim() !== '') reasons[i] = 'code';
  }
  return reasons;
}

// `init` writes the researcher's own text — the project slug and the outlet —
// as a double-quoted YAML scalar, because such a value may hold ": ", "#" or a
// quote of its own and a bare one makes the frontmatter unparseable (SQ-77).
// The quotes and the escapes they carry belong to the encoding, not to the
// value: `status` and `review` must show the outlet the researcher typed.
// A quoted scalar this parser cannot decode (a hand-written YAML escape JSON
// does not know) is left as it stands rather than guessed at.
function frontmatterScalar(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function parseFrontmatter(lines) {
  if (lines[0] !== '---') return { data: {}, end: 0 };
  const data = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return { data, end: i + 1 };
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (m) data[m[1]] = frontmatterScalar(m[2].trim());
  }
  return { data, end: lines.length, unterminated: true };
}

// "Some text. [marker, tag, tag]" → { text, marker, tags } or null when the
// trailing bracket group is missing or its first token is not a known marker.
function parseMarkerGroup(paragraph) {
  const m = MARKER_GROUP_RE.exec(paragraph);
  if (!m) return null;
  const parts = m[1].split(',').map((p) => p.trim()).filter(Boolean);
  if (!MARKERS.includes(parts[0])) return null;
  return { text: paragraph.slice(0, m.index).trim(), marker: parts[0], tags: parts.slice(1) };
}

function elementOf(questionId) {
  return Number(String(questionId).split('.')[0]);
}

// §4.2's three structural laws. A canvas holding two of the same heading is not
// untidy — it is a document with two readings, and every consumer silently
// picked one of them. The parser reports the breach and neither merges,
// prefers nor overwrites either reading; resolving it is the researcher's act.
// Both line numbers are named, because they are what the researcher needs to
// find the duplicate.
function structuralProblems(elements) {
  const problems = [];
  const elementLines = new Map();
  const questionLines = new Map();
  const misplaced = [];

  for (const el of elements) {
    if (!elementLines.has(el.number)) elementLines.set(el.number, []);
    elementLines.get(el.number).push(el.line);
    for (const q of el.questions) {
      if (!questionLines.has(q.id)) questionLines.set(q.id, []);
      questionLines.get(q.id).push(q.line);
      if (elementOf(q.id) !== el.number) misplaced.push({ q, element: el.number });
    }
  }

  for (const number of [...elementLines.keys()].sort((a, b) => a - b)) {
    const lines = elementLines.get(number);
    if (lines.length > 1) {
      problems.push(`element ${number} has ${lines.length} headings (lines ${lines.join(', ')}); while both stand it has no status, and the model may not resolve the duplicate`);
    }
  }
  for (const id of [...questionLines.keys()].sort()) {
    const lines = questionLines.get(id);
    if (lines.length > 1) {
      problems.push(`question ${id} has ${lines.length} headings (lines ${lines.join(', ')}); while both stand it has no single reading, and the model may not resolve the duplicate`);
    }
  }
  for (const m of misplaced) {
    problems.push(`line ${m.q.line}: question ${m.q.id} sits under element ${m.element}, but a question belongs to the element it is numbered for`);
  }
  return problems;
}

function parseCanvas(text) {
  const lines = String(text).split('\n');
  const fm = parseFrontmatter(lines);
  const hidden = hiddenLines(lines);
  const hiddenAt = (index) => (index >= 0 && index < hidden.length ? hidden[index] : null);
  const result = { frontmatter: fm.data, elements: [], problems: [] };
  const crlf = lineEndings.firstCrlfLine(text);
  if (crlf) result.problems.push(lineEndings.crlfProblem(crlf));
  if (fm.unterminated) result.problems.push('frontmatter is not terminated');

  let element = null;
  let question = null;
  let paragraph = [];
  let paragraphStart = -1;

  const flush = () => {
    if (!paragraph.length) return;
    const raw = paragraph.join('\n');
    const line = paragraphStart + 1;
    paragraph = [];
    paragraphStart = -1;
    if (raw.trim() === EMPTY_PLACEHOLDER) return;
    const hidden = hiddenAt(line - 1);
    if (!question) {
      result.problems.push(`line ${line}: text outside any question`);
      return;
    }
    const group = parseMarkerGroup(raw);
    if (!group) {
      question.statements.push({ text: normalizeText(raw), marker: null, tags: [], raw, line, hidden });
      return;
    }
    question.statements.push({ text: normalizeText(group.text), marker: group.marker, tags: group.tags, raw, line, hidden });
  };

  for (let i = fm.end; i < lines.length; i += 1) {
    const l = lines[i];
    const el = ELEMENT_RE.exec(l);
    if (el) {
      flush();
      element = { number: Number(el[1]), title: el[2].trim(), questions: [], line: i + 1 };
      result.elements.push(element);
      question = null;
      continue;
    }
    const q = QUESTION_RE.exec(l);
    if (q) {
      flush();
      if (!element) {
        result.problems.push(`line ${i + 1}: question outside any element`);
        continue;
      }
      question = { id: q[1], text: q[2].trim(), statements: [], line: i + 1 };
      element.questions.push(question);
      continue;
    }
    if (l.trim() === '') {
      flush();
      continue;
    }
    if (!paragraph.length) paragraphStart = i;
    paragraph.push(l);
    // A statement closes where its marker group closes. The canvas of §4.2
    // writes consecutive statements on consecutive lines, so a blank line is
    // not the only boundary. A statement may still run over several lines: it
    // ends at the line that carries the marker. Text with no marker group, or
    // with an unknown one, keeps accumulating to the next blank line.
    if (parseMarkerGroup(paragraph.join('\n'))) flush();
  }
  flush();
  result.problems.push(...structuralProblems(result.elements));
  result.problems.push(...controlCharacterProblems(result.elements));
  return result;
}

// Sorting "by code point" is not Array#sort's default, which orders by UTF-16
// code unit and disagrees with it above the BMP.
function compareByCodePoint(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

// A commitment is a statement carrying [stated] or [accepted] together with
// everything that gives it its meaning (§4.3.1). The first implementation
// identified a statement by question id and text alone, which left the element
// it sits under, that element's title, the wording of its own question and its
// evidence tags free to change underneath it — every structural hole SQ-21
// found went through one of those, leaving the key identical.
//
// The separator's whole justification is that a field cannot carry one (§4.3.1:
// "a character the researcher cannot have typed into Markdown"), and that
// justification is false — it can be pasted, and a model can write it. A field
// holding U+001F reproduces the boundary between two fields of the canonical
// line, so content crosses that boundary with the joined string unchanged and
// `committedSet` reads a re-cut commitment as the one it replaced (SQ-29's
// F9, K3/K4/K7/K8). Every other C0 control character does the same job one
// boundary over, so a committed statement whose fields carry one has no
// canonical form at all. Tab, CR and LF never reach a field: normalizeText
// collapses them first, which is why ordinary multi-line and tab-indented
// canvas content stays judgeable.
const CONTROL_CHAR_RE = /[\u0000-\u001f]/;
const CONTROL_FIELDS = [
  'the element number',
  'the element title',
  'the question id',
  'the question text',
  'the marker',
  'the statement text',
  'an evidence tag',
];

// Fields in the order of §4.3.1's table, with the evidence tags sorted so that
// reordering them is not a change. Built as a list, not joined here, so that
// the join and the control-character rule below read the same seven fields.
function canonicalFields(element, question, statement) {
  const tags = statement.tags.map(normalizeText).filter(Boolean).sort(compareByCodePoint);
  return [
    String(element.number),
    normalizeText(element.title),
    normalizeText(question.id),
    normalizeText(question.text),
    statement.marker,
    normalizeText(statement.text),
    tags.join(', '),
  ];
}

function canonicalCommitment(element, question, statement) {
  return canonicalFields(element, question, statement).join(COMMIT_SEP);
}

// Which field of a commitment carries a C0 control character, as the field's
// name and the character, or null. `parseCanvas` reports it as a problem, so
// the CLI's `review` prints it and the guard refuses the write that produced it
// — one rule, one place, both readers (§4.3.1, SQ-29 F9).
function controlCharacterField(element, question, statement) {
  const fields = canonicalFields(element, question, statement);
  for (let i = 0; i < fields.length; i += 1) {
    const found = CONTROL_CHAR_RE.exec(fields[i]);
    if (!found) continue;
    const code = found[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return { where: CONTROL_FIELDS[i], char: `U+${code}` };
  }
  return null;
}

// One problem per commitment that has no canonical form, in the shape the
// parser's other problems take: the line the researcher can go to.
function controlCharacterProblems(elements) {
  const problems = [];
  for (const el of elements) {
    for (const q of el.questions) {
      for (const s of q.statements) {
        if (!COMMITTED.has(s.marker)) continue;
        const bad = controlCharacterField(el, q, s);
        if (!bad) continue;
        problems.push(`line ${s.line}: the [${s.marker}] statement in question ${q.id} carries the control character ${bad.char} in ${bad.where}, and a field of a canonical commitment may not: it reproduces the U+001F separator the commitment is built from, so the commitment cannot be judged until the character is removed`);
      }
    }
  }
  return problems;
}

// How a commitment is named where it must be named compactly — a refusal text,
// canvas-review output, the stage-2 view. Deliberately not §4.4's
// `text <hash>`: that one covers the statement text alone, so an acceptance
// survives the researcher retitling the element around it, while this one
// changes, because for the model that retitle is a different commitment.
function commitmentHash(canonicalLine) {
  return crypto.createHash('sha256').update(String(canonicalLine), 'utf8').digest('hex').slice(0, 8);
}

// C(x) of §4.3.1. A set and not a sequence: reordering statements inside a
// question changes nothing, and a statement duplicated verbatim is the same
// commitment twice. Statements carrying [proposed] or [tentative] are not
// members at all and stay as free as §5.3 already makes them.
function committedSet(parsed) {
  const map = new Map();
  for (const el of parsed.elements) {
    for (const q of el.questions) {
      for (const s of q.statements) {
        if (!COMMITTED.has(s.marker)) continue;
        const line = canonicalCommitment(el, q, s);
        if (map.has(line)) continue;
        map.set(line, {
          canonical: line,
          hash: commitmentHash(line),
          element: el.number,
          elementTitle: el.title,
          question: q.id,
          questionText: q.text,
          marker: s.marker,
          text: s.text,
          tags: s.tags.map(normalizeText).filter(Boolean).sort(compareByCodePoint),
          line: s.line,
        });
      }
    }
  }
  return map;
}

// Status comes from committed statements only (§4.4). Proposals sit alongside
// and never lower it; they are counted in `open`.
function elementStatus(element) {
  const all = element.questions.flatMap((q) => q.statements);
  const committed = all.filter((s) => COMMITTED.has(s.marker));
  const open = all.length - committed.length;
  if (!all.length) return { status: 'empty', open: 0 };
  if (!committed.length) return { status: 'open', open };
  const status = committed.every((s) => s.marker === 'accepted') ? 'accepted' : 'stated';
  return { status, open };
}

function allStatements(parsed) {
  const out = [];
  for (const el of parsed.elements) {
    for (const q of el.questions) {
      for (const s of q.statements) out.push({ element: el.number, question: q.id, ...s });
    }
  }
  return out;
}

module.exports = {
  MARKERS,
  COMMITTED,
  EMPTY_PLACEHOLDER,
  COMMIT_SEP,
  normalizeText,
  compareByCodePoint,
  parseMarkerGroup,
  parseCanvas,
  hiddenLines,
  structuralProblems,
  canonicalCommitment,
  controlCharacterField,
  controlCharacterProblems,
  commitmentHash,
  committedSet,
  elementStatus,
  allStatements,
};
