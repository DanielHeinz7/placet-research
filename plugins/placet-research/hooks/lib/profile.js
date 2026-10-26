'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { elementStatus } = require('./canvas');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const BLOCK_RE = /```graph\n([\s\S]*?)```/;
const LINE_RE = /^([1-9])\s*<-\s*(.*)$/;

// A profile is prose with one machine-readable part: the fenced ```graph
// block. Everything else in the file is for the researcher to read and
// dispute (§4.5); only these lines are parsed.
function parseGraph(markdown) {
  const block = BLOCK_RE.exec(String(markdown));
  if (!block) throw new Error('profile has no ```graph block');
  const graph = {};
  for (let n = 1; n <= 9; n += 1) graph[n] = [];
  for (const rawLine of block[1].split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) throw new Error(`bad graph line: ${line}`);
    const from = Number(m[1]);
    const deps = m[2].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    for (const d of deps) {
      if (!Number.isInteger(d) || d < 1 || d > 9) throw new Error(`bad dependency in: ${line}`);
      if (d === from) throw new Error(`element ${from} depends on itself`);
    }
    graph[from] = deps;
  }
  return graph;
}

const CHECKS_RE = /```checks\n([\s\S]*?)```/;
const KNOWN_CHECKS = ['hypotheses-before-data'];

// The second machine-readable part of a profile, and an optional one: the
// mechanical checks its modules add to the review. A name the review does not
// know is an error on load, not a check that silently never runs.
function parseChecks(markdown) {
  const block = CHECKS_RE.exec(String(markdown));
  if (!block) return [];
  const names = block[1].split('\n').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    if (!KNOWN_CHECKS.includes(name)) throw new Error(`unknown check: ${name}`);
  }
  return names;
}

function loadProfile(id, pluginRoot) {
  if (!ID_RE.test(String(id))) throw new Error(`invalid profile id: ${id}`);
  const file = path.join(pluginRoot, 'references', 'profiles', `${id}.md`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    throw new Error(`profile not found: ${id}`);
  }
  return { id, graph: parseGraph(text), checks: parseChecks(text), text };
}

// An element that appears twice has *no* status — not the status of whichever
// heading came last (§4.2). The loop that simply assigned into the map is what
// let SQ-21's S15 append a second `# 1 · …` heading and have element 1 report
// `empty` while it still held the researcher's accepted statement. A duplicate
// is a detected condition here and a problem on the parse, never a silent
// overwrite.
function statusByNumber(parsed) {
  const map = {};
  const seen = new Set();
  for (const el of parsed.elements) {
    if (seen.has(el.number)) {
      map[el.number] = { status: 'duplicate', open: 0, duplicate: true };
      continue;
    }
    seen.add(el.number);
    map[el.number] = elementStatus(el);
  }
  return map;
}

// Rule (§4.6): an element may not be accepted while a dependency is not.
function dependencyViolations(parsed, graph) {
  const statuses = statusByNumber(parsed);
  const out = [];
  for (const el of parsed.elements) {
    if (statuses[el.number].status !== 'accepted') continue;
    const missing = (graph[el.number] || [])
      .map((d) => ({ element: d, status: statuses[d] ? statuses[d].status : 'missing' }))
      .filter((d) => d.status !== 'accepted');
    if (missing.length) out.push({ element: el.number, missing });
  }
  return out;
}

module.exports = { parseGraph, parseChecks, KNOWN_CHECKS, loadProfile, dependencyViolations, statusByNumber };
