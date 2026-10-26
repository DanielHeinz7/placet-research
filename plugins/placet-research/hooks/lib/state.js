'use strict';

const path = require('node:path');

const project = require('./project');
const canvas = require('./canvas');
const { parseDecisions } = require('./decisions');
const identity = require('./identity');
const profileLib = require('./profile');
const seal = require('./seal');
const lineEndings = require('./line-endings');
const { textHash } = require('./hash');

function defaultPluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..', '..');
}

// The project state every write reads first. The CLI and the session server
// both call this in-process, so there is one reading of the files. `variant`
// reads a variant's state directory instead of the main one; the sealing key
// is the project's either way, since it belongs to the root.
function loadState(root, { pluginRoot, variant } = {}) {
  if (variant !== undefined && !project.isVariantName(variant)) {
    return { root, error: `--variant takes a name of lowercase letters, digits and hyphens, not ${JSON.stringify(variant)}.`, code: 'invalid' };
  }
  const paths = {
    canvas: project.canvasPath(root, variant),
    decisions: project.decisionsPath(root, variant),
    glossary: project.glossaryPath(root, variant),
  };
  const canvasText = project.readIfExists(paths.canvas);
  if (canvasText === null) {
    if (variant !== undefined) {
      return { root, paths, error: `There is no variant "${variant}": no ${path.relative(root, paths.canvas)}. Create it with placet-research init --variant ${variant} --lens "<text>".`, code: 'not-found' };
    }
    return {
      root,
      paths,
      error: `This is not a paper project: no ${path.relative(root, paths.canvas) || 'research/canvas.md'}. Run placet-research init first.`,
      code: 'not-found',
    };
  }
  const parsed = canvas.parseCanvas(canvasText);
  const decisionsText = project.readIfExists(paths.decisions) || '';
  for (const [file, text] of [[paths.canvas, canvasText], [paths.decisions, decisionsText]]) {
    const line = lineEndings.firstCrlfLine(text);
    if (line) return { root, paths, error: lineEndings.crlfRefusal(path.relative(root, file), line), code: 'line-endings' };
  }
  // Where the project's key is named: the main log. A variant's log carries no
  // `Seal key:` line of its own — the key belongs to the root — so a write to a
  // variant asks the main log the same questions (SQ-294).
  const keyLineFile = variant === undefined ? paths.decisions : project.decisionsPath(root);
  const keyLineText = variant === undefined ? decisionsText : (project.readIfExists(keyLineFile) || '');
  let graph = null;
  let checks = [];
  let profileError = null;
  try {
    const loaded = profileLib.loadProfile(parsed.frontmatter.profile || 'is-qualitative', pluginRoot || defaultPluginRoot());
    graph = loaded.graph;
    checks = loaded.checks;
  } catch (err) {
    profileError = err.message;
  }
  // No key is the normal state of a fresh clone; a key that exists and cannot
  // be read is reported, not hidden behind "no key".
  let key = null;
  let keyError = null;
  try {
    key = seal.readKey(root);
  } catch (err) {
    keyError = `the sealing key at ${seal.keyPath(root)} exists but cannot be read (${(err && err.code) || 'unknown error'})`;
  }
  // The name every entry written from this machine carries as `By` (§3). Read
  // here, once, so the CLI and the view write the same name and neither holds
  // a second reading of where it comes from.
  const who = identity.readName(root);
  return { root, variant, paths, canvasText, parsed, decisionsText, keyLineFile, keyLineText, graph, checks, profileError, key, keyError, by: who.name, nameError: who.error || null };
}

// Whether the project's key is held on another machine: a log carries a seal,
// or the main log names one in its `Seal key:` line (SQ-286). A variant's log
// has neither of its own — the key belongs to the root — so the main log
// answers for it too (SQ-294). init refuses in exactly these cases, so every
// message that would send the researcher to init asks this first.
function keyHeldElsewhere(state) {
  const sealed = [state.decisionsText, state.keyLineText].some((text) => parseDecisions(text).entries.some((e) => e.seal !== null));
  return sealed || seal.keyLineOf(state.keyLineText) !== null;
}

// Why the ledger cannot take a new entry right now, or null. Checked before
// the canvas is touched, so a refusal leaves nothing half-done.
function ledgerRefusal(state) {
  const refuse = (error) => ({ error, code: 'ledger' });
  if (state.keyError) return refuse(`${state.keyError}; nothing is written.`);
  if (!state.key) {
    return refuse(keyHeldElsewhere(state)
      ? 'No sealing key for this project on this machine, and the project\'s key is held elsewhere; nothing is written. Get the project key from whoever holds it and run placet-research join --key-file <file> --name "<your name>". Do not run init: a new key would make the log read as broken.'
      : 'No sealing key for this project on this machine, so nothing is written: an entry counts only if it verifies (§4.7). Run `placet-research init --project <slug> --mode <mode>` once here to create the key, then retry.');
  }
  // A variant's log has no `Seal key:` line of its own to fail on, so a variant
  // write is checked against the main log's line, in the main log's words.
  if (state.variant !== undefined) {
    const named = seal.keyLineOf(state.keyLineText);
    if (named && named.fingerprint !== seal.keyFingerprint(state.key)) {
      return refuse(`The sealing key on this machine is not the project's: the Seal key line in ${path.relative(state.root, state.keyLineFile)} names a different key; nothing is written. Get the project's key from the person who shared the project and join with it.`);
    }
  }
  const chain = seal.verifyChain(state.decisionsText, state.key);
  if (chain.status === 'broken' && chain.broken.why === 'key') {
    return refuse(`The sealing key on this machine is not the project's: the Seal key line in ${path.relative(state.root, state.paths.decisions)} names a different key; nothing is written. Get the project's key from the person who shared the project and join with it.`);
  }
  if (chain.status === 'broken') {
    return refuse(`${path.relative(state.root, state.paths.decisions)} is broken at #${chain.broken.seq} (line ${chain.broken.line}); nothing is written. The harness never repairs a ledger — run placet-research review, then decide which version is true.`);
  }
  // Last, so every message about the key and the chain reads as it did before
  // a name was required: an entry no one is named in is not an entry this tool
  // writes, and a name is set once for the machine (spec §3).
  if (!state.by) return { error: `${state.nameError}; nothing is written.`, code: 'name' };
  return null;
}

// The statement a write from the view means: the one in this question whose
// text hash is the one the view saw. Returns the matches (any marker), so the
// caller decides what "gone", "twice" and "already done" mean for its write.
function statementsByHash(parsed, questionId, expectedHash, match) {
  const question = findQuestion(parsed, questionId).question;
  if (!question) return [];
  return question.statements.filter((s) => textHash(s.text) === expectedHash
    && (typeof match !== 'string' || s.text.includes(match)));
}

function findQuestion(parsed, questionId) {
  const element = parsed.elements.find((e) => e.questions.some((q) => q.id === questionId));
  const question = element ? element.questions.find((q) => q.id === questionId) : null;
  return { element, question };
}

// Only the marker changes; the evidence tags the researcher put on the
// statement are the statement's, not the acceptance's.
function replaceMarker(raw, newMarker) {
  return raw.replace(/\[([^[\]]+)\]\s*$/, (_, group) => {
    const parts = group.split(',').map((p) => p.trim()).filter(Boolean);
    parts[0] = newMarker;
    return `[${parts.join(', ')}]`;
  });
}

// Rewrites one statement's lines in the canvas text with a new marker.
function withMarker(canvasText, statement, marker) {
  const lines = canvasText.split('\n');
  const replaced = replaceMarker(statement.raw, marker);
  lines.splice(statement.line - 1, statement.raw.split('\n').length, ...replaced.split('\n'));
  return lines.join('\n');
}

const QUESTION_ID = /^[1-9]\.\d+$/;

module.exports = { loadState, ledgerRefusal, keyHeldElsewhere, findQuestion, statementsByHash, replaceMarker, withMarker, QUESTION_ID, defaultPluginRoot };
