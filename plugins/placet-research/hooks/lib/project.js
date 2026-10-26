'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANVAS_FILE = 'canvas.md';
const DECISIONS_FILE = 'decisions.md';
const GLOSSARY_FILE = 'glossary.md';

// The plugin knows no root. Claude Code sets CLAUDE_PROJECT_DIR; hook stdin
// carries cwd; process.cwd() is the last resort for the CLI.
function projectDir(data) {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    (data && typeof data.cwd === 'string' ? data.cwd : '') ||
    process.cwd()
  );
}

function stateDir(projectRoot) {
  const configured = process.env.PLACET_RESEARCH_DIR || 'research';
  return path.resolve(projectRoot, configured);
}

// A variant canvas is a full state directory of its own under
// research/variants/<name>/: its own canvas.md and its own decisions.md, so
// its log records that framing's decisions in a separate chain. Each log has
// its own append lock. The name becomes a directory, so it is held to
// a shape no path can escape from.
const VARIANTS_DIR = 'variants';
const VARIANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isVariantName(name) {
  return typeof name === 'string' && VARIANT_NAME_RE.test(name);
}

function variantsDir(projectRoot) {
  return path.join(stateDir(projectRoot), VARIANTS_DIR);
}

// The state directory a write means: the main one, or a variant's. A name
// that is not a variant name is thrown at, never joined into a path.
function stateDirOf(projectRoot, variant) {
  if (variant === undefined || variant === null) return stateDir(projectRoot);
  if (!isVariantName(variant)) throw new Error(`not a variant name: ${JSON.stringify(variant)}`);
  return path.join(variantsDir(projectRoot), variant);
}

function canvasPath(projectRoot, variant) {
  return path.join(stateDirOf(projectRoot, variant), CANVAS_FILE);
}

function decisionsPath(projectRoot, variant) {
  return path.join(stateDirOf(projectRoot, variant), DECISIONS_FILE);
}

// The glossary belongs to the state directory it sits beside, so a variant
// framing reads its own definitions instead of the main file's (glossary
// design, § Entry format and references).
function glossaryPath(projectRoot, variant) {
  return path.join(stateDirOf(projectRoot, variant), GLOSSARY_FILE);
}

// The variants that exist: a directory under variants/ with a valid name and a
// canvas.md in it, sorted so every caller lists them in one order.
function variantNames(projectRoot) {
  let entries;
  try {
    entries = fs.readdirSync(variantsDir(projectRoot), { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && isVariantName(e.name) && fs.existsSync(canvasPath(projectRoot, e.name)))
    .map((e) => e.name)
    .sort();
}

// "Absent" and "unreadable" are different answers and only the first one is
// safe to read as an empty file. A caller that cannot tell them apart judges an
// overwrite as a creation, which is how a chmod 000 canvas ends up writable.
// ENOENT — including a dangling symlink, which reports the same — is absence;
// EACCES, EPERM, EISDIR, ELOOP and the rest propagate to a caller that must
// decide what an unreadable file means for it.
function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

module.exports = {
  CANVAS_FILE,
  DECISIONS_FILE,
  GLOSSARY_FILE,
  VARIANTS_DIR,
  projectDir,
  stateDir,
  stateDirOf,
  variantsDir,
  isVariantName,
  variantNames,
  canvasPath,
  decisionsPath,
  glossaryPath,
  readIfExists,
};
