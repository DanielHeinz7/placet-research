'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const seal = require('../hooks/lib/seal');
const decisions = require('../hooks/lib/decisions');
const { mergeLogs } = require('../hooks/lib/merge');

const KEY = Buffer.alloc(32, 9);
const HEADER = '# Decision log — t\n';

// Appends sealed entries to a text in memory, the way sealedAppend does on disk.
function append(text, entries) {
  let out = text;
  for (const f of entries) {
    const seq = decisions.parseDecisions(out).maxSeq + 1;
    const { text: entry } = seal.sealEntry(seal.lastSealOf(out), { date: '2026-10-08', body: 'x', ...f, seq }, KEY);
    out += decisions.separatorAfter(out) + entry;
  }
  return out;
}
const d = (ref, extra = {}) => ({ kind: 'DISCOVERY', ref, body: `finding ${ref}`, by: 'A. Researcher', ...extra });

const base = append(HEADER, [d('1'), d('2')]);
const ours = append(base, [d('3'), d('4', { supersedes: 3 })]);
const theirs = append(base, [{ ...d('5'), by: 'B. Supervisor' }]);

test('one log a prefix of the other: the longer one, unchanged, no MERGE', () => {
  assert.deepEqual(mergeLogs(base, ours, KEY, { by: 'A', theirsCommit: 'abc1234' }), { ok: true, text: ours, merged: false, kept: 'theirs' });
  assert.deepEqual(mergeLogs(ours, base, KEY, { by: 'A', theirsCommit: 'abc1234' }), { ok: true, text: ours, merged: false, kept: 'ours' });
});

test('divergence: theirs unchanged, ours renumbered and re-sealed after it, references rewritten, one MERGE', () => {
  const r = mergeLogs(ours, theirs, KEY, { by: 'A. Researcher', theirsCommit: 'abc1234' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.merged, true);
  assert.ok(r.text.startsWith(theirs));
  assert.deepEqual(r.moved, [[3, 4], [4, 5]]);
  const entries = decisions.parseDecisions(r.text).entries;
  assert.deepEqual(entries.map((e) => [e.seq, e.kind, e.ref]), [[1, 'DISCOVERY', '1'], [2, 'DISCOVERY', '2'], [3, 'DISCOVERY', '5'], [4, 'DISCOVERY', '3'], [5, 'DISCOVERY', '4'], [6, 'MERGE', 'from abc1234']]);
  assert.equal(entries[4].supersedes, 4, 'the supersede follows the moved entry');
  assert.equal(entries[3].by, 'A. Researcher');
  assert.match(entries[5].body, /Taken up to #3 from abc1234\. Own #3–#4 moved to #4–#5\./);
  assert.equal(entries[5].by, 'A. Researcher');
  assert.equal(r.mergeSeq, 6);
  assert.equal(seal.verifyChain(r.text, KEY).status, 'verified');
});

test('a reference into the shared prefix stays', () => {
  const o = append(base, [d('3', { supersedes: 1 })]);
  const r = mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(decisions.parseDecisions(r.text).entries[3].supersedes, 1);
});

test('refusals: missing key, a broken side, no shared prefix', () => {
  assert.equal(mergeLogs(ours, theirs, null, { by: 'A', theirsCommit: 'x' }).code, 'ledger');
  const broken = ours.replace('finding 3', 'finding 3!');
  const r = mergeLogs(broken, theirs, KEY, { by: 'A', theirsCommit: 'x' });
  assert.equal(r.code, 'broken');
  assert.match(r.error, /ours is broken at #3/);
  assert.equal(mergeLogs(ours, theirs.replace('finding 5', 'finding 5!'), KEY, { by: 'A', theirsCommit: 'x' }).code, 'broken');
  const other = append('# Decision log — other\n', [d('1')]);
  assert.equal(mergeLogs(ours, other, KEY, { by: 'A', theirsCommit: 'x' }).code, 'no-prefix');
});

const accept = (q) => ({ kind: 'DECISION', ref: `${q} accepted`, hash: 'abcdef12', body: 'S. [accepted]', explained: 'E.', by: 'A. Researcher' });

test('check refusal: our acceptance on a question theirs opened a check on after the prefix', () => {
  const o = append(base, [accept('7.1')]);
  const t = append(base, [{ kind: 'DISCOVERY', ref: '7.1 check', body: 'Is this right?', by: 'B. Supervisor' }]);
  const r = mergeLogs(o, t, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(r.code, 'check');
  assert.match(r.error, /7\.1/);
  assert.match(r.error, /#3/);
  assert.match(r.error, /git merge --abort/);
  assert.match(r.error, /--skip-decision 3\b/);
  assert.doesNotMatch(r.error, /--skip-decision #/);
});

test('--skip-decision leaves that DECISION out and the MERGE entry says so', () => {
  const o = append(base, [accept('7.1'), d('8')]);
  const t = append(base, [{ kind: 'DISCOVERY', ref: '7.1 check', body: 'Is this right?', by: 'B. Supervisor' }]);
  const r = mergeLogs(o, t, KEY, { by: 'A', theirsCommit: 'abc1234', skip: [3] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.dropped, [3]);
  assert.deepEqual(r.moved, [[4, 4]]);
  const entries = decisions.parseDecisions(r.text).entries;
  assert.equal(entries.filter((e) => e.kind === 'DECISION').length, 0);
  assert.match(entries[entries.length - 1].body, /#3 dropped, to be accepted again/);
  assert.equal(seal.verifyChain(r.text, KEY).status, 'verified');
});

test('--skip-decision refuses a number that is not one of our moved DECISIONs, and a moved entry that points at it', () => {
  const o = append(base, [accept('7.1'), d('8', { supersedes: 3 })]);
  assert.equal(mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'x', skip: [1] }).code, 'skip');
  assert.equal(mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'x', skip: [4] }).code, 'skip');
  const r = mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'x', skip: [3] });
  assert.equal(r.code, 'dangling');
  assert.match(r.error, /#4.*#3/);
  const listed = append(base, [accept('7.1'), { ...d('8'), openAtAccept: [3] }]);
  const danglingList = mergeLogs(listed, theirs, KEY, { by: 'A', theirsCommit: 'x', skip: [3] });
  assert.equal(danglingList.code, 'dangling', 'Open at acceptance is a reference too');
  assert.match(danglingList.error, /#4.*#3/);
});

test('an Open at acceptance list moves with the entries it names', () => {
  const o = append(base, [d('3'), { ...d('4'), openAtAccept: [3] }]);
  const r = mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(decisions.parseDecisions(r.text).entries[4].openAtAccept, [4]);
});

test('a reference on a continuation line of its field moves too', () => {
  const o = append(base, [d('3'), d('4'), { ...d('5'), body: 'finding 5\n**Open at acceptance:** #3,\n#4\n**Supersedes:**\n#3' }]);
  const r = mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(r.ok, true, r.error);
  const moved = decisions.parseDecisions(r.text).entries[5];
  assert.deepEqual(moved.openAtAccept, [4, 5]);
  assert.equal(moved.supersedes, 4);
  assert.equal(seal.verifyChain(r.text, KEY).status, 'verified');
});

// SQ-192: a log whose first entries predate the seal. Theirs without a seal
// reads as unverifiable, not broken, and must not be re-anchored under ours.
const LEGACY = `${HEADER}\n## [#1] 2026-09-10 · DISCOVERY · 1\nfinding 1\n**By:** A. Researcher\n\n## [#2] 2026-09-12 · DECISION · 1.1 accepted · text 3b7a1c9e\nOld statement [accepted]\n**By:** A. Researcher\n`;
const lbase = append(LEGACY, [d('3')]);
const lours = append(lbase, [d('4')]);
const FORGED = '## [#3] 2026-09-16 · DECISION · 1.2 accepted · text deadbeef\nForged statement [accepted]\n**By:** Nobody Sealed This\n';

test('legacy theirs that dropped a seal ours has: refused', () => {
  const dropped = lbase.replace(/ · seal [0-9a-f]{16}$/m, '');
  assert.equal(seal.verifyChain(dropped, KEY).status, 'unverifiable');
  const r = mergeLogs(lours, dropped, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unverifiable');
  assert.equal(r.text, undefined);
});

test('legacy theirs with a forged unsealed entry in place of a sealed one: refused', () => {
  const forged = `${LEGACY}\n${FORGED}`;
  const r = mergeLogs(lours, forged, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(r.code, 'unverifiable');
});

test('legacy theirs with a rewritten header or text hash: refused, with or without an entry of its own', () => {
  const rewritten = LEGACY.replace('— t', '— renamed').replace('text 3b7a1c9e', 'text 0badf00d');
  assert.equal(mergeLogs(lours, rewritten, KEY, { by: 'A', theirsCommit: 'x' }).code, 'unverifiable');
  assert.equal(mergeLogs(lours, `${rewritten}\n${FORGED}`, KEY, { by: 'A', theirsCommit: 'x' }).code, 'unverifiable');
});

test('legacy bytes before the first seal compare exactly, even when theirs verifies', () => {
  // Theirs sealed by someone holding the key, on a legacy block that differs
  // from ours only in a text hash or in the header.
  const hash = append(LEGACY.replace('text 3b7a1c9e', 'text 0badf00d'), [d('9')]);
  const r = mergeLogs(lours, hash, KEY, { by: 'A', theirsCommit: 'x' });
  assert.equal(r.ok, false, 'the legacy #2 differs, so it is not shared and ours cannot move it');
  const header = append(LEGACY.replace('— t', '— renamed'), [d('9')]);
  const h = mergeLogs(lours, header, KEY, { by: 'A', theirsCommit: 'x' });
  assert.equal(h.code, 'no-prefix');
  assert.match(h.error, /above #1/);
});

test('SESSION entries move like any other entry', () => {
  const o = append(base, [{ kind: 'SESSION', ref: 'Supervision', body: 'Session started.', by: 'A' }]);
  const r = mergeLogs(o, theirs, KEY, { by: 'A', theirsCommit: 'x' });
  assert.deepEqual(decisions.parseDecisions(r.text).entries.map((e) => e.kind).slice(-2), ['SESSION', 'MERGE']);
});

// SQ-196: theirs holds no entries, so ours is what the merge would keep — but
// ours carries no seal, and the CLI writes before it verifies. The refusal has
// to come first, or the working file is left modified by a merge that fails.
test('ours without a seal and a theirs without entries: refused, no text', () => {
  assert.equal(seal.verifyChain(LEGACY, KEY).status, 'unverifiable');
  const r = mergeLogs(LEGACY, HEADER, KEY, { by: 'A', theirsCommit: 'abc1234' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unverifiable');
  assert.equal(r.text, undefined);
  assert.match(r.error, /no seal that verifies/);
  assert.deepEqual(mergeLogs(base, HEADER, KEY, { by: 'A', theirsCommit: 'abc1234' }), { ok: true, text: base, merged: false, kept: 'ours' }, 'a sealed ours with an entry-less theirs is still kept unchanged');
});
