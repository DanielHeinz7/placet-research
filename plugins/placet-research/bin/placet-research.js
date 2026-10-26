#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const project = require('../hooks/lib/project');
const canvasLib = require('../hooks/lib/canvas');
const glossaryLib = require('../hooks/lib/glossary');
const decisions = require('../hooks/lib/decisions');
const identity = require('../hooks/lib/identity');
const host = require('../hooks/lib/host');
const profileLib = require('../hooks/lib/profile');
const seal = require('../hooks/lib/seal');
const stateLib = require('../hooks/lib/state');
const { acceptStatement, acceptGlossaryEntry } = require('../hooks/lib/accept');
const { chooseFraming } = require('../hooks/lib/choose');
const { appendLog } = require('../hooks/lib/log');
const { mergeLogs } = require('../hooks/lib/merge');
const { startSession } = require('../hooks/lib/session');
const { protocolOf } = require('../hooks/lib/protocol');
const { mechanicalReview, ledgerReport, coverNote, ledgerSummary, COVER_STATE } = require('../hooks/lib/review');
const { agendaOf, agendaMarkdown } = require('../hooks/lib/agenda');
const { summarize } = require('../hooks/inject-state');

const MODES = ['brainstorming', 'seed', 'import'];
const USAGE = [
  'placet-research init --project <slug> --mode brainstorming|seed|import [--outlet <name>] [--title <text>] [--profile <id>]',
  'placet-research init --variant <name> --lens <text> [--mode brainstorming|seed|import]',
  'placet-research status [--variant <name>] [--key <file>]',
  'placet-research review [--variant <name>] [--key <file>]',
  'placet-research agenda [--out <file>]',
  'placet-research accept <n.m> --explained <text> [--match <substring>] [--why <text>] [--rejected <text>]',
  'placet-research glossary show <id>',
  'placet-research glossary accept <id> --hash <64hex> --explained <text> [--why <text>] [--rejected <text>]',
  'placet-research choose <name> --why <text> [--rejected <text>]',
  'placet-research log DISCOVERY|CONSTRAINT <ref> --body <text> [--why <text>] [--supersedes <n>] [--variant <name>]',
  'placet-research title [<text>]',
  'placet-research profile [<id>]',
  'placet-research name [<name>]',
  'placet-research key export --out <file>.seal.key',
  'placet-research join --key-file <file> --name "<name>"',
  'placet-research merge-log [--skip-decision <n>]',
  'placet-research session start "<occasion>"',
  'placet-research session protocol [<n>] [--out <file>]',
  'placet-research serve [--no-open]',
  'placet-research serve --app [--app-data <dir>] [--no-open]',
  'placet-research doctor',
  'placet-research install-cli [--dir <path>]',
].join('\n');

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// The value flags SQ-167 names, `skip-decision` among them. parseArgs cannot
// tell one given without a value from a switch: both arrive as `true`, and a
// command that then reads the value with `typeof flags.x === 'string'` sees
// "not given". That is how a bare --match accepted a question's single
// candidate without checking it, a bare --profile became the default profile,
// and a bare --title, --outlet, --why or --rejected vanished without a word.
// main refuses a bare flag of this set before the command runs, so no state is
// read or written on the way to the refusal; --project, --mode, --dir and
// --supersedes keep the bare-flag refusal their own command already has.
const VALUE_FLAGS = new Set(['hash', 'match', 'profile', 'title', 'outlet', 'explained', 'why', 'rejected', 'body', 'key', 'key-file', 'name', 'out', 'variant', 'lens', 'skip-decision']);

// Every message goes to stdout: the skills embed this command through a `!`
// line, and that line carries stdout only (§5.4). A refusal the researcher
// cannot read is the same as no refusal.
function say(text) {
  process.stdout.write(`${text}\n`);
}

function fail(text, code = 1) {
  say(text);
  return code;
}

// A refusal from the write library: a malformed call exits 2, with the usage
// text when the refusal is about the call's shape; anything else exits 1.
function refused(result) {
  if (result.code !== 'invalid') return fail(result.error);
  return fail(result.usage ? `${result.error}\n${USAGE}` : result.error, 2);
}

// Read-only exports print, or write the one file the person named.
function writeOrSay(markdown, out) {
  if (out === undefined) {
    process.stdout.write(markdown);
    return 0;
  }
  fs.writeFileSync(out, markdown);
  say(`Written to ${out}.`);
  return 0;
}

// ---------- init ----------

// Three frontmatter values are the researcher's own text: the project slug, the
// title and the outlet. Written bare, an outlet like `open: ISR / MISQ` makes
// the whole frontmatter unreadable for a real YAML reader — pandoc refuses the canvas
// with "mapping values are not allowed in this context" (SQ-73) — while this
// plugin's own lenient reader hid the breach. A double-quoted scalar is valid
// YAML everywhere, and canvas.js reads the quotes and their escapes back off.
// profile and mode need no quoting: init has already refused any value that is
// not one of the plugin's own identifiers.
function yamlString(value) {
  return JSON.stringify(String(value));
}

// The template's own frontmatter documents the template; a canvas gets its
// own. Everything below the frontmatter is copied unchanged, so the heading
// grammar the parser depends on has one source.
function templateBody() {
  const template = fs.readFileSync(path.join(pluginRoot(), 'references', 'canvas-elements.md'), 'utf8');
  return template.replace(/^---[\s\S]*?\n---\n/, '');
}

const GITATTRIBUTES = path.join('research', '.gitattributes');

// research/.gitattributes keeps every research file LF in every checkout, also
// under Git for Windows' default core.autocrlf=true; without it the canvas and
// the log are refused there (README, "Windows line endings"). A file that is
// already there is the researcher's and stays as it is.
function ensureGitattributes(root) {
  const file = path.join(root, GITATTRIBUTES);
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, '* text eol=lf\n');
  return true;
}

// "a", "a and b", "a, b and c": the Created line reads as it did before when
// research/.gitattributes is already there and nothing is added to it.
function andList(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
}

// A variant is one framing of an existing project, under its own lens: a full
// state directory under research/variants/<name>/ with its own canvas and its
// own log. It takes the project slug and profile from the main canvas, so the
// variants compared side by side answer the same questions. The sealing key is
// the project's, so a variant gets none of its own.
function initVariant(flags) {
  const root = project.projectDir({});
  const name = flags.variant;
  if (!project.isVariantName(name)) return fail(`--variant needs a name of lowercase letters, digits and hyphens (at most 40).\n${USAGE}`, 2);
  const lens = typeof flags.lens === 'string' ? flags.lens.trim() : '';
  if (!lens || /[\r\n]/.test(lens)) return fail(`--lens <text> is required: one line naming the lens this framing takes.\n${USAGE}`, 2);
  if (flags.mode !== undefined && !MODES.includes(flags.mode)) return fail(`--mode must be one of ${MODES.join(', ')}.\n${USAGE}`, 2);
  const mainText = project.readIfExists(project.canvasPath(root));
  if (mainText === null) {
    return fail(`This is not a paper project: no ${path.relative(root, project.canvasPath(root))}. A variant is a framing of an existing project; run placet-research init --project <slug> --mode <mode> first.`);
  }
  const main = canvasLib.parseCanvas(mainText).frontmatter;
  const canvasFile = project.canvasPath(root, name);
  const decisionsFile = project.decisionsPath(root, name);
  if (fs.existsSync(canvasFile)) return fail(`${path.relative(root, canvasFile)} already exists; nothing written.`);
  const slug = typeof main.project === 'string' && main.project ? main.project : path.basename(root);
  const mode = MODES.includes(flags.mode) ? flags.mode : MODES.includes(main.mode) ? main.mode : 'import';
  const frontmatter = [
    '---',
    `project: ${yamlString(slug)}`,
    `variant: ${name}`,
    `lens: ${yamlString(lens)}`,
    `profile: ${main.profile || 'is-qualitative'}`,
    `created: ${today()}`,
    `mode: ${mode}`,
    'canvas-schema: 2',
    '---',
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(canvasFile), { recursive: true });
  fs.writeFileSync(canvasFile, `${frontmatter}${templateBody()}`);
  if (!fs.existsSync(decisionsFile)) fs.writeFileSync(decisionsFile, decisions.header(`${slug} · variant ${name}`));
  const made = [path.relative(root, canvasFile), path.relative(root, decisionsFile)];
  if (ensureGitattributes(root)) made.push(path.relative(root, path.join(root, GITATTRIBUTES)));
  say(`Created ${andList(made)} (variant ${name}, lens: ${lens}, mode ${mode}).`);
  say('Every element is empty. Only the researcher chooses a framing, with placet-research choose <name>.');
  return 0;
}

// Why init must not create a key here, or null. A log that already carries
// seals was sealed with a key this machine does not have, and a seal
// recomputes under that key alone: a fresh key here would report an intact log
// as BROKEN (SQ-122). A log whose `Seal key:` line names a key is the same case
// before its first seal (SQ-286). init refuses to make one and names where the
// project's key comes from instead.
function foreignLog(root, decisionsFile) {
  if (fs.existsSync(seal.keyPath(root))) return null;
  const logText = fs.existsSync(decisionsFile) ? fs.readFileSync(decisionsFile, 'utf8') : '';
  const rel = path.relative(root, decisionsFile);
  const join = `ask the person who shared the project to run placet-research key export --out <file>${EXPORT_SUFFIX}, then run placet-research join --key-file <file> --name "<your name>". Nothing was changed.`;
  if (decisions.parseDecisions(logText).entries.some((e) => e.seal !== null)) {
    return `${rel} is sealed on another machine. Do not create a new key here: ${join}`;
  }
  if (seal.keyLineOf(logText)) return `${rel} names the project's key in its Seal key line, and this machine does not have it. Do not create a new key here: ${join}`;
  return null;
}

function init(flags) {
  if (flags.variant !== undefined) return initVariant(flags);
  const root = project.projectDir({});
  if (!flags.project || typeof flags.project !== 'string') return fail(`--project is required.\n${USAGE}`, 2);
  // The name becomes the log's title line and the canvas slug, so a line break
  // splits it: `init --project "p\nSeal key: 0…"` even made withKeyLine return
  // null and the write crash on a null payload (SQ-294).
  if (/[\r\n]/.test(flags.project)) {
    return fail(`--project must be one line: a name with a line break or a carriage return is not allowed.\n${USAGE}`, 2);
  }
  if (!MODES.includes(flags.mode)) return fail(`--mode must be one of ${MODES.join(', ')}.\n${USAGE}`, 2);
  const profileId = typeof flags.profile === 'string' ? flags.profile : 'is-qualitative';
  try {
    profileLib.loadProfile(profileId, pluginRoot());
  } catch (err) {
    return fail(err.message, 2);
  }
  const canvasFile = project.canvasPath(root);
  const decisionsFile = project.decisionsPath(root);
  // An existing project may still lack a key on this machine — a co-author's
  // clone, or a project started before the seal existed. init creates the
  // missing key and touches nothing else; with both present it does nothing.
  // A log already sealed under another machine's key is the exception, below.
  if (fs.existsSync(canvasFile)) {
    // A canvas that exists is never rewritten, so a title given here would be
    // dropped in silence. `title` is the one door for that line: init points at
    // it rather than editing a frontmatter the researcher already has.
    if (typeof flags.title === 'string') {
      say(`--title was not applied: ${path.relative(root, canvasFile)} already exists; run placet-research title "<text>" to set it.`);
    }
    const foreign = foreignLog(root, decisionsFile);
    if (foreign) return fail(foreign);
    const key = seal.createKey(root);
    if (!key.created) return fail(`${path.relative(root, canvasFile)} already exists; nothing written.`);
    say(`${path.relative(root, canvasFile)} already exists; kept.`);
    say(keyLine(key));
    return 0;
  }

  const foreign = foreignLog(root, decisionsFile);
  if (foreign) return fail(foreign);
  const body = templateBody();
  const frontmatterLines = [
    '---',
    `project: ${yamlString(flags.project)}`,
  ];
  // A title is optional and the view falls back to the slug without one, so a
  // project that was given none carries no title line rather than an empty one.
  if (typeof flags.title === 'string') frontmatterLines.push(`title: ${yamlString(flags.title)}`);
  frontmatterLines.push(
    `outlet: ${yamlString(typeof flags.outlet === 'string' ? flags.outlet : '')}`,
    `profile: ${profileId}`,
    `created: ${today()}`,
    `mode: ${flags.mode}`,
    'canvas-schema: 2',
    '---',
    '',
  );
  const frontmatter = frontmatterLines.join('\n');
  // The key comes first, so the new log names it in its `Seal key:` line: a
  // wrong key is then refused even while the log has no seal (SQ-286).
  const key = seal.createKey(root);
  let keyBytes;
  try {
    keyBytes = seal.readKey(root);
  } catch (err) {
    return fail(err.message);
  }
  fs.mkdirSync(path.dirname(canvasFile), { recursive: true });
  fs.writeFileSync(canvasFile, `${frontmatter}${body}`);
  if (!fs.existsSync(decisionsFile)) fs.writeFileSync(decisionsFile, seal.withKeyLine(decisions.header(flags.project), keyBytes));
  const made = [path.relative(root, canvasFile), path.relative(root, decisionsFile)];
  if (ensureGitattributes(root)) made.push(path.relative(root, path.join(root, GITATTRIBUTES)));
  say(`Created ${andList(made)} (profile ${profileId}, mode ${flags.mode}).`);
  say(keyLine(key));
  say('Every element is empty. That is the correct starting state.');
  return 0;
}

function keyLine(key) {
  return key.created
    ? `Sealing key created at ${key.path} (mode 0600, outside the repository). It seals every entry of the decision log written on this machine; it is never committed.`
    : `Sealing key already present at ${key.path}; kept.`;
}

// ---------- status / review ----------

function loadState(variant) {
  return stateLib.loadState(project.projectDir({}), { pluginRoot: pluginRoot(), variant });
}

// `--variant <name>` names a variant's state directory; absent, the main one.
// `{ error }` when the flag is there without a usable name.
function variantFlag(flags) {
  if (flags.variant === undefined) return { variant: undefined };
  if (!project.isVariantName(flags.variant)) return { error: `--variant needs a name of lowercase letters, digits and hyphens.\n${USAGE}` };
  return { variant: flags.variant };
}

// `--key <file>` is the released key of a record received from elsewhere: what
// `review` and `status` verify with instead of the key this machine would read
// (§4.7). A key that cannot be read, or that is not 32 bytes, is refused in
// one line before anything is judged. Verification only: no writing path takes
// this. `{}` means no `--key` was given, which is not the same as a key of
// null.
function keyOverride(flags) {
  if (flags.key === undefined) return {};
  try {
    return { key: seal.readKeyFile(flags.key) };
  } catch (err) {
    return { error: err.message };
  }
}

// The session hook and this command must never render the same state twice:
// summarize() is the one rendering, and it lives with the hook that injects it.
function status(flags) {
  const root = project.projectDir({});
  const { variant, error } = variantFlag(flags);
  if (error) return fail(error, 2);
  const given = keyOverride(flags);
  if (given.error) return fail(given.error, given.code || 1);
  // summarize() reads a CRLF canvas as one without elements; the refusal from
  // loadState names the cause instead of "not a paper project".
  const state = loadState(variant);
  if (state.code === 'line-endings') return fail(state.error);
  const summary = summarize(root, { seenSeq: 0, variant, key: given.key });
  if (!summary) {
    if (variant !== undefined) return fail(`There is no variant "${variant}" (or its canvas has no elements): no ${path.relative(root, project.canvasPath(root, variant))}.`);
    return fail('This is not a paper project: no research/canvas.md (or the file has no elements). Run placet-research init first.');
  }
  say(summary.text);
  return 0;
}

function review(flags) {
  const { variant, error } = variantFlag(flags);
  if (error) return fail(error, 2);
  const given = keyOverride(flags);
  if (given.error) return fail(given.error, given.code || 1);
  const state = loadState(variant);
  if (state.error) return fail(state.error);
  // With `--key`, the key this machine happens to hold is not what this run
  // judges with, so a complaint about reading that one is not its business.
  const key = given.key === undefined ? state.key : given.key;
  // A glossary that exists but cannot be read is a failed read, and a failed
  // read is `not checked`, never an empty glossary (§ Mechanical review and its
  // limits). Only absence is safe to read as "no glossary".
  let glossaryText = null;
  let glossaryReadError = null;
  try {
    glossaryText = project.readIfExists(state.paths.glossary);
  } catch (err) {
    glossaryReadError = (err && err.code) || 'unknown error';
  }
  const report = mechanicalReview({
    parsed: state.parsed,
    graph: state.graph,
    checks: state.checks,
    decisionsText: state.decisionsText,
    glossaryText,
    key,
    root: state.root,
    stateDir: path.dirname(state.paths.canvas),
    canvasFile: state.paths.canvas,
    glossaryFile: state.paths.glossary,
    glossaryReadError,
  });
  const list = (arr) => (arr.length ? arr.join(', ') : 'none');
  const stmt = (s) => `${s.question} [${s.marker === null ? 'unmarked' : s.marker}] (line ${s.line}): ${s.text}`;
  // One shape per stability finding: a changed definition names the canvas
  // statements and manuscript locations that rest on it, and a cover that does
  // not verify names the decision it is short of. Nothing here invalidates
  // anything — deciding what a changed definition means is the researcher's.
  const stabilityLines = (f) => {
    const dependents = f.locations.map((l) => `  ${l.where} (line ${l.line})${l.text === null ? '' : `: ${l.text}`}`);
    const withLocations = (head) => (dependents.length ? [head, 'dependent locations:', ...dependents] : [head]);
    if (f.kind === 'changed') {
      const noCover = f.state === 'verified' ? '' : ` — #${f.seq} does not verify (${COVER_STATE[f.state]})`;
      return withLocations(`${f.id}: definition changed since acceptance (#${f.seq} bound ${f.hash})${noCover}`);
    }
    if (f.kind === 'deleted') {
      const bind = f.seq === null ? '' : `; #${f.seq} accepted payload ${f.hash}`;
      return withLocations(`${f.id}: no single entry carries this id${bind}`);
    }
    if (f.kind === 'uncovered') return withLocations(`${f.id} (line ${f.line}): [accepted] with no decision naming it`);
    if (f.kind === 'superseded') return [`${f.id}: #${f.seq} bound an earlier payload (${f.hash}); #${f.coveredBy} covers the entry now — superseded history, not drift`];
    if (f.kind === 'withdrawn') return [`${f.id}: #${f.seq} still binds this payload (${f.hash}), and the entry is not [accepted]`];
    return [`${f.id}: [accepted], covered only by #${f.seq}, ${COVER_STATE[f.state]}`];
  };
  const lines = [variant === undefined ? '# Mechanical review' : `# Mechanical review — variant ${variant} (lens: ${state.parsed.frontmatter.lens || '?'})`, ''];
  if (state.profileError) lines.push(`> ${state.profileError}; dependencies not checked.`, '');
  if (state.keyError && given.key === undefined) lines.push(`> ${state.keyError}; the ledger is judged as if there were none.`, '');
  if (report.problems.length) lines.push('## Parse problems', ...report.problems, '');
  // Same wording as the session summary in hooks/inject-state.js: the count
  // names proposals, and an open element takes no plus sign because there is
  // nothing committed to add to.
  const status = (e) => {
    const s = report.statuses[e.number];
    const proposals = s.open ? ` (${s.status === 'open' ? '' : '+'}${s.open} proposal${s.open === 1 ? '' : 's'})` : '';
    return `${e.number} ${e.title}: ${s.status}${proposals}`;
  };
  lines.push('## Element status', ...state.parsed.elements.map(status), '');
  lines.push('## Empty elements', list(report.empty), '');
  lines.push('## Open elements (proposals only)', list(report.open), '');
  lines.push('## Dependency violations', ...(report.violations.length ? report.violations.map((v) => `element ${v.element} is accepted but ${v.missing.map((m) => `element ${m.element} is ${m.status}`).join(', ')}`) : ['none']), '');
  if (state.checks.includes('hypotheses-before-data')) {
    lines.push('## Findings before hypotheses', '(reported, never enforced; see references/preregistration.md)', ...(report.findingsBeforeHypotheses.length ? report.findingsBeforeHypotheses.map((f) => `#${f.finding} on element 7 comes before any acceptance on element ${f.element}`) : ['none']), '');
  }
  lines.push('## Unmarked statements', ...(report.unmarked.length ? report.unmarked.map(stmt) : ['none']), '');
  lines.push('## Untagged statements', '(no `src:` or `unverified` — decide whether each is a factual claim)', ...(report.untagged.length ? report.untagged.map(stmt) : ['none']), '');
  lines.push('## Conversational [stated] statements (review periodically)', ...(report.conversationalStated.length ? report.conversationalStated.map(stmt) : ['none']), '');
  const hiddenWhy = { comment: 'inside an HTML comment', code: 'inside a code block or indented as code' };
  lines.push('## Committed but not visible', '(the file holds these; a reader of the rendered canvas does not see them)', ...(report.invisibleCommitments.length ? report.invisibleCommitments.map((s) => `${s.question} [${s.marker}] (line ${s.line}): ${s.text} — ${hiddenWhy[s.hidden] || s.hidden}`) : ['none']), '');
  lines.push('## Decision log', ...ledgerReport(report.ledger, seal.keyPath(state.root)), '');
  // The head of the record as one line (SQ-124): the reviewer compares it with
  // the anchor the authors published, which is what catches a rewrite after the
  // fact. It needs no key of its own, so it prints on every run.
  lines.push('## Anchor', `Anchor: ${seal.logAnchor(state.decisionsText)}`, '');
  lines.push('## Stale acceptances', ...(report.staleAcceptances.length ? report.staleAcceptances.map((s) => `#${s.seq} ${s.ref} — text ${s.hash} no longer matches any accepted statement`) : ['none']), '');
  lines.push('## Unlogged acceptances', '(no verified DECISION entry accounts for these)', ...(report.unloggedAcceptances.length ? report.unloggedAcceptances.map((s) => `${s.question} (line ${s.line}): ${s.text}${coverNote(s.coveredBy)}`) : ['none']), '');
  lines.push('## Unverified decisions', '(DECISION entries that give no cover)', ...(report.unverifiedDecisions.length ? report.unverifiedDecisions.map((d) => `#${d.seq} ${d.ref} — ${COVER_STATE[d.state]}`) : ['none']), '');
  lines.push('## Glossary acceptances', ...(report.glossaryAcceptances.length ? report.glossaryAcceptances.map((a) => `${a.id} (line ${a.line}): ${a.term} — verified DECISION #${a.coveredBy.seq}, payload ${a.hash}`) : ['none']), '');
  lines.push('## Unlogged glossary acceptances', '(no verified DECISION entry accounts for these)', ...(report.glossaryUnloggedAcceptances.length ? report.glossaryUnloggedAcceptances.map((a) => `${a.id} (line ${a.line}): ${a.term} — unlogged${coverNote(a.coveredBy)}`) : ['none']), '');
  // Glossary mechanics (SQ-204): declared construct coverage and drift. The two
  // boundary sentences print on every run, and a check that could not run says
  // `not checked` — an absent manuscript list or a failed read is never zero
  // missing entries (§ Mechanical review and its limits).
  const g = report.glossaryMechanics;
  if (g !== null) {
    lines.push(
      '## Glossary mechanics',
      `Inspected: ${g.inspected.map((f) => `${f.path} (${f.status})`).join(', ')}`,
      ...g.notChecked.map((n) => `not checked: ${n.subject} — ${n.reason}`),
      'Declared construct coverage checked; undeclared constructs require human inspection.',
      'Human construct judgment: not performed by this check',
    );
  }
  if (g !== null && g.lexical.checked) {
    // The problem lines carry their own `line N` prefix from the glossary
    // parser; only the ones without one get it added here.
    const problem = (f) => `${f.id === null ? '' : `${f.id}: `}${f.line === null || /^line \d/.test(f.text) ? '' : `line ${f.line}: `}${f.text}`;
    const ref = (r) => (r.state === null ? `${r.id} — ${r.reason}` : `${r.id} [${r.state}]`);
    const inventory = `${g.structure.entries.length} ${g.structure.entries.length === 1 ? 'entry' : 'entries'}: ${g.structure.entries.map((e) => (e.id === null ? `(line ${e.line}) no id [${e.state}]` : `${e.id} [${e.state}]`)).join(', ')}`;
    lines.push(
      '',
      '### Entry structure and provenance',
      "(reported, never repaired; a source's existence does not prove it supports the definition)",
      ...(g.structure.entries.length ? [inventory] : []),
      ...(g.structure.findings.length ? g.structure.findings.map((f) => `- ${problem(f)}`) : ['none']),
      '',
      '### Declared canvas coverage (elements 3, 4, 7, 8)',
      '(the restricted resolver reads `src: glossary.md#<id>`; a resolved link proves an entry exists, not that it is accepted or supports the claim)',
      ...(g.canvas.statements.length
        ? g.canvas.statements.map((s) => `${s.question} [${s.marker}] (line ${s.line}): ${s.text} — cites ${s.refs.map(ref).join(', ')}`)
        : ['none']),
      '',
      '### Declared manuscript coverage',
      '(declared in the glossary frontmatter, resolved against the project root; links and `constructs:` declarations alike)',
      ...(g.manuscripts.declared.length ? [`declared: ${g.manuscripts.declared.join('; ')}`] : []),
      ...(g.manuscripts.references.length
        ? g.manuscripts.references.map((r) => `${r.path} (line ${r.line}) ${r.kind}: ${r.id}${r.state === null ? ` — ${r.reason}` : ` [${r.state}]`}`)
        : ['none']),
      ...g.manuscripts.notChecked.map((n) => `not checked: ${n.path === null ? 'manuscript coverage' : n.path} — ${n.reason}`),
      '',
      '### Lexical cross-check',
      '(declared terms and aliases in the statements above and in manuscript prose; Unicode word boundaries, no stemming)',
      ...(g.lexical.occurrences.length
        ? g.lexical.occurrences.map((o) => `${o.where} (line ${o.line}): "${o.label}" occurs but ${o.ambiguous ? `is ambiguous — ${o.ids.join(' and ')} both claim it` : `nothing here names ${o.ids[0]}`}`)
        : ['none']),
      '',
      '### Accepted text stability and cover',
      "(entry payload against the recorded decision, under this machine's seal; a changed definition names what depends on it and invalidates nothing)",
      ...(g.stability.length ? g.stability.flatMap(stabilityLines) : ['none']),
    );
  }
  say(lines.join('\n'));
  return 0;
}

// ---------- accept ----------

// The approval path lives in hooks/lib/accept.js; this maps its result to output.
function accept(positional, flags) {
  // A variant is a framing under comparison, not a commitment: acceptance
  // happens on the main canvas only, after a framing has been chosen.
  if (flags.variant !== undefined) return fail(`accept works on the main canvas only; choose a framing with placet-research choose <name> first.\n${USAGE}`, 2);
  const questionId = positional[0];
  const result = acceptStatement({
    root: project.projectDir({}),
    questionId,
    match: flags.match,
    why: flags.why,
    explained: flags.explained,
    rejected: flags.rejected,
    pluginRoot: pluginRoot(),
  });
  if (!result.ok) return refused(result);
  say(`Accepted ${questionId} (was [${result.was}]): ${result.text}`);
  if (result.openAtAccept.length) say(`Accepted with open check questions: ${result.openAtAccept.map((n) => `#${n}`).join(', ')}.`);
  say(`Logged as #${result.seq} with text ${result.hash}, sealed ${result.seal}.`);
  return 0;
}

// ---------- glossary ----------

// The glossary's acceptance path, beside the canvas's: the same researcher's
// act, named the same way on the command line, and refused to the model by the
// same guard. A variant glossary is not accepted here: the framing is chosen
// first, exactly as for a canvas acceptance.
// Read the selected glossary without loading the key or changing either file.
function glossaryShow(id) {
  if (typeof id !== 'string' || !glossaryLib.ID_RE.test(id)) return fail(`glossary show needs an entry id.\n${USAGE}`, 2);
  const loaded = glossaryLib.loadGlossary(project.projectDir({}));
  if (loaded.parsed === null) return fail(`There is no ${loaded.path}.`);
  if (!loaded.parsed.judgeable) return fail('The glossary does not parse cleanly; fix it before displaying a payload for acceptance.');
  const entry = glossaryLib.entryById(loaded.parsed, id);
  if (!entry) return fail(`There is no glossary entry ${id}.`);
  say(JSON.stringify(glossaryLib.entryPayload(entry)));
  say(`Binding digest: ${glossaryLib.bindingDigest(entry)}`);
  return 0;
}

function glossaryCommand(positional, flags) {
  const sub = positional[0];
  if (sub !== 'accept' && sub !== 'show') return fail(`glossary has two subcommands: show and accept.\n${USAGE}`, 2);
  if (flags.variant !== undefined) return fail(`glossary ${sub} works on the main glossary only; choose a framing with placet-research choose <name> first.\n${USAGE}`, 2);
  const id = positional[1];
  if (sub === 'show') return glossaryShow(id);
  if (typeof flags.hash !== 'string' || !/^[0-9a-f]{64}$/.test(flags.hash)) return fail(`glossary accept requires --hash <64hex> from glossary show <id>.\n${USAGE}`, 2);
  const result = acceptGlossaryEntry({
    root: project.projectDir({}),
    id,
    expectedHash: flags.hash,
    why: flags.why,
    explained: flags.explained,
    rejected: flags.rejected,
    pluginRoot: pluginRoot(),
  });
  if (!result.ok) return refused(result);
  say(`Accepted glossary entry ${id} (was [${result.was}]): ${result.term}`);
  say(`Logged as #${result.seq} with payload ${result.hash}, sealed ${result.seal}.`);
  return 0;
}

// ---------- log ----------

// The append path lives in hooks/lib/log.js; this maps its result to output.
function log(positional, flags) {
  const [kind, ref] = positional;
  const { variant, error } = variantFlag(flags);
  if (error) return fail(error, 2);
  const result = appendLog({
    root: project.projectDir({}),
    kind,
    ref,
    body: flags.body,
    why: flags.why,
    // A bare --supersedes parses as true, and Number(true) would be entry 1.
    supersedes: flags.supersedes === undefined ? undefined : flags.supersedes === true ? NaN : Number(flags.supersedes),
    pluginRoot: pluginRoot(),
    variant,
  });
  if (!result.ok) return refused(result);
  say(`Logged #${result.seq} ${kind} ${ref.trim()}${variant === undefined ? '' : ` in variant ${variant}`}, sealed ${result.seal}.`);
  return 0;
}

// ---------- choose ----------

// Choosing a framing lives in hooks/lib/choose.js; this maps its result to
// output. Like accept, it is the researcher's act, and the guard refuses it
// to the model.
function choose(positional, flags) {
  const result = chooseFraming({
    root: project.projectDir({}),
    name: positional[0],
    why: flags.why,
    rejected: flags.rejected,
    pluginRoot: pluginRoot(),
  });
  if (!result.ok) return refused(result);
  say(`Chose framing ${result.name}${result.lens ? ` (lens: ${result.lens})` : ''}: ${result.statements} statement${result.statements === 1 ? '' : 's'} copied into ${result.canvas}.`);
  say(`Logged as #${result.seq} with text ${result.hash}, sealed ${result.seal}.${result.rejected ? ` Rejected: ${result.rejected}` : ''}`);
  return 0;
}

// ---------- title ----------

// Where the title line is, or where it goes: the `title:` line already in the
// frontmatter, or the position directly after `project:` that init --title
// writes it to. `replace` says which of the two this is. Against a canvas this
// cannot place a line in — no frontmatter, no project: anchor — the answer is
// null, because any other position would be a guess at a file the researcher
// owns.
function titleLine(lines) {
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return null;
  const block = lines.slice(1, end);
  const existing = block.findIndex((line) => /^title:/.test(line));
  if (existing >= 0) return { index: existing + 1, replace: true };
  const anchor = block.findIndex((line) => /^project:/.test(line));
  return anchor >= 0 ? { index: anchor + 2, replace: false } : null;
}

// The title is presentational: the view prints it and no marker, seal or
// acceptance reads it, so the model may set it here even though the guard keeps
// refusing a Write or Edit on the frontmatter. The file is rewritten one line at
// a time — insert the line, or replace it — and every other byte stays as it was.
function title(positional) {
  const root = project.projectDir({});
  const canvasFile = project.canvasPath(root);
  if (!fs.existsSync(canvasFile)) {
    return fail(`This is not a paper project: no ${path.relative(root, canvasFile)}. Run placet-research init first.`);
  }
  const text = fs.readFileSync(canvasFile, 'utf8');
  if (!positional.length) {
    const current = canvasLib.parseCanvas(text).frontmatter.title;
    say(current === undefined || String(current).trim() === '' ? 'No title set.' : String(current));
    return 0;
  }
  // An unquoted title arrives as several words; they are one title, not the
  // first word of one. A title that is empty once trimmed is refused rather
  // than written as an empty line the view would show as a blank header.
  const wanted = positional.join(' ').trim();
  if (!wanted) return fail(`A title cannot be empty. Pass it as the argument: placet-research title "<text>"`);
  const lines = text.split('\n');
  const at = titleLine(lines);
  if (!at) return fail(`${path.relative(root, canvasFile)} has no frontmatter with a project: line, so there is nowhere to set a title.`);
  const line = `title: ${yamlString(wanted)}`;
  if (at.replace) lines[at.index] = line;
  else lines.splice(at.index, 0, line);
  fs.writeFileSync(canvasFile, lines.join('\n'));
  say(`Title set: ${wanted}`);
  return 0;
}

// ---------- profile ----------

// Which genre profile the canvas runs on (§4.5, 0.5 spec §9). Switching
// changes which dependencies the review reports and which checks run, so it
// is recorded: a sealed CONSTRAINT entry first, then the one frontmatter line.
// The log is written first because it is the step that can refuse (no key, a
// broken ledger); a refused switch leaves both files as they were.
function profile(positional) {
  const root = project.projectDir({});
  const canvasFile = project.canvasPath(root);
  if (!fs.existsSync(canvasFile)) {
    return fail(`This is not a paper project: no ${path.relative(root, canvasFile)}. Run placet-research init first.`);
  }
  const text = fs.readFileSync(canvasFile, 'utf8');
  const current = canvasLib.parseCanvas(text).frontmatter.profile || 'is-qualitative';
  if (!positional.length) {
    say(current);
    return 0;
  }
  const wanted = positional[0];
  try {
    profileLib.loadProfile(wanted, pluginRoot());
  } catch (err) {
    return fail(err.message);
  }
  if (wanted === current) return fail(`The canvas already uses ${current}; nothing changed.`);
  const lines = text.split('\n');
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return fail(`${path.relative(root, canvasFile)} has no frontmatter, so there is nowhere to set a profile.`);
  const at = lines.slice(1, end).findIndex((line) => /^profile:/.test(line));
  const logged = appendLog({
    root,
    kind: 'CONSTRAINT',
    ref: 'profile',
    body: `Profile changed from ${current} to ${wanted}.`,
    pluginRoot: pluginRoot(),
  });
  if (!logged.ok) return refused(logged);
  if (at >= 0) lines[at + 1] = `profile: ${wanted}`;
  else lines.splice(end, 0, `profile: ${wanted}`);
  fs.writeFileSync(canvasFile, lines.join('\n'));
  say(`Profile set: ${wanted} (was ${current}), logged as #${logged.seq}. Run placet-research review to see what the new graph reports.`);
  return 0;
}

// ---------- name ----------

// The name every entry written from this machine carries as `By` (spec §3).
// User-wide, not per project: it belongs to the person, not the clone, so two
// clones of one project write the same name and a second clone needs no
// setting up. A statement, not proof: the seal keeps the name from changing
// after the entry is written, and says nothing about who held the key.
function name(positional) {
  if (!positional.length) {
    const who = identity.readName(project.projectDir({}));
    if (!who.name) return fail(who.error);
    say(who.source === 'git' ? `${who.name} (from git config user.name)` : who.name);
    return 0;
  }
  if (positional.length > 1) return fail(`name takes one argument; quote a name with spaces.\n${USAGE}`, 2);
  const bad = identity.nameRefusal(positional[0]);
  if (bad) return fail(bad, 2);
  identity.writeName(positional[0]);
  say(`Name set: ${positional[0].trim()}. Every entry you write from now on carries it as By — a statement, not a proof of who wrote it.`);
  return 0;
}

// ---------- key export / join ----------

const EXPORT_SUFFIX = '.seal.key';

// The key holder's one step (spec §7): the project key into a file of their
// choosing, mode 600, never on stdout. The guard refuses this to the model.
function keyCommand(positional, flags) {
  if (positional[0] !== 'export' || positional.length !== 1) return fail(`key takes export.\n${USAGE}`, 2);
  if (typeof flags.out !== 'string' || !flags.out.endsWith(EXPORT_SUFFIX)) {
    return fail(`key export needs --out <file> ending in ${EXPORT_SUFFIX}.\n${USAGE}`, 2);
  }
  const root = project.projectDir({});
  let key;
  try {
    key = seal.readKey(root);
  } catch (err) {
    return fail(err.message);
  }
  if (!key) return fail('There is no sealing key for this project on this machine, so there is nothing to export.');
  try {
    fs.writeFileSync(flags.out, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') return fail(`${flags.out} already exists; nothing was written.`);
    throw err;
  }
  say(`Key written to ${flags.out} (mode 0600). Hand it to the second person yourself — not as plain-text mail, not into the repository. They run: placet-research join --key-file <file> --name "<their name>"`);
  stampKeyLine(root, key);
  return 0;
}

// A log from before the `Seal key:` line, with no seal yet, cannot tell a wrong
// key from the right one at join (SQ-286). The exporting machine holds the
// project's key, so this is where the line goes in. A sealed log keeps its
// bytes: its seals already tell keys apart, and the line would break them.
function stampKeyLine(root, key) {
  const file = project.decisionsPath(root);
  const text = project.readIfExists(file);
  if (text === null || seal.verifyChain(text, key).status === 'broken') return;
  const stamped = seal.withKeyLine(text, key);
  if (stamped === null) return;
  fs.writeFileSync(file, stamped);
  const rel = path.relative(root, file);
  say(`${rel} had no Seal key line, so join could not check a key against it; the line is added now. Commit and push ${rel} before you hand over the key file.`);
}

// The second person's one step: check the key against this clone's log, copy
// it, set the name. A key that does not verify the log is refused before
// anything is copied — a wrong key here would report every later merge as
// broken.
function join(flags) {
  if (typeof flags['key-file'] !== 'string' || typeof flags.name !== 'string') return fail(`join needs --key-file <file> and --name "<name>".\n${USAGE}`, 2);
  const bad = identity.nameRefusal(flags.name);
  if (bad) return fail(bad, 2);
  let key;
  try {
    key = seal.readKeyFile(flags['key-file']);
  } catch (err) {
    return fail(err.message);
  }
  const state = loadState();
  if (state.error) return fail(state.error);
  const chain = seal.verifyChain(state.decisionsText, key);
  const rel = path.relative(state.root, state.paths.decisions);
  if (chain.status === 'broken' && chain.broken.why === 'key') {
    return fail(`This key file does not hold the project's key: the Seal key line in ${rel} names a different key. It belongs to another project; ask the person who shared this one for theirs. Nothing was copied.`);
  }
  if (chain.status === 'broken') {
    return fail(`This key does not verify ${path.relative(state.root, state.paths.decisions)}: it fails at #${chain.broken.seq} (${chain.broken.why}). It belongs to another project, or the log was changed. Nothing was copied.`);
  }
  if (state.keyError) return fail(`${state.keyError}; nothing was copied.`);
  const file = seal.keyPath(state.root);
  // A stored key the log's own `Seal key:` line contradicts is replaced — and
  // only by a key file that matches that line: the file, not the request, is
  // what decides which key is the project's (SQ-294). Without the line there is
  // nothing to check the incoming key against, so the refusal stands.
  const named = seal.keyLineOf(state.decisionsText);
  let replaced = false;
  if (state.key && !state.key.equals(key)) {
    if (!named || named.fingerprint !== seal.keyFingerprint(key)) {
      return fail(`A different key is already at ${file}; nothing was copied. If it is wrong, the person who set it up decides which key is the project's.`);
    }
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    replaced = true;
    say(`The key already at ${file} does not match the Seal key line in ${rel}; the key file you gave does, so it replaced the stored one.`);
  }
  if (!state.key) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  identity.writeName(flags.name);
  // Option (b) of SQ-286: an old log with no seal and no Seal key line is
  // joined, but the person is told that nothing checked the key.
  if (chain.verified.size === 0 && !seal.keyLineOf(state.decisionsText)) {
    say(`Note: ${rel} has no sealed entry and no Seal key line, so this key could not be checked against it. If the person who shared the project runs placet-research key export again, the line is added to the log.`);
  }
  say(`${state.key && !replaced ? 'The same key was already here; kept.' : `Key copied to ${file}.`} Name set: ${flags.name.trim()}.`);
  say(`You can delete ${flags['key-file']} now; join does not delete it.`);
  say('placet-research doctor:');
  doctor();
  return 0;
}

// ---------- merge-log ----------

function gitIn(root, args) {
  return childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

// Entry numbers arrive as `12` or `#12`; a shell drops an unquoted `#12` as a
// comment, which the bare-flag refusal in main already catches.
function entryNumber(value) {
  const m = /^#?([1-9]\d*)$/.exec(String(value));
  return m ? Number(m[1]) : null;
}

// Run inside a `git pull --no-rebase` that conflicted on decisions.md (spec
// §2). Ours is stage 2, theirs stage 3. Writes the working file and nothing
// else: staging and committing stay the person's steps.
function mergeLog(flags, argv) {
  const root = project.projectDir({});
  // parseArgs reads `--skip-decision=5` as a switch of its own name and keeps
  // only the last of two values; either way the merge would run without the
  // skip the person asked for (SQ-192).
  const given = argv.filter((a) => a === '--skip-decision' || a.startsWith('--skip-decision='));
  if (given.some((a) => a !== '--skip-decision')) return fail(`--skip-decision takes its number after a space, e.g. --skip-decision 12.\n${USAGE}`, 2);
  if (given.length > 1) return fail(`--skip-decision is given more than once; merge-log leaves out one decision per run.\n${USAGE}`, 2);
  let skip = [];
  if (flags['skip-decision'] !== undefined) {
    const n = entryNumber(flags['skip-decision']);
    if (n === null) return fail(`--skip-decision takes an entry number, e.g. 12.\n${USAGE}`, 2);
    skip = [n];
  }
  const gitPath = (name) => {
    const r = gitIn(root, ['rev-parse', '--git-path', name]);
    return r.status === 0 ? path.resolve(root, r.stdout.trim()) : null;
  };
  if (['rebase-merge', 'rebase-apply'].some((n) => { const p = gitPath(n); return p && fs.existsSync(p); })) {
    return fail('A rebase is in progress; in a rebase ours and theirs are swapped, so merge-log refuses. Abort it (git rebase --abort) and pull with git pull --no-rebase.');
  }
  const head = gitIn(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.status !== 0) return fail('There is no merge in progress. Run merge-log after a git pull --no-rebase that conflicted on research/decisions.md.');
  const state = stateLib.loadState(root, { pluginRoot: pluginRoot() });
  if (state.error) return fail(state.error);
  const refusal = stateLib.ledgerRefusal({ ...state, decisionsText: '' });
  if (refusal) return fail(`Cannot merge: ${refusal.error}`);
  const rel = `./${path.relative(root, state.paths.decisions)}`;
  const ours = gitIn(root, ['show', `:2:${rel}`]);
  const theirs = gitIn(root, ['show', `:3:${rel}`]);
  if (ours.status !== 0 || theirs.status !== 0) return fail(`${rel.slice(2)} is not in conflict in this merge; nothing to do.`);
  const short = gitIn(root, ['rev-parse', '--short', 'MERGE_HEAD']).stdout.trim();
  const result = mergeLogs(ours.stdout, theirs.stdout, state.key, { by: state.by, theirsCommit: short, skip });
  if (!result.ok) return fail(result.error);
  fs.writeFileSync(state.paths.decisions, result.text);
  if (seal.verifyChain(fs.readFileSync(state.paths.decisions, 'utf8'), state.key).status !== 'verified') {
    return fail(`${rel.slice(2)} was written but does not verify. Do not commit it; run git merge --abort.`);
  }
  if (!result.merged) say(`One log already holds the other (${result.kept} kept, unchanged).`);
  else say(`Merged: their log up to #${result.mergeSeq - result.moved.length - 1}, then ours as ${result.moved.map(([o, n]) => `#${o}→#${n}`).join(', ') || 'nothing'}; MERGE entry #${result.mergeSeq}.`);
  for (const s of result.dropped || []) {
    say(`#${s} was left out. Its statement in research/canvas.md may still read [accepted]: set its marker back by hand after the merge, then accept it again with placet-research accept.`);
  }
  say(`Next: git add ${rel.slice(2)}, resolve any other conflicts, git commit.`);
  return 0;
}

// ---------- session ----------

// The session marker (§4). A session runs from its SESSION entry to the next
// one or the end of the log; a person starts it, and the sealed entry names
// them by `By`. `log` cannot write the kind, so the two commands stay apart.
function session(positional, flags) {
  const [action, ...rest] = positional;
  if (action === 'start') {
    if (rest.length !== 1) return fail(`session start takes one quoted occasion.\n${USAGE}`, 2);
    const result = startSession({ root: project.projectDir({}), occasion: rest[0], pluginRoot: pluginRoot() });
    if (!result.ok) return refused(result);
    say(`Session #${result.seq} started, sealed ${result.seal}. It runs until the next session start.`);
    return 0;
  }
  // The protocol (§5): what the entries between two markers decided, noted and
  // left open. Read-only, like the agenda: it prints, or writes the one file
  // the person named.
  if (action === 'protocol') {
    if (rest.length > 1) return fail(`session protocol takes at most one entry number.\n${USAGE}`, 2);
    const seq = rest.length ? entryNumber(rest[0]) : undefined;
    if (seq === null) return fail(`session protocol takes an entry number, e.g. 12.\n${USAGE}`, 2);
    const state = loadState();
    if (state.error) return fail(state.error);
    const result = protocolOf({ decisionsText: state.decisionsText, canvasText: state.canvasText, key: state.key, seq });
    if (!result.ok) return fail(result.error);
    return writeOrSay(result.markdown, flags.out);
  }
  return fail(`session takes start or protocol.\n${USAGE}`, 2);
}

// ---------- agenda ----------

// The "To talk about" tab as Markdown, before a session (spec §6). Read-only.
function agenda(flags) {
  const state = loadState();
  if (state.error) return fail(state.error);
  const fm = state.parsed.frontmatter;
  const markdown = agendaMarkdown(agendaOf(state.parsed, state.decisionsText), {
    title: fm.title || fm.project || 'Untitled',
    date: today(),
    seal: ledgerSummary(seal.verifyChain(state.decisionsText, state.key)),
  });
  return writeOrSay(markdown, flags.out);
}

// ---------- serve ----------

// The session view (US-2). A human runs this in their own terminal; the URL
// with the single-use code goes to their browser and their terminal, and the
// token it is traded for never leaves the server and the view. The terminal
// also shows when the code is redeemed. It runs until SIGINT. With --app it
// serves the desktop app's shell instead, which can open another project; the
// folder it starts in is opened if it is a paper project.
function serve(flags) {
  const root = project.projectDir({});
  const appMode = flags.app === true;
  if (!appMode && !fs.existsSync(project.canvasPath(root))) return fail('This is not a paper project: no research/canvas.md. Run placet-research init first.');
  let startLines = [];
  if (appMode) {
    const probe = childProcess.spawnSync(require('../hooks/lib/app-git').gitBinary(), ['--version'], { encoding: 'utf8' });
    const notes = host.startNotes({ platform: process.platform, nodeVersion: process.versions.node, gitFound: !probe.error });
    if (notes.refuse) return fail(notes.refuse);
    startLines = notes.lines;
  }
  const canvasServe = require('./canvas-serve');
  const options = appMode
    ? {
      root: fs.existsSync(project.canvasPath(root)) ? root : null,
      app: { dataDir: typeof flags['app-data'] === 'string' ? flags['app-data'] : path.join(os.homedir(), '.placet-research') },
    }
    : { root };
  canvasServe.start({ ...options, pluginRoot: pluginRoot(), log: say }).then((running) => {
    const url = appMode ? running.appUrl : running.url;
    say(url);
    for (const line of startLines) say(line);
    if (flags['no-open'] !== true) canvasServe.openInBrowser(url);
    process.once('SIGINT', () => {
      running.close().then(() => process.exit(0));
    });
  }, (err) => {
    say(`Cannot start the session view: ${err.message}`);
    process.exitCode = 1;
  });
  return 0;
}

// ---------- doctor ----------

const PLUGIN_NAME = 'placet-research';

// The three settings files Claude Code reads for this cwd, in the order a
// later one overrides an earlier one. doctor can only read what is on disk;
// it cannot see whether a running Claude Code process actually loaded the
// plugin.
function settingsSources(root) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [
    { label: 'user settings', file: path.join(home, 'settings.json') },
    { label: 'project settings', file: path.join(root, '.claude', 'settings.json') },
    { label: 'local settings', file: path.join(root, '.claude', 'settings.local.json') },
  ];
}

function checkPluginEnabled(root) {
  let match = null;
  const problems = [];
  for (const { label, file } of settingsSources(root)) {
    let raw;
    try {
      raw = project.readIfExists(file);
    } catch (err) {
      problems.push(`${file} cannot be read (${(err && err.code) || 'unknown error'})`);
      continue;
    }
    if (raw === null) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      problems.push(`${file} does not parse as JSON (${err.message})`);
      continue;
    }
    const enabled = data && typeof data === 'object' ? data.enabledPlugins : null;
    if (!enabled || typeof enabled !== 'object') continue;
    // The last file to name the key wins, which is exactly Claude Code's own
    // precedence (user, then project, then local) — so a later file that
    // disables the plugin is the answer, not the earlier one that enabled it.
    for (const key of Object.keys(enabled)) {
      if (key.startsWith(`${PLUGIN_NAME}@`)) {
        match = { label, file, key, value: !!enabled[key] };
      }
    }
  }
  if (problems.length) return { ok: false, name: 'plugin enabled', detail: problems.join('; ') };
  if (!match) {
    const files = settingsSources(root).map((s) => s.file).join(', ');
    return { ok: false, name: 'plugin enabled', detail: `no enabledPlugins entry for ${PLUGIN_NAME}@<marketplace> in ${files}` };
  }
  if (!match.value) return { ok: false, name: 'plugin enabled', detail: `${match.key} is disabled by ${match.label} (${match.file})` };
  return { ok: true, name: 'plugin enabled', detail: `${match.key} is enabled by ${match.label} (${match.file})` };
}

// Runs the guard exactly as Claude Code would: a PreToolUse payload on its
// stdin, cwd and CLAUDE_PROJECT_DIR pointed at the project, the verdict read
// back off stdout. Same mechanics as test/guard-promotion.test.js's run().
function runGuard(cwd, toolName, toolInput) {
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  const script = path.join(pluginRoot(), 'hooks', 'guard-promotion.js');
  const result = childProcess.spawnSync(process.execPath, [script], {
    cwd,
    env: { ...ambient, CLAUDE_PLUGIN_ROOT: pluginRoot(), CLAUDE_PROJECT_DIR: cwd },
    input: JSON.stringify({ cwd, session_id: 'doctor', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  if (result.error) return { error: `could not run the guard (${result.error.message})` };
  if (result.status !== 0) return { error: `the guard exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}` };
  if (!result.stdout) return { decision: null };
  const parsed = JSON.parse(result.stdout).hookSpecificOutput || {};
  return { decision: parsed.permissionDecision || null, reason: parsed.permissionDecisionReason };
}

// A throwaway project the guard is asked to judge: one [proposed] statement,
// promoted to [accepted] the way a model's Edit would. The guard must deny
// that, and must not deny an ordinary read — an always-deny guard is not a
// working guard.
function checkGuardDenies() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-doctor-'));
  try {
    fs.mkdirSync(path.join(dir, 'research'));
    const canvasFile = path.join(dir, 'research', 'canvas.md');
    const statement = 'A throwaway statement doctor writes to test the guard. [proposed]';
    const canvasText = [
      '---',
      'canvas-schema: 2',
      '---',
      '',
      '# 1 · Puzzle',
      '',
      '## 1.1 What is the broad question this project speaks to?',
      '',
      statement,
      '',
    ].join('\n');
    fs.writeFileSync(canvasFile, canvasText);

    const promote = runGuard(dir, 'Edit', {
      file_path: canvasFile,
      old_string: statement,
      new_string: statement.replace('[proposed]', '[accepted]'),
    });
    if (promote.error) return { ok: false, name: 'guard denies', detail: promote.error };
    if (promote.decision !== 'deny') {
      return { ok: false, name: 'guard denies', detail: 'the guard allowed a model edit that promotes a [proposed] statement to [accepted]; it should have denied it' };
    }

    const read = runGuard(dir, 'Read', { file_path: canvasFile });
    if (read.error) return { ok: false, name: 'guard denies', detail: read.error };
    if (read.decision === 'deny') {
      return { ok: false, name: 'guard denies', detail: `the guard denies an ordinary read of the canvas (${read.reason}); it should only deny writes it cannot judge` };
    }
    return { ok: true, name: 'guard denies', detail: 'guard-promotion.js denies a model promotion to [accepted] and allows an ordinary read' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Only inside a project: the sealing key `status` and `review` both need
// (via loadState) to write a verifiable decision-log entry.
function checkProjectState() {
  const state = loadState();
  if (state.error) return null;
  if (state.keyError) return { ok: false, name: 'project state', detail: state.keyError };
  if (!state.key) {
    return { ok: false, name: 'project state', detail: stateLib.keyHeldElsewhere(state)
      ? 'no sealing key for this project on this machine, and the project\'s key is held elsewhere; get the key file from the person who shared the project and run `placet-research join --key-file <file> --name "<your name>"`'
      : 'no sealing key for this project on this machine; run `placet-research init --project <slug> --mode <mode>` once here' };
  }
  return { ok: true, name: 'project state', detail: `sealing key present at ${seal.keyPath(state.root)}` };
}

// The shim `install-cli` writes and `doctor` looks for: the file a terminal
// resolves when the researcher types the bare command. Only a file carrying the
// marker counts as ours — another program of that name on PATH is not this CLI.
const SHIM_NAME = 'placet-research';
const SHIM_MARKER = '# placet-research install-cli shim';

// The directories a terminal resolves the bare command from: the default one,
// which need not be on PATH at all, and every directory PATH does carry.
function shimDirs() {
  const dirs = [path.join(os.homedir(), '.local', 'bin')];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) if (entry) dirs.push(entry);
  return [...new Set(dirs)];
}

function checkTerminalCommand() {
  const onPath = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean));
  let offPath = null;
  for (const dir of shimDirs()) {
    const file = path.join(dir, SHIM_NAME);
    let raw = null;
    try {
      raw = project.readIfExists(file);
    } catch (_) {
      continue; // unreadable is not installed; doctor says so in one line
    }
    if (raw !== null && raw.includes(SHIM_MARKER)) {
      // install-cli rewrites its own shim with mode 0755, so it is the repair.
      try {
        fs.accessSync(file, fs.constants.X_OK);
      } catch (_) {
        return { ok: false, name: 'terminal command', detail: `shim at ${file} is not executable; run placet-research install-cli again` };
      }
      if (onPath.has(dir)) return { ok: true, name: 'terminal command', detail: `shim at ${file}` };
      // The default directory need not be on PATH, and a terminal does not look there.
      offPath = offPath || { file, dir };
    }
  }
  if (offPath) {
    return { ok: false, name: 'terminal command', detail: `shim at ${offPath.file}, but ${offPath.dir} is not on PATH; add this line to ~/.zshrc: export PATH="${offPath.dir}:$PATH"` };
  }
  return { ok: false, name: 'terminal command', detail: 'not installed; run placet-research install-cli so serve works in your own terminal' };
}

// Every entry written here carries a name as `By`; without one the write
// refuses, so doctor reports it before the researcher meets the refusal
// mid-write (spec §3).
function checkName() {
  const who = identity.readName(project.projectDir({}));
  return who.name
    ? { ok: true, name: 'name', detail: `entries are written as ${who.name}` }
    : { ok: false, name: 'name', detail: who.error };
}

// Two session markers in a row are allowed (§4) — the first session is then
// empty — but they are usually a second `session start` typed while one was
// running. doctor notes them; it never fails on them.
function checkSessionMarkers() {
  const state = loadState();
  if (state.error) return null;
  const entries = decisions.parseDecisions(state.decisionsText).entries;
  const at = entries.findIndex((e, i) => i > 0 && e.kind === 'SESSION' && entries[i - 1].kind === 'SESSION');
  if (at < 0) return null;
  return { ok: true, note: true, name: 'note', detail: `#${entries[at - 1].seq} and #${entries[at].seq} are two session markers in a row; the first session is empty` };
}

// The key on this machine must verify this clone's log (spec §7): a key from
// another project, or a log that grew under another key, makes every later
// write a chain the other clone reports broken. Only inside a project with a
// key — the project-state check already reports a missing one.
function checkKeyVerifies() {
  const state = loadState();
  if (state.error || state.keyError || !state.key) return null;
  const chain = seal.verifyChain(state.decisionsText, state.key);
  if (chain.status === 'broken' && chain.broken.why === 'key') {
    return { ok: false, name: 'key verifies', detail: 'the key here is not the project\'s: the Seal key line in decisions.md names a different key; run placet-research join with the project key' };
  }
  if (chain.status === 'broken') {
    return { ok: false, name: 'key verifies', detail: `the key here does not verify decisions.md (fails at #${chain.broken.seq}); run placet-research join with the project key` };
  }
  if (chain.verified.size) return { ok: true, name: 'key verifies', detail: 'the key here verifies decisions.md' };
  if (seal.keyLineOf(state.decisionsText)) return { ok: true, name: 'key verifies', detail: 'the key here matches the Seal key line of decisions.md' };
  return { ok: true, name: 'key verifies', detail: 'no sealed entry yet for the key here to verify' };
}

// Notes about the git clone the project sits in (spec §7), never failures: a
// project with one person and no remote is healthy. Outside a git work tree
// there is nothing to say.
function checkGit() {
  const root = project.projectDir({});
  if (childProcess.spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).status !== 0) return [];
  const notes = [];
  const remotes = childProcess.spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (!remotes) notes.push({ ok: true, note: true, name: 'note', detail: 'no git remote; a second clone needs one' });
  const rebase = childProcess.spawnSync('git', ['config', '--get', 'pull.rebase'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (rebase && rebase !== 'false') notes.push({ ok: true, note: true, name: 'note', detail: `pull.rebase is ${rebase} here, so merge-log would refuse after a pull; run git config pull.rebase false` });
  return notes;
}

function doctor() {
  const root = project.projectDir({});
  const checks = [checkPluginEnabled(root), checkGuardDenies(), checkProjectState(), checkName(), checkKeyVerifies(), checkSessionMarkers(), ...checkGit(), checkTerminalCommand()].filter(Boolean);
  const failed = checks.filter((c) => !c.ok);
  say(`placet-research doctor: ${failed.length === 0 ? `ok (${checks.length} checks)` : `${failed.length} of ${checks.length} checks failed`}`);
  for (const c of failed) say(`- ${c.name}: ${c.detail}`);
  for (const c of checks.filter((c) => c.note)) say(`- note: ${c.detail}`);
  return failed.length === 0 ? 0 : 1;
}

// ---------- install-cli ----------

// Claude Code puts the plugin's bin/ on the Bash tool's PATH while the plugin is
// enabled, so the bare command works inside a session — and nowhere else. The
// researcher's own terminal is a different shell with a different PATH, which is
// where `serve` has to run. This writes one small shim into a directory a login
// shell already carries.
//
// The shim holds the resolution itself: it reads the plugin's current install
// path out of installed_plugins.json at every run, so a plugin update — a new
// versioned directory under the cache — leaves it working. Nothing here reads or
// writes the paper project.
function defaultBinDir() {
  return path.join(os.homedir(), '.local', 'bin');
}

function shimText() {
  // A single-quoted program: the shell expands nothing in it, so `$` would be
  // literal there — this text holds none, and no apostrophe either.
  const resolver = [
    'const fs = require("node:fs");',
    'let data;',
    'try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (err) { process.exit(1); }',
    'const entries = data && data.plugins && data.plugins["placet-research@placet-research"];',
    'for (const entry of [].concat(entries || [])) {',
    '  if (entry && typeof entry.installPath === "string" && fs.existsSync(entry.installPath)) {',
    '    process.stdout.write(entry.installPath);',
    '    process.exit(0);',
    '  }',
    '}',
    'process.exit(1);',
  ].join('\n');
  return [
    '#!/bin/sh',
    `${SHIM_MARKER}; do not edit, \`placet-research install-cli\` rewrites it.`,
    '# It finds the plugin from installed_plugins.json at every run, so the shim',
    '# survives the plugin being updated.',
    '',
    'config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "placet-research: node is not on this terminal\'s PATH; install Node.js 20 or newer, or open a shell where node runs."',
    '  exit 1',
    'fi',
    "if ! install_path=$(node -e '",
    resolver,
    '\' "$config/plugins/installed_plugins.json"); then',
    '  echo "placet-research: the plugin is not installed for Claude Code; install it with /plugin install placet-research@placet-research."',
    '  exit 1',
    'fi',
    'exec node "$install_path/bin/placet-research.js" "$@"',
    '',
  ].join('\n');
}

function installCli(flags) {
  const refusal = host.installCliRefusal(process.platform);
  if (refusal) return fail(refusal, 2);
  if (flags.dir !== undefined && typeof flags.dir !== 'string') return fail(`--dir needs a path.\n${USAGE}`, 2);
  const dir = path.resolve(typeof flags.dir === 'string' ? flags.dir : defaultBinDir());
  const target = path.join(dir, SHIM_NAME);
  if (fs.existsSync(target)) {
    let existing = null;
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch (_) {
      existing = null; // unreadable, a directory, or binary: not a shim we wrote
    }
    if (existing === null || !existing.includes(SHIM_MARKER)) {
      return fail(`${target} already exists and is not the shim this command writes; refusing to overwrite it. Remove or rename that file first.`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, shimText(), { mode: 0o755 });
  fs.chmodSync(target, 0o755); // writeFileSync's mode applies only to a new file
  say(`Wrote ${target}.`);
  if ((process.env.PATH || '').split(path.delimiter).includes(dir)) {
    say(`${dir} is on PATH.`);
    return 0;
  }
  say(`${dir} is not on PATH. Add this line to ~/.zshrc:`);
  say(`export PATH="${dir}:$PATH"`);
  return 0;
}

// ---------- entry ----------

function main(argv) {
  // `--help`/`-h` is answered before anything else, on any subcommand: the
  // usage is the whole answer, exit 0, no project looked at and no file
  // touched. With no subcommand at all the usage is also the right answer
  // rather than the refusal an unknown subcommand earns.
  if (argv.includes('--help') || argv.includes('-h')) {
    say(USAGE);
    return 0;
  }
  const { positional, flags } = parseArgs(argv);
  // `--match --why x` gives match the same `true` as a `--match` at the end of
  // the line, so both are refused the same way.
  const bare = Object.keys(flags).find((name) => VALUE_FLAGS.has(name) && flags[name] === true);
  if (bare) return fail(`--${bare} needs a value.\n${USAGE}`, 2);
  const command = positional.shift();
  switch (command) {
    case 'init': return init(flags);
    case 'status': return status(flags);
    case 'review': return review(flags);
    case 'choose': return choose(positional, flags);
    case 'accept': return accept(positional, flags);
    case 'glossary': return glossaryCommand(positional, flags);
    case 'log': return log(positional, flags);
    case 'title': return title(positional);
    case 'profile': return profile(positional);
    case 'name': return name(positional);
    case 'key': return keyCommand(positional, flags);
    case 'join': return join(flags);
    case 'merge-log': return mergeLog(flags, argv);
    case 'session': return session(positional, flags);
    case 'agenda': return agenda(flags);
    case 'serve': return serve(flags);
    case 'doctor': return doctor();
    case 'install-cli': return installCli(flags);
    case undefined:
      say(USAGE);
      return 0;
    default: return fail(USAGE, 2);
  }
}

// readIfExists lets every error but ENOENT through, so a canvas that exists but
// cannot be read (EACCES, EISDIR, ELOOP, ...) reaches this point as the
// operating system's error. That is the right answer and it belongs on one
// line, not in a stack trace: the researcher needs the file and the code, and
// "not a paper project" would be a lie. Anything that is not a filesystem
// error is a bug and keeps its trace. EISDIR arrives from `read`, not `open`,
// and carries no path; the state directory is the closest name there is.
// Lock contention is an expected refusal, not a programming error. Keep this
// narrow boundary separate from the existing filesystem-error handling.
function mainWithAppendRefusal(argv) {
  try {
    return main(argv);
  } catch (err) {
    if (err && err.code === 'RH_APPEND_BUSY') return fail(err.message);
    throw err;
  }
}

function run(argv) {
  try {
    return mainWithAppendRefusal(argv);
  } catch (err) {
    if (err && err.code && err.syscall) {
      const where = err.path || `a state file in ${project.stateDir(project.projectDir({}))}`;
      return fail(`Cannot read ${where} (${err.code}). Restore access to the file and run the command again.`);
    }
    throw err;
  }
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

// `run`, not `main`: the bare `bin/placet-research` is a one-line door to this
// file and every entry has to answer alike, filesystem errors included.
module.exports = { main, run, replaceMarker: stateLib.replaceMarker };
