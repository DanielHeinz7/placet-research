'use strict';

const decisions = require('./decisions');
const seal = require('./seal');

// Two clones that both appended after #n each hold a #n+1 on the same chain
// (spec §2). Equal seq and equal seal means the same entry, because a seal
// chains over everything before it, so the shared prefix is found by
// comparing seals, without git's merge base. Theirs stays byte for byte; our
// entries after the prefix are renumbered and re-sealed after it. Nothing is
// deleted: an entry left out with `skip` stays in git history.

function refuse(code, error) {
  return { ok: false, code, error };
}

// An entry's own bytes, heading to the next heading, without the blank lines
// that separate it from what follows.
function rawEntry(text, entries, k) {
  return text.slice(entries[k].offset, k + 1 < entries.length ? entries[k + 1].offset : text.length).trimEnd();
}

// A sealed entry is the same entry when seq and seal match: the seal chains
// over everything before it. A legacy entry has no seal of its own, so it is
// the same entry only byte for byte, text hash included (SQ-193).
function sameEntry(ours, a, k, theirs, b) {
  if (a[k].seq !== b[k].seq) return false;
  if (a[k].seal !== null || b[k].seal !== null) return a[k].seal === b[k].seal;
  return rawEntry(ours, a, k) === rawEntry(theirs, b, k);
}

const ACCEPT_REF = /^([1-9]\.\d+) accepted$/;
const REF_FIELDS = new Set(['Supersedes', 'Open at acceptance']);

// Only the fields that name entries by number move with the map, and all of
// such a field: the parser reads a field's continuation lines as part of it.
// The first line is the entry's text and is never read as a field.
function rewriteRefs(body, map) {
  const lines = body.split('\n');
  let refs = false;
  for (let i = 1; i < lines.length; i += 1) {
    const label = decisions.fieldLabelIn(lines[i]);
    if (label) refs = REF_FIELDS.has(label);
    if (refs) lines[i] = lines[i].replace(/#(\d+)/g, (all, n) => (map.has(Number(n)) ? `#${map.get(Number(n))}` : all));
  }
  return lines.join('\n');
}

function refsOf(entry) {
  return [...(entry.supersedes ? [entry.supersedes] : []), ...entry.openAtAccept];
}

function mergeLogs(ours, theirs, key, { by, theirsCommit, skip = [] } = {}) {
  if (!key) return refuse('ledger', 'No sealing key for this project on this machine; nothing is merged.');
  for (const [side, text] of [['ours', ours], ['theirs', theirs]]) {
    const chain = seal.verifyChain(text, key);
    if (chain.status === 'broken' && chain.broken.why === 'key') {
      return refuse('broken', `The sealing key on this machine is not the one ${side} was started with: its Seal key line names a different key; nothing is merged.`);
    }
    if (chain.status === 'broken') {
      return refuse('broken', `${side} is broken at #${chain.broken.seq} (line ${chain.broken.line}, ${chain.broken.why}); nothing is merged. The harness never repairs a ledger.`);
    }
    // Theirs is what the merge keeps byte for byte and seals our entries onto,
    // so it has to verify under our key. A copy without seals reads as
    // unverifiable, not broken: one that dropped a seal, forged a later entry
    // unsealed, or rewrote the bytes before its first seal would otherwise be
    // re-anchored here into a log that verifies (SQ-192).
    if (side === 'theirs' && chain.status !== 'verified') {
      return refuse('unverifiable', 'theirs carries no seal that verifies under our key, so nothing in it can be checked; nothing is merged. A copy whose seals were dropped or never written is not merged onto a sealed log.');
    }
  }
  const a = decisions.parseDecisions(ours).entries;
  const b = decisions.parseDecisions(theirs).entries;
  let n = 0;
  while (n < a.length && n < b.length && sameEntry(ours, a, n, theirs, b)) n += 1;
  if (n > 0 && ours.slice(0, a[0].offset) !== theirs.slice(0, b[0].offset)) {
    return refuse('no-prefix', 'The text above #1 differs between the two logs; nothing is merged.');
  }
  if (n === a.length) return { ok: true, text: theirs, merged: false, kept: 'theirs' };
  // Theirs being a prefix of ours means ours is what would be written out, and
  // the CLI verifies only after that write; an ours without a seal would leave
  // a log that cannot verify on disk, so it is refused before anything is
  // returned (SQ-196).
  if (n === b.length) {
    if (seal.verifyChain(ours, key).status !== 'verified') {
      return refuse('unverifiable', 'ours carries no seal that verifies under our key, so keeping it would write a log that does not verify; nothing is merged.');
    }
    return { ok: true, text: ours, merged: false, kept: 'ours' };
  }
  // No shared entry still means two copies of one log when both grew from the
  // same empty log (SQ-249): the same bytes above #1, and a first entry on
  // each side sealed onto them. Both sides verify under our key by now, so
  // their seals anchor on those bytes. A log of another project, or one that
  // starts with an unsealed entry ours lacks, does not share that origin.
  const sameOrigin = a[0].seal !== null && b[0].seal !== null && ours.slice(0, a[0].offset) === theirs.slice(0, b[0].offset);
  if (n === 0 && !sameOrigin) return refuse('no-prefix', 'The two logs share no entry; they are not two copies of one log. Nothing is merged.');

  const mine = a.slice(n);
  const other = b.slice(n);
  if (mine.some((e) => e.seal === null)) return refuse('broken', 'ours has unsealed entries after the shared part; nothing is merged.');
  for (const s of skip) {
    if (!mine.some((e) => e.seq === s && e.kind === 'DECISION')) {
      return refuse('skip', `--skip-decision ${s}: our side has no DECISION #${s} after the shared part (${n ? `#${a[n - 1].seq}` : 'the empty log'}); nothing is merged.`);
    }
  }
  const kept = mine.filter((e) => !skip.includes(e.seq));
  for (const e of kept) {
    const hit = refsOf(e).find((r) => skip.includes(r));
    if (hit) return refuse('dangling', `Our #${e.seq} refers to #${hit}, which --skip-decision leaves out; nothing is merged. Merge without the skip, or leave both out by accepting again after the merge.`);
  }
  for (const e of kept) {
    const q = e.kind === 'DECISION' && ACCEPT_REF.exec(e.ref);
    if (!q) continue;
    const check = other.find((t) => t.kind === 'DISCOVERY' && t.ref.trim() === `${q[1]} check`);
    if (check) {
      return refuse('check', `Our acceptance #${e.seq} of ${q[1]} would be placed after their check question #${check.seq} on ${q[1]}, which we never saw, and would read as having closed it. Nothing is merged. Run git merge --abort, then git pull --no-rebase again and run placet-research merge-log --skip-decision ${e.seq}; accept ${q[1]} again after the merge.`);
    }
  }

  const theirMax = decisions.parseDecisions(theirs).maxSeq;
  const map = new Map();
  kept.forEach((e, i) => map.set(e.seq, theirMax + 1 + i));
  let text = theirs;
  let previous = seal.lastSealOf(theirs);
  for (const e of kept) {
    const fields = { seq: map.get(e.seq), date: e.date, kind: e.kind, ref: e.ref, hash: e.hash, body: rewriteRefs(e.body, map) };
    const sealed = seal.sealEntry(previous, fields, key);
    text += decisions.separatorAfter(text) + sealed.text;
    previous = sealed.seal;
  }
  const moved = kept.map((e) => [e.seq, map.get(e.seq)]);
  const range = (xs) => (xs.length === 1 ? `#${xs[0]}` : `#${xs[0]}–#${xs[xs.length - 1]}`);
  const parts = [`Taken up to #${theirMax} from ${theirsCommit}.`];
  if (moved.length) parts.push(`Own ${range(moved.map((m) => m[0]))} moved to ${range(moved.map((m) => m[1]))}.`);
  if (skip.length) parts.push(`${skip.map((s) => `#${s}`).join(', ')} dropped, to be accepted again.`);
  const mergeSeq = theirMax + kept.length + 1;
  const entry = seal.sealEntry(previous, { seq: mergeSeq, date: new Date().toISOString().slice(0, 10), kind: 'MERGE', ref: `from ${theirsCommit}`, body: parts.join(' '), by }, key);
  text += decisions.separatorAfter(text) + entry.text;
  if (seal.verifyChain(text, key).status !== 'verified') return refuse('broken', 'The merged log does not verify; nothing is written. This is a bug in merge-log.');
  return { ok: true, text, merged: true, moved, dropped: [...skip], mergeSeq };
}

module.exports = { mergeLogs };
