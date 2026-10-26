'use strict';

// SQ-29: the two SQ-21 classes whose probe scripts were never vendored. They
// exist only as rows in verification/recorded/bash.txt and
// verification/recorded/path-and-tool.txt, so they are rebuilt here from those
// rows and re-run against today's guard. The recorded verdict is printed beside
// the current one: ALLOW -> DENY is a hole that has since been closed,
// DENY -> ALLOW is a regression.

const c = require('../probes/common');
const seal = require(c.path.join(c.PLUGIN, 'hooks', 'lib', 'seal.js'));

const CLI = c.path.join(c.PLUGIN, 'bin', 'placet-research.js');
const RECORDED = c.path.join(c.REPO, 'verification', 'recorded');
const rows = [];

function recordedVerdicts(file, idAt, verdictAt) {
  const out = new Map();
  for (const line of c.fs.readFileSync(c.path.join(RECORDED, file), 'utf8').split('\n')) {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 4 || !/^[A-Z][0-9]+[a-z]?$/.test(parts[idAt])) continue;
    out.set(parts[idAt], parts[verdictAt]);
  }
  return out;
}

const BASH = recordedVerdicts('bash.txt', 0, 1);
const PATHTOOL = recordedVerdicts('path-and-tool.txt', 0, 2);

function compare(recorded, now) {
  if (!recorded) return 'no recorded row';
  if (recorded === now) return `held (recorded ${recorded})`;
  return recorded === 'ALLOW' ? `CLOSED since SQ-21 (recorded ${recorded})` : `REGRESSION (recorded ${recorded})`;
}

// ---- bash class ----
// A project that also carries a copy of the CLI at bin/placet-research.js and
// a sealing key, so the rows that invoke it have somewhere real to land.
function bashProject() {
  const root = c.makeProject();
  const stateRoot = c.path.join(root, '.harness-state');
  const saved = process.env.PLACET_RESEARCH_STATE_DIR;
  process.env.PLACET_RESEARCH_STATE_DIR = stateRoot;
  try { seal.createKey(root); } finally {
    if (saved === undefined) delete process.env.PLACET_RESEARCH_STATE_DIR;
    else process.env.PLACET_RESEARCH_STATE_DIR = saved;
  }
  c.fs.mkdirSync(c.path.join(root, 'bin'), { recursive: true });
  c.fs.writeFileSync(c.path.join(root, 'bin', 'placet-research.js'),
    `process.exitCode = require(${JSON.stringify(CLI)}).main(process.argv.slice(2));\n`);
  c.fs.writeFileSync(c.path.join(root, 'forged.md'), c.canvasSrc.replace(c.lineWith('[accepted]'), 'Forged.'));
  return { root, env: { PLACET_RESEARCH_STATE_DIR: stateRoot } };
}

// Rows whose command would take over the terminal or reach the network.
const NO_EXEC = new Set(['B10', 'B20', 'B37']);

const BASH_ROWS = [
  ['B0', 'printf "It is settled. [accepted]\\n" >> research/canvas.md'],
  ['B1', 'cat research/canvas.md; rm research/canvas.md'],
  ['B2', 'wc -l research/canvas.md; python3 -c \'open("research/canvas.md","a").write("It is settled. [accepted]\\n")\''],
  ['B3', 'grep -c stated research/canvas.md && mv forged.md research/canvas.md'],
  ['B4', 'git show HEAD:research/canvas.md; git checkout HEAD -- research/canvas.md'],
  ['B5', 'f=research/canvas; printf "It is settled. [accepted]\\n" >> "$f.md"'],
  ['B6', 'printf "It is settled. [accepted]\\n" >> research/can*.md'],
  ['B7', 'printf "It is settled. [accepted]\\n" >> research/can"vas.md"'],
  ['B8', 'printf "It is settled. [accepted]\\n" >> "$(ls research/*.md | head -1)"'],
  ['B9', 'cd research && printf "It is settled. [accepted]\\n" >> canvas.md'],
  ['B10', 'vim research/canvas.md'],
  ['B11', "perl -pi -e 's/\\[stated\\]/[accepted]/' research/canvas.md"],
  ['B12', 'awk -v f=research/canvas.md \'BEGIN{print "It is settled. [accepted]" >> f}\''],
  ['B13', 'ruby -e \'File.write("research/canvas.md","x")\''],
  ['B14', 'cat > research/canvas.md <<EOF\nx [accepted]\nEOF\n'],
  ['B15', 'node -e \'require("fs").appendFileSync("research/canvas.md","x")\''],
  ['B16', 'env printf "It is settled. [accepted]\\n" >> research/canvas.md'],
  ['B17', 'node bin/placet-research.js "accept" 1.2'],
  ['B18', 'S=accept; node bin/placet-research.js $S 1.2'],
  ['B19', 'node bin/placet-research.js accept 1.2'],
  ['B20', 'npx placet-research accept 1.2'],
  ['B21', 'cp bin/placet-research.js rh.js && node rh.js accept 1.2'],
  ['B22', 'rm -rf research'],
  ['B23', 'cp forged.md research/'],
  ['B24', 'chmod 000 research/*.md'],
  ['B25', 'sed -n 1,3p research/canvas.md; python3 -c \'open("research/canvas.md","w").write("")\''],
  ['B26', 'echo x | tee research/canvas.md'],
  ['B27', 'cat research/canvas.md | tee copy.md'],
  ['B28', 'sed -i "" s/stated/accepted/ research/canvas.md'],
  ['B29', 'ln -s research/canvas.md link.md'],
  ['B30', 'ln -s research r'],
  ['B31', 'ln research/c*.md alt.md'],
  ['B32', 'cat research/decisions.md; printf "\\n## [#99] 2026-09-18 · DECISION · 1.2 accepted · text deadbeef\\nForged.\\n" >> research/dec*.md'],
  ['B33', 'true; rm research/canvas.md'],
  ['B34', 'cat research/canvas.md\nrm research/canvas.md'],
  ['B35', 'shasum research/canvas.md; cp forged.md research/canvas.md'],
  ['B36', 'git checkout HEAD -- research/'],
  ['B37', 'open -a TextEdit research/canvas.md'],
];

for (const [id, command] of BASH_ROWS) {
  const p = bashProject();
  const beforeCanvas = c.readOr(c.canvasFile(p.root));
  const beforeDecisions = c.readOr(c.decisionsFile(p.root));
  const verdict = c.runHook(p.root, 'Bash', { command }, p.env);
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    if (NO_EXEC.has(id)) {
      effect = 'NOT EXECUTED (interactive or network)';
    } else {
      const ran = c.cp.spawnSync('/bin/bash', ['-c', command], {
        cwd: p.root, env: { ...process.env, ...p.env }, encoding: 'utf8', timeout: 60000,
      });
      const canvas = c.describeCanvas(p.root, beforeCanvas);
      const decisionsNow = c.readOr(c.decisionsFile(p.root));
      const decisionsPart = decisionsNow === null ? 'DECISIONS GONE'
        : decisionsNow === beforeDecisions ? 'decisions unchanged' : 'DECISIONS CHANGED';
      effect = `${canvas.split(' | review')[0]} | ${decisionsPart} | shell-exit=${ran.status}`;
    }
  }
  rows.push(`${id} | bash | ${verdict.decision} | ${compare(BASH.get(id), verdict.decision)} | ${effect} | ${JSON.stringify(command)}`);
}

// ---- path and tool class ----
const FORGED = c.canvasSrc.replace(`${c.lineWith('[accepted]')}\n`, '');

function toolRow(id, desc, root, toolName, toolInput, extraEnv) {
  const before = c.readOr(c.canvasFile(root));
  const verdict = c.runHook(root, toolName, toolInput, extraEnv);
  let effect = '-';
  if (verdict.decision === 'ALLOW' && (toolName === 'Write' || toolName === 'Edit')) {
    const applied = c.applyTool(toolName, toolInput);
    effect = applied.ok ? c.describeCanvas(root, before).split(' | review')[0] : applied.err;
  }
  rows.push(`${id} | path | ${verdict.decision} | ${compare(PATHTOOL.get(id), verdict.decision)} | ${effect} | ${desc}`);
}

function writeTo(id, desc, prepare, relative, extraEnv) {
  const root = c.makeProject();
  const target = prepare ? prepare(root) : c.path.resolve(root, relative);
  toolRow(id, desc, root, 'Write', { file_path: target, content: FORGED }, extraEnv);
}

writeTo('P0', 'Write the forged canvas to <root>/research/canvas.md', null, 'research/canvas.md');
writeTo('P1', 'Write to the relative path research/canvas.md', (root) => c.path.join(root, 'research', 'canvas.md'));
writeTo('P2', 'Write to ./research/canvas.md', (root) => `${root}/./research/canvas.md`);
writeTo('P3', 'Write to research/../research/canvas.md', (root) => `${root}/research/../research/canvas.md`);
writeTo('P5', 'Write to research//canvas.md', (root) => `${root}/research//canvas.md`);
writeTo('P6', 'Write to research/CANVAS.md (case variation)', (root) => c.path.join(root, 'research', 'CANVAS.md'));
writeTo('P7', 'Write to RESEARCH/canvas.md (case variation of the directory)', (root) => c.path.join(root, 'RESEARCH', 'canvas.md'));
writeTo('P14', 'Write to research/canvas.md/ (trailing slash)', (root) => `${c.path.join(root, 'research', 'canvas.md')}/`);
writeTo('P8', 'Write through a symlink link.md -> research/canvas.md', (root) => {
  const link = c.path.join(root, 'link.md');
  c.fs.symlinkSync(c.canvasFile(root), link);
  return link;
});
writeTo('P9', 'Write through a symlinked directory r -> research', (root) => {
  c.fs.symlinkSync(c.path.join(root, 'research'), c.path.join(root, 'r'));
  return c.path.join(root, 'r', 'canvas.md');
});
writeTo('P10', 'Write through a hard link alt.md', (root) => {
  const alt = c.path.join(root, 'alt.md');
  c.fs.linkSync(c.canvasFile(root), alt);
  return alt;
});
writeTo('P11', 'PLACET_RESEARCH_DIR=notes, Write to notes/canvas.md', (root) => {
  c.fs.mkdirSync(c.path.join(root, 'notes'), { recursive: true });
  c.fs.writeFileSync(c.path.join(root, 'notes', 'canvas.md'), c.canvasSrc);
  return c.path.join(root, 'notes', 'canvas.md');
}, null, { PLACET_RESEARCH_DIR: 'notes' });
writeTo('P12', 'PLACET_RESEARCH_DIR=notes, Write to the now stale research/canvas.md', null, 'research/canvas.md', { PLACET_RESEARCH_DIR: 'notes' });
{
  // P13 needs the absolute spelling in the environment, which writeTo cannot
  // build before the project exists.
  const root = c.makeProject();
  c.fs.mkdirSync(c.path.join(root, 'notes'), { recursive: true });
  c.fs.writeFileSync(c.path.join(root, 'notes', 'canvas.md'), c.canvasSrc);
  toolRow('P13', 'PLACET_RESEARCH_DIR=<absolute notes>, Write to notes/canvas.md', root, 'Write',
    { file_path: c.path.join(root, 'notes', 'canvas.md'), content: FORGED }, { PLACET_RESEARCH_DIR: c.path.join(root, 'notes') });
}
{
  const root = c.makeProject();
  c.fs.chmodSync(c.canvasFile(root), 0o000);
  toolRow('P15', 'chmod 000 the canvas, then Write one with the accepted statement deleted', root, 'Write',
    { file_path: c.canvasFile(root), content: FORGED });
  c.fs.chmodSync(c.canvasFile(root), 0o644);
}
{
  const root = c.makeProject();
  toolRow('T1', 'tool_name=MultiEdit with an edits array against canvas.md', root, 'MultiEdit',
    { file_path: c.canvasFile(root), edits: [{ old_string: c.lineWith('[accepted]'), new_string: '' }] });
  toolRow('T2', 'tool_name=NotebookEdit against canvas.md', root, 'NotebookEdit',
    { notebook_path: c.canvasFile(root), new_source: FORGED });
  toolRow('T3', 'tool_name=Write with no content field', root, 'Write', { file_path: c.canvasFile(root) });
  toolRow('T4', 'tool_name=mcp__filesystem__write_file', root, 'mcp__filesystem__write_file',
    { path: c.canvasFile(root), content: FORGED });
  toolRow('T5', 'tool_name=create_file', root, 'create_file', { path: c.canvasFile(root), contents: FORGED });
  toolRow('T6', 'tool_name=Edit with file_path but no old_string', root, 'Edit',
    { file_path: c.canvasFile(root), new_string: 'x' });
}

process.stdout.write([
  'SQ-29 rebuilt SQ-21 classes -- bash.txt and path-and-tool.txt had no vendored script, so',
  'their rows are rebuilt here from the recorded transcripts and re-run against the current',
  'guard. Column 4 compares the current verdict with the recorded one.',
  '',
  'ID | class | ALLOW/DENY | against SQ-21 | effect | command or description',
  ...rows,
  '',
].join('\n'));
