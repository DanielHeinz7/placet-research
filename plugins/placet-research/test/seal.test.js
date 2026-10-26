'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');
const { textHash } = require('../hooks/lib/hash');

const legacyLog = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'decisions.md'),
  'utf8',
);

// Sealed at 3792c3e, before a labelled line below an entry's text became a
// refusal (SQ-133). Its bytes and its key are frozen here together, so the
// check is that a log written before the change still verifies and parses as
// it did, not that today's code can seal and read its own output.
const prechangeLog = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'prechange-decisions.md'),
  'utf8',
);
const PRECHANGE_KEY = Buffer.from('ab'.repeat(32), 'hex');

function withState(fn) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
  const previous = process.env.PLACET_RESEARCH_STATE_DIR;
  process.env.PLACET_RESEARCH_STATE_DIR = stateDir;
  try {
    return fn(stateDir);
  } finally {
    if (previous === undefined) delete process.env.PLACET_RESEARCH_STATE_DIR;
    else process.env.PLACET_RESEARCH_STATE_DIR = previous;
  }
}

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
}

const KEY = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');

test('createKey writes 32 random bytes under the harness state root with mode 0600 and never overwrites', () => {
  withState((stateDir) => {
    const root = tempProject();
    const first = seal.createKey(root);
    assert.equal(first.created, true);
    assert.ok(first.path.startsWith(stateDir), first.path);
    assert.equal(path.basename(first.path), 'seal.key');
    assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);
    const key = seal.readKey(root);
    assert.equal(key.length, 32);
    const again = seal.createKey(root);
    assert.equal(again.created, false);
    assert.deepEqual(seal.readKey(root), key, 'a second init keeps the key');
  });
});

test('readKey is null when no key exists for the project on this machine', () => {
  withState(() => {
    assert.equal(seal.readKey(tempProject()), null);
  });
});

for (const [name, content] of [
  ['empty', ''],
  ['short', 'ab'.repeat(31)],
  ['odd-length', 'a'.repeat(63)],
  ['non-hex', 'g'.repeat(64)],
]) {
  test(`readKey rejects the ${name} local key without replacing it`, () => {
    withState(() => {
      const root = tempProject();
      const { path: file } = seal.createKey(root);
      fs.writeFileSync(file, content);
      assert.throws(() => seal.readKey(root), /is not a 32-byte key/);
      assert.equal(seal.createKey(root).created, false, 'init does not replace a damaged key');
      assert.equal(fs.readFileSync(file, 'utf8'), content, 'the damaged key is unchanged');
    });
  });

  for (const [logName, logText] of [['fresh', decisions.header('p')], ['legacy', legacyLog]]) {
    test(`the ${name} local key refuses a write to a ${logName} log without changing project files`, () => {
      withState(() => {
        const root = tempProject();
        const research = path.join(root, 'research');
        fs.mkdirSync(research);
        const canvasFile = path.join(research, 'canvas.md');
        const canvasText = fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'canvas.md'), 'utf8');
        fs.writeFileSync(canvasFile, canvasText);
        const logFile = path.join(research, 'decisions.md');
        fs.writeFileSync(logFile, logText);
        const { path: file } = seal.createKey(root);
        fs.writeFileSync(file, content);

        const state = require('../hooks/lib/state').loadState(root);
        const result = require('../hooks/lib/log').appendLog({
          root, kind: 'DISCOVERY', ref: '1 Puzzle', body: 'A new finding [tentative]',
        });
        assert.equal(result.ok, false, 'the write is refused');
        assert.equal(state.key, null, 'an invalid key never reaches sealing');
        assert.ok(state.keyError, 'loadState reports the invalid local key');
        assert.equal(result.code, 'ledger');
        assert.match(result.error, /nothing is written/);
        assert.equal(fs.readFileSync(logFile, 'utf8'), logText, 'no entry is appended');
        assert.equal(fs.readFileSync(canvasFile, 'utf8'), canvasText, 'the canvas is unchanged');
        assert.equal(fs.readFileSync(file, 'utf8'), content, 'the key is unchanged');
      });
    });
  }
}

for (const suffix of ['', '\n']) {
  test(`readKey decodes a valid local key${suffix ? ' with a trailing newline' : ''} without changing it`, () => {
    withState(() => {
      const root = tempProject();
      const { path: file } = seal.createKey(root);
      const content = KEY.toString('hex').toUpperCase() + suffix;
      fs.writeFileSync(file, content);
      assert.deepEqual(seal.readKey(root), KEY);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    });
  });
}

test('sealOf is 16 hex of an HMAC over the previous seal and the canonical entry, reflow-insensitive in the body', () => {
  const entry = { seq: 4, date: '2026-09-18', kind: 'DISCOVERY', ref: '2 Prior Research', hash: null, body: 'Two studies\ncontradict each other. [tentative, src: ref-11]' };
  const s = seal.sealOf(KEY, 'abc', entry);
  assert.match(s, /^[0-9a-f]{16}$/);
  const canonical = ['abc', '4', '2026-09-18', 'DISCOVERY', '2 Prior Research', '', 'Two studies contradict each other. [tentative, src: ref-11]'].join('');
  assert.equal(s, crypto.createHmac('sha256', KEY).update(canonical, 'utf8').digest('hex').slice(0, 16));
  assert.equal(seal.sealOf(KEY, 'abc', { ...entry, body: 'Two studies   contradict each other.   [tentative, src: ref-11]' }), s);
  assert.notEqual(seal.sealOf(KEY, 'abc', { ...entry, body: 'Two studies agree. [tentative, src: ref-11]' }), s);
  assert.notEqual(seal.sealOf(KEY, 'abd', entry), s);
  assert.notEqual(seal.sealOf(Buffer.from('other-key'), 'abc', entry), s);
});

test('parseDecisions reads the seal field and the body of every entry', () => {
  const text = `${legacyLog}\n## [#4] 2026-09-18 · DISCOVERY · 2 Prior Research · seal 0123456789abcdef\nx [tentative]\n**Supersedes:** #2\n`;
  const parsed = decisions.parseDecisions(text);
  assert.equal(parsed.entries.length, 4);
  assert.equal(parsed.entries[0].seal, null);
  assert.equal(parsed.entries[0].body, 'Only the twelve recorded meetings may be used; no additional fieldwork before submission. [stated]');
  assert.equal(parsed.entries[2].hash, '3b7a1c9e');
  assert.equal(parsed.entries[2].body.split('\n').length, 3, 'Why and Rejected lines are part of the body');
  assert.equal(parsed.entries[3].seal, '0123456789abcdef');
  assert.equal(parsed.entries[3].body, 'x [tentative]\n**Supersedes:** #2');
  assert.equal(text.slice(parsed.entries[3].offset, parsed.entries[3].offset + 8), '## [#4] ');
  const sealed = decisions.formatEntry({ seq: 5, date: '2026-09-18', kind: 'DECISION', ref: '1.2 accepted', hash: 'deadbeef', body: 'y [accepted]', seal: 'fedcba9876543210' });
  assert.equal(sealed, '## [#5] 2026-09-18 · DECISION · 1.2 accepted · text deadbeef · seal fedcba9876543210\ny [accepted]\n');
  assert.equal(decisions.parseDecisions(sealed).entries[0].seal, 'fedcba9876543210');
});

test('a legacy log with no seals is unverifiable, not broken, and names its legacy entries once', () => {
  const result = seal.verifyChain(legacyLog, KEY);
  assert.equal(result.status, 'unverifiable');
  assert.equal(result.reason, 'legacy');
  assert.deepEqual(result.legacy, [1, 2, 3]);
  assert.equal(result.broken, null);
  assert.deepEqual([...result.verified], []);
  assert.equal(seal.verifyChain('', KEY).status, 'verified', 'an empty log has nothing to verify');
  assert.equal(seal.verifyChain(decisions.header('x'), KEY).status, 'verified');
});

test('a log sealed before the field labels were refused still verifies and parses as it did', () => {
  const result = seal.verifyChain(prechangeLog, PRECHANGE_KEY);
  assert.equal(result.status, 'verified');
  assert.deepEqual([...result.verified], [1, 2]);
  const [decision, discovery] = decisions.parseDecisions(prechangeLog).entries;
  assert.deepEqual(
    [decision.why, decision.explained, decision.rejected, decision.openAtAccept, decision.supersedes],
    [
      'the phenomenon, not a gap, drives the study.\nIt holds across both sites.',
      'I accept that uptake, not voice, is the gap.',
      'framing it as a voice-frequency question.',
      [4, 12],
      null,
    ],
  );
  assert.equal(decision.body.split('\n')[0], "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]", 'the entry text is still the whole text below the heading');
  assert.deepEqual(
    [discovery.why, discovery.supersedes, discovery.openAtAccept],
    ['the claim is stronger if uptake is observable in more than one meeting.', 1, []],
  );
  assert.equal(discovery.body, 'Which meetings actually show the uptake the claims rest on?\n**Why:** the claim is stronger if uptake is observable in more than one meeting.\n**Supersedes:** #1');
});

test('sealedAppend chains the first sealed entry onto the hash of everything before it and every later one onto the previous seal', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, legacyLog);
  const first = seal.sealedAppend(file, { date: '2026-09-18', kind: 'DISCOVERY', ref: '2 Prior Research', body: 'x [tentative]' }, KEY);
  assert.equal(first.seq, 4);
  const text1 = fs.readFileSync(file, 'utf8');
  assert.ok(text1.startsWith(legacyLog));
  const parsed1 = decisions.parseDecisions(text1);
  const entry4 = parsed1.entries[3];
  assert.equal(entry4.seal, first.seal);
  const prefix = text1.slice(0, entry4.offset);
  const anchor = crypto.createHash('sha256').update(prefix, 'utf8').digest('hex');
  assert.equal(first.seal, seal.sealOf(KEY, anchor, entry4));

  const second = seal.sealedAppend(file, { date: '2026-09-18', kind: 'CONSTRAINT', ref: '5 Research Setting', body: 'y [stated]', why: 'because' }, KEY);
  assert.equal(second.seq, 5);
  const parsed2 = decisions.parseDecisions(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed2.entries[4].seal, seal.sealOf(KEY, first.seal, parsed2.entries[4]));

  const result = seal.verifyChain(fs.readFileSync(file, 'utf8'), KEY);
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.legacy, [1, 2, 3]);
  assert.deepEqual([...result.verified], [4, 5]);
});

// Captured by running the two appends below against the code as it stood
// before sealEntry was extracted (SQ-179). The refactor may not move a byte of
// what sealedAppend writes, so the expected text is frozen here rather than
// recomputed with the same functions it is meant to check.
const SEALED_APPEND_BYTES = '# Decision log — t\n\n## [#1] 2026-10-08 · DISCOVERY · 1 Puzzle · seal 6a9529aeb20154ce\nFirst finding. [tentative]\n**By:** A. Researcher\n\n## [#2] 2026-10-08 · CONSTRAINT · 2 Prior Research · seal 5788b9ba31ad04d7\nA constraint. [stated]\n**By:** A. Researcher\n**Why:** because\n';

test('sealedAppend writes the same bytes as before sealEntry was extracted', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, '# Decision log — t\n');
  const first = seal.sealedAppend(file, { date: '2026-10-08', kind: 'DISCOVERY', ref: '1 Puzzle', body: 'First finding. [tentative]', by: 'A. Researcher' }, KEY);
  const second = seal.sealedAppend(file, { date: '2026-10-08', kind: 'CONSTRAINT', ref: '2 Prior Research', body: 'A constraint. [stated]', why: 'because', by: 'A. Researcher' }, KEY);
  assert.deepEqual([first.seq, first.seal, second.seq, second.seal], [1, '6a9529aeb20154ce', 2, '5788b9ba31ad04d7']);
  assert.equal(fs.readFileSync(file, 'utf8'), SEALED_APPEND_BYTES);
});

test('sealedAppend seals a DECISION only when told to and refuses a broken chain', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, decisions.header('p'));
  assert.throws(() => seal.sealedAppend(file, { date: '2026-09-18', kind: 'DECISION', ref: '1.1 accepted', hash: 'deadbeef', body: 'x [accepted]' }, KEY), /DECISION/);
  const decided = seal.sealedAppend(file, { date: '2026-09-18', kind: 'DECISION', ref: '1.1 accepted', hash: 'deadbeef', body: 'x [accepted]' }, KEY, { decision: true });
  assert.equal(decided.seq, 1);
  assert.equal(seal.verifyChain(fs.readFileSync(file, 'utf8'), KEY).status, 'verified');
  fs.appendFileSync(file, '\n## [#2] 2026-09-18 · DECISION · 1.2 accepted · text deadbeef\nforged [accepted]\n');
  assert.throws(() => seal.sealedAppend(file, { date: '2026-09-18', kind: 'DISCOVERY', ref: '1 Puzzle', body: 'z [tentative]' }, KEY), /broken/);
  assert.equal(fs.readFileSync(file, 'utf8').split('## [#').length - 1, 2, 'nothing was appended to a broken ledger');
});

test('verifyChain without a key reports unverifiable here, still catches an unsealed entry after a sealed one', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, legacyLog);
  seal.sealedAppend(file, { date: '2026-09-18', kind: 'DISCOVERY', ref: '1 Puzzle', body: 'x [tentative]' }, KEY);
  const sealedText = fs.readFileSync(file, 'utf8');
  const noKey = seal.verifyChain(sealedText, null);
  assert.equal(noKey.status, 'unverifiable');
  assert.equal(noKey.reason, 'no-key');
  assert.deepEqual([...noKey.verified], []);
  const downgraded = `${sealedText}\n## [#5] 2026-09-18 · DECISION · 1.2 accepted · text deadbeef\nforged [accepted]\n`;
  const result = seal.verifyChain(downgraded, null);
  assert.equal(result.status, 'broken');
  assert.equal(result.broken.seq, 5);
  assert.equal(result.broken.why, 'unsealed');
});

test('verifyChain names the first entry that fails and whether its content or the chain before it changed', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, legacyLog);
  for (let k = 0; k < 3; k += 1) {
    seal.sealedAppend(file, { date: '2026-09-18', kind: 'DISCOVERY', ref: '1 Puzzle', body: `finding ${k} [tentative]` }, KEY);
  }
  const good = fs.readFileSync(file, 'utf8');
  assert.equal(seal.verifyChain(good, KEY).status, 'verified');

  const reworded = good.replace('finding 1 [tentative]', 'finding one [tentative]');
  const contentBreak = seal.verifyChain(reworded, KEY);
  assert.equal(contentBreak.status, 'broken');
  assert.equal(contentBreak.broken.seq, 5);
  assert.equal(contentBreak.broken.why, 'content');
  assert.deepEqual([...contentBreak.verified], [4], 'entries before the break still count');

  const parsed = decisions.parseDecisions(good);
  const removed = good.slice(0, parsed.entries[4].offset) + good.slice(parsed.entries[5].offset);
  const chainBreak = seal.verifyChain(removed, KEY);
  assert.equal(chainBreak.status, 'broken');
  assert.equal(chainBreak.broken.seq, 6);
  assert.equal(chainBreak.broken.why, 'chain');

  const legacyEdited = good.replace('no additional fieldwork', 'some additional fieldwork');
  const anchorBreak = seal.verifyChain(legacyEdited, KEY);
  assert.equal(anchorBreak.status, 'broken');
  assert.equal(anchorBreak.broken.seq, 4);
  assert.equal(anchorBreak.broken.why, 'anchor');

  const forgedSeal = good.replace(/seal [0-9a-f]{16}\nfinding 2/, 'seal 0000000000000000\nfinding 2');
  assert.equal(seal.verifyChain(forgedSeal, KEY).broken.seq, 6);

  const wrongKey = seal.verifyChain(good, Buffer.from('not-the-key'));
  assert.equal(wrongKey.status, 'broken');
  assert.equal(wrongKey.broken.seq, 4);
});

test('a verified DECISION with its text hash still round-trips through textHash', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, decisions.header('p'));
  const statement = 'When do members\' suggestions get taken up?';
  seal.sealedAppend(file, { date: '2026-09-18', kind: 'DECISION', ref: '1.1 accepted', hash: textHash(statement), body: `${statement} [accepted]` }, KEY, { decision: true });
  const parsed = decisions.parseDecisions(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.entries[0].hash, textHash(statement));
  assert.deepEqual([...seal.verifyChain(fs.readFileSync(file, 'utf8'), KEY).verified], [1]);
});

test('readKeyFile takes the released key from a path, and refuses anything that is not a 32-byte one', () => {
  const dir = tempProject();
  const file = path.join(dir, 'seal.key');
  fs.writeFileSync(file, `${KEY.toString('hex')}\n`);
  assert.deepEqual(seal.readKeyFile(file), KEY, 'a trailing newline does not change the key it holds');
  fs.writeFileSync(file, 'ab'.repeat(16));
  assert.throws(() => seal.readKeyFile(file), /is not a 32-byte key \(64 hex characters/);
  fs.writeFileSync(file, 'z'.repeat(64));
  assert.throws(() => seal.readKeyFile(file), /is not a 32-byte key/);
  assert.throws(() => seal.readKeyFile(dir), /cannot be read \(EISDIR\)/);
});

test('logAnchor names the last seal, maxSeq and the whole file hash without a key', () => {
  const dir = tempProject();
  const file = path.join(dir, 'decisions.md');
  fs.writeFileSync(file, decisions.header('p'));
  seal.sealedAppend(file, { date: '2026-09-18', kind: 'DECISION', ref: '1.1 accepted', hash: textHash('x'), body: 'x [accepted]' }, KEY, { decision: true });
  const text = fs.readFileSync(file, 'utf8');
  const lastSeal = decisions.parseDecisions(text).entries[0].seal;
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  assert.equal(seal.logAnchor(text), `last seal ${lastSeal}, maxSeq 1, decisions.md sha256 ${digest}`);
  assert.match(seal.logAnchor(''), /^last seal none, maxSeq 0, decisions\.md sha256 e3b0c442/);
  assert.notEqual(seal.logAnchor(text), seal.logAnchor(`${text} `), 'a byte anywhere moves the anchor');
});

test('a seal over an entry with By recomputes, and changing the name breaks it', () => {
  const key = Buffer.alloc(32, 7);
  const file = path.join(tempProject(), 'decisions.md');
  fs.writeFileSync(file, '# Decision log — t\n');
  seal.sealedAppend(file, { date: '2026-10-08', kind: 'DISCOVERY', ref: '7', body: 'A finding.', by: 'A. Researcher' }, key);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(seal.verifyChain(text, key).status, 'verified');
  assert.equal(seal.verifyChain(text.replace('A. Researcher', 'B. Supervisor'), key).status, 'broken');
});

// SQ-286: the `Seal key:` line init writes under the title names the key the
// log was started with, so a wrong key is caught before the log has a seal.
test('a log whose Seal key line names another key is broken (key) under that key, even with no entry', () => {
  const wrong = Buffer.from('ab'.repeat(32), 'hex');
  const text = seal.withKeyLine(decisions.header('p'), KEY);
  assert.equal(text, `# Decision log — p\n\nSeal key: ${seal.keyFingerprint(KEY)}\n`);
  assert.match(seal.keyFingerprint(KEY), /^[0-9a-f]{16}$/);
  assert.equal(text.includes(KEY.toString('hex').slice(0, 16)), false, 'the line is not the key');
  const bad = seal.verifyChain(text, wrong);
  assert.equal(bad.status, 'broken');
  assert.deepEqual(bad.broken, { seq: 0, line: 3, why: 'key' });
  assert.equal(seal.verifyChain(text, KEY).status, 'verified', 'the right key verifies the empty log');
  assert.equal(seal.verifyChain(text, null).status, 'verified', 'without a key nothing is compared');
  // After the first seal the line sits inside the anchor, and the key check
  // still comes first.
  const file = path.join(tempProject(), 'decisions.md');
  fs.writeFileSync(file, text);
  seal.sealedAppend(file, { date: '2026-10-15', kind: 'DISCOVERY', ref: '7', body: 'A finding.', by: 'A. Researcher' }, KEY);
  const sealed = fs.readFileSync(file, 'utf8');
  assert.equal(seal.verifyChain(sealed, KEY).status, 'verified');
  assert.equal(seal.verifyChain(sealed, wrong).broken.why, 'key');
  assert.throws(
    () => seal.sealedAppend(file, { date: '2026-10-15', kind: 'DISCOVERY', ref: '7', body: 'Another.', by: 'B' }, wrong),
    (err) => err.message === `${seal.WRONG_KEY}; nothing is appended`,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), sealed, 'nothing was appended under the wrong key');
});

test('only a Seal key line above #1 counts, and withKeyLine leaves a sealed or named log alone', () => {
  const wrong = Buffer.from('ab'.repeat(32), 'hex');
  const inBody = `${decisions.header('p')}\n## [#1] 2026-10-15 · DISCOVERY · 7\nSeal key: ${seal.keyFingerprint(KEY)}\n`;
  assert.equal(seal.keyLineOf(inBody), null);
  assert.equal(seal.verifyChain(inBody, wrong).reason, 'legacy', 'an entry body cannot claim a key for the log');
  // A legacy log gets the line under its title; its entries keep their bytes.
  const stamped = seal.withKeyLine(legacyLog, KEY);
  assert.equal(stamped, legacyLog.replace(/\n/, `\n\nSeal key: ${seal.keyFingerprint(KEY)}\n`));
  assert.deepEqual(decisions.parseDecisions(stamped).entries.map((e) => e.body), decisions.parseDecisions(legacyLog).entries.map((e) => e.body));
  assert.equal(seal.verifyChain(stamped, wrong).broken.why, 'key');
  assert.equal(seal.verifyChain(stamped, KEY).reason, 'legacy');
  assert.equal(seal.withKeyLine(stamped, KEY), null, 'a log that names a key is not stamped twice');
  assert.equal(seal.withKeyLine(prechangeLog, PRECHANGE_KEY), null, 'a sealed log keeps its bytes');
  assert.equal(seal.withKeyLine('', KEY), null);
  assert.equal(seal.withKeyLine('## [#1] 2026-10-15 · DISCOVERY · 7\nx\n', KEY), `Seal key: ${seal.keyFingerprint(KEY)}\n\n## [#1] 2026-10-15 · DISCOVERY · 7\nx\n`);
});
