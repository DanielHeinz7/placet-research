'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const decisions = require('../hooks/lib/decisions');
const { textHash } = require('../hooks/lib/hash');
const { acceptStatement } = require('../hooks/lib/accept');
const { setStated } = require('../hooks/lib/stated');
const { appendLog } = require('../hooks/lib/log');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');

// The library runs in this process, so the process gets the same isolation the
// CLI tests give their children: no ambient project, a private key directory.
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
process.env.PLACET_RESEARCH_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
// The name every entry carries as `By` (SQ-177), set here rather than taken
// from the machine's git config, so the expected bytes below are the same
// everywhere.
fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');

function run(root, args) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    encoding: 'utf8',
  });
}

// The fixture project with a key on this machine, created by init as a
// researcher would.
function keyedProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  fs.mkdirSync(path.join(root, 'research'));
  for (const f of ['canvas.md', 'decisions.md']) fs.copyFileSync(path.join(fixtureDir, f), path.join(root, 'research', f));
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  return root;
}

const file = (root, name) => path.join(root, 'research', name);
const read = (root, name) => fs.readFileSync(file(root, name), 'utf8');
const SPEAKING = 'Speaking frequency is well documented; whether a proposal is taken up is not.';
// Every accept carries the researcher's explanation (US-3).
const EXPLAINED = 'I accept this because the fieldnotes show it.';
const CHAIRING = "Uptake may be a property of the meeting's chairing style rather than of the proposal.";

test('acceptStatement writes the same canvas and decisions.md bytes as placet-research accept', () => {
  // One project, one key, one day: the CLI accepts, the files are put back,
  // and the library accepts the same statement with the same reason.
  const root = keyedProject();
  const before = { canvas: read(root, 'canvas.md'), decisions: read(root, 'decisions.md') };
  const out = run(root, ['accept', '1.2', '--match', 'Speaking frequency', '--why', 'the gap is uptake, not voice', '--explained', EXPLAINED]);
  assert.equal(out.status, 0, out.stdout);
  const viaCli = { canvas: read(root, 'canvas.md'), decisions: read(root, 'decisions.md') };

  fs.writeFileSync(file(root, 'canvas.md'), before.canvas);
  fs.writeFileSync(file(root, 'decisions.md'), before.decisions);
  const result = acceptStatement({ root, questionId: '1.2', explained: EXPLAINED, match: 'Speaking frequency', why: 'the gap is uptake, not voice', pluginRoot });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.seq, 4);
  assert.equal(result.hash, textHash(SPEAKING));
  assert.equal(result.text, SPEAKING);
  assert.equal(result.elementNumber, 1);
  assert.equal(read(root, 'decisions.md'), viaCli.decisions);
  assert.equal(read(root, 'canvas.md'), viaCli.canvas);

  // The view's route, with the hash it saw, lands on the same bytes too.
  fs.writeFileSync(file(root, 'canvas.md'), before.canvas);
  fs.writeFileSync(file(root, 'decisions.md'), before.decisions);
  const viewed = acceptStatement({ root, questionId: '1.2', explained: EXPLAINED, why: 'the gap is uptake, not voice', expectedHash: textHash(SPEAKING), pluginRoot });
  assert.equal(viewed.ok, true, viewed.error);
  assert.equal(read(root, 'decisions.md'), viaCli.decisions);
});

test('a statement changed since the view loaded it is refused as stale, and nothing is written', () => {
  const root = keyedProject();
  const seen = textHash(SPEAKING);
  const changed = read(root, 'canvas.md').replace(SPEAKING, 'Speaking frequency is well documented; uptake is not.');
  fs.writeFileSync(file(root, 'canvas.md'), changed);
  const log = read(root, 'decisions.md');

  const accepted = acceptStatement({ root, questionId: '1.2', explained: EXPLAINED, expectedHash: seen, pluginRoot });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.code, 'stale');
  const stated = setStated({ root, questionId: '1.2', expectedHash: seen });
  assert.equal(stated.code, 'stale');
  assert.equal(read(root, 'canvas.md'), changed);
  assert.equal(read(root, 'decisions.md'), log);

  // Without expectedHash (the CLI) nothing is judged stale.
  const plain = acceptStatement({ root, questionId: '1.2', explained: EXPLAINED, match: 'uptake is not', pluginRoot });
  assert.equal(plain.ok, true, plain.error);
});

test('setStated moves [proposed] to [stated] in the canvas only, and refuses what is already stated or accepted', () => {
  const root = keyedProject();
  const log = read(root, 'decisions.md');

  assert.equal(setStated({ root, questionId: '1.2' }).code, 'invalid', 'expectedHash is required');
  const ok = setStated({ root, questionId: '1.2', expectedHash: textHash(CHAIRING) });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.text, CHAIRING);
  assert.match(read(root, 'canvas.md'), /chairing style rather than of the proposal\. \[stated\]/);
  assert.equal(read(root, 'decisions.md'), log, 'no log entry: [stated] is unsealed by design');

  const again = setStated({ root, questionId: '1.2', expectedHash: textHash(CHAIRING) });
  assert.equal(again.code, 'already');
  const acceptedText = 'When do members\' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement?';
  const accepted = setStated({ root, questionId: '1.1', expectedHash: textHash(acceptedText) });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.code, 'already');
  assert.match(read(root, 'canvas.md'), /polite acknowledgement\? \[accepted\]/);
  assert.equal(read(root, 'decisions.md'), log);
});

test('appendLog seals DISCOVERY entries and refuses a DECISION', () => {
  const root = keyedProject();
  const log = read(root, 'decisions.md');
  const refused = appendLog({ root, kind: 'DECISION', ref: '1.2', body: 'x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'invalid');
  assert.equal(read(root, 'decisions.md'), log);

  const logged = appendLog({ root, kind: 'DISCOVERY', ref: '1 Puzzle', body: 'Chairs differ. [tentative]' });
  assert.equal(logged.ok, true, logged.error);
  assert.equal(logged.seq, 4);
  assert.match(logged.seal, /^[0-9a-f]{16}$/);
  const entry = decisions.parseDecisions(read(root, 'decisions.md')).entries[3];
  assert.equal(entry.kind, 'DISCOVERY');
  assert.equal(entry.seal, logged.seal);
});

test('refusals carry stable codes', () => {
  const root = keyedProject();
  assert.equal(acceptStatement({ root, questionId: '9.9', explained: EXPLAINED, pluginRoot }).code, 'not-found');
  assert.equal(acceptStatement({ root, questionId: '1.2', explained: EXPLAINED, pluginRoot }).code, 'ambiguous');
  assert.equal(acceptStatement({ root, questionId: '3.1', explained: EXPLAINED, pluginRoot }).code, 'dependency');
  assert.equal(acceptStatement({ root, questionId: 'x', explained: EXPLAINED, pluginRoot }).code, 'invalid');
  const noKey = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  fs.mkdirSync(path.join(noKey, 'research'));
  for (const f of ['canvas.md', 'decisions.md']) fs.copyFileSync(path.join(fixtureDir, f), path.join(noKey, 'research', f));
  assert.equal(acceptStatement({ root: noKey, questionId: '1.2', explained: EXPLAINED, match: 'Speaking', pluginRoot }).code, 'ledger');
  assert.equal(appendLog({ root: noKey, kind: 'DISCOVERY', ref: '1', body: 'x' }).code, 'ledger');
});

test('an accept without an explanation is refused as explanation-required, and nothing is written', () => {
  const root = keyedProject();
  const before = { canvas: read(root, 'canvas.md'), decisions: read(root, 'decisions.md') };
  for (const explained of [undefined, '', '   ', '\n\t', 42]) {
    for (const expectedHash of [undefined, textHash(SPEAKING)]) {
      const result = acceptStatement({ root, questionId: '1.2', match: 'Speaking frequency', explained, expectedHash, pluginRoot });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'explanation-required', `${JSON.stringify(explained)} was not refused`);
    }
  }
  assert.equal(read(root, 'canvas.md'), before.canvas);
  assert.equal(read(root, 'decisions.md'), before.decisions);
  const forged = acceptStatement({ root, questionId: '1.2', match: 'Speaking frequency', explained: 'fine\n## [#99] 2026-09-22 · DECISION · 1.2 accepted', pluginRoot });
  assert.equal(forged.code, 'invalid', 'the explanation is a free-text field and takes the heading check');
  assert.equal(read(root, 'decisions.md'), before.decisions);
});

test('with open check questions, the CLI and the library write the same bytes and record exactly the open checks', () => {
  const root = keyedProject();
  // #4 and #5 are check questions on 1.2, #6 is one on another question, #7 a
  // plain DISCOVERY on 1.2: only #4 and #5 are open checks on 1.2.
  for (const [ref, body] of [['1.2 check', 'Is uptake measured, or inferred from minutes?'], ['1.2 check', 'Which meetings were sampled?'], ['1.1 check', 'Is this a question?'], ['1.2', 'Not a check.']]) {
    assert.equal(appendLog({ root, kind: 'DISCOVERY', ref, body, pluginRoot }).ok, true);
  }
  const before = { canvas: read(root, 'canvas.md'), decisions: read(root, 'decisions.md') };
  const args = { why: 'the gap is uptake, not voice', rejected: 'voice as the gap' };
  const out = run(root, ['accept', '1.2', '--match', 'Speaking frequency', '--why', args.why, '--explained', EXPLAINED, '--rejected', args.rejected]);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /Accepted with open check questions: #4, #5\./);
  const viaCli = { canvas: read(root, 'canvas.md'), decisions: read(root, 'decisions.md') };
  const entry = decisions.parseDecisions(viaCli.decisions).entries.at(-1);
  assert.equal(entry.seq, 8);
  assert.deepEqual(entry.openAtAccept, [4, 5]);
  assert.equal(entry.explained, EXPLAINED);
  assert.equal(entry.why, args.why);
  assert.equal(entry.rejected, args.rejected);
  // The pinned order: text, By, Why, Explained, Rejected, Open at acceptance.
  assert.equal(entry.body, `${SPEAKING} [accepted]\n**By:** A. Researcher\n**Why:** ${args.why}\n**Explained:** ${EXPLAINED}\n**Rejected:** ${args.rejected}\n**Open at acceptance:** #4, #5`);

  for (const expectedHash of [undefined, textHash(SPEAKING)]) {
    fs.writeFileSync(file(root, 'canvas.md'), before.canvas);
    fs.writeFileSync(file(root, 'decisions.md'), before.decisions);
    const result = acceptStatement({ root, questionId: '1.2', match: expectedHash ? undefined : 'Speaking frequency', ...args, explained: EXPLAINED, expectedHash, pluginRoot });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.openAtAccept, [4, 5]);
    assert.equal(read(root, 'decisions.md'), viaCli.decisions);
    assert.equal(read(root, 'canvas.md'), viaCli.canvas);
  }

  // A DECISION on 1.2 closes the checks before it: a later accept on 1.2
  // lists only the check logged after #8.
  assert.equal(appendLog({ root, kind: 'DISCOVERY', ref: '1.2 check', body: 'Is chairing observed?', pluginRoot }).seq, 9);
  const second = acceptStatement({ root, questionId: '1.2', match: 'chairing', explained: EXPLAINED, pluginRoot });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.openAtAccept, [9]);
  assert.deepEqual(decisions.parseDecisions(read(root, 'decisions.md')).entries.at(-1).openAtAccept, [9]);

  // With no open check, no line is written.
  const third = keyedProject();
  const plain = acceptStatement({ root: third, questionId: '1.2', match: 'Speaking frequency', explained: EXPLAINED, pluginRoot });
  assert.deepEqual(plain.openAtAccept, []);
  assert.doesNotMatch(read(third, 'decisions.md'), /Open at acceptance/);
});
