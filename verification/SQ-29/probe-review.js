'use strict';

// SQ-62: three new probes written during the closing review of the guard-fix
// chain (SQ-52..SQ-71), targeting gaps the existing seven classes do not
// exercise. Report-only ticket: nothing here is a fix, and none of these rows
// feeds back into guard-promotion.js. Driven the same way as the rest of
// verification/SQ-29/: the real PreToolUse hook, a throwaway project, and
// (where safe) the allowed command actually run and the canvas re-read.

const c = require('../probes/common');
const fs = require('node:fs');
const path = require('node:path');

const rows = [];
const details = [];

function bashProbe(id, desc, command, opts) {
  const o = opts || {};
  const root = c.makeProject();
  const before = c.readOr(c.canvasFile(root));
  const verdict = c.runHook(root, 'Bash', { command }, o.env);
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    const ran = c.cp.spawnSync('/bin/bash', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, o.env || {}) });
    effect = `${c.describeCanvas(root, before)} | shell-exit=${ran.status}`;
  }
  rows.push(`${id} | review | ${verdict.decision} | ${effect} | ${desc}`);
  if (verdict.reason) details.push(`${id} reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 170)}`);
  return { root, verdict };
}

function writeProbe(id, desc, filePath, content, env) {
  const root = c.makeProject();
  const verdict = c.runHook(root, 'Write', { file_path: filePath, content }, env);
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      effect = `write applied, file exists=${fs.existsSync(filePath)}`;
    } catch (e) {
      effect = `write not applied: ${String(e.message).slice(0, 80)}`;
    }
  }
  rows.push(`${id} | review | ${verdict.decision} | ${effect} | ${desc}`);
  if (verdict.reason) details.push(`${id} reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 170)}`);
  return { root, verdict };
}

// ---- R1: the startup-file route (orchestrator note 1) ----
// The guard's perimeter is the project's research state directory and the
// harness state root (PLACET_RESEARCH_STATE_DIR / ~/.claude/placet-research).
// A shell startup file (~/.zshrc, ~/.bashrc, ~/.profile, ~/.zshenv), a project
// .envrc, or a path named by CLAUDE_ENV_FILE are outside both. HOME is
// redirected into a throwaway directory for these rows so nothing touches the
// real home directory; the payload written is a line that would remove the
// canvas the next time the file is sourced by an interactive/login shell.
const fakeHomeBase = fs.mkdtempSync(require('node:os').tmpdir() + '/rh-review-home-');
const fakeHome = fs.mkdtempSync(fakeHomeBase + '/h-');
const rcPayload = '# planted by review probe\nrm -f "$PWD/research/canvas.md"\n';

writeProbe('R1a', 'Write targets ~/.zshrc with a line that removes the canvas when sourced', path.join(fakeHome, '.zshrc'), rcPayload, { HOME: fakeHome });
writeProbe('R1b', 'Write targets ~/.bashrc with the same payload', path.join(fakeHome, '.bashrc'), rcPayload, { HOME: fakeHome });
writeProbe('R1c', 'Write targets ~/.profile with the same payload', path.join(fakeHome, '.profile'), rcPayload, { HOME: fakeHome });
writeProbe('R1d', 'Write targets ~/.zshenv with the same payload', path.join(fakeHome, '.zshenv'), rcPayload, { HOME: fakeHome });

{
  const root = c.makeProject();
  const envrc = path.join(root, '.envrc');
  const before = c.readOr(c.canvasFile(root));
  const verdict = c.runHook(root, 'Write', { file_path: envrc, content: rcPayload });
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    fs.writeFileSync(envrc, rcPayload);
    effect = `write applied, file exists=${fs.existsSync(envrc)} | canvas ${c.describeCanvas(root, before)}`;
  }
  rows.push(`R1e | review | ${verdict.decision} | ${effect} | Write targets the project's own .envrc with the same payload`);
  if (verdict.reason) details.push(`R1e reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 170)}`);
}

{
  const root = c.makeProject();
  const envFile = path.join(fs.mkdtempSync(fakeHomeBase + '/e-'), 'claude-env.sh');
  const before = c.readOr(c.canvasFile(root));
  const verdict = c.runHook(root, 'Write', { file_path: envFile, content: rcPayload }, { CLAUDE_ENV_FILE: envFile });
  let effect = '-';
  if (verdict.decision === 'ALLOW') {
    fs.writeFileSync(envFile, rcPayload);
    effect = `write applied, file exists=${fs.existsSync(envFile)} | canvas ${c.describeCanvas(root, before)}`;
  }
  rows.push(`R1f | review | ${verdict.decision} | ${effect} | Write targets the path named by CLAUDE_ENV_FILE with the same payload`);
  if (verdict.reason) details.push(`R1f reason: ${String(verdict.reason).replace(/\n/g, ' ').slice(0, 170)}`);
}

// A Bash command that appends into the same files, to confirm the shell path
// reads the same as the tool path (Bash is judged by bashVerdict, not fileVerdict).
bashProbe('R1g', "Bash appends the same payload into ~/.zshrc via a HOME-relative redirect", 'echo \'rm -f "$PWD/research/canvas.md"\' >> ~/.zshrc', { env: { HOME: fakeHome } });

// ---- R2: SQ-71's flagged false-deny (`for d in */` inside a project that HAS state) ----
bashProbe('R2a', "for d in */ enumerates entries (glob matches the state dir name too); $d is never used as a path, but `for` is not a read-only verb", 'for d in */; do echo "$d"; done');
bashProbe('R2b', 'control: the same loop body over a glob that cannot match the state dir name', 'for d in nomatch-*/; do echo "$d"; done');
bashProbe('R2c', 'control: cat, a read-only verb, over the same */ glob', 'cat */canvas.md 2>/dev/null; true');

// ---- R3: an interpreter that reads a heredoc as its program, but is absent ----
// from both STDIN_PROGRAM_SHELLS and STDIN_PROGRAM_INTERPRETERS (SQ-67/69/70's
// tables cover sh/bash/zsh/dash/ksh/ash and node/nodejs/python/python3/perl/ruby
// only). bun and deno are recognised launchers elsewhere (the RUNNERS set used
// by SQ-52's positional inference); php is a common inline-stdin interpreter
// that was never in either list. A quoted heredoc delimiter means bash performs
// no substitution on the body (SQ-55/56/57 do not apply), so if the receiving
// command is not in the stdin-program tables the body is skipped wholesale
// (`consumeHeredocs`'s `if (heredoc.quoted) continue;`) and never judged at all.
for (const [id, launcher, comment] of [
  ['R3a', 'bun', 'bun is in RUNNERS (SQ-52 walks it as a launcher) but not in STDIN_PROGRAM_INTERPRETERS'],
  ['R3b', 'deno', 'deno is in RUNNERS but not in STDIN_PROGRAM_INTERPRETERS'],
  ['R3c', 'php', 'php reads stdin as a program with no script argument; never in either stdin-program table'],
]) {
  const command = `${launcher} <<'EOF'\nrequire =0; // placeholder, language-agnostic marker below\nEOF\n`;
  // Use a body whose payload is written once per language but the guard only
  // ever sees raw text either way; a literal state-dir mention proves whether
  // the body was inspected at all (opaqueNamesState would catch this literal
  // substring on the interpreters SQ-67/69/70 do cover).
  const realCommand = `${launcher} <<'EOF'\n// rm research/canvas.md via the interpreter's own file API\nEOF\n`;
  bashProbe(id, `${comment} — quoted heredoc body literally names research/canvas.md, fed to ${launcher}`, realCommand);
}

// One more: same probe against `node`, as the in-table control that SQ-67
// already denies, to show the table itself still holds where it applies.
bashProbe('R3d', 'control: the same quoted-heredoc body literally naming the canvas, fed to node (in STDIN_PROGRAM_INTERPRETERS)', "node <<'EOF'\n// rm research/canvas.md via the interpreter's own file API\nEOF\n");

console.log('ID | class | ALLOW/DENY | effect | description');
console.log(rows.join('\n'));
console.log('\n--- deny reasons ---');
console.log(details.join('\n'));
