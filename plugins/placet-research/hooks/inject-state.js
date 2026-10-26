#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const project = require('./lib/project');
const canvas = require('./lib/canvas');
const numbers = require('./lib/numbers');
const profileLib = require('./lib/profile');
const { mechanicalReview, ledgerSummary } = require('./lib/review');
const { parseDecisions } = require('./lib/decisions');
const ledger = require('./lib/ledger');
const seal = require('./lib/seal');
const output = require('./lib/output');

// The four writing rules, restated once per session because the model reads
// them once per session (§5.2). The guard enforces them; this only states them.
const RULES = [
  'Rules for research/canvas.md: write only [proposed], [tentative], or [stated] as a transcription of what the researcher said.',
  'Never write [accepted]. Never alter or remove a [stated] or [accepted] statement — propose alongside as [proposed].',
  'Factual claims carry `src: <id>` or `unverified`, never nothing. An empty element is fine; plausible filler is not.',
  'Only the researcher accepts, via /placet-research:accept <n.m> --explained "<their sentence>"; never draft that sentence for them. Skills: /placet-research:canvas, /placet-research:canvas-review.',
].join(' ');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) || {} : {};
  } catch (_) {
    return {};
  }
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
}

// The desktop app asks for a marker to show that the plugin's hooks are loaded
// in its Claude Code session (spec 2026-10-15-desktop-app-claude-code §5.4).
// Without the variable nothing changes. A marker that cannot be written is the
// app's problem to report, never a reason to stop the session.
function writeAppMarker() {
  const file = process.env.PLACET_RESEARCH_APP_MARKER;
  if (!file || !path.isAbsolute(file)) return;
  try {
    const root = pluginRoot();
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version || null; } catch (_) { /* no version to report */ }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pluginRoot: root, version, pid: process.pid }));
    fs.renameSync(tmp, file);
  } catch (_) {
    // Fail open, as the summary does.
  }
}

// Returns { text, maxSeq } or null when there is nothing to inject. Exported
// so `placet-research status` (Task 8) prints the same summary the session
// was given; two renderings of the same state would drift.
//
// `key` is the sealing key this run verifies with, when the caller has one:
// `status --key <file>` hands the reviewer the authors' released key, so the
// ledger line is judged with it instead of the key this machine would read
// (§4.7). Left undefined, the key is read here, as the hook reads it. Nothing
// below writes, so a released key cannot reach the append path through it.
function summarize(projectRoot, { seenSeq = 0, variant, key: releaseKey = undefined } = {}) {
  const canvasText = project.readIfExists(project.canvasPath(projectRoot, variant));
  if (canvasText === null) return null;
  const parsed = canvas.parseCanvas(canvasText);
  if (!parsed.elements.length) return null;

  const fm = parsed.frontmatter;
  const profileId = fm.profile || 'is-qualitative';
  let profileNote = `profile ${profileId}`;
  let graph = null;
  try {
    graph = profileLib.loadProfile(profileId, pluginRoot()).graph;
  } catch (_) {
    // A profile the plugin does not ship is the researcher's business, not a
    // reason to say nothing: report the rest and name what went unchecked.
    profileNote = `profile ${profileId} (not found; dependencies not checked)`;
  }

  const decisionsText = project.readIfExists(project.decisionsPath(projectRoot, variant)) || '';
  let key = releaseKey;
  if (key === undefined) {
    key = null;
    try {
      key = seal.readKey(projectRoot);
    } catch (_) {
      // A key this hook cannot read is the same as none: the ledger reads as
      // unverifiable here, which is the honest word for it.
    }
  }
  const report = mechanicalReview({ parsed, graph, decisionsText, key });
  const log = parseDecisions(decisionsText);

  const statusLine = parsed.elements
    .map((e) => {
      const s = report.statuses[e.number];
      // The count names what it counts. An open element holds only proposals,
      // so its count is not "in addition to" anything and takes no plus sign;
      // `1 open (+1 open)` read as two different words for the same thing.
      const proposals = s.open ? ` (${s.status === 'open' ? '' : '+'}${s.open} proposal${s.open === 1 ? '' : 's'})` : '';
      return `${e.number} ${s.status}${proposals}`;
    })
    .join(' · ');
  const list = (arr) => (arr.length ? arr.join(', ') : 'none');
  const unseen = log.entries.filter((e) => e.seq > seenSeq);
  const unseenLine = unseen.length ? unseen.map((e) => `#${e.seq} ${e.kind} ${e.ref}`).join('; ') : 'none';
  const violationLine = report.violations.length
    ? report.violations
        .map((v) => `${v.element} accepted but ${v.missing.map((m) => `${m.element} is ${m.status}`).join(', ')}`)
        .join('; ')
    : 'none';
  const staleLine = report.staleAcceptances.length ? report.staleAcceptances.map((s) => `#${s.seq}`).join(', ') : 'none';
  const hiddenLine = report.invisibleCommitments.length
    ? report.invisibleCommitments.map((s) => s.question).join(', ')
    : 'none';

  // At most 20 numbers, so a canvas full of proposals stays inside the 4 KiB budget.
  const proposalNums = numbers.openProposalNumbers(parsed);
  const proposalLine = proposalNums.length
    ? proposalNums.slice(0, 20).join(', ') + (proposalNums.length > 20 ? `, +${proposalNums.length - 20} more` : '')
    : 'none';

  const text = [
    `placet-research · paper project "${fm.project || '?'}"${variant !== undefined ? ` · variant ${variant} (lens: ${fm.lens || '?'})` : ''} · ${profileNote} · mode ${fm.mode || '?'}`,
    `Elements: ${statusLine}`,
    `Empty: ${list(report.empty)} · Open (proposals only): ${list(report.open)}`,
    `Dependency violations: ${violationLine} · Stale acceptances: ${staleLine} · Ledger: ${ledgerSummary(report.ledger)}`,
    `Committed but not visible in the rendered canvas: ${hiddenLine}`,
    `Decisions not yet seen: ${unseenLine}`,
    `Open proposals by number (cite statements as 3.1 or 3.1b): ${proposalLine}`,
    RULES,
  ].join('\n');
  return { text, maxSeq: log.maxSeq };
}

function main() {
  try {
    writeAppMarker();
    const data = readStdin();
    const projectRoot = project.projectDir(data);
    const sessionId = typeof data.session_id === 'string' ? data.session_id : '';
    const summary = summarize(projectRoot, { seenSeq: ledger.readSeen(projectRoot, sessionId) });
    if (!summary) return;
    ledger.writeSeen(projectRoot, sessionId, summary.maxSeq);
    output.writeContext('SessionStart', summary.text);
  } catch (_) {
    // Fail open: a hook must never stop a prompt (§5.2). A canvas this parser
    // cannot read means no injection, not a broken session.
  }
}

if (require.main === module) main();

module.exports = { summarize, RULES };
