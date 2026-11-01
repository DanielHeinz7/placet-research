'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const script = path.join(pluginRoot, 'hooks', 'guard-promotion.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');
const guard = require('../hooks/guard-promotion');
// The exported verdicts resolve the profile through CLAUDE_PLUGIN_ROOT in this
// process. A runner launched from another plugin's process carries that plugin's
// root, so the in-process calls below would load the wrong profile set.
process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;

const canvasText = fs.readFileSync(path.join(fixtureDir, 'canvas.md'), 'utf8');
const decisionsText = fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  fs.mkdirSync(path.join(root, 'research'));
  fs.writeFileSync(path.join(root, 'research', 'canvas.md'), canvasText);
  fs.writeFileSync(path.join(root, 'research', 'decisions.md'), decisionsText);
  return root;
}

// A checkout that is not a paper project: nowhere in it is there research state.
function makeBareProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rh-bare-'));
}

// A notes repo whose research directory is not harness state.
function makeNotesProject(t) {
  const parent = makeBareProject();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo');
  fs.mkdirSync(path.join(root, 'research'), { recursive: true });
  fs.mkdirSync(path.join(root, 'areas'));
  fs.writeFileSync(path.join(root, 'research', 'note.md'), 'note');
  fs.writeFileSync(path.join(root, 'areas', 'a.md'), 'x');
  return root;
}

// A paper project whose own directory name holds brackets. The guard builds the
// state path out of real directories, and one of them spells a character class.
function makeBracketProject() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-bracket-')), 'paper[2024]');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'research'));
  fs.writeFileSync(path.join(root, 'research', 'canvas.md'), canvasText);
  fs.writeFileSync(path.join(root, 'research', 'decisions.md'), decisionsText);
  return root;
}

function run(projectRoot, toolName, toolInput, env = {}) {
  const { CLAUDE_PROJECT_DIR: _project, PLACET_RESEARCH_DIR: _dir, ...ambient } = process.env;
  const out = childProcess.spawnSync(process.execPath, [script], {
    cwd: projectRoot,
    env: { ...ambient, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env },
    input: JSON.stringify({ cwd: projectRoot, session_id: 's', hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput }),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null;
}

const ACCEPTED = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]";
const STATED = 'Speaking frequency is well documented; whether a proposal is taken up is not. [stated]';
const PROPOSED = 'Uptake may be a property of the meeting\'s chairing style rather than of the proposal. [proposed]';

test('files outside the state dir are not the guard\'s business', () => {
  const root = makeProject();
  assert.equal(run(root, 'Write', { file_path: path.join(root, 'manuscript.md'), content: 'x [accepted]' }), null);
  assert.equal(run(root, 'Bash', { command: 'ls -la' }), null);
});

test('editing, adding and removing proposals is allowed', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  assert.equal(run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: 'Uptake may depend on who chairs. [tentative]' }), null);
  assert.equal(run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: '' }), null);
  assert.equal(run(root, 'Edit', { file_path: file, old_string: '## 1.3 Why does this matter — for practice, for theory, or both?\n\n_(empty)_', new_string: '## 1.3 Why does this matter — for practice, for theory, or both?\n\nBecause allocation happens in meetings. [proposed, src: memo-01]' }), null);
});

test('transcribing a new [stated] statement is allowed; tagging a proposal is allowed', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  assert.equal(run(root, 'Edit', { file_path: file, old_string: STATED, new_string: `${STATED}\nThe researcher recorded all twelve meetings personally. [stated]` }), null);
  // A proposal is not a commitment, so its tags stay the model's to set.
  assert.equal(run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: PROPOSED.replace('[proposed]', '[proposed, src: memo-05]') }), null);
});

// The evidence tags belong to the commitment (§4.3.1), so attaching one to a
// statement the researcher stated is not an annotation, it is a claim about
// what backs their words — SQ-21's D4b fabricated a source on the accepted
// statement and thereby dropped it from canvas-review's untagged report, so the
// review stopped flagging the very thing it exists to flag.
test('retagging a committed statement is denied, including attaching a source to it', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const attach = run(root, 'Edit', { file_path: file, old_string: STATED, new_string: STATED.replace('[stated]', '[stated, src: memo-05]') });
  assert.equal(attach.permissionDecision, 'deny');
  assert.match(attach.permissionDecisionReason, /evidence tag/);

  const tagged = 'Under what meeting conditions does a junior member\'s proposal get taken up? [stated, src: memo-03]';
  for (const replacement of ['[stated, src: memo-99 §4]', '[stated]']) {
    const out = run(root, 'Edit', { file_path: file, old_string: tagged, new_string: tagged.replace('[stated, src: memo-03]', replacement) });
    assert.equal(out.permissionDecision, 'deny', replacement);
    assert.match(out.permissionDecisionReason, /evidence tag/);
  }
});

test('creating an [accepted] statement is denied', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const out = run(root, 'Edit', { file_path: file, old_string: '_(empty)_\n\n# 2 ', new_string: 'It matters. [accepted]\n\n# 2 ' });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /\[accepted\]/);
  assert.match(out.permissionDecisionReason, /placet-research:accept/);
});

test('altering, removing or downgrading a [stated] or [accepted] statement is denied', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  for (const newString of [
    STATED.replace('well documented', 'poorly documented'),
    '',
    STATED.replace('[stated]', '[proposed]'),
  ]) {
    const out = run(root, 'Edit', { file_path: file, old_string: STATED, new_string: newString });
    assert.equal(out.permissionDecision, 'deny', `should deny: ${JSON.stringify(newString)}`);
    assert.match(out.permissionDecisionReason, /propose .* alongside/i);
  }
  const accepted = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement? [accepted]";
  const out = run(root, 'Edit', { file_path: file, old_string: accepted, new_string: accepted.replace('serious', 'real') });
  assert.equal(out.permissionDecision, 'deny');
});

test('promoting a proposal to [stated] or [accepted] is denied', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  for (const marker of ['[stated]', '[accepted]']) {
    const out = run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: PROPOSED.replace('[proposed]', marker) });
    assert.equal(out.permissionDecision, 'deny', marker);
  }
});

// SQ-21's structural class. Each of these changed the canvas by zero or a
// handful of bytes and left the statement's own text and marker untouched;
// what moved was the element, the question or the frontmatter around it. The
// byte deltas are from the probe run and are the point: a researcher reading
// the transcript would not notice any of them.
const Q11 = '## 1.1 What is the broad question this project speaks to?';
const BLOCK11 = `${Q11}\n\n${ACCEPTED}\n\n`;

test('re-parenting a committed statement to another element is denied (S1, S6)', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  // S1, 3157 -> 3157: question 1.1 and its accepted statement moved under
  // element 3. S6, 3157 -> 3157: the statement alone moved to a duplicate 1.1
  // under element 9, which flipped element 9 to `accepted` while element 1 lost
  // the commitment and the file did not change size.
  const s1 = canvasText.replace(BLOCK11, '').replace('# 3 · Research Question\n', `# 3 · Research Question\n\n${Q11}\n\n${ACCEPTED}\n`);
  const s6 = `${canvasText.replace(BLOCK11, '')}\n${Q11}\n\n${ACCEPTED}\n`;
  for (const [name, content] of [['S1', s1], ['S6', s6]]) {
    const out = run(root, 'Write', { file_path: file, content });
    assert.equal(out.permissionDecision, 'deny', name);
    assert.equal(Buffer.byteLength(content), Buffer.byteLength(canvasText), `${name} changes no bytes`);
  }
});

test('a duplicate question heading is denied wherever it is placed (S5, S5b)', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const copy = `${ACCEPTED.replace(' [accepted]', '')} [proposed]`;
  // The first implementation matched statements in file order, so the copy was
  // caught after the original and missed before it. A duplicate heading is now
  // unjudgeable either way.
  const before = canvasText.replace(BLOCK11, `${Q11}\n\n${copy}\n\n${BLOCK11}`);
  const after = `${canvasText}\n${Q11}\n\n${copy}\n`;
  for (const [name, content] of [['S5', before], ['S5b', after]]) {
    const out = run(root, 'Write', { file_path: file, content });
    assert.equal(out.permissionDecision, 'deny', name);
    assert.match(out.permissionDecisionReason, /question 1\.1 has 2 headings/, name);
  }
});

test('a second element heading is denied (S15, 3157 -> 3215)', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const out = run(root, 'Write', { file_path: file, content: `${canvasText}\n# 1 · Puzzle (working)\n\n## 1.7 Working notes\n\n_(empty)_\n` });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /element 1 has 2 headings/);
});

test('rewriting the question or the element around a commitment is denied (S2, S3)', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  // S2, 3157 -> 3150: the question's text rewritten, its id kept, so the
  // accepted statement now answers a different question.
  const s2 = run(root, 'Write', { file_path: file, content: canvasText.replace(Q11, '## 1.1 Which chairing style should the firm adopt?') });
  assert.equal(s2.permissionDecision, 'deny');
  assert.match(s2.permissionDecisionReason, /question rewritten/);
  // S3, 3157 -> 3164: Puzzle retitled Contributions, which turns an accepted
  // puzzle into an accepted contribution.
  const s3 = run(root, 'Write', { file_path: file, content: canvasText.replace('# 1 · Puzzle', '# 1 · Contributions') });
  assert.equal(s3.permissionDecision, 'deny');
  assert.match(s3.permissionDecisionReason, /title of its element/);
});

// The frontmatter is protected state, not decoration (§4.3.1): the whole
// mapping, so that the next key added is protected by default.
test('rewriting any frontmatter key is denied (S12, S12b)', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const s12 = run(root, 'Write', {
    file_path: file,
    content: canvasText.replace('project: voice-uptake', 'project: chair-rotation').replace('outlet: Organization Science', 'outlet: Journal of Chairing'),
  });
  assert.equal(s12.permissionDecision, 'deny');
  assert.match(s12.permissionDecisionReason, /frontmatter key "outlet"|frontmatter key "project"/);

  // S12b pointed profile: at an id the plugin does not ship, and dependency
  // checking simply stopped rather than reporting that it could not check.
  const s12b = run(root, 'Write', { file_path: file, content: canvasText.replace('profile: is-qualitative', 'profile: is-experimental') });
  assert.equal(s12b.permissionDecision, 'deny');

  const added = run(root, 'Write', { file_path: file, content: canvasText.replace('canvas-schema: 2', 'canvas-schema: 2\nreviewer: the model') });
  assert.equal(added.permissionDecision, 'deny');
  assert.match(added.permissionDecisionReason, /frontmatter key "reviewer"/);
});

test('a canvas whose profile does not resolve cannot be judged at all', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const broken = canvasText.replace('profile: is-qualitative', 'profile: is-experimental');
  fs.writeFileSync(file, broken);
  // Even a write that touches nothing else: the rules that judge this canvas
  // cannot be loaded, so §5.3's fail-closed clause applies.
  const out = run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: '' });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /does not resolve to a profile this harness ships/);
});

test('pushing U+00A0 or U+FEFF into a committed statement is denied (D5b, D5c)', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  for (const code of [0x00a0, 0xfeff]) {
    const injected = ACCEPTED.replace('serious consideration', `serious${String.fromCharCode(code)}consideration`);
    const out = run(root, 'Edit', { file_path: file, old_string: ACCEPTED, new_string: injected });
    assert.equal(out.permissionDecision, 'deny', code.toString(16));
  }
});

// SQ-29 F9. The canonical line joins its seven fields with U+001F, and a field
// holding one reproduces a boundary between them, so a commitment can be re-cut
// with its identity unchanged. A C0 control character in a commitment's field is
// refused at whichever write would leave one, which is the two writes K7/K8
// needed: first the crafted tag, then the re-cut.
test('a control character in a commitment field is denied, at either write', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const sep = String.fromCharCode(0x1f);
  const plant = `${STATED.replace(/ \[stated\]$/, '')} and the planted tag. [stated, alpha${sep}beta]`;

  const first = run(root, 'Edit', { file_path: file, old_string: STATED, new_string: `${STATED}\n\n${plant}` });
  assert.equal(first.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /control character U\+001F in an evidence tag/);

  // The re-cut, on a canvas that already carries the crafted tag: the joined
  // line is identical, and the write is still refused.
  fs.writeFileSync(file, canvasText.replace(STATED, `${STATED}\n\n${plant}`));
  const shifted = plant.replace(` [stated, alpha${sep}beta]`, `${sep}alpha [stated, beta]`);
  const second = run(root, 'Edit', { file_path: file, old_string: plant, new_string: shifted });
  assert.equal(second.permissionDecision, 'deny');
  assert.match(second.permissionDecisionReason, /control character U\+001F in the statement text/);

  // And on the accepted statement, in both directions (K3, K4).
  const craftedTag = `[accepted, src: interview-07${sep}memo-02]`;
  fs.writeFileSync(file, canvasText.replace('[accepted]', craftedTag));
  const out = run(root, 'Edit', { file_path: file, old_string: craftedTag, new_string: `${sep}src: interview-07 [accepted, memo-02]` });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /control character U\+001F/);
});

test('a tab and a line break in a statement are reflow, not a control character', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const added = 'The researcher\tlogged every meeting over\n\ttwo terms. [stated]';
  assert.equal(run(root, 'Edit', { file_path: file, old_string: STATED, new_string: `${STATED}\n\n${added}` }), null);
});

test('Write is judged as a whole file; removing a heading is denied', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  assert.equal(run(root, 'Write', { file_path: file, content: canvasText.replace(PROPOSED, '') }), null);
  const out = run(root, 'Write', { file_path: file, content: canvasText.replace('## 9.3 What would refute the contribution?\n\n_(empty)_\n', '') });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /heading/);
});

test('creating canvas.md where none exists is allowed unless it carries [accepted]', () => {
  const root = makeProject();
  fs.unlinkSync(path.join(root, 'research', 'canvas.md'));
  const file = path.join(root, 'research', 'canvas.md');
  assert.equal(run(root, 'Write', { file_path: file, content: canvasText.replace('[accepted]', '[proposed]') }), null);
  assert.equal(run(root, 'Write', { file_path: file, content: canvasText }).permissionDecision, 'deny');
});

test('the guard fails closed when it cannot judge', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const missing = run(root, 'Edit', { file_path: file, old_string: 'this text is not in the file', new_string: 'x' });
  assert.equal(missing.permissionDecision, 'deny');
  assert.match(missing.permissionDecisionReason, /old_string/);
  const ambiguous = run(root, 'Edit', { file_path: file, old_string: '_(empty)_', new_string: 'y [proposed]' });
  assert.equal(ambiguous.permissionDecision, 'deny');
  const garbage = run(root, 'Write', { file_path: file, content: 'not a canvas at all' });
  assert.equal(garbage.permissionDecision, 'deny');
  const notebook = run(root, 'NotebookEdit', { notebook_path: file, new_source: 'x' });
  assert.equal(notebook.permissionDecision, 'deny');
  assert.match(notebook.permissionDecisionReason, /not a notebook/);
  // A recognised tool carrying a payload it cannot have written from: no
  // content to compare against, no old_string to apply.
  const contentless = run(root, 'Write', { file_path: file });
  assert.equal(contentless.permissionDecision, 'deny');
  assert.match(contentless.permissionDecisionReason, /carries no content/);
  const stringless = run(root, 'Edit', { file_path: file, new_string: 'x [accepted]' });
  assert.equal(stringless.permissionDecision, 'deny');
  assert.match(stringless.permissionDecisionReason, /old_string/);
});

// ---------- path resolution ----------

// The control payload from SQ-21 (verification/SQ-21/path-and-tool.txt): the
// [accepted] statement of 1.1 deleted and the [stated] statement of 1.2
// reworded. At the canonical path it is denied; every case below is that same
// payload reaching the same file under a different name.
const FORGED = canvasText
  .replace(`${ACCEPTED}\n`, '')
  .replace(STATED, 'Whether a proposal is taken up is well documented. [stated]');

function deniedReason(root, file, env) {
  const out = run(root, 'Write', { file_path: file, content: FORGED }, env);
  assert.equal(out && out.permissionDecision, 'deny', String(file));
  return out.permissionDecisionReason;
}

// Case sensitivity is a property of the volume, so the test asks the volume.
// Where names are case-sensitive these really are different files and the
// guard is right to ignore them.
function caseBlindVolume(root) {
  try {
    fs.accessSync(path.join(root, 'RESEARCH', 'canvas.md'));
    return true;
  } catch (_) {
    return false;
  }
}

function canSymlink(root) {
  const probe = path.join(root, '.symlink-probe');
  try {
    fs.symlinkSync(path.join(root, 'research'), probe);
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

test('the forged canvas is denied at the canonical path', () => {
  const root = makeProject();
  assert.match(deniedReason(root, path.join(root, 'research', 'canvas.md')), /\[accepted\] commitment in question 1\.1/);
});

test('a case variant of the path is the same file and is judged as one', (t) => {
  const root = makeProject();
  if (!caseBlindVolume(root)) return t.skip('case-sensitive volume: these are different files');
  for (const spelling of [['research', 'CANVAS.md'], ['RESEARCH', 'canvas.md'], ['RESEARCH', 'CANVAS.md']]) {
    assert.match(deniedReason(root, path.join(root, ...spelling)), /\[accepted\] commitment in question 1\.1/);
  }
  // With no canvas on disk a case variant still creates one, so the creation
  // rule applies to it too: allowed, unless it carries [accepted].
  fs.unlinkSync(path.join(root, 'research', 'canvas.md'));
  const fresh = path.join(root, 'research', 'CANVAS.md');
  assert.equal(run(root, 'Write', { file_path: fresh, content: canvasText.replace('[accepted]', '[proposed]') }), null);
  assert.equal(run(root, 'Write', { file_path: fresh, content: canvasText }).permissionDecision, 'deny');
  return undefined;
});

test('a symlinked file, a symlinked directory and a hard link all lead back to the canvas', (t) => {
  const root = makeProject();
  if (!canSymlink(root)) return t.skip('this platform does not allow symlinks');
  const canvasFile = path.join(root, 'research', 'canvas.md');
  fs.symlinkSync(canvasFile, path.join(root, 'link.md'));
  fs.symlinkSync(path.join(root, 'research'), path.join(root, 'r'));
  fs.linkSync(canvasFile, path.join(root, 'alt.md'));
  for (const spelling of ['link.md', path.join('r', 'canvas.md'), 'alt.md']) {
    assert.match(deniedReason(root, path.join(root, spelling)), /\[accepted\] commitment in question 1\.1/);
  }
  // A link that points nowhere yet still names where the write would land.
  fs.unlinkSync(canvasFile);
  fs.symlinkSync(canvasFile, path.join(root, 'dangling.md'));
  assert.equal(run(root, 'Write', { file_path: path.join(root, 'dangling.md'), content: canvasText }).permissionDecision, 'deny');
  return undefined;
});

test('an unreadable canvas is unjudgeable, not absent', (t) => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  fs.chmodSync(file, 0o000);
  try {
    fs.readFileSync(file);
    fs.chmodSync(file, 0o644);
    return t.skip('this process reads a mode 000 file, so the fail-open cannot be reproduced');
  } catch (_) {
    // As intended: the guard is about to meet the same EACCES.
  }
  for (const toolInput of [
    { file_path: file, content: FORGED },
    { file_path: file, content: canvasText },
  ]) {
    const out = run(root, 'Write', toolInput);
    assert.equal(out && out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /Cannot judge this write/);
    assert.match(out.permissionDecisionReason, /cannot be read \(EACCES\)/);
    // The refusal names the file it could not read, not what was typed.
    assert.ok(out.permissionDecisionReason.includes(fs.realpathSync.native(file)), out.permissionDecisionReason);
  }
  const edit = run(root, 'Edit', { file_path: file, old_string: STATED, new_string: '' });
  assert.equal(edit.permissionDecision, 'deny');
  assert.match(edit.permissionDecisionReason, /cannot be read \(EACCES\)/);
  fs.chmodSync(file, 0o644);
  return undefined;
});

// Held, and must stay held: the spellings path.resolve already reduced to the
// canonical path. Canonicalising must not lose any of them.
test('relative, dotted, doubled and trailing-slash spellings stay held', () => {
  const root = makeProject();
  for (const spelling of [
    'research/canvas.md',
    './research/canvas.md',
    'research/../research/canvas.md',
    'research//canvas.md',
    `${path.join(root, 'research', 'canvas.md')}${path.sep}`,
    path.join(root, '.', 'research', '..', 'research', 'canvas.md'),
  ]) {
    assert.match(deniedReason(root, spelling), /\[accepted\] commitment in question 1\.1/);
  }
});

test('PLACET_RESEARCH_DIR stays held in its relative and its absolute form', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-'));
  const configuredDir = path.join(root, 'paper', 'state');
  fs.mkdirSync(configuredDir, { recursive: true });
  fs.writeFileSync(path.join(configuredDir, 'canvas.md'), canvasText);
  fs.mkdirSync(path.join(root, 'research'));
  fs.writeFileSync(path.join(root, 'research', 'canvas.md'), canvasText);
  for (const configured of [path.join('paper', 'state'), configuredDir]) {
    const reason = deniedReason(root, path.join(configuredDir, 'canvas.md'), { PLACET_RESEARCH_DIR: configured });
    assert.match(reason, /\[accepted\] commitment in question 1\.1/);
    // and research/ is then just another directory
    assert.equal(run(root, 'Write', { file_path: path.join(root, 'research', 'canvas.md'), content: FORGED }, { PLACET_RESEARCH_DIR: configured }), null);
  }
});

// §5.3 after SQ-27: the model does not write decisions.md, appends included.
// SQ-21's D7b (Edit) and D7c (Write) appended a forged DECISION through the
// append-only door; D8 showed that it silenced the unlogged-acceptance report.
test('decisions.md: every model write is denied, appends included, and the refusal names the append path', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'decisions.md');
  const forged = `\n## [#4] 2026-09-18 · DECISION · 1.2 accepted · text d1b87d4e\nChair rotation is the mechanism that determines uptake.\n**Why:** confirmed by the researcher in session.\n`;
  const d7b = run(root, 'Edit', { file_path: file, old_string: '**Rejected:** framing it as a voice-frequency question.', new_string: `**Rejected:** framing it as a voice-frequency question.${forged}` });
  assert.equal(d7b.permissionDecision, 'deny');
  assert.match(d7b.permissionDecisionReason, /placet-research log DISCOVERY\|CONSTRAINT/);
  assert.match(d7b.permissionDecisionReason, /researcher's act/);
  const d7c = run(root, 'Write', { file_path: file, content: `${decisionsText}${forged}` });
  assert.equal(d7c.permissionDecision, 'deny');
  for (const input of [
    ['Write', { file_path: file, content: `${decisionsText}\n## [#4] 2026-09-16 · DISCOVERY · 2 Audience and Prior Research\nx [tentative]\n` }],
    ['Edit', { file_path: file, old_string: 'CONSTRAINT', new_string: 'DECISION' }],
    ['Write', { file_path: file, content: '# fresh\n' }],
    ['Write', { file_path: file, content: decisionsText }],
    ['NotebookEdit', { notebook_path: file, new_source: 'x' }],
  ]) {
    const out = run(root, input[0], input[1]);
    assert.equal(out && out.permissionDecision, 'deny', `${input[0]} ${JSON.stringify(input[1]).slice(0, 60)}`);
  }
  // A ledger that does not exist yet is not a door either.
  fs.unlinkSync(file);
  assert.equal(run(root, 'Write', { file_path: file, content: '# Decision log — x\n' }).permissionDecision, 'deny');
});

// The key is a secret only while the model cannot read it, and the chain is
// evidence only while the model cannot seal with a key of its own choosing.
test('the harness state directory is off-limits to every tool, and a harness invocation cannot be given its own environment', () => {
  const root = makeProject();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
  const env = { PLACET_RESEARCH_STATE_DIR: stateRoot };
  const keyDir = path.join(stateRoot, 'abc');
  fs.mkdirSync(keyDir);
  const keyFile = path.join(keyDir, 'seal.key');
  fs.writeFileSync(keyFile, '00');
  for (const [tool, input] of [
    ['Read', { file_path: keyFile }],
    ['Read', { file_path: stateRoot }],
    ['Glob', { pattern: '*', path: stateRoot }],
    ['Grep', { pattern: 'x', path: keyDir }],
    ['Write', { file_path: keyFile, content: '00' }],
    ['Edit', { file_path: keyFile, old_string: '00', new_string: '11' }],
    ['mcp__filesystem__read_file', { path: keyFile }],
  ]) {
    const out = run(root, tool, input, env);
    assert.equal(out && out.permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
    assert.match(out.permissionDecisionReason, /harness state directory/, tool);
  }
  for (const cmd of [
    `cat ${keyFile}`,
    `cat "${keyDir}"/seal.key`,
    `ls ${stateRoot}`,
    `cp ${keyFile} /tmp/k`,
    `PLACET_RESEARCH_STATE_DIR=/tmp/x node "/x/bin/placet-research.js" log DISCOVERY 1 --body x`,
    `HOME=/tmp/h node "/x/bin/placet-research.js" log DISCOVERY 1 --body x`,
    `PLACET_RESEARCH_STATE_DIR=/tmp/x node "/x/bin/placet-research.js" init --project p --mode seed`,
    `export PLACET_RESEARCH_STATE_DIR=/tmp/x; node "/x/bin/placet-research.js" log DISCOVERY 1 --body x`,
    `k=${stateRoot}; cat "$k/abc/seal.key"`,
  ]) {
    const out = run(root, 'Bash', { command: cmd }, env);
    assert.equal(out && out.permissionDecision, 'deny', cmd);
  }
  // Ordinary work next to it stays open, and so does reading the state root's
  // parent, which is the user's own home.
  for (const cmd of [`ls ${path.dirname(stateRoot)}`, 'cat ~/.zshrc', 'node "/x/bin/placet-research.js" status']) {
    assert.equal(run(root, 'Bash', { command: cmd }, env), null, cmd);
  }
  assert.equal(run(root, 'Read', { file_path: path.join(root, 'research', 'canvas.md') }, env), null);
});

test('Bash: a symlinked ancestor of the state root, on disk or made by an earlier statement, is still denied', (t) => {
  const root = makeProject();
  if (!canSymlink(root)) return t.skip('this platform does not allow symlinks');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
  const env = { PLACET_RESEARCH_STATE_DIR: stateRoot };
  const keyDir = path.join(stateRoot, 'abc');
  fs.mkdirSync(keyDir);
  fs.writeFileSync(path.join(keyDir, 'seal.key'), '00');

  // A symlink that already exists on disk and only spells the state root
  // through an ancestor: the Bash closure has to resolve it, not just
  // compare spellings, the same way the file-tool path already does.
  const link = path.join(root, 'shortcut');
  fs.symlinkSync(stateRoot, link);
  assert.equal(run(root, 'Bash', { command: `cat ${link}/*/seal.key` }, env).permissionDecision, 'deny');

  // A symlink the command itself creates, earlier in the same compound
  // command, before the shell has run anything: the guard has to track it
  // the way it already tracks `cd` across statements.
  const madeCmd = `ln -sfn ${path.dirname(stateRoot)} h && cat h/${path.basename(stateRoot)}/*/seal.key`;
  assert.equal(run(root, 'Bash', { command: madeCmd }, env).permissionDecision, 'deny');

  // Control: the same made-in-command link pointed at ordinary project
  // files stays open, so the new check does not widen the closure.
  assert.equal(run(root, 'Bash', { command: 'ln -sfn . h && cat h/research/canvas.md' }, env), null);
});

test('Bash: earlier-call and pre-existing links to the project cannot hide a canvas or log write', (t) => {
  const root = makeProject();
  if (!canSymlink(root)) return t.skip('this platform does not allow symlinks');
  // This call is allowed and makes the link before the writes are judged.
  assert.equal(run(root, 'Bash', { command: 'ln -s . h' }), null);
  fs.symlinkSync('.', path.join(root, 'h'));
  fs.symlinkSync(path.join(root, 'research'), path.join(root, 'already'));
  for (const command of [
    `sed -i '' 's/\\[proposed\\]/[accepted]/' h/research/canvas.md`,
    'echo tail >> h/research/decisions.md',
    'echo tail >> already/decisions.md',
    'echo tail >> h/research/variants/alpha/decisions.md',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  assert.equal(run(root, 'Bash', { command: 'cat h/research/canvas.md' }), null);
});

test('the default harness state directory under the home directory is protected without any environment set', () => {
  const root = makeProject();
  const { PLACET_RESEARCH_STATE_DIR: _state, ...rest } = process.env;
  const home = os.homedir();
  for (const cmd of [
    `cat ${home}/.claude/placet-research/abc/seal.key`,
    'cat ~/.claude/placet-research/abc/seal.key',
    'cat "$HOME/.claude/placet-research/abc/seal.key"',
    'find ~/.claude/placet-research -name seal.key',
  ]) {
    const out = childProcess.spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...rest, CLAUDE_PLUGIN_ROOT: pluginRoot },
      input: JSON.stringify({ cwd: root, session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }),
      encoding: 'utf8',
    });
    const parsed = out.stdout ? JSON.parse(out.stdout).hookSpecificOutput : null;
    assert.equal(parsed && parsed.permissionDecision, 'deny', cmd);
  }
});

test('Bash: reading the state files is allowed, writing them is denied, accept via Bash is denied', () => {
  const root = makeProject();
  for (const cmd of [
    'cat research/canvas.md',
    'grep -n accepted research/canvas.md | head',
    'sed -n 1,20p research/decisions.md',
    'git diff -- research/canvas.md',
    'node "/x/bin/placet-research.js" status',
    'node "/x/bin/placet-research.js" review',
    'node "/x/bin/placet-research.js" init --project p --mode seed',
    'node "/x/bin/placet-research.js" log DISCOVERY "2 Prior Research" --body "Two studies contradict each other. [tentative, src: ref-11]"',
    'node "/x/bin/placet-research.js" log CONSTRAINT 5 --body "No further fieldwork. [stated]" --why "the committee said so"',
    'placet-research log DISCOVERY 1.2 --body x',
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, cmd);
  }
  for (const cmd of [
    'node "/x/bin/placet-research.js" log DECISION "1.2 accepted" --body "x [accepted]"',
    'node "/x/bin/placet-research.js" log "$KIND" 1 --body x',
    'k=DECISION; node "/x/bin/placet-research.js" log $k 1 --body x',
    'node "/x/bin/placet-research.js" log',
    'echo "x [accepted]" >> research/canvas.md',
    'cat other.md > research/canvas.md',
    'sed -i "s/stated/accepted/" research/canvas.md',
    'cat research/canvas.md | tee research/canvas.md',
    'python3 -c "open(\'research/decisions.md\',\'w\').write(\'\')"',
    'node "/x/bin/placet-research.js" accept 1.2',
    'mv research/canvas.md /tmp/x',
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', cmd);
  }
});

// The probe set from SQ-21 (verification/SQ-21/bash.txt). One case per evasion
// family rather than one per probe: each family is a different way of writing
// the same intent, which is why the guard lexes the command instead of matching
// strings against it.
const BASH_EVASIONS = [
  ['chained behind a read verb', 'cat research/canvas.md; rm research/canvas.md'],
  ['chained behind a read verb, newline separator', 'cat research/canvas.md\nrm research/canvas.md'],
  ['chained into an interpreter', 'wc -l research/canvas.md; python3 -c \'open("research/canvas.md","a").write("It is settled. [accepted]")\''],
  ['chained behind &&', 'grep -c stated research/canvas.md && mv forged.md research/canvas.md'],
  ['chained behind a checksum', 'shasum research/canvas.md; cp forged.md research/canvas.md'],
  ['glob', 'printf "It is settled. [accepted]\\n" >> research/can*.md'],
  ['quote splitting', 'printf "It is settled. [accepted]\\n" >> research/can"vas.md"'],
  ['variable assembly', 'f=research/canvas; printf "It is settled. [accepted]\\n" >> "$f.md"'],
  ['command substitution', 'printf "It is settled. [accepted]\\n" >> "$(ls research/*.md | head -1)"'],
  ['awk redirection', 'awk -v f=research/canvas.md \'BEGIN{print "It is settled. [accepted]" >> f}\''],
  ['directory removal', 'rm -rf research'],
  ['symlink onto the state dir', 'ln -s research r'],
  ['hard link out of the state dir', 'ln research/c*.md alt.md'],
  ['ledger append behind a read', 'cat research/decisions.md; printf "\\n## [#99] 2026-09-18 · DECISION · 1.2 accepted · text deadbeef\\nForged.\\n" >> research/dec*.md'],
  ['interpreter naming the file in its program text', 'node -e \'require("fs").appendFileSync("research/canvas.md","x")\''],
  ['restoring the file out of git', 'git checkout HEAD -- research/'],
  ['permissions', 'chmod 000 research/*.md'],
  ['command substitution, no literal part survives either substitution', 'rm "$(printf %s resear)$(printf %s ch/canvas.md)"'],
];

// Commands the guard already held. They stay denied: the new shape must not
// trade one hole for another.
const BASH_HELD = [
  'printf "It is settled. [accepted]\\n" >> research/canvas.md',
  'cd research && printf "It is settled. [accepted]\\n" >> canvas.md',
  'vim research/canvas.md',
  "perl -pi -e 's/\\[stated\\]/[accepted]/' research/canvas.md",
  'ruby -e \'File.write("research/canvas.md","x")\'',
  'env printf "It is settled. [accepted]\\n" >> research/canvas.md',
  'cat > research/canvas.md <<EOF\nx [accepted]\nEOF',
  'sed -i "" s/stated/accepted/ research/canvas.md',
  'echo x | tee research/canvas.md',
  'cat research/canvas.md | tee copy.md',
  'ln -s research/canvas.md link.md',
  'true; rm research/canvas.md',
  'open -a TextEdit research/canvas.md',
];

// Deny by default only inside the scope the lexer can see. These are the
// negative controls against over-denial: reads over the state, and ordinary
// work that has nothing to do with it.
const BASH_ALLOWED = [
  'git log --oneline -- research/canvas.md',
  'git show HEAD:research/canvas.md',
  'git add research/canvas.md',
  'git commit -m "update research/canvas.md"',
  'wc -l research/canvas.md research/decisions.md | sort | uniq -c',
  'diff research/canvas.md /tmp/other.md',
  'cd research && cat canvas.md',
  'grep -c stated research/canvas.md > /tmp/rh-count',
  'find research -name "*.md"',
  'shasum research/*.md',
  'cat bin/placet-research.js',
  'npx placet-research status',
  'placet-research doctor',
  'placet-research install-cli --dir /tmp/rh-bin',
  'echo "see research/canvas.md"',
  'echo x > "$LOG"',
  'node -e \'console.log(1)\'',
  'git add .',
  'npm test',
  'mkdir -p docs/research-notes',
  'rm -rf node_modules',
  'cat "$(printf %s resear)$(printf %s ch/canvas.md)"',
];

test('Bash: every evasion family in the probe set is denied', () => {
  const root = makeProject();
  for (const [family, cmd] of BASH_EVASIONS) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', `${family}: ${cmd}`);
    assert.match(out.permissionDecisionReason, /read-only/, family);
  }
});

test('Bash: the commands the guard already held stay denied', () => {
  const root = makeProject();
  for (const cmd of BASH_HELD) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', cmd);
  }
});

test('Bash: reads over the state and ordinary work elsewhere are not refused', () => {
  const root = makeProject();
  for (const cmd of BASH_ALLOWED) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, cmd);
  }
});

// SQ-68. SQ-57's fail-closed reading of an unresolved substitution in argument
// position was asked of every verb, so it refused ordinary work in a paper
// project: `mkdir -p "build/$(date +%F)"` and `[ "$(sysctl -n vm.loadavg)" = x ]`
// were denied because the substitution could not be resolved, not because
// either command names the state. The reading belongs to a verb whose operand
// is the file it writes; `NON_FILE_VERBS` names the verbs whose operand is only
// ever a value, and only there is it lifted. Every other verb keeps it, so the
// write shapes in the second case still deny.
test('SQ-68: an unresolved substitution in a non-file operand is not a write target', () => {
  const root = makeProject();
  for (const command of [
    '[ "$(sysctl -n vm.loadavg)" = x ]',
    'test "$(cat t)" = x',
    'mkdir -p "build/$(date +%F)"',
    'echo "$(date)" > out.log',
    'printf "%s\\n" "$(date)"',
    'true "$(cat t)"',
    'false "$(cat t)"',
    'date -r "$(cat t)"',
    'sleep "$(cat t)"',
    'git commit -m "$(cat msg.txt)"',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

test('SQ-68: the same substitution stays denied where the verb writes its operand', () => {
  const root = makeProject();
  for (const command of [
    'node script.js "$(git rev-parse HEAD)"',
    'vim "$(cat t)"',
    'chmod 000 "$(cat t)"',
    'cp notes.md "backup/$(date +%s).md"',
    'rm "$(cat target.txt)"',
    'mv research/canvas.md "$(cat t)"',
    'ln -s x "$(cat t)"',
    'touch "$(cat t)"',
    'truncate -s 0 "$(cat t)"',
    'tee "$(cat t)"',
    'dd of="$(cat t)"',
    'sed -i "s/a/b/" "$(cat t)"',
    'sort -o "$(cat t)" research/canvas.md',
    'cat foo > "$(cat t)"',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// SQ-65. A word with no path separator is a name, not a location. The bare
// `research` was resolved against the project root, landed on the state
// directory and denied every tool whose payload carried the word — a profile
// id, a topic, a title — in a vault or a skills checkout exactly as in a paper
// project, and the shell path read `python3 x.py research` the same way. The
// name no longer counts as the directory; every spelling that does carry a
// location still counts, and the guard is inert for the bare word only where
// there is no state directory to name.
test('SQ-65: a bare state-directory name in a payload is a name, not the state directory', () => {
  const root = makeProject();
  assert.equal(run(root, 'mcp__plugin_sidequest_board__profile_get', { profile: 'research' }), null);
  // The same word in every spelling that spells a location is still the state.
  for (const spelling of ['./research', 'research/', 'research/canvas.md', path.join(root, 'research')]) {
    const out = run(root, 'MultiEdit', { file_path: spelling, edits: [] });
    assert.equal(out && out.permissionDecision, 'deny', spelling);
  }
});

test('SQ-65: without research state the bare word is left alone, a spelled path is not', () => {
  const bare = makeBareProject();
  for (const command of ['python3 x.py research', 'node research', 'rm -rf research', 'ln -s research r']) {
    assert.equal(run(bare, 'Bash', { command }), null, command);
  }
  assert.equal(run(bare, 'mcp__plugin_sidequest_board__profile_get', { profile: 'research' }), null);
  const write = run(bare, 'MultiEdit', { file_path: 'research/canvas.md', edits: [] });
  assert.equal(write && write.permissionDecision, 'deny');
  // A command that creates the state is still judged: the path it spells is a
  // location whether or not there is anything there yet.
  for (const command of ['cat > research/canvas.md', 'git checkout HEAD -- research/']) {
    const out = run(bare, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// SQ-71: a command cannot touch research state that is not there. The state is
// the canvas and the decision log, so a project whose state directory holds
// neither has nothing to refuse: an ordinary line — a loop whose body reads a
// substitution, an `rm "$x"` whose value the guard never read — is speculation
// about where the state might be, and there is nowhere for it to land. The
// words that spell a location are still judged (SQ-65), the harness state
// directory is still off-limits (SQ-27), and the CLI's own refusals do not
// depend on state at all.
test('SQ-71: without research state ordinary shell commands are not the guard\'s business', () => {
  const bare = makeBareProject();
  for (const command of [
    'for d in */; do echo "$d"; done',
    'while true; do l=$(sysctl -n vm.loadavg); echo "$l"; sleep 30; done',
    'x=$(cat a); rm "$x"',
    'l=$(sysctl -n vm.loadavg); echo "$l"',
    'VAR=x node --test t.mjs > /private/tmp/sq71/log 2>&1',
    // A pattern the guard cannot compute is refused because it can land on the
    // state; with no state there is nothing for it to land on.
    'rm -rf resea[r]ch',
    // The state is read once, where the command stands: a line that creates it
    // and removes it in the same breath is judged on entry, and is left alone.
    'mkdir research && rm -rf */',
    // SQ-72, folded in: the same speculation one statement later — a `cd` the
    // guard cannot follow makes `base` null, and every word after it counted as
    // touching a state that is not there. Ordinary build and tool lines were
    // denied this way in a repo that never had a `research/`.
    'docker stop x',
    'for p in 3100 3111; do lsof -i :$p; done',
    'npm run gates > gate.log 2>&1',
    'cd "$HOME/x" && docker stop x',
    'cd "$HOME/x" && for p in 3100 3111; do lsof -i :$p; done',
    'cd "$HOME/x" && npm run build > build.log 2>&1',
  ]) {
    assert.equal(run(bare, 'Bash', { command }), null, command);
  }
  // Creating the state stays allowed — the guard watches creation, it does not
  // forbid it.
  assert.equal(run(bare, 'Bash', { command: 'placet-research init' }), null);
  assert.equal(run(bare, 'Bash', { command: 'mkdir -p research' }), null);
  // What still holds: a path that spells the location (SQ-65), the harness
  // state directory (SQ-27), and accepting a statement, which is the
  // researcher's act whether or not there is state to accept into.
  for (const command of ['cat > research/canvas.md', 'git checkout HEAD -- research/']) {
    const out = run(bare, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  const harnessRead = run(bare, 'Bash', { command: 'cat ~/.claude/placet-research/abc/seal.key' });
  assert.equal(harnessRead && harnessRead.permissionDecision, 'deny');
  for (const command of ['placet-research accept 1.2', `node "${path.join(pluginRoot, 'bin', 'placet-research.js')}" accept 1.2`]) {
    const out = run(bare, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  assert.equal(run(bare, 'Bash', { command: `node "${path.join(pluginRoot, 'bin', 'placet-research.js')}" status` }), null);
});

// An empty state directory holds neither the canvas nor the decision log, so it
// is no state either (SQ-71). The bare name and the glob are let go; the
// spelled path is still judged, because that is the word that would create the
// state SQ-65 keeps watching.
test('SQ-71: an empty state directory is no state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-empty-'));
  fs.mkdirSync(path.join(root, 'research'));
  for (const command of ['rm -rf research', 'for d in */; do echo "$d"; done']) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
  const write = run(root, 'Bash', { command: 'cat > research/canvas.md' });
  assert.equal(write && write.permissionDecision, 'deny');
});

// The control for the narrowing above: the same rows still deny in a project
// that holds state, which is the rule SQ-71 narrowed and did not remove.
test('SQ-71: with research state the same rows still deny', () => {
  const root = makeProject();
  // SQ-106 made a loop whose body only reads read-only (`for d in */; do echo
  // "$d"; done` is allowed here now), so the loop row writes.
  for (const command of [
    'for d in */; do rm -r "$d"; done',
    'while true; do l=$(sysctl -n vm.loadavg); echo "$l"; sleep 30; done',
    'x=$(cat a); rm "$x"',
    'rm -rf resea[r]ch',
    // A `cd` the guard cannot follow still counts here: with state present the
    // words after it can land on it, which is what SQ-71 narrowed, not removed.
    'cd "$HOME/x" && docker stop x',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// SQ-76: a glob expands only onto files that exist, so where the state is
// absent a pattern cannot land on it at any depth. SQ-71 let the pattern go
// when it stood for the state directory itself, but a deeper one — the `find
// -path '*/20*/*'` of a mail-mirror count — still resolved its leading `*`
// onto `research` and denied the `du` beside it in a repo with no research
// state. The three mail-bridge lines are the rows below, with the scratchpad
// path shortened; the spelled path and the stateful control still deny.
test('SQ-76: without research state a pattern below the state directory is not the state', () => {
  const bare = makeBareProject();
  const S = '/private/tmp/claude-501/-Users-x-mail-bridge/0a1b/scratchpad';
  for (const command of [
    `S=${S}; head -3 $S/inbox_imap.log; for k in a b; do d=mirror/$k/history/inbox; [ -d $d ] && echo "$k: $(ls $d | grep -v '\\.md$' | head -1), $(find $d -name '*.md' -path '*/20*/*' | wc -l) Dateien" || echo "$k: kein Archiv"; done; .venv/bin/python --version`,
    `S=${S}; grep -c "Eingangsarchiv 20" $S/inbox_kit.log; tail -1 $S/inbox_kit.log; cd ${bare} && find mirror/history/inbox -name '*.md' -path '*/20*/*' | wc -l; du -sh mirror/history/inbox mirror/*/history/inbox`,
    `cd ${bare} && find mirror/history/inbox -name '*.md' -path '*/20*/*' | wc -l && ls mirror/history/inbox | head -1 && du -sh mirror/history/inbox mirror/a/history/inbox`,
    'rm -rf */20*/*',
  ]) {
    assert.equal(run(bare, 'Bash', { command }), null, command);
  }
  // A pattern that can stand for a state file is still judged: a line that
  // first creates the state with a bare name would have the glob land on it.
  for (const command of [
    'cat > research/canvas.md',
    'cp x.md research/canvas.md',
    'git checkout HEAD -- research && cp x.md research/canva?.md',
    'git checkout HEAD -- research && sed -i s/a/b/ */canvas.md',
    'rm -rf research/*',
  ]) {
    const out = run(bare, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-empty-'));
  fs.mkdirSync(path.join(empty, 'research'));
  assert.equal(run(empty, 'Bash', { command: "find . -path '*/20*/*' | wc -l && du -sh research" }), null);
  const root = makeProject();
  for (const command of ["find m -path '*/20*/*' | wc -l && du -sh m", 'rm -rf research/*', 'rm -rf */20*/*']) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

test('SQ-65: with the state directory there the same words still deny', () => {
  const root = makeProject();
  for (const command of [
    'python3 x.py research',
    'rm -rf research',
    'ln -s research r',
    'git checkout HEAD -- research',
    'cd research && rm -rf notes.md',
    // A pattern is not a name the shell fails to find: the glob expands onto
    // the state directory that is right there. SQ-54 keeps this true by
    // compiling the class before it calls a word a pattern at all.
    'rm -rf resea[r]ch',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// SQ-75: bash expands braces before anything else, so `rm -rf {research,tmp}`
// removes the state directory. The lexer split the word on its braces and never
// saw `research`. Every expansion is now judged; a quoted or escaped brace does
// not expand and is judged as the name it spells.
test('SQ-75: a brace expansion is judged on every word it expands to', () => {
  const root = makeProject();
  for (const command of [
    'cp a.md research/canvas.md',
    'rm -rf {research,tmp}',
    'cp a.md {research,x}/canvas.md',
    'cp a.md rese{arch,x}/canvas.md',
    'cp a.md research/{canvas,x}.md',
    'sed -i s/a/b/ {research,x}/canvas.md',
    'cp a.md rese{a..c}rch/canvas.md',
    'for n in research tmp; do rm -rf $n; done',
    'for n in {research,tmp}; do rm -rf $n; done',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  for (const command of [
    "cp a.md '{research,x}'/canvas.md",
    'cp a.md \\{research,x\\}/canvas.md',
    'cat {research,x}/canvas.md',
    'find . -name x -exec grep y {} +',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
  // Too many words to compute is a word the guard cannot judge.
  const huge = run(root, 'Bash', { command: `cp a.md ${'{a,b}'.repeat(10)}` });
  assert.equal(huge && huge.permissionDecision, 'deny');
});

// SQ-75: in a vault whose `research/` is a notes folder, moving a note and a
// loop over literal names were denied. A word below the state directory now
// lands on the state only if the component where the state files stand can be
// one of them; a loop over literal words is judged once per value.
test('SQ-75: without research state a word below the state directory is judged on the state file position', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-vault-'));
  fs.mkdirSync(path.join(vault, 'research'));
  fs.writeFileSync(path.join(vault, 'research', 'a.md'), 'note');
  const B = 'for n in sichtbarkeit lab-ai; do echo "$n: $(ls -d {areas,projects,research,appdev}/$n{.md,} 2>/dev/null)"; done';
  for (const command of [
    'git mv research/a.md research/b.md',
    'mv research/x.md projects/x.md',
    'for n in a b; do ls -d research/$n; done',
    B,
    'cp x.md "$d/research/x.md"',
  ]) {
    assert.equal(run(vault, 'Bash', { command }), null, command);
  }
  const bare = makeBareProject();
  assert.equal(run(bare, 'Bash', { command: `cd ${vault}; ${B}` }), null);
  for (const [where, command] of [
    [bare, 'cat > research/canvas.md'],
    [bare, 'git checkout HEAD -- research/'],
    [bare, 'cp x.md "research/$f"'],
    [bare, 'git checkout HEAD -- research && cp x.md research/canva?.md'],
    [bare, 'rm -rf research/*'],
    [bare, 'cp x.md {research,x}/canvas.md'],
    [bare, 'cp x.md research/Canvas.md'],
    [bare, 'cp x.md research/sub/../canvas.md'],
    [bare, 'cp x.md "$d/research/sub/$f"'],
    [bare, 'cp -r src "$d/research"'],
    [vault, 'for f in canvas.md x; do cp a research/$f; done'],
    [vault, 'for n in $(ls); do cp x research/$n; done'],
    [vault, 'cat ~/.claude/{placet-research,x}/abc/seal.key'],
    [vault, 'placet-research accept 1.2'],
  ]) {
    const out = run(where, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// SQ-201 could not reproduce the reported false denial on 0.5.0: SQ-75
// already handles these literal paths. Keep the exact reports as regressions.
// Removing the absent-state exception would break the allow cases; ignoring
// state-file names or existing state would break the deny cases.
test('SQ-201: git mv into a notes-only research directory is allowed', (t) => {
  const root = makeNotesProject(t);
  assert.equal(run(root, 'Bash', { command: 'git mv areas/a.md research/a.md' }), null);
});

test('SQ-201: sed after cd with an exit fallback in a notes repo is allowed', (t) => {
  const root = makeNotesProject(t);
  assert.equal(run(path.dirname(root), 'Bash', {
    command: "cd repo || exit 1; sed -i '' s/x/y/ research/a.md",
  }), null);
});

test('SQ-201: creating canvas.md in a notes-only research directory is denied', (t) => {
  const root = makeNotesProject(t);
  const out = run(root, 'Bash', { command: 'echo x > research/canvas.md' });
  assert.equal(out && out.permissionDecision, 'deny');
});

test('SQ-201: git mv into a research directory holding canvas.md is denied', (t) => {
  const root = makeNotesProject(t);
  fs.writeFileSync(path.join(root, 'research', 'canvas.md'), canvasText);
  const out = run(root, 'Bash', { command: 'git mv areas/a.md research/a.md' });
  assert.equal(out && out.permissionDecision, 'deny');
});

// SQ-86: a loop body that rebinds its variable (`do f=…`, `export f=…`,
// `read f`, `printf -v f`, `declare f=…`) makes `$f` something other than the
// loop's literal words, so the loop values no longer count.
test('SQ-86: a loop variable rebound inside the loop is unknown again', () => {
  const bare = makeBareProject();
  for (const command of [
    'for f in x y; do f=canvas.md; cp a.md research/$f; done',
    'for f in x; do export f=canvas.md; cp a.md research/$f; done',
    'for f in x; do read f < n.txt; cp a.md research/$f; done',
    'for f in x; do printf -v f canvas.md; cp a.md research/$f; done',
    'for f in x; do declare f=canvas.md; cp a.md research/$f; done',
  ]) {
    const out = run(bare, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// SQ-106: a `for`, `while` or `until` loop is read-only when every command in
// it, the condition included, is read-only and nothing in it redirects into a
// file. The header's word list is not a write.
const SQ106_CLI = '/home/x/.claude/plugins/cache/eigenwise/placet-research/1.0/bin/placet-research.js';
test('SQ-106: a loop whose body only reads is allowed, with state and without', () => {
  for (const root of [makeProject(), makeBareProject()]) {
    for (const command of [
      'for f in research/*.md; do head -3 "$f"; done',
      'for k in a b c; do d=mirror/$k/history/inbox; [ -d $d ] && echo "$k" || echo none; done',
      'while read -r l; do echo "$l"; done < research/canvas.md',
      'for f in research/*.md; do for g in a b; do grep -c "$g" "$f"; done; done',
    ]) {
      assert.equal(run(root, 'Bash', { command }), null, `${root}: ${command}`);
    }
  }
});

test('SQ-106: a loop whose body writes keeps its denial', () => {
  const root = makeProject();
  for (const command of [
    'for f in research/*.md; do sed -i s/x/y/ "$f"; done',
    'for f in research/*.md; do cat "$f" > "$f.bak"; done',
    'for f in research/*.md; do grep x "$f" > /tmp/out; done',
    `for f in research/*.md; do node ${SQ106_CLI} accept 1.2; done`,
    'while true; do cp x research/canvas.md; done',
    'until false; do rm research/canvas.md; done',
    'for f in research/*.md; do for g in a b; do cp $g $f; done; done',
    'for f in research/*.md; do while read -r l; do echo "$l"; done < $f > research/out.md; done',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  const accept = run(root, 'Bash', { command: `for f in research/*.md; do node ${SQ106_CLI} accept 1.2; done` });
  assert.match(accept.permissionDecisionReason, /Accepting a statement is the researcher's act/);
  // `read` passes only as a loop condition: it is not on the read-only list.
  const read = run(root, 'Bash', { command: 'read -r l < research/canvas.md; cp x research/canvas.md' });
  assert.equal(read && read.permissionDecision, 'deny');
});

// SQ-29 finding F5, first face (verification/SQ-29/lex.txt L30, L26). A `[…]`
// run in a word made every word a glob, and a pattern the regex engine refused
// was answered "matches": an ordinary `node -e` whose JavaScript held an array
// literal named the state directory and was denied for the verb, not for
// anything it did. A bracket body that does not compile as a class is not a
// class — the word is the literal it spells, and a literal that names no
// location is none of the guard's business.
test('SQ-54: a bracketed literal in a word is a literal, not a glob onto the state', () => {
  const root = makeProject();
  for (const command of [
    `node -e 'const r=["SQ-28","SQ-30"];console.log(r)'`,
    `curl -d '[sidequest-route model=a effort=high]' http://127.0.0.1/`,
    `node -e 'const t={files:["a"],readonly:["b"]};console.log(t)'`,
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
  // The read-only verb that made the same word visible in the first place is
  // unaffected: it never refused anything.
  assert.equal(run(root, 'Bash', { command: 'grep -n "[Qa-]" README.md' }), null);
});

// SQ-29 finding F5, second face (verification/SQ-29/lex.txt L33,
// perimeter.txt M10). The comparison read the candidate as a pattern and the
// state's own component as the literal, so a project (or state root) whose name
// holds brackets never matched itself: the guard stopped recognising its own
// state directory and a removal inside it was allowed. The name spelled exactly
// is that name, whatever brackets are in it.
test('SQ-54: a state directory whose own name holds brackets is still the state', () => {
  const root = makeBracketProject();
  const removal = run(root, 'Bash', { command: 'rm research/canvas.md' });
  assert.equal(removal && removal.permissionDecision, 'deny');
  // Not a blanket refusal: the same project, read-only.
  assert.equal(run(root, 'Bash', { command: 'cat research/canvas.md' }), null);
  assert.equal(run(root, 'Bash', { command: 'sed -n 1,2p research/canvas.md' }), null);
});

// SQ-29 finding F5, the part neither face above fixes: a word that really is a
// pattern (`*` or `?`) whose class the engine refuses says nothing about what
// the shell expands it onto. Where there is a write to refuse, that unknown is
// denied rather than read as a match or a miss; under a read-only verb nothing
// is written, so the same word stays the name it spells.
test('SQ-54: a pattern the guard cannot compute is refused where there is a write', () => {
  const root = makeProject();
  for (const command of [
    `node -e 'a[Q-2]*'`,
    `cat notes.txt > 'a[Q-2]*'`,
    `rm 'a[Q-2]*'`,
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /cannot compute/, command);
  }
  // A read position writes nothing, so the word is read as the name it spells.
  assert.equal(run(root, 'Bash', { command: `grep -n 'a[Q-2]*' README.md` }), null);
  // And a class that does compile is still a glob onto the state (SQ-65).
  const glob = run(root, 'Bash', { command: 'rm -rf resea[r]ch' });
  assert.equal(glob && glob.permissionDecision, 'deny');
});

// SQ-29 finding "two rows that are neither" (verification/SQ-29/lex.txt L17,
// L19, L20; probes at b4a7066). `[N]>&M` and `[N]<&M` duplicate a descriptor:
// the word after `&` is an fd number or `-`, never a path. The lexer took `1`
// as the redirect's file target, so a pure read — `cd "$HOME/…" && cat … 2>&1`
// (L19) — was refused for redirecting into a relative path after a `cd` the
// guard cannot follow, and `cd research && cat canvas.md 2>&1` (L20, a read
// inside the state) for redirecting into the research state. There is no path
// in either, so neither refusal has anything to stand on.
test('SQ-60: a descriptor duplication is not a file redirection', () => {
  const root = makeProject();
  for (const command of [
    'cd "$HOME/no-such-dir-sq60" && cat notes.txt 2>&1',
    'cd "$HOME/no-such-dir-sq60" && grep -n x notes.txt 2>&1 | sort | uniq -c',
    'cd research && cat canvas.md 2>&1',
    'cd research && wc -l canvas.md 1>&2',
    'cd "$HOME/no-such-dir-sq60" && cat notes.txt 1>&-',
    'cd "$HOME/no-such-dir-sq60" && cat notes.txt 3<&0',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

// The other direction, bounded so the fix is not a hole: a `>&`/`&>` target that
// is not a digit or `-` is the file redirection bash makes of it, and a target
// the guard cannot read (a substitution in the fd position) stays one too.
test('SQ-60: a non-numeric `>&` target is still a file redirection', () => {
  const root = makeProject();
  for (const command of [
    'echo x >& research/canvas.md',
    'cd research && echo x >& canvas.md',
    'cd research && cat canvas.md &>notes.md',
    'cd "$HOME/no-such-dir-sq60" && echo x 2>&$fd',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
});

// L17 and L18 are the same pipeline with and without the `2>&1`: both carry a
// verb the guard does not read as read-only, so both stay denied — and now for
// that reason, not for a redirect that has no path. (The ticket read the L17
// refusal as the whole denial; it was the first refusal in the chain.)
test('SQ-60: the `2>&1` does not excuse a verb the guard otherwise holds', () => {
  const root = makeProject();
  for (const command of [
    'cd "$HOME/no-such-dir-sq60" && node bin/tool.js help 2>&1 | grep -n x',
    'cd "$HOME/no-such-dir-sq60" && node bin/tool.js help | grep -n x',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /`node` is not a read-only command/, command);
  }
});

// SQ-29 finding F6 (verification/SQ-29/lex.txt L1/L3, probes at b4a7066). The
// lexer skipped a heredoc body wholesale, which is right for a quoted delimiter
// and wrong for an unquoted one: bash expands `$(...)` and backticks in that
// body before the command runs, so the removal written inside it was never
// judged. The rest of the body is stdin data and is still not read as a command
// line — `rm research/canvas.md` on a line of its own removes nothing.
test('Bash: a substitution in an unquoted heredoc body is judged, a quoted one is data', () => {
  const root = makeProject();
  for (const [form, cmd] of [
    ['unquoted delimiter, command substitution', 'cat <<EOF\n$(rm research/canvas.md)\nEOF\n'],
    ['unquoted delimiter, backquote', 'cat <<EOF\n`rm research/canvas.md`\nEOF\n'],
    ['unquoted delimiter, substitution on a later line', 'cat <<EOF\nfirst line\n$(rm research/canvas.md)\nEOF\n'],
    ['unquoted delimiter, a body that never reaches it', 'cat <<EOF\n$(rm research/canvas.md)\n'],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
    assert.match(out.permissionDecisionReason, /read-only/, form);
  }
  for (const [form, cmd] of [
    ['quoted delimiter, the same body', "cat <<'EOF'\n$(rm research/canvas.md)\nEOF\n"],
    ['double-quoted delimiter, the same body', 'cat <<"EOF"\n$(rm research/canvas.md)\nEOF\n'],
    ['escaped delimiter, the same body', 'cat <<\\EOF\n$(rm research/canvas.md)\nEOF\n'],
    ['plain body text is data, not a command', 'cat <<EOF\nrm research/canvas.md\nEOF\n'],
    ['unquoted delimiter, a read-only substitution', 'cat <<EOF\n$(date)\nEOF\n'],
    ['unquoted body naming the state under a read verb', 'cat <<EOF\nsee research/canvas.md\nEOF\n'],
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, form);
  }
  // A body the scan cannot finish — an unclosed `$(`, or nesting past
  // MAX_SUBSTITUTION_DEPTH — is opaque: it is judged on the names it still
  // spells out, which denies it under a verb that is not read-only.
  const unread = run(root, 'Bash', { command: 'tee /dev/null <<EOF\n$(cat research/canvas.md\nEOF\n' });
  assert.equal(unread && unread.permissionDecision, 'deny');
  assert.match(unread.permissionDecisionReason, /read-only/);
});

// SQ-232. A heredoc body that is stdin data was not judged at all: a quoted body
// was skipped and an unquoted one only scanned for substitutions. `xargs rm
// <<'EOF'` with the canvas path in its body removed the canvas, while `printf …
// | xargs rm` and `xargs rm <<< …` were refused. The body is now judged the way
// an inert word of a read-only verb is, on the paths it spells: a line that only
// reads still passes, and a line with a command that is not read-only is refused.
test('SQ-232: a heredoc body that is stdin data is judged on the paths it spells', () => {
  const root = makeProject();
  const body = '\nresearch/canvas.md\nEOF';
  for (const [form, cmd] of [
    ['xargs, quoted delimiter', `xargs rm <<'EOF'${body}`],
    ['xargs, unquoted delimiter', `xargs rm <<EOF${body}`],
    ['cat piped into xargs', `cat <<'EOF' | xargs rm${body}`],
    ['a while-read loop', `while read f; do rm "$f"; done <<'EOF'${body}`],
    ['an external command given a state path', 'cockpit rueckmeldung <<\'EOF\'\n{"vault":"research/x.md"}\nEOF'],
    // An inline program may read its stdin, and `printf … | python3 -c …` was
    // already refused, so SQ-69's data receivers are held the same way.
    ['an inline program given the state path as data', "python3 -c 'print(1)' <<'EOF'\nrm research/canvas.md\nEOF"],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
    assert.match(out.permissionDecisionReason, /read-only/, form);
  }
  for (const [form, cmd] of [
    ['only reads', `cat <<'EOF'${body}`],
    ['a commit message naming the state', "git commit -F - <<'EOF'\nTighten research/canvas.md 1.2\nEOF"],
    ['a path outside the state', 'cockpit rueckmeldung <<\'EOF\'\n{"vault":"vault/research/x.md"}\nEOF'],
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, form);
  }
  // Without research state the body gets what an argument word gets, no more:
  // the heredoc and its printf form are judged alike.
  const bare = makeBareProject();
  for (const [receiver, data, expected] of [
    ['xargs rm', 'research/canvas.md', 'deny'],
    ['cockpit rueckmeldung', '{"vault":"research/x.md"}', null],
  ]) {
    const heredoc = run(bare, 'Bash', { command: `${receiver} <<'EOF'\n${data}\nEOF` });
    const piped = run(bare, 'Bash', { command: `printf '%s\\n' '${data}' | ${receiver}` });
    assert.equal(heredoc && heredoc.permissionDecision, expected, `heredoc: ${data}`);
    assert.equal(piped && piped.permissionDecision, expected, `printf: ${data}`);
  }
});

// SQ-233. SQ-232 judged a data body on the paths it spells, which left two ways
// through. xargs makes each item it reads an operand, so a bare `research` in
// the body removed the state directory under `xargs rm -r`, where the printf
// form was refused. And an unquoted body was read as typed rather than as bash
// expands it, so `$PWD/research/canvas.md` and `${d}earch/canvas.md` spelled no
// state path. On a line that runs xargs or parallel the body is now judged item
// by item, and an unquoted body also as the text bash hands the command. Under
// any other receiver the body keeps the path rule, so prose that mentions
// research still passes.
test('SQ-233: heredoc data that reaches the state through xargs or shell expansion is refused', () => {
  const root = makeProject();
  for (const [form, cmd] of [
    ['xargs, the state directory on a line of its own', "xargs rm -r <<'EOF'\nnotes\nresearch\nEOF"],
    ['xargs, the state directory beside another item', "xargs rm -r <<'EOF'\nnotes research\nEOF"],
    ['xargs, a variable in front of the state path', 'xargs rm <<EOF\n$PWD/research/canvas.md\nEOF'],
    ['xargs, an unknown variable completing the name', 'xargs rm <<EOF\n${d}earch/canvas.md\nEOF'],
    ['xargs, a variable the line assigned', 'd=res; xargs rm <<EOF\n${d}earch/canvas.md\nEOF'],
    ['xargs on a later command of the line', "cat <<'EOF' | xargs rm -r\nnotes\nresearch\nEOF"],
    ['parallel', "parallel rm -r <<'EOF'\nnotes\nresearch\nEOF"],
    // The forms the heredoc is held to, refused before this change.
    ['printf piped into xargs', "printf '%s\\n' notes research | xargs rm -r"],
    ['the argument word', 'rm -r research'],
    ['the argument word with the assigned variable', 'd=res; xargs rm ${d}earch/canvas.md'],
    ['a while-read loop', "while read f; do rm -r \"$f\"; done <<'EOF'\nresearch\nEOF"],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
    assert.match(out.permissionDecisionReason, /read-only/, form);
  }
  for (const [form, cmd] of [
    ['prose and a vault path for another receiver', 'cockpit rueckmeldung <<\'EOF\'\n{"titel":"Reddit research done","vault":"vault/research/x.md"}\nEOF'],
    ['prose beside a variable for another receiver', 'cockpit rueckmeldung <<EOF\n{"titel":"research for $USER","vault":null}\nEOF'],
    ['the state directory under a read', "cat <<'EOF'\nresearch\nEOF"],
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, form);
  }
  // Without research state an item gets what an argument word gets, no more:
  // the heredoc and its printf form are judged alike.
  const bare = makeBareProject();
  for (const [heredoc, piped, expected] of [
    ["xargs rm -r <<'EOF'\nnotes\nresearch\nEOF", "printf '%s\\n' notes research | xargs rm -r", null],
    ['xargs rm <<EOF\n$PWD/research/canvas.md\nEOF', 'printf \'%s\\n\' "$PWD/research/canvas.md" | xargs rm', 'deny'],
  ]) {
    const fromBody = run(bare, 'Bash', { command: heredoc });
    const fromPipe = run(bare, 'Bash', { command: piped });
    assert.equal(fromBody && fromBody.permissionDecision, expected, heredoc);
    assert.equal(fromPipe && fromPipe.permissionDecision, expected, piped);
  }
});

// SQ-234. SQ-233 cut a data body into items only on a line that runs xargs or
// parallel, and only at blanks and newlines. A `read` loop over `notes` and
// `research` on two lines removed the state directory, and so did `xargs -d ,`
// over `notes,research`, or the same data printed by printf. A `read` anywhere
// on the line now counts like xargs, the delimiter that `-d` or IFS sets ends an
// item too, and what printf and echo print is data. Each item is judged the way
// an argument word is.
test('SQ-234: data a read loop or xargs -d cuts into items is judged item by item', () => {
  const root = makeProject();
  for (const [form, cmd] of [
    ['a while-read loop', "while read f; do rm -r \"$f\"; done <<'EOF'\nnotes\nresearch\nEOF"],
    ['IFS= read -r', "while IFS= read -r f; do rm -r \"$f\"; done <<'EOF'\nnotes\nresearch\nEOF"],
    ['an until loop', "until ! read f; do rm -r \"$f\"; done <<'EOF'\nnotes\nresearch\nEOF"],
    ['cat piped into the loop', "cat <<'EOF' | while read f; do rm -r \"$f\"; done\nnotes\nresearch\nEOF"],
    ['the second field of a line', "while read a b; do rm -r \"$b\"; done <<'EOF'\nnotes research\nEOF"],
    ['printf piped into the loop', 'printf "notes research\\n" | while read a b; do rm -r "$b"; done'],
    ['xargs -d ,', "xargs -d , rm -r <<'EOF'\nnotes,research\nEOF"],
    ['xargs -d, attached', "xargs -d, rm -r <<'EOF'\nnotes,research\nEOF"],
    ['xargs --delimiter=,', "xargs --delimiter=, rm -r <<'EOF'\nnotes,research\nEOF"],
    ['printf piped into xargs -d ,', 'printf notes,research | xargs -d , rm -r'],
    // The same splitting under the other spellings it reads.
    ['a delimiter given as an escape', "xargs --delimiter '\\x2c' rm -r <<'EOF'\nnotes,research\nEOF"],
    ['read -d in a cluster', "while read -rd, f; do rm -r \"$f\"; done <<'EOF'\nnotes,research\nEOF"],
    ['IFS=,', "while IFS=, read a b; do rm -r \"$b\"; done <<'EOF'\nnotes,research\nEOF"],
    ['a delimiter the guard cannot read', "xargs -d \"$D\" rm -r <<'EOF'\nnotes,research\nEOF"],
    ['echo -e', 'echo -e "notes\\nresearch" | while read f; do rm -r "$f"; done'],
    ['a NUL printf prints for xargs -0', "printf 'notes\\0research' | xargs -0 rm -r"],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
    assert.match(out.permissionDecisionReason, /read-only/, form);
  }
  for (const [form, cmd] of [
    ['the loop only reads', "while read f; do echo \"$f\"; done <<'EOF'\nnotes\nresearch\nEOF"],
    ['no read loop and no xargs on the line', 'cockpit rueckmeldung <<\'EOF\'\n{"titel":"notes, research","vault":"vault/research/x.md"}\nEOF'],
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, form);
  }
  // Without research state an item gets what an argument word gets, no more, and
  // a delimiter the guard cannot read has nothing to land on.
  const bare = makeBareProject();
  for (const cmd of [
    "while read f; do rm -r \"$f\"; done <<'EOF'\nnotes\nresearch\nEOF",
    'printf notes,research | xargs -d , rm -r',
    "xargs -d \"$D\" rm -r <<'EOF'\nnotes,research\nEOF",
  ]) {
    assert.equal(run(bare, 'Bash', { command: cmd }), null, cmd);
  }
});

// SQ-67. SQ-55 reads a heredoc body as stdin data, which is right when the
// receiving command is `cat` and wrong when it is a shell or interpreter that
// reads its program from stdin: `bash <<EOF … EOF` runs the body, and quoting
// the delimiter does not change that. The body is now lexed as the script it is
// — the nesting an unquoted body's substitutions already get — and the receiving
// command is read as a launcher rather than a verb that refuses for not being
// read-only, so a body that only reads the state still reads.
test('SQ-67: a heredoc fed to a shell or interpreter is program text, not stdin data', () => {
  const root = makeProject();
  for (const [form, cmd] of [
    ['bash', 'bash <<EOF\nrm research/canvas.md\nEOF'],
    ['quoted delimiter behaves the same', "bash <<'EOF'\nrm research/canvas.md\nEOF"],
    ['bash -s', 'bash -s <<EOF\nrm research/canvas.md\nEOF'],
    ['explicit stdin `-`', 'bash - <<EOF\nrm research/canvas.md\nEOF'],
    ['sh', 'sh <<EOF\nrm research/canvas.md\nEOF'],
    ['zsh', 'zsh <<EOF\nrm research/canvas.md\nEOF'],
    ['dash', 'dash <<EOF\nrm research/canvas.md\nEOF'],
    ['a wrapper in front of the shell', 'env bash <<EOF\nrm research/canvas.md\nEOF'],
    ['the shell\'s own redirect still writes the state', 'bash > research/canvas.md <<EOF\ncat notes.md\nEOF'],
    ['node', 'node <<EOF\nrequire("fs").unlinkSync("research/canvas.md")\nEOF'],
    ['python3', 'python3 <<EOF\nimport os; os.remove("research/canvas.md")\nEOF'],
    ['perl', 'perl <<EOF\nunlink "research/canvas.md";\nEOF'],
    ['ruby', 'ruby <<EOF\nFile.delete("research/canvas.md")\nEOF'],
    ['the body names accept', 'bash <<EOF\nnode bin/placet-research.js accept 1.2\nEOF'],
    ['a substitution in the body', 'bash <<EOF\n$(rm research/canvas.md)\nEOF'],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
  }
  // The here-string and the pipe hand the state name to the receiving shell as
  // an operand word, so SQ-52's opaque-word rule already held both.
  for (const cmd of ["bash <<< 'rm research/canvas.md'", "echo 'rm research/canvas.md' | bash"]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', cmd);
  }
  // The body is judged as the script it is, so a body that only reads the state
  // reads: the receiving shell is a launcher, not a verb of its own.
  for (const cmd of [
    'bash <<EOF\ncat research/canvas.md\nEOF',
    'python3 <<EOF\nprint("hello")\nEOF',
    "sh -c 'ls research'",
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, cmd);
  }
  // SQ-55's control: with a data receiver the same text is body text and reads.
  assert.equal(run(root, 'Bash', { command: 'cat <<EOF\nrm research/canvas.md\nEOF\n' }), null);
  assert.equal(run(root, 'Bash', { command: "cat <<'EOF'\nrm research/canvas.md\nEOF\n" }), null);
});

// SQ-69. SQ-67 left one word unread: a flag that takes a value. The receiver was
// recognised as reading its program from stdin unless a script file operand
// stood in front of the heredoc — and a flag's value (`errexit`, `ignore`,
// `dev/null`, `fs`) is a bare word, so it was taken for that operand and the body
// was read as its stdin data. Telling a flag's value from a script file takes a
// per-interpreter table of value-taking flags that fails open for every flag it
// misses, so the operand is gone: a shell or interpreter that receives a heredoc
// reads its program from stdin unless an inline-program flag carries it.
test('SQ-69: a flag\'s value is not a script file operand, so the heredoc body is still the program', () => {
  const root = makeProject();
  for (const [form, cmd] of [
    ['shell -o', "bash -o errexit <<'EOF'\nrm research/canvas.md\nEOF"],
    ['shell --rcfile', "bash --rcfile /dev/null <<'EOF'\nrm research/canvas.md\nEOF"],
    ['python3 -W', "python3 -W ignore <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -X', "python3 -X utf8 <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['node -r', "node -r fs <<'EOF'\nrequire('fs').rmSync('research/canvas.md')\nEOF"],
    ['the cost: a script file operand proves nothing', 'bash script.sh <<EOF\nrm research/canvas.md\nEOF'],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
  }
  // The inline-program spellings still make the body stdin data: a bundle with
  // the program in the next word (`node -pe PROG`), a program attached to the
  // flag letter (`python3 -c'PROG'`), and a shell's `-c` not last in the bundle.
  // SQ-232: data that spells the state is refused under these receivers too, so
  // the body names it only through a pattern. Read as the program, `res*` counts
  // as the glob it may become and is denied; read as data, it is a string.
  for (const cmd of [
    "python3 -c'print(1)' <<'EOF'\nrm res*/canvas.md\nEOF",
    "python3 -c 'print(1)' <<'EOF'\nrm res*/canvas.md\nEOF",
    "perl -e'print 1' <<'EOF'\nrm res*/canvas.md\nEOF",
    "node -pe '1+1' <<'EOF'\nrm res*/canvas.md\nEOF",
    "perl -ne 'print' <<'EOF'\nrm res*/canvas.md\nEOF",
    "bash -ce 'ls research' <<'EOF'\nrm res*/canvas.md\nEOF",
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, cmd);
  }
  // A flag whose value the guard cannot see is not read as a program flag: the
  // body stays the program it may be.
  for (const cmd of [
    "python3 -Wdev <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF",
    "python3 -Xdev <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF",
    "python3 -m json.tool <<'EOF'\nrm research/canvas.md\nEOF",
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', cmd);
  }
  // The data receiver of SQ-55 and the read controls of SQ-67 are unchanged; the
  // `sh -c` body names the state through a pattern, as above (SQ-232).
  for (const cmd of [
    "cat <<'EOF'\nrm research/canvas.md\nEOF\n",
    "python3 <<EOF\nprint('hi')\nEOF\n",
    'bash <<EOF\ncat research/canvas.md\nEOF\n',
    "sh -c 'ls research' <<EOF\nrm res*/canvas.md\nEOF\n",
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, cmd);
  }
});

// SQ-70. SQ-69 gave every interpreter the same inline-program letters, and the
// letters are not shared: python3's `-E` ignores PYTHON* environment variables and
// it has no `-e`, ruby's `-E` takes an encoding, and node's `-c` is `--check`, a
// syntax check that runs nothing. Only perl carries a program on `-E`. A flag
// outside an interpreter's own row leaves the body judged as the program it may
// be, which is the fail-closed answer.
test('SQ-70: the inline-program letters belong to one interpreter, not to all of them', () => {
  const root = makeProject();
  // The reported rows: the flag is not this interpreter's program spelling, so the
  // heredoc body is the program it may be.
  for (const [form, cmd] of [
    ['python3 -E', "python3 -E <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -Es', "python3 -Es <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['ruby -E takes an encoding', "ruby -E UTF-8 <<'EOF'\nFile.delete('research/canvas.md')\nEOF"],
    ['ruby -E with the encoding attached', "ruby -EUTF-8 <<'EOF'\nFile.delete('research/canvas.md')\nEOF"],
    ['python3 -W (SQ-69, unchanged)', "python3 -W ignore <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['node -c is --check', "node -c <<'EOF'\nrequire('fs').rmSync('research/canvas.md')\nEOF"],
    ['ruby -w carries no program', "ruby -w <<'EOF'\nFile.delete('research/canvas.md')\nEOF"],
    // A value-taking letter swallows the `c` that follows it, so the cluster does
    // not carry a program: `python3 -Wc` is a warning filter, not `-W` plus `-c`.
    ['python3 -Wc is one flag, not a bundle', "python3 -Wc <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -Xc is one flag, not a bundle', "python3 -Xc <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    // Perl's `-i` takes a backup suffix, so `-ie` leaves the next word as a script
    // file name rather than a program.
    ['perl -ie is not a bundle', "perl -ie 'print 1' <<'EOF'\nunlink 'research/canvas.md';\nEOF"],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
  }
  // The spelling each interpreter really accepts still makes the body stdin data.
  // The body names the state through a pattern, as in SQ-69 (SQ-232).
  for (const [form, cmd] of [
    ['perl -E carries the program', "perl -E 'say 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['perl -e attached', "perl -e'print 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['perl -ne bundle', "perl -ne 'print' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['perl -lne bundle', "perl -lne 'print' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['perl -ce compiles the program from -e', "perl -ce 'print 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['python3 -c', "python3 -c 'print(1)' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['python3 -c attached', "python3 -c'print(1)' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['python3 -Ic, program in the next word', "python3 -Ic 'print(1)' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['node -pe', "node -pe 1 <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['node --eval', "node --eval 'console.log(1)' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['node --print', "node --print 1 <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['ruby -ne', "ruby -ne 'p 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['ruby -e attached', "ruby -e'puts 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['a shell cluster is unchanged', "bash -ce 'ls research' <<'EOF'\nrm res*/canvas.md\nEOF"],
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, form);
  }
  // SQ-70 rework. An interactive flag makes the interpreter read standard input as
  // code once the inline program has run, so an inline flag no longer makes the
  // body data. Probed on the binaries: `python3 -i -c 'pass'`, `python3 -ic 'pass'`
  // and `node -i -e 1` each ran the heredoc body.
  for (const [form, cmd] of [
    ['python3 -i -c', "python3 -i -c 'pass' <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -ic', "python3 -ic 'pass' <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -Ii -c', "python3 -Ii -c 'pass' <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -uic', "python3 -uic 'pass' <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -Ei has no program of its own', "python3 -Ei <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -iE', "python3 -iE <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['python3 -i alone', "python3 -i <<'EOF'\nimport os; os.remove('research/canvas.md')\nEOF"],
    ['node -i -e', "node -i -e 1 <<'EOF'\nrequire('fs').rmSync('research/canvas.md')\nEOF"],
    ['node -e then -i', "node -e 1 -i <<'EOF'\nrequire('fs').rmSync('research/canvas.md')\nEOF"],
    ['node --interactive -e', "node --interactive -e 1 <<'EOF'\nrequire('fs').rmSync('research/canvas.md')\nEOF"],
    ['node -p then -i', "node -p 1 -i <<'EOF'\nrequire('fs').rmSync('research/canvas.md')\nEOF"],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
  }
  // The other order follows the binary. Python takes the program out of `-c`'s
  // next word and stops reading options, so `python3 -c PROG -i` passes `-i` as an
  // argument the program never sees and the body stays data. Perl's and ruby's `-i`
  // is in-place editing and never reads stdin as code after `-e`.
  for (const [form, cmd] of [
    ['python3 -c then -i is the program\'s argument', "python3 -c 'pass' -i <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['perl -i after -e is in-place editing', "perl -e 'print 1' -i <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['perl -i before -e', "perl -i -e 'print 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['ruby -i before -e', "ruby -i -e 'puts 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
    ['ruby -ni bundle', "ruby -ni -e 'puts 1' <<'EOF'\nrm res*/canvas.md\nEOF"],
  ]) {
    assert.equal(run(root, 'Bash', { command: cmd }), null, form);
  }
});

// SQ-101. SQ-67 lexed every stdin program as bash, which is right for a shell and
// wrong for python, node, perl and ruby: their source was read as shell words, and
// a string like `'*/*.md'` became a glob onto the state. The body of an
// interpreter is now program text the guard cannot read, judged the way the same
// text is under `python3 -c` or `node -e`.
test('SQ-101: an interpreter\'s heredoc program is judged as program text, not as bash', () => {
  const bare = makeBareProject();
  const root = makeProject();
  // Lexed as bash, the template literal was a backquote substitution the guard
  // could not compute, and that denied the program where state is present.
  const lexedAsBash = "node - <<'EOF'\nconst x = `${1}`;\nconsole.log(x)\nEOF";
  for (const cmd of [
    "python3 - <<'EOF'\nimport os, tempfile\nd = tempfile.mkdtemp()\nos.mkdir(os.path.join(d, \"out\"))\nprint(d)\nEOF",
    "node - <<'EOF'\nconst r = require('fs').readdirSync('.');\nfor (const f of r) console.log(f > '')\nEOF",
    "perl <<'EOF'\nopen(my $f, '>', 'out.txt') or die; print $f 1;\nEOF",
    lexedAsBash,
  ]) {
    assert.equal(run(bare, 'Bash', { command: cmd }), null, cmd);
  }
  assert.equal(run(root, 'Bash', { command: lexedAsBash }), null);
  // What the body spells still counts: a state path, and a substitution bash
  // runs first under an unquoted delimiter.
  for (const [form, cmd] of [
    ['a state write', "python3 - <<'EOF'\nopen('research/canvas.md','w').write('x')\nEOF"],
    ['a substitution bash runs', "python3 <<EOF\nprint('$(rm research/canvas.md)')\nEOF"],
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', form);
  }
  // A shell as the reader keeps SQ-67: its body is lexed as the script it is.
  assert.equal(run(root, 'Bash', { command: 'bash <<EOF\ncat research/canvas.md\nEOF' }), null);
  const shell = run(root, 'Bash', { command: "bash <<'EOF'\nrm research/canvas.md\nEOF" });
  assert.equal(shell && shell.permissionDecision, 'deny');
});

test('Bash: a CLI-named path operand does not imply harness invocation', () => {
  const root = makeProject();
  const pathOperand = path.join(path.dirname(root), 'placet-research');
  assert.equal(run(root, 'Bash', { command: `mkdir -p ${pathOperand}` }), null);
});

test('Bash: accept is the researcher\'s act however it is spelled', () => {
  const root = makeProject();
  for (const cmd of [
    'node bin/placet-research.js accept 1.2',
    'node bin/placet-research.js "accept" 1.2',
    'S=accept; node bin/placet-research.js $S 1.2',
    'cp bin/placet-research.js rh.js && node rh.js accept 1.2',
    'npx placet-research accept 1.2',
    'xargs placet-research accept 1.2',
    'xargs -n 1 placet-research accept 1.2',
    'xargs --max-args 1 placet-research accept 1.2',
  ]) {
    const out = run(root, 'Bash', { command: cmd });
    assert.equal(out && out.permissionDecision, 'deny', cmd);
    assert.match(out.permissionDecisionReason, /researcher's act/, cmd);
    assert.match(out.permissionDecisionReason, /placet-research:accept/, cmd);
    // The recovery names what the accept needs: since 0.4.0 it is refused
    // without the researcher's explanation, so the example carries the flag.
    assert.match(out.permissionDecisionReason, /placet-research:accept <n\.m> --explained/, cmd);
  }
});

// The probe set from SQ-29 (verification/SQ-29/cli.txt B1–B9, B13–B14 and
// perimeter.txt M14–M15). The inference read three launcher shapes and nothing
// else, so `accept` reached the CLI in silence behind any other one. Two routes
// close that: a wrapper is followed to the command it launches, and a program
// text, which no lexer here can read, is judged by what it names. Each row
// carries the negative control that keeps the route from denying ordinary work.
const LAUNCHERS = [
  ['env', 'env node bin/placet-research.js accept 1.2', 'env FOO=1 npm test'],
  ['env with an option that takes a value', 'env -u FOO node bin/placet-research.js accept 1.2', 'env -u FOO npm test'],
  ['command', 'command node bin/placet-research.js accept 1.2', 'command npm test'],
  ['exec', 'exec node bin/placet-research.js accept 1.2', 'exec npm test'],
  ['nice', 'nice -n 10 node bin/placet-research.js accept 1.2', 'nice -n 10 npm test'],
  ['time', 'time node bin/placet-research.js accept 1.2', 'time npm test'],
  ['nohup', 'nohup node bin/placet-research.js accept 1.2', 'nohup npm test'],
  ['sudo', 'sudo node bin/placet-research.js accept 1.2', 'sudo npm test'],
  ['wrappers in front of each other', 'env exec nice node bin/placet-research.js accept 1.2', 'env exec nice npm test'],
  ['xargs with a runner in the command slot', 'printf x | xargs node bin/placet-research.js accept 1.2', 'printf x | xargs npm test'],
  ['xargs after --', 'printf x | xargs -- node bin/placet-research.js accept 1.2', 'printf x | xargs -- npm test'],
  ['find -exec', 'find . -maxdepth 0 -exec node bin/placet-research.js accept 1.2 \\;', 'find . -maxdepth 1 -exec grep -l stated {} \\;'],
  ['find -execdir', 'find . -maxdepth 0 -execdir placet-research accept 1.2 +', 'find . -maxdepth 1 -execdir grep -l stated {} +'],
];

const PROGRAM_TEXTS = [
  ['sh -c', 'sh -c \'node bin/placet-research.js accept 1.2\'', 'sh -c \'ls research\''],
  ['bash -c', 'bash -c "placet-research accept 1.2"', 'bash -c "git status"'],
  ['zsh -c', 'zsh -lc \'node bin/placet-research.js accept 1.2\'', 'zsh -lc \'npm test\''],
  ['eval', 'eval \'node bin/placet-research.js accept 1.2\'', 'eval \'npm test\''],
  ['node -e', 'node -e \'require("./bin/placet-research.js").main(["accept","1.2"])\'', 'node -e \'console.log(1)\''],
  ['node --eval', 'node --eval \'require("./bin/placet-research.js").main(["accept","1.2"])\'', 'node --eval \'console.log(1)\''],
  ['node --eval=', 'node --eval=\'require("./bin/placet-research.js").main(["accept","1.2"])\'', 'node --eval=\'console.log(1)\''],
  ['node -p', 'node -p \'require("./bin/placet-research.js").main(["accept","1.2"])\'', 'node -p \'1 + 1\''],
];

test('Bash: a wrapper is followed to the command it launches', () => {
  const root = makeProject();
  for (const [launcher, denied] of LAUNCHERS) {
    const out = run(root, 'Bash', { command: denied });
    assert.equal(out && out.permissionDecision, 'deny', `${launcher}: ${denied}`);
    assert.match(out.permissionDecisionReason, /researcher's act/, launcher);
  }
});

test('Bash: a program text that names the CLI or accept is a harness invocation', () => {
  const root = makeProject();
  for (const [form, denied] of PROGRAM_TEXTS) {
    const out = run(root, 'Bash', { command: denied });
    assert.equal(out && out.permissionDecision, 'deny', `${form}: ${denied}`);
    assert.match(out.permissionDecisionReason, /researcher's act/, form);
  }
  // The read-only form is no different: inside a program text the guard cannot
  // see which subcommand runs, and an unreadable subcommand is denied the way
  // an acceptance is, the same way `placet-research "$SUB"` is.
  const out = run(root, 'Bash', { command: 'sh -c \'placet-research status\'' });
  assert.equal(out && out.permissionDecision, 'deny');
});

// SQ-146. An unreadable subcommand is denied as strictly as `accept` is, since
// it may be one — but the guard never read `accept` in the line, so the text
// must not say that is what runs. It says what it knows: the subcommand is
// unreadable, and the denial is the strict one.
test('SQ-146: an unreadable subcommand is denied with its own text, not the accept text', () => {
  for (const root of [makeBareProject(), makeProject()]) {
    for (const command of [
      `node -p 'Buffer.from("x placet-research y").toString("base64")'`,
      'placet-research "$SUB"',
      'placet-research "$(cat x)"',
    ]) {
      const out = run(root, 'Bash', { command });
      assert.equal(out && out.permissionDecision, 'deny', command);
      assert.match(out.permissionDecisionReason, /a subcommand this guard cannot read/, command);
      assert.match(out.permissionDecisionReason, /denied the way `accept` is/, command);
      assert.doesNotMatch(out.permissionDecisionReason, /Accepting a statement is the researcher's act/, command);
      assert.doesNotMatch(out.permissionDecisionReason, /`placet-research accept` cannot be run from the shell/, command);
    }
  }
});

test('SQ-146: a literal accept subcommand still gets the accept text', () => {
  const root = makeProject();
  const out = run(root, 'Bash', { command: 'placet-research accept 1.1 --why x' });
  assert.equal(out && out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Accepting a statement is the researcher's act/);
  assert.doesNotMatch(out.permissionDecisionReason, /subcommand this guard cannot read/);
});

test('Bash: neither route denies ordinary work', () => {
  const root = makeProject();
  for (const [launcher, , allowed] of [...LAUNCHERS, ...PROGRAM_TEXTS]) {
    assert.equal(run(root, 'Bash', { command: allowed }), null, `${launcher}: ${allowed}`);
  }
  // SQ-32's contract: a bare word whose basename is a CLI name is an operand,
  // not an invocation, and the two routes above do not bring that inference back.
  assert.equal(run(root, 'Bash', { command: 'cd placet-research && npm test' }), null);
});

// SQ-116. install-cli writes the shim for the researcher's own terminal and
// touches no research state, so the model may run it in a project with state.
// `serve` keeps the name rule it always had: what the browser sends approvals
// to is the researcher's to start.
test('Bash: the model may install the terminal command and still cannot start the server', () => {
  const root = makeProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-bin-'));
  assert.equal(run(root, 'Bash', { command: `placet-research install-cli --dir ${dir}` }), null);
  const serve = run(root, 'Bash', { command: 'placet-research serve' });
  assert.equal(serve && serve.permissionDecision, 'deny');
  assert.match(serve.permissionDecisionReason, /not status, review, init, doctor, install-cli, title, agenda, session protocol, or log/);
});

// SQ-118. `title` writes the paper's own title line in the canvas frontmatter
// and touches nothing the guard judges, so the model may run it in a project
// with state. A title that happens to hold the words accept or serve is an
// argument, not a second command: the name rule is only consulted once
// something in the line was already refused.
test('Bash: the model may set the canvas title, even one that reads like a write verb', () => {
  const root = makeProject();
  assert.equal(run(root, 'Bash', { command: 'placet-research title "Working title"' }), null);
  assert.equal(run(root, 'Bash', { command: 'placet-research title "What we accept and serve"' }), null);
});

test('Bash: with title allowed, bare accept and serve stay denied', () => {
  const root = makeProject();
  const accept = run(root, 'Bash', { command: 'placet-research accept 1.1' });
  assert.equal(accept && accept.permissionDecision, 'deny');
  assert.match(accept.permissionDecisionReason, /Accepting a statement is the researcher's act/);
  const serve = run(root, 'Bash', { command: 'placet-research serve' });
  assert.equal(serve && serve.permissionDecision, 'deny');
  assert.match(serve.permissionDecisionReason, /read-only shell access/);
});

// 0.5 (plan Task 8). `agenda` and `session protocol` only print, so the model
// may run them; with `--out` they write a file, which is a write. The other new
// subcommands (`name`, `session start`, `merge-log`, `key`, `join`) are the
// person's and stay denied by the allowlist.
test('0.5 subcommands: agenda and session protocol read; every writing one is the person\'s', () => {
  const root = makeProject();
  const allow = ['placet-research agenda', 'placet-research session protocol', 'placet-research session protocol 12'];
  const deny = [
    'placet-research agenda --out notes.md',
    'placet-research agenda --out research/canvas.md',
    'placet-research session protocol --out p.md',
    'placet-research session protocol 12 --out p.md',
    'placet-research session start "Supervision"',
    'placet-research session',
    'placet-research name "A. Researcher"',
    'placet-research name',
    'placet-research merge-log',
    'placet-research merge-log --skip-decision 3',
    'placet-research key export --out k.seal.key',
    'placet-research join --key-file k.seal.key --name B',
  ];
  for (const command of allow) assert.notEqual((run(root, 'Bash', { command }) || {}).permissionDecision, 'deny', command);
  for (const command of deny) assert.equal((run(root, 'Bash', { command }) || {}).permissionDecision, 'deny', command);
  const merge = run(root, 'Bash', { command: 'placet-research merge-log' });
  assert.match(merge.permissionDecisionReason, /not status, review, init, doctor, install-cli, title, agenda, session protocol, or log/);
});

test('an exported key file is the key: no tool reads, copies or writes a *.seal.key path', () => {
  const root = makeProject();
  const file = path.join(os.tmpdir(), 'x', 'voice.seal.key');
  for (const [tool, input] of [
    ['Read', { file_path: file }],
    ['Write', { file_path: file, content: '00' }],
    ['Edit', { file_path: file, old_string: 'a', new_string: 'b' }],
    ['Bash', { command: `cat ${file}` }],
    ['Bash', { command: 'cat ~/Downloads/voice.seal.key' }],
    ['Bash', { command: 'cp voice.seal.key /tmp/y' }],
    ['Bash', { command: 'base64 < voice.seal.key' }],
  ]) assert.equal((run(root, tool, input) || {}).permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
  assert.equal(run(root, 'Bash', { command: 'cat notes.md' }), null);
});

// SQ-185: the spellings that reach a write through the two new allowances.
// The CLI's parseArgs gives a `--flag` the next word as its value unless that
// word starts with `--`, so a flag in front of the subcommand moves which word
// the CLI dispatches on; the guard reads the line the same way.
test('SQ-185: agenda and session protocol pass only as literal words without flags', () => {
  const root = makeProject();
  for (const command of [
    'placet-research agenda --out=notes.md',
    'placet-research agenda --out',
    'placet-research agenda "--out" notes.md',
    "placet-research agenda --o''ut notes.md",
    'placet-research agenda --{out,x} notes.md',
    'placet-research agenda -o notes.md',
    "placet-research agenda $'--out' research/canvas.md",
    "placet-research agenda $'--\\x6fut' notes.md",
    "placet-research agenda $'--\\157ut' notes.md",
    'placet-research agenda $"--out" notes.md',
    'placet-research agenda $FLAG notes.md',
    'placet-research agenda "$(cat flag.txt)" notes.md',
    'placet-research agenda > research/canvas.md',
    'placet-research agenda | tee research/canvas.md',
    'placet-research session protocol $N',
    'placet-research session protocol 12 13',
    'placet-research session protocol start "Occasion"',
    'placet-research session --x start protocol "Occasion"',
    'placet-research session protocol --x start',
    'placet-research session "$ACTION"',
    'echo --out research/canvas.md | xargs placet-research agenda',
    'echo 3 --out p.md | xargs placet-research session protocol',
    'echo accept 1.1 --explained y | xargs placet-research',
    'placet-research --x agenda session start "Occasion"',
    'placet-research --x status merge-log',
    'placet-research --x title name "B. Supervisor"',
    `node ${path.join(pluginRoot, 'bin', 'placet-research.js')} --x agenda join --key-file k --name B`,
  ]) assert.equal((run(root, 'Bash', { command }) || {}).permissionDecision, 'deny', command);
  // The flag that swallows `status` hands `accept` the dispatch: the accept
  // denial, not a read.
  const accept = run(root, 'Bash', { command: 'placet-research --x status accept 1.1 --explained y' });
  assert.match(accept.permissionDecisionReason, /Accepting a statement is the researcher's act/);
  for (const command of [
    "placet-research session protocol '#12'",
    'placet-research session protocol 12 # the second one',
    'placet-research agenda > notes.md',
    'placet-research agenda | head -20',
    'placet-research status --variant alpha',
  ]) assert.equal(run(root, 'Bash', { command }), null, command);
});

test('SQ-185: a key file is denied under every spelling the guard can read', (t) => {
  const root = makeProject();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-keys-'));
  const key = path.join(dir, 'voice.seal.key');
  fs.writeFileSync(key, '00');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'x');
  const deny = [
    ['Bash', { command: `cat ${dir}/VOICE.SEAL.KEY` }],
    ['Bash', { command: `cat ${dir}/*.seal.ke?` }],
    ['Bash', { command: `cat ${dir}/*` }],
    ['Bash', { command: `cd ${dir} && cat voice.seal.k[e]y` }],
    ['Bash', { command: `cat "$D/voice.seal.key"` }],
    ['Bash', { command: 'cat ~/Downloads/voice.seal$E.key' }],
    ['Bash', { command: 'cat voice.seal.{key,x}' }],
    ['Bash', { command: "cat $'voice.seal\\x2ekey'" }],
    ['Bash', { command: 'placet-research agenda > k.seal.key' }],
    ['Bash', { command: 'placet-research key export --out=k.seal.key' }],
    ['Bash', { command: `node -e 'console.log(require("fs").readFileSync("voice.seal.key","utf8"))'` }],
    ['Bash', { command: "python3 <<'EOF'\nprint(open('voice.seal.key').read())\nEOF" }],
    ['Bash', { command: 'ln -s ~/Downloads/voice.seal.key k.txt && cat k.txt' }],
    ['Read', { file_path: `${dir}/Voice.Seal.Key` }],
    ['Grep', { pattern: '.', path: dir, glob: '*.seal.key' }],
    ['Glob', { pattern: '**/*.seal.key' }],
    ['NotebookEdit', { notebook_path: key, new_source: 'x' }],
    ['SomeMcpTool', { destination: key }],
  ];
  for (const [tool, input] of deny) {
    const out = run(root, tool, input);
    assert.equal(out && out.permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
    assert.match(out.permissionDecisionReason, /\.seal\.key|harness state directory|read-only shell access/, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input] of [
    ['Bash', { command: `cat ${dir}/notes.md` }],
    ['Bash', { command: `cat ${dir}/*.md` }],
    ['Bash', { command: 'cat seal.key.txt' }],
    ['Read', { file_path: path.join(dir, 'notes.md') }],
    ['Grep', { pattern: 'seal.key', path: root }],
    ['Edit', { file_path: path.join(root, 'README.md'), old_string: 'a', new_string: 'run placet-research key export --out k.seal.key' }],
  ]) assert.equal(run(root, tool, input), null, `${tool} ${JSON.stringify(input)}`);
  // A link whose own name says nothing still lands on the key.
  const link = path.join(dir, 'k.txt');
  if (!canSymlink(dir)) return t.skip('this filesystem cannot make symlinks');
  fs.symlinkSync(key, link);
  for (const [tool, input] of [
    ['Read', { file_path: link }],
    ['Bash', { command: `cat ${link}` }],
  ]) assert.equal((run(root, tool, input) || {}).permissionDecision, 'deny', `${tool} ${JSON.stringify(input)}`);
});

// SQ-199: the 0.5.0 replay denied five benign commands in projects without
// research state, each because a glob's last component matched more than
// MAX_GLOB_MATCHES (4096) files and the count alone stood for a key. The last
// component's matches are now judged by name; only a directory component that
// fans out that far still counts as reaching a key.
test('SQ-199: a glob over many ordinary files is not a key file', () => {
  const bare = makeBareProject();
  const logs = path.join(bare, 'sent', '2026-09');
  fs.mkdirSync(logs, { recursive: true });
  for (let i = 0; i <= 4096; i += 1) fs.writeFileSync(path.join(logs, `binlog.${i}.md`), '');
  fs.writeFileSync(path.join(bare, 'SKILL.md'), 'x');
  for (const command of [
    'for m in pypdf zipfile; do python3 -c "import $m" 2>/dev/null && echo "DA: $m" || echo "--: $m"; done; ls -t sent/2026-09/*.md | head -3',
    'cid=$(comm -12 a.txt b.txt | head -1); echo "$cid"; grep -l -F "$cid" sent/*/*.md | head',
    'f=$(ls sent/*/*.md | tail -1) && echo "=== $f" && sed -n \'1,25p\' "$f"',
    "ls -t sent/2026-09 | head -3; ls sent/2026-09 | grep -c '^binlog\\.'; du -ch sent/2026-09/binlog.* | tail -1",
    'grep -n -i "lösch\\|delete" SKILL.md | head; grep -l "^reason: thread" sent/*/*.md | wc -l',
  ]) assert.equal(run(bare, 'Bash', { command }), null, command);
  // A key among those files is still found by its name, not by the count.
  fs.writeFileSync(path.join(logs, 'binlog.seal.key'), '00');
  const found = run(bare, 'Bash', { command: 'du -ch sent/2026-09/binlog.* | tail -1' });
  assert.equal(found && found.permissionDecision, 'deny');
  assert.match(found.permissionDecisionReason, /\.seal\.key/);
  // A directory component that fans out past the bound still counts as one.
  const fan = path.join(bare, 'fan');
  for (let i = 0; i <= 4096; i += 1) fs.mkdirSync(path.join(fan, `d${i}`), { recursive: true });
  assert.equal((run(bare, 'Bash', { command: 'cat fan/*/*' }) || {}).permissionDecision, 'deny');
});

test('Write: adding a title to the frontmatter stays the researcher\'s', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  const added = run(root, 'Write', {
    file_path: file,
    content: canvasText.replace('project: voice-uptake', 'project: voice-uptake\ntitle: "What we accept and serve"'),
  });
  assert.equal(added.permissionDecision, 'deny');
  assert.match(added.permissionDecisionReason, /Adding the frontmatter key "title"/);
});

// US-2 P4. The session server takes approvals from the browser, so only the
// researcher starts it: `placet-research serve` and the server script, on
// either route, with or without research state in the project.
test('Bash: the model cannot start the session server', () => {
  for (const root of [makeProject(), makeBareProject()]) {
    for (const command of [
      'placet-research serve',
      'nohup placet-research serve &',
      'node plugins/placet-research/bin/canvas-serve.js',
      'env node bin/canvas-serve.js --no-open',
      'sh -c "node plugins/placet-research/bin/canvas-serve.js"',
      'sh -c "node ./canvas-serve.js"',
      'node -e \'require("./bin/canvas-serve")\'',
    ]) {
      const out = run(root, 'Bash', { command });
      assert.equal(out && out.permissionDecision, 'deny', command);
    }
    const direct = run(root, 'Bash', { command: 'node plugins/placet-research/bin/canvas-serve.js' });
    assert.match(direct.permissionDecisionReason, /starts the session server/);
    // Reading the server's source is not starting it.
    assert.equal(run(root, 'Bash', { command: 'grep -n serve plugins/placet-research/bin/canvas-serve.js' }), null);
  }
});

// SQ-99 (P6 F2). Unlisted wrappers, other interpreters' inline programs,
// terminal launchers and quote-split names reached `accept` and `serve`. In a
// project with state, a line naming the CLI with either verb, or naming
// canvas-serve, is refused unless every command in it is read-only.
const SQ99_CLI = '/home/x/.claude/plugins/cache/eigenwise/placet-research/1.0/bin/placet-research.js';
const SQ99_SPLIT = "/home/x/.claude/plugins/cache/eigenwise/placet-resea''rch/1.0/bin/placet-resea''rch.js";
const SQ99_FORMS = (verb) => [
  `timeout 600 node ${SQ99_CLI} ${verb}`,
  `caffeinate -i node ${SQ99_CLI} ${verb}`,
  `script -q /dev/null node ${SQ99_CLI} ${verb}`,
  `arch -arm64 node ${SQ99_CLI} ${verb}`,
  `stdbuf -o0 node ${SQ99_CLI} ${verb}`,
  `watch -n 999 node ${SQ99_CLI} ${verb}`,
  `flock /tmp/l node ${SQ99_CLI} ${verb}`,
  `doas node ${SQ99_CLI} ${verb}`,
  `setsid node ${SQ99_CLI} ${verb}`,
  `python3 -c "import subprocess; subprocess.run(['node','${SQ99_CLI}','${verb.split(' ').join("','")}'])"`,
  `perl -e "system(q{node ${SQ99_CLI} ${verb}})"`,
  `osascript -e "do shell script \\"node ${SQ99_CLI} ${verb}\\""`,
  `bash -c "node ${SQ99_SPLIT} ${verb.replace(/^accept/, "acc''ept")}"`,
  `cmux workspace create --cwd /tmp --name x --command "node ${SQ99_CLI} ${verb}"`,
  `cmux send --surface surface:2 "node ${SQ99_CLI} ${verb}"`,
  `tmux new -d "node ${SQ99_CLI} ${verb}"`,
  `screen -dm node ${SQ99_CLI} ${verb}`,
  `ln -s ${SQ99_CLI} /tmp/rh.js && node /tmp/rh.js ${verb}`,
  `python3 <<'EOF'\nimport subprocess; subprocess.run(['node', '${SQ99_CLI}', '${verb.split(' ')[0]}'])\nEOF`,
];

test('SQ-99: a line naming the CLI with accept or serve is denied whatever wraps it', () => {
  const root = makeProject();
  for (const command of [...SQ99_FORMS('serve --no-open'), 'bash -c "placet-resea\'\'rch serve"']) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /session server/, command);
  }
  for (const command of SQ99_FORMS('accept 1.2')) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /Accepting a statement is the researcher's act/, command);
  }
  const server = run(root, 'Bash', { command: 'caffeinate -i node plugins/placet-research/bin/canvas-serve.js' });
  assert.equal(server && server.permissionDecision, 'deny');
});

test('SQ-99: reading the plugin and wrapping unrelated commands stay allowed', () => {
  const root = makeProject();
  for (const command of [
    'grep -n accept plugins/placet-research/bin/placet-research.js',
    'grep "placet-research accept" README.md',
    'grep -rn serve plugins/placet-research/bin/canvas-serve.js | head -5',
    'git commit -m "placet-research serve: document the token"',
    'caffeinate -i make test',
    'timeout 5 node x.js',
    'cd plugins/placet-research && node --test test/serve.test.js',
    'placet-research status',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

test('SQ-99: without research state the name rule does not engage', () => {
  const root = makeBareProject();
  for (const command of [`caffeinate -i node ${SQ99_CLI} accept 1.2`, `tmux new -d "node ${SQ99_CLI} serve"`]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

// SQ-105. `node -e` reached the CLI through the opaque-program route in every
// project, while the same call from python's `-c`, perl's or ruby's `-e`, or a
// heredoc an interpreter reads as its program was caught only by SQ-99's
// backstop, which needs research state. A line can create the state and accept
// into it in one call, so an interpreter's program text is held to the
// named-write test without state too.
test('SQ-105: an interpreter program naming the CLI with accept or serve is denied without state', () => {
  const root = makeBareProject();
  for (const command of [
    `python3 -c "import subprocess; subprocess.run(['placet-research', 'accept', '1.2'])"`,
    `python3 -Ic "import os; os.system('node ${SQ99_CLI} accept 1.2')"`,
    `env FOO=1 python3 -c "import os; os.system('placet-research accept 1.2')"`,
    `perl -e 'system("placet-research", "accept", "1.2")'`,
    `ruby -e 'system("placet-research accept 1.2")'`,
    `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['placet-research', 'accept', '1.2'])\nEOF`,
    `python3 <<EOF\nimport subprocess\nsubprocess.run(['node', '${SQ99_CLI}', 'accept', '1.2'])\nEOF`,
    `node - <<'EOF'\nrequire('child_process').execSync('placet-research accept 1.2');\nEOF`,
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /Accepting a statement is the researcher's act/, command);
  }
  const serve = run(root, 'Bash', { command: `python3 -c "import subprocess; subprocess.Popen(['node', 'bin/canvas-serve.js'])"` });
  assert.equal(serve && serve.permissionDecision, 'deny');
  assert.match(serve.permissionDecisionReason, /session server/);
});

test('SQ-105: a path segment or a lone accept in an interpreter program stays allowed', () => {
  const root = makeBareProject();
  for (const command of [
    `python3 -c "import os; os.chdir('/src/placet-research'); print(os.listdir('.'))"`,
    `python3 -c "print('accept')"`,
    `python3 - <<'EOF'\nimport json\nprint(json.load(open('plugins/placet-research/package.json')))\nEOF`,
    `node - <<'EOF'\nconsole.log(require('fs').readFileSync('plugins/placet-research/hooks/lib/accept.js', 'utf8').length);\nEOF`,
    `python3 -m pytest -k accept tests/placet-research`,
    `cat <<'EOF'\nplacet-research accept 1.2\nEOF`,
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

// SQ-61, cli.txt B10. The inference read the command word first, and an opaque
// one ended the walk there: the CLI name and `accept` behind it were never
// looked at, so the invocation ran unseen. An opaque word is read the way an
// unknown wrapper is — its command slot is walked, and what stands there is
// judged as the invocation it would have been. `$(echo node)` beside it is
// already denied since SQ-57 resolved it to the literal `node`.
test('SQ-61: an opaque command word does not hide the invocation behind it', () => {
  const root = makeProject();
  for (const command of [
    'R=$(cat x); $R bin/placet-research.js accept 1.2',
    'R=$(date +%s); $R bin/placet-research.js accept 1.2',
    '$R bin/placet-research.js accept 1.2',
    '$R --no-warnings bin/placet-research.js accept 1.2',
    'R=$(cat x); $R bin/placet-research.js log DECISION 1.2 --body x',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  // No CLI name and no `accept` behind the opaque word: there is nothing here
  // for the inference to find, and an unknown wrapper stays ordinary work.
  for (const command of [
    '$CMD --version',
    '$R echo hi',
    'R=$(date +%s); ls research',
    '$R npm test',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

// SQ-102 (SQ-97 shape 3). A variable's value is spliced into the command word
// unsplit, so the whole `git -C …/placet-research` read as one path whose last
// component is the CLI's name. Bash splits the unquoted value and runs git; the
// CLI's name is only the directory of `-C`. A value that does start the CLI
// keeps its denial, and so does SQ-61's opaque command word.
test('SQ-102: the CLI name as a directory in a variable\'s flag argument is not a harness call', () => {
  const allowed = [
    'G="git -C /home/u/src/placet-research"; $G status --short',
    'G="git -C /home/u/src/placet-research"; $G log -3',
    'G="git -C /home/u/src/placet-research"; $G add -A',
  ];
  const denied = [
    '$R bin/placet-research.js accept 1.2',
    'G="node bin/placet-research.js"; $G accept 1.2',
    'G="npx placet-research"; $G accept 1.2',
    'G="/opt/x/bin/placet-research.js accept"; $G 1.2',
    // A changed IFS decides how bash splits the value, so the guard does not
    // split it: with IFS=: the program is the whole path, the CLI.
    'IFS=:; G="/tmp/a b/placet-research.js"; $G accept 1.2',
    'export IFS=:; G="/tmp/a b/placet-research.js"; $G accept 1.2',
    "IFS=$'\\n'; G=\"/tmp/a b/placet-research.js\"; $G accept 1.2",
    '(IFS=:; G="/tmp/a b/placet-research.js"; $G accept 1.2)',
    // Only space, tab and newline split under the default IFS; a carriage
    // return stays inside the program name.
    'G="/tmp/a\rb/placet-research.js"; $G accept 1.2',
  ];
  // The probe corpus replays in a project without research state, where no
  // state path can deny for a reason of its own; a paper project must agree.
  for (const root of [makeBareProject(), makeProject()]) {
    for (const command of allowed) assert.equal(run(root, 'Bash', { command }), null, command);
    for (const command of denied) {
      const out = run(root, 'Bash', { command });
      assert.equal(out && out.permissionDecision, 'deny', command);
    }
  }
});

// SQ-61, the argument-position sibling (SQ-57's reading, closed here). An
// assignment whose value carries a substitution the guard cannot resolve makes
// the variable unknown, so `$x` is an unknown target where it stands: denied
// under a verb whose operand is the file it writes, exactly as SQ-68 denies the
// substitution written out in the argument, and still read under a read-only
// verb. The cost, stated in the release note: `$(mktemp)` is unknown too, so
// that one is denied inside a research project.
test('SQ-61: an unknown variable is a write target like the substitution written out', () => {
  const root = makeProject();
  for (const command of [
    'x=$(cat p.txt); rm "$x"',
    'x=$(cat p.txt); rm "$x.md"',
    'tmp=$(mktemp); rm "$tmp"',
    'x=$(cat p.txt); mv notes.md "$x"',
    'x=$(cat p.txt); touch "$x"',
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  for (const command of [
    'x=$(cat p.txt); cat "$x"',
    'x=$(pwd); ls "$x"',
    'x=$(cat p.txt); grep -c x "$x"',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

test('Bash: a command the lexer cannot read is denied only when it names the state', () => {
  const root = makeProject();
  const huge = `echo ${'a'.repeat(70000)}`;
  assert.equal(run(root, 'Bash', { command: huge }), null);
  const out = run(root, 'Bash', { command: `${huge} research/canvas.md` });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /could not read/);
});

// SQ-29 F7 (lex.txt L8): nine nested substitutions put the body — and the `rm`
// in it — past MAX_SUBSTITUTION_DEPTH, so nothing below the limit was ever
// lexed. A line whose nesting is that deep is unreadable in full, not a line
// the guard read and judged harmless.
test('Bash: nesting past the substitution depth limit makes the command unreadable', () => {
  const root = makeProject();
  const nest = (levels) => {
    let inner = 'rm research/canvas.md';
    for (let k = 0; k < levels; k += 1) inner = `echo $(${inner})`;
    return inner;
  };
  // Seven and eight levels stay within the limit, so the `rm` at the bottom is
  // a real command the guard reads and refuses as one.
  for (const levels of [7, 8]) {
    const out = run(root, 'Bash', { command: nest(levels) });
    assert.equal(out && out.permissionDecision, 'deny', `${levels} levels`);
    assert.match(out.permissionDecisionReason, /read-only/, `${levels} levels`);
  }
  const deep = run(root, 'Bash', { command: nest(9) });
  assert.equal(deep && deep.permissionDecision, 'deny');
  assert.match(deep.permissionDecisionReason, /could not read/);
  assert.match(deep.permissionDecisionReason, /8-deep/);
  // The rule is the same one an unreadable line already follows: it is refused
  // for naming the state, and left alone when it names nothing there.
  let benign = 'echo hi';
  for (let k = 0; k < 9; k += 1) benign = `echo $(${benign})`;
  assert.equal(run(root, 'Bash', { command: benign }), null);
});

// ---------- tool coverage ----------

// The probe set from SQ-21 (verification/SQ-21/path-and-tool.txt) reached the
// canvas under tool names the guard had never heard of. It cannot keep a list of
// the tools that can write a file, so a tool it does not recognise is judged by
// where its payload points — whatever the key is called, and however deep in the
// payload it sits.
const unrecognised = (file) => [
  ['MultiEdit', { file_path: file, edits: [{ old_string: ACCEPTED, new_string: '' }] }],
  ['mcp__filesystem__write_file', { path: file, content: FORGED }],
  ['create_file', { filename: file, contents: FORGED }],
  ['Scrivener', { target: file }],
  ['mcp__anvil__apply_patch', { patch: { hunks: [{ where: { document: file } }] } }],
  ['', { file_path: file }],
];

test('a tool the guard does not recognise may not reach the research state', () => {
  const root = makeProject();
  for (const [toolName, toolInput] of unrecognised(path.join(root, 'research', 'canvas.md'))) {
    const label = toolName || '(no tool name)';
    const out = run(root, toolName, toolInput);
    assert.equal(out && out.permissionDecision, 'deny', label);
    assert.match(out.permissionDecisionReason, /cannot judge/, label);
    assert.match(out.permissionDecisionReason, /canvas\.md/, label);
  }
  // decisions.md, the directory itself and anything in it are state as much as
  // the canvas is: what an unknown tool would do to them is equally unreadable.
  for (const target of [
    path.join(root, 'research', 'decisions.md'),
    path.join(root, 'research'),
    path.join(root, 'research', 'notes.md'),
  ]) {
    const out = run(root, 'mcp__filesystem__move_file', { source: target, destination: path.join(root, 'elsewhere') });
    assert.equal(out && out.permissionDecision, 'deny', target);
  }
});

test('an unrecognised tool is judged by where the path lands, not how it is spelled', (t) => {
  const root = makeProject();
  for (const spelling of ['research/canvas.md', './research/../research/canvas.md']) {
    const out = run(root, 'MultiEdit', { file_path: spelling, edits: [] });
    assert.equal(out && out.permissionDecision, 'deny', spelling);
  }
  if (!canSymlink(root)) return t.skip('this platform does not allow symlinks');
  const canvasFile = path.join(root, 'research', 'canvas.md');
  fs.symlinkSync(canvasFile, path.join(root, 'link.md'));
  fs.symlinkSync(path.join(root, 'research'), path.join(root, 'r'));
  fs.linkSync(canvasFile, path.join(root, 'alt.md'));
  for (const spelling of ['link.md', path.join('r', 'canvas.md'), 'alt.md']) {
    const out = run(root, 'mcp__filesystem__write_file', { path: path.join(root, spelling), content: FORGED });
    assert.equal(out && out.permissionDecision, 'deny', spelling);
    assert.match(out.permissionDecisionReason, /canvas\.md/, spelling);
  }
  return undefined;
});

// The other half of the acceptance: a default of deny must not make the guard a
// general write block. Everything here is either outside the state or a read,
// and none of it is the guard's business.
test('an unrecognised tool is left alone everywhere else', () => {
  const root = makeProject();
  const outside = path.join(root, 'manuscript.md');
  for (const [toolName, toolInput] of [
    ['MultiEdit', { file_path: outside, edits: [{ old_string: 'x', new_string: 'y [accepted]' }] }],
    ['mcp__filesystem__write_file', { path: outside, content: FORGED }],
    ['create_file', { filename: path.join(root, 'docs', 'research-notes.md'), contents: 'x' }],
    ['Scrivener', { note: 'see research/canvas.md for the accepted wording' }],
    ['TodoWrite', { todos: [{ content: 'Ask the researcher to accept 1.2', status: 'pending' }] }],
    ['WebFetch', { url: 'https://example.org/research/canvas.md', prompt: 'summarise it' }],
    ['Read', { file_path: path.join(root, 'research', 'canvas.md') }],
    ['Grep', { pattern: 'accepted', path: path.join(root, 'research') }],
    ['Glob', { pattern: 'research/*.md' }],
  ]) {
    assert.equal(run(root, toolName, toolInput), null, toolName);
  }
});

// A hook that never fires is a guard that never decides, so the matcher is the
// other half of the perimeter. It carries none: every tool reaches the guard,
// and which of them it can judge is decided in the guard alone.
test('every tool reaches the guard', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  for (const group of hooks.hooks.PreToolUse) {
    const matcher = Object.prototype.hasOwnProperty.call(group, 'matcher') ? group.matcher : null;
    assert.ok(
      matcher === null || matcher === '' || matcher === '*',
      `PreToolUse matcher ${JSON.stringify(matcher)} decides in config what belongs to the guard`,
    );
  }
});

test('canvasVerdict and bashVerdict are exported for reuse', () => {
  assert.equal(guard.canvasVerdict(canvasText, canvasText), null);
  assert.match(guard.canvasVerdict(canvasText, canvasText.replace('[stated, src: memo-03]', '[accepted, src: memo-03]')), /\[accepted\]/);
  assert.equal(guard.bashVerdict('wc -l research/canvas.md'), null);
  assert.match(guard.bashVerdict('rm research/canvas.md'), /read-only/);
});

// SQ-20, decided: the guard does not judge visibility. Wrapping a committed
// statement in an HTML comment (S10) or indenting it into a code block (S8)
// leaves the commitment intact — same element, question, marker, text, tags —
// so the set rule has nothing to object to, and it stays permitted. The review
// reports the divergence instead. Making the parser strip comments would close
// S10, leave S8 open, and put a statement the researcher commented out
// themselves outside the guard's reach; that trade was refused.
test('hiding a committed statement from the rendered view is permitted and reported, not denied', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  for (const [what, replacement] of [
    ['an HTML comment', `<!--\n\n${ACCEPTED}\n\n-->`],
    ['an indented code block', `    ${ACCEPTED}`],
  ]) {
    assert.equal(run(root, 'Edit', { file_path: file, old_string: ACCEPTED, new_string: replacement }), null, what);
  }
  // Same markers on one line are a different statement, because they become
  // part of its text — that one the set rule does catch.
  const inline = run(root, 'Edit', { file_path: file, old_string: ACCEPTED, new_string: `<!-- ${ACCEPTED} -->` });
  assert.equal(inline.permissionDecision, 'deny');
  assert.match(inline.permissionDecisionReason, /commitment in question 1\.1/);
});

// US-3/B: every canvas.md and decisions.md below the state directory is
// research state, judged as the main pair is. A variant canvas is written by
// the model as proposals; [accepted] never lands there, and its log is sealed
// by the harness alone.
function withVariant(root, name, text) {
  const dir = path.join(root, 'research', 'variants', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'canvas.md'), text);
  fs.writeFileSync(path.join(dir, 'decisions.md'), '# Decision log — voice-uptake · variant x\n');
  return dir;
}

test('US-3: [accepted] written into a variant canvas is denied, by Edit and by Write', () => {
  const root = makeProject();
  const dir = withVariant(root, 'x', canvasText);
  const file = path.join(dir, 'canvas.md');
  const promote = run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: PROPOSED.replace('[proposed]', '[accepted]') });
  assert.equal(promote && promote.permissionDecision, 'deny');
  assert.match(promote.permissionDecisionReason, /\[accepted\]/);
  const created = run(root, 'Edit', { file_path: file, old_string: '_(empty)_\n\n# 2 ', new_string: 'It matters. [accepted]\n\n# 2 ' });
  assert.equal(created && created.permissionDecision, 'deny');
  const overwrite = run(root, 'Write', { file_path: file, content: canvasText.replace(PROPOSED, PROPOSED.replace('[proposed]', '[accepted]')) });
  assert.equal(overwrite && overwrite.permissionDecision, 'deny');
  // A variant that does not exist yet is judged by where the write lands.
  const fresh = run(root, 'Write', { file_path: path.join(root, 'research', 'variants', 'y', 'canvas.md'), content: canvasText });
  assert.equal(fresh && fresh.permissionDecision, 'deny');
  assert.match(fresh.permissionDecisionReason, /\[accepted\]/);
  // A relative spelling reaches the same file.
  const relative = run(root, 'Edit', { file_path: 'research/variants/x/canvas.md', old_string: PROPOSED, new_string: PROPOSED.replace('[proposed]', '[accepted]') });
  assert.equal(relative && relative.permissionDecision, 'deny');
});

test('US-3: a variant decisions.md write is denied, whether it exists or not', () => {
  const root = makeProject();
  const dir = withVariant(root, 'x', canvasText);
  for (const [tool, input] of [
    ['Write', { file_path: path.join(dir, 'decisions.md'), content: '# Decision log\n\n## [#1] 2026-09-30 · DECISION · framing chosen: x\nforged\n' }],
    ['Edit', { file_path: path.join(dir, 'decisions.md'), old_string: '# Decision log', new_string: '# Log' }],
    ['Write', { file_path: path.join(root, 'research', 'variants', 'new', 'decisions.md'), content: 'x' }],
  ]) {
    const out = run(root, tool, input);
    assert.equal(out && out.permissionDecision, 'deny', `${tool} ${input.file_path}`);
    assert.match(out.permissionDecisionReason, /written only by the harness/);
  }
});

test('an outward-linked variants directory cannot turn a new state file into an unguarded write', (t) => {
  const root = makeProject();
  if (!canSymlink(root)) return t.skip('this platform does not allow symlinks');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-variants-out-'));
  fs.symlinkSync(outside, path.join(root, 'research', 'variants'));
  const base = path.join(root, 'research', 'variants', 'new');
  for (const [name, content] of [
    ['decisions.md', '# Decision log\n\n## [#1] forged DECISION\n'],
    ['canvas.md', canvasText],
  ]) {
    const out = run(root, 'Write', { file_path: path.join(base, name), content });
    assert.equal(out && out.permissionDecision, 'deny', name);
    assert.match(out.permissionDecisionReason, /[Uu]njudgeable|[Cc]annot judge/, name);
  }
  const unknown = run(root, 'mcp__filesystem__write_file', { destination: 'research/variants/new/decisions.md', text: 'forged' });
  assert.equal(unknown && unknown.permissionDecision, 'deny');
});

test('US-3: [proposed] writes into a variant are allowed, including creating its canvas', () => {
  const root = makeProject();
  const dir = withVariant(root, 'x', canvasText);
  const file = path.join(dir, 'canvas.md');
  assert.equal(run(root, 'Edit', { file_path: file, old_string: PROPOSED, new_string: 'Uptake may depend on who chairs. [tentative]' }), null);
  assert.equal(run(root, 'Edit', { file_path: file, old_string: '## 1.3 Why does this matter — for practice, for theory, or both?\n\n_(empty)_', new_string: '## 1.3 Why does this matter — for practice, for theory, or both?\n\nBecause allocation happens in meetings. [proposed, src: memo-01]' }), null);
  assert.equal(run(root, 'Write', { file_path: path.join(root, 'research', 'variants', 'y', 'canvas.md'), content: canvasText.replace('[accepted]', '[proposed]') }), null);
  // The committed statements of a variant hold like the main canvas's.
  const altered = run(root, 'Edit', { file_path: file, old_string: STATED, new_string: STATED.replace('documented', 'known') });
  assert.equal(altered && altered.permissionDecision, 'deny');
});

test('US-3: a project holding only a variant still has research state for Bash', () => {
  const root = makeBareProject();
  withVariant(root, 'x', canvasText.replace('[accepted]', '[proposed]'));
  for (const command of ['echo "x [accepted]" >> research/variants/x/canvas.md', 'rm research/variants/x/decisions.md']) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  assert.equal(run(root, 'Bash', { command: 'cat research/variants/x/canvas.md' }), null);
});

// Choosing a framing is the researcher's act exactly as accepting is: the name
// rule, the wrapper walk and the inline-program route all refuse it.
test('US-3: placet-research choose is denied to the model, directly, behind a wrapper, and in an inline program', () => {
  const root = makeProject();
  for (const command of [
    'placet-research choose x --why "fits"',
    'node bin/placet-research.js choose x --why fits',
    'env node bin/placet-research.js choose x',
    'nice -n 10 placet-research choose x',
    `caffeinate -i node ${SQ99_CLI} choose x --why fits`,
    `timeout 600 node ${SQ99_CLI} choose x`,
    'bash -c "placet-research choose x"',
    `bash -c "node ${SQ99_SPLIT} cho''ose x"`,
    'node -e \'require("./bin/placet-research.js").main(["choose","x"])\'',
    `python3 -c "import subprocess; subprocess.run(['placet-research', 'choose', 'x'])"`,
    `tmux new -d "node ${SQ99_CLI} choose x"`,
  ]) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /Choosing a framing is the researcher's act|researcher's act/, command);
  }
  const direct = run(root, 'Bash', { command: 'placet-research choose x --why fits' });
  assert.match(direct.permissionDecisionReason, /^Choosing a framing is the researcher's act/);
  // Both comparison commands are spelled as commands, so the prefix the CLI
  // actually takes is named in the text the researcher reads.
  assert.match(direct.permissionDecisionReason, /`placet-research review --variant <name>`/);
  // An inline program is held to the name rule without state too (SQ-105).
  const bare = makeBareProject();
  for (const command of [
    `python3 -c "import subprocess; subprocess.run(['placet-research', 'choose', 'x'])"`,
    `perl -e 'system("placet-research", "choose", "x")'`,
  ]) {
    const out = run(bare, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /^Choosing a framing is the researcher's act/, command);
  }
});

test('US-3: the word choose alone, and reading the variants, stay allowed', () => {
  const root = makeProject();
  withVariant(root, 'x', canvasText);
  for (const command of [
    'node -e \'console.log("choose")\'',
    `python3 -c "print('choose')"`,
    'grep -n choose plugins/placet-research/bin/placet-research.js',
    'placet-research status --variant x',
    'placet-research review --variant x',
    'placet-research log DISCOVERY 1.1 --body "x" --variant x',
    'placet-research init --variant y --lens "power"',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

// ---------- SQ-145: whole words and redirect targets are judged where they land ----------

// Rows 1-20 of SQ-145's two tables, one guard process each through run().
// `bare` is a checkout with no research state anywhere; `full` is a paper
// project whose canvas holds an [accepted] commitment. A cell marked
// case-dependent only holds where the volume folds case, since that is what
// makes `./Research` land on `./research`. SQ-145's rows 1 and 2 are ALLOW on
// every filesystem and never skip; the rest of the case-dependent cells skip
// with a message where the two names are different files.
const SQ145_ROWS = [
  { n: 1, name: 'a run spelling the state name inside a word is program text, not a path', command: "sed -i '' 's/Foo\\./Research/' notes.md", bare: 'ALLOW', full: 'ALLOW' },
  { n: 2, name: 'a longer run that only begins with the state name is program text too', command: "sed -i '' 's/Foo\\./Research Plan/' notes.md", bare: 'ALLOW', full: 'ALLOW' },
  { n: 3, name: 'the state directory spelled as a path is the state', command: "sed -i '' 's/Foo\\./research/' notes.md", bare: 'DENY', full: 'DENY' },
  { n: 4, name: 'a state-directory operand that lands on the state directory', command: "sed -i '' 's/a/b/' ./Research", bare: 'DENY', full: 'DENY', caseBlind: true },
  { n: 5, name: 'a bare state-directory operand in place of the phrase', command: "sed -i '' 's/a/b/' Research", bare: 'ALLOW', full: 'DENY', caseBlindFull: true },
  { n: 6, name: 'a state file under the state directory, spelled with a path', command: "sed -i '' 's/x/y/' ./Research/canvas.md", full: 'DENY', caseBlindFull: true },
  { n: 7, name: 'an in-place edit that rewrites a [proposed] marker', command: "sed -i '' 's/proposed/accepted/' Research/canvas.md", full: 'DENY', caseBlindFull: true },
  { n: 8, name: 'a redirect into the decision log', command: 'printf x >> Research/decisions.md', full: 'DENY', caseBlindFull: true },
  { n: 9, name: 'a copy onto the canvas', command: 'cp notes.md Research/canvas.md', full: 'DENY', caseBlindFull: true },
  { n: 10, name: 'reading the canvas', command: 'cat Research/canvas.md', full: 'ALLOW' },
  { n: 11, name: 'grepping the decision log', command: 'grep x Research/decisions.md', full: 'ALLOW' },
  { n: 12, name: 'a sed -n script that substitutes and then writes the canvas', command: "sed -n 's/\\[proposed\\]/[accepted]/;w research/canvas.md' copy.md", full: 'DENY' },
  { n: 13, name: 'a sed -n whose script writes the canvas', command: "sed -n 'w research/canvas.md' notes.md", bare: 'DENY', full: 'DENY' },
  { n: 14, name: 'a sed -n whose s command carries a w flag', command: "sed -n 's/x/y/w research/canvas.md' notes.md", full: 'DENY' },
  { n: 15, name: 'a sed -n -e script that writes the decision log', command: "sed -n -e 'w research/decisions.md' notes.md", full: 'DENY' },
  { n: 16, name: 'a sed -n writing the canvas through the state directory spelled in its case', command: "sed -n 'w Research/canvas.md' notes.md", bare: 'DENY', full: 'DENY', caseBlind: true },
  { n: 17, name: 'a sed -i whose s command carries a w flag into the decision log', command: "sed -i '' 's/a/b/w research/decisions.md' notes.md", full: 'DENY' },
  { n: 18, name: "the same w flag spelled in the state directory's case", command: "sed -i '' 's/a/b/w Research/decisions.md' notes.md", full: 'DENY', caseBlindFull: true },
  { n: 19, name: 'an address-range read stays a read', command: "sed -n '1,5p' research/canvas.md", bare: 'ALLOW', full: 'ALLOW' },
  { n: 20, name: 'a regex-address read stays a read', command: "sed -n '/Why/,/^$/p' research/canvas.md", bare: 'ALLOW', full: 'ALLOW' },
];

function bashVerdict(root, command) {
  const out = run(root, 'Bash', { command });
  if (!out) return 'ALLOW';
  assert.equal(out.permissionDecision, 'deny', `${command}: ${out.permissionDecisionReason}`);
  return 'DENY';
}

for (const row of SQ145_ROWS) {
  test(`SQ-145 row ${row.n}: ${row.name}`, (t) => {
    const full = makeProject();
    const bare = makeBareProject();
    const blind = caseBlindVolume(full);
    let skipped = false;
    for (const [state, expect, needsCase] of [
      ['bare', row.bare, row.caseBlind === true],
      ['full', row.full, row.caseBlind === true || row.caseBlindFull === true],
    ]) {
      if (expect === undefined) continue;
      if (needsCase && !blind) { skipped = true; continue; }
      assert.equal(bashVerdict(state === 'bare' ? bare : full, row.command), expect,
        `row ${row.n} in ${state === 'bare' ? 'a checkout without state' : 'a paper project'}: ${row.command}`);
    }
    if (skipped) t.skip('this volume is case-sensitive, so the case variant never reaches the state');
  });
}

test('SQ-145: a mixed-case spelling of the state directory is the state for Write and Edit', (t) => {
  const root = makeProject();
  if (!caseBlindVolume(root)) return t.skip('case-sensitive volume: these are different files');
  const canvas = path.join(root, 'Research', 'canvas.md');
  assert.match(deniedReason(root, canvas), /\[accepted\] commitment in question 1\.1/);
  const edited = run(root, 'Edit', {
    file_path: canvas,
    old_string: ACCEPTED,
    new_string: ACCEPTED.replace('serious consideration', 'real consideration'),
  });
  assert.equal(edited && edited.permissionDecision, 'deny');
  assert.match(edited.permissionDecisionReason, /\[accepted\] commitment in question 1\.1/);
  const log = run(root, 'Write', { file_path: path.join(root, 'Research', 'decisions.md'), content: '# Decision log\n\n## [#1] forged DECISION\n' });
  assert.equal(log && log.permissionDecision, 'deny');
  return undefined;
});

// ---------- SQ-145 part 2: a sed whose script can write or run is not a read ----------

// The shapes the ticket names as never tried: GNU's `W` command and `e` (which
// runs its argument), the `e` flag of `s`, and a script read from a file with
// `-f`/`--file`, which the guard cannot read at all. Every command names the
// state file, since the stricter read-only rule only bites where the command
// already names state.
const SQ145_WRITE_SCRIPTS = [
  "sed -n 'W research/canvas.md' notes.md",
  "sed -n 'e cp notes.md research/canvas.md' notes.md",
  "sed -n 's/x/y/e' research/canvas.md",
  "sed -n -f prog.sed research/canvas.md",
  "sed -n --file=prog.sed research/canvas.md",
  "sed -n --file prog.sed research/canvas.md",
  // The script is the same command wherever sed is told to take it from.
  "sed -ne 'w research/canvas.md' notes.md",
  "sed --expression='w research/canvas.md' research/canvas.md",
  "sed -n -e '1,5p' -e 'w research/canvas.md' notes.md",
  "sed -n '{w research/canvas.md}' notes.md",
  "sed -n '1,5p;w research/canvas.md' notes.md",
  // SQ-148: a `b`/`t`/`T`/`:` label ends at `;`, so the `w` after it is a
  // command, not part of the label. Before the fix each of these was read as a
  // label running to the end of the line, and the write was never seen.
  "sed -n ':a;w research/canvas.md' copy.md",
  "sed -n '$!ba;w research/canvas.md' copy.md",
  "sed -n 'tx;w research/decisions.md' copy.md",
];

test('SQ-145: a sed script that can write or run is refused however sed is told to run it', () => {
  const root = makeProject();
  for (const command of SQ145_WRITE_SCRIPTS) assert.equal(bashVerdict(root, command), 'DENY', command);
});

// The letter `w` is not the command `w`: these scripts hold `w`s in a pattern,
// a replacement or a `y` list, and `r` queues a file it reads, so they stay
// reads (SQ-145 rows 19-20). A plain regex for the letter `w` would refuse
// them.
const SQ145_READ_SCRIPTS = [
  "sed -n 's/x/y/g' research/canvas.md",
  "sed -n 's/w/W/g' research/canvas.md",
  "sed -n 'y/w/x/' research/canvas.md",
  "sed -n '/Why/p' research/canvas.md",
  "sed -n 'r research/canvas.md' notes.md",
  // SQ-148: the common label idiom, whose labels now end at `;` — the rest of
  // the line is parsed and holds no write.
  "sed -n ':a;N;$!ba;s/\\n/ /g;p' research/canvas.md",
];

test('SQ-145: a sed -n whose script cannot write stays a read', () => {
  const root = makeProject();
  for (const command of SQ145_READ_SCRIPTS) assert.equal(bashVerdict(root, command), 'ALLOW', command);
});

// `less` is a named reader, but `-o FILE`, `-O FILE` and `--log-file=FILE` copy
// what is viewed into FILE. Probed in a temp dir under a pty: they write when
// the input is a pipe and stdout a terminal, and write nothing when less gets a
// file operand or a piped stdout. Which shape the shell hands `less` is not the
// guard's to know, so the flags are refused the way `sort -o` is — while plain
// `less` over the canvas stays a read.
test('SQ-145: the less flags that log to a file are refused, a plain less is not', () => {
  const root = makeProject();
  for (const command of [
    'less -o log.txt research/canvas.md',
    'less -O log.txt research/canvas.md',
    'less --log-file=log.txt research/canvas.md',
  ]) assert.equal(bashVerdict(root, command), 'DENY', command);
  assert.equal(bashVerdict(root, 'less research/canvas.md'), 'ALLOW');
});

// ---------- SQ-203: the glossary is protected state ----------

// § Authorization and text binding: agents propose entries, only the
// researcher accepts them, and a [stated] or [accepted] entry is protected the
// way a canvas commitment is — protected against a rewrite, a downgrade, a
// rename, a shell command, a filesystem alias and a tool the guard does not
// know. Every construct in these fixtures is invented for this file.
const GLOSS_HEAD = '---\nglossary-schema: 1\nmanuscripts: paper.md\n---\n\n';

function glossEntry(id, fields = {}) {
  const f = {
    term: 'Speaking turn',
    definition: 'One member holding the floor until another begins.',
    origin: 'own-definition',
    distinctions: 'A working label; nothing links to it yet.',
    marker: '[proposed]',
    ...fields,
  };
  const lines = [`## ${id}`, '', `Term: ${f.term}`];
  if (f.aliases !== undefined) lines.push(`Aliases: ${f.aliases}`);
  lines.push(`Definition: ${f.definition}`, `Origin: ${f.origin}`, `Distinctions: ${f.distinctions}`);
  if (f.marker !== null) lines.push(f.marker);
  return lines.join('\n');
}

const GLOSS_STATED = glossEntry('speaking-turn', { marker: '[stated]' });
const GLOSS_ACCEPTED = glossEntry('handoff-lag', {
  term: 'Handoff lag',
  definition: 'The interval between a request being made and its next visible acknowledgement.',
  distinctions: 'Unlike [speaking turn](#speaking-turn), this is measured in time rather than counted.',
  marker: '[accepted]',
});
const GLOSS_PROPOSED = glossEntry('chair-style', {
  term: 'Chair style',
  definition: 'How the chair allocates turns when several people want the floor.',
});
const GLOSSARY = `${GLOSS_HEAD}${[GLOSS_STATED, GLOSS_ACCEPTED, GLOSS_PROPOSED].join('\n\n')}\n`;

function makeGlossaryProject() {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'research', 'glossary.md'), GLOSSARY);
  return root;
}

test('SQ-203: a committed glossary entry cannot be altered, detagged, relabelled or retitled', () => {
  const root = makeGlossaryProject();
  const file = path.join(root, 'research', 'glossary.md');
  const cases = [
    ['is altered', GLOSS_STATED, GLOSS_STATED.replace('holding the floor', 'holding the floor twice'), /\[stated\] glossary entry speaking-turn \(payload [0-9a-f]{8}\) was altered \(its term, aliases, definition, origin or distinctions changed\)/],
    ['loses its marker', GLOSS_STATED, GLOSS_STATED.replace('\n[stated]', ''), /\[stated\] glossary entry speaking-turn \(payload [0-9a-f]{8}\) lost its authorization marker/],
    ['is downgraded', GLOSS_ACCEPTED, GLOSS_ACCEPTED.replace('[accepted]', '[proposed]'), /\[accepted\] glossary entry handoff-lag \(payload [0-9a-f]{8}\) was relabelled \[accepted\] to \[proposed\]/],
    ['is relabelled upward', GLOSS_STATED, GLOSS_STATED.replace('[stated]', '[accepted]'), /was relabelled \[stated\] to \[accepted\]/],
    ['is retitled', GLOSS_ACCEPTED, GLOSS_ACCEPTED.replace('Handoff lag', 'Hand-off lag'), /was altered/],
    ['is relinked', GLOSS_ACCEPTED, GLOSS_ACCEPTED.replace('#speaking-turn', '#chair-style'), /was altered/],
  ];
  for (const [what, oldString, newString, why] of cases) {
    const out = run(root, 'Edit', { file_path: file, old_string: oldString, new_string: newString });
    assert.equal(out && out.permissionDecision, 'deny', what);
    assert.match(out.permissionDecisionReason, why, what);
    assert.match(out.permissionDecisionReason, /placet-research:glossary-accept/, what);
  }
});

test('SQ-203: removing or renaming a glossary entry is denied, because its id is a link target', () => {
  const root = makeGlossaryProject();
  const file = path.join(root, 'research', 'glossary.md');
  const removed = run(root, 'Write', { file_path: file, content: GLOSSARY.replace(`${GLOSS_PROPOSED}\n`, '') });
  assert.equal(removed.permissionDecision, 'deny');
  assert.match(removed.permissionDecisionReason, /Removing or renaming the glossary entry chair-style is not allowed/);
  const renamed = run(root, 'Write', { file_path: file, content: GLOSSARY.replace('## chair-style', '## chairing-style') });
  assert.equal(renamed.permissionDecision, 'deny');
  assert.match(renamed.permissionDecisionReason, /Removing or renaming the glossary entry chair-style is not allowed/);
});

test('SQ-203: the model may add a [proposed] or a [stated] entry, never an [accepted] one', () => {
  const root = makeGlossaryProject();
  const file = path.join(root, 'research', 'glossary.md');
  const add = (marker, id) => `${GLOSSARY}\n${glossEntry(id, { marker, term: `New label ${id}`, distinctions: 'A new entry with no links.' })}\n`;
  assert.equal(run(root, 'Write', { file_path: file, content: add('[proposed]', 'new-proposal') }), null);
  // Transcribing what the researcher just said is the canvas's rule too.
  assert.equal(run(root, 'Write', { file_path: file, content: add('[stated]', 'new-stated') }), null);
  const out = run(root, 'Write', { file_path: file, content: add('[accepted]', 'new-accepted') });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Only the researcher may write \[accepted\] \(glossary entry new-accepted\)/);
  assert.match(out.permissionDecisionReason, /placet-research:glossary-accept/);
});

test('SQ-203: promoting a proposal to a commitment is denied', () => {
  const root = makeGlossaryProject();
  const file = path.join(root, 'research', 'glossary.md');
  for (const marker of ['[stated]', '[accepted]']) {
    const out = run(root, 'Edit', { file_path: file, old_string: GLOSS_PROPOSED, new_string: GLOSS_PROPOSED.replace('[proposed]', marker) });
    assert.equal(out.permissionDecision, 'deny', marker);
    assert.match(out.permissionDecisionReason, new RegExp(`A \\[proposed\\] glossary entry cannot be promoted to \\[${marker.slice(1, -1)}\\] by the model \\(entry chair-style\\)`), marker);
  }
});

test('SQ-203: rewriting a proposal is allowed; retagging its marker and restructuring the file are not', () => {
  const root = makeGlossaryProject();
  const file = path.join(root, 'research', 'glossary.md');
  assert.equal(run(root, 'Edit', { file_path: file, old_string: GLOSS_PROPOSED, new_string: GLOSS_PROPOSED.replace('allocates turns', 'hands out turns') }), null);
  const tagged = run(root, 'Edit', { file_path: file, old_string: GLOSS_PROPOSED, new_string: GLOSS_PROPOSED.replace('[proposed]', '[proposed, src: memo-05]') });
  assert.equal(tagged.permissionDecision, 'deny');
  assert.match(tagged.permissionDecisionReason, /marker carries tags/);
  const dup = run(root, 'Write', { file_path: file, content: `${GLOSSARY}${GLOSS_PROPOSED}\n` });
  assert.equal(dup.permissionDecision, 'deny');
  assert.match(dup.permissionDecisionReason, /chair-style" has 2 headings/);
  const fm = run(root, 'Write', { file_path: file, content: GLOSSARY.replace('manuscripts: paper.md', 'manuscripts: other.md') });
  assert.equal(fm.permissionDecision, 'deny');
  assert.match(fm.permissionDecisionReason, /frontmatter key "manuscripts"/);
  assert.match(fm.permissionDecisionReason, /glossary-accept/);
});

test('SQ-203: writing the glossary for the first time follows the same rules', () => {
  const root = makeProject();
  const file = path.join(root, 'research', 'glossary.md');
  const solo = (marker) => `${GLOSS_HEAD}${glossEntry('solo', { marker, term: 'Solo label', distinctions: 'A definition with nothing to compare it to.' })}\n`;
  assert.equal(run(root, 'Write', { file_path: file, content: solo('[proposed]') }), null);
  assert.equal(run(root, 'Write', { file_path: file, content: solo('[stated]') }), null);
  const out = run(root, 'Write', { file_path: file, content: solo('[accepted]') });
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Only the researcher may write \[accepted\] \(glossary entry solo\)/);
});

test('SQ-203: a variant glossary and a symlinked name for the main one are the same state', () => {
  const root = makeGlossaryProject();
  const dir = path.join(root, 'research', 'variants', 'field-notes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'glossary.md'), GLOSSARY);
  const edited = run(root, 'Edit', {
    file_path: path.join(dir, 'glossary.md'),
    old_string: GLOSS_STATED,
    new_string: GLOSS_STATED.replace('holding the floor', 'holding the floor twice'),
  });
  assert.equal(edited && edited.permissionDecision, 'deny');
  assert.match(edited.permissionDecisionReason, /glossary entry speaking-turn/);
  // A variant glossary that does not exist yet is created under the same rule.
  const fresh = run(root, 'Write', {
    file_path: path.join(root, 'research', 'variants', 'second', 'glossary.md'),
    content: `${GLOSS_HEAD}${glossEntry('solo', { term: 'Solo label', distinctions: 'A fresh proposal.' })}\n`,
  });
  assert.equal(fresh, null);
  // A name that leads to the same file is the same file.
  const link = path.join(root, 'alias-glossary.md');
  fs.symlinkSync(path.join(root, 'research', 'glossary.md'), link);
  const viaLink = run(root, 'Edit', {
    file_path: link,
    old_string: GLOSS_ACCEPTED,
    new_string: GLOSS_ACCEPTED.replace('Handoff lag', 'Hand-off lag'),
  });
  assert.equal(viaLink && viaLink.permissionDecision, 'deny');
});

test('SQ-210: literal glossary show is read-only, without admitting acceptance or opaque subcommands', () => {
  const root = makeGlossaryProject();
  for (const command of [
    'node "/x/bin/placet-research.js" glossary show speaking-turn',
    'placet-research glossary show speaking-turn',
    'npx placet-research glossary show speaking-turn',
  ]) assert.equal(run(root, 'Bash', { command }), null, command);
  for (const command of [
    'placet-research glossary accept speaking-turn --hash 12345678 --explained "I accept this."',
    'placet-research glossary "$action" speaking-turn',
    'placet-research glossary --x accept show speaking-turn',
  ]) assert.equal(run(root, 'Bash', { command }).permissionDecision, 'deny', command);
});

test('SQ-203: the acceptance route is refused in the shell under every name it can be spelled', () => {
  const root = makeGlossaryProject();
  const commands = [
    'node "/x/bin/placet-research.js" glossary accept speaking-turn --explained "I accept this."',
    'placet-research glossary accept speaking-turn --explained "I accept this."',
    'npx placet-research glossary accept speaking-turn --explained "I accept this."',
    'env node "/x/bin/placet-research.js" glossary accept speaking-turn --explained "I accept this."',
    "node -e 'require(\"child_process\").execFileSync(\"placet-research\",[\"glossary\",\"accept\"])'",
    'printf "Chair style is settled. [accepted]\\n" >> research/glossary.md',
    'sed -i "s/\\[proposed\\]/[accepted]/" research/glossary.md',
    'cd research && printf "x [accepted]\\n" >> glossary.md',
    'echo "x [accepted]" >> research/variants/x/glossary.md',
  ];
  for (const command of commands) {
    const out = run(root, 'Bash', { command });
    assert.equal(out && out.permissionDecision, 'deny', command);
  }
  const first = run(root, 'Bash', { command: commands[0] });
  assert.match(first.permissionDecisionReason, /researcher's act/);
  assert.match(first.permissionDecisionReason, /glossary-accept/);
  for (const command of [
    'cat research/glossary.md',
    'grep -n "\\[accepted\\]" research/glossary.md',
    'git log --oneline -- research/glossary.md',
    'shasum research/glossary.md',
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

test('SQ-203: a tool the guard does not know is judged by the state path it names', () => {
  const root = makeGlossaryProject();
  const out = run(root, 'mcp__filesystem__write_file', { destination: 'research/glossary.md', text: 'forged [accepted]' });
  assert.equal(out && out.permissionDecision, 'deny');
});

// SQ-331: the hook and Bash share HOME; quoted tildes name a literal directory.
function tildeProject(t) {
  const home = makeBareProject();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'proj');
  fs.mkdirSync(path.join(root, 'research'), { recursive: true });
  fs.writeFileSync(path.join(root, 'research', 'canvas.md'), canvasText);
  fs.writeFileSync(path.join(root, 'research', 'decisions.md'), decisionsText);
  return { root, env: { HOME: home } };
}

for (const command of [
  'printf x >> ~/proj/research/decisions.md',
  'printf x >> ~/proj/research/glossary.md',
  'cp x ~/proj/research/canvas.md',
  "sed -i '' 's/x/y/' ~/proj/research/canvas.md",
  'rm -rf ~/proj/research',
  'cp x ~fixture/proj/research/canvas.md',
  'printf x >> ~fixture/proj/research/decisions.md',
  'printf x >> ~/"proj"/research/decisions.md',
  'printf x >> ~/proj/research/{decisions,canvas}.md',
]) {
  test('Bash tilde: denies state write ' + command, (t) => {
    const { root, env } = tildeProject(t);
    assert.equal(run(root, 'Bash', { command }, env)?.permissionDecision, 'deny', command);
  });
}

for (const command of [
  'cat ~/proj/research/canvas.md',
  'printf x >> ~/notes.txt',
  "printf x >> '~/proj/research/decisions.md'",
  'printf x >> "~/proj/research/decisions.md"',
  'printf x >> \\~/proj/research/decisions.md',
]) {
  test('Bash tilde: allows read or non-state write ' + command, (t) => {
    const { root, env } = tildeProject(t);
    assert.equal(run(root, 'Bash', { command }, env), null, command);
  });
}

for (const command of [
  "printf x >> '~/proj/research/decisions.md'",
  'printf x >> "~/proj/research/decisions.md"',
  'printf x >> \\~/proj/research/decisions.md',
]) {
  test('Bash tilde: denies literal tilde directory symlink into state ' + command, (t) => {
    const { root, env } = tildeProject(t);
    fs.symlinkSync(env.HOME, path.join(root, '~'));
    assert.equal(run(root, 'Bash', { command }, env)?.permissionDecision, 'deny', command);
  });
}

test('Bash tilde: denies bare home tilde when HOME is the state directory', (t) => {
  const { root } = tildeProject(t);
  assert.equal(run(root, 'Bash', { command: 'rm -rf ~' }, { HOME: path.join(root, 'research') })?.permissionDecision, 'deny');
});

// ---------- SQ-338: writes whose target is in a patch, archive or stash ----------

// `git stash pop`, `git apply`, `patch`, `tar -x` and `unzip` name no protected
// path on the command line: the files they write are listed in data the guard
// cannot read. Where research state exists they are refused, unless the form
// only lists or checks, or extracts into a directory that neither lies inside
// the state directory nor holds it.
const SQ338_DENIED = [
  'git stash pop',
  'git stash apply',
  'git stash apply stash@{1}',
  'git stash branch scratch',
  'git -C . stash pop',
  'git apply attack.patch',
  'git apply --index attack.patch',
  'patch -p1 < attack.patch',
  'patch -p1 -i attack.patch',
  'tar -xf attack.tar',
  'tar xf attack.tar',
  'tar xzvf attack.tgz',
  'tar -xzf attack.tgz',
  'tar -x -f attack.tar',
  'tar --extract -f attack.tar',
  'tar --get -f attack.tar',
  'bsdtar -xf attack.tar',
  'unzip attack.zip',
  'unzip -o attack.zip',
  'env tar -xf attack.tar',
  'sudo unzip attack.zip',
  'xargs -n1 tar -xf < archives.txt',
  "find . -name '*.zip' -exec unzip {} \;",
  'tar -xf attack.tar -C .',
  'tar -xf attack.tar -C out/..',
  'tar -xf attack.tar -C /',
  'tar -xf attack.tar --directory=.',
  'cd research && tar -xf ../attack.tar',
  'tar -xPf attack.tar -C out',
  'tar -xf attack.tar --absolute-paths -C out',
  'tar -xf attack.tar --absolute-names -C out',
  'unzip attack.zip -d .',
  'unzip -: attack.zip -d out',
  'unzip -d. attack.zip',
  'unzip attack.zip -d',
  'unzip -qd out attack.zip',
  'tar -xf attack.tar -C',
  'tar -xf attack.tar -C.',
  'tar -xf attack.tar --directory .',
  'gtar -xf attack.tar',
  'git -c core.quotepath=off stash pop',
  'git apply --check --apply attack.patch',
];

test('SQ-338: a write whose target hides in a patch, archive or stash is refused where state exists', () => {
  const root = makeProject();
  for (const command of SQ338_DENIED) {
    const out = run(root, 'Bash', { command });
    assert.equal(out?.permissionDecision, 'deny', command);
    if (!/^cd /.test(command)) assert.match(out.permissionDecisionReason, /read-only shell access/, command);
  }
});

test('SQ-338: the refusal names why the target cannot be judged', () => {
  const root = makeProject();
  assert.match(run(root, 'Bash', { command: 'git stash pop' }).permissionDecisionReason, /patch, archive or stash/);
  assert.match(run(root, 'Bash', { command: 'unzip attack.zip' }).permissionDecisionReason, /patch, archive or stash/);
});

const SQ338_ALLOWED = [
  'git stash list',
  'git stash show -p',
  'git apply --check attack.patch',
  'git apply --stat attack.patch',
  'patch --dry-run -p1 < attack.patch',
  'tar -tf attack.tar',
  'tar tvf attack.tar',
  'tar -czf notes.tgz notes',
  'tar -xOf attack.tar notes.md',
  'tar -xf attack.tar -C out',
  'tar -xzf attack.tgz --directory=vendor/lib',
  'unzip -l attack.zip',
  'unzip -t attack.zip',
  'unzip -p attack.zip notes.md',
  'unzip attack.zip -d vendor',
  'unzip -q attack.zip -d /tmp/sq338-out',
  'unzip -dvendor attack.zip',
  'tar -xf attack.tar -Cout',
  'tar -xf attack.tar --to-stdout',
  'tar --get -f attack.tar --directory out',
];

test('SQ-338: listing, checking and extracting clear of the state stay allowed', () => {
  const root = makeProject();
  for (const command of SQ338_ALLOWED) assert.equal(run(root, 'Bash', { command }), null, command);
});

test('SQ-338: the exported bashVerdict gives the hook\'s verdicts in-process', () => {
  const root = makeProject();
  for (const command of SQ338_DENIED) assert.match(guard.bashVerdict(command, root) || '', /read-only shell access/, command);
  for (const command of SQ338_ALLOWED) assert.equal(guard.bashVerdict(command, root), null, command);
});

test('SQ-338: a project without research state is not the guard\'s business', () => {
  const root = makeBareProject();
  for (const command of ['git stash pop', 'git apply attack.patch', 'patch -p1 < attack.patch', 'tar -xf attack.tar', 'unzip attack.zip']) {
    assert.equal(run(root, 'Bash', { command }), null, command);
  }
});

test('SQ-338: a project holding only a variant is guarded the same way', () => {
  const root = makeBareProject();
  fs.mkdirSync(path.join(root, 'research', 'variants', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'research', 'variants', 'alpha', 'canvas.md'), canvasText);
  assert.equal(run(root, 'Bash', { command: 'tar -xf attack.tar' })?.permissionDecision, 'deny');
});

test('SQ-338: extracting into a directory that holds the harness state is refused', (t) => {
  const root = makeProject();
  // The parent holds the harness state and nothing of the project.
  const stateParent = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-parent-'));
  t.after(() => fs.rmSync(stateParent, { recursive: true, force: true }));
  const env = { PLACET_RESEARCH_STATE_DIR: path.join(stateParent, 'state') };
  for (const command of [`tar -xf attack.tar -C ${stateParent}`, `unzip attack.zip -d ${stateParent}`]) {
    assert.equal(run(root, 'Bash', { command }, env)?.permissionDecision, 'deny', command);
  }
});

test('SQ-338: extracting into a symlink that leads into the state is refused', (t) => {
  const root = makeProject();
  fs.symlinkSync('research', path.join(root, 'shortcut'));
  assert.equal(run(root, 'Bash', { command: 'tar -xf attack.tar -C shortcut' })?.permissionDecision, 'deny');
  assert.equal(run(root, 'Bash', { command: 'ln -s research link && unzip attack.zip -d link' })?.permissionDecision, 'deny');
});

test('SQ-338: program text that names one of these commands is refused; a read that names one is not', () => {
  const root = makeProject();
  for (const command of [
    "bash -c 'tar xf attack.tar'",
    'sh -c "unzip attack.zip"',
    "eval 'git stash pop'",
    "xargs sh -c 'patch -p1 < attack.patch'",
    `node -e 'require("child_process").execSync("tar xf attack.tar")'`,
  ]) {
    assert.equal(run(root, 'Bash', { command })?.permissionDecision, 'deny', command);
    assert.match(guard.bashVerdict(command, root) || '', /patch, archive or stash/, command);
  }
  for (const command of [
    'grep -r unzip .',
    'git log --grep patch',
    'echo tar xf attack.tar',
    "bash -c 'echo hi'",
  ]) {
    assert.equal(run(root, 'Bash', { command }), null, command);
    assert.equal(guard.bashVerdict(command, root), null, command);
  }
});
