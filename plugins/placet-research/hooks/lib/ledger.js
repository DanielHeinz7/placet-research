'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The ledger remembers, per project and per session, the highest decision
// sequence already injected. It is transient, per machine, and never part of
// the paper (§5.2) — so it lives outside the repository. Tests override it.
function stateRoot() {
  return process.env.PLACET_RESEARCH_STATE_DIR || movedFromLegacyName(path.join(os.homedir(), '.claude'));
}

// Before 0.7.0 the plugin was called research-harness and kept its state, the
// sealing key among it, under that name. The first call after the rename moves
// it, so existing logs still verify. A move that fails because another process
// moved it first finds the new root; any other failure keeps the old one.
function movedFromLegacyName(claudeDir) {
  const root = path.join(claudeDir, 'placet-research');
  const legacy = path.join(claudeDir, 'research-harness');
  if (fs.existsSync(root) || !fs.existsSync(legacy)) return root;
  try {
    fs.renameSync(legacy, root);
  } catch (_) {
    return fs.existsSync(root) ? root : legacy;
  }
  return root;
}

// Project paths and session ids both end up as file names; hashing keeps them
// out of the file system and gives every entry the same shape.
function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

// One directory per project under the state root, shared with the sealing key
// (seal.js). Named by the real path, so a symlinked checkout of the same
// project finds the same directory.
function projectStateDir(projectRoot) {
  let real;
  try {
    real = fs.realpathSync(projectRoot);
  } catch (_) {
    real = path.resolve(projectRoot);
  }
  return path.join(stateRoot(), digest(real));
}

function ledgerFile(projectRoot, sessionId) {
  return path.join(projectStateDir(projectRoot), `${digest(sessionId)}.json`);
}

function readSeen(projectRoot, sessionId) {
  if (!sessionId) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(ledgerFile(projectRoot, sessionId), 'utf8'));
    return Number.isInteger(data.seenSeq) ? data.seenSeq : 0;
  } catch (_) {
    return 0;
  }
}

function writeSeen(projectRoot, sessionId, seenSeq) {
  if (!sessionId || !Number.isInteger(seenSeq)) return;
  try {
    const file = ledgerFile(projectRoot, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seenSeq }));
  } catch (_) {
    // The ledger is an optimization. Failing to write it must never affect a
    // hook: the worst case is that a decision is injected twice.
  }
}

module.exports = { stateRoot, projectStateDir, readSeen, writeSeen };
