'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { allStatements, COMMITTED, compareByCodePoint, normalizeText } = require('./canvas');
const { textHash } = require('./hash');
const { parseDecisions, MARKER_KINDS } = require('./decisions');
const { verifyChain, WRONG_KEY } = require('./seal');
const { dependencyViolations, statusByNumber } = require('./profile');
const glossaryLib = require('./glossary');

const ACCEPT_REF_RE = /^([1-9]\.\d+) accepted$/;
// The glossary's acceptance ref (§ Authorization and text binding): the same
// question asked about an entry payload instead of a statement text.
const GLOSSARY_ACCEPT_REF_RE = /^glossary ([a-z0-9]+(?:-[a-z0-9]+)*) accepted$/;
const COMMITTED_MARKERS = COMMITTED;

// The element a log entry is about: `4.1 accepted`, `7.2 check`, a bare `7`.
const ELEMENT_REF_RE = /^([1-9])(?:\.\d+)?(?:\s|$)/;
function elementOfRef(ref) {
  const m = ELEMENT_REF_RE.exec(String(ref || '').trim());
  return m ? Number(m[1]) : null;
}

// The `hypotheses-before-data` check (references/preregistration.md): the
// sealed log orders events, so it can show whether the hypotheses (4) and the
// design (6) were accepted before the first finding (7) was recorded. It
// reports; it never blocks. A session marker is not a finding: an occasion
// like "7 October supervision" would otherwise read as element 7 (§4).
function findingsBeforeHypotheses(decisionsText) {
  const entries = parseDecisions(decisionsText || '').entries.filter((e) => !MARKER_KINDS.has(e.kind));
  const first = entries.find((e) => elementOfRef(e.ref) === 7);
  if (!first) return [];
  return [4, 6]
    .filter((n) => !entries.some((e) => e.kind === 'DECISION' && elementOfRef(e.ref) === n && e.seq < first.seq))
    .map((n) => ({ element: n, finding: first.seq }));
}

// ---------- glossary mechanics (§ Mechanical review and its limits) ----------
//
// Package 3 of the construct-glossary design: what a deterministic pass over
// the glossary, the canvas and the declared manuscripts can say about declared
// construct coverage — and, printed with every report, what it cannot. Nothing
// here repairs, reaccepts or invalidates anything; a changed definition names
// the canvas statements and manuscript locations that rest on it and leaves
// them standing (§ Authorization and text binding). A check that could not run
// says `not checked`, never zero findings, which would read as a clean result.

const GLOSSARY_ELEMENTS = new Set([3, 4, 7, 8]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const SRC_PREFIX_RE = /^src:[ \t]*/;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An explicit Unicode word boundary: a declared label is matched as a word of
// its own, so `uptake` does not match inside `uptakes` (no stemming), and a
// label outside ASCII is bounded by letters of its own script rather than by an
// ASCII approximation of them. No `g` flag: one expression is tested many
// times and must stay stateless.
function labelRegExp(label) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(label)}(?![\\p{L}\\p{N}_])`, 'iu');
}

// The source with the given ranges blanked to spaces: every offset, and with it
// every line number the report prints, stays where it was. The replacement
// walks UTF-16 code units (`[^\n]`), so the masked text has the source's exact
// length even where the source carries astral characters.
function blankRegions(source, regions) {
  const parts = [];
  let at = 0;
  for (const region of [...regions].sort((a, b) => a.start - b.start)) {
    if (region.start < at) continue;
    parts.push(source.slice(at, region.start), source.slice(region.start, region.end).replace(/[^\n]/g, ' '));
    at = region.end;
  }
  parts.push(source.slice(at));
  return parts.join('');
}

function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = low + Math.floor((high - low + 1) / 2);
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s/;
const BIBLIOGRAPHY_RE = /^#{1,6}\s+(?:references|bibliography|works cited)\s*$/i;
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const MD_LINK_RE = /\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
const CONSTRUCTS_RE = /constructs\s*:\s*([\s\S]*)$/i;

// One Markdown document read for the cross-check: its prose with fenced code, a
// bibliography section, inline code, link destinations and HTML comments
// blanked out, plus the glossary links and `constructs:` declarations those
// regions held. A declaration is machine-readable usage even though a reader of
// the rendered manuscript never sees it (§ Manuscript citation form), so it is
// parsed here rather than left to the masked prose.
function readProse(source, { base, glossaryFile }) {
  const text = String(source);
  const starts = lineStartsOf(text);
  const regions = [];
  const excluded = new Set();
  const lines = text.split('\n');
  let offset = 0;
  let fence = null;
  let bibliography = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const at = offset;
    offset += line.length + 1;
    if (fence !== null) {
      regions.push({ start: at, end: at + line.length });
      excluded.add(i + 1);
      if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
      continue;
    }
    if (bibliography !== null) {
      regions.push({ start: at, end: at + line.length });
      excluded.add(i + 1);
      const heading = HEADING_RE.exec(line);
      if (heading && heading[1].length <= bibliography) bibliography = null;
      continue;
    }
    const open = FENCE_RE.exec(line);
    if (open !== null) {
      fence = { char: open[1][0], length: open[1].length };
      regions.push({ start: at, end: at + line.length });
      excluded.add(i + 1);
      continue;
    }
    if (BIBLIOGRAPHY_RE.test(line)) {
      bibliography = HEADING_RE.exec(line)[1].length;
      regions.push({ start: at, end: at + line.length });
      excluded.add(i + 1);
    }
  }

  // A declaration inside a code example is part of the example, not a statement
  // about the manuscript.
  const declarations = [];
  for (const m of text.matchAll(COMMENT_RE)) {
    const line = lineOf(starts, m.index);
    if (excluded.has(line)) continue;
    regions.push({ start: m.index, end: m.index + m[0].length });
    const declared = CONSTRUCTS_RE.exec(m[1]);
    if (!declared) continue;
    const ids = declared[1].split(',').map((part) => part.trim()).filter(Boolean);
    if (ids.length) declarations.push({ ids, line });
  }

  const withoutComments = blankRegions(text, regions);
  for (const m of withoutComments.matchAll(INLINE_CODE_RE)) {
    regions.push({ start: m.index, end: m.index + m[0].length });
  }

  const withoutCode = blankRegions(text, regions);
  const links = [];
  for (const m of withoutCode.matchAll(MD_LINK_RE)) {
    // Every link destination is blanked, not just the glossary ones: a URL or a
    // file path is not prose, and a label word inside it — `uptake-2026` in a
    // registration address — must not read as the manuscript's own usage. Only
    // a destination that resolves to the glossary is recorded as a citation.
    const destination = m.index + m[0].indexOf(']') + 2;
    regions.push({ start: destination, end: destination + m[2].length });
    const id = glossaryLib.referenceId(m[2], base, glossaryFile);
    if (id === null) continue;
    links.push({ id, line: lineOf(starts, m.index) });
  }

  return { prose: blankRegions(text, regions), links, declarations };
}

// The paragraphs of a document: a run of source lines that hold anything but
// whitespace. A line blanked out — a comment, a code span, a link destination —
// does not break the run, so a declaration inside a paragraph covers that
// paragraph, and one on a line of its own between two paragraphs covers the
// paragraph before it.
function paragraphsOf(source, prose) {
  const sourceLines = String(source).split('\n');
  const proseLines = String(prose).split('\n');
  const blocks = [];
  let current = null;
  for (let i = 0; i < sourceLines.length; i += 1) {
    if (sourceLines[i].trim() === '') {
      current = null;
      continue;
    }
    if (current === null) {
      current = { start: i + 1, end: i + 1, prose: proseLines[i].trim() !== '' };
      blocks.push(current);
    } else {
      current.end = i + 1;
      if (proseLines[i].trim() !== '') current.prose = true;
    }
  }
  return blocks;
}

function paragraphFor(blocks, line) {
  const own = blocks.find((b) => line >= b.start && line <= b.end);
  if (own && own.prose) return own;
  let before = null;
  for (const b of blocks) {
    if (!b.prose || b.end >= line) continue;
    if (!before || b.end > before.end) before = b;
  }
  return before || null;
}

// How an entry reads at a reference: its authorization marker, and — because a
// proposal is an entry but not an accepted one — what is still missing.
function entryStateLabel(entry) {
  if (entry === null) return null;
  const marker = entry.marker === null ? 'unmarked' : entry.marker;
  const missing = entry.incomplete.filter((i) => i !== 'no authorization marker');
  return missing.length ? `${marker}, incomplete: ${missing.join('; ')}` : marker;
}

function unresolvedReason(id, idCounts) {
  const seen = idCounts.get(id) || 0;
  return seen > 1
    ? `the id "${id}" has ${seen} headings; while both stand it is not a link target and neither entry may be read`
    : `no entry has the id "${id}"`;
}

// What a DECISION entry that does not verify is, in the order the researcher
// needs to know it: after the break everything is broken; before the first seal
// everything is legacy; a sealed entry with no key here is unverifiable.
function decisionState(ledger, e) {
  if (ledger.verified.has(e.seq)) return 'verified';
  if (ledger.broken && e.seq >= ledger.broken.seq) return 'broken';
  if (ledger.legacy.includes(e.seq)) return 'legacy';
  return 'unverifiable';
}

// What the `glossary <id> accepted` decisions say about the entries now: an
// accepted payload that changed, an accepted entry whose id is gone, a marker
// with no decision behind it, and a payload a decision binds that does not
// verify. Reflow alone changes no payload hash, so it passes. The location list
// is the point: a changed definition names what depends on it.
function glossaryStability({ resolvable, acceptedById, decisionsById, coverFor, locationsOf }) {
  const findings = [];
  const ids = [...new Set([...decisionsById.keys(), ...acceptedById.keys()])].sort(compareByCodePoint);
  for (const id of ids) {
    const entry = resolvable.get(id) || null;
    const decisions = decisionsById.get(id) || [];
    const accepted = acceptedById.get(id) || null;
    const newest = decisions.length ? decisions[decisions.length - 1] : null;
    const current = entry ? glossaryLib.payloadHash(entry) : null;
    const cover = current === null ? null : coverFor(id, current);
    if (entry === null) {
      // A decision names an id no entry carries: reported rather than passed in
      // silence, whether the entry was deleted or never written.
      // No single entry carries the id — deleted, or two headings share it.
      findings.push({ kind: 'deleted', id, seq: newest === null ? null : newest.seq, hash: newest === null ? null : newest.hash, locations: locationsOf(id) });
      continue;
    }
    if (accepted !== null) {
      if (cover !== null && cover.state === 'verified') {
        // Superseded history, not drift: an older decision bound a payload a
        // newer verified one replaced.
        const superseded = decisions.filter((d) => d.seq !== cover.seq && d.hash !== current);
        if (superseded.length) {
          const last = superseded[superseded.length - 1];
          findings.push({ kind: 'superseded', id, seq: last.seq, hash: last.hash, coveredBy: cover.seq, locations: [] });
        }
        continue;
      }
      if (cover !== null) {
        findings.push({ kind: 'state', id, seq: cover.seq, hash: cover.hash, state: cover.state, locations: [] });
        continue;
      }
      if (decisions.length) {
        findings.push({ kind: 'changed', id, seq: newest.seq, hash: newest.hash, state: newest.state, locations: locationsOf(id) });
        continue;
      }
      findings.push({ kind: 'uncovered', id, line: entry.line, hash: null, locations: locationsOf(id) });
      continue;
    }
    // Not accepted now: a verified decision still binds the payload it names,
    // and neither the marker nor the payload may be rewritten by this check.
    if (cover !== null && cover.state === 'verified') findings.push({ kind: 'withdrawn', id, seq: cover.seq, hash: cover.hash, locations: [] });
    else if (cover !== null) findings.push({ kind: 'state', id, seq: cover.seq, hash: cover.hash, state: cover.state, locations: [] });
  }
  return findings;
}

// The whole `Glossary mechanics` group. `glossary` is the parsed selected
// glossary or null; the caller has already read the file, so a failed read
// arrives as a reason for `not checked` instead of a crash.
function glossaryMechanics({ parsed, root, stateDir, canvasFile, glossaryFile, glossary, glossaryReadError = null, acceptedEntries, coverFor, decisionsById }) {
  const glossaryLabel = glossaryFile ? path.relative(root, glossaryFile) : 'research/glossary.md';
  const inspected = new Map();
  // The first status a file is seen under, except that a later `read` wins: one
  // file can be both a declared manuscript and an origin source.
  const note = (file, status) => {
    if (file === null) return;
    const key = String(file);
    if (!inspected.has(key) || status === 'read') inspected.set(key, status);
  };
  const notChecked = [];
  note(glossaryLabel, glossaryReadError ? 'unreadable' : glossary ? 'read' : 'absent');
  note(path.relative(root, canvasFile), 'read');
  if (!glossary) {
    notChecked.push({
      subject: 'glossary mechanics',
      reason: glossaryReadError
        ? `${glossaryLabel} exists but cannot be read (${glossaryReadError})`
        : `there is no ${glossaryLabel}`,
    });
    return {
      inspected: [...inspected].map(([file, status]) => ({ path: file, status })),
      notChecked,
      structure: { entries: [], findings: [] },
      canvas: { statements: [], findings: [] },
      manuscripts: { declared: [], references: [], notChecked: [], findings: [] },
      lexical: { checked: false, occurrences: [] },
      stability: [],
    };
  }

  const resolvable = glossaryLib.resolvableEntries(glossary);
  const labels = [...glossaryLib.labelIndex(glossary).values()]
    .sort((a, b) => compareByCodePoint(a.label, b.label))
    .map((l) => ({ ...l, re: labelRegExp(l.label) }));
  const idCounts = new Map();
  for (const e of glossary.entries) {
    if (e.id !== null) idCounts.set(e.id, (idCounts.get(e.id) || 0) + 1);
  }
  const locations = new Map();
  const addLocation = (id, where, line, text) => {
    if (!locations.has(id)) locations.set(id, []);
    const list = locations.get(id);
    if (!list.some((l) => l.where === where && l.line === line)) list.push({ where, line, text: text === undefined ? null : text });
  };
  const locationsOf = (id) => locations.get(id) || [];

  // --- entry structure and provenance ---
  const entries = [];
  const structureFindings = [];
  for (const e of glossary.entries) {
    const origin = glossaryLib.resolveOrigin(root, e);
    entries.push({ id: e.id, line: e.line, marker: e.marker === null ? 'unmarked' : e.marker, state: entryStateLabel(e), incomplete: e.incomplete });
    for (const problem of e.problems) structureFindings.push({ id: e.id, line: e.line, text: problem });
    for (const missing of e.incomplete) structureFindings.push({ id: e.id, line: e.line, text: missing });
    // What the tool can decide about the origin — presence and local target
    // resolution, never whether the passage supports the definition — is
    // reported when it fails. `unverified` and a malformed origin are already
    // said by the parser's incomplete and problem lists, so they are not
    // repeated here; a `missing` or unreadable target is this check's own
    // finding, and the file it looked at is listed among the inspected ones
    // with the status it had (row 1, § Mechanical review and its limits).
    // The file is listed under the path the researcher declared, not the
    // resolved one: resolution returns a real path, and a project reached
    // through a symlinked temporary directory would otherwise be listed as a
    // climb out of itself.
    const declaredFile = e.origin.file || null;
    if (origin.status === 'unverified' || origin.status === 'malformed') continue;
    if (origin.status === 'ok') {
      if (declaredFile !== null) note(declaredFile, 'read');
      continue;
    }
    structureFindings.push({ id: e.id, line: e.line, text: `Origin ${e.origin.text} — ${origin.reason}` });
    if (declaredFile !== null) note(declaredFile, origin.status === 'missing' ? 'missing' : 'unreadable');
  }
  for (const problem of glossary.problems) structureFindings.push({ id: null, line: null, text: problem });

  // --- declared canvas coverage (elements 3, 4, 7, 8) ---
  const statements = [];
  const canvasFindings = [];
  for (const s of allStatements(parsed)) {
    if (!GLOSSARY_ELEMENTS.has(s.element)) continue;
    const refs = [];
    for (const tag of s.tags) {
      const target = SRC_PREFIX_RE.test(tag) ? tag.replace(SRC_PREFIX_RE, '') : tag;
      const id = glossaryLib.referenceId(target, stateDir, glossaryFile);
      if (id === null) continue;
      const entry = resolvable.get(id) || null;
      if (entry === null) {
        const reason = unresolvedReason(id, idCounts);
        refs.push({ id, state: null, reason });
        canvasFindings.push({ question: s.question, line: s.line, text: s.text, id, reason });
        continue;
      }
      refs.push({ id, state: entryStateLabel(entry) });
      addLocation(id, s.question, s.line, s.text);
    }
    if (refs.length) statements.push({ question: s.question, line: s.line, marker: s.marker === null ? 'unmarked' : s.marker, text: s.text, refs });
  }

  // --- declared manuscript coverage ---
  const declared = glossary.manuscripts;
  const references = [];
  const manuscriptsNotChecked = [];
  const manuscriptFindings = [];
  const documents = [];
  if (!declared.length) {
    manuscriptsNotChecked.push({ path: null, reason: 'the glossary frontmatter declares no manuscripts, so manuscript coverage was not requested' });
  }
  for (const ref of declared) {
    const target = glossaryLib.resolveLocal(root, ref);
    if (target.status !== 'ok') {
      note(ref, target.status);
      manuscriptsNotChecked.push({ path: ref, reason: target.reason });
      continue;
    }
    if (!MARKDOWN_EXTENSIONS.has(path.extname(target.path).toLowerCase())) {
      note(ref, 'unsupported');
      manuscriptsNotChecked.push({ path: ref, reason: `"${ref}" is not a Markdown manuscript this check reads` });
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(target.path, 'utf8');
    } catch (err) {
      note(ref, 'unreadable');
      manuscriptsNotChecked.push({ path: ref, reason: `"${ref}" cannot be read (${(err && err.code) || 'unknown error'})` });
      continue;
    }
    note(ref, 'read');
    // The base is the declared path resolved against the root, not the
    // manuscript's real path: `referenceId` compares paths literally, and the
    // glossary file arrives in the root's own path space, so a realpath here
    // would make every relative link in the manuscript resolve to nothing.
    const document = readProse(text, { base: path.dirname(path.resolve(root, ref)), glossaryFile });
    documents.push({ path: ref, ...document, blocks: paragraphsOf(text, document.prose) });
    const record = (id, line, kind) => {
      const entry = resolvable.get(id) || null;
      if (entry === null) {
        const reason = unresolvedReason(id, idCounts);
        manuscriptFindings.push({ path: ref, line, id, kind, reason });
        references.push({ path: ref, line, kind, id, state: null, reason });
        return;
      }
      references.push({ path: ref, line, kind, id, state: entryStateLabel(entry) });
      addLocation(id, ref, line, null);
    };
    for (const link of document.links) record(link.id, link.line, 'link');
    for (const d of document.declarations) for (const id of d.ids) record(id, d.line, 'declaration');
  }

  // --- lexical cross-check ---
  const occurrences = [];
  // An occurrence is open when nothing in its statement or paragraph names one
  // of the entries the label belongs to. A label two entries claim is listed
  // under both — the review never picks a reading (§ Ambiguous matches stay
  // ambiguous).
  const claimOpen = (label, ids, linked, where, line, text) => {
    const open = ids.filter((id) => !linked.has(id));
    if (!open.length) return;
    occurrences.push({ where, line, label, ids: open, text, ambiguous: open.length > 1 });
    for (const id of open) addLocation(id, where, line, text);
  };
  for (const s of allStatements(parsed)) {
    if (!GLOSSARY_ELEMENTS.has(s.element)) continue;
    const linked = new Set();
    for (const tag of s.tags) {
      const target = SRC_PREFIX_RE.test(tag) ? tag.replace(SRC_PREFIX_RE, '') : tag;
      const id = glossaryLib.referenceId(target, stateDir, glossaryFile);
      if (id !== null && resolvable.has(id)) linked.add(id);
    }
    for (const { label, ids, re } of labels) {
      if (!re.test(s.text)) continue;
      claimOpen(label, ids, linked, s.question, s.line, s.text);
    }
  }
  for (const doc of documents) {
    const proseLines = doc.prose.split('\n');
    // A link or a declaration covers the paragraph it stands in, which is the
    // unit the design asks for ("at the definition and first substantive use").
    const coverage = new Map();
    const cover = (line, id) => {
      const block = paragraphFor(doc.blocks, line);
      if (!block) return;
      if (!coverage.has(block.start)) coverage.set(block.start, new Set());
      coverage.get(block.start).add(id);
    };
    for (const link of doc.links) cover(link.line, link.id);
    for (const d of doc.declarations) for (const id of d.ids) cover(d.line, id);
    for (const block of doc.blocks) {
      if (!block.prose) continue;
      const text = normalizeText(proseLines.slice(block.start - 1, block.end).join('\n'));
      const linked = coverage.get(block.start) || new Set();
      for (const { label, ids, re } of labels) {
        if (!re.test(text)) continue;
        claimOpen(label, ids, linked, doc.path, block.start, text);
      }
    }
  }

  // --- accepted text stability and cover ---
  const acceptedById = new Map(acceptedEntries.map((a) => [a.id, a]));
  const stability = glossaryStability({ resolvable, acceptedById, decisionsById, coverFor, locationsOf });

  return {
    inspected: [...inspected].map(([file, status]) => ({ path: file, status })),
    notChecked,
    structure: { entries, findings: structureFindings },
    canvas: { statements, findings: canvasFindings },
    manuscripts: { declared, references, notChecked: manuscriptsNotChecked, findings: manuscriptFindings },
    lexical: { checked: true, occurrences },
    stability,
  };
}

// The mechanical half of canvas-review (§5.4, items 1, 2, 5, 6, 7). The
// judgment half — fit, refutation, manuscript support — stays in the skill.
// Nothing here decides whether two elements contradict each other; it only
// computes what needs no judgment at all.
// `key` is the sealing key of this machine, or null on a checkout that has
// none; the ledger verdict and every acceptance's cover depend on it (§4.7).
function mechanicalReview({ parsed, graph, checks = [], decisionsText, glossaryText = null, key = null, root = null, stateDir = null, canvasFile = null, glossaryFile = null, glossaryReadError = null }) {
  const statuses = statusByNumber(parsed);
  const numbers = parsed.elements.map((e) => e.number);
  const statements = allStatements(parsed);
  const log = parseDecisions(decisionsText || '');
  const ledger = verifyChain(decisionsText || '', key);

  const empty = numbers.filter((n) => statuses[n].status === 'empty');
  const open = numbers.filter((n) => statuses[n].status === 'open');
  const violations = graph ? dependencyViolations(parsed, graph) : [];
  const unmarked = statements.filter((s) => s.marker === null);
  // Committed, but not where a reader would see it (§4.3, SQ-20). Reported and
  // never enforced: the commitment is intact, and which of the two views is
  // the one the researcher meant is their judgment, not the parser's.
  const invisibleCommitments = statements.filter((s) => s.hidden && COMMITTED_MARKERS.has(s.marker));
  const untagged = statements.filter((s) => s.marker !== null && s.tags.length === 0);
  const conversationalStated = untagged.filter((s) => s.marker === 'stated');

  // Acceptances recorded in the log must still match a statement's text.
  const acceptedByQuestion = new Map();
  for (const s of statements) {
    if (s.marker !== 'accepted') continue;
    if (!acceptedByQuestion.has(s.question)) acceptedByQuestion.set(s.question, []);
    acceptedByQuestion.get(s.question).push({ ...s, hash: textHash(s.text) });
  }
  // The glossary's side of the same question (§ Authorization and text
  // binding): an entry marked [accepted] is covered by a verified DECISION that
  // names the entry, its payload hash and its exact canonical payload.
  const glossary = glossaryText === null || glossaryText === undefined ? null : glossaryLib.parseGlossary(glossaryText);
  // The payload an id names, per heading: an id two headings share names no
  // single reading and is not a link target (§ Entry format and references), so
  // it maps to no payload and a decision about it covers neither block. Letting
  // the last heading win would compare a decision's sealed payload with a
  // heading it never named, and a short-hash collision then reads as cover.
  const glossaryPayloads = new Map();
  const acceptedEntries = [];
  if (glossary) {
    for (const e of glossary.entries) {
      if (e.id === null) continue;
      const payload = JSON.stringify(glossaryLib.entryPayload(e));
      glossaryPayloads.set(e.id, glossaryPayloads.has(e.id) ? null : payload);
      if (e.marker !== 'accepted') continue;
      acceptedEntries.push({ id: e.id, line: e.line, term: e.term, hash: glossaryLib.payloadHash(e), payload, coveredBy: null });
    }
  }
  const stateOf = (e) => decisionState(ledger, e);
  // An acceptance is logged only by an entry naming its question and hash
  // that verifies (§4.4). An entry that does not still binds a hash — stale is
  // stale whoever wrote it — but it gives no cover: SQ-21's D7b/D7c/D8 forged
  // exactly such an entry.
  const coverByAcceptance = new Map();
  const staleAcceptances = [];
  const unverifiedDecisions = [];
  const glossaryCover = new Map();
  // Every `glossary <id> accepted` DECISION in log order, with the verdict it
  // got. The stability report needs the whole history per entry — the newest
  // decision is not always the one that covers the payload — while the cover
  // map above answers only what counts as cover.
  const glossaryDecisions = new Map();
  const glossaryStaleAcceptances = [];
  for (const e of log.entries) {
    if (e.kind !== 'DECISION') continue;
    const state = stateOf(e);
    // Every DECISION that does not verify is listed, whatever its ref: a
    // `framing chosen` entry is as much the researcher's act as an acceptance
    // (SQ-139). Only the cover and stale bookkeeping below is about acceptances.
    if (state !== 'verified') unverifiedDecisions.push({ seq: e.seq, ref: e.ref, hash: e.hash, line: e.line, state });
    // A `glossary <id> accepted` entry binds a payload hash exactly as an
    // acceptance binds a statement text, and it is read first because the
    // canvas rule's ref shape is not this one.
    const g = e.hash ? GLOSSARY_ACCEPT_REF_RE.exec(e.ref) : null;
    if (g) {
      const cover = { seq: e.seq, state };
      const coverKey = `${g[1]}:${e.hash}`;
      const covered = glossaryCover.get(coverKey);
      // The ledger's short hash is only an identifier: a collision must not
      // cover different text. The first body line is the sealed JSON payload;
      // the remaining lines are the decision's labelled explanation fields.
      const sealedPayload = e.body.split('\n')[0];
      const samePayload = glossaryPayloads.get(g[1]) === sealedPayload;
      if (samePayload && (!covered || (state === 'verified' && covered.state !== 'verified'))) glossaryCover.set(coverKey, cover);
      if (!glossaryDecisions.has(g[1])) glossaryDecisions.set(g[1], []);
      glossaryDecisions.get(g[1]).push({ seq: e.seq, ref: e.ref, hash: e.hash, state });
      // Live is asked per accepted entry, not per id: an entry that still holds
      // the sealed payload keeps its acceptance out of the stale list even
      // while a second heading shares its id — such an id covers nothing, but
      // the payload itself did not move.
      const live = acceptedEntries.some((a) => a.id === g[1] && a.hash === e.hash && a.payload === sealedPayload);
      if (!live) glossaryStaleAcceptances.push({ seq: e.seq, ref: e.ref, hash: e.hash });
      continue;
    }
    const m = e.hash ? ACCEPT_REF_RE.exec(e.ref) : null;
    if (!m) continue;
    const cover = { seq: e.seq, state };
    const acceptance = `${m[1]}:${e.hash}`;
    const covered = coverByAcceptance.get(acceptance);
    if (!covered || (state === 'verified' && covered.state !== 'verified')) coverByAcceptance.set(acceptance, cover);
    const live = (acceptedByQuestion.get(m[1]) || []).some((s) => s.hash === e.hash);
    if (!live) staleAcceptances.push({ seq: e.seq, ref: e.ref, hash: e.hash });
  }
  // Accepted statements no verified entry accounts for: a hand edit, a merge,
  // or a planted acceptance. `coveredBy` names the entry that claims it, if
  // any, and why that claim does not count.
  const unloggedAcceptances = [];
  for (const list of acceptedByQuestion.values()) {
    for (const s of list) {
      const cover = coverByAcceptance.get(`${s.question}:${s.hash}`) || null;
      if (cover && cover.state === 'verified') continue;
      unloggedAcceptances.push({ question: s.question, line: s.line, hash: s.hash, text: s.text, coveredBy: cover });
    }
  }
  // Accepted glossary entries no verified entry accounts for — a hand edit, a
  // merge, or a marker written by hand. Reported the same way, with the entry
  // id where the canvas names a question.
  const glossaryUnloggedAcceptances = [];
  for (const a of acceptedEntries) {
    a.coveredBy = glossaryCover.get(`${a.id}:${a.hash}`) || null;
    if (a.coveredBy && a.coveredBy.state === 'verified') continue;
    glossaryUnloggedAcceptances.push(a);
  }

  return {
    statuses,
    empty,
    open,
    violations,
    unmarked,
    untagged,
    invisibleCommitments,
    conversationalStated,
    staleAcceptances,
    unloggedAcceptances,
    unverifiedDecisions,
    glossary,
    glossaryStaleAcceptances,
    glossaryAcceptances: acceptedEntries.filter((a) => a.coveredBy && a.coveredBy.state === 'verified'),
    glossaryUnloggedAcceptances,
    ledger,
    // The `Glossary mechanics` group of the review, present when the caller
    // knows the project on disk: provenance, coverage and manuscript prose need
    // files, and a review of parsed text alone has none to inspect.
    glossaryMechanics: root === null ? null : glossaryMechanics({
      parsed,
      root,
      stateDir,
      canvasFile,
      glossaryFile,
      glossary,
      glossaryReadError,
      acceptedEntries,
      coverFor: (id, hash) => glossaryCover.get(`${id}:${hash}`) || null,
      decisionsById: glossaryDecisions,
    }),
    problems: parsed.problems,
    findingsBeforeHypotheses: checks.includes('hypotheses-before-data') ? findingsBeforeHypotheses(decisionsText) : [],
  };
}

const WHY = {
  unsealed: 'an unsealed entry follows a sealed one',
  anchor: 'its own content or the unsealed block before it changed',
  chain: 'entries before it are missing or were removed',
  content: 'its own heading or body changed',
  key: WRONG_KEY,
  'line-endings': 'the file has Windows line endings (CRLF), which the harness does not read (see the README, "Windows line endings")',
};

const COVER_STATE = {
  legacy: 'legacy (no seal)',
  unverifiable: 'unverifiable here',
  broken: 'broken',
};

function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : noun.endsWith('y') ? '' : 's'}`.replace(/entry(s)?$/, n === 1 ? 'entry' : 'entries');
}

// One word for the session summary (§5.2's budget) …
function ledgerSummary(ledger) {
  if (ledger.status === 'broken') {
    // A wrong key breaks no entry: the summary names the key and no entry
    // number, and points at the step that fixes it (SQ-294).
    if (ledger.broken.why === 'key') return `${WRONG_KEY} — run placet-research join with the project key`;
    return `BROKEN at #${ledger.broken.seq} (${ledger.broken.why}) — run placet-research review`;
  }
  if (ledger.status === 'unverifiable') {
    return ledger.reason === 'no-key' ? 'unverifiable here (no key on this machine)' : `unverifiable (${plural(ledger.legacy.length, 'entry')} predate the seal)`;
  }
  return ledger.verified.size ? 'verified' : 'empty';
}

// … and the full verdict for `review`, which is where the researcher reads
// which entry broke and what to do about it (§4.7: the harness never repairs).
function ledgerReport(ledger, keyFile) {
  const legacyNote = ledger.legacy.length ? `entries ${ledger.legacy.map((n) => `#${n}`).join(', ')} predate the seal` : '';
  if (ledger.status === 'broken') {
    return [
      `BROKEN at #${ledger.broken.seq} (line ${ledger.broken.line}): ${WHY[ledger.broken.why]}.`,
      'The harness never repairs a ledger: deciding which version is true is the researcher\'s act. Until then no entry from the break onward gives an acceptance cover.',
    ];
  }
  if (ledger.status === 'unverifiable') {
    if (ledger.reason === 'legacy') return [`unverifiable: ${legacyNote}`];
    return [`unverifiable here: no sealing key on this machine (expected at ${keyFile}); the sealed entries read as intact and cannot be confirmed here${legacyNote ? `; ${legacyNote}` : ''}`];
  }
  if (!ledger.verified.size) return ['empty: no entries yet'];
  return [`verified: ${plural(ledger.verified.size, 'sealed entry')}${legacyNote ? `; ${legacyNote}` : ''}`];
}

function coverNote(coveredBy) {
  return coveredBy ? ` — covered only by #${coveredBy.seq}, ${COVER_STATE[coveredBy.state]}` : '';
}

module.exports = { mechanicalReview, findingsBeforeHypotheses, elementOfRef, ledgerSummary, ledgerReport, coverNote, COVER_STATE };
