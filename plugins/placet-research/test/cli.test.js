'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canvas = require('../hooks/lib/canvas');
const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');
const { textHash } = require('../hooks/lib/hash');
const { agendaOf, agendaMarkdown } = require('../hooks/lib/agenda');
const { ledgerSummary } = require('../hooks/lib/review');
const { protocolOf } = require('../hooks/lib/protocol');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');
// Every accept carries the researcher's explanation (US-3).
const EXPLAINED = 'I accept this because the fieldnotes show it.';

function makeProject(withState = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  if (withState) {
    fs.mkdirSync(path.join(root, 'research'));
    fs.copyFileSync(path.join(fixtureDir, 'canvas.md'), path.join(root, 'research', 'canvas.md'));
    fs.copyFileSync(path.join(fixtureDir, 'decisions.md'), path.join(root, 'research', 'decisions.md'));
  }
  return root;
}

// One harness state directory per fixture project, so the key `init` creates
// is the key `accept` and `review` read — as on a real machine.
const stateDirs = new Map();
function stateDirOf(root) {
  if (!stateDirs.has(root)) stateDirs.set(root, fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-')));
  return stateDirs.get(root);
}

// The name every entry carries as `By` (SQ-177). Set in the fixture's state
// dir, which comes before git config user.name, so the expected bytes are the
// same on a machine with a git identity and on one without.
function setName(root, name = 'A. Researcher') {
  fs.writeFileSync(path.join(stateDirOf(root), 'name'), `${name}\n`);
}

function run(root, args, env = {}) {
  // Claude Code sets CLAUDE_PROJECT_DIR; an inherited value would point every
  // fixture at the real project, so it is stripped here. PLACET_RESEARCH_DIR
  // would move research/ somewhere else for the same reason.
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...ambient,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PLACET_RESEARCH_STATE_DIR: stateDirOf(root),
      ...env,
    },
    encoding: 'utf8',
  });
}

function readLog(root) {
  return fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8');
}

// The fixture project as a researcher would have it after upgrading: a legacy
// log and a key on this machine, created by init on the existing project, and
// a name of their own (SQ-177), so every entry the CLI writes from here carries
// the same By whatever git config on the machine running the suite says.
function keyedProject() {
  const root = makeProject();
  setName(root);
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  return root;
}

test('init creates canvas.md from the template and an empty decision log; refuses to overwrite', () => {
  const root = makeProject(false);
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed', '--outlet', 'Organization Science']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const text = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const parsed = canvas.parseCanvas(text);
  assert.equal(parsed.frontmatter.project, 'voice-uptake');
  assert.equal(parsed.frontmatter.mode, 'seed');
  assert.equal(parsed.frontmatter.outlet, 'Organization Science');
  assert.equal(parsed.frontmatter.profile, 'is-qualitative');
  assert.match(parsed.frontmatter.created, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(parsed.elements.length, 9);
  assert.equal(canvas.allStatements(parsed).length, 0);
  // The sealing key lives outside the repository, mode 0600, and init says so.
  const keyFile = path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), 'seal.key');
  assert.ok(fs.existsSync(keyFile), keyFile);
  // The log names that key by its fingerprint, never by the key (SQ-286).
  const fingerprint = seal.keyFingerprint(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'));
  assert.equal(fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8'), `${decisions.header('voice-uptake')}\nSeal key: ${fingerprint}\n`);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.match(out.stdout, /Sealing key created/);
  assert.match(out.stdout, /0600/);
  const again = run(root, ['init', '--project', 'x', '--mode', 'seed']);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /already exists/);
  const bad = run(makeProject(false), ['init', '--project', 'x', '--mode', 'whatever']);
  assert.equal(bad.status, 2);
});

test('--help and -h print the usage and exit 0, with a subcommand and without one', () => {
  const root = makeProject(false);
  for (const args of [['--help'], ['-h'], ['init', '--help'], ['init', '-h'], ['status', '--help'], ['accept', '1.1', '-h'], []]) {
    const label = args.join(' ') || '<no command>';
    const out = run(root, args);
    assert.equal(out.status, 0, `${label}: ${out.stdout}${out.stderr}`);
    assert.equal(out.stderr, '', `${label} wrote to stderr`);
    assert.match(out.stdout, /^placet-research init --project <slug>/, label);
    assert.match(out.stdout, /\[--title <text>\]/, label);
    assert.match(out.stdout, /placet-research serve \[--no-open\]/, label);
    assert.match(out.stdout, /placet-research title \[<text>\]/, label);
  }
  assert.equal(fs.existsSync(path.join(root, 'research')), false, 'a help call writes nothing');
});

test('init quotes the frontmatter values that are the researcher\'s own text, so ": " and a quote survive a real YAML reader', () => {
  const root = makeProject(false);
  const outlet = 'open: ISR / MISQ / ETP ("special issue")';
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'import', '--outlet', outlet]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const text = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const parsed = canvas.parseCanvas(text);
  assert.deepEqual(parsed.problems, [], 'the frontmatter must still parse');
  assert.equal(parsed.frontmatter.outlet, outlet, 'the value reads back unchanged, with no quotes left on it');
  assert.equal(parsed.frontmatter.project, 'voice-uptake');
  // The line pandoc refused as bare in the pilot (SQ-73) is now a double-quoted
  // scalar whose escaping is JSON's, which YAML reads too.
  assert.ok(text.includes(`outlet: ${JSON.stringify(outlet)}\n`), text.split('\n').slice(0, 8).join('\n'));
  // Quoting must not change the ordinary shapes: an outlet left off, and a slug.
  const bare = makeProject(false);
  assert.equal(run(bare, ['init', '--project', 'x', '--mode', 'seed']).status, 0);
  const bareParsed = canvas.parseCanvas(fs.readFileSync(path.join(bare, 'research', 'canvas.md'), 'utf8'));
  assert.equal(bareParsed.frontmatter.outlet, '');
  assert.equal(bareParsed.frontmatter.project, 'x');
});

test('init --title writes the paper\'s own text as a quoted scalar after project:, and no title line without it', () => {
  const root = makeProject(false);
  const title = 'Voice uptake: the "unheard" patient in ISR';
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed', '--title', title]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const text = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const parsed = canvas.parseCanvas(text);
  assert.deepEqual(parsed.problems, [], 'the frontmatter must still parse');
  assert.equal(parsed.frontmatter.title, title, 'the value reads back unchanged, with no quotes left on it');
  assert.equal(parsed.frontmatter.project, 'voice-uptake', 'the title line leaves the fields around it alone');
  assert.equal(parsed.frontmatter.outlet, '');
  // The line sits directly after project:, quoted the way outlet and project are.
  assert.ok(text.includes(`project: "voice-uptake"\ntitle: ${JSON.stringify(title)}\n`), text.split('\n').slice(0, 9).join('\n'));
  // Without --title there is no line at all, so the view falls back to the slug.
  const bare = makeProject(false);
  assert.equal(run(bare, ['init', '--project', 'x', '--mode', 'seed']).status, 0);
  const bareText = fs.readFileSync(path.join(bare, 'research', 'canvas.md'), 'utf8');
  assert.equal(canvas.parseCanvas(bareText).frontmatter.title, undefined);
  assert.ok(!/^title:/m.test(bareText), bareText.split('\n').slice(0, 9).join('\n'));
});

test('init --title on an existing project leaves the canvas byte-identical and names the title command', () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed', '--title', 'A title that must not land']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^--title was not applied: research\/canvas\.md already exists; run placet-research title "<text>" to set it\.$/m);
  assert.doesNotMatch(out.stdout, /by hand/, 'the old hand-edit wording is gone');
  assert.equal(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'), before);
  assert.equal(readLog(root), fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8'), 'the message is the whole effect');
});

test('title writes the line after project:, and every other byte of the canvas stays as it was', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const before = fs.readFileSync(file, 'utf8');
  const logBefore = readLog(root);
  // The title is the researcher's own text: a quote, a colon, a hash and
  // non-ASCII, the shapes the frontmatter quoting has to survive.
  const title = 'Wissen, was man gebaut hat: "Vibe Coding" #1 — für Dana';
  const out = run(root, ['title', title]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(out.stdout, `Title set: ${title}\n`);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before.replace('project: voice-uptake\n', `project: voice-uptake\ntitle: ${JSON.stringify(title)}\n`));
  const parsed = canvas.parseCanvas(after);
  assert.deepEqual(parsed.problems, [], 'the frontmatter must still parse');
  assert.equal(parsed.frontmatter.title, title, 'the value reads back unchanged, with no quotes left on it');
  assert.equal(parsed.frontmatter.outlet, 'Organization Science', 'the fields around it are untouched');
  assert.equal(readLog(root), logBefore, 'setting a title writes no decision-log entry');
});

test('title replaces the title line in place, so a second call never adds a second one', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  assert.equal(run(root, ['title', 'First title']).status, 0);
  const one = fs.readFileSync(file, 'utf8');
  const second = 'Second: "title" #2';
  const out = run(root, ['title', second]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const two = fs.readFileSync(file, 'utf8');
  assert.equal(two, one.replace(`title: ${JSON.stringify('First title')}\n`, `title: ${JSON.stringify(second)}\n`));
  assert.equal((two.match(/^title:/gm) || []).length, 1, 'exactly one title line after the second call');
  assert.equal(canvas.parseCanvas(two).frontmatter.title, second);
});

test('title without text prints the title, or says there is none', () => {
  const root = makeProject();
  const none = run(root, ['title']);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.equal(none.stdout, 'No title set.\n');
  assert.equal(run(root, ['title', 'Voice uptake']).status, 0);
  assert.equal(run(root, ['title']).stdout, 'Voice uptake\n');
});

test('title joins the words it is given and refuses an empty one', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const before = fs.readFileSync(file, 'utf8');
  for (const args of [['title', ''], ['title', '   '], ['title', '\t\n']]) {
    const out = run(root, args);
    assert.equal(out.status, 1, `${JSON.stringify(args)} was not refused: ${out.stdout}`);
    assert.equal(out.stderr, '', 'the refusal is one line on stdout');
    assert.match(out.stdout, /cannot be empty/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused title writes nothing');
  const joined = run(root, ['title', 'Metacognition', 'in', 'meetings']);
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  assert.equal(run(root, ['title']).stdout, 'Metacognition in meetings\n');
});

test('title refuses outside a paper project, like status, and creates nothing', () => {
  const root = makeProject(false);
  for (const args of [['title'], ['title', 'A title']]) {
    const out = run(root, args);
    assert.equal(out.status, 1, `${args.join(' ')} was not refused: ${out.stdout}`);
    assert.equal(out.stderr, '');
    assert.match(out.stdout, /not a paper project/);
    assert.match(out.stdout, /no research\/canvas\.md/);
  }
  assert.equal(fs.existsSync(path.join(root, 'research')), false);
});

test('title refuses a canvas it cannot place the line in, rather than guessing', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const text = '---\nmode: seed\n---\n\n# 1 · Puzzle\n';
  fs.writeFileSync(file, text);
  const out = run(root, ['title', 'A title']);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /nowhere to set a title/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('init on an existing project only creates the missing key, and never replaces one', () => {
  const root = makeProject();
  const canvasBefore = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const first = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /already exists/);
  assert.match(first.stdout, /Sealing key created/);
  assert.equal(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'), canvasBefore);
  assert.equal(readLog(root), fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8'));
  const keyFile = path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), 'seal.key');
  const key = fs.readFileSync(keyFile, 'utf8');
  const second = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /already exists; nothing written/);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), key);
});

test('init in a clone whose log is already sealed creates no key, and review then says unverifiable rather than broken', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'decisions.md');
  // The log as a clone receives it: sealed with the key of the machine the
  // project started on, which this checkout does not have.
  const elsewhere = Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex');
  fs.writeFileSync(file, decisions.header('voice-uptake'));
  seal.sealedAppend(file, { date: '2026-09-30', kind: 'DISCOVERY', ref: '1 Puzzle', body: 'the gap is uptake, not voice [tentative]' }, elsewhere);
  const sealedLog = fs.readFileSync(file, 'utf8');

  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 1, out.stdout);
  assert.match(out.stdout, /sealed on another machine/);
  assert.match(out.stdout, /placet-research join --key-file/);
  const keyFile = path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), 'seal.key');
  assert.equal(fs.existsSync(keyFile), false, 'a fresh key here would make every seal fail to recompute');
  assert.equal(fs.readFileSync(file, 'utf8'), sealedLog, 'the log is not touched');

  const review = run(root, ['review']);
  assert.equal(review.status, 0, review.stdout);
  assert.match(review.stdout, /## Decision log\nunverifiable here: no sealing key on this machine \(expected at [^\n]+seal\.key\)/);
  assert.doesNotMatch(review.stdout, /BROKEN/);
});

test('status prints the same summary the session hook injects', () => {
  const root = makeProject();
  const out = run(root, ['status']);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /paper project "voice-uptake"/);
  assert.match(out.stdout, /Elements: 1 stated \(\+1 proposal\) · 2 open \(1 proposal\) · 3 stated/);
  assert.match(out.stdout, /Empty: 4, 6, 7, 8, 9/);
  const none = run(makeProject(false), ['status']);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /no research\/canvas\.md/);
});

test('review prints the mechanical report as markdown', () => {
  const root = makeProject();
  const out = run(root, ['review']);
  assert.equal(out.status, 0);
  // Same wording as the session summary: proposals are counted as proposals,
  // and an open element takes no plus sign (SQ-30, SQ-33).
  assert.match(out.stdout, /## Element status\n1 Puzzle: stated \(\+1 proposal\)\n2 [^\n]+: open \(1 proposal\)\n/);
  assert.match(out.stdout, /## Empty elements\n4, 6, 7, 8, 9/);
  assert.match(out.stdout, /## Open elements \(proposals only\)\n2/);
  assert.match(out.stdout, /## Untagged statements/);
  assert.match(out.stdout, /1\.2 \[stated\]/);
  assert.match(out.stdout, /## Stale acceptances\n#3/);
  assert.match(out.stdout, /## Unlogged acceptances\n[^\n]+\n1\.1/);
  assert.match(out.stdout, /## Decision log\nunverifiable: entries #1, #2, #3 predate the seal/);
  assert.match(out.stdout, /## Unverified decisions\n[^\n]+\n#3 1\.1 accepted — legacy/);
  assert.match(out.stdout, /## Committed but not visible\n[^\n]+\nnone/);
});

test('review names a committed statement that would not render, and says which view hides it', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const accepted = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]";
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(accepted));
  fs.writeFileSync(file, text.replace(accepted, `<!--\n\n${accepted}\n\n-->`));
  const out = run(root, ['review']);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /## Committed but not visible\n[^\n]+\n1\.1 \[accepted\] \(line \d+\): [^\n]+ — inside an HTML comment/);
});

test('review reports a verified, an unverifiable-here and a broken ledger, and names the cover an unlogged acceptance lacks', () => {
  const root = keyedProject();
  const one = run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']);
  assert.equal(one.status, 0, one.stdout);
  const verified = run(root, ['review']);
  assert.match(verified.stdout, /## Decision log\nverified: 1 sealed entry; entries #1, #2, #3 predate the seal/);
  assert.match(verified.stdout, /## Unlogged acceptances\n[^\n]+\n1\.1 \(line \d+\): [^\n]+\n\n## /, 'the sealed acceptance of 1.2 is covered; only 1.1 remains');

  const elsewhere = run(root, ['review'], { PLACET_RESEARCH_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-')) });
  assert.match(elsewhere.stdout, /## Decision log\nunverifiable here: no sealing key on this machine \(expected at [^\n]+seal\.key\)/);
  assert.match(elsewhere.stdout, /## Unlogged acceptances\n[^\n]+\n1\.1 [^\n]+\n1\.2 \(line \d+\): [^\n]+ — covered only by #4, unverifiable here/);

  fs.writeFileSync(path.join(root, 'research', 'decisions.md'), readLog(root).replace('the phenomenon, not a gap', 'the gap'));
  const broken = run(root, ['review']);
  assert.match(broken.stdout, /## Decision log\nBROKEN at #4 \(line \d+\): its own content or the unsealed block before it changed/);
  assert.match(broken.stdout, /1\.2 \(line \d+\): [^\n]+ — covered only by #4, broken/);
});

// The released key of a project on this machine, as a reviewer receives it.
function keyFileOf(root) {
  return path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), 'seal.key');
}

// A record received from the authors: the same canvas and log at another path,
// under a state directory of its own, so this machine holds no key for it.
function receivedCopy(root) {
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-received-'));
  fs.cpSync(path.join(root, 'research'), path.join(second, 'research'), { recursive: true });
  return second;
}

function anchorLine(stdout) {
  const found = stdout.match(/^## Anchor\nAnchor: (.*)$/m);
  assert.ok(found, `no anchor line in:\n${stdout}`);
  return found[1];
}

test('a record received from elsewhere verifies with --key <file>, and a wrong key reads as broken', () => {
  const author = keyedProject();
  const accepted = run(author, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']);
  assert.equal(accepted.status, 0, accepted.stdout);
  const reviewer = receivedCopy(author);

  // Without the key the reviewer sees the seals and cannot judge them …
  const blind = run(reviewer, ['review']);
  assert.match(blind.stdout, /## Decision log\nunverifiable here: no sealing key on this machine \(expected at [^\n]+seal\.key\)/);
  assert.match(run(reviewer, ['status']).stdout, /Ledger: unverifiable here \(no key on this machine\)/);
  // … and the released key is what makes the same record verifiable off the
  // authors' machine, for `review` and for `status`.
  const verified = run(reviewer, ['review', '--key', keyFileOf(author)]);
  assert.equal(verified.status, 0, verified.stdout);
  assert.match(verified.stdout, /## Decision log\nverified: 1 sealed entry; entries #1, #2, #3 predate the seal/);
  assert.doesNotMatch(verified.stdout, /BROKEN/);
  const summary = run(reviewer, ['status', '--key', keyFileOf(author)]);
  assert.equal(summary.status, 0, summary.stdout);
  assert.match(summary.stdout, /Ledger: verified/);

  // A 32-byte key that is not this project's reads as broken, not as a match.
  const wrong = path.join(reviewer, 'another-projects.key');
  fs.writeFileSync(wrong, 'ff'.repeat(32));
  const broken = run(reviewer, ['review', '--key', wrong]);
  assert.equal(broken.status, 0, broken.stdout);
  assert.match(broken.stdout, /## Decision log\nBROKEN at #4 \(line \d+\): its own content or the unsealed block before it changed/);
  assert.match(run(reviewer, ['status', '--key', wrong]).stdout, /Ledger: BROKEN at #4 \(anchor\)/);
});

test('--key refuses a file it cannot read, one that is not 32 bytes, and a missing path', () => {
  const root = keyedProject();
  const missing = run(root, ['review', '--key', path.join(root, 'nowhere', 'seal.key')]);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout.trimEnd().split('\n').length, 1, 'one line, and no report is printed');
  assert.match(missing.stdout, /cannot be read \(ENOENT\); nothing was verified against it\./);

  const short = path.join(root, 'short.key');
  fs.writeFileSync(short, 'ab'.repeat(16));
  const wrongSize = run(root, ['review', '--key', short]);
  assert.equal(wrongSize.status, 1);
  assert.equal(wrongSize.stdout.trimEnd().split('\n').length, 1);
  assert.match(wrongSize.stdout, /is not a 32-byte key \(64 hex characters/);

  const notHex = path.join(root, 'not-hex.key');
  fs.writeFileSync(notHex, 'z'.repeat(64));
  const garbled = run(root, ['status', '--key', notHex]);
  assert.equal(garbled.status, 1);
  assert.match(garbled.stdout, /is not a 32-byte key/);

});

test('the anchor line is stable for an unchanged record and moves when a byte moves', () => {
  const root = keyedProject();
  assert.equal(run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']).status, 0);
  const parts = (line) => line.match(/^last seal ([0-9a-f]{16}), maxSeq (\d+), decisions\.md sha256 ([0-9a-f]{64})$/);
  const before = parts(anchorLine(run(root, ['review']).stdout));
  assert.ok(before, 'the anchor names the last seal, maxSeq and the file hash');
  assert.equal(before[2], '4');
  assert.equal(anchorLine(run(root, ['review']).stdout), anchorLine(run(root, ['review']).stdout), 'two runs over one unchanged file print one anchor');

  fs.writeFileSync(path.join(root, 'research', 'decisions.md'), readLog(root).replace('the phenomenon, not a gap', 'the gap'));
  const after = parts(anchorLine(run(root, ['review']).stdout));
  assert.equal(after[2], before[2], 'the entry count is the same');
  assert.equal(after[1], before[1], 'the stored seal is untouched by a body edit — the whole-file hash is what carries it');
  assert.notEqual(after[3], before[3], 'one changed byte moves the anchor');
});

test('accept promotes the single candidate, keeps tags, logs a sealed DECISION with the text hash', () => {
  const root = keyedProject();
  // 3.1 depends on 1 (is-qualitative). Element 1 is stated, not accepted → refused first.
  const refused = run(root, ['accept', '3.1', '--explained', EXPLAINED]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /element 1 is stated/);
  // Accept the remaining committed statement in 1.2 so element 1 becomes accepted.
  const one = run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency', '--why', 'the gap is uptake, not voice']);
  assert.equal(one.status, 0, one.stdout);
  let text = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  assert.match(text, /whether a proposal is taken up is not\. \[accepted\]/);
  assert.match(text, /chairing style rather than of the proposal\. \[proposed\]/, 'the proposal stays a proposal');
  let log = decisions.parseDecisions(fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8'));
  assert.equal(log.maxSeq, 4);
  assert.equal(log.entries[3].ref, '1.2 accepted');
  assert.equal(log.entries[3].hash, textHash('Speaking frequency is well documented; whether a proposal is taken up is not.'));
  assert.match(log.entries[3].seal, /^[0-9a-f]{16}$/);
  assert.match(one.stdout, /sealed/);
  // Now 3.1 is acceptable; its src: tag survives.
  const three = run(root, ['accept', '3.1', '--explained', EXPLAINED]);
  assert.equal(three.status, 0, three.stdout);
  text = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  assert.match(text, /get taken up\? \[accepted, src: memo-03\]/);
  log = decisions.parseDecisions(fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8'));
  assert.equal(log.maxSeq, 5);
  const key = Buffer.from(fs.readFileSync(path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), 'seal.key'), 'utf8'), 'hex');
  assert.equal(seal.verifyChain(readLog(root), key).status, 'verified');
});

test('accept refuses without a key and on a broken ledger, and leaves the canvas untouched', () => {
  const noKey = makeProject();
  const canvasBefore = fs.readFileSync(path.join(noKey.toString(), 'research', 'canvas.md'), 'utf8');
  const refused = run(noKey, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /no sealing key/i);
  assert.match(refused.stdout, /placet-research init/);
  assert.equal(fs.readFileSync(path.join(noKey, 'research', 'canvas.md'), 'utf8'), canvasBefore, 'nothing is accepted without a log entry');

  const root = keyedProject();
  assert.equal(run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']).status, 0);
  fs.appendFileSync(path.join(root, 'research', 'decisions.md'), '\n## [#5] 2026-09-18 · DECISION · 3.1 accepted · text deadbeef\nforged [accepted]\n');
  const before = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const onBroken = run(root, ['accept', '3.1', '--explained', EXPLAINED]);
  assert.equal(onBroken.status, 1);
  assert.match(onBroken.stdout, /broken at #5/);
  assert.equal(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'), before);
});

test('log appends a sealed DISCOVERY or CONSTRAINT and refuses a DECISION, a missing key, and a broken ledger', () => {
  const root = keyedProject();
  const out = run(root, ['log', 'DISCOVERY', '2 Audience and Prior Research', '--body', 'Two studies contradict each other on uptake. [tentative, src: ref-11]', '--supersedes', '2']);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /Logged #4 DISCOVERY 2 Audience and Prior Research/);
  const log = decisions.parseDecisions(readLog(root));
  assert.equal(log.entries[3].kind, 'DISCOVERY');
  assert.match(log.entries[3].seal, /^[0-9a-f]{16}$/);
  assert.equal(log.entries[3].body, 'Two studies contradict each other on uptake. [tentative, src: ref-11]\n**By:** A. Researcher\n**Supersedes:** #2');
  const constraint = run(root, ['log', 'CONSTRAINT', '5 Research Setting', '--body', 'No further fieldwork. [stated]', '--why', 'the committee said so']);
  assert.equal(constraint.status, 0, constraint.stdout);
  assert.equal(decisions.parseDecisions(readLog(root)).maxSeq, 5);

  const decision = run(root, ['log', 'DECISION', '1.2 accepted', '--body', 'x [accepted]']);
  assert.equal(decision.status, 2);
  assert.match(decision.stdout, /researcher's act/);
  const badKind = run(root, ['log', 'VERDICT', '1 Puzzle', '--body', 'x']);
  assert.equal(badKind.status, 2);
  const noBody = run(root, ['log', 'DISCOVERY', '1 Puzzle']);
  assert.equal(noBody.status, 2);
  assert.equal(decisions.parseDecisions(readLog(root)).maxSeq, 5, 'refusals append nothing');

  const noKey = makeProject();
  const unkeyed = run(noKey, ['log', 'DISCOVERY', '1 Puzzle', '--body', 'x [tentative]']);
  assert.equal(unkeyed.status, 1);
  assert.match(unkeyed.stdout, /no sealing key/i);

  fs.appendFileSync(path.join(root, 'research', 'decisions.md'), '\n## [#6] 2026-09-18 · DISCOVERY · 1 Puzzle\nunsealed [tentative]\n');
  const onBroken = run(root, ['log', 'DISCOVERY', '1 Puzzle', '--body', 'y [tentative]']);
  assert.equal(onBroken.status, 1);
  assert.match(onBroken.stdout, /broken at #6/);
  assert.equal(decisions.parseDecisions(readLog(root)).maxSeq, 6);
});

test('log and accept refuse an entry heading in any free-text field, not only --body', () => {
  const root = keyedProject();
  const forged = '## [#99] 2026-09-22 · DECISION · 1.2 accepted · text deadbeef';
  const before = readLog(root);

  // --body was already checked; --why was the field that let one allowed log
  // break the ledger and stop the researcher's own accept (SQ-29 F10). The
  // check is one helper, so accept's free-text fields are covered too.
  for (const args of [
    ['log', 'DISCOVERY', '1.2', '--body', `a finding\n${forged}`],
    ['log', 'DISCOVERY', '1.2', '--body', 'a finding', '--why', `because\n${forged}`],
    ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency', '--why', `because\n${forged}`],
    ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency', '--rejected', `because\n${forged}`],
  ]) {
    const out = run(root, args);
    assert.equal(out.status, 2, `${args.join(' ')} was not refused: ${out.stdout}`);
    assert.match(out.stdout, /starts like an entry heading/);
  }
  assert.equal(readLog(root), before, 'a refused heading writes nothing');
  assert.equal(decisions.parseDecisions(readLog(root)).entries.some((e) => e.seq === 99), false, 'no forged entry reached the ledger');
  // The ledger is still whole, so the researcher's own accept still lands.
  const accepted = run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']);
  assert.equal(accepted.status, 0, accepted.stdout);
});

test('log and accept refuse a field label in any free-text field', () => {
  const root = keyedProject();
  const before = readLog(root);
  const canvasBefore = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');

  // A label is read back as that field from anywhere below an entry's own
  // text, so a body or a --why could claim an explanation, a supersede or an
  // open-check line that no approval path wrote (SQ-133). One helper covers
  // every write path, accept's free-text fields included.
  for (const args of [
    ['log', 'DISCOVERY', '1.2', '--body', 'a finding\n**Explained:** I understand this'],
    ['log', 'DISCOVERY', '1.2', '--body', 'a finding', '--why', 'because\n**Supersedes:** #2'],
    ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency', '--why', 'because\n**Open at acceptance:** #1'],
    ['accept', '1.2', '--explained', 'I accept this\n**Explained:** twice over', '--match', 'Speaking frequency'],
    ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency', '--rejected', '**Rejected:** nothing'],
  ]) {
    const out = run(root, args);
    assert.equal(out.status, 2, `${args.join(' ')} was not refused: ${out.stdout}`);
    assert.match(out.stdout, /starts like a field label/);
    assert.match(out.stdout, /\*\*(Explained|Supersedes|Open at acceptance|Rejected):\*\*/, 'the refusal names the label');
  }
  assert.equal(readLog(root), before, 'a refused label writes nothing');
  assert.equal(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'), canvasBefore, 'a refused label accepts nothing');

  // An ordinary question body is text, not a label (SQ-128 writes these).
  const check = run(root, ['log', 'DISCOVERY', '1.2 check', '--body', 'Which meetings show the uptake in #4?']);
  assert.equal(check.status, 0, check.stdout);
  // The ledger is still whole, so the researcher's own accept still lands.
  const accepted = run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', 'Speaking frequency']);
  assert.equal(accepted.status, 0, accepted.stdout);
});

test('a statement text that reads as a field label stays the entry text and forges nothing', () => {
  const root = keyedProject();
  const canvasPath = path.join(root, 'research', 'canvas.md');
  // The researcher's own text, accepted as it stands: refusing it would be
  // refusing their words, so the parser stops reading the first line as a
  // field instead (SQ-133).
  fs.writeFileSync(canvasPath, fs.readFileSync(canvasPath, 'utf8').replace(
    'Speaking frequency is well documented; whether a proposal is taken up is not.',
    '**Supersedes:** #1',
  ));
  const out = run(root, ['accept', '1.2', '--explained', EXPLAINED, '--match', '**Supersedes:**']);
  assert.equal(out.status, 0, out.stdout);
  const last = decisions.parseDecisions(readLog(root)).entries.at(-1);
  assert.equal(last.ref, '1.2 accepted');
  assert.equal(last.body, `**Supersedes:** #1 [accepted]\n**By:** A. Researcher\n**Explained:** ${EXPLAINED}`, 'body stays the whole text under the heading');
  assert.equal(last.hash, textHash('**Supersedes:** #1'), 'the acceptance binds the text it accepted');
  assert.equal(last.supersedes, null, 'the statement text is not read back as a field');
  assert.equal(last.explained, EXPLAINED, 'the explanation the approval path wrote still parses');

  // A label the approval path never wrote is not forged by the text either:
  // the parser used to read this text back as `rejected: "nothing [accepted]"`.
  const other = keyedProject();
  const otherCanvas = path.join(other, 'research', 'canvas.md');
  fs.writeFileSync(otherCanvas, fs.readFileSync(otherCanvas, 'utf8').replace(
    'Speaking frequency is well documented; whether a proposal is taken up is not.',
    '**Rejected:** nothing',
  ));
  const forged = run(other, ['accept', '1.2', '--explained', EXPLAINED, '--match', '**Rejected:**']);
  assert.equal(forged.status, 0, forged.stdout);
  const forgedEntry = decisions.parseDecisions(readLog(other)).entries.at(-1);
  assert.equal(forgedEntry.rejected, null, 'the statement text forges no field the approval path did not write');
  assert.equal(forgedEntry.explained, EXPLAINED);
});

test('accept refuses ambiguity, unknown questions, and already-accepted statements', () => {
  const root = makeProject();
  const ambiguous = run(root, ['accept', '1.2', '--explained', EXPLAINED]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stdout, /--match/);
  const unknown = run(root, ['accept', '7.9', '--explained', EXPLAINED]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stdout, /no question 7\.9/);
  const done = run(root, ['accept', '1.1', '--explained', EXPLAINED]);
  assert.equal(done.status, 1);
  assert.match(done.stdout, /nothing to accept/);
});

test('accept without an explanation is refused and writes nothing; with one, the explanation is logged', () => {
  const root = keyedProject();
  const canvasBefore = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  const logBefore = readLog(root);
  // A bare --explained is the malformed call below, not a missing explanation.
  for (const extra of [[], ['--explained', '   '], ['--explained', '']]) {
    const out = run(root, ['accept', '1.2', '--match', 'Speaking frequency', ...extra]);
    assert.equal(out.status, 1, `${extra.join(' ')} was not refused: ${out.stdout}`);
    assert.match(out.stdout, /needs your explanation/);
    assert.match(out.stdout, /--explained <text>/);
  }
  assert.equal(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'), canvasBefore, 'nothing is accepted without an explanation');
  assert.equal(readLog(root), logBefore, 'nothing is logged without an explanation');
  const out = run(root, ['accept', '1.2', '--match', 'Speaking frequency', '--explained', EXPLAINED]);
  assert.equal(out.status, 0, out.stdout);
  const last = decisions.parseDecisions(readLog(root)).entries.at(-1);
  assert.equal(last.explained, EXPLAINED);
  assert.deepEqual(last.openAtAccept, []);
  assert.doesNotMatch(out.stdout, /open check questions/);
});

test('nothing is written to stderr, so a skill can embed the output through a `!` line', () => {
  const root = makeProject();
  for (const args of [['status'], ['review'], ['accept', '1.2'], ['accept'], ['log'], ['log', 'DISCOVERY', '1 Puzzle', '--body', 'x'], []]) {
    const out = run(root, args);
    assert.equal(out.stderr, '', `${args.join(' ') || '<no command>'} wrote to stderr`);
    assert.ok(out.stdout.length > 0, `${args.join(' ') || '<no command>'} printed nothing`);
  }
});

// readIfExists tells "absent" from "unreadable" (SQ-23); the CLI has to say
// which one it hit. A root user reads a mode-000 file anyway, so the check
// cannot run there.
test('a canvas that exists but cannot be read is reported on one line with the file and the code, not as a stack trace', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
  const root = makeProject();
  // The CLI names the file as the process sees it, under the real cwd, which
  // on macOS is /private/var rather than the /var the tmpdir was handed out as.
  const canvasFile = path.join(fs.realpathSync(root), 'research', 'canvas.md');
  fs.chmodSync(canvasFile, 0o000);
  try {
    for (const args of [['status'], ['review']]) {
      const out = run(root, args);
      assert.equal(out.status, 1, `${args[0]} exit code`);
      assert.equal(out.stderr, '', `${args[0]} wrote to stderr`);
      assert.equal(out.stdout, `Cannot read ${canvasFile} (EACCES). Restore access to the file and run the command again.\n`);
      assert.doesNotMatch(out.stdout, /not a paper project/);
    }
  } finally {
    fs.chmodSync(canvasFile, 0o644);
  }
});

// doctor reads the same three settings files Claude Code does, but has no
// way to see what a running Claude Code process actually loaded — these
// tests point CLAUDE_CONFIG_DIR at a fixture instead of the real ~/.claude.
function fakeConfigDir(enabledPlugins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-config-'));
  if (enabledPlugins !== undefined) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ enabledPlugins }));
  }
  return dir;
}

// SQ-116. doctor also looks for the shim install-cli writes, so a test must own
// the home and the PATH it reads: a shim that happens to be installed on this
// machine would otherwise decide the verdict. These are temp directories, never
// the real ~/.local/bin.
function fakeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-home-'));
}

function installShim(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'placet-research');
  fs.writeFileSync(file, '#!/bin/sh\n# placet-research install-cli shim; a test fixture\n', { mode: 0o755 });
  return file;
}

const NO_PATH = { PATH: '/usr/bin:/bin' };

test('doctor reports ok when the plugin is enabled and the terminal command is installed', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  const home = fakeHome();
  const dir = path.join(home, '.local', 'bin');
  installShim(dir);
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: home, PATH: `/usr/bin:/bin:${dir}` });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: ok \(4 checks\)$/m);
});

test('doctor reports a shim in ~/.local/bin that the terminal cannot find, with the PATH line install-cli prints', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  const home = fakeHome();
  const dir = path.join(home, '.local', 'bin');
  const file = installShim(dir);
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: home, ...NO_PATH });
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: 1 of 4 checks failed$/m);
  assert.ok(out.stdout.includes(`- terminal command: shim at ${file}, but ${dir} is not on PATH; add this line to ~/.zshrc: export PATH="${dir}:$PATH"`), out.stdout);
});

test('doctor reports the plugin as not enabled when no settings file names it', () => {
  const root = makeProject(false);
  const configDir = fakeConfigDir();
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: fakeHome(), ...NO_PATH });
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /plugin enabled: no enabledPlugins entry for placet-research@/);
});

// SQ-337. Since 0.7.0 the plugin is called placet-research; an upgrade that
// leaves research-harness enabled runs two guards. The old-plugin check reports
// only a failure, so the counts of the tests above stay as they are.
const OLD_PLUGIN_KEY = 'research-harness@research-harness';

function projectSettings(root, name, enabledPlugins) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', name), JSON.stringify({ enabledPlugins }));
}

function doctorWithShim(root, configDir) {
  const home = fakeHome();
  const dir = path.join(home, '.local', 'bin');
  installShim(dir);
  return run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: home, PATH: `/usr/bin:/bin:${dir}` });
}

test('doctor fails when the old research-harness plugin is still enabled beside placet-research', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true, [OLD_PLUGIN_KEY]: true });
  const out = doctorWithShim(root, configDir);
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: 1 of 5 checks failed$/m);
  const file = path.join(configDir, 'settings.json');
  assert.ok(out.stdout.includes(`- old plugin: ${OLD_PLUGIN_KEY} is still enabled by user settings (${file}); two guards run. Remove it with: claude plugin uninstall ${OLD_PLUGIN_KEY}`), out.stdout);
});

test('doctor does not report the old research-harness plugin when it is disabled', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true, [OLD_PLUGIN_KEY]: false });
  const out = doctorWithShim(root, configDir);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: ok \(4 checks\)$/m);
  assert.doesNotMatch(out.stdout, /old plugin/);
});

test('doctor follows settings precedence for the old plugin: a later file that disables it wins', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true, [OLD_PLUGIN_KEY]: true });
  projectSettings(root, 'settings.json', { [OLD_PLUGIN_KEY]: false });
  const out = doctorWithShim(root, configDir);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: ok \(4 checks\)$/m);
  assert.doesNotMatch(out.stdout, /old plugin/);
});

// A settings file that is not what Claude Code writes. checkPluginEnabled
// reports a file it cannot read or parse; the old-plugin check must not repeat
// it, and a file that parses to something odd simply names no plugins.
function writeProjectSettingsRaw(root, text) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), text);
}

test('doctor reports a project settings file that does not parse once, and not as an old plugin', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  writeProjectSettingsRaw(root, '{ not json');
  const out = doctorWithShim(root, configDir);
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: 1 of 4 checks failed$/m);
  const file = path.join(root, '.claude', 'settings.json');
  assert.equal(out.stdout.split(`${file} does not parse as JSON`).length - 1, 1, out.stdout);
  assert.match(out.stdout, /^- plugin enabled: .*does not parse as JSON/m);
  assert.doesNotMatch(out.stdout, /old plugin/);
});

test('doctor reports a project settings file it cannot read once, with the error code, and not as an old plugin', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  // A directory where the file belongs: reading it fails with EISDIR.
  fs.mkdirSync(path.join(root, '.claude', 'settings.json'), { recursive: true });
  const out = doctorWithShim(root, configDir);
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: 1 of 4 checks failed$/m);
  const file = path.join(root, '.claude', 'settings.json');
  assert.equal(out.stdout.split(`${file} cannot be read (EISDIR)`).length - 1, 1, out.stdout);
  assert.doesNotMatch(out.stdout, /old plugin/);
});

for (const [name, text] of [
  ['null', 'null'],
  ['a number', '42'],
  ['an object without enabledPlugins', '{}'],
  ['an object whose enabledPlugins is a string', JSON.stringify({ enabledPlugins: 'research-harness@research-harness' })],
]) {
  test(`doctor ignores a project settings file that is ${name}`, () => {
    const root = makeProject(false);
    setName(root);
    const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
    writeProjectSettingsRaw(root, text);
    const out = doctorWithShim(root, configDir);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^placet-research doctor: ok \(4 checks\)$/m);
    assert.doesNotMatch(out.stdout, /old plugin/);
  });
}

test("doctor's guard-denies check passes on its own throwaway project, independent of the plugin-enabled check", () => {
  const root = makeProject(false);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': false });
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: fakeHome(), ...NO_PATH });
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /plugin enabled: .*is disabled/);
  assert.doesNotMatch(out.stdout, /guard denies/);
});

test('doctor asks for the terminal command when nothing has installed it', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: fakeHome(), ...NO_PATH });
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: 1 of 4 checks failed$/m);
  assert.match(out.stdout, /^- terminal command: not installed; run placet-research install-cli so serve works in your own terminal$/m);

  // The marker is what counts: another program of that name is not this CLI.
  const foreignHome = fakeHome();
  fs.mkdirSync(path.join(foreignHome, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(foreignHome, '.local', 'bin', 'placet-research'), '#!/bin/sh\necho some other tool\n');
  const foreign = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: foreignHome, ...NO_PATH });
  assert.notEqual(foreign.status, 0, foreign.stdout + foreign.stderr);
  assert.match(foreign.stdout, /^- terminal command: not installed; run placet-research install-cli so serve works in your own terminal$/m);
});

test('doctor does not count a shim the terminal cannot execute', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  const home = fakeHome();
  const file = installShim(path.join(home, '.local', 'bin'));
  fs.chmodSync(file, 0o644);
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: home, ...NO_PATH });
  assert.notEqual(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: 1 of 4 checks failed$/m);
  assert.ok(out.stdout.includes(`- terminal command: shim at ${file} is not executable; run placet-research install-cli again`), out.stdout);
});

test('doctor finds the terminal command on PATH, not only at ~/.local/bin', () => {
  const root = makeProject(false);
  setName(root);
  const configDir = fakeConfigDir({ 'placet-research@placet-research': true });
  const installed = path.join(fakeHome(), 'bin');
  installShim(installed);
  const out = run(root, ['doctor'], { CLAUDE_CONFIG_DIR: configDir, HOME: fakeHome(), PATH: `/usr/bin:/bin:${installed}` });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /^placet-research doctor: ok \(4 checks\)$/m);
});

test('the README runs the CLI as the installed command, since the reader is in a paper checkout without bin/', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /node bin\/placet-research\.js/);
  assert.match(readme, /^ {4}placet-research review --key <key file>$/m);
});

// SQ-167: `--flag` with no value parsed as `true`, and the command read that as
// "not given" — accepting a question's single candidate without the filter,
// taking the default profile, dropping a title. It is now a malformed call.
test('a flag that takes a value is refused when it is given none, and nothing is touched', () => {
  const root = keyedProject();
  const canvasFile = path.join(root, 'research', 'canvas.md');
  const canvasBefore = fs.readFileSync(canvasFile, 'utf8');
  const logBefore = readLog(root);
  const bare = [
    ['accept', '1.2', '--explained', EXPLAINED, '--match'],
    ['accept', '1.2', '--match', 'Speaking frequency', '--explained'],
    ['accept', '1.2', '--match', 'Speaking frequency', '--explained', EXPLAINED, '--why'],
    ['accept', '1.2', '--match', 'Speaking frequency', '--explained', EXPLAINED, '--rejected'],
    ['log', 'DISCOVERY', '2 Audience and Prior Research', '--body', 'x [tentative]', '--why'],
    ['log', 'DISCOVERY', '2 Audience and Prior Research', '--body'],
    ['status', '--variant'],
    ['status', '--key'],
    ['init', '--project', 'voice-uptake', '--mode', 'seed', '--profile'],
    ['init', '--project', 'voice-uptake', '--mode', 'seed', '--title'],
    ['init', '--project', 'voice-uptake', '--mode', 'seed', '--outlet'],
    ['init', '--variant', 'v', '--lens'],
  ];
  for (const args of bare) {
    const flag = args.at(-1);
    const out = run(root, args);
    assert.equal(out.status, 2, `${args.join(' ')}: ${out.stdout}`);
    assert.match(out.stdout, new RegExp(`${flag} needs a value`), args.join(' '));
    assert.equal(out.stderr, '', args.join(' '));
  }
  assert.equal(fs.readFileSync(canvasFile, 'utf8'), canvasBefore, 'the canvas is byte-identical');
  assert.equal(readLog(root), logBefore, 'the log is byte-identical');
});

test('init refuses a bare value flag before it writes the canvas, the log or a key', () => {
  const root = makeProject(false);
  for (const flag of ['--profile', '--title', '--outlet']) {
    const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed', flag]);
    assert.equal(out.status, 2, `${flag}: ${out.stdout}`);
    assert.match(out.stdout, /needs a value/);
  }
  assert.equal(fs.existsSync(path.join(root, 'research')), false, 'no canvas and no log are written');
  assert.deepEqual(fs.readdirSync(stateDirOf(root)), [], 'no sealing key is written');
  // The same call with a value does write both, so the two checks above are not vacuous.
  const ok = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed', '--title', 'Voice uptake']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(fs.existsSync(path.join(root, 'research', 'canvas.md')));
  assert.notDeepEqual(fs.readdirSync(stateDirOf(root)), []);
});

// SQ-294 (F5): the name becomes the log's title line and the canvas slug, so a
// line break in it splits the header — and one carrying `Seal key: …` made the
// write crash. It is refused before anything is written.
test('init refuses --project with a line break or a carriage return, and writes nothing', () => {
  for (const name of ['voice\nuptake', 'voice\ruptake', 'voice\nSeal key: 0000000000000000']) {
    const root = makeProject(false);
    const out = run(root, ['init', '--project', name, '--mode', 'seed']);
    assert.equal(out.status, 2, `${JSON.stringify(name)}: ${out.stdout}${out.stderr}`);
    assert.match(out.stdout, /^--project must be one line: a name with a line break or a carriage return is not allowed\.$/m);
    assert.equal(fs.existsSync(path.join(root, 'research')), false, 'no canvas and no log are written');
    assert.deepEqual(fs.readdirSync(stateDirOf(root)), [], 'no sealing key is written');
  }
  // The same call with a one-line name writes all three, so the refusals above
  // are not vacuous.
  const root = makeProject(false);
  const ok = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(fs.existsSync(path.join(root, 'research', 'canvas.md')));
  assert.notDeepEqual(fs.readdirSync(stateDirOf(root)), []);
});

test('log --supersedes refuses a bare flag, zero, a negative and an entry the log does not have, and writes nothing', () => {
  const root = keyedProject();
  const before = readLog(root);
  const maxSeq = decisions.parseDecisions(before).maxSeq;
  for (const value of [[], ['0'], ['-1'], ['1.5'], [String(maxSeq + 1)]]) {
    const out = run(root, ['log', 'DISCOVERY', '2 Audience and Prior Research', '--body', 'x [tentative]', '--supersedes'].concat(value));
    assert.notEqual(out.status, 0, `--supersedes ${value.join(' ') || '(bare)'} was accepted: ${out.stdout}`);
    assert.match(out.stdout + out.stderr, /--supersedes/);
    assert.equal(readLog(root), before);
  }
  const ok = run(root, ['log', 'DISCOVERY', '2 Audience and Prior Research', '--body', 'x [tentative]', '--supersedes', String(maxSeq)]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(readLog(root), new RegExp(`\\*\\*Supersedes:\\*\\* #${maxSeq}`));
});

test('every accept the README shows carries --explained, which accept requires', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const accepts = readme.match(/\/placet-research:accept \d+\.\d+[^`\n]*/g) || [];
  assert.ok(accepts.length > 0, 'the README shows an accept');
  for (const a of accepts) assert.match(a, /--explained "/, a);
});

test('review prints "Findings before hypotheses" only under a profile with that check', () => {
  const root = keyedProject();
  const canvasFile = path.join(root, 'research', 'canvas.md');
  assert.doesNotMatch(run(root, ['review']).stdout, /Findings before hypotheses/);
  fs.writeFileSync(canvasFile, fs.readFileSync(canvasFile, 'utf8').replace(/^profile: .*$/m, 'profile: is-quantitative'));
  const out = run(root, ['review']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /## Findings before hypotheses\n\(reported, never enforced/);
});

// SQ-175: switching a profile is a write to the researcher's canvas, so the
// log entry comes first and a refusal leaves both files as they were. Refusals
// go to stdout (see `say`), so the refusal tests read both streams.
test('profile prints the active profile and switches to another, with a sealed log entry', () => {
  const root = keyedProject();
  assert.equal(run(root, ['profile']).stdout.trim(), 'is-qualitative');
  const out = run(root, ['profile', 'is-quantitative']);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /Profile set: is-quantitative \(was is-qualitative\), logged as #\d+/);
  assert.match(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'), /^profile: is-quantitative$/m);
  assert.match(readLog(root), /· CONSTRAINT · profile · seal [0-9a-f]{16}\nProfile changed from is-qualitative to is-quantitative\./);
  assert.match(run(root, ['review']).stdout, /## Decision log\n.*verified/);
});

test('profile refuses an unknown id, the active id, and a missing key, writing nothing', () => {
  const root = keyedProject();
  const canvasFile = path.join(root, 'research', 'canvas.md');
  const before = fs.readFileSync(canvasFile, 'utf8');
  const logBefore = readLog(root);
  const unknown = run(root, ['profile', 'no-such-profile']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout + unknown.stderr, /profile not found: no-such-profile/);
  const same = run(root, ['profile', 'is-qualitative']);
  assert.notEqual(same.status, 0);
  assert.match(same.stdout + same.stderr, /already uses is-qualitative/);
  const nokey = run(root, ['profile', 'is-quantitative'], { PLACET_RESEARCH_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-')) });
  assert.notEqual(nokey.status, 0);
  assert.equal(fs.readFileSync(canvasFile, 'utf8'), before);
  assert.equal(readLog(root), logBefore);
});

test('name sets and prints the name; log writes it as By; no name at all refuses the write', () => {
  const root = makeProject();
  assert.equal(run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']).status, 0);
  const set = run(root, ['name', 'A. Researcher']);
  assert.equal(set.status, 0, set.stdout);
  assert.match(run(root, ['name']).stdout, /^A\. Researcher$/m);
  assert.equal(run(root, ['log', 'DISCOVERY', '7', '--body', 'A finding.']).status, 0);
  assert.match(readLog(root), /A finding\.\n\*\*By:\*\* A\. Researcher\n/);
  assert.equal(run(root, ['name', 'bad # name']).status, 2);

  fs.rmSync(path.join(stateDirOf(root), 'name'));
  const nobody = run(root, ['log', 'DISCOVERY', '7', '--body', 'Another.'], { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.equal(nobody.status, 1);
  assert.match(nobody.stdout, /placet-research name "<your name>"/);
  assert.doesNotMatch(readLog(root), /Another\./);

  // The same missing name is what doctor reports, so the check names the one
  // command that fixes it.
  const doctor = run(root, ['doctor'], { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  assert.match(doctor.stdout, /^- name: no name is set for the decision log on this machine; run placet-research name "<your name>" once$/m);
});

test('session start appends a sealed SESSION marker with By; log refuses SESSION and MERGE', () => {
  const root = makeProject();
  assert.equal(run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']).status, 0);
  assert.equal(run(root, ['name', 'A. Researcher']).status, 0);
  const out = run(root, ['session', 'start', 'Supervision with B. Supervisor']);
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /Session #\d+ started/);
  assert.match(readLog(root), /· SESSION · Supervision with B\. Supervisor · seal [0-9a-f]{16}\nSession started\.\n\*\*By:\*\* A\. Researcher\n/);
  assert.equal(run(root, ['log', 'SESSION', 'x', '--body', 'y']).status, 2);
  assert.equal(run(root, ['log', 'MERGE', 'x', '--body', 'y']).status, 2);
  assert.equal(run(root, ['session', 'start', 'a · b']).status, 2);
  assert.equal(run(root, ['session', 'start']).status, 2);
  assert.equal(run(root, ['session']).status, 2);
});

test('doctor notes two session markers in a row without failing on it', () => {
  const root = makeProject();
  run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  run(root, ['name', 'A. Researcher']);
  run(root, ['session', 'start', 'One']);
  run(root, ['session', 'start', 'Two']);
  assert.match(run(root, ['doctor']).stdout, /note: .*#\d+ and #\d+ are two session markers in a row/);
});

test('agenda prints the To talk about tab as Markdown, and --out writes exactly that file', () => {
  const root = keyedProject();
  const decisionsText = fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8');
  const parsed = canvas.parseCanvas(fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8'));
  // The same inputs the command builds, so the bytes are compared, not a shape.
  const expected = agendaMarkdown(agendaOf(parsed, decisionsText), {
    title: parsed.frontmatter.title || parsed.frontmatter.project || 'Untitled',
    date: new Date().toISOString().slice(0, 10),
    seal: ledgerSummary(seal.verifyChain(decisionsText, seal.readKey(root))),
  });

  const printed = run(root, ['agenda']);
  assert.equal(printed.status, 0, printed.stdout + printed.stderr);
  assert.equal(printed.stderr, '');
  assert.equal(printed.stdout, expected);

  const file = path.join(root, 'agenda.md');
  const written = run(root, ['agenda', '--out', file]);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.equal(written.stdout, `Written to ${file}.\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), expected);

  const bare = run(root, ['agenda', '--out']);
  assert.equal(bare.status, 2, bare.stdout);
  assert.match(bare.stdout, /--out needs a value/);
});

test('session protocol prints the latest session, takes 12 and #12, and --out writes exactly that file', () => {
  const root = keyedProject();
  // No marker yet: the command refuses and points at session start.
  const none = run(root, ['session', 'protocol']);
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.match(none.stdout, /session start/);

  assert.equal(run(root, ['session', 'start', 'First supervision']).status, 0);
  assert.equal(run(root, ['log', 'DISCOVERY', '5', '--body', 'First finding.']).status, 0);
  assert.equal(run(root, ['session', 'start', 'Second supervision']).status, 0);
  assert.equal(run(root, ['log', 'DISCOVERY', '7.1 check', '--body', 'Is the sample large enough?', '--why', 'Power.']).status, 0);

  const decisionsText = readLog(root);
  const canvasText = fs.readFileSync(path.join(root, 'research', 'canvas.md'), 'utf8');
  // The key the spawned CLI reads, from the state dir `run` hands it.
  const keyFile = path.join(stateDirOf(root), path.basename(path.dirname(seal.keyPath(root))), 'seal.key');
  const key = seal.readKeyFile(keyFile);
  // The same inputs the command builds, so the bytes are compared, not a shape.
  const expected = protocolOf({ decisionsText, canvasText, key }).markdown;
  assert.match(expected, /^# Session protocol — Second supervision$/m);
  assert.match(expected, /## Open at the end[\s\S]*7\.1 check/);

  const printed = run(root, ['session', 'protocol']);
  assert.equal(printed.status, 0, printed.stdout + printed.stderr);
  assert.equal(printed.stderr, '');
  assert.equal(printed.stdout, expected);

  const firstSeq = decisions.parseDecisions(decisionsText).entries.filter((e) => e.kind === 'SESSION')[0].seq;
  const first = protocolOf({ decisionsText, canvasText, key, seq: firstSeq }).markdown;
  for (const arg of [String(firstSeq), `#${firstSeq}`]) {
    const picked = run(root, ['session', 'protocol', arg]);
    assert.equal(picked.status, 0, `${arg}: ${picked.stdout}${picked.stderr}`);
    assert.equal(picked.stdout, first);
  }

  const file = path.join(root, 'protocol.md');
  const written = run(root, ['session', 'protocol', '--out', file]);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.equal(written.stdout, `Written to ${file}.\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), expected);

  const notAMarker = run(root, ['session', 'protocol', 99]);
  assert.equal(notAMarker.status, 1, notAMarker.stdout);
  assert.match(notAMarker.stdout, /#99 is not a session marker/);
  const unknown = run(root, ['session', 'protocol', 'x']);
  assert.equal(unknown.status, 2, unknown.stdout);
  assert.match(unknown.stdout, /entry number, e\.g\. 12/);
  const two = run(root, ['session', 'protocol', '1', '2']);
  assert.equal(two.status, 2, two.stdout);
});
