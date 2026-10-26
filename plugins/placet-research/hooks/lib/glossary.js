'use strict';

// The construct glossary (docs/superpowers/specs/construct-glossary-design.md,
// § Entry format and references and § Authorization and text binding). This is
// the reader every other glossary consumer — acceptance, protection, review —
// is built on, so it reports what it cannot judge instead of repairing it: a
// duplicate id, a duplicated or misordered field, an unsupported schema and a
// block this grammar cannot read leave the document unjudgeable, and the raw
// block text stays on the entry for the report. Malformed content is never
// dropped to obtain a clean result.
//
// Grammar, schema 1:
//
//   ---
//   glossary-schema: 1
//   manuscripts: paper.md; sections/theory.md
//   ---
//
//   ## felt-safety
//
//   Term: Felt safety
//   Aliases: perceived safety
//   Definition: A participant's reported expectation that expressing a
//     concern will not expose them to interpersonal harm.
//   Origin: own-definition
//   Distinctions: Unlike [speaking frequency](#speaking-frequency), ...
//   [proposed]
//
// Each field appears once and in that order; a value may run over several
// lines, and `Aliases` is a comma-separated list of declared labels. The
// authorization marker is a marker group of its own, after the fields, and is
// the only thing the payload hash excludes.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const canvas = require('./canvas');
const lineEndings = require('./line-endings');
const project = require('./project');
const { textHash } = require('./hash');

const SCHEMA = 1;
const FIELD_ORDER = ['term', 'aliases', 'definition', 'origin', 'distinctions'];
const FIELD_LABEL = {
  term: 'Term',
  aliases: 'Aliases',
  definition: 'Definition',
  origin: 'Origin',
  distinctions: 'Distinctions',
};
const FIELD_RE = /^(Term|Aliases|Definition|Origin|Distinctions):[ \t]*(.*)$/;
// A unique lowercase hyphenated ID: the stable link target, so a changed
// display term renames nothing.
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADING_RE = /^##(?:[ \t]+(.*?))?[ \t]*$/;
// A neighbour is cited as `[term](#entry-id)`; only same-document links name
// entries, so a literature link or an external URL is not a reference.
const LINK_RE = /\[([^\]]*)\]\(#([^)]+)\)/g;
const ORIGIN_SRC_RE = /^src:[ \t]*([^\s#]+)(?:#(\S+))?$/;

// canvas.js parses the same `key: value` header but keeps its reader private,
// and its body grammar is the canvas's, not this one. The glossary header is
// two scalar fields; nothing else is read from it.
function parseHeader(lines) {
  if (lines[0] !== '---') return { data: {}, end: 0 };
  const data = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return { data, end: i + 1 };
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (m) data[m[1]] = m[2].trim();
  }
  return { data, end: lines.length, unterminated: true };
}

// The declared manuscripts, in declared order. An absent list means manuscript
// coverage was not requested — not that there are no constructs.
function manuscriptList(raw) {
  if (typeof raw !== 'string') return [];
  return raw.split(';').map((part) => part.trim()).filter(Boolean);
}

function newEntry(heading, line, startIndex) {
  return {
    heading,
    id: null,
    line,
    startIndex,
    endIndex: startIndex,
    fields: {},
    fieldLines: {},
    marker: null,
    markerTags: [],
    markerLine: null,
    raw: '',
    term: null,
    aliases: null,
    definition: null,
    origin: null,
    distinctions: null,
    references: [],
    problems: [],
    incomplete: [],
  };
}

function parseOrigin(value) {
  const lowered = value.toLowerCase();
  if (lowered === 'own-definition') return { kind: 'own-definition', text: value, file: null, anchor: null };
  if (lowered === 'unverified') return { kind: 'unverified', text: value, file: null, anchor: null };
  const m = ORIGIN_SRC_RE.exec(value);
  if (m) return { kind: 'source', text: value, file: m[1], anchor: m[2] === undefined ? null : m[2] };
  return { kind: 'other', text: value, file: null, anchor: null };
}

function finishEntry(entry) {
  if (entry.heading === '' || !ID_RE.test(entry.heading)) {
    entry.problems.push(`line ${entry.line}: "${entry.heading}" is not a lowercase hyphenated id; the heading is the entry's link target`);
  } else {
    entry.id = entry.heading;
  }

  const value = (key) => {
    const raw = entry.fields[key];
    if (raw === undefined) return null;
    const normalized = canvas.normalizeText(raw);
    return normalized === '' ? null : normalized;
  };
  const at = (key) => entry.fieldLines[key];

  entry.term = value('term');
  if (entry.fields.aliases === undefined) {
    entry.aliases = null;
  } else {
    entry.aliases = canvas.normalizeText(entry.fields.aliases).split(',').map((a) => canvas.normalizeText(a)).filter(Boolean);
  }
  entry.definition = value('definition');
  entry.distinctions = value('distinctions');

  const originValue = value('origin');
  entry.origin = originValue === null ? null : parseOrigin(originValue);

  // A field declared empty reads as missing, not as a value. Aliases are
  // optional — a construct may be named by its term alone — and a `pending`
  // definition or an `unverified` origin is an unfinished proposal: visible,
  // and unable to satisfy acceptance, but not a malformed block.
  entry.incomplete = [];
  if (entry.term === null) entry.incomplete.push('term is missing');
  if (entry.definition === null) entry.incomplete.push('definition is missing');
  else if (entry.definition.toLowerCase() === 'pending') entry.incomplete.push('definition is pending');
  if (entry.origin === null) entry.incomplete.push('origin is missing');
  else if (entry.origin.kind === 'unverified') entry.incomplete.push('origin is unverified');
  if (entry.distinctions === null) entry.incomplete.push('distinctions are missing');
  if (entry.marker === null) entry.incomplete.push('no authorization marker');
  if (entry.origin && entry.origin.kind === 'other') {
    entry.problems.push(`line ${at('origin')}: Origin is neither own-definition nor src: <project-relative file>#<anchor>`);
  }

  if (entry.distinctions !== null) {
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(entry.distinctions)) !== null) {
      entry.references.push({ text: m[1], id: m[2] });
    }
  }
}

function parseGlossary(text) {
  const lines = String(text).split('\n');
  const header = parseHeader(lines);
  const parsed = {
    frontmatter: header.data,
    schema: Object.prototype.hasOwnProperty.call(header.data, 'glossary-schema') ? header.data['glossary-schema'] : null,
    schemaSupported: header.data['glossary-schema'] === String(SCHEMA),
    manuscripts: manuscriptList(header.data.manuscripts),
    entries: [],
    problems: [],
  };
  const crlf = lineEndings.firstCrlfLine(text);
  if (crlf) parsed.problems.push(lineEndings.crlfProblem(crlf));
  if (header.unterminated) parsed.problems.push('frontmatter is not terminated');
  if (!parsed.schemaSupported) {
    parsed.problems.push(parsed.schema === null
      ? `the frontmatter declares no glossary-schema; this reader reads glossary-schema: ${SCHEMA}`
      : `glossary-schema is ${JSON.stringify(parsed.schema)}; this reader reads glossary-schema: ${SCHEMA}`);
  }

  let entry = null;
  let field = null;
  let lastIndex = -1;
  const flush = (endIndex) => {
    if (!entry) return;
    entry.endIndex = endIndex;
    entry.raw = lines.slice(entry.startIndex, entry.endIndex).join('\n').replace(/\n+$/, '');
    finishEntry(entry);
    parsed.entries.push(entry);
    entry = null;
    field = null;
    lastIndex = -1;
  };

  for (let i = header.end; i < lines.length; i += 1) {
    const line = lines[i];
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush(i);
      entry = newEntry(heading[1] === undefined ? '' : heading[1].trim(), i + 1, i);
      continue;
    }
    if (line.trim() === '') {
      // A blank line closes a wrapped value; the entry stays open for its
      // marker and for any field that still follows.
      field = null;
      continue;
    }
    if (!entry) {
      parsed.problems.push(`line ${i + 1}: text outside any entry`);
      continue;
    }
    const f = FIELD_RE.exec(line);
    if (f) {
      const key = f[1].toLowerCase();
      const index = FIELD_ORDER.indexOf(key);
      if (entry.fields[key] !== undefined) {
        entry.problems.push(`line ${i + 1}: ${FIELD_LABEL[key]} appears more than once (first at line ${entry.fieldLines[key]}); the first one is read`);
        field = null;
      } else if (entry.marker !== null) {
        entry.problems.push(`line ${i + 1}: ${FIELD_LABEL[key]} comes after the authorization marker`);
        field = null;
      } else {
        if (index < lastIndex) {
          entry.problems.push(`line ${i + 1}: ${FIELD_LABEL[key]} is out of order; the fields are ${FIELD_ORDER.map((k) => FIELD_LABEL[k]).join(', ')}`);
        }
        entry.fields[key] = f[2];
        entry.fieldLines[key] = i + 1;
        if (index > lastIndex) lastIndex = index;
        field = key;
      }
      continue;
    }
    const group = canvas.parseMarkerGroup(line.trim());
    if (group && group.text === '') {
      if (entry.marker !== null) {
        entry.problems.push(`line ${i + 1}: a second authorization marker (first at line ${entry.markerLine})`);
      } else if (Object.keys(entry.fields).length === 0) {
        entry.problems.push(`line ${i + 1}: the authorization marker comes before any field`);
      } else {
        entry.marker = group.marker;
        entry.markerTags = group.tags;
        entry.markerLine = i + 1;
      }
      if (group.tags.length) {
        entry.problems.push(`line ${i + 1}: the marker carries tags (${group.tags.join(', ')}); the glossary reads the marker alone and binds it with the payload, so extra tags are not read`);
      }
      field = null;
      continue;
    }
    if (field === null) {
      entry.problems.push(`line ${i + 1}: text outside any field`);
      continue;
    }
    entry.fields[field] = `${entry.fields[field]}\n${line}`;
  }
  flush(lines.length);

  // Cross-entry checks: only a whole document can tell a duplicate id, an
  // alias claimed by two entries, or a distinction link with no target.
  const byId = new Map();
  for (const e of parsed.entries) {
    if (e.id === null) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  for (const id of [...byId.keys()].sort()) {
    const at = byId.get(id);
    if (at.length > 1) {
      parsed.problems.push(`the id "${id}" has ${at.length} headings (lines ${at.map((e) => e.line).join(', ')}); while both stand it is not a link target and neither entry may be read`);
    }
  }
  const aliases = new Map();
  for (const e of parsed.entries) {
    for (const alias of e.aliases || []) {
      const key = alias.toLowerCase();
      if (!aliases.has(key)) aliases.set(key, { display: alias, ids: [] });
      const seen = aliases.get(key);
      if (e.id !== null && !seen.ids.includes(e.id)) seen.ids.push(e.id);
    }
  }
  for (const key of [...aliases.keys()].sort()) {
    const seen = aliases.get(key);
    if (seen.ids.length > 1) {
      parsed.problems.push(`the alias "${seen.display}" is claimed by ${seen.ids.join(' and ')}; one label for two entries is ambiguous, and the researcher disambiguates`);
    }
  }
  const ids = new Set([...byId.keys()].filter((id) => byId.get(id).length === 1));
  for (const e of parsed.entries) {
    for (const ref of e.references) {
      if (!ids.has(ref.id)) {
        e.problems.push(`line ${e.line}: Distinctions links to #${ref.id}, which is no entry id`);
      }
    }
  }

  parsed.judgeable = parsed.problems.length === 0 && parsed.entries.every((e) => e.problems.length === 0);
  return parsed;
}

function entryById(parsed, id) {
  return parsed.entries.find((e) => e.id === id) || null;
}

// The entries a reference may resolve to: an id carried by exactly one heading.
// A duplicated id is not a link target (§ Entry format and references), so
// nothing resolves to any of its readings.
function resolvableEntries(parsed) {
  const byId = new Map();
  for (const e of parsed.entries) {
    if (e.id === null) continue;
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  return new Map([...byId].filter(([, readings]) => readings.length === 1).map(([id, readings]) => [id, readings[0]]));
}

// Every label the glossary declares — each entry's term and its aliases —
// mapped to the entries that claim it. A label two entries claim stays
// ambiguous: the review names both readings rather than picking one
// (§ Mechanical review and its limits, lexical cross-check).
function labelIndex(parsed) {
  const index = new Map();
  for (const e of parsed.entries) {
    if (e.id === null) continue;
    for (const label of [e.term, ...(e.aliases || [])]) {
      if (!label) continue;
      const key = label.toLowerCase();
      if (!index.has(key)) index.set(key, { label, ids: [] });
      const seen = index.get(key);
      if (!seen.ids.includes(e.id)) seen.ids.push(e.id);
    }
  }
  return index;
}

// The target of a reference is a path and a fragment: `glossary.md#felt-safety`
// as a canvas evidence tag, `[felt safety](research/glossary.md#felt-safety)` as
// a manuscript link. A `#` inside the path or a target with no file is not a
// reference to an entry. A Markdown title (`(path "title")`) is not part of it.
function referenceParts(target) {
  const text = String(target === null || target === undefined ? '' : target).trim().replace(/^</, '').replace(/>$/, '');
  const at = text.indexOf('#');
  if (at <= 0) return null;
  const file = text.slice(0, at).trim().replace(/\s+"[^"]*"$/, '');
  const id = text.slice(at + 1).trim();
  if (file === '' || id === '') return null;
  return { file, id };
}

// The entry id `target` names, or null when the target does not resolve to the
// selected glossary file from `base`. Resolution is lexical — the file may not
// exist yet — and relative to the document that carries the reference, so the
// same reference reads the same from the canvas's state directory and from a
// manuscript at any depth. Literal comparison, so only the form the design
// gives (§ Canvas citation form, § Manuscript citation form) is recognized.
function referenceId(target, base, glossaryFile) {
  const parts = referenceParts(target);
  if (!parts || !glossaryFile) return null;
  return path.resolve(base, parts.file) === path.resolve(glossaryFile) ? parts.id : null;
}

// The payload a `glossary <id> accepted` decision binds (§ Authorization and
// text binding): canonical JSON of the id and the fixed-order field values,
// each normalized first. JSON escaping means no value can cross a field
// boundary, so a value carrying a comma or a quote cannot reproduce a
// different entry's payload — the failure the canvas's joined separator line
// had to defend against (§4.3.1). Aliases stay in declared order, and the
// authorization marker is excluded, deliberately and only it.
function entryPayload(entry) {
  return [
    entry.id,
    entry.term,
    entry.aliases,
    entry.definition,
    entry.origin === null ? null : entry.origin.text,
    entry.distinctions,
  ];
}

// The human-facing binding uses the full digest, not the ledger's legacy
// eight-hex identifier. Match textHash's normalization over canonical JSON.
function bindingDigest(entry) {
  return crypto.createHash('sha256').update(canvas.normalizeText(JSON.stringify(entryPayload(entry))), 'utf8').digest('hex');
}

function payloadHash(entry) {
  return textHash(JSON.stringify(entryPayload(entry)));
}

// The one thing an acceptance rewrites (§ Authorization and text binding): the
// authorization marker line, and only it. The fields keep the order, the
// wrapping and the words the researcher read, and the payload hash excludes
// the marker, so the accepted payload is the payload the decision binds. An
// entry without a marker line is not one this function may rewrite silently.
function withEntryMarker(text, entry, marker) {
  const lines = String(text).split('\n');
  if (entry.markerLine === null) {
    throw new Error(`glossary entry ${entry.id === null ? '(no id)' : entry.id} has no authorization marker line; nothing was rewritten`);
  }
  lines[entry.markerLine - 1] = `[${marker}]`;
  return lines.join('\n');
}

// A source or manuscript path is resolved against the project root, and the
// answer distinguishes what it is: a path that climbs out of the project or a
// symlink that leaves it is refused, a missing target is reported as missing
// and an unreadable one as unreadable — never as absent, which is how an
// unreadable file becomes "nothing to check" and passes.
function resolveLocal(root, reference) {
  const text = String(reference === null || reference === undefined ? '' : reference).trim();
  if (text === '') return { status: 'missing', reason: 'no path is declared', path: null };
  if (path.isAbsolute(text)) return { status: 'not-relative', reason: `"${text}" is absolute, and a declared path is project-relative`, path: null };
  const base = path.resolve(root);
  const target = path.resolve(base, text);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return { status: 'outside-project', reason: `"${text}" climbs out of the project`, path: null };
  }
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (err) {
    const code = (err && err.code) || 'unknown error';
    if (code === 'ENOENT') return { status: 'missing', reason: `"${text}" does not exist`, path: target };
    return { status: 'unreadable', reason: `"${text}" cannot be reached (${code})`, path: target };
  }
  const realBase = fs.realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { status: 'outside-project', reason: `"${text}" resolves through a symlink to a path outside the project`, path: target };
  }
  try {
    if (!fs.statSync(real).isFile()) return { status: 'unreadable', reason: `"${text}" is not a file`, path: real };
    fs.accessSync(real, fs.constants.R_OK);
  } catch (err) {
    return { status: 'unreadable', reason: `"${text}" cannot be read (${(err && err.code) || 'unknown error'})`, path: real };
  }
  return { status: 'ok', reason: null, path: real };
}

// Where an entry's definition comes from, resolved against the project. The
// tool checks that the declared target is there and readable; whether that
// passage supports the definition is the researcher's reading, not this one.
function resolveOrigin(root, entry) {
  if (!entry || entry.origin === null) {
    return { status: 'missing', reason: 'no origin is declared', path: null, anchor: null };
  }
  if (entry.origin.kind === 'own-definition') return { status: 'ok', reason: null, path: null, anchor: null };
  if (entry.origin.kind === 'unverified') {
    return { status: 'unverified', reason: 'unverified describes an unfinished proposal and cannot satisfy the origin requirement for acceptance', path: null, anchor: null };
  }
  if (entry.origin.kind === 'other') {
    return { status: 'malformed', reason: `"${entry.origin.text}" is neither own-definition nor src: <project-relative file>#<anchor>`, path: null, anchor: null };
  }
  const target = resolveLocal(root, entry.origin.file);
  return { status: target.status, reason: target.reason, path: target.path, anchor: entry.origin.anchor };
}

// The selected state directory's glossary, or null text when there is none.
// An unreadable file (EACCES, EISDIR) throws, as project.readIfExists
// documents: only absence is safe to read as an empty file.
function loadGlossary(root, { variant } = {}) {
  const file = project.glossaryPath(root, variant);
  const text = project.readIfExists(file);
  return { path: file, variant: variant === undefined ? null : variant, text, parsed: text === null ? null : parseGlossary(text) };
}

module.exports = {
  SCHEMA,
  FIELD_ORDER,
  FIELD_LABEL,
  ID_RE,
  parseGlossary,
  loadGlossary,
  entryById,
  resolvableEntries,
  labelIndex,
  referenceId,
  entryPayload,
  payloadHash,
  bindingDigest,
  withEntryMarker,
  resolveLocal,
  resolveOrigin,
  manuscriptList,
};
