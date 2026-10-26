'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { normalizeText } = require('./canvas');
const decisions = require('./decisions');
const lineEndings = require('./line-endings');
const { projectStateDir } = require('./ledger');

// The tamper-evident chain over decisions.md (§4.7). This is not the session
// ledger in ledger.js, which is a transient optimization that may fail
// silently; this is durable, part of the paper, and fails closed.
//
// seal(n) = HMAC-SHA-256(key, seal(n-1) ␟ seq ␟ date ␟ kind ␟ ref ␟ text-hash ␟ normalize(body))
//
// truncated to 16 hex. The key is what makes an *append* unforgeable: a plain
// hash chain can be extended by anyone who can read the log. The first sealed
// entry chains onto the SHA-256 of every byte before it, so a legacy block
// without seals cannot be rewritten quietly either.

const KEY_FILE = 'seal.key';
const KEY_BYTES = 32;
const KEY_CHARS = KEY_BYTES * 2;
const SEAL_HEX = 16;
const HEX_KEY = /^[0-9a-f]+$/i;
const UNIT = '';

function keyPath(projectRoot) {
  return path.join(projectStateDir(projectRoot), KEY_FILE);
}

// null means no key on this machine, which is the normal state of a fresh
// clone; anything else that goes wrong reading the key propagates.
function readKey(projectRoot) {
  let hex;
  try {
    hex = fs.readFileSync(keyPath(projectRoot), 'utf8').trim();
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (hex.length !== KEY_CHARS || !HEX_KEY.test(hex)) {
    throw new Error(`the key file ${keyPath(projectRoot)} is not a ${KEY_BYTES}-byte key (${KEY_CHARS} hex characters, as ${KEY_FILE} holds it); nothing was verified against it.`);
  }
  return Buffer.from(hex, 'hex');
}

// The key as a released file: `--key <file>` is how a reviewer who never held
// the key confirms the chain (§4.7). The file is the one createKey writes, 64
// hex characters; anything else is refused rather than decoded into a short
// key, which would report a sound log as BROKEN. Both refusals are one line,
// and neither is a reason to judge a chain.
function readKeyFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`the key file ${file} cannot be read (${(err && err.code) || 'unknown error'}); nothing was verified against it.`);
  }
  const hex = text.trim();
  if (hex.length !== KEY_CHARS || !HEX_KEY.test(hex)) {
    throw new Error(`the key file ${file} is not a ${KEY_BYTES}-byte key (${KEY_CHARS} hex characters, as ${KEY_FILE} holds it); nothing was verified against it.`);
  }
  return Buffer.from(hex, 'hex');
}

// Creates the key once. A second call keeps what is there: replacing the key
// would silently break every seal already written with the old one.
function createKey(projectRoot) {
  const file = keyPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, crypto.randomBytes(KEY_BYTES).toString('hex'), { mode: 0o600, flag: 'wx' });
    return { path: file, created: true };
  } catch (err) {
    if (err && err.code === 'EEXIST') return { path: file, created: false };
    throw err;
  }
}

function anchorOf(prefix) {
  return crypto.createHash('sha256').update(prefix, 'utf8').digest('hex');
}

// The `Seal key:` line init writes under the log's title (SQ-286). It names the
// key the log was started with, so a wrong key is caught on a log that has no
// seal yet to recompute. The value is a keyed hash over a fixed label, 64 bits
// of it, and gives nothing away about the key. Only the text above #1 counts:
// an entry body cannot claim a key for the log.
const KEY_LABEL = 'placet-research seal key';
const KEY_LINE_RE = /^Seal key: ([0-9a-f]{16})$/m;
// What every refusal of a 'key' break says, in one wording.
const WRONG_KEY = 'this key is not the project\'s: the Seal key line in decisions.md names a different key';

function keyFingerprint(key) {
  return crypto.createHmac('sha256', key).update(KEY_LABEL, 'utf8').digest('hex').slice(0, SEAL_HEX);
}

function keyLine(key) {
  return `Seal key: ${keyFingerprint(key)}`;
}

// The fingerprint the log names and the line it sits on, or null.
function keyLineOf(text) {
  const source = String(text || '');
  const first = decisions.parseDecisions(source).entries[0];
  const above = first ? source.slice(0, first.offset) : source;
  const m = KEY_LINE_RE.exec(above);
  return m ? { fingerprint: m[1], line: above.slice(0, m.index).split('\n').length } : null;
}

// The log with a `Seal key:` line added under its title, or null when it gets
// none: it names a key already, or a sealed entry anchors on the bytes above
// #1, so adding a line now would break the chain. Only for a log the given key
// is known to belong to (init, key export).
function withKeyLine(text, key) {
  const source = String(text || '');
  if (!source || keyLineOf(source)) return null;
  const { entries } = decisions.parseDecisions(source);
  if (entries.some((e) => e.seal !== null)) return null;
  if (entries.length && entries[0].offset === 0) return `${keyLine(key)}\n\n${source}`;
  const nl = source.indexOf('\n');
  const title = nl < 0 ? source : source.slice(0, nl);
  const rest = nl < 0 ? '' : source.slice(nl + 1);
  return `${title}\n\n${keyLine(key)}\n${rest && !rest.startsWith('\n') ? '\n' : ''}${rest}`;
}

// The head of the record as one line, for the reviewer who compares what they
// received with what the authors published: the last seal, the highest
// sequence number, and the SHA-256 of decisions.md as received. It needs no
// key — it is the fingerprint of the received bytes, and every part of it
// moves when a byte moves. Its worth lies in having been published *earlier*
// (a tag, the submission): an anchor printed now matches a rewritten log too,
// so the copy a third party kept is what catches a rewrite.
function logAnchor(text) {
  const source = String(text || '');
  const { entries, maxSeq } = decisions.parseDecisions(source);
  const sealed = entries.filter((e) => e.seal !== null);
  const lastSeal = sealed.length ? sealed[sealed.length - 1].seal : 'none';
  const digest = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
  return `last seal ${lastSeal}, maxSeq ${maxSeq}, decisions.md sha256 ${digest}`;
}

function sealOf(key, previousSeal, entry) {
  const canonical = [
    previousSeal,
    String(entry.seq),
    entry.date,
    entry.kind,
    entry.ref,
    entry.hash || '',
    normalizeText(entry.body || ''),
  ].join(UNIT);
  return crypto.createHmac('sha256', key).update(canonical, 'utf8').digest('hex').slice(0, SEAL_HEX);
}

function result(status, reason, legacy, broken, verified) {
  return { status, reason, legacy, broken, verified };
}

// Three outcomes, kept apart because they mean different things (§4.7):
// verified (every seal recomputes), unverifiable (no key here, or a log that
// predates the seal), broken (a seal does not recompute, or an unsealed entry
// follows a sealed one). `broken` names the first failing entry and why:
// 'unsealed', 'anchor' (the first sealed entry — its own content or the legacy
// block before it changed), 'chain' (entries are missing before it),
// 'content' (its own heading or body changed), or 'key' (seq 0: the given key
// is not the one the log's `Seal key:` line names, so no entry counts under
// it). `verified` holds the sequence numbers whose seals recomputed, which is
// what gives an acceptance cover.
function verifyChain(text, key) {
  const source = String(text || '');
  // Checked before the empty-log shortcut: a header-only CRLF log is not
  // "verified", because the first seal appended to it would anchor on CR bytes.
  const crlf = lineEndings.firstCrlfLine(source);
  if (crlf) {
    const first = decisions.parseDecisions(source.replace(/\r\n/g, '\n')).entries[0];
    return result('broken', null, [], { seq: first ? first.seq : 0, line: crlf, why: 'line-endings' }, new Set());
  }
  const { entries } = decisions.parseDecisions(source);
  const verified = new Set();
  const firstSealed = entries.findIndex((e) => e.seal !== null);
  const legacy = (firstSealed < 0 ? entries : entries.slice(0, firstSealed)).map((e) => e.seq);
  // Before the empty-log shortcut too: an empty log is where a wrong key has
  // no seal to fail on, and the line is what tells it apart (SQ-286).
  const named = key ? keyLineOf(source) : null;
  if (named && named.fingerprint !== keyFingerprint(key)) {
    return result('broken', null, legacy, { seq: 0, line: named.line, why: 'key' }, verified);
  }
  if (!entries.length) return result('verified', null, [], null, verified);
  if (firstSealed < 0) return result('unverifiable', 'legacy', legacy, null, verified);

  let previous = anchorOf(source.slice(0, entries[firstSealed].offset));
  for (let k = firstSealed; k < entries.length; k += 1) {
    const e = entries[k];
    if (e.seal === null) return result('broken', null, legacy, { seq: e.seq, line: e.line, why: 'unsealed' }, verified);
    if (!key) continue;
    if (sealOf(key, previous, e) !== e.seal) {
      const why = k === firstSealed ? 'anchor' : e.seq !== entries[k - 1].seq + 1 ? 'chain' : 'content';
      return result('broken', null, legacy, { seq: e.seq, line: e.line, why }, verified);
    }
    verified.add(e.seq);
    previous = e.seal;
  }
  if (!key) return result('unverifiable', 'no-key', legacy, null, verified);
  return result('verified', null, legacy, null, verified);
}

// The seal an append to `current` chains onto: the last seal there is, or for
// a log that has none yet, the anchor over every byte the new entry follows.
function lastSealOf(current) {
  const sealed = decisions.parseDecisions(current).entries.filter((e) => e.seal !== null);
  return sealed.length ? sealed[sealed.length - 1].seal : anchorOf(current + decisions.separatorAfter(current));
}

// One sealed entry as text, without touching a file. The body under seal is
// what the parser will read back, so it is taken from a parse of the
// formatted draft rather than assembled twice.
function sealEntry(previousSeal, fields, key) {
  const draft = decisions.formatEntry({ ...fields, seal: undefined });
  const entry = decisions.parseDecisions(draft).entries[0];
  const s = sealOf(key, previousSeal, entry);
  return { text: decisions.formatEntry({ ...fields, seal: s }), seal: s };
}

// Locks live outside research/: they are machine-local, never paper artifacts.
function appendLockPath(filePath) {
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    real = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  }
  const digest = crypto.createHash('sha256').update(real).digest('hex');
  return path.join(os.tmpdir(), `rh-append-${digest}.lock`);
}

function removeAppendLock(file, owned) {
  try {
    const current = fs.statSync(file);
    if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function createAppendLock(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
  const owned = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
    return owned;
  } catch (err) {
    removeAppendLock(file, owned);
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

function appendLockPid(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.pid;
  } catch (err) {
    if (err instanceof SyntaxError) return null; // Owner may still be writing its pid.
    throw err;
  }
}

function appendLockOwnerDead(file) {
  const pid = appendLockPid(file);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH'; // EPERM is not evidence of a dead owner.
  }
}

function reclaimAppendLock(file) {
  try {
    const held = fs.statSync(file);
    if (Date.now() - held.mtimeMs <= 30000 && !appendLockOwnerDead(file)) return false;
    // shortcut: the 30-second stale lease assumes an append finishes within it;
    // inode checks avoid removing a replacement already observed at this path.
    removeAppendLock(file, held);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function waitForAppendLock(deadline, sleeper) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    const err = new Error('decisions.md is being written by another placet-research process; nothing was appended — try again');
    err.code = 'RH_APPEND_BUSY';
    throw err;
  }
  Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
}

function acquireAppendLock(file) {
  const deadline = Date.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let reclaimed = false;
  while (true) {
    const owned = createAppendLock(file);
    if (owned) return owned;
    if (!reclaimed && reclaimAppendLock(file)) {
      reclaimed = true;
      continue;
    }
    waitForAppendLock(deadline, sleeper);
  }
}

// The one append path. It refuses to seal a DECISION unless the caller is the
// approval path, refuses without a key, and refuses to extend a broken chain:
// the harness never repairs a ledger, and appending to a broken one would bury
// the break under entries that verify.
function sealedAppend(filePath, fields, key, { decision = false } = {}) {
  if (fields.kind === 'DECISION' && !decision) {
    throw new Error('the append path does not seal a DECISION: an acceptance is the researcher\'s act, via placet-research accept');
  }
  if (!key) throw new Error('no sealing key for this project on this machine; on a log sealed elsewhere run placet-research join, on a new project placet-research init');
  const lock = appendLockPath(filePath);
  const owned = acquireAppendLock(lock);
  try {
    let current = '';
    try {
      current = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const chain = verifyChain(current, key);
    if (chain.status === 'broken' && chain.broken.why === 'key') throw new Error(`${WRONG_KEY}; nothing is appended`);
    if (chain.status === 'broken') {
      throw new Error(`decisions.md is broken at #${chain.broken.seq} (line ${chain.broken.line}, ${chain.broken.why}); nothing is appended to a broken ledger`);
    }
    const seq = decisions.parseDecisions(current).maxSeq + 1;
    const { text, seal: s } = sealEntry(lastSealOf(current), { ...fields, seq }, key);
    decisions.appendEntry(filePath, text);
    return { seq, seal: s };
  } finally {
    removeAppendLock(lock, owned);
  }
}

module.exports = { KEY_FILE, WRONG_KEY, keyPath, readKey, readKeyFile, createKey, anchorOf, keyFingerprint, keyLine, keyLineOf, withKeyLine, logAnchor, sealOf, verifyChain, lastSealOf, sealEntry, sealedAppend };
