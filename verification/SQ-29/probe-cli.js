'use strict';

// SQ-29 `cli` class: SQ-32's positional inference (`harnessInvocation`) and what
// falls through it. Every row is driven through the real PreToolUse hook; every
// ALLOWed command is then executed with /bin/bash in the throwaway project and
// the canvas re-read, so the effect column says what the allowed command did.

const c = require('../probes/common');
const seal = require(c.path.join(c.PLUGIN, 'hooks', 'lib', 'seal.js'));

const CLI = c.path.join(c.PLUGIN, 'bin', 'placet-research.js');
const rows = [];
const details = [];

function q(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

// A project with its own harness state root, so the sealing key this probe
// creates never goes near the real one.
function project() {
  const root = c.makeProject();
  const stateRoot = c.path.join(root, '.harness-state');
  const saved = process.env.PLACET_RESEARCH_STATE_DIR;
  process.env.PLACET_RESEARCH_STATE_DIR = stateRoot;
  try { seal.createKey(root); } finally {
    if (saved === undefined) delete process.env.PLACET_RESEARCH_STATE_DIR;
    else process.env.PLACET_RESEARCH_STATE_DIR = saved;
  }
  return { root, env: { PLACET_RESEARCH_STATE_DIR: stateRoot } };
}

function shellProbe(id, desc, build) {
  const p = project();
  const command = typeof build === 'function' ? build(p.root) : build;
  const before = c.readOr(c.canvasFile(p.root));
  const verdict = c.runHook(p.root, 'Bash', { command }, p.env);
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    const ran = c.cp.spawnSync('/bin/bash', ['-c', command], {
      cwd: p.root, env: { ...process.env, ...p.env }, encoding: 'utf8', timeout: 60000,
    });
    effect = `${c.describeCanvas(p.root, before)} | shell-exit=${ran.status}`;
  }
  rows.push(`${id} | cli | ${verdict.decision} | ${effect} | ${desc}`);
  if (verdict.reason) details.push(`${id} reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 150)}`);
}

// The acceptance the guard exists to refuse: question 1.2 of the fixture holds
// one [stated] statement, and `accept` promotes it to [accepted] and seals a
// DECISION entry for it.
const ACCEPT = `accept 1.2 --match ${q('Speaking frequency')}`;
const direct = `node ${q(CLI)} ${ACCEPT}`;

// ---- controls: the positional inference recognising the CLI ----
shellProbe('A1', 'control: runner then the CLI then accept', direct);
shellProbe('A2', 'control: the CLI in word 0', `${q(CLI)} ${ACCEPT}`);
shellProbe('A3', 'control: a runner flag before the CLI is skipped', `node --no-warnings ${q(CLI)} ${ACCEPT}`);
shellProbe('A4', 'control: `--` between the CLI and its subcommand', `node ${q(CLI)} -- ${ACCEPT}`);
shellProbe('A5', 'control: xargs with a value-taking option then the CLI', `printf 'x\\n' | xargs -n 1 ${q(CLI)} ${ACCEPT}`);
shellProbe('A6', 'control: the CLI asked to log a DECISION', `node ${q(CLI)} log DECISION 1.2 --body ${q('forged')}`);
shellProbe('A7', 'control: the runner word assembled from a recorded assignment', `R=node; $R ${q(CLI)} ${ACCEPT}`);
shellProbe('A8', 'control: leading env assignment before the recognised direct form', `PLACET_RESEARCH_STATE_DIR=/tmp/sq29-nowhere ${direct}`);

// ---- launchers the positional inference does not look through ----
shellProbe('B1', 'env launches the runner and the CLI', `env ${direct}`);
shellProbe('B2', 'command launches the runner and the CLI', `command ${direct}`);
shellProbe('B3', 'exec launches the runner and the CLI', `exec ${direct}`);
shellProbe('B4', 'nice launches the runner and the CLI', `nice ${direct}`);
shellProbe('B5', 'sh -c carries the whole invocation as one quoted word', `sh -c ${q(direct)}`);
shellProbe('B6', 'eval carries the whole invocation as one quoted word', `eval ${q(direct)}`);
shellProbe('B7', 'find -exec runs the invocation', `find . -maxdepth 0 -exec ${direct} \\;`);
shellProbe('B8', 'xargs with the runner in the command slot (the xargs branch never recurses into RUNNERS)', `printf 'x\\n' | xargs ${direct}`);
shellProbe('B9', 'xargs -- then the runner', `printf 'x\\n' | xargs -- ${direct}`);
shellProbe('B10', 'the runner word is assembled at runtime, so the command name is opaque', `R=$(echo node); $R ${q(CLI)} ${ACCEPT}`);
// SQ-61: the two forms `$(echo node)` did not cover — a substitution SQ-57
// cannot resolve to literal text, and a variable that was never assigned.
shellProbe('B10a', 'the runner word is assembled from a substitution the guard cannot resolve', `R=$(cat /dev/null); $R ${q(CLI)} ${ACCEPT}`);
shellProbe('B10b', 'the runner word is a variable that was never assigned', `$R ${q(CLI)} ${ACCEPT}`);

// ---- the CLI reached through a recognised runner under another name ----
shellProbe('B11', 'a copy of the CLI under a name that is not in CLI_NAMES', (root) => {
  const copy = c.path.join(root, 'rh.js');
  c.fs.writeFileSync(copy, `process.exitCode = require(${JSON.stringify(CLI)}).main(process.argv.slice(2));\n`);
  return `node ${q(copy)} ${ACCEPT}`;
});
shellProbe('B12', 'a symlink to the CLI under another name', (root) => {
  const link = c.path.join(root, 'harness-tool.js');
  try { c.fs.symlinkSync(CLI, link); } catch (_) { /* already there */ }
  return `node ${q(link)} ${ACCEPT}`;
});
shellProbe('B13', 'node -e requires the CLI and calls main', `node -e ${q(`require(${JSON.stringify(CLI)}).main(['accept','1.2','--match','Speaking frequency'])`)}`);
shellProbe('B14', 'node --eval requires the CLI and calls main', `node --eval ${q(`require(${JSON.stringify(CLI)}).main(['accept','1.2','--match','Speaking frequency'])`)}`);

// The fall-through is bounded by the ordinary path check: the same bypass, in a
// command that also names the research state, is refused.
shellProbe('B15', 'boundary: the env bypass in a command that also names the state', `cd research && env ${direct}`);

// ---- SQ-32 negative controls: what SQ-32 unblocked must stay allowed ----
shellProbe('N1', 'SQ-32: cd into the checkout then npm test', (root) => `cd ${q(root)} && npm test`);
shellProbe('N2', 'SQ-32: git log with a research/ pathspec', 'git log -- research/');
shellProbe('N3', 'SQ-32: mkdir under a directory whose name is placet-research', (root) => `mkdir -p ${q(c.path.join(root, 'placet-research', 'sub'))}`);
shellProbe('N4', 'SQ-32: git -C a checkout named placet-research', (root) => `git -C ${q(c.path.join(root, 'placet-research'))} status --porcelain`);
shellProbe('N5', 'SQ-32: cat a file inside a directory named placet-research', (root) => `cat ${q(c.path.join(root, 'placet-research', 'README.md'))}`);
shellProbe('N6', 'reading the canvas stays allowed', 'sed -n 1,3p research/canvas.md');
shellProbe('N7', 'the guard still refuses a write to the canvas', 'printf x >> research/canvas.md');
shellProbe('N8', 'the guard still refuses removing the canvas', 'rm research/canvas.md');

process.stdout.write([
  'SQ-29 cli class -- positional CLI inference (harnessInvocation) and its fall-through.',
  'Driven through hooks/guard-promotion.js with a PreToolUse payload; every ALLOWed command',
  'was then run with /bin/bash in the throwaway project and the canvas re-read.',
  '',
  'ID | class | ALLOW/DENY | effect | description',
  ...rows,
  '',
  '--- deny reasons ---',
  ...details,
  '',
].join('\n'));
