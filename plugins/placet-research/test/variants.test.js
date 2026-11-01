'use strict';

// US-3/B: variant canvases under research/variants/<name>/ and the
// researcher's choice of one framing, through the CLI and through the library
// function the session server will call.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canvas = require('../hooks/lib/canvas');
const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');
const { textHash } = require('../hooks/lib/hash');
const { mechanicalReview } = require('../hooks/lib/review');
const { discardedReport } = require('../hooks/lib/choose');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');

const stateDirs = new Map();
function stateDirOf(root) {
  if (!stateDirs.has(root)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
    // The name every entry carries as `By` (SQ-177), written into the fixture's
    // own state dir. It comes before git config user.name, so the expected
    // bytes are the same on a machine with a git identity and on one without.
    fs.writeFileSync(path.join(dir, 'name'), 'A. Researcher\n');
    stateDirs.set(root, dir);
  }
  return stateDirs.get(root);
}

function run(root, args) {
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...ambient, CLAUDE_PLUGIN_ROOT: pluginRoot, PLACET_RESEARCH_STATE_DIR: stateDirOf(root) },
    encoding: 'utf8',
  });
}

// The project's key, read under the same state root the CLI runs with.
function keyOf(root) {
  const saved = process.env.PLACET_RESEARCH_STATE_DIR;
  process.env.PLACET_RESEARCH_STATE_DIR = stateDirOf(root);
  try {
    return seal.readKey(root);
  } finally {
    if (saved === undefined) delete process.env.PLACET_RESEARCH_STATE_DIR;
    else process.env.PLACET_RESEARCH_STATE_DIR = saved;
  }
}

function ok(out) {
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return out.stdout;
}

const file = (root, ...parts) => path.join(root, 'research', ...parts);
const read = (f) => fs.readFileSync(f, 'utf8');

// Writes one statement under the question with this id, where its placeholder
// still stands — the same edit the accepted-refusal test makes by hand.
function putStatement(f, id, statement) {
  const text = read(f);
  const heading = text.indexOf(`## ${id} `);
  assert.notEqual(heading, -1, `no question ${id} in ${f}`);
  const at = text.indexOf('_(empty)_', heading);
  assert.notEqual(at, -1, `question ${id} is not empty in ${f}`);
  fs.writeFileSync(f, `${text.slice(0, at)}${statement}${text.slice(at + '_(empty)_'.length)}`);
}

// A fresh project with two variants, each holding one proposal under 1.1.
function projectWithVariants() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-var-'));
  ok(run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed', '--title', 'Voice uptake']));
  ok(run(root, ['init', '--variant', 'power', '--lens', 'power and hierarchy']));
  ok(run(root, ['init', '--variant', 'sense-making', '--lens', 'collective sense-making: "who hears whom"']));
  for (const [name, statement] of [
    ['power', 'Uptake follows rank rather than argument. [proposed, unverified]'],
    ['sense-making', 'Uptake follows whether a proposal fits the frame the room already shares. [tentative, unverified]'],
  ]) {
    const f = file(root, 'variants', name, 'canvas.md');
    const text = read(f);
    const at = text.indexOf('_(empty)_');
    fs.writeFileSync(f, `${text.slice(0, at)}${statement}${text.slice(at + '_(empty)_'.length)}`);
  }
  return root;
}

// A variant canvas written by hand rather than by `init --variant`, whose
// --lens check refuses a line break: the lens line carries the double-quoted
// value the frontmatter decoder in canvas.js JSON.parses, so it can hold a real
// newline.
function writeLens(root, name, lens) {
  const f = file(root, 'variants', name, 'canvas.md');
  const text = read(f);
  assert.match(text, /^lens: .*$/m);
  fs.writeFileSync(f, text.replace(/^lens: .*$/m, `lens: ${JSON.stringify(lens)}`));
}

// The fixture's two variants plus a third whose lens came in that way.
function projectWithPlantedLens(lens) {
  const root = projectWithVariants();
  ok(run(root, ['init', '--variant', 'planted', '--lens', 'placeholder']));
  writeLens(root, 'planted', lens);
  return root;
}

test('init --variant creates a full state directory with variant and lens in the frontmatter', () => {
  const root = projectWithVariants();
  const parsed = canvas.parseCanvas(read(file(root, 'variants', 'sense-making', 'canvas.md')));
  assert.equal(parsed.frontmatter.variant, 'sense-making');
  assert.equal(parsed.frontmatter.lens, 'collective sense-making: "who hears whom"');
  assert.equal(parsed.frontmatter.project, 'voice-uptake');
  assert.equal(parsed.frontmatter.mode, 'seed');
  assert.equal(parsed.elements.length, canvas.parseCanvas(read(file(root, 'canvas.md'))).elements.length);
  assert.match(read(file(root, 'variants', 'sense-making', 'decisions.md')), /^# Decision log — voice-uptake · variant sense-making\n$/);
  // The key is the project's: no second key file anywhere in the state root.
  const keys = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else if (n === seal.KEY_FILE) keys.push(f); } };
  walk(stateDirOf(root));
  assert.equal(keys.length, 1);

  const again = run(root, ['init', '--variant', 'power', '--lens', 'x']);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /already exists; nothing written/);
  for (const args of [['init', '--variant', '../x', '--lens', 'x'], ['init', '--variant', 'Power', '--lens', 'x'], ['init', '--variant', 'y'], ['init', '--variant', 'y', '--lens', 'x', '--mode', 'bad']]) {
    assert.equal(run(root, args).status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(root, 'research', 'x')), false);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-var-bare-'));
  assert.equal(run(bare, ['init', '--variant', 'a', '--lens', 'x']).status, 1);
  assert.equal(fs.existsSync(path.join(bare, 'research')), false);
});

test('status, review and log take --variant and read and write only that variant', () => {
  const root = projectWithVariants();
  const mainLog = read(file(root, 'decisions.md'));
  const status = ok(run(root, ['status', '--variant', 'power']));
  assert.match(status, /variant power \(lens: power and hierarchy\)/);
  assert.match(status, /1 open \(1 proposal\)/);
  const review = ok(run(root, ['review', '--variant', 'power']));
  assert.match(review, /^# Mechanical review — variant power \(lens: power and hierarchy\)/);
  assert.match(review, /## Open elements \(proposals only\)\n1\n/);

  const logged = ok(run(root, ['log', 'DISCOVERY', '1.1', '--body', 'Rank is recorded in the minutes.', '--variant', 'power']));
  assert.match(logged, /^Logged #1 DISCOVERY 1\.1 in variant power, sealed [0-9a-f]{16}\./);
  assert.equal(read(file(root, 'decisions.md')), mainLog);
  const variantLog = read(file(root, 'variants', 'power', 'decisions.md'));
  assert.equal(seal.verifyChain(variantLog, keyOf(root)).status, 'verified');
  assert.match(variantLog, /## \[#1\] \d{4}-\d{2}-\d{2} · DISCOVERY · 1\.1 · seal [0-9a-f]{16}\nRank is recorded in the minutes\./);
  assert.match(ok(run(root, ['review', '--variant', 'power'])), /## Decision log\nverified: 1 sealed entry/);

  assert.equal(run(root, ['status', '--variant', 'nope']).status, 1);
  assert.equal(run(root, ['review', '--variant', 'nope']).status, 1);
  assert.equal(run(root, ['status', '--variant', '../..']).status, 2);
  assert.equal(run(root, ['log', 'DISCOVERY', '1.1', '--body', 'x', '--variant', '../../x']).status, 2);
});

// SQ-294 (F1): a variant's log carries no `Seal key:` line of its own — the key
// belongs to the root — so a variant write checked nothing and sealed with a
// key the project does not have. It asks the main log, in the main log's words.
test('a variant write with a key that is not the project\'s is refused in the main log\'s words', () => {
  const root = projectWithVariants();
  const keyFile = path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), seal.KEY_FILE);
  fs.writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  const mainBefore = read(file(root, 'decisions.md'));
  const variantBefore = read(file(root, 'variants', 'power', 'decisions.md'));

  const main = run(root, ['log', 'DISCOVERY', '1.1', '--body', 'x']);
  const variant = run(root, ['log', 'DISCOVERY', '1.1', '--body', 'x', '--variant', 'power']);
  assert.equal(main.status, 1, main.stdout);
  assert.equal(variant.status, 1, variant.stdout);
  assert.match(variant.stdout, /^Cannot log: The sealing key on this machine is not the project's: the Seal key line in research\/decisions\.md names a different key; nothing is written\. Get the project's key from the person who shared the project and join with it\.$/m);
  assert.equal(variant.stdout, main.stdout, 'the same sentence the main log uses');
  assert.equal(read(file(root, 'decisions.md')), mainBefore);
  assert.equal(read(file(root, 'variants', 'power', 'decisions.md')), variantBefore, 'the variant log is untouched');
});

test('accept works on the main canvas only', () => {
  const root = projectWithVariants();
  const before = read(file(root, 'variants', 'power', 'canvas.md'));
  const out = run(root, ['accept', '1.1', '--variant', 'power']);
  assert.equal(out.status, 2);
  assert.match(out.stdout, /accept works on the main canvas only/);
  assert.equal(read(file(root, 'variants', 'power', 'canvas.md')), before);
});

test('choose copies the variant\'s statements into the main canvas and seals a framing DECISION in the main log', () => {
  const root = projectWithVariants();
  const mainBefore = read(file(root, 'canvas.md'));
  const variantText = read(file(root, 'variants', 'sense-making', 'canvas.md'));
  const variantLogs = ['power', 'sense-making'].map((n) => read(file(root, 'variants', n, 'decisions.md')));

  const out = ok(run(root, ['choose', 'sense-making', '--why', 'It explains the two meetings the power lens cannot.']));
  assert.match(out, /^Chose framing sense-making \(lens: collective sense-making: "who hears whom"\): 1 statement copied into research\/canvas\.md\./);

  const mainAfter = read(file(root, 'canvas.md'));
  // The main frontmatter stays; everything below it is the variant's.
  const head = (t) => t.slice(0, t.indexOf('\n---\n') + 5);
  assert.equal(head(mainAfter), head(mainBefore));
  assert.equal(mainAfter.slice(head(mainAfter).length), variantText.slice(head(variantText).length));
  const statements = canvas.allStatements(canvas.parseCanvas(mainAfter)).filter((s) => s.marker !== null);
  assert.deepEqual(statements.map((s) => [s.question, s.marker]), [['1.1', 'tentative']]);

  const log = decisions.parseDecisions(read(file(root, 'decisions.md')));
  const entry = log.entries[log.entries.length - 1];
  assert.equal(entry.kind, 'DECISION');
  assert.equal(entry.ref, 'framing chosen: sense-making');
  assert.equal(entry.hash, textHash(variantText));
  assert.match(entry.body, /\*\*Why:\*\* It explains the two meetings the power lens cannot\./);
  assert.match(entry.body, /\*\*Rejected:\*\* power \(lens: power and hierarchy\)$/m);
  assert.match(ok(run(root, ['review'])), /## Decision log\nverified: 1 sealed entry/);

  // The variants stay as the record, logs untouched.
  assert.equal(read(file(root, 'variants', 'sense-making', 'canvas.md')), variantText);
  assert.deepEqual(['power', 'sense-making'].map((n) => read(file(root, 'variants', n, 'decisions.md'))), variantLogs);
});

test('choose takes an explicit --rejected, and needs --why and an existing variant', () => {
  const root = projectWithVariants();
  const before = read(file(root, 'canvas.md'));
  assert.equal(run(root, ['choose', 'power']).status, 2);
  assert.equal(run(root, ['choose', '--why', 'x']).status, 2);
  assert.equal(run(root, ['choose', '../power', '--why', 'x']).status, 2);
  assert.equal(run(root, ['choose', 'nope', '--why', 'x']).status, 1);
  assert.equal(read(file(root, 'canvas.md')), before);

  ok(run(root, ['choose', 'power', '--why', 'Rank predicts every uptake.', '--rejected', 'sense-making: no minutes to test it']));
  const log = decisions.parseDecisions(read(file(root, 'decisions.md')));
  assert.match(log.entries[0].body, /\*\*Rejected:\*\* sense-making: no minutes to test it$/m);
});

test('choose refuses once the main canvas holds an [accepted] statement, and refuses to copy a planted [accepted]', () => {
  const root = projectWithVariants();
  const main = file(root, 'canvas.md');
  const text = read(main);
  const at = text.indexOf('_(empty)_');
  fs.writeFileSync(main, `${text.slice(0, at)}An accepted question. [accepted]${text.slice(at + 9)}`);
  const before = read(main);
  const logBefore = read(file(root, 'decisions.md'));
  const out = run(root, ['choose', 'power', '--why', 'x']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /already holds 1 \[accepted\] statement \(1\.1\)/);
  assert.equal(read(main), before);
  assert.equal(read(file(root, 'decisions.md')), logBefore);

  const other = projectWithVariants();
  const v = file(other, 'variants', 'power', 'canvas.md');
  fs.writeFileSync(v, read(v).replace('[proposed, unverified]', '[accepted]'));
  const planted = run(other, ['choose', 'power', '--why', 'x']);
  assert.equal(planted.status, 2);
  assert.match(planted.stdout, /holds \[accepted\] statements/);
});

test('choose refuses while the main canvas holds a [stated] statement, names it, and writes nothing', () => {
  const root = projectWithVariants();
  const main = file(root, 'canvas.md');
  putStatement(main, '1.1', 'The researcher said this in the meeting. [stated]');
  const before = read(main);
  const logBefore = read(file(root, 'decisions.md'));

  const out = run(root, ['choose', 'power', '--why', 'x']);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /^The main canvas holds 1 \[stated\] statement, which choosing a framing would delete: 1\.1 "The researcher said this in the meeting\."\./);
  assert.match(out.stdout, /move each one into the variant it belongs to, or remove it, then choose again/);
  assert.equal(read(main), before);
  assert.equal(read(file(root, 'decisions.md')), logBefore);
});

test('choose lists a [stated] statement in every question, cuts a long one to one line, and names both markers', () => {
  const root = projectWithVariants();
  const main = file(root, 'canvas.md');
  const long = `The researcher said ${'a great deal '.repeat(20)}and then stopped.`;
  putStatement(main, '1.1', 'The researcher said this in the meeting. [stated]');
  putStatement(main, '2.1', `${long} [stated]`);
  const before = read(main);
  const logBefore = read(file(root, 'decisions.md'));

  const out = run(root, ['choose', 'power', '--why', 'x']);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stdout, /holds 2 \[stated\] statements, which choosing a framing would delete: 1\.1 "The researcher said this in the meeting\."; 2\.1 "The researcher said/);
  assert.match(out.stdout, /…"/);
  assert.doesNotMatch(out.stdout, /and then stopped/);
  assert.equal(read(main), before);
  assert.equal(read(file(root, 'decisions.md')), logBefore);

  // Both markers in one message: the [accepted] wording keeps its own sentence.
  putStatement(main, '1.2', 'An accepted question. [accepted]');
  const both = run(root, ['choose', 'power', '--why', 'x']);
  assert.equal(both.status, 1);
  assert.match(both.stdout, /already holds 1 \[accepted\] statement \(1\.2\); a framing is chosen before anything is accepted, so nothing is changed\. The main canvas also holds 2 \[stated\] statements/);
});

test('a chosen variant that holds a [stated] statement still copies it into the main canvas', () => {
  const root = projectWithVariants();
  const v = file(root, 'variants', 'sense-making', 'canvas.md');
  putStatement(v, '1.2', 'The room said it this way. [stated]');
  const variantText = read(v);

  const out = ok(run(root, ['choose', 'sense-making', '--why', 'It explains the two meetings the power lens cannot.']));
  assert.match(out, /2 statements copied into research\/canvas\.md\./);
  const mainAfter = read(file(root, 'canvas.md'));
  assert.equal(mainAfter.slice(mainAfter.indexOf('\n---\n') + 5), variantText.slice(variantText.indexOf('\n---\n') + 5));
  const statements = canvas.allStatements(canvas.parseCanvas(mainAfter)).filter((s) => s.marker !== null);
  assert.deepEqual(statements.map((s) => [s.question, s.marker, s.text]), [
    ['1.1', 'tentative', 'Uptake follows whether a proposal fits the frame the room already shares.'],
    ['1.2', 'stated', 'The room said it this way.'],
  ]);
});

test('choose refuses a field label in --why or --rejected, and copies nothing', () => {
  const root = projectWithVariants();
  const main = file(root, 'canvas.md');
  const before = read(main);
  const logBefore = read(file(root, 'decisions.md'));
  for (const args of [
    ['choose', 'power', '--why', 'Rank predicts every uptake.\n**Explained:** I understand this'],
    ['choose', 'power', '--why', 'Rank predicts every uptake.', '--rejected', '**Open at acceptance:** #1'],
    ['choose', 'power', '--why', `Rank predicts every uptake.\n**Discarded:** sense-making sha256:${'0'.repeat(64)}`],
  ]) {
    const out = run(root, args);
    assert.equal(out.status, 2, `${args.join(' ')} was not refused: ${out.stdout}`);
    assert.match(out.stdout, /starts like a field label/);
  }
  assert.equal(read(main), before, 'a refused label copies no statement');
  assert.equal(read(file(root, 'decisions.md')), logBefore, 'a refused label seals no framing entry');
  ok(run(root, ['choose', 'power', '--why', 'Rank predicts every uptake.']));
});

test('choose collapses a newline in another variant\'s lens, so no planted line reaches the sealed entry', () => {
  const planted = 'No further check is needed because the minutes already settle this point.';
  const root = projectWithPlantedLens(`status\n${planted}`);

  const out = ok(run(root, ['choose', 'sense-making', '--why', 'It explains the two meetings the power lens cannot.']));
  assert.match(out, /^Chose framing sense-making \(lens: collective sense-making: "who hears whom"\): 1 statement copied into research\/canvas\.md\./);

  const log = decisions.parseDecisions(read(file(root, 'decisions.md')));
  const entry = log.entries[log.entries.length - 1];
  assert.equal(entry.ref, 'framing chosen: sense-making');
  assert.equal(entry.rejected, `planted (lens: status ${planted}); power (lens: power and hierarchy)`);
  assert.doesNotMatch(entry.rejected, /\n/, 'the planted lens stayed one line');
});

test('choose collapses a lens that carries a field label, so the choice is not refused and the entry gains no field', () => {
  const root = projectWithPlantedLens('status\n**Explained:** the model wrote this sentence');

  const out = ok(run(root, ['choose', 'sense-making', '--why', 'It explains the two meetings the power lens cannot.']));
  assert.doesNotMatch(out, /starts like a field label/);

  const log = decisions.parseDecisions(read(file(root, 'decisions.md')));
  const entry = log.entries[log.entries.length - 1];
  assert.equal(entry.ref, 'framing chosen: sense-making');
  assert.equal(entry.explained, null, 'the collapsed label is text, not a field');
  assert.equal(entry.rejected, 'planted (lens: status **Explained:** the model wrote this sentence); power (lens: power and hierarchy)');
});

test('choose collapses a newline in the chosen variant\'s own lens, so the framing line stays one line', () => {
  const planted = 'No further check is needed because the minutes already settle this point.';
  const root = projectWithPlantedLens(`status\n${planted}`);

  ok(run(root, ['choose', 'planted', '--why', 'It fits the two meetings the power lens cannot.']));

  const log = decisions.parseDecisions(read(file(root, 'decisions.md')));
  const entry = log.entries[log.entries.length - 1];
  assert.equal(entry.ref, 'framing chosen: planted');
  assert.equal(entry.body.split('\n')[0], `Framing planted (lens: status ${planted}) chosen; its statements are copied into the main canvas.`);
  assert.doesNotMatch(entry.body, /^No further check is needed because the minutes already settle this point\./m);
});

test('mechanicalReview does not count a framing-chosen DECISION as an acceptance', () => {
  const root = projectWithVariants();
  ok(run(root, ['choose', 'power', '--why', 'x']));
  const decisionsText = read(file(root, 'decisions.md'));
  const parsed = canvas.parseCanvas(read(file(root, 'canvas.md')));
  // With the key the entry verifies; without it the DECISION is unverifiable
  // here. It is listed as a DECISION that does not verify (SQ-139), and still is
  // not reported as an acceptance lacking cover.
  for (const key of [keyOf(root), null]) {
    const report = mechanicalReview({ parsed, graph: null, decisionsText, key });
    assert.equal(report.ledger.status, key ? 'verified' : 'unverifiable');
    assert.deepEqual(report.staleAcceptances, []);
    assert.deepEqual(report.unloggedAcceptances, []);
    assert.deepEqual(report.unverifiedDecisions.map((d) => [d.seq, d.ref, d.state]), key ? [] : [[1, 'framing chosen: power', 'unverifiable']]);
  }
});

// The SHA-256 of a file's bytes, as `shasum -a 256` prints it.
const sha256Of = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('choose seals the SHA-256 of every discarded variant canvas as it stood at the choice, whatever --rejected says', () => {
  const root = projectWithVariants();
  ok(run(root, ['init', '--variant', 'rituals', '--lens', 'meeting rituals']));
  const [power, rituals] = ['power', 'rituals'].map((n) => sha256Of(file(root, 'variants', n, 'canvas.md')));

  ok(run(root, ['choose', 'sense-making', '--why', 'It explains the two meetings the power lens cannot.', '--rejected', 'power and rituals: no minutes to test them']));
  const text = read(file(root, 'decisions.md'));
  const entry = decisions.parseDecisions(text).entries[0];
  assert.equal(entry.discarded, `power sha256:${power}; rituals sha256:${rituals}`);
  assert.equal(entry.rejected, 'power and rituals: no minutes to test them');
  assert.match(entry.body, /\n\*\*Rejected:\*\* [^\n]*\n\*\*Discarded:\*\* power sha256:[0-9a-f]{64}; rituals sha256:[0-9a-f]{64}$/, 'Discarded follows Rejected');
  assert.equal(seal.verifyChain(text, keyOf(root)).status, 'verified');
  // Sealed like the rest of the entry: another digest breaks the chain there.
  const forged = seal.verifyChain(text.replace(power, '0'.repeat(64)), keyOf(root));
  assert.deepEqual([forged.status, forged.broken.seq], ['broken', 1]);

  assert.match(ok(run(root, ['review'])), /\n## Discarded framings\n\([^\n]*\)\n#1 power: unchanged since the choice\n#1 rituals: unchanged since the choice\n/);
  const powerFile = file(root, 'variants', 'power', 'canvas.md');
  fs.appendFileSync(powerFile, 'A line added after the choice.\n');
  fs.rmSync(file(root, 'variants', 'rituals', 'canvas.md'));
  const after = ok(run(root, ['review']));
  assert.match(after, new RegExp(`\\n#1 power: CHANGED since the choice — recorded sha256:${power}, now sha256:${sha256Of(powerFile)}\\n`));
  assert.match(after, new RegExp(`\\n#1 rituals: canvas missing now — recorded sha256:${rituals}\\n`));
});

test('choose records a discarded variant whose canvas is missing as missing, and still chooses', () => {
  const root = projectWithVariants();
  ok(run(root, ['init', '--variant', 'rituals', '--lens', 'meeting rituals']));
  const ritualsFile = file(root, 'variants', 'rituals', 'canvas.md');
  fs.rmSync(ritualsFile);
  const power = sha256Of(file(root, 'variants', 'power', 'canvas.md'));

  ok(run(root, ['choose', 'sense-making', '--why', 'It explains the two meetings the power lens cannot.']));
  const text = read(file(root, 'decisions.md'));
  const entry = decisions.parseDecisions(text).entries[0];
  assert.equal(entry.discarded, `power sha256:${power}; rituals missing`);
  assert.equal(entry.rejected, 'power (lens: power and hierarchy)', 'the default Rejected text is what it was');
  assert.equal(seal.verifyChain(text, keyOf(root)).status, 'verified');

  assert.match(ok(run(root, ['review'])), /\n#1 rituals: missing at the choice, still missing\n/);
  fs.writeFileSync(ritualsFile, 'written after the choice\n');
  assert.match(ok(run(root, ['review'])), new RegExp(`\\n#1 rituals: missing at the choice, present now \\(sha256:${sha256Of(ritualsFile)}\\)\\n`));
});

test('choose with no other variant records that nothing was discarded, and review lists no discarded framing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-var-'));
  ok(run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']));
  ok(run(root, ['init', '--variant', 'power', '--lens', 'power and hierarchy']));
  ok(run(root, ['choose', 'power', '--why', 'Rank predicts every uptake.']));
  const text = read(file(root, 'decisions.md'));
  assert.equal(decisions.parseDecisions(text).entries[0].discarded, 'none');
  assert.equal(seal.verifyChain(text, keyOf(root)).status, 'verified');
  assert.doesNotMatch(ok(run(root, ['review'])), /Discarded framings/);
});

// Sealed at 0869951, before the framing entry recorded its discarded variants,
// under the key 'cd'.repeat(32): bytes and key are frozen together (fixtures/README.md).
const prechangeChoice = read(path.join(__dirname, 'fixtures', 'prechange-choice-decisions.md'));
const PRECHANGE_CHOICE_KEY = Buffer.from('cd'.repeat(32), 'hex');

test('a framing choice sealed before the Discarded field still verifies and reads as it did, with no discarded record', () => {
  const result = seal.verifyChain(prechangeChoice, PRECHANGE_CHOICE_KEY);
  assert.deepEqual([result.status, [...result.verified]], ['verified', [1]]);
  const [entry] = decisions.parseDecisions(prechangeChoice).entries;
  assert.deepEqual(
    [entry.kind, entry.ref, entry.hash, entry.by, entry.why, entry.rejected, entry.discarded],
    ['DECISION', 'framing chosen: sense-making', '9c18603d', 'A. Researcher', 'It explains the two meetings the power lens cannot.', 'power (lens: power and hierarchy)', null],
  );
  const parsed = canvas.parseCanvas(read(file(projectWithVariants(), 'canvas.md')));
  const report = mechanicalReview({ parsed, graph: null, decisionsText: prechangeChoice, key: PRECHANGE_CHOICE_KEY });
  assert.deepEqual([report.ledger.status, report.unverifiedDecisions, report.staleAcceptances], ['verified', [], []]);
  assert.deepEqual(discardedReport(os.tmpdir(), prechangeChoice), [], 'nothing was recorded, so nothing is compared');
});

test('discardedReport names a Discarded item it cannot read instead of skipping it', () => {
  const root = projectWithVariants();
  const log = `${decisions.header('voice-uptake')}\n${decisions.formatEntry({ seq: 1, date: '2026-11-01', kind: 'DECISION', ref: 'framing chosen: power', body: 'Framing power chosen.', discarded: 'Sense-Making sha256:abc' })}`;
  assert.deepEqual(discardedReport(root, log).slice(2), ['#1: unreadable Discarded item "Sense-Making sha256:abc"', '']);
});
