'use strict';

// US-3/H: the README walkthrough is the test's script. Every `console` block in
// its "Walkthrough" section starts with a `$` command; this file runs those
// commands, in the README's order, in a fresh project under a temp directory
// (the human steps included, through the CLI, as cli.test.js does), and holds
// the printed result to the output the README shows under the command. A claim
// the README makes about a printed line either matches the real output or this
// file fails on it.
//
// What it cannot run: the steps Claude takes (`/placet-research:canvas`,
// `:check`, `:record-review`) and `serve`, which needs a browser, and
// `fetch.js`, which needs the network. Those are covered where the README says:
// the recorded stand-ins run here, the skills' instructions are pinned by
// skills.test.js, the view's dialogs by view.test.js, and fetch's hash check is
// tested below on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const canvasLib = require('../hooks/lib/canvas');
const decisions = require('../hooks/lib/decisions');
const seal = require('../hooks/lib/seal');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const exampleDir = path.join(repoRoot, 'examples', 'ai-assistants-interviews');
const readmeText = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');

// ---------- the README's walkthrough, as data ----------

// From the Walkthrough heading to the next `## ` heading that is not inside a
// fenced block (the review output printed in a block holds `## ` lines of its own).
function walkthroughSection() {
  const lines = readmeText.split('\n');
  const from = lines.findIndex((l) => l.startsWith('## Walkthrough: '));
  assert.notEqual(from, -1, 'the plugin README has no Walkthrough section');
  let fenced = false;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('```')) fenced = !fenced;
    else if (!fenced && lines[i].startsWith('## ')) { to = i; break; }
  }
  return lines.slice(from, to).join('\n');
}

// { lang, mods, lines } for each fenced block; `mods` is the rest of the
// info string (`refused`, `clone`).
function fencedBlocks(text) {
  const blocks = [];
  const re = /```(\w+)([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: m[1], mods: m[2].trim().split(/\s+/).filter(Boolean), lines: m[3].replace(/\n$/, '').split('\n') });
  }
  return blocks;
}

function consoleBlocks() {
  return fencedBlocks(walkthroughSection())
    .filter((b) => b.lang === 'console')
    .map((b) => {
      assert.match(b.lines[0], /^\$ /, `a console block must start with a $ command: ${b.lines[0]}`);
      return { command: b.lines[0].slice(2), expected: b.lines.slice(1), refused: b.mods.includes('refused'), clone: b.mods.includes('clone') };
    });
}

// A README line may hold `…` for any text inside the line; a line that is only
// `…` stands for any number of lines. Lines between two such markers must be
// contiguous in the output and in the same order; without a leading or
// trailing marker the output starts or ends exactly there.
function lineMatches(expected, actual) {
  if (!expected.includes('…')) return expected === actual;
  const source = expected.split('…').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`).test(actual);
}

function matchesOutput(expected, output) {
  const actual = output.replace(/\n+$/, '').split('\n');
  const segments = [[]];
  let leading = false;
  let trailing = false;
  expected.forEach((line, i) => {
    if (line === '…') {
      if (i === 0) leading = true;
      else if (i === expected.length - 1) trailing = true;
      if (segments[segments.length - 1].length) segments.push([]);
    } else {
      segments[segments.length - 1].push(line);
    }
  });
  if (!segments[segments.length - 1].length) segments.pop();
  let pos = 0;
  for (let s = 0; s < segments.length; s += 1) {
    const seg = segments[s];
    let at = -1;
    for (let j = pos; j + seg.length <= actual.length; j += 1) {
      if (s === 0 && !leading && j !== 0) break;
      if (seg.every((line, k) => lineMatches(line, actual[j + k]))) { at = j; break; }
    }
    if (at < 0) return false;
    pos = at + seg.length;
  }
  return trailing || pos === actual.length;
}

// Seals, digests and the dated text hash differ on every run; the README shows
// them as placeholders.
function normalize(output, found) {
  return output
    .replace(/Sealing key created at (\S+) \(mode/, (_, file) => {
      found.keyFile = file;
      return 'Sealing key created at <key file> (mode';
    })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>')
    .replace(/\b[0-9a-f]{16}\b/g, '<seal>')
    .replace(/(with text )[0-9a-f]{8}\b/g, '$1<hash>');
}

// ---------- running it ----------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-demo-'));
const binDir = path.join(scratch, 'bin');
fs.mkdirSync(binDir);
// The bare `placet-research` the README types, as install-cli would provide.
fs.writeFileSync(path.join(binDir, 'placet-research'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });

const project = path.join(scratch, 'rh-demo');
const reviewer = path.join(scratch, 'rh-review');
fs.mkdirSync(project);
const stateOf = (dir) => path.join(scratch, `state-${path.basename(dir)}`);

// The name every entry carries as `By` (SQ-177). Written into the fixture's own
// state dir, which comes before git config user.name, so the walkthrough prints
// the same bytes on a machine with a git identity and on one without.
function setName(dir) {
  const state = stateOf(dir);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(state, 'name'))) fs.writeFileSync(path.join(state, 'name'), 'A. Researcher\n');
}

function shell(command, cwd) {
  setName(cwd);
  const { CLAUDE_PROJECT_DIR: _p, PLACET_RESEARCH_DIR: _d, CLAUDE_PLUGIN_ROOT: _r, ...ambient } = process.env;
  return childProcess.spawnSync('/bin/sh', ['-c', command], {
    cwd,
    env: { ...ambient, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, PLACET_RESEARCH_STATE_DIR: stateOf(cwd) },
    encoding: 'utf8',
  });
}

let walked = null;
function walk() {
  if (walked) return walked;
  const found = { keyFile: null };
  const steps = [];
  const started = Date.now();
  for (const block of consoleBlocks()) {
    let cwd = project;
    if (block.clone) {
      // The reviewer's checkout: a copy of research/ and no key of its own.
      if (!fs.existsSync(reviewer)) {
        fs.mkdirSync(reviewer);
        fs.cpSync(path.join(project, 'research'), path.join(reviewer, 'research'), { recursive: true });
      }
      cwd = reviewer;
    }
    const command = block.command.replaceAll('~/placet-research', repoRoot).replaceAll('<key file>', found.keyFile || '<no key yet>');
    const began = Date.now();
    const out = shell(command, cwd);
    steps.push({ ...block, ran: command, cwd, status: out.status, stdout: normalize(out.stdout, found), stderr: out.stderr, ms: Date.now() - began });
  }
  walked = { steps, found, totalMs: Date.now() - started };
  return walked;
}

// ---------- the tests ----------

test('every console block of the walkthrough runs in README order and prints what the README shows', () => {
  const { steps, totalMs } = walk();
  assert.ok(steps.length >= 13, `expected the walkthrough's commands, found ${steps.length}`);
  for (const step of steps) {
    const label = `README command: ${step.command}`;
    if (step.refused) assert.notEqual(step.status, 0, `${label} should be refused\n${step.stdout}`);
    else assert.equal(step.status, 0, `${label} failed (exit ${step.status})\n${step.stdout}${step.stderr}`);
    assert.equal(step.stderr, '', `${label} wrote to stderr`);
    assert.ok(matchesOutput(step.expected, step.stdout), `${label}\nREADME shows:\n${step.expected.join('\n')}\nthe command printed:\n${step.stdout}`);
  }
  console.log(`# demo walkthrough: ${steps.length} commands, ${totalMs} ms of wall time`);
});

test('the walkthrough teaches every command of the three capabilities', () => {
  const commands = walk().steps.map((s) => s.command);
  for (const needle of [
    'placet-research init --project',
    'recorded.js',
    'placet-research review --variant trust',
    'placet-research choose trust --why',
    'placet-research log DISCOVERY "3.1 check" --body',
    'placet-research accept 1.1 --explained',
    'placet-research accept 3.1 --explained',
    'placet-research status',
    'placet-research choose workflow --why',
    'grep -E',
    'placet-research review --key <key file>',
  ]) {
    assert.ok(commands.some((c) => c.includes(needle)), `no README command contains: ${needle}`);
  }
  // an accept without the explanation is shown being refused
  const bare = walk().steps.find((s) => s.command === 'placet-research accept 1.1');
  assert.ok(bare && bare.refused && bare.status !== 0);
});

test('the decision log holds what the README says the reviewer cites', () => {
  walk();
  const { entries } = decisions.parseDecisions(fs.readFileSync(path.join(project, 'research', 'decisions.md'), 'utf8'));
  assert.deepEqual(entries.map((e) => `${e.seq} ${e.kind} ${e.ref}`), [
    '1 DECISION framing chosen: trust',
    '2 DISCOVERY 3.1 check',
    '3 DECISION 1.1 accepted',
    '4 DECISION 3.1 accepted',
  ]);
  const [chosen, check, first, second] = entries;
  assert.match(chosen.why, /interview guide's last section/);
  assert.match(chosen.rejected, /^role \(lens: .+\); workflow \(lens: .+\)$/, 'the other two framings, with their lenses');
  assert.ok(check.seal !== null, 'the check question is sealed like every entry');
  assert.equal(check.explained, null, 'a check question carries no explanation');
  assert.match(first.explained, /^I accept that these developers/);
  assert.deepEqual(first.openAtAccept, [], '1.1 had no open check question');
  assert.match(second.explained, /^The question is the one/);
  assert.deepEqual(second.openAtAccept, [2], '3.1 was accepted with the check question #2 open');
  // the two framings that were not chosen stay where they were written
  assert.deepEqual(fs.readdirSync(path.join(project, 'research', 'variants')).sort(), ['role', 'trust', 'workflow']);
  // nothing in the log is unsealed: the whole chain verifies under the key init printed
  const key = seal.readKeyFile(walk().found.keyFile);
  assert.equal(seal.verifyChain(fs.readFileSync(path.join(project, 'research', 'decisions.md'), 'utf8'), key).status, 'verified');
});

test('the three recorded framings are proposals and findings only, tagged with sources that exist', () => {
  walk();
  const sources = JSON.parse(fs.readFileSync(path.join(exampleDir, 'sources.json'), 'utf8'));
  const known = new Set(sources.files.map((f) => f.name));
  const lenses = new Set();
  for (const name of ['workflow', 'trust', 'role']) {
    const file = path.join(project, 'research', 'variants', name, 'canvas.md');
    const parsed = canvasLib.parseCanvas(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.frontmatter.variant, name);
    assert.deepEqual(parsed.problems, [], `${name} canvas has parse problems`);
    lenses.add(parsed.frontmatter.lens);
    const statements = canvasLib.allStatements(parsed).filter((s) => s.marker !== null);
    assert.deepEqual(statements.map((s) => s.question), ['1.1', '3.1', '7.1', '9.1'], `${name} holds four statements`);
    for (const s of statements) {
      assert.ok(['proposed', 'tentative'].includes(s.marker), `${name} ${s.question} is [${s.marker}]`);
      for (const tag of s.tags.filter((t) => t.startsWith('src:'))) {
        assert.ok(known.has(tag.slice(4).trim()), `${name} ${s.question} cites ${tag}, which sources.json does not pin`);
      }
    }
  }
  assert.equal(lenses.size, 3, 'three different lenses');
});

test('the reviewer\'s copy verifies only under the released key, and a changed byte is named', () => {
  walk();
  const original = fs.readFileSync(path.join(project, 'research', 'decisions.md'), 'utf8');
  assert.equal(fs.readFileSync(path.join(reviewer, 'research', 'decisions.md'), 'utf8'), original);
  const anchorLine = (text) => text.split('\n').find((l) => l.startsWith('Anchor: '));
  const mine = shell('placet-research review', project).stdout;
  const keyless = shell('placet-research review', reviewer).stdout;
  const keyed = shell(`placet-research review --key "${walk().found.keyFile}"`, reviewer).stdout;
  assert.match(mine, /verified: 4 sealed entries/);
  assert.match(keyless, /unverifiable here: no sealing key on this machine/);
  assert.match(keyed, /verified: 4 sealed entries/);
  assert.ok(anchorLine(mine) && anchorLine(mine) === anchorLine(keyless) && anchorLine(mine) === anchorLine(keyed), 'the same record prints the same anchor everywhere');

  // One word of entry #3 changed in the reviewer's copy.
  const tampered = original.replace('do not take the assistant', 'do take the assistant');
  assert.notEqual(tampered, original);
  fs.writeFileSync(path.join(reviewer, 'research', 'decisions.md'), tampered);
  const broken = shell(`placet-research review --key "${walk().found.keyFile}"`, reviewer).stdout;
  assert.match(broken, /BROKEN at #3 \(line \d+\): its own heading or body changed\./);
  assert.notEqual(anchorLine(broken), anchorLine(mine), 'the anchor no longer matches the published one');
  fs.writeFileSync(path.join(reviewer, 'research', 'decisions.md'), original);
});

// The guard's verdict on a command the README shows, as Claude Code would ask it.
function guardVerdict(command) {
  const { CLAUDE_PROJECT_DIR: _p, PLACET_RESEARCH_DIR: _d, ...ambient } = process.env;
  const out = childProcess.spawnSync(process.execPath, [path.join(pluginRoot, 'hooks', 'guard-promotion.js')], {
    cwd: project,
    env: { ...ambient, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: project, PLACET_RESEARCH_STATE_DIR: stateOf(project) },
    input: JSON.stringify({ cwd: project, session_id: 'demo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput.permissionDecision : null;
}

test('the human steps of the walkthrough are denied to the model; the one write it makes is not', () => {
  const steps = walk().steps;
  const human = steps.filter((s) => /^placet-research (choose|accept) /.test(s.command));
  assert.ok(human.length >= 5, `expected the choose and accept commands, found ${human.length}`);
  for (const s of human) assert.equal(guardVerdict(s.ran), 'deny', `the guard must deny: ${s.command}`);
  assert.equal(guardVerdict('placet-research serve'), 'deny');
  const check = steps.find((s) => s.command.startsWith('placet-research log DISCOVERY "3.1 check"'));
  assert.ok(check, 'the README shows the log DISCOVERY "3.1 check" command the check skill runs');
  assert.notEqual(guardVerdict(check.ran), 'deny', 'the model records a check question through log DISCOVERY');
});

test('fetch.js accepts exactly the pinned bytes and refuses anything else', () => {
  const fetchLib = require(path.join(exampleDir, 'fetch.js'));
  const { sources } = fetchLib;
  assert.equal(sources.record, 22893731);
  assert.equal(sources.licence, 'CC-BY-4.0');
  assert.deepEqual(sources.files.map((f) => f.name), [
    ...Array.from({ length: 13 }, (_, i) => `Interview_P${String(i + 1).padStart(2, '0')}.md`),
    'README.md',
  ]);
  for (const f of sources.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isInteger(f.size) && f.size > 0);
    assert.match(fetchLib.urlOf(f), new RegExp(`^https://zenodo.org/api/records/22893731/files/${f.name}/content$`));
  }
  // bytes built to match one pinned entry pass; one changed byte or a cut file does not
  const file = { name: 'x.md', size: 5, sha256: fetchLib.sha256(Buffer.from('hello')) };
  assert.equal(fetchLib.mismatch(file, Buffer.from('hello')), null);
  assert.match(fetchLib.mismatch(file, Buffer.from('hellp')), /sha256/);
  assert.match(fetchLib.mismatch(file, Buffer.from('hell')), /4 bytes, pinned 5/);
});

test('the demo folder states its licence, its pinned version and the later versions', () => {
  const text = fs.readFileSync(path.join(exampleDir, 'README.md'), 'utf8');
  for (const needle of ['22893731', '10.5281/zenodo.22893731', 'CC BY 4.0', 'Hristova', '22902703', '22975092']) {
    assert.ok(text.includes(needle), `examples/ai-assistants-interviews/README.md does not mention ${needle}`);
  }
});
