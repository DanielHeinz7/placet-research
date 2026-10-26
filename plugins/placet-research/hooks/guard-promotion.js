#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const project = require('./lib/project');
const canvas = require('./lib/canvas');
const glossary = require('./lib/glossary');
const profile = require('./lib/profile');
const output = require('./lib/output');
const ledger = require('./lib/ledger');
const seal = require('./lib/seal');
const lineEndings = require('./lib/line-endings');

// The plugin's own root, for the one question the guard asks of it: does this
// canvas name a profile that ships (§4.5)?
function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
}

// The schema this parser implements. A canvas that names another one is a
// migration, which is the harness's own act rather than a model tool call.
const CANVAS_SCHEMA = '2';

// Every refusal ends here, because a guard that only says no blocks the
// harness against itself (§5.3).
const NEXT_STEP = 'Propose the change as [proposed] alongside the existing statement, or let the researcher make it with /placet-research:accept.';
// The glossary's equivalent (SQ-203): an entry is accepted by the researcher
// alone, through the skill that calls `placet-research glossary accept`.
const GLOSSARY_NEXT_STEP = 'Propose the change as a new [proposed] entry, or let the researcher accept the entry with /placet-research:glossary-accept <id> --explained "<their sentence>".';

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) || {} : {};
  } catch (_) {
    return {};
  }
}

// ---------- canvas.md ----------

function headingKeys(parsed) {
  const keys = [];
  for (const el of parsed.elements) {
    keys.push(`#${el.number}`);
    for (const q of el.questions) keys.push(`##${q.id}`);
  }
  return keys;
}

function cannotJudge(what, step = NEXT_STEP) {
  return `Cannot judge this write: ${what}. ${step}`;
}

// §5.3: a `profile:` that does not resolve to a shipped profile makes the
// canvas unjudgeable. SQ-21's S12b pointed it at an id the plugin does not
// ship and dependency checking simply stopped — nothing reported that it could
// not check. A rule that can be switched off by editing one word is not a rule.
function profileRefusal(frontmatter) {
  const id = frontmatter.profile;
  if (id === undefined) return null;
  try {
    profile.loadProfile(id, pluginRoot());
    return null;
  } catch (_) {
    return cannotJudge(`"profile: ${id}" does not resolve to a profile this harness ships, so the rules that judge this canvas cannot be loaded. Restore the profile the canvas was written against`);
  }
}

// §5.3 clause 4. The protected thing is the whole mapping, not a list of keys:
// enumerating them would leave the next key added unprotected by default. The
// researcher changes the frontmatter in their own editor or through the canvas
// view, neither of which is a model tool call.
function frontmatterRefusal(before, after, { what = 'canvas', nextStep = NEXT_STEP } = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of [...keys].sort()) {
    const had = Object.prototype.hasOwnProperty.call(before, k);
    const has = Object.prototype.hasOwnProperty.call(after, k);
    if (had && !has) return `Removing the frontmatter key "${k}" is not allowed; the frontmatter is the researcher's. ${nextStep}`;
    if (!had && has) return `Adding the frontmatter key "${k}" is not allowed; the frontmatter is the researcher's. ${nextStep}`;
    if (before[k] !== after[k]) {
      return `The frontmatter key "${k}" is the researcher's to change ("${before[k]}" to "${after[k]}" was refused); it decides how the whole ${what} is read and judged. ${nextStep}`;
    }
  }
  return null;
}

// What became of a commitment that is no longer in C(after). The refusal is
// part of the product, so it says which of the fields around the statement
// moved rather than only that something did.
function describeLoss(lost, afterSet) {
  for (const cand of afterSet.values()) {
    if (cand.text !== lost.text) continue;
    if (cand.element !== lost.element) return `was moved to element ${cand.element}`;
    if (cand.question !== lost.question) return `was moved to question ${cand.question}`;
    if (cand.marker !== lost.marker) return `was downgraded to [${cand.marker}]`;
    if (cand.elementTitle !== lost.elementTitle) return `had the title of its element rewritten to "${cand.elementTitle}"`;
    if (cand.questionText !== lost.questionText) return 'had the text of its own question rewritten, so it now answers a different question';
    if (cand.tags.join(', ') !== lost.tags.join(', ')) {
      return lost.tags.length
        ? `had its evidence tags rewritten from "${lost.tags.join(', ')}" to "${cand.tags.join(', ') || 'none'}"`
        : `had the evidence tag "${cand.tags.join(', ')}" attached to it`;
    }
    return 'was altered';
  }
  return 'was altered or removed';
}

// Returns a refusal reason, or null when the write is permitted (§5.3, §4.3.1).
//
// One rule over the committed set, not a check per hole. The three prohibitions
// of the first draft are what clauses 1 and 2 say about one statement at a
// time; they were not wrong, they were too narrow, and SQ-21's attacks went
// around them rather than through them.
function canvasVerdict(beforeText, afterText) {
  // A CRLF file reads as empty, so a write could not be compared with what is
  // there; the repair is git's (README, "Windows line endings"), not the agent's.
  const crlfBefore = lineEndings.firstCrlfLine(beforeText);
  if (crlfBefore) return cannotJudge(lineEndings.crlfProblem(crlfBefore));
  const before = canvas.parseCanvas(beforeText || '');
  const after = canvas.parseCanvas(afterText || '');
  const existed = String(beforeText || '').trim() !== '';

  // §4.3.1's U+001F separator cannot survive inside a field (SQ-29 F9): a field
  // carrying one reproduces a boundary of the canonical line, so a commitment
  // can be re-cut with its identity unchanged. The rule lives with the canonical
  // line, and `parseCanvas` reports it there too, so the CLI's `review` and this
  // refusal name the same statement. It comes before the structural check
  // because the remedy is to remove a character, not to restore a heading.
  const unjudgeable = canvas.controlCharacterProblems(after.elements);
  if (unjudgeable.length) return cannotJudge(unjudgeable[0]);
  if (after.problems.length) {
    return cannotJudge(`${after.problems[0]}. Keep the canvas structure — frontmatter, "# N · Title", "## N.M question", statements ending in a marker group`);
  }
  if (!after.elements.length) return cannotJudge('the result has no elements');
  if (after.frontmatter['canvas-schema'] !== undefined && after.frontmatter['canvas-schema'] !== CANVAS_SCHEMA) {
    return cannotJudge(`the result names canvas-schema ${after.frontmatter['canvas-schema']}, which this parser does not implement`);
  }
  const badProfile = profileRefusal(after.frontmatter);
  if (badProfile) return badProfile;

  // Clause 3: every element and question heading that was there is still there.
  const afterHeadings = new Set(headingKeys(after));
  for (const key of headingKeys(before)) {
    if (!afterHeadings.has(key)) return `Removing or renaming the heading ${key} is not allowed; every element and question heading stays. ${NEXT_STEP}`;
  }

  // Clause 4, only once there is a document to compare against: creating the
  // canvas is legitimate and writes the frontmatter for the first time.
  if (existed) {
    const fm = frontmatterRefusal(before.frontmatter, after.frontmatter);
    if (fm) return fm;
  }

  const beforeSet = canvas.committedSet(before);
  const afterSet = canvas.committedSet(after);

  // Clause 1: C(before) ⊆ C(after). Nothing committed is lost, moved,
  // retitled, re-questioned, re-tagged or downgraded.
  for (const lost of beforeSet.values()) {
    if (afterSet.has(lost.canonical)) continue;
    return `The [${lost.marker}] commitment in question ${lost.question} (${lost.hash}) ${describeLoss(lost, afterSet)}. It records what the researcher said or accepted, together with the element, the question and the evidence tags that give it its meaning. ${NEXT_STEP}`;
  }

  // The first draft's third prohibition, which clauses 1 and 2 do *not*
  // subsume, though §4.3.1 says the three "are what clauses 1 and 2 say about
  // one statement at a time". Relabelling a [proposed] statement [stated]
  // creates a commitment that is new (so clause 1 is silent, the proposal never
  // being a member of C) and carries [stated] (so clause 2 permits it). The set
  // rule cannot see a promotion, because it cannot see what the statement used
  // to be. SQ-21's D3b walks through exactly that gap with one `replace_all`.
  // Repetition is not confirmation (§4.3), so promotion is refused on its own.
  const proposals = new Map();
  for (const s of canvas.allStatements(before)) {
    if (s.marker === null || canvas.COMMITTED.has(s.marker)) continue;
    proposals.set(`${s.question}|${s.text}`, s);
  }

  // Clause 2: every commitment C(after) gained carries [stated] — the model may
  // transcribe what it just heard, and may never declare a commitment.
  for (const gained of afterSet.values()) {
    if (beforeSet.has(gained.canonical)) continue;
    const was = proposals.get(`${gained.question}|${gained.text}`);
    if (was) {
      return `A [${was.marker}] statement cannot be promoted to [${gained.marker}] by the model (question ${gained.question}); only the researcher confirms it. ${NEXT_STEP}`;
    }
    if (gained.marker === 'stated') continue;
    return `Only the researcher may write [${gained.marker}] (question ${gained.question}). ${NEXT_STEP}`;
  }
  return null;
}

// ---------- glossary.md ----------

// SQ-203 (§ Authorization and text binding). A [stated] or [accepted] glossary
// entry is what the researcher said or accepted, and it is protected the way a
// canvas commitment is: the model may add a [proposed] or [tentative] entry,
// and may neither change, retitle, downgrade nor remove a committed one, nor
// promote a proposal to a commitment. The payload is the fixed-order fields as
// canonical JSON, so a rewrite that moves a definition, an alias list or an
// origin is the same kind of change as a canvas rewrite; the id is part of the
// commitment, because it is the link a Distinctions line points at.
const GLOSSARY_COMMITTED = new Set(['stated', 'accepted']);

function glossaryKey(id, payload) {
  return `${id}|${JSON.stringify(payload)}`;
}

function glossaryCommitments(parsed) {
  const items = [];
  for (const entry of parsed.entries) {
    if (entry.id === null || !GLOSSARY_COMMITTED.has(entry.marker)) continue;
    const payload = glossary.entryPayload(entry);
    items.push({
      canonical: JSON.stringify([entry.marker, ...payload]),
      id: entry.id,
      marker: entry.marker,
      payload,
      hash: glossary.payloadHash(entry),
      term: entry.term,
    });
  }
  return items;
}

// What became of a commitment that is no longer in C(after), said in the terms
// the refusal should say it in. The comparison is against every entry with the
// id, not only the committed ones: an entry whose marker the model dropped or
// relabelled is still that entry, and "was removed" would misdescribe it.
function describeGlossaryLoss(lost, after) {
  const sameId = after.entries.filter((e) => e.id === lost.id);
  if (!sameId.length) return 'was removed, or its id was renamed';
  for (const cand of sameId) {
    if (JSON.stringify(glossary.entryPayload(cand)) !== JSON.stringify(lost.payload)) continue;
    return cand.marker === null ? 'lost its authorization marker' : `was relabelled [${lost.marker}] to [${cand.marker}]`;
  }
  return 'was altered (its term, aliases, definition, origin or distinctions changed)';
}

function glossaryVerdict(beforeText, afterText) {
  // A CRLF file reads as empty, so a write could not be compared with what is
  // there; the repair is git's (README, "Windows line endings"), not the agent's.
  const crlfBefore = lineEndings.firstCrlfLine(beforeText);
  if (crlfBefore) return cannotJudge(lineEndings.crlfProblem(crlfBefore), GLOSSARY_NEXT_STEP);
  const before = glossary.parseGlossary(beforeText || '');
  const after = glossary.parseGlossary(afterText || '');
  const existed = String(beforeText || '').trim() !== '';

  // A block this reader cannot judge could be a payload the model wrote and a
  // reader would read differently, so it is refused before anything is
  // compared — a duplicate id, a field out of order, an unsupported schema.
  const bad = after.problems[0] || (after.entries.find((e) => e.problems.length) || { problems: [] }).problems[0];
  if (bad) return cannotJudge(`${bad}. Keep the glossary structure — frontmatter with glossary-schema, "## <id>", the fields Term, Aliases, Definition, Origin and Distinctions in that order, and the authorization marker last`, GLOSSARY_NEXT_STEP);
  if (!after.entries.length) return cannotJudge('the result has no entries', GLOSSARY_NEXT_STEP);

  // The frontmatter is the document's, not a write's: creating the glossary
  // writes it for the first time, and after that nothing in it moves.
  if (existed) {
    const fm = frontmatterRefusal(before.frontmatter, after.frontmatter, { what: 'glossary', nextStep: GLOSSARY_NEXT_STEP });
    if (fm) return fm;
  }

  // Every entry id that was there stays: it is the link target its Distinctions
  // references point at, so removing or renaming one breaks references.
  const afterIds = new Set(after.entries.map((e) => e.id).filter((id) => id !== null));
  for (const entry of before.entries) {
    if (entry.id !== null && !afterIds.has(entry.id)) {
      return `Removing or renaming the glossary entry ${entry.id} is not allowed; the id is the link target its Distinctions references point at. ${GLOSSARY_NEXT_STEP}`;
    }
  }

  const beforeSet = glossaryCommitments(before);
  const afterSet = glossaryCommitments(after);

  // Clause 1: C(before) ⊆ C(after). Nothing committed is lost or rewritten.
  for (const lost of beforeSet) {
    if (afterSet.some((c) => c.canonical === lost.canonical)) continue;
    return `The [${lost.marker}] glossary entry ${lost.id} (payload ${lost.hash}) ${describeGlossaryLoss(lost, after)}. It records the definition the researcher stated or accepted, with the id its references point at. ${GLOSSARY_NEXT_STEP}`;
  }

  // Promotion, the gap the set rule cannot see: a [proposed] or [tentative]
  // entry relabelled [stated] is new to C and carries a permitted marker.
  const proposals = new Map();
  for (const entry of before.entries) {
    if (entry.marker === null || GLOSSARY_COMMITTED.has(entry.marker)) continue;
    proposals.set(glossaryKey(entry.id, glossary.entryPayload(entry)), entry.marker);
  }
  const beforeCanonical = new Set(beforeSet.map((c) => c.canonical));

  // Clause 2: every commitment gained carries [stated] — the model may
  // transcribe what it just heard, and may never declare a commitment.
  for (const gained of afterSet) {
    if (beforeCanonical.has(gained.canonical)) continue;
    const was = proposals.get(glossaryKey(gained.id, gained.payload));
    if (was !== undefined) {
      return `A [${was}] glossary entry cannot be promoted to [${gained.marker}] by the model (entry ${gained.id}); only the researcher accepts it. ${GLOSSARY_NEXT_STEP}`;
    }
    if (gained.marker === 'stated') continue;
    return `Only the researcher may write [${gained.marker}] (glossary entry ${gained.id}). ${GLOSSARY_NEXT_STEP}`;
  }
  return null;
}

// Apply an Edit the way the tool would; null when it could not be applied
// unambiguously, which is a diff the guard must not guess at.
function applyEdit(current, toolInput) {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = toolInput;
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  const first = current.indexOf(oldString);
  if (first < 0) return null;
  const second = current.indexOf(oldString, first + oldString.length);
  if (second >= 0 && !replaceAll) return null;
  return replaceAll ? current.split(oldString).join(newString) : `${current.slice(0, first)}${newString}${current.slice(first + oldString.length)}`;
}

// ---------- Bash ----------

// A gate built from string tests over an unparsed command line cannot
// enumerate the ways a shell can be told to write a file — quoting, chaining,
// globbing, assembling the path in a variable, `cd`, a nested substitution are
// all the same intent written differently. So the guard lexes the command far
// enough to see every word, and then asks one question of each: can this denote
// the research state directory? Where one can, nothing runs but a named
// read-only form. Deny by default inside a scope the lexer can see, rather than
// allow by default outside one (§5.3).

const MAX_COMMAND_LENGTH = 64 * 1024;
const MAX_SUBSTITUTION_DEPTH = 8;

// An expansion leaves a mark where it stood, so a word keeps its literal parts
// and still remembers that the rest of it is unknown.
const EXP_OPEN = '\u0000';
const EXP_CLOSE = '\u0001';
const EXP_UNKNOWN = `${EXP_OPEN}${EXP_CLOSE}`;
const EXP_RE = /\u0000([A-Za-z0-9_]*)\u0001/g;
// The one-letter escapes of bash's `$'…'` quoting.
const ANSI_ESCAPES = {
  a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

// SQ-75: bash expands `{a,b}` and `{1..3}` before anything else, so
// `rm -rf {research,tmp}` removes the state directory. Only an unquoted brace
// expands, so the lexer keeps a second spelling of a word (`shape`) in which the
// unquoted `{`, `,` and `}` are these marks; a quoted or escaped one stays the
// plain character and is left alone, as bash leaves it.
const BRACE_OPEN = '\u0002';
const BRACE_CLOSE = '\u0003';
const BRACE_COMMA = '\u0004';
const BRACE_MARK = { '{': BRACE_OPEN, '}': BRACE_CLOSE, ',': BRACE_COMMA };
const BRACE_MARKS_RE = /[\u0002\u0003\u0004]/g;
const BRACE_CHAR = { [BRACE_OPEN]: '{', [BRACE_CLOSE]: '}', [BRACE_COMMA]: ',' };
// Past this many words a brace expansion or a loop is not computed: the word is
// one the guard cannot judge, like a pattern it cannot compute.
const MAX_EXPANSIONS = 256;

const RUNNERS = new Set(['node', 'nodejs', 'npx', 'bun', 'deno', 'pnpm', 'yarn']);
const CLI_NAMES = new Set(['placet-research', 'placet-research.js']);
// SQ-116: `install-cli` writes a shim into the researcher's own PATH
// (~/.local/bin by default) and touches no research state, so it is a read of
// the paper, like doctor. `accept` and `serve` stay out: the name rule for the
// two acts the researcher keeps is unchanged.
const CLI_READ_SUBS = new Set(['status', 'review', 'init', 'doctor', 'install-cli', 'title']);
// US-2: the session server takes approvals from the browser, so only the
// researcher starts it. `placet-research serve` is already refused as a
// subcommand outside CLI_READ_SUBS; running the server script itself is the
// same act, and it is found on the same two routes as the CLI.
const SERVER_NAMES = new Set(['canvas-serve', 'canvas-serve.js']);
const XARGS_VALUE_FLAGS = new Set([
  '-a', '-d', '-E', '-I', '-J', '-L', '-n', '-P', '-s', '-S',
  '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars',
]);
// Two routes reach the CLI without it standing in the command slot, and the
// inference follows both (§5.3). A wrapper runs the command that follows it, so
// the words after it are read as a command line of their own. A program text is
// a language this lexer cannot read at all, so it is judged by what it names.
// Neither route infers the CLI from a bare word in argument position: that was
// SQ-32's over-denial of `cd placet-research && npm test`, and it stays gone.
const WRAPPERS = new Set(['env', 'command', 'exec', 'nice', 'time', 'nohup', 'sudo']);
// The wrapper options that take a separate value word, so the value is not
// mistaken for the command (`env -u NAME node …`, `sudo -u someone node …`).
const WRAPPER_VALUE_FLAGS = new Set([
  '-u', '--unset', '-C', '--chdir', '-S', '--split-string',
  '-n', '--adjustment', '-g', '--group', '-f', '--format', '-o', '--output',
]);
const OPAQUE_SHELLS = new Set(['sh', 'bash', 'zsh']);
// A shell's `-c` carries the program in the next word, and the flag may sit
// anywhere in a bundle of its own letters: `bash -ec PROG`, `bash -cs PROG` and
// `bash -ce PROG` all run PROG and never the heredoc body.
const SHELL_COMMAND_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/;
// SQ-67: the commands that read their program from standard input when no inline
// program flag carries it. A heredoc body fed to one of these is that program,
// not stdin data — `bash <<EOF` runs the body, and so does `bash -s <<EOF`,
// `node <<EOF` or `python3 <<EOF`. SQ-69: a script file operand does not change
// that; see `readsProgramFromStdin`.
const STDIN_PROGRAM_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash']);
const STDIN_PROGRAM_INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'perl', 'ruby']);
// The flags that carry the program on the command line instead, so what follows
// the heredoc is ordinary stdin data (`sh -c PROG`, `node -e PROG`). SQ-70: the
// spelling is per interpreter, because the letters are not shared — python's `-E`
// ignores PYTHON* environment variables and it has no `-e`, ruby's `-E` takes an
// encoding, and node's `-c` is `--check`, a syntax check that runs nothing. Only
// perl carries a program on `-E`. A flag outside an interpreter's row leaves the
// body judged as the program it may be, the fail-closed answer. The rows were read
// off the installed binaries (python3 3.14.7 `--help`, node v24.16.0 `--help`,
// perl 5.40.2, ruby 2.6.10) and each cluster form confirmed by feeding a body to
// the binary with and without the flag; the probes are the ticket's evidence
// (verification/SQ-70/probe-interpreter-flags.js).
const INTERPRETER_INLINE_PROGRAM_RE = new Map([
  // `-c` carries the program — bare (`python3 -c PROG`), attached (`-cPROG`, so
  // `-cE` runs the program `E`) or closing a cluster of boolean letters
  // (`python3 -Ic PROG`). `-W`, `-X` and `-m` take a value that swallows a trailing
  // `c` (`python3 -Wc` reads its program from stdin), so their letters are not
  // bundleable, and `-E`, `-Es` carry no program at all.
  ['python', /^-[bBdEhiIOPqSsuvVx]*c/],
  ['python3', /^-[bBdEhiIOPqSsuvVx]*c/],
  // `-e` and `-E` carry the program — bare, attached (`perl -e'PROG'`) or closing a
  // bundle of loop and formatting letters (`perl -ne PROG`, `perl -lne PROG`).
  // Perl's `-i` takes a backup suffix, so `perl -ie PROG` runs `PROG` as a script
  // file name: `i` is not bundleable.
  ['perl', /^-[nplc]*[eE]/],
  // Ruby's `-e` alone carries the program (`ruby -ne PROG`, `ruby -ce PROG`); its
  // `-E` takes the encoding, so `ruby -E UTF-8` reads the program from stdin.
  ['ruby', /^-[nplc]*e/],
  // `node -e PROG`, `node -p PROG`, `node -pe PROG`, `--eval PROG` and
  // `--print PROG`. Node takes no program attached to the letter (`node -ePROG` is
  // a bad option), and its `-c` is `--check`.
  ['node', /^-(e|p|pe)$|^--(eval|print)$/],
  ['nodejs', /^-(e|p|pe)$|^--(eval|print)$/],
]);
// SQ-70: the flags that make the interpreter read standard input as code *after*
// the inline program, so an inline flag does not make the heredoc body data.
// Python's `i` sits in the same boolean cluster as its other flags (`-i`, `-ic`,
// `-Ii`, `-Ei`), and node spells it `-i` or `--interactive`. Probed against the
// binaries: `python3 -i -c 'pass'`, `python3 -ic 'pass'` and `node -i -e 1` each
// ran the heredoc body; perl's and ruby's `-i` is in-place editing and never reads
// stdin as code (`perl -e PROG -i` and `ruby -ne PROG` left the body as data), so
// those two have no row and the fail-closed reading below stands for them.
const INTERPRETER_INTERACTIVE_PROGRAM_RE = new Map([
  // The literal `i` may only be a cluster letter, never the character before a
  // closing `c`: `-ci` attaches `i` as `-c`'s program text and runs it, so it is
  // not an interactive flag.
  ['python', /^-[bBdEhiIOPqSsuvVx]*i[bBdEhiIOPqSsuvVx]*c?$/],
  ['python3', /^-[bBdEhiIOPqSsuvVx]*i[bBdEhiIOPqSsuvVx]*c?$/],
  ['node', /^(?:-i|--interactive)$/],
  ['nodejs', /^(?:-i|--interactive)$/],
]);
// Python stops reading options at `-c`'s program word, so a flag after it is an
// argument, not a flag: `python3 -c PROG -i` runs PROG and never enters the
// interpreter, leaving the heredoc body as data. Node and perl keep reading
// options, so `node -e 1 -i` and `perl -e PROG -i` do see the later flag.
const INTERPRETER_PROGRAM_ENDS_OPTIONS = new Set(['python', 'python3']);
const RUNNER_EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--input-type']);
// `log` is the harness's own append path (§4.7): it seals what it writes, and
// it is open to the model for these two kinds only. A DECISION is the
// approval path's alone, and a kind the guard cannot read is judged as one.
const CLI_LOG_KINDS = new Set(['DISCOVERY', 'CONSTRAINT']);

// Commands that read and cannot be talked into writing by their own arguments.
// `awk` is absent on purpose: its program text is a language this guard cannot
// read, and `print > f` inside it writes a file.
const READ_ONLY = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'cut', 'tr', 'column', 'sort', 'uniq',
  'grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'stat', 'ls', 'file', 'find', 'realpath',
  'basename', 'dirname', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum',
  'echo', 'printf', 'pwd', 'cd', 'true', 'false', 'test', '[', '[[', 'date', 'sed', 'git',
]);
// SQ-106: the keywords that open a loop's condition or body. `for` and `done`
// stand as commands of their own and are handled where they appear.
const LOOP_OPENERS = new Set(['do', 'while', 'until']);
// SQ-68: verbs that never act on an operand as a file. An argument here is a
// value the command computes with, not a landing place for the state, so an
// unresolved substitution in one is not an unknown write target (the fail-closed
// reading below). Every verb not named here keeps that reading.
const NON_FILE_VERBS = new Set([
  '[', 'test', 'true', 'false', // decide on their operands; they create and change nothing
  'echo', 'printf', // send text to a stream; a named file only ever comes from a redirect, judged on its own
  'date', // prints the clock; an argument is a format string
  'sleep', // takes a duration, not a path
  'mkdir', // only creates a directory: every form on a path that already exists fails (EEXIST or ENOTDIR), so an existing state file keeps its bytes, mode and mtime
]);
// `add` and `commit` stage and record; neither rewrites a tracked file, and
// leaving them out would refuse `git commit -m "update research/canvas.md"`
// for naming the path. `checkout`, `restore`, `stash` and `clean` do rewrite.
const GIT_READ_ONLY = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'grep', 'add', 'commit',
  'rev-parse', 'ls-files', 'cat-file', 'describe', 'shortlog',
]);
const WRITE_FLAG_RE = /^--(?:output|out-file|output-file|write|in-place)(?:=|$)/;
const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const VALUE_RE = /^[^=\s]+=([\s\S]+)$/;
const FRAGMENT_SPLIT = /[^A-Za-z0-9._\-/~*?[\]+@:]+/;

// Reads a `$(...)` body from `src` starting just past the opening `(`. What the
// parenthesis opens is a command line of its own, so the quotes inside it are
// the ordinary ones and are kept in the body as they stand. Returns the body and
// the index just past the closing `)`, or the end of `src` with `open` set when
// the parenthesis is never closed.
function readParenBody(src, from) {
  let level = 1;
  let body = '';
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { body += ch + (src[i + 1] || ''); i += 2; continue; }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end + 1;
      body += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      body += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '(') level += 1;
    else if (ch === ')') {
      level -= 1;
      i += 1;
      if (!level) return { body, end: i, open: false };
      body += ch;
      continue;
    }
    body += ch;
    i += 1;
  }
  return { body, end: i, open: true };
}

// Reads the parameter a `$` at `at` opens in `src` — `${NAME}`, `$NAME` or a
// special parameter — as the mark a word gets for it, and the index past it.
// A `${…}` that is more than a name is an unknown, and a `$` that opens none
// of them stands for itself.
function parameterMark(src, at) {
  const next = src[at + 1];
  if (next === '{') {
    let k = at + 2;
    let name = '';
    let level = 1;
    while (k < src.length) {
      const ch = src[k];
      if (ch === '{') { level += 1; name += ch; k += 1; continue; }
      if (ch === '}') {
        level -= 1;
        k += 1;
        if (!level) break;
        name += ch;
        continue;
      }
      name += ch;
      k += 1;
    }
    return { mark: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `${EXP_OPEN}${name}${EXP_CLOSE}` : EXP_UNKNOWN, end: k };
  }
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let k = at + 1;
    while (k < src.length && /[A-Za-z0-9_]/.test(src[k])) k += 1;
    return { mark: `${EXP_OPEN}${src.slice(at + 1, k)}${EXP_CLOSE}`, end: k };
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return { mark: EXP_UNKNOWN, end: at + 2 };
  return { mark: '$', end: at + 1 };
}

// SQ-233: the text bash hands a command from the body of a heredoc whose
// delimiter was not quoted. A backslash escapes `$`, a backtick, itself and a
// newline, and nothing else; a parameter becomes the mark a word gets for it,
// and a substitution its literal output where that is knowable (SQ-57) or an
// unknown. The substitutions are lexed as commands by nestHeredocBody.
function expandHeredocBody(body, depth) {
  const output = (inner) => {
    const literal = literalSubstitutionValue(inner, depth);
    return literal === null ? EXP_UNKNOWN : literal;
  };
  let out = '';
  let k = 0;
  while (k < body.length) {
    const ch = body[k];
    if (ch === '\\' && /[$`\\\n]/.test(body[k + 1] || '')) {
      if (body[k + 1] !== '\n') out += body[k + 1];
      k += 2;
    } else if (ch === '`') {
      let inner = '';
      k += 1;
      while (k < body.length && body[k] !== '`') {
        if (body[k] === '\\') { inner += body[k + 1] || ''; k += 2; continue; }
        inner += body[k];
        k += 1;
      }
      out += output(inner);
      k += 1;
    } else if (ch === '$' && body[k + 1] === '(') {
      const read = readParenBody(body, k + 2);
      out += output(read.body);
      k = read.end;
    } else if (ch === '$') {
      const read = parameterMark(body, k);
      out += read.mark;
      k = read.end;
    } else {
      out += ch;
      k += 1;
    }
  }
  return out;
}

// Splits a command line into simple commands, each carrying its words and its
// redirections. Commands nested in `$(...)` or backticks are real commands and
// join the list; the word that held them keeps a mark that it is unknown.
function lexBash(text, depth) {
  const commands = [];
  let cmd = { words: [], redirects: [] };
  let word = null;
  let pending = null;
  // The heredocs whose bodies follow the newline, each with the redirect it
  // belongs to and whether its delimiter was quoted: only an unquoted delimiter
  // lets bash expand the body (see consumeHeredocs).
  const heredocs = [];
  let i = 0;

  function startWord(shellLiteral = false) {
    if (!word) word = { text: '', opaque: false, quoted: false, tilde: shellLiteral && /^~[^\s/"'`$\\;&|()<>]*(?=\/|$|[\s;&|()<>])/.test(text.slice(i)) };
    return word;
  }
  function endWord() {
    if (!word) return;
    if (word.braceAt) {
      if (word.braceAt.some((k) => word.text[k] === '{')) {
        let shape = '';
        let from = 0;
        for (const k of word.braceAt) {
          shape += word.text.slice(from, k) + BRACE_MARK[word.text[k]];
          from = k + 1;
        }
        word.shape = shape + word.text.slice(from);
      }
      delete word.braceAt;
    }
    expandShellTilde(word);
    word.opaque = word.text.includes(EXP_OPEN);
    if (pending) {
      // SQ-60: after `>&` or `<&`, a target that is only digits or `-` names a
      // file descriptor, not a file. The word is part of the redirection and
      // carries no path, so the redirect does not write anywhere and the word is
      // not a command argument either. Any other target — a path, or a
      // substitution the guard cannot read (`2>&$fd`) — keeps the redirect as
      // the file redirection it then is.
      if (pending.dup && !word.opaque && (word.text === '-' || /^[0-9]+$/.test(word.text))) {
        pending.write = false;
        pending.dup = false;
        pending = null;
        word = null;
        return;
      }
      pending.target = word;
      if (pending.heredoc) heredocs.push({ redirect: pending, text: word.text, quoted: word.quoted, cmd });
      pending = null;
    } else {
      cmd.words.push(word);
    }
    word = null;
  }
  function endCommand() {
    endWord();
    pending = null;
    if (cmd.words.length || cmd.redirects.length) commands.push(cmd);
    cmd = { words: [], redirects: [] };
  }
  // A body past MAX_SUBSTITUTION_DEPTH is not lexed at all: everything below it
  // stays unseen, so a word standing in for it would be a guess. The line is
  // marked unreadable instead, and the verdict refuses it as one (SQ-29 F7).
  function nest(body) {
    if (depth >= MAX_SUBSTITUTION_DEPTH) {
      commands.push({ unreadable: true, words: [], redirects: [] });
      return false;
    }
    for (const inner of lexBash(body, depth + 1)) commands.push(inner);
    return true;
  }

  function readSubstitution() {
    const read = readParenBody(text, i);
    i = read.end;
    return read.body;
  }

  function readBackquote(w) {
    let body = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { body += text[i + 1] || ''; i += 2; continue; }
      if (ch === '`') { i += 1; break; }
      body += ch;
      i += 1;
    }
    const literal = literalSubstitutionValue(body, depth);
    w.text += literal === null ? EXP_UNKNOWN : literal;
    nest(body);
  }

  function readDollar(w) {
    if (text[i + 1] === '(') {
      i += 2;
      const body = readSubstitution();
      const literal = literalSubstitutionValue(body, depth);
      w.text += literal === null ? EXP_UNKNOWN : literal;
      nest(body);
      return;
    }
    const read = parameterMark(text, i);
    w.text += read.mark;
    i = read.end;
  }

  // The body of `$'…'`, decoded the way bash decodes it: the one-letter
  // escapes, `\xHH` and `\NNN`. `\c`, `\u`, `\U` and a NUL are not reproduced
  // here, nor a control character this lexer uses as a mark; the word then
  // holds an unknown, as a substitution's output does.
  function readAnsiQuoted(w) {
    w.quoted = true;
    while (i < text.length && text[i] !== "'") {
      if (text[i] !== '\\') { w.text += text[i]; i += 1; continue; }
      const esc = text[i + 1];
      const hex = /^x([0-9A-Fa-f]{1,2})/.exec(text.slice(i + 1, i + 4));
      const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4));
      const code = hex ? parseInt(hex[1], 16) : octal ? parseInt(octal[0], 8) & 0xff : null;
      if (code !== null) {
        w.text += code > 4 ? String.fromCharCode(code) : EXP_UNKNOWN;
        i += 1 + (hex || octal)[0].length;
      } else if (esc !== undefined && Object.prototype.hasOwnProperty.call(ANSI_ESCAPES, esc)) {
        w.text += ANSI_ESCAPES[esc];
        i += 2;
      } else if (esc === 'c' || esc === 'u' || esc === 'U') {
        w.text += EXP_UNKNOWN;
        i += 2;
      } else {
        w.text += '\\';
        i += 1;
      }
    }
    i += 1;
  }

  function readDoubleQuoted(w) {
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') { i += 1; return; }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined) { i += 1; return; }
        if (next === '\n') { i += 2; continue; }
        if (next === '$' || next === '`' || next === '"' || next === '\\') { w.text += next; i += 2; continue; }
        w.text += ch;
        i += 1;
        continue;
      }
      if (ch === '$') { readDollar(w); continue; }
      if (ch === '`') { i += 1; readBackquote(w); continue; }
      w.text += ch;
      i += 1;
    }
  }

  // Lexes the command substitutions in the body of a heredoc whose delimiter was
  // not quoted: bash runs `$(...)` and backticks there before the command does,
  // so each is a nested command the way it would be in a word. The rest of the
  // body is data that reaches the command's stdin, not a command line, so it is
  // not lexed as one — `cat <<EOF` with `rm …` on its own line reads, and
  // removes nothing. Quotes inside the body protect nothing either: bash expands
  // `'$(…)'` there. Returns false when part of the body stayed unread.
  function nestHeredocBody(body) {
    let k = 0;
    while (k < body.length) {
      const ch = body[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '`') {
        let inner = '';
        k += 1;
        for (;;) {
          if (k >= body.length) return false;
          if (body[k] === '\\') { inner += body[k + 1] || ''; k += 2; continue; }
          if (body[k] === '`') { k += 1; break; }
          inner += body[k];
          k += 1;
        }
        if (!nest(inner)) return false;
        continue;
      }
      if (ch === '$' && body[k + 1] === '(') {
        const read = readParenBody(body, k + 2);
        if (read.open || !nest(read.body)) return false;
        k = read.end;
        continue;
      }
      k += 1;
    }
    return true;
  }

  // `i` points at `<` or `>`; `forced` marks the `&>` form, which writes.
  function readRedirect(forced) {
    const op = text[i];
    i += 1;
    let write = forced || op === '>';
    let heredoc = false;
    // SQ-60: `[N]>&M` and `[N]<&M` duplicate a descriptor. The word that follows
    // belongs to the redirection as an fd number or `-`, never as a path, so the
    // form is flagged for endWord.
    let dup = false;
    if (op === '>') {
      if (text[i] === '>' || text[i] === '|') i += 1;
      else if (text[i] === '&') { dup = true; i += 1; }
    } else if (text[i] === '<') {
      heredoc = true;
      i += 1;
      if (text[i] === '<') { heredoc = false; i += 1; } else if (text[i] === '-') i += 1;
    } else if (text[i] === '>') { write = true; i += 1; } else if (text[i] === '&') { dup = true; i += 1; }
    pending = { write, heredoc, dup, target: null };
    cmd.redirects.push(pending);
  }

  // A heredoc body runs to the line that holds its delimiter alone. The body of
  // an unquoted delimiter is expanded by bash before the command runs, so it is
  // scanned for substitutions. Any other body is literal data and is not lexed;
  // the verdict still judges the paths a data body spells (SQ-232).
  function consumeHeredocs() {
    while (heredocs.length) {
      const heredoc = heredocs.shift();
      const delimiter = heredoc.text.replace(/['"\\]/g, '').trim();
      const lines = [];
      for (;;) {
        if (i >= text.length) break;
        const nl = text.indexOf('\n', i);
        const line = nl < 0 ? text.slice(i) : text.slice(i, nl);
        i = nl < 0 ? text.length : nl + 1;
        if (line.trim() === delimiter) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      // SQ-67: a body fed to a shell or interpreter that reads its program from
      // stdin is that program, not stdin data, and quoting the delimiter does not
      // change that — `bash <<EOF` and `bash <<'EOF'` run the body alike. It is
      // lexed as the script it is, at the depth the substitution-scan already
      // nests an unquoted body's `$(...)` at. The receiving command is marked so
      // the verdict reads it as a launcher and judges what the body does.
      if (heredoc.cmd && readsProgramFromStdin(heredoc.cmd.words)) {
        if (STDIN_PROGRAM_SHELLS.has(launchedCommandAt(heredoc.cmd.words).name)) {
          heredoc.cmd.stdinProgram = true;
          if (!nest(body)) heredoc.redirect.unreadBody = { text: body, opaque: true };
          continue;
        }
        // SQ-101: an interpreter's body is python, JS, perl or ruby, not shell
        // words, so lexing it as bash read `os.mkdir(…)` as commands and refused
        // ordinary scripts. It is program text the guard cannot read, judged the
        // way the quoted `PROG` of `node -e PROG` is: on the paths it spells,
        // with the interpreter itself a verb that is not read-only. An unquoted
        // delimiter still has bash run the body's substitutions first. The body
        // is not read the way `node -e PROG` is: a path component spelling the
        // CLI (`plugins/placet-research/…`) is no invocation, and matching on it
        // denied ordinary scripts in the harness's own checkout as `accept`.
        // SQ-105: `program` marks it for the narrower named-write test instead,
        // which wants the CLI's name at the end of a path together with `accept`.
        heredoc.redirect.unreadBody = { text: body, opaque: false, quoted: true, program: true };
        if (!heredoc.quoted) nestHeredocBody(body);
        continue;
      }
      // SQ-232: any other body is stdin data, and data can still name a file:
      // `xargs rm <<'EOF'` removes the paths its body lists, as `printf … |
      // xargs rm` does. Whatever the quoting, the redirect carries the body so
      // the verdict judges the paths it spells, as it judges a printf argument.
      heredoc.redirect.dataBody = { text: body, opaque: false, quoted: true };
      if (heredoc.quoted) continue;
      // SQ-233: bash expands an unquoted body before the command reads it, so
      // where that changes the text, the text the command is handed is carried
      // as well, with the marks a word gets for what the guard cannot compute.
      const expanded = expandHeredocBody(body, depth);
      if (expanded !== body) heredoc.redirect.dataBody.expanded = { text: expanded, opaque: false, quoted: true };
      // A body the scan could not finish is a word the guard cannot read: the
      // redirect carries it so the verdict can judge it as one.
      if (!nestHeredocBody(body)) heredoc.redirect.unreadBody = { text: body, opaque: true };
    }
  }

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) { i += 1; continue; }
      if (next === '\n') { i += 2; continue; }
      const escaped = startWord();
      escaped.quoted = true;
      escaped.text += next;
      i += 2;
      continue;
    }
    if (ch === "'") {
      i += 1;
      const end = text.indexOf("'", i);
      const single = startWord();
      single.quoted = true;
      single.text += end < 0 ? text.slice(i) : text.slice(i, end);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      const double = startWord();
      double.quoted = true;
      readDoubleQuoted(double);
      continue;
    }
    if (ch === '`') { i += 1; readBackquote(startWord()); continue; }
    // `$'…'` is ANSI-C quoting and `$"…"` a translated string. Read as a `$`
    // character followed by a quote, `$'--out'` was a word that does not start
    // with `-`, where bash makes `--out` of it (SQ-185).
    if (ch === '$' && text[i + 1] === "'") { i += 2; readAnsiQuoted(startWord()); continue; }
    if (ch === '$' && text[i + 1] === '"') { i += 1; startWord(); continue; }
    if (ch === '$') { readDollar(startWord()); continue; }
    if (ch === '#' && !word) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endWord(); i += 1; continue; }
    if (ch === '\n') { endWord(); i += 1; consumeHeredocs(); endCommand(); continue; }
    if (ch === '&' && text[i + 1] === '>') { endWord(); i += 1; readRedirect(true); continue; }
    if (ch === ';' || ch === '&' || ch === '|') {
      endCommand();
      i += 1;
      if (text[i] === ch || (ch === '|' && text[i] === '&')) i += 1;
      continue;
    }
    if (ch === '(' || ch === ')') { endCommand(); i += 1; continue; }
    if (ch === '<' || ch === '>') {
      if (word && /^[0-9]+$/.test(word.text)) word = null;
      else endWord();
      readRedirect(false);
      continue;
    }
    const plain = startWord(true);
    if (ch === '{' || ch === '}' || ch === ',') (plain.braceAt || (plain.braceAt = [])).push(plain.text.length);
    plain.text += ch;
    i += 1;
  }
  endWord();
  consumeHeredocs();
  endCommand();
  return commands;
}

function baseNameOf(text) {
  const cut = text.lastIndexOf('/');
  return cut < 0 ? text : text.slice(cut + 1);
}

// When a `$(...)`/backtick body is nothing but a literal `echo` or `printf`
// of a constant, its output is knowable without running it: splice that
// output into the word as literal text instead of leaving an opaque mark, so
// a path built from several such substitutions still reads as one literal
// (SQ-57).
function literalSubstitutionValue(body, depth) {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return null;
  let commands;
  try {
    commands = lexBash(body, depth + 1);
  } catch (_) {
    return null;
  }
  if (commands.length !== 1) return null;
  const [sc] = commands;
  if (sc.redirects.length || !sc.words.length) return null;
  // A brace in the echoed words expands to more than the text it spells (SQ-75).
  if (sc.words.some((w) => w.opaque || w.shape)) return null;
  const verb = baseNameOf(sc.words[0].text);
  const args = sc.words.slice(1).map((w) => w.text);
  if (verb === 'echo') {
    if (args.some((a) => a.startsWith('-'))) return null; // flags can change output; do not guess
    return args.join(' ');
  }
  if (verb === 'printf') {
    if (!args.length) return null;
    const [format, ...rest] = args;
    if (format.includes('\\') || /%(?!s)/.test(format)) return null;
    const slots = (format.match(/%s/g) || []).length;
    if (slots === 0) return rest.length ? null : format;
    if (slots === 1 && rest.length === 1) return format.replace('%s', rest[0]);
    return null;
  }
  return null;
}

function substitute(w, values) {
  if (!w.text.includes(EXP_OPEN)) return;
  const put = (all, name) => (name && values.has(name) ? values.get(name) : all);
  w.text = w.text.replace(EXP_RE, put);
  // A value is spliced in after brace expansion, as bash does it: a brace in the
  // value is a plain character in the shape.
  if (w.shape) w.shape = w.shape.replace(EXP_RE, put);
  w.opaque = w.text.includes(EXP_OPEN);
}

// A `{1..3}` or `{a..e}` body as the words it expands to, or null when it is
// not a sequence bash expands.
function braceSequence(body) {
  const num = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  const chr = num ? null : /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body);
  const m = num || chr;
  if (!m) return null;
  const from = num ? Number(m[1]) : m[1].charCodeAt(0);
  const to = num ? Number(m[2]) : m[2].charCodeAt(0);
  const step = Math.abs(Number(m[3] || 1)) || 1;
  const count = Math.floor(Math.abs(to - from) / step) + 1;
  if (!Number.isSafeInteger(count) || count > MAX_EXPANSIONS) return undefined;
  const padded = !!num && (/^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]));
  const pad = padded ? Math.max(m[1].length, m[2].length) : 0;
  const out = [];
  for (let k = 0, v = from; k < count; k += 1, v += from <= to ? step : -step) {
    if (!num) out.push(String.fromCharCode(v));
    else {
      const digits = String(Math.abs(v)).padStart(pad - (v < 0 ? 1 : 0), '0');
      out.push(v < 0 ? `-${digits}` : digits);
    }
  }
  return out;
}

// Expands the brace marks in a shape the way bash does, prefix and suffix and
// nesting included. Returns null past MAX_EXPANSIONS words: that word is one
// the guard cannot judge.
function braceExpand(shape) {
  for (let open = shape.indexOf(BRACE_OPEN); open >= 0; open = shape.indexOf(BRACE_OPEN, open + 1)) {
    let level = 0;
    let close = -1;
    const commas = [];
    for (let k = open; k < shape.length; k += 1) {
      if (shape[k] === BRACE_OPEN) level += 1;
      else if (shape[k] === BRACE_CLOSE) {
        level -= 1;
        if (!level) { close = k; break; }
      } else if (shape[k] === BRACE_COMMA && level === 1) commas.push(k);
    }
    if (close < 0) continue;
    let alternatives;
    if (commas.length) {
      alternatives = [];
      let from = open + 1;
      for (const k of [...commas, close]) { alternatives.push(shape.slice(from, k)); from = k + 1; }
    } else {
      alternatives = braceSequence(shape.slice(open + 1, close).replace(BRACE_MARKS_RE, (m) => BRACE_CHAR[m]));
      if (alternatives === undefined) return null;
      if (!alternatives) continue;
    }
    const out = [];
    for (const alternative of alternatives) {
      const rest = braceExpand(shape.slice(0, open) + alternative + shape.slice(close + 1));
      if (!rest || out.length + rest.length > MAX_EXPANSIONS) return null;
      out.push(...rest);
    }
    return out;
  }
  return [shape.replace(BRACE_MARKS_RE, (m) => BRACE_CHAR[m])];
}

// The words bash makes of one word: its brace expansion, and for every variable
// a `for NAME in …` loop over literal words set (`loops`), one word per value
// (SQ-75). A word too large to compute comes back as one opaque word marked
// `uncomputable`. A word with neither comes back as itself.
function expandWord(w, loops) {
  let texts = [w.text];
  if (w.shape) {
    // Every unmatched `{` is rescanned, so a word of thousands of them is not
    // expanded at all.
    const marks = w.shape.match(BRACE_MARKS_RE).length;
    texts = marks > 4 * MAX_EXPANSIONS ? null : braceExpand(w.shape);
    if (!texts) return [{ text: w.text, opaque: true, quoted: w.quoted, uncomputable: true }];
  }
  if (loops.size && w.text.includes(EXP_OPEN)) {
    const out = [];
    for (const text of texts) {
      let variants = [text];
      const names = new Set();
      for (const m of text.matchAll(EXP_RE)) if (loops.has(m[1])) names.add(m[1]);
      for (const name of names) {
        const mark = `${EXP_OPEN}${name}${EXP_CLOSE}`;
        const next = [];
        for (const v of variants) for (const value of loops.get(name)) next.push(v.split(mark).join(value));
        if (out.length + next.length > MAX_EXPANSIONS) return [{ text: w.text, opaque: true, quoted: w.quoted, uncomputable: true }];
        variants = next;
      }
      out.push(...variants);
    }
    texts = out;
  }
  if (texts.length === 1 && texts[0] === w.text) return [w.shape ? { text: w.text, opaque: w.opaque, quoted: w.quoted } : w];
  return texts.map((text) => ({ text, opaque: text.includes(EXP_OPEN), quoted: w.quoted }));
}

// One word can carry several paths: the word itself, the value of a `k=v`
// argument (`awk -v f=research/canvas.md`), and any slash-bearing run inside a
// quoted program text (`node -e '…("research/canvas.md")'`).
function pathCandidates(text) {
  return wordCandidates(text).concat(pathFragments(text));
}

// The candidates the shell itself sees as arguments: the word and its value.
function wordCandidates(text) {
  const value = VALUE_RE.exec(text);
  return value ? [text, value[1]] : [text];
}

// The slash-bearing runs inside the word's text.
function pathFragments(text) {
  return text.split(FRAGMENT_SPLIT).filter((fragment) => fragment.includes('/'));
}

function globToRegExp(component) {
  let source = '';
  for (let k = 0; k < component.length; k += 1) {
    const ch = component[k];
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '[') {
      const end = component.indexOf(']', k + 1);
      if (end < 0) source += '\\[';
      else { source += `[${component.slice(k + 1, end).replace(/\\/g, '\\\\')}]`; k = end; }
    } else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

// The characters that can make a component a pattern rather than a name. On
// its own a `[` is not enough: `isPattern` asks whether it opens a class.
const GLOB_META_RE = /[*?[]/;

// A component is a pattern when the shell would expand it: a `*`, a `?`, or a
// `[…]` class that is really one. The brackets are where this has to be
// careful, because plenty of ordinary words carry them. `["SQ-28","SQ-30"]` in
// a `node -e` body and `[sidequest-route model=a]` in a quoted body are
// punctuation and quotes around a name; the class they spell is not one the
// engine accepts, and bash leaves the word alone, so the word is a name and is
// compared as one. One definition, so "matches the state directory by glob" and
// "is a name, not a pattern" cannot drift apart.
function isPattern(text) {
  if (!GLOB_META_RE.test(text)) return false;
  if (/[*?]/.test(text)) return true;
  try {
    globToRegExp(text);
    return true;
  } catch (_) {
    return false;
  }
}

function componentMatches(pattern, literal) {
  // A component that spells the state's own name is that name: the state path
  // is built from real directories, and one of them can carry brackets itself.
  // Read as a class, `paper[2024]` failed to match the very directory it names
  // and the guard stopped recognising its own state (SQ-29 F5: lex L33, M10).
  if (pattern === literal) return true;
  if (!isPattern(pattern)) return false;
  try {
    return globToRegExp(pattern).test(literal);
  } catch (_) {
    // A `*` or `?` word whose class the engine refuses is a pattern the guard
    // cannot compute: what it expands onto is unknown, which is neither a match
    // nor a miss. The callers deny it rather than read it as one.
    return null;
  }
}

// Shared by the plain spelling comparison and the resolved-path comparison
// below: true when the leading components of `parts` spell `stateParts`, null
// when one of them is a pattern the guard cannot compute.
function partsMatchState(parts, stateParts, literal) {
  if (parts.length < stateParts.length) return false;
  for (let k = 0; k < stateParts.length; k += 1) {
    const matched = literal ? parts[k] === stateParts[k] : componentMatches(parts[k], stateParts[k]);
    if (matched === null) return null;
    if (!matched) return false;
  }
  return true;
}

// True when the path could name the state directory or anything below it, null
// when a component of it is a pattern the guard cannot compute. A word that is
// only an ancestor (`.`, `..`) does not count: catching those would refuse
// `git add .`, and this is a promotion guard, not a sandbox against a command
// that destroys the whole project. `literal` compares each component as a name
// only, for text no shell will expand (see wordTouchesState).
function denotesState(candidate, base, stateParts, literal) {
  if (!candidate || candidate.includes(EXP_OPEN)) return false;
  let resolved;
  try {
    resolved = path.resolve(base, candidate);
  } catch (_) {
    return false;
  }
  return partsMatchState(resolved.split(path.sep).filter(Boolean), stateParts, literal);
}

// The harness state root, as words on a command line can spell it: resolved,
// `~`-prefixed, or opaque with the literal tail that survives expansion
// (`"$HOME/.claude/placet-research/…"`).
function harnessRoot() {
  const configured = path.resolve(ledger.stateRoot());
  const root = canonical(configured, 0);
  const home = os.homedir();
  const rel = path.relative(home, root);
  // Both spellings, because a command names the directory as it was typed and
  // the filesystem answers to the canonical one (/var → /private/var on macOS).
  const spellings = [...new Set([configured, root])];
  return {
    parts: spellings.map((s) => s.split(path.sep).filter(Boolean)),
    tail: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null,
    names: new Set([seal.KEY_FILE]),
  };
}

// SQ-331: normalize only a prefix the lexer saw unquoted. Quoted/escaped
// tildes remain literal relative paths; quoting later path components does not
// stop expansion. Named-user tildes are runtime-assembled, never guessed from
// the hook's home, so writes that might reach state remain fail-closed.
function expandShellTilde(w) {
  if (!w.tilde) return;
  for (const key of ['text', 'shape']) {
    if (!w[key]) continue;
    const expanded = expandTilde(w[key]);
    w[key] = expanded.startsWith('~') ? expanded.replace(/^~[^/]*/, EXP_UNKNOWN) : expanded;
  }
}

function expandTilde(candidate) {
  if (candidate === '~' || candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(1));
  return candidate;
}

// Where a candidate word actually lands: `links` is every `ln -s TARGET NAME`
// this same command already made (§ trackSymlink) — the shell has not run it
// yet, but the guard can still tell where NAME would point, the same way it
// already tracks `cd` across statements. `canonical` then resolves whatever
// is left through the real filesystem, exactly as the file-tool path does
// (landingOf/canonical): a symlink prepared before this command runs, or
// sitting anywhere above the state dir, is caught there.
function resolveThroughLinks(base, candidate, links) {
  let resolved;
  try {
    resolved = path.resolve(base, candidate);
  } catch (_) {
    return null;
  }
  for (const [from, to] of links) {
    if (resolved === from) { resolved = to; break; }
    const prefix = from + path.sep;
    if (resolved.startsWith(prefix)) { resolved = path.join(to, resolved.slice(prefix.length)); break; }
  }
  return canonical(resolved, 0);
}

const NO_LINKS = new Map();

function wordTouchesHarness(w, base, harness, links) {
  if (w.opaque) {
    const literal = w.text.replace(EXP_RE, '');
    if (harness.tail && literal.includes(harness.tail)) return true;
    return opaqueNamesState(w.text, harness.names);
  }
  const resolvedBase = base || os.homedir();
  return pathCandidates(w.text).some((expanded) => {
    // `!== false`, not truthiness: a pattern the guard cannot compute counts as
    // touching here. This is the directory that holds the sealing key, and it
    // admits no spelling at all, read-only or not.
    if (harness.parts.some((parts) => denotesState(expanded, resolvedBase, parts) !== false)) return true;
    if (!expanded || expanded.includes(EXP_OPEN)) return false;
    const landed = resolveThroughLinks(resolvedBase, expanded, links || NO_LINKS);
    if (!landed) return false;
    const parts = landed.split(path.sep).filter(Boolean);
    return harness.parts.some((stateParts) => partsMatchState(parts, stateParts) !== false);
  });
}

// A word the guard could not fully expand is judged on the literal parts it
// still has: a path it cannot resolve but that names the state dir or one of
// its files is treated as touching it.
// `ln -s TARGET LINKNAME` inside the same command aliases LINKNAME to wherever
// TARGET already resolves, before the shell has made anything: the guard does
// not need the link to exist on disk to know where it will point the moment
// this command runs. Only the plain two-operand form is tracked; anything
// odder (missing/extra operands, an opaque operand) is left alone rather than
// guessed at.
function trackSymlink(argv, base, links) {
  if (base === null || !argv.length || argv[0].opaque || baseNameOf(argv[0].text) !== 'ln') return;
  const flags = [];
  const positional = [];
  for (const w of argv.slice(1)) {
    if (w.opaque) return; // cannot read this operand; do not guess
    if (w.text.startsWith('-') && w.text !== '-') flags.push(w.text);
    else positional.push(w.text);
  }
  if (positional.length !== 2) return;
  const symbolic = flags.some((f) => (f.startsWith('--') ? f === '--symbolic' : /s/.test(f.slice(1))));
  if (!symbolic) return;
  let target;
  try {
    target = canonical(path.resolve(base, positional[0]), 0);
  } catch (_) {
    return;
  }
  links.set(path.resolve(base, positional[1]), target);
}

function opaqueNamesState(text, stateNames) {
  for (const fragment of text.replace(EXP_RE, ' ').split(FRAGMENT_SPLIT)) {
    for (const part of fragment.split('/')) {
      if (part && stateNames.has(part)) return true;
    }
  }
  return false;
}

// 0.5: `placet-research key export --out <file>.seal.key` puts the sealing key
// in a file of the person's choosing, outside the state directory, for them to
// carry to a second clone. A file whose name ends in .seal.key is that key
// wherever it lies, so no tool reads, copies or writes one (spec §7). Compared
// without case: a case-blind volume opens VOICE.SEAL.KEY as voice.seal.key.
const KEY_FILE_SUFFIX = '.seal.key';

function isKeyFileName(name) {
  return name.toLowerCase().endsWith(KEY_FILE_SUFFIX);
}

// The name a text spells at its end. A part the guard cannot expand counts as
// empty, so `voice.seal$E.key` is the key when $E is.
function spellsKeyFile(text) {
  return isKeyFileName(text.replace(EXP_RE, '').split(/[\\/]/).pop());
}

// A pattern expands onto the files that are there (SQ-76), so it is judged by
// what it would expand onto now: `cat ~/Downloads/*` reads a key lying there.
// The last component names the files themselves, so its matches are judged by
// name, never counted: `ls binlog.*` over ten thousand logs reaches no key
// (SQ-199). Only a directory component that fans out past MAX_GLOB_MATCHES
// paths counts as reaching a key. One whose class the engine refuses is left
// to wordTouchesState, which already weighs a pattern it cannot compute by the
// position it stands in (SQ-54).
const MAX_GLOB_MATCHES = 4096;

function globLandsOnKeyFile(candidate, base) {
  const parts = path.resolve(base, candidate).split(path.sep).filter(Boolean);
  let paths = [path.parse(path.resolve(base)).root];
  for (const [n, part] of parts.entries()) {
    if (!isPattern(part)) {
      paths = paths.map((at) => path.join(at, part));
      continue;
    }
    let re;
    try {
      re = globToRegExp(part);
    } catch (_) {
      return false;
    }
    const next = [];
    for (const at of paths) {
      let entries = [];
      try {
        entries = fs.readdirSync(at);
      } catch (_) {
        continue;
      }
      for (const entry of entries) {
        if (!re.test(entry)) continue;
        if (n < parts.length - 1) next.push(path.join(at, entry));
        else if (isKeyFileName(entry)) return true;
      }
      if (next.length > MAX_GLOB_MATCHES) return true;
    }
    paths = next;
  }
  return paths.some((at) => isKeyFileName(path.basename(at)));
}

// True when a shell word names an exported key file: by the name it spells, by
// what its pattern expands onto, or by where it lands through a symlink, one
// made earlier in this command included. A word that is program text
// (runsProgramText, a heredoc program) is read on every name in it, the way
// `node -e '…readFileSync("voice.seal.key")…'` spells one; any other word only
// on itself and its `k=v` value, so a commit message or a grep pattern that
// mentions a key file is not one.
function wordNamesKeyFile(w, base, links, programText) {
  const candidates = wordCandidates(w.text);
  if (programText) candidates.push(...w.text.replace(EXP_RE, '').split(FRAGMENT_SPLIT).filter(Boolean));
  if (candidates.some(spellsKeyFile)) return true;
  if (w.opaque) return false;
  return candidates.some((expanded) => {
    if (expanded.includes(EXP_OPEN)) return false;
    if (base === null && !path.isAbsolute(expanded)) return false;
    const at = base || os.homedir();
    if (isPattern(expanded)) return globLandsOnKeyFile(expanded, at);
    const landed = resolveThroughLinks(at, expanded, links);
    return !!landed && isKeyFileName(path.basename(landed));
  });
}

// `/` and `\` both separate path components: a path written on Windows spells
// the same location.
const PATH_SEPARATOR_RE = /[\\/]/;

function hasPathSeparator(text) {
  return PATH_SEPARATOR_RE.test(text);
}

// The shell resolves a bare word as a path of its own, so `rm -rf research`
// really removes the state directory and is judged as one while it is there.
// In a repository that is not a paper project there is no such directory, and
// then the same word names nothing: the guard is inert for it, which is the
// false deny SQ-65 reports from a vault and a skills checkout (README: the
// plugin stays silent there). Only the word that *is* the state directory is
// let go this way — a word one level below it (`rm -rf notes.md` after `cd
// research`), and anything that spells a location at all (`research/canvas.md`,
// `./research`, an absolute path, a path through a symlinked ancestor), is
// judged whether or not the directory exists. A command that creates the state
// is therefore still judged, and fail-closed (§5.3) holds for every project
// that has the directory.
//
// A bare name is let go, and so is a pattern: `rm -rf resea[r]ch` is judged
// while the state directory is right there, because the glob expands onto it,
// and in a project whose state directory holds neither the canvas nor the
// decision log there is nothing for it to land on, so `for d in */` names
// nothing either (SQ-71). A word whose brackets are not a class at all
// (`["SQ-28","SQ-30"]` in a `node -e` body) is a name, and is let go where it
// names nothing. A word that spells a location literally (`research/canvas.md`,
// `./research`, an absolute path) is never let go this way: that is the word
// that would create the state, and SQ-65 judges it whether or not it exists.
//
// A pattern below the state directory is let go too, unless the component that
// stands where the state files would can match one of them (SQ-76). The shell
// expands a glob only onto files that exist, so `find -path '*/20*/*'` — denied
// in a repo without research state because its leading `*` resolved onto
// `research` — cannot reach the canvas. `research/canva?.md` is still judged:
// the state is read once, on entry, and a line that first creates it with a
// bare name (`git checkout HEAD -- research`) would have the glob land on it.
const STATE_FILES = [project.CANVAS_FILE, project.DECISIONS_FILE, project.GLOSSARY_FILE];

//
// SQ-75 carries the same rule over to a literal word: `git mv research/a.md
// research/b.md` in a vault whose `research/` is a notes folder lands on no
// state file and creates none, so it is let go. Only the component that stands
// where the state files would decides, compared without case, because a
// case-blind volume would put `research/Canvas.md` on the canvas. A spelled
// path to the directory itself (`research/`, `./research`) is still judged:
// copying a folder into it can bring the canvas along.
function isStateFileName(component) {
  return STATE_FILES.some((name) => component.toLowerCase() === name.toLowerCase() || componentMatches(component, name) !== false);
}

function namesAbsentStateDir(candidate, base, stateParts, hasState) {
  if (hasState) return false;
  const pattern = isPattern(candidate);
  let resolved;
  try {
    resolved = path.resolve(base, candidate);
  } catch (_) {
    return false;
  }
  // Equal length means the word is the state directory itself, not a path
  // reaching into it; denotesState has already matched every component.
  const parts = resolved.split(path.sep).filter(Boolean);
  if (parts.length === stateParts.length) return pattern || !hasPathSeparator(candidate);
  return !isStateFileName(parts[stateParts.length]);
}

// An opaque word in a project without state (SQ-75). A word that reaches below
// a component named like the state directory through a literal tail lands where
// that tail says, whatever the unknown part before it was: `research/$n` with a
// loop value, `"$d/research/x.md"`. It is let go unless the component below can
// be a state file. An unknown part anywhere in the tail can climb out with `..`
// or be `canvas.md` itself, so it counts as "can"; so does a tail that leaves the
// directory. Every other name the word spells is judged as before.
const OPAQUE_SPLIT = /[^A-Za-z0-9._\-/~*?[\]+@:\u0000\u0001]+/;

function opaqueReachesState(text, stateNames, dirName) {
  for (const fragment of text.split(OPAQUE_SPLIT)) {
    const parts = fragment.split('/');
    for (let k = 0; k < parts.length; k += 1) {
      const names = parts[k].replace(EXP_RE, ' ').split(' ').some((piece) => piece && stateNames.has(piece));
      if (!names) continue;
      const tail = parts.slice(k + 1).join('/');
      if (parts[k] !== dirName || !tail || tail.includes(EXP_OPEN)) return true;
      const below = path.posix.normalize(tail).split('/')[0];
      if (below === '.' || below === '..' || isStateFileName(below)) return true;
      break;
    }
  }
  return false;
}

// True when the word names the state, null when the pattern in it is one the
// guard cannot compute, false when it names something else. The null is the
// caller's to weigh: a word in a write position is denied on it, because a
// pattern whose expansion is unknown can land on the state.
//
// `inertText` says the command runs no program text of its own (see
// runsProgramText). The slash-bearing runs inside the word are then bytes of a
// sed program, a grep pattern or a message, which no shell expands: a `*` or
// `**` there is a character, and a run names the state only by spelling it
// (SQ-96: `sed -i '' 's|x|**/_raw/*|' .gitignore` was denied because `**`
// matched `research`). The word itself and a `k=v` value stay patterns, since
// the shell does expand those, unless the word is `inert`: an item xargs reads
// from a heredoc reaches its command unexpanded (SQ-233).
function wordTouchesState(w, base, stateParts, stateNames, hasState, inertText, stateRoot) {
  // A brace expansion or loop too large to compute (SQ-75) is unknown where
  // state is there to land on; where it is not, it is read on the names it
  // spells, the way an opaque word is.
  if (w.uncomputable && hasState) return null;
  if (w.opaque && hasState) return opaqueNamesState(w.text, stateNames);
  if (w.opaque) return opaqueReachesState(w.text, stateNames, stateParts[stateParts.length - 1]);
  if (base === null) return false;
  let unjudgeable = false;
  const candidates = wordCandidates(w.text).map((text) => [text, !!w.inert, false])
    .concat(pathFragments(w.text).map((text) => [text, !!inertText, true]));
  for (const [candidate, literal, fragment] of candidates) {
    const denotes = denotesState(candidate, base, stateParts, literal);
    if (denotes === null) unjudgeable = true;
    else if (denotes && !namesAbsentStateDir(candidate, base, stateParts, hasState)) return true;
    else if (!candidate.includes(EXP_OPEN)) {
      const landed = canonical(path.resolve(base, candidate), 0);
      // A run inside a word's text is not a path either: `s/Foo\./Research/`
      // is program text, and on a case-insensitive volume `./Research/` in it
      // resolves onto the state directory without naming it. Such a run counts
      // on where it lands only when that landing is a state file (row 16:
      // `sed -n 'w Research/canvas.md'`), which is a write wherever it is
      // spelled from; the spelled comparison above stays its judge (SQ-145).
      if (underState(landed, stateRoot)
        && (!fragment || isStateFileName(path.basename(landed)))
        && (hasState || hasPathSeparator(candidate) || !samePath(landed, stateRoot))
        && !namesAbsentStateDir(landed, base, stateRoot.split(path.sep).filter(Boolean), hasState)) return true;
    }
  }
  return unjudgeable ? null : false;
}

// Commands that hand some of their words to a shell or an interpreter as program
// text (`sh -c 'rm res*/canvas.md'`, `eval`, `xargs sh -c`, `find -exec sh -c`,
// `node -e 'execSync(…)'`, `awk '{system(…)}'`, `watch`, `ssh`). A `*` in that
// text is expanded when it runs, so a command that names one of them anywhere,
// or whose command word cannot be read, keeps every run inside a word a pattern.
const PROGRAM_TEXT_COMMANDS = new Set([
  ...STDIN_PROGRAM_SHELLS, ...STDIN_PROGRAM_INTERPRETERS, ...RUNNERS,
  'eval', 'source', '.', 'fish', 'csh', 'tcsh', 'awk', 'gawk', 'mawk', 'nawk', 'php',
  'watch', 'su', 'runuser', 'script', 'ssh', 'parallel', 'tmux', 'screen', 'make',
]);

function runsProgramText(words) {
  const verbAt = words.findIndex((w) => !ASSIGNMENT_RE.test(w.text));
  if (verbAt < 0) return false;
  if (words[verbAt].opaque) return true;
  return words.slice(verbAt).some((w) => !w.opaque && PROGRAM_TEXT_COMMANDS.has(baseNameOf(w.text)));
}

// SQ-233: commands that make what they read on stdin the operands of a command
// they run. On a line that names one, a heredoc body that is stdin data is a
// list of operands, so each item in it is judged the way an argument word is,
// and a bare `research` names the state directory. Elsewhere a body is text
// the receiver reads, and only the paths it spells name the state (SQ-232).
// SQ-234: `read` is one of them, wherever it stands (`while read f`, `until !
// read f`, after a pipe): a loop hands each item it reads to the commands in
// its body (`while read f; do rm -r "$f"; done`). On such a line what printf
// and echo print is data too. The items are cut from the data as it is written,
// so a command that rewrites the data on its way to the reader (`printf
// notes,research | tr , '\0' | xargs -0 rm -r`, or sed, awk, cut) makes items
// the guard never sees: that transformation is not followed.
const STDIN_OPERAND_COMMANDS = new Set(['xargs', 'parallel', 'read']);

// SQ-234: the short options of those commands that take a value, so a cluster
// is read the way getopt reads it and `-d X`, `-dX` and `-rd X` all find the
// delimiter. A letter in `attached` takes a value only from its own word (GNU
// xargs's `-e`, `-i` and `-l`). parallel is read like xargs.
const ITEM_OPTIONS = new Map([
  ['xargs', { value: 'adEIJLnPRsS', attached: 'eil' }],
  ['parallel', { value: 'adEIJLnPRsS', attached: 'eil' }],
  ['read', { value: 'adinNptu', attached: '' }],
]);

// SQ-234: the commands that print their arguments, so what they print is data.
const PRINTERS = new Set(['printf', 'echo']);

// SQ-234: the text printf prints for a format or a `%b` argument, and echo for
// an argument, as `-e` (and sh's echo) has it: the one-letter escapes, `\NNN` or
// `\0NNN` octal, `\xHH` hex and `\uHHHH`. A NUL, which no file name holds, a
// character this guard uses as a mark, and `\c`, after which nothing more is
// printed, become a newline: each ends an item.
function printedText(text) {
  return text.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|0?[0-7]{1,3}|[\s\S])/g, (all, esc) => {
    if (esc === 'c') return '\n';
    if (esc.length === 1 && Object.prototype.hasOwnProperty.call(ANSI_ESCAPES, esc)) return ANSI_ESCAPES[esc];
    let code;
    if (/^[xuU]./.test(esc)) code = parseInt(esc.slice(1), 16);
    else if (/^[0-7]/.test(esc)) code = parseInt(esc, 8) & 0xff;
    else return all;
    return code > 4 && code <= 0x10ffff ? String.fromCodePoint(code) : '\n';
  });
}

// SQ-234: a printf conversion stands for an argument, which is judged as data
// of its own. The text around it is judged twice, once as if the argument ended
// an item and once as if it were empty, so `research,%s` and `research%s` with
// an empty argument print an item that names the state.
const PRINTF_CONVERSION_RE = /%(?:%|[-+ #0']*(?:\*|[0-9]+)?(?:\.(?:\*|[0-9]*))?[A-Za-z])/g;

function printedTexts(text) {
  const ended = text.replace(PRINTF_CONVERSION_RE, (c) => (c === '%%' ? '%' : '\n'));
  if (ended === text) return [printedText(text)];
  return [printedText(ended), printedText(text.replace(PRINTF_CONVERSION_RE, (c) => (c === '%%' ? '%' : '')))];
}

// SQ-234: the delimiters set by the options of `args[0]`, one of
// STDIN_OPERAND_COMMANDS: `-d X`, `-dX`, `--delimiter=X` and `--delimiter X`.
// read ends an item on the first character of X as it stands (a NUL for an
// empty X, which ends a line here); xargs and parallel take one character, or
// an escape that stands for one. A null is a delimiter the guard cannot read.
function itemDelimiters(args) {
  const name = baseNameOf(args[0].text);
  const { value, attached } = ITEM_OPTIONS.get(name);
  const delimiterOf = (w) => {
    if (!w || w.opaque) return null;
    if (name === 'read') return w.text ? w.text[0] : '\n';
    const ch = printedText(w.text);
    return [...ch].length === 1 ? ch : null;
  };
  const found = [];
  for (let k = 1; k < args.length; k += 1) {
    const { text, opaque } = args[k];
    if (opaque || text === '--' || text === '-' || !text.startsWith('-')) break;
    if (text.startsWith('--')) {
      if (name === 'read') break;
      if (text.startsWith('--delimiter=')) found.push(delimiterOf({ text: text.slice('--delimiter='.length), opaque: false }));
      else if (XARGS_VALUE_FLAGS.has(text)) {
        if (text === '--delimiter') found.push(delimiterOf(args[k + 1]));
        k += 1;
      }
      continue;
    }
    for (let c = 1; c < text.length; c += 1) {
      const rest = text.slice(c + 1);
      if (!value.includes(text[c]) && !(attached.includes(text[c]) && rest)) continue;
      if (text[c] === 'd') found.push(delimiterOf(rest ? { text: rest, opaque: false } : args[k + 1]));
      if (!rest) k += 1;
      break;
    }
  }
  return found;
}

// The items xargs reads from a body by default: blanks and newlines separate
// them, quotes group characters and are dropped, and a backslash takes the next
// character. Each whole trimmed line counts besides, as the item `-d`, `-0`,
// `-L` and `-I` make of it. Neither xargs nor parallel expands a pattern in an
// item, so each is `inert`: it names the state only by spelling it.
// SQ-234: read splits a line on blanks without removing quotes or backslashes
// (`read -r`), or on the IFS characters it is given, and `xargs -d X` splits on
// X and nothing else. So the text is also cut on blanks as it stands, and, where
// the line names delimiters, on them with and without the blanks, each piece
// trimmed. The delimiters are taken together, so a line that names many of them
// costs no more to judge than a line that names one.
function operandWords(text, delimiters) {
  const items = new Set(text.split('\n').map((line) => line.trim()));
  const named = delimiters.join('');
  for (const set of named ? [' \t\n', `\n${named}`, ` \t\n${named}`] : [' \t\n']) {
    const separator = new RegExp(`[${set.replace(/[\\\]^[-]/g, '\\$&')}]`);
    for (const piece of text.split(separator)) items.add(piece.trim());
  }
  let item = null;
  let quote = null;
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (quote) {
      if (ch === quote) quote = null;
      else item += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      item = item || '';
    } else if (ch === '\\') {
      item = (item || '') + (text[k + 1] || '');
      k += 1;
    } else if (/[ \t\n]/.test(ch)) {
      items.add(item);
      item = null;
    } else {
      item = (item || '') + ch;
    }
  }
  items.add(item);
  return [...items].filter(Boolean).map((t) => ({ text: t, opaque: t.includes(EXP_OPEN), quoted: true, inert: true }));
}

// SQ-233: the words an unquoted body is judged as once bash has expanded it.
// Its text stays under the literal rule a quoted body is judged by (SQ-232),
// and every blank-separated token that still carries an expansion the guard
// could not resolve is judged as the opaque word it is, on the names it spells.
// A body whose loop values are too many to compute is one such word (SQ-75).
function expansionWords(body) {
  if (body.uncomputable) return [body];
  const marked = body.text.split(/\s+/).filter((token) => token.includes(EXP_OPEN));
  return [{ text: body.text, opaque: false, quoted: true }, ...marked.map((text) => ({ text, opaque: true, quoted: true }))];
}

// A redirection target built at runtime (`>> "$f.md"`, `>> "$(…)"`) is the
// assemble-the-path family; a bare `> "$LOG"` has no literal path part and is
// left alone.
function assembledTarget(text) {
  const literal = text.replace(EXP_RE, '');
  return literal.includes('/') || /\.[A-Za-z0-9]+$/.test(literal);
}

// A mark with no name is a substitution (or another expansion this guard
// cannot resolve) rather than a variable reference — `"$LOG"` carries a
// name and is excluded, but `"$(date)"` is not.
function hasUnknownSubstitution(text) {
  const matches = text.match(EXP_RE);
  return !!matches && matches.some((m) => m === EXP_UNKNOWN);
}

function flagName(text) {
  const eq = text.indexOf('=');
  return eq < 0 ? text : text.slice(0, eq);
}

// The first word after a wrapper's own assignments and options: the command it
// launches. A word the guard cannot read where the command should stand ends
// the walk, the same way an opaque command name does.
function wrapperCommandAt(args, from) {
  let k = from;
  while (k < args.length) {
    const { text } = args[k];
    if (ASSIGNMENT_RE.test(text)) { k += 1; continue; }
    if (args[k].opaque) return args.length;
    if (text === '--') return k + 1;
    if (text !== '-' && text.startsWith('-')) {
      if (WRAPPER_VALUE_FLAGS.has(flagName(text))) k += 1;
      k += 1;
      continue;
    }
    return k;
  }
  return args.length;
}

// The command a chain of wrappers launches: leading assignments and wrapper
// options are skipped to the command slot (`env -u FOO bash …`). Null when the
// slot holds a word the guard cannot read.
function launchedCommandAt(words) {
  let at = 0;
  for (;;) {
    while (at < words.length && ASSIGNMENT_RE.test(words[at].text)) at += 1;
    if (at >= words.length || words[at].opaque) return null;
    const name = baseNameOf(words[at].text);
    if (!WRAPPERS.has(name)) return { at, name };
    const next = wrapperCommandAt(words, at + 1);
    if (next >= words.length) return null;
    at = next;
  }
}

// True when this simple command reads its program from standard input, so a
// heredoc body it is given is that program rather than data (SQ-67). The program
// is elsewhere only when an inline-program flag carries it: a shell's `-c` family
// (`sh -c PROG`, `bash -ec PROG`) or one of the interpreter spellings above
// (`node -e PROG`, `python3 -c'PROG'`, `node -pe PROG`). SQ-70: an interactive
// flag is not one of them — python's `i` in a boolean cluster and node's `-i` or
// `--interactive` make the interpreter read the body as code once the inline
// program has run, so the body stays the program. Everything else is read
// as the program, which is the fail-closed answer SQ-69 settled on. A bare word
// after the flags may be a script file (`bash script.sh`) or a flag's value
// (`bash -o errexit`, `python3 -W ignore`, `node -r fs`), and telling them apart
// takes a per-interpreter table of value-taking flags that fails open for every
// flag it misses — `errexit` stood where a script file would and the body was
// read as its stdin data. The cost of refusing to guess: `bash script.sh <<EOF`
// whose body names a state write is denied.
function readsProgramFromStdin(words) {
  const launched = launchedCommandAt(words);
  if (!launched) return false;
  const shell = STDIN_PROGRAM_SHELLS.has(launched.name);
  if (!shell && !STDIN_PROGRAM_INTERPRETERS.has(launched.name)) return false;
  // The interpreter's own inline-program spellings (SQ-70). A name without a row
  // keeps the fail-closed reading below: its body is judged as the program.
  const programRe = shell ? null : INTERPRETER_INLINE_PROGRAM_RE.get(launched.name);
  const interactiveRe = shell ? null : INTERPRETER_INTERACTIVE_PROGRAM_RE.get(launched.name);
  let noMoreFlags = false;
  let inline = false;
  for (const w of words.slice(launched.at + 1)) {
    if (w.opaque) return true; // the flags are unreadable: judge the body as the program it may be
    const text = w.text;
    if (!noMoreFlags && text === '--') { noMoreFlags = true; continue; }
    if (!noMoreFlags && text.startsWith('-')) {
      if (shell) {
        if (SHELL_COMMAND_FLAG_RE.test(text)) return false;
        continue;
      }
      const flag = flagName(text);
      // An interactive flag keeps standard input as code beside any inline
      // program, so the body stays the program (SQ-70).
      if (interactiveRe && interactiveRe.test(flag)) return true;
      if (programRe && programRe.test(flag)) {
        // Python read the program out of the next word and then stopped reading
        // options, so a later `-i` is an argument and the body is data.
        if (INTERPRETER_PROGRAM_ENDS_OPTIONS.has(launched.name)) return false;
        inline = true;
      }
    }
  }
  return !inline;
}

// What a program text the lexer cannot read names: 'accept' when the word is in
// there, 'cli' when it names the CLI as a path component or a require target,
// (the session server's script counts as the CLI here), and null when it names
// neither — `node -e 'console.log(1)'` is ordinary work and stays outside the
// harness.
// `choose` (US-3) counts only beside the CLI's name: unlike `accept`, the word
// is common enough in ordinary program text that on its own it names nothing.
function programNames(text) {
  let cli = false;
  let choose = false;
  for (const fragment of text.replace(EXP_RE, ' ').split(FRAGMENT_SPLIT)) {
    if (!fragment) continue;
    if (fragment === 'accept') return 'accept';
    if (fragment === 'choose') choose = true;
    if (!cli) {
      for (const part of fragment.split('/')) {
        if (CLI_NAMES.has(part) || SERVER_NAMES.has(part)) cli = true;
      }
    }
  }
  if (cli && choose) return 'choose';
  return cli ? 'cli' : null;
}

// A program text that reaches the CLI is a harness invocation with a subcommand
// the guard cannot read: `accept` or `choose` where the text says so,
// unreadable otherwise. All are judged as the researcher's act, as
// `placet-research "$SUB"` already is — the guard cannot lex the program, so
// it cannot see the read-only form.
function opaqueProgram(word) {
  const names = programNames(word.text);
  if (!names) return null;
  const sub = names === 'accept' || names === 'choose' ? { text: names, opaque: false } : { text: word.text, opaque: true };
  return { harness: true, sub, rest: [] };
}

// Where the CLI's subcommand stands. The CLI's parseArgs gives a `--name` word
// the next word as its value unless that word starts with `--` too, and
// dispatches on the first word left over, so `placet-research --x status
// accept 1.1` runs accept: skipping the flag alone read it as status (SQ-185).
// A value the guard cannot read may itself start with `--` and leave the word
// after it in the command slot, so that value stands in for the subcommand as
// the unknown it is.
function cliSubAt(args, from) {
  let k = from;
  while (k < args.length && !args[k].opaque && args[k].text.startsWith('-')) {
    const value = args[k + 1];
    if (!args[k].text.startsWith('--') || !value || (!value.opaque && value.text.startsWith('--'))) k += 1;
    else if (value.opaque) return k + 1;
    else k += 2;
  }
  return k;
}

function harnessInvocation(args, depth = 0, splitsBlanks = false) {
  if (!args.length || depth > MAX_SUBSTITUTION_DEPTH) return null;
  if (args[0].opaque) {
    // The command word is assembled at runtime (`$R bin/placet-research.js
    // accept`, `R=$(cat x); $R …`), so the guard cannot read the name it
    // stands for. That is no reason to stop: an unknown wrapper's command
    // slot is walked the way a known wrapper's is (SQ-61). A CLI name or
    // `accept` found there is the invocation it would have been; `$CMD
    // --version` names neither and is left alone.
    const commandAt = wrapperCommandAt(args, 1);
    return commandAt < args.length ? harnessInvocation(args.slice(commandAt), depth + 1, splitsBlanks) : null;
  }
  // An unquoted word only holds blanks when a variable's value put them there,
  // and bash splits that value into words before it runs anything: the program
  // is the first of them. `G="git -C /src/placet-research"; $G add` runs git,
  // with the CLI's name as the directory of its `-C` (SQ-102). Only the default
  // IFS splits on space, tab and newline, so the caller allows the split only
  // when the command never names IFS; otherwise the whole word is read as one
  // name, which errs toward denying (`IFS=:; G="/a b/placet-research.js"`).
  if (splitsBlanks && !args[0].quoted && /[ \t\n]/.test(args[0].text)) {
    const split = args[0].text.split(/[ \t\n]+/).filter(Boolean).map((text) => ({ text, opaque: false, quoted: false }));
    return harnessInvocation([...split, ...args.slice(1)], depth + 1, splitsBlanks);
  }
  const skipFlags = (from) => {
    let k = from;
    while (k < args.length && args[k].text.startsWith('-')) k += 1;
    return k;
  };
  const name = baseNameOf(args[0].text);
  if (SERVER_NAMES.has(name)) return { harness: true, server: true, sub: null, rest: args.slice(1) };
  if (CLI_NAMES.has(name)) {
    const k = cliSubAt(args, 1);
    return { harness: true, sub: k < args.length ? args[k] : null, rest: args.slice(k + 1) };
  }
  if (WRAPPERS.has(name)) {
    const commandAt = wrapperCommandAt(args, 1);
    return commandAt < args.length ? harnessInvocation(args.slice(commandAt), depth + 1, splitsBlanks) : null;
  }
  if (name === 'xargs') {
    let commandAt = 1;
    while (commandAt < args.length) {
      const option = args[commandAt];
      if (option.opaque) return null;
      if (option.text === '--') {
        commandAt += 1;
        break;
      }
      if (option.text === '-' || !option.text.startsWith('-')) break;
      if (XARGS_VALUE_FLAGS.has(option.text)) commandAt += 1;
      commandAt += 1;
    }
    // xargs adds the words it reads from stdin to the command it runs, so the
    // command carries a word the guard never sees: `echo accept 1.1 | xargs
    // placet-research` runs accept, `echo --out f | xargs placet-research
    // agenda` writes f (SQ-185). That word is read as the unknown it is.
    const unseen = { text: EXP_UNKNOWN, opaque: true, quoted: false };
    return commandAt < args.length ? harnessInvocation([...args.slice(commandAt), unseen], depth + 1, splitsBlanks) : null;
  }
  if (name === 'find') {
    const execAt = args.findIndex((w, k) => k > 0 && !w.opaque && (w.text === '-exec' || w.text === '-execdir'));
    if (execAt < 0) return null;
    let end = execAt + 1;
    while (end < args.length && args[end].text !== ';' && args[end].text !== '+') end += 1;
    const action = harnessInvocation(args.slice(execAt + 1, end), depth + 1, splitsBlanks);
    // `find` is not a launcher the way `env` is: it searches, and it can carry
    // more than one action. So the inference reads the action it was given
    // without vouching for the search around it, which keeps `find`'s own
    // refusal for being told to run a command at all.
    return action ? { ...action, action: true } : null;
  }
  if (OPAQUE_SHELLS.has(name)) {
    let k = 1;
    let carries = false;
    while (k < args.length && !args[k].opaque && args[k].text !== '-' && args[k].text.startsWith('-')) {
      if (SHELL_COMMAND_FLAG_RE.test(args[k].text)) carries = true;
      k += 1;
    }
    return carries && k < args.length ? opaqueProgram(args[k]) : null;
  }
  if (name === 'eval') {
    for (const w of args.slice(1)) {
      const program = opaqueProgram(w);
      if (program) return program;
    }
    return null;
  }
  if (!RUNNERS.has(name)) return null;
  const scriptAt = skipFlags(1);
  // `-e`, `--eval` and `-p` turn the word after the flags from a script path
  // into program text, so there is no script name left to recognise.
  const evalFlag = args.slice(1, scriptAt).find((w) => RUNNER_EVAL_FLAGS.has(flagName(w.text)));
  if (evalFlag) {
    const eq = evalFlag.text.indexOf('=');
    const inline = eq < 0 ? null : opaqueProgram({ text: evalFlag.text.slice(eq + 1), opaque: evalFlag.opaque });
    if (inline) return inline;
    return scriptAt < args.length ? opaqueProgram(args[scriptAt]) : null;
  }
  if (scriptAt >= args.length) return null;
  const script = args[scriptAt];
  if (!script.opaque && SERVER_NAMES.has(baseNameOf(script.text))) {
    return { harness: true, server: true, sub: null, rest: args.slice(scriptAt + 1) };
  }
  const subAt = cliSubAt(args, scriptAt + 1);
  return {
    harness: !script.opaque && CLI_NAMES.has(baseNameOf(script.text)),
    sub: subAt < args.length ? args[subAt] : null,
    rest: args.slice(subAt + 1),
  };
}

// What the CLI's `log` subcommand is being asked to write: 'open' for a
// literal DISCOVERY or CONSTRAINT, 'decision' for DECISION or a kind the guard
// cannot read, 'none' when no kind was given at all.
function logKindOf(invocation) {
  const kind = invocation.rest.find((w) => !w.text.startsWith('-'));
  if (!kind) return 'none';
  if (kind.opaque || !CLI_LOG_KINDS.has(kind.text)) return 'decision';
  return 'open';
}

const CLI_SUB_WHY = 'the CLI is being run with a subcommand that is not status, review, init, doctor, install-cli, title, agenda, session protocol, or log';

// 0.5: `agenda` and `session protocol [<n>]` only print; `--out <file>` makes
// either one write that file, and a read that writes a file is a write. They
// pass only as literal words with no flag at all. `--out` is the one flag
// either reads, and any other `--flag` would take the next word as its value
// (cliSubAt), which moves the word the CLI reads as the action:
// `session --x start protocol` starts a session.
function glossaryPrintsOnly(invocation) {
  const [action, id, ...more] = invocation.rest;
  return !!action && !action.opaque && action.text === 'show'
    && !!id && !id.opaque && glossary.ID_RE.test(id.text) && !more.length;
}

function printsOnly(invocation) {
  if (invocation.rest.some((w) => w.opaque || w.text.startsWith('-'))) return false;
  if (invocation.sub.text === 'agenda') return true;
  const [action, seq, ...more] = invocation.rest;
  return !!action && action.text === 'protocol' && (!seq || /^#?\d+$/.test(seq.text)) && !more.length;
}

// ---------- sed scripts ----------
// SQ-145: `sed -n` reads only while the script it runs writes no file and runs
// no command. `w` and `W` write, the `w` flag of `s` writes, GNU's `e` command
// and the `e` flag of `s` run one — but the letter on its own says nothing:
// `sed -n '/Why/,/^$/p' research/canvas.md` and `sed -n 's/w/W/g'` are reads, so
// the script is parsed rather than searched for `w`. A script the parser cannot
// follow — an unknown command or flag, a `-f FILE` whose text lives in a file —
// is not read-only. That verdict is only ever consulted for a command that
// already names the research state (see the `touches && refusal` gate).

// Commands that take no argument of their own...
const SED_SIMPLE_COMMANDS = new Set(['p', 'P', 'd', 'D', 'h', 'H', 'g', 'G', 'x', 'n', 'N', 'q', 'Q', '=', 'l', 'z', 'F', '{', '}']);
// ...the ones whose argument is the rest of their line: the text of `a`/`i`/`c`
// (GNU continues it over a backslash-newline), the target of `r`/`R`, and a
// comment.
const SED_LINE_COMMANDS = new Set(['a', 'i', 'c', 'r', 'R', '#']);
// ...and the ones whose argument is a label. A label ends at `;` or a newline,
// not at the end of the line: `:a;N;$!ba;s/\n/ /g` is the ordinary spelling. GNU
// sed ends it at the `;`, and BSD sed reads the `;` into the label only to fail
// with an undefined label — so ending it here is the stricter reading on both.
// SQ-148: reading a label to the end of the line swallowed the `w` that follows
// the `;`, and `sed -n ':a;w research/canvas.md'` came back a read.
const SED_LABEL_COMMANDS = new Set(['b', 't', 'T', ':']);
const SED_SUBSTITUTION_FLAGS = new Set(['g', 'p', 'i', 'I', 'm', 'M']);
const SED_SHORT_FLAGS = new Set(['n', 'E', 'r', 's', 'u', 'z', 'l', 'a', 'H', 'h', 'V']);
const SED_LONG_FLAGS = new Set(['--quiet', '--silent', '--posix', '--debug', '--sandbox', '--follow-symlinks', '--binary', '--regexp-extended', '--separate', '--unbuffered', '--zero-terminated', '--null-data', '--line-length', '--in-place', '--help', '--version']);
const SED_LONG_VALUE_FLAGS = new Set(['--line-length', '--in-place']);

// The index of the delimiter that closes a delimited body — the pattern or
// replacement of an `s` or `y`, or the regex of an address — with a backslash
// escaping the next character. `at` is where the body starts, just past its
// opening delimiter; `delimiter` is that opening delimiter, passed explicitly
// because the replacement of `s/x/y/` starts on a `y`. A newline inside the
// body ends the script there rather than the body, which is unreadable.
function sedDelimitedEnd(script, at, delimiter) {
  if (!delimiter || delimiter === '\\' || delimiter === '\n') return -1;
  for (let k = at; k < script.length; k += 1) {
    const ch = script[k];
    if (ch === '\\') { k += 1; continue; }
    if (ch === '\n') return -1;
    if (ch === delimiter) return k;
  }
  return -1;
}

// The end of the line that holds the rest of a command's argument, counting a
// backslash at the end of the line as a continuation (GNU sed spells `a text`
// that way, and POSIX `a\` + newline).
function sedLineEnd(script, at) {
  let k = at;
  for (;;) {
    const nl = script.indexOf('\n', k);
    if (nl < 0) return script.length;
    let escapes = 0;
    while (nl - 1 - escapes >= 0 && script[nl - 1 - escapes] === '\\') escapes += 1;
    if (escapes % 2 === 0) return nl;
    k = nl + 1;
  }
}

// The end of a label argument, at the `;` or newline that terminates it. Unlike
// `sedLineEnd` this is not a line: the rest of the line after the label is more
// script, and the `;` that ends the idiom `:a;N;$!ba;s/\n/ /g` is one.
function sedLabelEnd(script, at) {
  for (let k = at; k < script.length; k += 1) {
    if (script[k] === ';' || script[k] === '\n') return k;
  }
  return script.length;
}

// One address at `at`, or -1 when no address starts there: a line number (with
// GNU's `first~step`), `/regex/` or `\cREc` with its `I`/`M` modifiers, `$`.
function sedAddressEnd(script, at) {
  const ch = script[at];
  if (ch === undefined) return -1;
  if (ch === '$') return at + 1;
  if (ch === '/' || ch === '\\') {
    const open = ch === '\\' ? at + 1 : at;
    const close = sedDelimitedEnd(script, open + 1, script[open]);
    if (close < 0) return -1;
    let k = close + 1;
    while (script[k] === 'I' || script[k] === 'M') k += 1;
    return k;
  }
  if (ch >= '0' && ch <= '9') {
    let k = at;
    while (script[k] >= '0' && script[k] <= '9') k += 1;
    if (script[k] === '~') {
      k += 1;
      while (script[k] >= '0' && script[k] <= '9') k += 1;
    }
    return k;
  }
  return -1;
}

// True when the script writes a file or runs a command, false when it does
// neither, null when this parser cannot follow it.
function sedScriptWrites(script) {
  const n = script.length;
  const blank = (ch) => ch === ' ' || ch === '\t' || ch === '\r';
  let i = 0;
  const separators = () => {
    while (i < n && (blank(script[i]) || script[i] === ';' || script[i] === '\n')) i += 1;
  };
  const spaces = () => { while (i < n && blank(script[i])) i += 1; };
  for (separators(); i < n; separators()) {
    if (script[i] === '#') { i = sedLineEnd(script, i + 1); continue; }
    if (script[i] === '}' || script[i] === ';') { i += 1; continue; }
    let far = sedAddressEnd(script, i);
    if (far >= 0) {
      i = far;
      spaces();
      if (script[i] === ',') {
        i += 1;
        spaces();
        far = script[i] === '+' || script[i] === '~' ? sedAddressEnd(script, i + 1) : sedAddressEnd(script, i);
        if (far < 0) return null;
        i = far;
        spaces();
      }
      if (script[i] === '!') { i += 1; spaces(); }
    } else if (script[i] === '!') {
      return null;
    }
    const letter = script[i];
    if (letter === undefined) return null;
    if (letter === 's' || letter === 'y') {
      const delimiter = script[i + 1];
      const pattern = sedDelimitedEnd(script, i + 2, delimiter);
      if (pattern < 0) return null;
      const replacement = sedDelimitedEnd(script, pattern + 1, delimiter);
      if (replacement < 0) return null;
      i = replacement + 1;
      if (letter === 'y') continue;
      for (;;) {
        const flag = script[i];
        if (flag === undefined || blank(flag) || flag === ';' || flag === '\n') break;
        if (SED_SUBSTITUTION_FLAGS.has(flag)) { i += 1; continue; }
        if (flag >= '0' && flag <= '9') { while (script[i] >= '0' && script[i] <= '9') i += 1; continue; }
        // `s///w FILE` writes that file, GNU's `s///e` runs the result.
        if (flag === 'w' || flag === 'e') return true;
        return null;
      }
      continue;
    }
    if (letter === 'w' || letter === 'W' || letter === 'e') return true;
    if (SED_SIMPLE_COMMANDS.has(letter)) {
      i += 1;
      if (letter === 'q' || letter === 'Q' || letter === 'l') {
        while (script[i] >= '0' && script[i] <= '9') i += 1;
      }
      continue;
    }
    if (SED_LABEL_COMMANDS.has(letter)) { i = sedLabelEnd(script, i + 1); continue; }
    if (SED_LINE_COMMANDS.has(letter)) { i = sedLineEnd(script, i + 1); continue; }
    return null;
  }
  return false;
}

// The script operands sed would run: every `-e`/`--expression` argument, or the
// first operand when the script is given as one. null when the guard cannot
// read them — a `-f`/`--file` script is a file, and an unknown flag could be one
// that takes the next word as its argument.
function sedScriptOperands(flags) {
  const scripts = [];
  let scripted = false;
  let ended = false;
  for (let k = 0; k < flags.length; k += 1) {
    const w = flags[k];
    if (w.opaque) return null;
    const text = w.text;
    if (!ended && text === '--') { ended = true; continue; }
    if (!ended && text.startsWith('--')) {
      const eq = text.indexOf('=');
      const name = eq < 0 ? text : text.slice(0, eq);
      const value = eq < 0 ? null : text.slice(eq + 1);
      if (name === '--expression' || name === '--file') {
        if (name === '--file') return null;
        const next = value === null ? flags[k + 1] : { text: value, opaque: false };
        if (!next || next.opaque) return null;
        scripts.push(next.text);
        scripted = true;
        if (value === null) k += 1;
        continue;
      }
      if (!SED_LONG_FLAGS.has(name) || (value !== null && !SED_LONG_VALUE_FLAGS.has(name))) return null;
      continue;
    }
    if (!ended && text.length > 1 && text[0] === '-') {
      for (let c = 1; c < text.length; c += 1) {
        const letter = text[c];
        if (letter === 'e' || letter === 'f') {
          if (letter === 'f') return null;
          const rest = text.slice(c + 1);
          if (rest) scripts.push(rest);
          else {
            const next = flags[k + 1];
            if (!next || next.opaque) return null;
            scripts.push(next.text);
            k += 1;
          }
          scripted = true;
          break;
        }
        if (!SED_SHORT_FLAGS.has(letter)) return null;
      }
      continue;
    }
    // An operand. Without a `-e` before it, the first one is the script; the
    // rest are files it reads.
    if (!scripted) { scripts.push(text); scripted = true; }
  }
  return scripts;
}

// The reason a `sed -n` that names the state is still not read-only, or null.
function sedRefusal(flags) {
  const scripts = sedScriptOperands(flags);
  if (scripts === null) return '`sed` reads its script from a file or from a flag this guard cannot name';
  for (const script of scripts) {
    const writes = sedScriptWrites(script);
    if (writes === null) return 'this guard cannot read the sed script, so it cannot tell whether it writes';
    if (writes) return 'the sed script writes a file or runs a command';
  }
  return null;
}

// Returns null when the simple command is a named read-only form, or the
// reason it is not.
function readOnlyRefusal(sc, args, base, stateParts, stateNames, hasState, splitsBlanks, stateRoot) {
  for (const redirect of sc.redirects) {
    if (!redirect.write) continue;
    // SQ-106: a loop counts as read-only only when nothing in it writes, so a
    // redirect that writes anywhere but /dev/null holds the whole loop.
    if (sc.inLoop && !(redirect.target && !redirect.target.opaque && redirect.target.text === '/dev/null')) {
      return 'a loop that writes through a redirect is not read-only';
    }
    if (!redirect.target) return 'it redirects into a path assembled at runtime';
    for (const target of redirect.targets || [redirect.target]) {
      if (target.opaque) return 'it redirects into a path assembled at runtime';
      if (base === null && !target.text.startsWith('/')) return 'it redirects into a relative path after a `cd` this guard cannot follow';
      const touches = wordTouchesState(target, base, stateParts, stateNames, hasState, false, stateRoot);
      if (touches === null) return UNCOMPUTABLE_PATTERN_WHY;
      if (touches) return 'it redirects into the research state';
    }
  }
  if (!args.length || sc.loopKeyword) return null;
  // SQ-106: `read` in a `while`/`until` condition sets a shell variable from
  // stdin and writes no file. It is not added to READ_ONLY: only this position
  // lets it through.
  if (sc.loopCondition && !args[0].opaque && args[0].text === 'read') return null;
  // SQ-67: a shell reading its program from this heredoc is a launcher, not a
  // verb of its own (an interpreter's body is program text instead, SQ-101). The body was lexed as the script it is, so
  // what runs is judged as commands in their own right — `cat research/canvas.md`
  // under it still reads. Its own redirects were checked above.
  if (sc.stdinProgram) return null;
  const invocation = harnessInvocation(args, 0, splitsBlanks);
  if (invocation && invocation.harness && !invocation.action) {
    if (invocation.server) return 'it starts the session server, which only the researcher starts';
    if (!invocation.sub) return null;
    if (invocation.sub.opaque) return CLI_SUB_WHY;
    if (invocation.sub.text === 'log') {
      return logKindOf(invocation) === 'open' ? null : 'the CLI\'s log command takes DISCOVERY or CONSTRAINT as a literal word';
    }
    if (invocation.sub.text === 'glossary') return glossaryPrintsOnly(invocation) ? null : CLI_SUB_WHY;
    if (invocation.sub.text === 'agenda' || invocation.sub.text === 'session') return printsOnly(invocation) ? null : CLI_SUB_WHY;
    return CLI_READ_SUBS.has(invocation.sub.text) ? null : CLI_SUB_WHY;
  }
  if (args[0].opaque) return 'the command name is assembled at runtime';
  const verb = baseNameOf(args[0].text);
  if (!READ_ONLY.has(verb)) return `\`${verb}\` is not a read-only command`;
  const flags = args.slice(1);
  const hasFlag = (re) => flags.some((w) => re.test(w.text));
  if (hasFlag(WRITE_FLAG_RE)) return `\`${verb}\` was given a flag that writes a file`;
  if (verb === 'sed') {
    const quiet = hasFlag(/^-[A-Za-z]*n/) || flags.some((w) => w.text === '--quiet' || w.text === '--silent');
    if (!quiet) return '`sed` only reads with -n';
    if (hasFlag(/^-[A-Za-z]*i/) || flags.some((w) => w.text === '--in-place')) return '`sed -i` edits in place';
    const script = sedRefusal(flags);
    if (script) return script;
  }
  if (verb === 'sort' && hasFlag(/^-o/)) return '`sort -o` writes a file';
  // SQ-145: probed in a temp dir, `less -o FILE`, `-O FILE` and `--log-file=FILE`
  // copy the input into FILE as it is viewed. They only do so when the input is
  // a pipe and the output a terminal — a file operand or a piped stdout writes
  // nothing today — but which shape the shell will hand `less` is not this
  // guard's to know, so the flags are refused the way `sort -o` is.
  if (verb === 'less' && (hasFlag(/^-[A-Za-z]*[oO]/) || flags.some((w) => /^--(?:log-file|LOG-FILE)(?:=|$)/.test(w.text)))) {
    return '`less -o`, `-O` or `--log-file` writes a file';
  }
  if (verb === 'uniq' && flags.filter((w) => !w.text.startsWith('-')).length > 1) return '`uniq` with two operands writes the second';
  if (verb === 'find' && hasFlag(/^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/)) return '`find` was given an action that writes or runs a command';
  if (verb === 'git') {
    const sub = flags.find((w) => !w.text.startsWith('-'));
    if (!sub || sub.opaque || !GIT_READ_ONLY.has(sub.text)) return 'this is not a read-only git subcommand';
  }
  return null;
}

function bashDenial(why) {
  return `Only read-only shell access to the research state is allowed, and ${why}. Reads that pass: cat, grep, sed -n, git diff/log/show/status, placet-research status/review/init, and placet-research log DISCOVERY|CONSTRAINT to record a finding. Use the Edit tool for [proposed] and [tentative] statements; acceptance is the researcher's act via /placet-research:accept.`;
}

// SQ-29 F5. A `*` or `?` word whose character class the engine refuses is a
// pattern the guard cannot compute, so whether it reaches the research state is
// unknown — neither a match nor a miss. It is denied where there is a write to
// refuse, the way an unreadable command line is: under a read-only verb the same
// word is read as the name it spells.
const UNCOMPUTABLE_PATTERN_WHY = 'it carries a pattern this guard cannot compute, so whether it reaches the research state is unknown';

// Acceptance is the researcher's act wherever it is invoked from: running it
// from the shell would be the model declaring a commitment (§4.3).
const ACCEPT_DENIAL = 'Accepting a statement is the researcher\'s act, so `placet-research accept` cannot be run from the shell — under any name, quoting, or variable. Leave the statement as it stands and ask the researcher for /placet-research:accept <n.m> --explained "<your sentence>".';
// SQ-203: accepting a glossary entry is the researcher's act for the same
// reason (§ Authorization and text binding), found on the same routes.
const GLOSSARY_DENIAL = 'Accepting a glossary entry is the researcher\'s act, so `placet-research glossary accept` cannot be run from the shell — under any name, quoting, or variable. Leave the entry as [proposed] and ask the researcher for /placet-research:glossary-accept <id> --explained "<your sentence>".';
// SQ-146. A subcommand the guard cannot read — a word built at run time
// (`placet-research "$SUB"`) or a program text that only names the CLI — is
// judged as strictly as `accept` is, because it may be one. The verdict stays
// the same; the text says what the guard actually knows, rather than naming a
// subcommand it never read.
const OPAQUE_SUB_DENIAL = 'This command may run placet-research with a subcommand this guard cannot read (built at run time, or inside program text), so it is denied the way `accept` is. Spell the subcommand out, e.g. `placet-research status`. If the text only mentions the name, pass it as data, e.g. printf it into a file and run the file. Acceptance stays the researcher\'s act via /placet-research:accept <n.m> --explained "<your sentence>".';
// US-3: choosing a framing replaces the main canvas with one variant's and
// seals a DECISION, so it is the researcher's act exactly as accepting is, and
// it is found on the same routes and by the same name rule.
const CHOOSE_DENIAL = 'Choosing a framing is the researcher\'s act, so `placet-research choose` cannot be run from the shell — under any name, quoting, or variable. Compare the variants with `placet-research status --variant <name>` and `placet-research review --variant <name>`, and ask the researcher to choose one.';
const LOG_DECISION_DENIAL = 'A DECISION entry is the researcher\'s act, so `placet-research log DECISION` cannot be run from the shell — nor `log` with a kind the guard cannot read. Record a finding with `placet-research log DISCOVERY|CONSTRAINT <ref> --body "<text>"`, and ask the researcher for /placet-research:accept <n.m> --explained "<your sentence>".';
// The CLI reads its configuration from the session. A command line that hands
// it another home, state directory or project would make it seal with a key
// of the model's choosing, and the researcher's ledger would then read as
// broken at that entry.
const ENV_DENIAL = 'placet-research cannot be run with its own environment set on the command line (`NAME=value placet-research …`): it reads its configuration from the session, and a changed home or state directory would seal the decision log with the wrong key. Run the command without the assignment.';
// The harness state directory holds the sealing key of the decision log
// (§4.7). A key the model can read or replace seals nothing, and nothing in
// that directory is part of the paper.
function harnessStateDenial(label) {
  return `placet-research cannot let ${label} touch the harness state directory (${ledger.stateRoot()}): it holds the sealing key of the decision log, and a key the model can read or replace seals nothing. Nothing there is part of the paper; read the research state with Read, cat or grep instead.`;
}

function keyFileDenial(label) {
  return `placet-research cannot let ${label} touch a file whose name ends in .seal.key: that is an exported sealing key (placet-research key export), and a key the model can read, copy or replace seals nothing. Carrying it to a second clone is the person's step: placet-research join --key-file <file> --name "<name>" in their own terminal.`;
}

// The research state is the canvas and the decision log. A state directory that
// holds neither — `mkdir research` on its own — is not state: there is nothing
// there to read and nothing to promote, so the read-only rule has nothing to
// refuse (SQ-71).
// US-3: a variant's canvas or log is research state as much as the main pair.
function statePresent(stateDir) {
  if (fs.existsSync(path.join(stateDir, project.CANVAS_FILE))
    || fs.existsSync(path.join(stateDir, project.DECISIONS_FILE))) return true;
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(stateDir, project.VARIANTS_DIR));
  } catch (_) {
    return false;
  }
  return entries.some((name) => fs.existsSync(path.join(stateDir, project.VARIANTS_DIR, name, project.CANVAS_FILE))
    || fs.existsSync(path.join(stateDir, project.VARIANTS_DIR, name, project.DECISIONS_FILE)));
}

// SQ-99: a backstop next to the wrapper and opaque-program routes. Whatever
// wraps it — an unlisted wrapper, another interpreter's inline program, a
// terminal launcher — a line whose text names the CLI together with one of its
// two write verbs, or names the server script, reaches them. Quotes, escapes
// and empty quote pairs are dropped first, so `placet-resea''rch` reads as the
// name the shell makes of it. A name built at run time is not seen (spec §5.3).
// US-3 adds `choose`, the researcher's other act on the record.
const NAMED_WRITE_VERBS = new Set(['accept', 'choose', 'serve', 'glossary']);
const NAME_SPLIT = /[^A-Za-z0-9._\-/~+@:]+/;

function namedWrite(text) {
  const fragments = text.replace(/\$(?:''|"")/g, '').replace(/[\\'"`]/g, '').split(NAME_SPLIT);
  const names = fragments.map((f) => f.split('/').filter(Boolean).pop() || '');
  if (names.some((n) => SERVER_NAMES.has(n))) return 'serve';
  if (!names.some((n) => CLI_NAMES.has(n))) return null;
  for (const verb of NAMED_WRITE_VERBS) if (fragments.includes(verb)) return verb;
  return null;
}

// SQ-105: the program text an interpreter takes on its command line —
// `python3 -c PROG`, `python3 -Ic PROG`, `perl -e'PROG'`, `ruby -ne PROG`,
// `node -e PROG` — found with the same per-interpreter spellings that decide
// whether a heredoc body is the program (SQ-70).
function inlinePrograms(words) {
  const launched = launchedCommandAt(words);
  const programRe = launched && INTERPRETER_INLINE_PROGRAM_RE.get(launched.name);
  if (!programRe) return [];
  const programs = [];
  const args = words.slice(launched.at + 1);
  for (let k = 0; k < args.length; k += 1) {
    const { text } = args[k];
    if (text === '--') break;
    const match = text.startsWith('-') ? programRe.exec(flagName(text)) : null;
    if (!match) continue;
    const attached = text.slice(match[0].length).replace(/^=/, '');
    if (attached) programs.push(attached);
    else if (k + 1 < args.length) programs.push(args[k + 1].text);
  }
  return programs.map((text) => text.replace(EXP_RE, ' '));
}

const NAMED_SERVER_WHY ='it names the session server (`placet-research serve` or canvas-serve), which only the researcher starts, and not every command in it is read-only';

function bashVerdict(command, projectRoot) {
  const cmd = String(command || '');
  if (!cmd.trim()) return null;
  const root = projectRoot || project.projectDir({});
  const stateDir = project.stateDir(root);
  const stateRoot = canonical(stateDir, 0);
  const stateParts = stateDir.split(path.sep).filter(Boolean);
  const stateNames = new Set([project.CANVAS_FILE, project.DECISIONS_FILE, project.GLOSSARY_FILE, path.basename(stateDir)]);
  // SQ-71: state that is not there cannot be touched. A word the guard cannot
  // read — an unknown substitution, a pattern it cannot compute, a `cd` it
  // cannot follow — is speculation about where the state might be, and in a
  // project that holds no research state there is nowhere for it to land. Only
  // a word that spells the state's location is judged, as SQ-65 already has it.
  const hasState = statePresent(stateDir);
  // SQ-102: a command that names IFS anywhere (an assignment, `export`,
  // `read`, a subshell) may change how bash splits a variable's value.
  const splitsBlanks = !/\bIFS\b/.test(cmd);

  let commands = null;
  if (cmd.length <= MAX_COMMAND_LENGTH) {
    try {
      commands = lexBash(cmd, 0);
    } catch (_) {
      commands = null;
    }
  }
  // A body past MAX_SUBSTITUTION_DEPTH leaves every nesting below it unread, so
  // the words above it stand for commands the guard never saw (SQ-29 F7): the
  // line is unreadable in full, not a line it read and judged harmless.
  const tooDeep = !!commands && commands.some((sc) => sc.unreadable);
  if (!commands || tooDeep) {
    // Unreadable is not the same as harmless: judge it if it names the state.
    const names = [...stateNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (!new RegExp(`${names}|placet-research`).test(cmd) && !/\.seal\.key/i.test(cmd)) return null;
    const cause = tooDeep ? `: its command substitutions nest past the ${MAX_SUBSTITUTION_DEPTH}-deep limit` : '';
    return `placet-research could not read this shell command well enough to judge it${cause}, and it names the research state or a .seal.key file, so it is denied. Split it into separate, simpler commands, or use the Edit tool.`;
  }

  const values = new Map();
  const loops = new Map();
  const harness = harnessRoot();
  const links = new Map();
  let base = root;
  let touches = false;
  let uncomputable = false;
  let acceptAttempt = false;
  let glossaryAttempt = false;
  let opaqueSubAttempt = false;
  let chooseAttempt = false;
  let serveAttempt = false;
  let decisionAttempt = false;
  let envAttempt = false;
  let refusal = null;
  let allReadOnly = true;
  let loopDepth = 0;
  // SQ-233: whether the line runs xargs or parallel, and each data body's text
  // with the directory it is read from, judged as operands once the whole line
  // is known (`cat <<EOF | xargs rm` names xargs after the body's command).
  // SQ-234: or read, with the delimiters those commands and IFS set, null for
  // one the guard cannot read; printf and echo arguments are data texts too.
  let operands = false;
  let reads = false;
  const dataTexts = [];
  const delimiters = [];
  const ifsValues = [];

  for (const sc of commands) {
    // SQ-106: a loop is read by its parts. The lexer hands `for f in W; do
    // head "$f"; done` over as `for f in W`, `do head "$f"` and `done`, so the
    // keywords are taken off the front of each command and what follows is
    // judged as the command it is. The header and a lone `done` do nothing of
    // their own; a body command that is not read-only still refuses, and so a
    // loop is read-only only when every command in it is.
    while (sc.words.length && !sc.words[0].quoted && LOOP_OPENERS.has(sc.words[0].text)) {
      const keyword = sc.words.shift().text;
      sc.keywordStripped = true;
      sc.loopCondition = keyword !== 'do';
      if (sc.loopCondition) loopDepth += 1;
    }
    const lead = sc.words[0];
    if (lead && !lead.quoted && lead.text === 'for') {
      loopDepth += 1;
      sc.loopKeyword = true;
    } else if (lead && !lead.quoted && lead.text === 'done' && sc.words.length === 1) {
      sc.loopKeyword = true;
    }
    sc.inLoop = loopDepth > 0;
    if (sc.loopKeyword && lead.text === 'done') loopDepth = Math.max(0, loopDepth - 1);
    for (const w of sc.words) substitute(w, values);
    for (const redirect of sc.redirects) if (redirect.target) substitute(redirect.target, values);
    // SQ-75: each word becomes the words bash makes of it. Leading assignments
    // are not brace-expanded; a redirect target keeps every form it can take,
    // and each is judged.
    const leading = sc.words.findIndex((w) => !ASSIGNMENT_RE.test(w.text));
    const cut = leading < 0 ? sc.words.length : leading;
    sc.words = [...sc.words.slice(0, cut), ...sc.words.slice(cut).flatMap((w) => expandWord(w, loops))];
    for (const redirect of sc.redirects) {
      redirect.targets = redirect.target && !redirect.heredoc ? expandWord(redirect.target, loops) : [];
    }
    // `for NAME in W…` over literal words sets NAME to each of them in turn, so a
    // word that uses it is judged once per value. A loop over anything the
    // guard cannot read leaves NAME unknown, as it was.
    const [loopVerb, loopName, loopIn, ...loopWords] = sc.words;
    if (loopVerb && !loopVerb.opaque && loopVerb.text === 'for' && loopName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(loopName.text)) {
      values.delete(loopName.text);
      loops.delete(loopName.text);
      // SQ-86: the body can rebind NAME (`do f=…`, `export f=…`, `read f`,
      // `printf -v f …`), and `$f` is then no longer a loop value. Any later
      // word that is NAME or assigns to it leaves NAME unknown for the line.
      const name = loopName.text;
      const rebound = commands.slice(commands.indexOf(sc) + 1).some((later) =>
        later.words.some((w) => w.text === name || w.text.startsWith(`${name}=`) || w.text.startsWith(`${name}+=`)));
      if (!rebound && loopIn && loopIn.text === 'in' && !loopIn.opaque && loopWords.every((w) => !w.opaque)) {
        loops.set(name, loopWords.map((w) => w.text));
      }
    }
    for (const w of sc.words) {
      const assignment = ASSIGNMENT_RE.exec(w.text);
      if (!assignment) break;
      loops.delete(assignment[1]);
      // A value the guard resolved to literal text is recorded. One that still
      // carries an unresolved substitution is recorded too, as the unknown it
      // is: `x=$(cat p.txt)` makes `$x` an unknown target, not a name the guard
      // may read past (SQ-61). A value that is only other variables (`x=$y`) is
      // left unrecorded, unchanged: the substitution is what makes the value
      // unknowable here.
      if (!assignment[2].includes(EXP_OPEN) || assignment[2].includes(EXP_UNKNOWN)) values.set(assignment[1], assignment[2]);
    }

    // The harness state directory admits no form at all, read-only or not.
    for (const w of sc.words) {
      if (wordTouchesHarness(w, base, harness, links)) return harnessStateDenial('this shell command');
    }
    for (const redirect of sc.redirects) {
      // A heredoc body left unread is judged the way an opaque word is: on the
      // literal names it still spells out.
      if (redirect.unreadBody && wordTouchesHarness(redirect.unreadBody, base, harness, links)) return harnessStateDenial('this shell command');
      if (redirect.targets.some((target) => wordTouchesHarness(target, base, harness, links))) return harnessStateDenial('this shell command');
    }
    // So does an exported key file, wherever it lies (spec §7).
    const programText = runsProgramText(sc.words);
    for (const w of sc.words) {
      if (wordNamesKeyFile(w, base, links, programText)) return keyFileDenial('this shell command');
    }
    for (const redirect of sc.redirects) {
      if (redirect.unreadBody && wordNamesKeyFile(redirect.unreadBody, base, links, true)) return keyFileDenial('this shell command');
      if (redirect.targets.some((target) => wordNamesKeyFile(target, base, links, false))) return keyFileDenial('this shell command');
    }

    // Leading `NAME=value` words are assignments, not the command.
    const verbAt = sc.words.findIndex((w) => !ASSIGNMENT_RE.test(w.text));
    const argv = verbAt < 0 ? [] : sc.words.slice(verbAt);
    for (let k = 0; k < argv.length; k += 1) {
      if (argv[k].opaque || !STDIN_OPERAND_COMMANDS.has(baseNameOf(argv[k].text))) continue;
      operands = true;
      if (baseNameOf(argv[k].text) === 'read') reads = true;
      delimiters.push(...itemDelimiters(argv.slice(k)));
    }
    for (const w of sc.words) {
      const ifs = /^IFS\+?=([\s\S]*)$/.exec(w.text);
      if (ifs) ifsValues.push(w.opaque ? null : ifs[1]);
    }
    const printer = argv.findIndex((w) => !w.opaque && PRINTERS.has(baseNameOf(w.text)));
    if (printer >= 0) {
      for (const w of argv.slice(printer + 1)) for (const text of printedTexts(w.text)) dataTexts.push({ text, at: base });
    }

    // SQ-71: only a project that holds state can have its state touched. Where
    // there is none, an unfollowable `cd`, an operand the guard cannot read and
    // a word whose expansion is unknown are speculation with nowhere to land.
    // A word that spells the state's location is still judged (SQ-65).
    const touched = (verdict) => verdict === true || (verdict !== false && hasState);
    if (base === null && hasState) touches = true;
    const inertText = !runsProgramText(sc.words);
    for (const w of sc.words) {
      const verdict = wordTouchesState(w, base, stateParts, stateNames, hasState, inertText, stateRoot);
      if (verdict === null && hasState) uncomputable = true;
      else if (verdict) touches = true;
    }
    for (const redirect of sc.redirects) {
      if (redirect.unreadBody && wordTouchesState(redirect.unreadBody, base, stateParts, stateNames, hasState, false, stateRoot)) touches = true;
      // SQ-232: a heredoc body that is stdin data counts the way an inert word
      // of a read-only verb does: its slash-bearing runs name the state only by
      // spelling it, since bash never globs a body. Only a line that also runs a
      // command that is not read-only is refused for it.
      if (redirect.dataBody) {
        const verdict = wordTouchesState(redirect.dataBody, base, stateParts, stateNames, hasState, true, stateRoot);
        if (verdict === null && hasState) uncomputable = true;
        else if (verdict) touches = true;
        // SQ-233: an unquoted body is also judged as the text bash expands it
        // to, with the values this line assigned (a prefix assignment included,
        // as bash expands the body after it) and one text per loop value.
        let bodies = [redirect.dataBody];
        const { expanded } = redirect.dataBody;
        if (expanded) {
          substitute(expanded, values);
          bodies = expandWord(expanded, loops);
          for (const body of bodies.flatMap(expansionWords)) {
            const found = wordTouchesState(body, base, stateParts, stateNames, hasState, true, stateRoot);
            if (found === null && hasState) uncomputable = true;
            else if (found) touches = true;
          }
        }
        for (const body of bodies) dataTexts.push({ text: body.text, at: base });
      }
      // A redirect target is a write position, so a pattern there the guard
      // cannot compute counts as touching: `readOnlyRefusal` below supplies the
      // reason.
      for (const target of redirect.targets) {
        if (touched(wordTouchesState(target, base, stateParts, stateNames, hasState, false, stateRoot))) touches = true;
        if (hasState && redirect.write && target.opaque && (assembledTarget(target.text) || hasUnknownSubstitution(target.text))) touches = true;
      }
    }
    // A word in argument position that is wholly or partly the output of a
    // command substitution the guard could not resolve to a literal is an
    // unknown target: `readOnlyRefusal` below still allows it through when
    // the command is read-only, but a non-read-only command with such an
    // argument is denied rather than silently let through (SQ-57). A verb
    // whose operand is never a file it writes is the exception (SQ-68): the
    // argument is a value, not a landing place for the state.
    const verbName = argv.length && !argv[0].opaque ? baseNameOf(argv[0].text) : null;
    if (!NON_FILE_VERBS.has(verbName)) {
      for (const w of argv.slice(1)) {
        if (hasState && hasUnknownSubstitution(w.text)) touches = true;
      }
    }
    // SQ-106: a loop that is not read-only keeps the verdict it had before the
    // keywords were taken off. Then every word after `do`, `while` or `until`
    // was an operand of that keyword, so an unknown value anywhere in the
    // command counted as a target. It decides nothing when the loop only reads.
    if (hasState && sc.keywordStripped && sc.words.some((w) => hasUnknownSubstitution(w.text))) touches = true;

    const invocation = harnessInvocation(argv, 0, splitsBlanks);
    if (invocation) {
      if (invocation.harness) touches = true;
      if (invocation.harness && verbAt > 0) envAttempt = true;
      if (invocation.sub && !invocation.sub.opaque && invocation.sub.text === 'accept') acceptAttempt = true;
      else if (invocation.sub && !invocation.sub.opaque && invocation.sub.text === 'glossary' && !glossaryPrintsOnly(invocation)) glossaryAttempt = true;
      else if (invocation.sub && !invocation.sub.opaque && invocation.sub.text === 'choose') chooseAttempt = true;
      else if (invocation.harness && invocation.sub && invocation.sub.opaque) opaqueSubAttempt = true;
      else if (invocation.harness && invocation.sub && invocation.sub.text === 'log' && logKindOf(invocation) === 'decision') decisionAttempt = true;
    }
    // SQ-105: an interpreter's own program text — an inline program or a heredoc
    // body it reads as its program — is held to the SQ-99 named-write test in
    // every project, as `node -e` already is to the opaque-program route: a line
    // can create the state and accept into it in one call, so no state yet is no
    // reason to let it through.
    const programs = [
      ...inlinePrograms(argv),
      ...sc.redirects.filter((r) => r.unreadBody && r.unreadBody.program).map((r) => r.unreadBody.text),
    ];
    for (const text of programs) {
      const named = namedWrite(text);
      if (named === 'accept') acceptAttempt = true;
      else if (named === 'glossary') glossaryAttempt = true;
      else if (named === 'choose') chooseAttempt = true;
      else if (named === 'serve') serveAttempt = true;
    }

    const scRefusal = readOnlyRefusal(sc, argv, base, stateParts, stateNames, hasState, splitsBlanks, stateRoot);
    if (!refusal) refusal = scRefusal;
    // A launcher reading its program from a heredoc is not a read-only verb here:
    // a body in another language was never lexed into commands of its own.
    if (scRefusal || sc.stdinProgram) allReadOnly = false;

    if (argv.length && !argv[0].opaque && baseNameOf(argv[0].text) === 'cd') {
      const operand = argv.slice(1).find((w) => !w.text.startsWith('-'));
      base = !operand || operand.opaque || operand.text === '-' || base === null
        ? null
        : path.resolve(base, operand.text);
    }
    // A link this statement made is visible to the words that follow it, in
    // this statement and any later one in the same command (M9b: `ln -sfn .
    // h && cat h/…`) — the same reason `cd` above keeps mutating `base`.
    trackSymlink(argv, base, links);
  }
  // SQ-234: IFS splits what read reads, and only that. A delimiter the guard
  // cannot read leaves the items of every data text unknown, which is judged as
  // a pattern it cannot compute is: refused where state exists.
  if (reads) for (const value of ifsValues) delimiters.push(...(value === null ? [null] : value));
  if (operands && delimiters.includes(null) && hasState && dataTexts.some(({ text }) => text.trim())) uncomputable = true;
  const known = [...new Set(delimiters.filter((d) => d !== null))];
  if (operands && dataTexts.some(({ text, at }) => operandWords(text, known)
    .some((w) => wordTouchesState(w, at, stateParts, stateNames, hasState, true, stateRoot)))) touches = true;

  if (acceptAttempt) return ACCEPT_DENIAL;
  if (glossaryAttempt) return GLOSSARY_DENIAL;
  if (opaqueSubAttempt) return OPAQUE_SUB_DENIAL;
  if (chooseAttempt) return CHOOSE_DENIAL;
  if (serveAttempt) return bashDenial(NAMED_SERVER_WHY);
  if (decisionAttempt) return LOG_DECISION_DENIAL;
  if (envAttempt) return ENV_DENIAL;
  if (uncomputable && refusal) return bashDenial(UNCOMPUTABLE_PATTERN_WHY);
  if (touches && refusal) return bashDenial(refusal);
  if (hasState && !allReadOnly) {
    const named = namedWrite(cmd);
    if (named === 'accept') return ACCEPT_DENIAL;
    if (named === 'glossary') return GLOSSARY_DENIAL;
    if (named === 'choose') return CHOOSE_DENIAL;
    if (named === 'serve') return bashDenial(NAMED_SERVER_WHY);
  }
  return null;
}

// ---------- path resolution ----------

// Two names reach the same file more often than they look alike: a case
// variant on a case-insensitive volume, a symlinked file, a symlinked parent
// directory, a hard link. Comparing the strings the model typed judges the
// spelling; the guard has to judge the file (§5.3).

const MAX_LINK_HOPS = 32;

function readLink(file) {
  try {
    return fs.readlinkSync(file);
  } catch (_) {
    return null;
  }
}

// What the filesystem calls this path. `realpathSync.native` is libc's
// realpath: it follows symlinks and hands back the spelling that is on disk,
// which is how a case variant is caught without asking the platform what kind
// of volume this is. It needs every component to exist, so a leaf that is not
// there yet — creating the canvas is legitimate — is canonicalised through its
// parent, and a dangling symlink through what it points at.
function canonical(target, hops) {
  const full = path.resolve(target);
  try {
    return fs.realpathSync.native(full);
  } catch (err) {
    // ELOOP, or a parent this process may not traverse: nothing further can be
    // resolved, and the path as written is the best answer there is.
    if (!err || err.code !== 'ENOENT') return full;
  }
  const link = hops < MAX_LINK_HOPS ? readLink(full) : null;
  if (link !== null) return canonical(path.resolve(path.dirname(full), link), hops + 1);
  const parent = path.dirname(full);
  return parent === full ? full : path.join(canonical(parent, hops), path.basename(full));
}

function flipCase(name) {
  return name.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
}

// Case sensitivity belongs to the volume, not to the platform, so ask the
// filesystem rather than process.platform: a directory on a case-insensitive
// volume answers to a flipped spelling of its own name. This only decides
// paths that do not exist yet — realpath has already settled the ones that do.
function caseBlind(dir) {
  let at = path.resolve(dir);
  for (;;) {
    const name = path.basename(at);
    const flipped = flipCase(name);
    if (flipped !== name) {
      try {
        return fs.realpathSync.native(path.join(path.dirname(at), flipped)) === fs.realpathSync.native(at);
      } catch (_) {
        return false;
      }
    }
    const parent = path.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
}

function samePath(a, b) {
  return a === b || (a.toLowerCase() === b.toLowerCase() && caseBlind(path.dirname(a)));
}

// Device and inode: one file, however many names lead to it. This is what
// catches a hard link, which realpath cannot — a hard link is not a reference
// to a name, it is a second name for the same file.
function identity(file) {
  try {
    const s = fs.statSync(file);
    return `${s.dev}:${s.ino}`;
  } catch (_) {
    return null;
  }
}

// ---------- what a path leads to ----------

// Where a write to this path would land, under every name the filesystem
// answers to: the resolved path, its canonical spelling, and its identity.
function landingOf(projectRoot, raw) {
  const written = path.resolve(projectRoot, raw);
  return { writtenPath: written, canonicalPath: canonical(written, 0), id: identity(written) };
}

// US-3: every variant's canvas and log is state too. The ones that exist are
// listed here so that a link to one is caught by its identity; one that does
// not exist yet is caught by where it lands (stateFileAt). SQ-203 adds the
// glossary of each state directory: it holds the accepted definitions.
function stateFiles(projectRoot) {
  const pairs = [
    ['canvas', project.canvasPath(projectRoot)],
    ['decisions', project.decisionsPath(projectRoot)],
    ['glossary', project.glossaryPath(projectRoot)],
  ];
  let variants = [];
  try {
    variants = fs.readdirSync(project.variantsDir(projectRoot));
  } catch (_) {
    variants = [];
  }
  for (const name of variants) {
    const dir = path.join(project.variantsDir(projectRoot), name);
    pairs.push(['canvas', path.join(dir, project.CANVAS_FILE)], ['decisions', path.join(dir, project.DECISIONS_FILE)], ['glossary', path.join(dir, project.GLOSSARY_FILE)]);
  }
  return pairs.map(([kind, statePath]) => ({ kind, file: canonical(statePath, 0), id: identity(statePath) }));
}

// US-3: a canvas.md or decisions.md anywhere below the state directory is
// state, whether or not it exists yet and whatever the directory between is
// called — the guard does not decide which subdirectories hold a variant.
const STATE_KIND_BY_NAME = new Map([[project.CANVAS_FILE, 'canvas'], [project.DECISIONS_FILE, 'decisions'], [project.GLOSSARY_FILE, 'glossary']]);

function nestedStateAt(projectRoot, landing) {
  const base = path.basename(landing.canonicalPath);
  const kind = STATE_KIND_BY_NAME.get(base) || STATE_KIND_BY_NAME.get(base.toLowerCase());
  if (!kind) return null;
  const writtenRoot = path.resolve(project.stateDir(projectRoot));
  const stateRoot = canonical(writtenRoot, 0);
  const landsInState = underState(path.dirname(landing.canonicalPath), stateRoot);
  const spelledInState = underState(path.dirname(landing.writtenPath), writtenRoot);
  if (!landsInState && !spelledInState) return null;
  return { kind, file: landing.canonicalPath, id: landing.id, unjudgeable: spelledInState && !landsInState };
}

function stateFileAt(landing, states) {
  for (const state of states) {
    // The file is named by where the write lands, not by what was typed: a
    // refusal that says canvas.md is more use than one that says link.md.
    if ((state.id !== null && state.id === landing.id) || samePath(landing.canonicalPath, state.file)) return state;
  }
  return null;
}

function targetOf(projectRoot, toolInput) {
  const raw = toolInput.file_path || toolInput.notebook_path || toolInput.path;
  if (typeof raw !== 'string' || !raw) return null;
  const landing = landingOf(projectRoot, raw);
  return nestedStateAt(projectRoot, landing) || stateFileAt(landing, stateFiles(projectRoot));
}

// ---------- tool coverage ----------

// Which tools can write a file is not a list this guard can keep. MultiEdit, an
// MCP filesystem server, whatever the client ships next: a list of the tools it
// knows is a list of yesterday's holes, and lengthening it reproduces the defect
// for tomorrow's tool. So the default is inverted rather than extended. A
// recognised tool is judged by the write it would perform; every other tool is
// judged by where its payload points, and a payload pointing into the research
// state is refused — an unknown tool reaching the canvas is exactly the "cannot
// judge this write" case §5.3 already fails closed on.

// Reading the state is how the harness works, so the tools that only read stay
// open. Everything else, named or not, meets the default.
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'Glob', 'Grep']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

const MAX_CANDIDATES = 256;
const MAX_CANDIDATE_LENGTH = 4096;
const MAX_PAYLOAD_DEPTH = 16;

// Every string in the payload is a candidate path, wherever it sits. Reading
// only the keys this guard has heard of — file_path, path, notebook_path — would
// be the same allowlist one level down: the next tool calls its argument
// `destination` and is through. A key it cannot read is a key it must not trust.
function payloadStrings(value, out, depth) {
  if (out.length >= MAX_CANDIDATES) return out;
  if (typeof value === 'string') {
    // Trimmed, because the filesystem and the guard should disagree about a
    // padded path in the direction of denying it.
    const text = value.trim();
    if (text && text.length <= MAX_CANDIDATE_LENGTH) out.push(text);
    return out;
  }
  if (depth >= MAX_PAYLOAD_DEPTH || !value || typeof value !== 'object') return out;
  for (const inner of Array.isArray(value) ? value : Object.values(value)) payloadStrings(inner, out, depth + 1);
  return out;
}

// The state directory and everything under it, compared the way a single file
// is: by where the path lands, not by how it is spelled.
function underState(target, stateRoot) {
  let at = target;
  for (;;) {
    if (samePath(at, stateRoot)) return true;
    const parent = path.dirname(at);
    if (parent === at) return false;
    at = parent;
  }
}

function shortName(projectRoot, file) {
  const rel = path.relative(projectRoot, file);
  return !rel || rel.startsWith('..') ? path.basename(file) : rel;
}

// A prose string is not a path: only a value that resolves, whole, into the
// state counts. `see research/canvas.md for the wording` resolves to a file of
// that unlikely name beside the project, and is nobody's business.
// A payload value with no separator at all is a name, not a location: the
// `research` in a profile id, a topic or a title is not the state directory,
// and reading it as one denied any tool whose payload happened to carry the
// word, in every repository (SQ-65). A name still counts when it names a state
// file — with PLACET_RESEARCH_DIR=. the canvas sits at the project root and
// `canvas.md` is that file — and everything that spells a location
// (`research/canvas.md`, `./research`, an absolute path, a path through a
// symlinked ancestor) is judged whether or not it exists.
function unknownToolVerdict(projectRoot, toolName, toolInput) {
  const states = stateFiles(projectRoot);
  const stateRoot = canonical(project.stateDir(projectRoot), 0);
  for (const candidate of payloadStrings(toolInput, [], 0)) {
    const landing = landingOf(projectRoot, candidate);
    const hit = stateFileAt(landing, states);
    if (!hit && !(hasPathSeparator(candidate) && (
      underState(landing.canonicalPath, stateRoot)
      || underState(landing.writtenPath, path.resolve(project.stateDir(projectRoot)))))) continue;
    const label = toolName ? `\`${toolName.slice(0, 40)}\`` : 'an unnamed tool';
    const name = shortName(projectRoot, hit ? hit.file : landing.canonicalPath);
    return `placet-research cannot judge what ${label} would do to ${name}, so it is denied: it reads Edit, Write and Bash well enough to tell a proposal from a promotion, and nothing else. Read the file with Read, cat or grep; change it with the Edit or Write tool. ${NEXT_STEP}`;
  }
  return null;
}

// ---------- main ----------

// §5.3: the model does not write decisions.md, appends included. Appending was
// permitted once, as faithful to "append-only"; SQ-21's D7b and D7c appended a
// forged acceptance through that door and D8 showed it silenced §4.4's
// backstop. Every entry now comes through the harness, which seals it.
const DECISIONS_DENIAL = 'decisions.md is written only by the harness, so that every entry is sealed (§4.7). To record a finding, run `placet-research log DISCOVERY|CONSTRAINT <ref> --body "<text>"`. A DECISION is the researcher\'s act: ask them for /placet-research:accept <n.m> --explained "<your sentence>".';

// Any tool whose payload points into the harness's own state directory is
// refused, reads included: see harnessStateDenial.
function harnessStateVerdict(projectRoot, toolName, toolInput) {
  const root = canonical(ledger.stateRoot(), 0);
  for (const candidate of payloadStrings(toolInput, [], 0)) {
    if (underState(landingOf(projectRoot, expandTilde(candidate)).canonicalPath, root)) {
      return harnessStateDenial(toolName ? `\`${toolName.slice(0, 40)}\`` : 'an unnamed tool');
    }
  }
  return null;
}

// An exported key file is refused to every tool, reads included, by the name
// it is spelled with and by the name of the file it lands on (a symlink to it).
// A tool this guard knows is read on its path fields only, so an Edit whose new
// text documents `key export --out k.seal.key` is not a key; any other tool on
// every string in its payload, as harnessStateVerdict reads it.
const KNOWN_PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'glob'];

function keyFileVerdict(projectRoot, toolName, toolInput) {
  const known = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName);
  const candidates = known
    ? [...KNOWN_PATH_FIELDS, ...(toolName === 'Glob' ? ['pattern'] : [])].map((key) => toolInput[key]).filter((v) => typeof v === 'string')
    : payloadStrings(toolInput, [], 0);
  for (const candidate of candidates) {
    const text = expandTilde(candidate.trim());
    if (!text) continue;
    if (isKeyFileName(path.basename(text)) || isKeyFileName(path.basename(landingOf(projectRoot, text).canonicalPath))) {
      return keyFileDenial(toolName ? `\`${toolName.slice(0, 40)}\`` : 'an unnamed tool');
    }
  }
  return null;
}

function fileVerdict(target, toolName, toolInput) {
  if (target.unjudgeable) return `Cannot judge this write: ${target.file} is spelled under the research state but lands outside it through a symlink. ${NEXT_STEP}`;
  const name = path.basename(target.file);
  if (target.kind === 'decisions') return DECISIONS_DENIAL;
  if (toolName === 'NotebookEdit') {
    return `${name} is Markdown, not a notebook, and a notebook edit cannot be judged here. Use the Edit tool. ${NEXT_STEP}`;
  }
  let before;
  try {
    before = project.readIfExists(target.file) || '';
  } catch (err) {
    // An unreadable file is not an absent one. Reading it as absent would make
    // this a creation rather than a modification, and so permit a write that
    // deletes whatever the researcher had accepted. §5.3 says the guard denies
    // what it cannot judge, and it cannot judge this.
    return `Cannot judge this write: ${target.file} exists but cannot be read (${(err && err.code) || 'unknown error'}). Restore read access to it and retry. ${NEXT_STEP}`;
  }
  let after;
  if (toolName === 'Write') {
    after = typeof toolInput.content === 'string' ? toolInput.content : null;
    if (after === null) return `Cannot judge this write: it carries no content for ${name}. ${NEXT_STEP}`;
  } else {
    after = applyEdit(before, toolInput);
    if (after === null) {
      return `Cannot judge this edit: old_string was not found exactly once in ${name}. Re-read the file and retry with an old_string that appears exactly once.`;
    }
  }
  return target.kind === 'glossary' ? glossaryVerdict(before, after) : canvasVerdict(before, after);
}

function main() {
  let reason = null;
  try {
    const data = readStdin();
    const toolName = typeof data.tool_name === 'string' ? data.tool_name : '';
    const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
    const projectRoot = project.projectDir(data);

    if (toolName === 'Bash') {
      reason = bashVerdict(toolInput.command, projectRoot);
    } else if ((reason = harnessStateVerdict(projectRoot, toolName, toolInput) || keyFileVerdict(projectRoot, toolName, toolInput)) === null) {
      if (WRITE_TOOLS.has(toolName)) {
        const target = targetOf(projectRoot, toolInput);
        if (target) reason = fileVerdict(target, toolName, toolInput);
      } else if (!READ_TOOLS.has(toolName)) {
        reason = unknownToolVerdict(projectRoot, toolName, toolInput);
      }
    }
  } catch (err) {
    // Fail closed: a permission guard that lets writes through on error is a
    // hole, which is where this parts company with the fail-open hook (§5.3).
    reason = `placet-research could not evaluate this write (${err && err.message ? err.message : 'unknown error'}); it is denied. ${NEXT_STEP}`;
  }
  if (reason) output.writeDeny(reason);
}

if (require.main === module) main();

module.exports = { canvasVerdict, glossaryVerdict, bashVerdict, applyEdit };
