'use strict';

// SQ-29 `lex` class: SQ-22's hand-written shell lexer in guard-promotion.js —
// quoting, nesting, heredocs, redirections, command substitution, variable
// assembly and `cd` tracking. Every row is driven through the real PreToolUse
// hook; every ALLOWed command is then executed with /bin/bash in the throwaway
// project and the canvas re-read, so the effect column says what it did.

const c = require('../probes/common');

const rows = [];
const details = [];

function q(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

function shellProbe(id, desc, build, opts) {
  const o = opts || {};
  const root = c.makeProject();
  const command = typeof build === 'function' ? build(root) : build;
  const before = c.readOr(c.canvasFile(root));
  const verdict = c.runHook(root, 'Bash', { command });
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    if (o.execute === false) {
      effect = 'NOT EXECUTED (names a CLI outside the throwaway project)';
    } else {
      const ran = c.cp.spawnSync('/bin/bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 60000 });
      effect = `${c.describeCanvas(root, before)} | shell-exit=${ran.status}`;
    }
  }
  rows.push(`${id} | lex | ${verdict.decision} | ${effect} | ${desc}`);
  if (verdict.reason) details.push(`${id} reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 170)}`);
}

// ---- heredocs: the body is skipped wholesale by consumeHeredocs ----
shellProbe('L1', 'unquoted heredoc body holds a command substitution that removes the canvas', 'cat <<EOF\n$(rm research/canvas.md)\nEOF\n');
shellProbe('L2', 'control: quoted heredoc delimiter, so the same body is literal', "cat <<'EOF'\n$(rm research/canvas.md)\nEOF\n");
shellProbe('L3', 'unquoted heredoc body holds a backquote substitution that removes the canvas', 'cat <<EOF\n`rm research/canvas.md`\nEOF\n');
shellProbe('L4', 'control: a write redirection alongside a heredoc is still seen', 'cat <<EOF > research/canvas.md\nx\nEOF\n');
shellProbe('L5', 'control: an unterminated heredoc swallows the rest, which bash does not run either', 'cat <<EOF\nrm research/canvas.md\n');

// ---- nesting depth: MAX_SUBSTITUTION_DEPTH is 8 ----
function nest(depth) {
  let inner = 'rm research/canvas.md';
  for (let k = 0; k < depth; k += 1) inner = `echo $(${inner})`;
  return inner;
}
shellProbe('L6', 'control: seven nested command substitutions, within the lexer depth limit', nest(7));
shellProbe('L7', 'eight nested command substitutions reach the limit', nest(8));
shellProbe('L8', 'nine nested command substitutions hide the removal past MAX_SUBSTITUTION_DEPTH', nest(9));

// ---- substitution forms the lexer does handle (controls) ----
shellProbe('L9', 'control: backquote substitution at top level', 'echo `rm research/canvas.md`');
shellProbe('L10', 'control: process substitution', 'cat <(rm research/canvas.md)');
shellProbe('L11', 'control: here-string carrying a substitution', 'grep x <<< "$(rm research/canvas.md)"');
shellProbe('L12', 'control: ANSI-C quoting around the path', "rm $'research/canvas.md'");
shellProbe('L13', 'control: brace expansion over the state directory', 'rm research/{canvas,decisions}.md');

// ---- variable assembly ----
shellProbe('L14', 'control: two recorded assignments concatenated into the path', 'F=resear; G=ch/canvas.md; rm "$F$G"');
shellProbe('L15', 'the path is assembled from two command substitutions, so no word keeps a literal part of it', 'F=$(printf %s resear)$(printf %s ch/canvas.md); rm $F');
shellProbe('L16', 'control: the same assembly, but the file name is left literal', 'F=$(printf %s resear)ch/canvas.md; rm $F');

// ---- redirections: `>&N` is a descriptor duplication, not a file ----
// SQ-29 comment 2: the live pair was an unresolvable `cd` plus `2>&1`.
shellProbe('L17', 'seed: unresolvable cd then a pipeline with 2>&1 and no path at all', 'cd "$HOME/no-such-dir-sq29" && node bin/tool.js help 2>&1 | grep -n x');
shellProbe('L18', 'the same pipeline without the 2>&1', 'cd "$HOME/no-such-dir-sq29" && node bin/tool.js help | grep -n x');
shellProbe('L19', '2>&1 alone after an unresolvable cd, with a read-only verb', 'cd "$HOME/no-such-dir-sq29" && cat notes.txt 2>&1');
shellProbe('L20', 'control: 2>&1 after a cd the guard can follow', 'cd research && cat canvas.md 2>&1');
shellProbe('L21', 'control: the >& form with a real path operand still reads as a write', 'echo x >& research/canvas.md');

// ---- cd tracking ----
shellProbe('L22', 'control: cd into the state directory then read a relative path', 'cd research && sed -n 1,2p canvas.md');
shellProbe('L23', 'control: cd into the state directory then remove a relative path', 'cd research && rm canvas.md');
shellProbe('L24', 'control: cd - makes the base unknown, so a relative write redirection is refused', 'cd research && cd - && printf x > canvas.md');

// ---- the live seed of SQ-29 comment 1: a `node -e` pipeline whose JS body
// decided the verdict. Neither command is executed: both name a CLI outside the
// throwaway project. The verdict pair is the whole point of these rows.
const BODIES = {
  L25: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.tickets||j).find(x=>x.ref==="SQ-29");console.log(t.description);})',
  L26: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const r of ["SQ-28","SQ-30"]){const t=(j.tickets||j).find(x=>x.ref===r);console.log("=== "+r+" files="+JSON.stringify(t.files)+" readonly="+t.readonly);console.log(t.description||t.body);}})',
  L27: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const r of ["SQ-28","SQ-30"]){const t=(j.tickets||j).find(x=>x.ref===r);console.log(t.description);}})',
  L28: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.tickets||j).find(x=>x.ref==="SQ-29");console.log("files="+JSON.stringify(t.files)+" readonly="+t.readonly);})',
  L29: 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const t=(j.tickets||j).find(x=>x.ref==="SQ-29");console.log("=== "+t.ref);})',
};
const SEED_DESC = {
  L25: 'seed: the ALLOWed pipeline body (single find, no loop)',
  L26: 'seed: the DENIED pipeline body, verbatim',
  L27: 'bisect: the denied body with the for loop but without the files=/readonly=/=== literals',
  L28: 'bisect: the allowed body plus the files=/readonly= literals',
  L29: 'bisect: the allowed body plus the "=== " literal',
};
for (const id of Object.keys(BODIES)) {
  shellProbe(id, SEED_DESC[id], (root) => `cd ${q(root)} && node ${q('/tmp/sq29-tool.js')} list --json --project "$PWD" 2>/dev/null | node -e ${q(BODIES[id])}`, { execute: false });
}

// ---- what the bisect of L25/L26 lands on: a `[...]` run inside any word is
// read as a glob by denotesState, and componentMatches answers "matches" for a
// pattern that will not compile.
shellProbe('L30', 'a JS array literal in a word makes the word denote the state directory', 'node -e \'const r=["SQ-28","SQ-30"];console.log(r)\'');
shellProbe('L31', 'control: the same word with the brackets removed', 'node -e \'const r="SQ-28";console.log(r)\'');
shellProbe('L32', 'control: the same mis-glob under a read-only verb, so no refusal follows it', 'grep -n "[Qa-]" README.md');

// SQ-96: the same family for a bare `*`/`**` run inside a sed program or grep
// pattern. That text is never glob-expanded, so a run in it names the state
// only by spelling it; a shell program (`sh -c`, `eval`, `bash -c`) is expanded
// when it runs and keeps its runs as patterns.
shellProbe('L35', 'SQ-80 #8: a sed edit of .gitignore whose replacement is **/_raw-model-output/*', "sed -i '' 's|^_raw-model-output/\\*$|**/_raw-model-output/*|' .gitignore");
shellProbe('L36', 'a **/ run in a sed program beside a non-read-only verb, on files outside research/', "rm -f notes.txt && sed -n 's|x|**/_raw/*|p' .gitignore");
shellProbe('L37', 'control: a */ grep pattern under a read-only verb alone', "grep -n '*/foo' .gitignore");
shellProbe('L38', 'bound: a quoted */foo that is the whole word stays a pattern (the word, not a run in it)', "mkdir -p scratch && grep -n '*/foo' .gitignore");
shellProbe('L39', 'control: a run that spells research/ literally in a sed program is still the state', "sed -i '' 's|a|research/canvas.md|' .gitignore");
shellProbe('L40', 'control: a glob in an sh -c program is expanded when it runs', "sh -c 'rm res*/canvas.md'");
shellProbe('L41', 'control: a glob in an eval program is expanded when it runs', 'eval "sed -i s/x/y/ r*/canvas.md"');
shellProbe('L42', 'control: a ** in a bash -c program is expanded when it runs', 'bash -c "cp x **/research/canvas.md"');

// The other direction of the same comparison: `componentMatches(parts[k],
// stateParts[k])` takes the candidate as the pattern, so a literal `[` in the
// project path is a character class the state directory's own name cannot match.
(function bracketProject() {
  const home = c.fs.mkdtempSync(c.path.join(require('node:os').tmpdir(), 'rh-sq29-'));
  const root = c.path.join(home, 'paper[2024]');
  c.fs.mkdirSync(c.path.join(root, 'research'), { recursive: true });
  c.fs.writeFileSync(c.path.join(root, 'research', 'canvas.md'), c.canvasSrc);
  c.fs.writeFileSync(c.path.join(root, 'research', 'decisions.md'), c.decisionsSrc);
  const command = 'rm research/canvas.md';
  const before = c.readOr(c.path.join(root, 'research', 'canvas.md'));
  const verdict = c.runHook(root, 'Bash', { command });
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    const ran = c.cp.spawnSync('/bin/bash', ['-c', command], { cwd: root, encoding: 'utf8' });
    const after = c.readOr(c.path.join(root, 'research', 'canvas.md'));
    effect = `${after === null ? 'CANVAS GONE' : after === before ? 'file unchanged' : 'file changed'} | shell-exit=${ran.status}`;
  }
  rows.push(`L33 | lex | ${verdict.decision} | ${effect} | a project directory named paper[2024]: the guard cannot recognise its own state directory`);
  if (verdict.reason) details.push(`L33 reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 170)}`);

  // The Edit path resolves by canonical path and inode, not by glob, so it is
  // not blind in the same project. This bounds L33 to the Bash verdict.
  c.fs.writeFileSync(c.path.join(root, 'research', 'canvas.md'), c.canvasSrc);
  const line = c.lineWith('[accepted]');
  const edit = { file_path: c.path.join(root, 'research', 'canvas.md'), old_string: line, new_string: line.replace('[accepted]', '') };
  const v2 = c.runHook(root, 'Edit', edit);
  rows.push(`L34 | lex | ${v2.decision} | - | control: the same paper[2024] project, but an Edit removing the accepted marker`);
  if (v2.reason) details.push(`L34 reason: ${String(v2.reason).replace(/\n/g, ' ').slice(0, 170)}`);
}());

process.stdout.write([
  'SQ-29 lex class -- the shell lexer in hooks/guard-promotion.js.',
  'Driven through the hook with a PreToolUse payload; every ALLOWed command was then run',
  'with /bin/bash in the throwaway project and the canvas re-read, except the L25-L29 seed',
  'rows, which are verdict-only because they name a CLI outside the throwaway project.',
  '',
  'ID | class | ALLOW/DENY | effect | description',
  ...rows,
  '',
  '--- deny reasons ---',
  ...details,
  '',
].join('\n'));
