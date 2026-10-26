'use strict';

// Only invented fixture data. Native CLI writes build the baseline; direct
// library calls below are hostile mutations, never substitute CLI verdicts.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const REPO = path.resolve(__dirname, '../../..');
const PLUGIN = path.join(REPO, 'plugins/placet-research');
const CLI = path.join(PLUGIN, 'bin/placet-research.js');
const decisions = require(path.join(PLUGIN, 'hooks/lib/decisions'));
const seal = require(path.join(PLUGIN, 'hooks/lib/seal'));
const parent = process.env.PLACET_RESEARCH_PROBE_DIR || os.tmpdir();
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, 'log-tamper-'));
const state = path.join(scratch, 'state');
const emptyHooks = path.join(scratch, 'empty-hooks');
fs.mkdirSync(emptyHooks);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith('GIT_') || key.startsWith('PLACET_RESEARCH_') || key === 'CLAUDE_PROJECT_DIR') delete env[key];
}
Object.assign(env, {
  CLAUDE_PLUGIN_ROOT: PLUGIN, PLACET_RESEARCH_STATE_DIR: state,
  GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Probe Author', GIT_AUTHOR_EMAIL: 'probe@example.invalid',
  GIT_COMMITTER_NAME: 'Probe Author', GIT_COMMITTER_EMAIL: 'probe@example.invalid',
});
const rows = [];
const details = [];
const LIMIT = 'The authors hold the key, so an anchor printed today would match a rewritten log too — what detects a rewrite is an anchor published *earlier*: a git tag, the submitted manuscript, a mail.';
const file = root => path.join(root, 'research/decisions.md');
const canvas = root => path.join(root, 'research/canvas.md');
const read = root => fs.readFileSync(file(root), 'utf8');
const entries = text => decisions.parseDecisions(text).entries;
const write = (root, text) => fs.writeFileSync(file(root), text);

function run(bin, args, root) {
  const r = cp.spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.signal, null, `process was killed: ${bin} ${args[0]}`);
  assert.notEqual(r.status, null, `process did not complete: ${bin} ${args[0]}`);
  return { code: r.status, text: `${r.stdout}${r.stderr}`.trim() };
}
function cli(root, args) { return run(process.execPath, [CLI, ...args], root); }
function must(r) { assert.equal(r.code, 0, r.text); return r; }
function git(root, args) {
  return run('git', ['-c', `core.hooksPath=${emptyHooks}`, '-c', `init.templateDir=${emptyHooks}`, ...args], root);
}
// This standalone probe owns its process environment; children use the isolated env above.
process.env.PLACET_RESEARCH_STATE_DIR = state;
function keyPath(root) { return seal.keyPath(root); }
function installKey(root, key) {
  const target = keyPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, key.toString('hex'), { mode: 0o600 });
  return target;
}
function copyProject(source, label) {
  const root = path.join(scratch, label);
  fs.mkdirSync(root);
  fs.cpSync(path.join(source, 'research'), path.join(root, 'research'), { recursive: true });
  return root;
}
function blocks(text) {
  const es = entries(text);
  return { prefix: text.slice(0, es[0].offset), parts: es.map((e, i) => text.slice(e.offset, es[i + 1]?.offset || text.length)) };
}
function replaceEntry(text, index, transform) {
  const b = blocks(text);
  const before = b.parts[index];
  b.parts[index] = transform(before);
  assert.notEqual(b.parts[index], before, 'mutation must change its target');
  return b.prefix + b.parts.join('');
}
function anchor(text) { return `Anchor: ${seal.logAnchor(text)}`; }
function verdict(r, stale) {
  const lines = r.text.split('\n');
  const problem = lines.find(line => /BROKEN|CRLF|line endings|Seal key line.*different key|unverifiable/.test(line))
    || (stale && lines.find(line => /no longer matches|Stale acceptances: #/.test(line)));
  const summary = problem || lines.find(line => /^verified:|Ledger:|unverifiable/.test(line));
  assert.notEqual(summary, undefined, 'CLI verdict must have a recognized diagnostic or summary');
  return { detected: Boolean(problem), display: `exit ${r.code}; ${summary}` };
}
function cleanVerdicts(review, status, rv, sv) {
  return [review.code === 0, status.code === 0, !rv.detected, !sv.detected,
    /verified:/.test(review.text), /Ledger: verified/.test(status.text)].every(Boolean);
}
function findingFor(options, result) {
  if (options.limit) return 'LIMIT';
  const success = options.clean ? result.clean : result.detected;
  return success ? 'no' : 'FINDING';
}
function recordAnchor(id, root, review) {
  const currentAnchor = review.text.split('\n').find(line => line.startsWith('Anchor:'));
  if (currentAnchor !== undefined) assert.equal(currentAnchor, anchor(read(root)), `${id}: CLI must print actual byte anchor`);
  else {
    assert.equal(review.code, 1, `${id}: only early CRLF refusal omits anchor`);
    assert.match(review.text, /CRLF/);
  }
  const changed = anchor(read(root)) === anchor(original) ? 'unchanged' : 'CHANGED';
  const refusal = currentAnchor === undefined ? ' (CLI refused CRLF before printing an anchor)' : '';
  details.push(`${id}: anchor ${changed} relative to retained baseline${refusal}.`);
  return currentAnchor;
}
function recordLimit(id, limit) {
  if (limit) details.push(`${id} LIMIT (README, “Verifying a record you received”): “${LIMIT}” ${limit}`);
}
function observe(id, name, root, options = {}) {
  const config = { keyFile: originalKeyFile, clean: false, stale: false, ...options };
  const review = cli(root, ['review', '--key', config.keyFile]);
  const status = cli(root, ['status', '--key', config.keyFile]);
  // Both consumers normally exit 0 even for BROKEN. Their diagnostic, not
  // process success, is the detection oracle. Process errors cannot pass it.
  const rv = verdict(review, config.stale);
  const sv = verdict(status, config.stale);
  const clean = cleanVerdicts(review, status, rv, sv);
  const detected = [rv.detected, sv.detected].every(Boolean);
  const expected = config.clean ? 'verified control' : 'detected';
  rows.push([id, name, expected, rv.display, sv.display, findingFor(config, { clean, detected })]);
  const currentAnchor = recordAnchor(id, root, review);
  recordLimit(id, config.limit);
  fs.writeFileSync(path.join(scratch, `${id}-review.txt`), review.text + '\n');
  fs.writeFileSync(path.join(scratch, `${id}-status.txt`), status.text + '\n');
  return { review, status, clean, detected, currentAnchor };
}
function mutation(id, name, transform, options) {
  const root = copyProject(base, id);
  const next = transform(original);
  assert.notEqual(next, original, `${id}: changed bytes required`);
  write(root, next);
  return observe(id, name, root, options);
}
function asyncLog(root, body) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [CLI, 'log', 'DISCOVERY', '3.1', '--body', body], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 30000);
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, text: text.trim() });
    });
  }).then(result => {
    assert.equal(result.signal, null, 'concurrent CLI was killed');
    assert.notEqual(result.code, null, 'concurrent CLI did not complete');
    return result;
  });
}

const base = path.join(scratch, 'baseline');
fs.mkdirSync(base);
assert.equal(fs.existsSync(state), false, 'state starts absent');
must(cli(base, ['init', '--project', 'invented-log-probe', '--mode', 'seed']));
must(cli(base, ['name', 'Probe Author']));
const fixture = fs.readFileSync(path.join(PLUGIN, 'test/fixtures/voice-uptake/research/canvas.md'), 'utf8');
fs.writeFileSync(canvas(base), fixture.replace('[accepted]', '[stated]'));
must(cli(base, ['accept', '1.2', '--match', 'Speaking frequency', '--explained', 'Invented probe acceptance.']));
for (let i = 2; i <= 10; i += 1) must(cli(base, ['log', i % 2 ? 'CONSTRAINT' : 'DISCOVERY', '3.1', '--body', `Invented finding ${i}.`, '--why', 'Probe control.']));
const original = read(base);
assert.equal(entries(original).length, 10, 'ten real CLI entries');
const originalKeyFile = keyPath(base);
const key = seal.readKeyFile(originalKeyFile);
const foreignKey = crypto.randomBytes(32);
const foreignKeyFile = path.join(scratch, 'foreign.seal.key');
fs.writeFileSync(foreignKeyFile, foreignKey.toString('hex'), { mode: 0o600 });
assert.equal(observe('L00', 'baseline: ten CLI entries', base, { clean: true }).clean, true);

mutation('L01', 'one body character', t => replaceEntry(t, 4, s => s.replace('finding', 'Finding')));
mutation('L02', 'one By field character', t => replaceEntry(t, 4, s => s.replace('Probe Author', 'Probe author')));
mutation('L03', 'one date character', t => replaceEntry(t, 4, s => s.replace(/(\d{4}-\d{2}-)\d/, '$19')));
function changeHexCharacter(_, prefix, character) {
  return prefix + '1000000000000000'[parseInt(character, 16)];
}
mutation('L04', 'one Seal key fingerprint character', t => t.replace(/(Seal key: )([0-9a-f])/, changeHexCharacter));
mutation('L05', 'one seal value character', t => replaceEntry(t, 4, s => s.replace(/( · seal )([0-9a-f])/, changeHexCharacter)));
mutation('L06', 'delete middle entry', t => { const b = blocks(t); b.parts.splice(4, 1); return b.prefix + b.parts.join(''); });
mutation('L07', 'delete last entry', t => { const b = blocks(t); b.parts.pop(); return b.prefix + b.parts.join(''); }, { limit: 'Tail truncation leaves a valid prefix; retained anchor differs.' });
mutation('L08', 'swap middle entries', t => { const b = blocks(t); [b.parts[4], b.parts[5]] = [b.parts[5], b.parts[4]]; return b.prefix + b.parts.join(''); });
mutation('L09', 'duplicate entry', t => { const b = blocks(t); b.parts.splice(5, 0, b.parts[4]); return b.prefix + b.parts.join(''); });
mutation('L10', 'append forged entry sealed with foreign key', t => t + decisions.separatorAfter(t) + seal.sealEntry(seal.lastSealOf(t), {
  seq: 11, date: '2026-01-01', kind: 'DISCOVERY', ref: '3.1', body: 'Invented forgery.', by: 'Probe Intruder',
}, foreignKey).text);
const resealed = mutation('L11', 're-seal entire log under new key; reviewer receives new key', t => {
  let text = blocks(t).prefix.replace(/^Seal key: .*$/m, seal.keyLine(foreignKey));
  for (const e of entries(t)) text += decisions.separatorAfter(text) + seal.sealEntry(seal.lastSealOf(text), {
    seq: e.seq, date: e.date, kind: e.kind, ref: e.ref, hash: e.hash, body: e.body,
  }, foreignKey).text;
  return text;
}, { keyFile: foreignKeyFile, limit: 'Reviewer uses substituted key; retained original anchor must change.' });
assert.equal(resealed.clean, true, 're-sealed log verifies under new key');
assert.notEqual(resealed.currentAnchor, anchor(original), 're-sealing changes published anchor');
observe('L12', 're-sealed log checked with original key', path.join(scratch, 'L11'));
mutation('L13', 'CRLF only', t => t.replace(/\n/g, '\r\n'));
mutation('L14', 'trailing spaces on body lines only', t => replaceEntry(t, 4, s => s.replace('Invented finding 5.', 'Invented finding 5.   ')));
mutation('L15', 'trailing spaces on every nonempty line', t => t.replace(/([^\n]+)\n/g, '$1   \n'));
mutation('L16', 'UTF-8 BOM at file start only', t => '﻿' + t);
const stale = copyProject(base, 'L17');
const accepted = fs.readFileSync(canvas(stale), 'utf8');
assert.match(accepted, /Speaking frequency[^\n]*\[accepted\]/);
fs.writeFileSync(canvas(stale), accepted.replace('Speaking frequency', 'Speaking duration'));
observe('L17', 'accepted statement text changed after acceptance', stale, { stale: true });

function clone(source, name) {
  const root = path.join(scratch, name);
  must(git(scratch, ['clone', '--quiet', '--no-local', source, root]));
  installKey(root, key);
  return root;
}
function commitFixture(root, message) {
  must(git(root, ['add', 'research']));
  must(git(root, ['commit', '--quiet', '-m', message]));
}
// These branches and commits belong solely to an isolated invented fixture
// repository, not this checkout or the user's repository.
must(git(base, ['init', '--quiet', '-b', 'fixture-base']));
commitFixture(base, 'Invented baseline');
const ours = clone(base, 'merge-ours');
const theirs = clone(base, 'merge-theirs');
for (const [root, label] of [[ours, 'ours'], [theirs, 'theirs']]) {
  for (let i = 1; i <= 2; i += 1) must(cli(root, ['log', 'DISCOVERY', '3.1', '--body', `Invented ${label} branch ${i}.`]));
  commitFixture(root, `Invented ${label} append`);
}
const oursText = read(ours);
const theirsText = read(theirs);
must(git(ours, ['fetch', '--quiet', theirs, 'HEAD']));
const conflict = git(ours, ['merge', '--no-edit', 'FETCH_HEAD']);
assert.equal(conflict.code, 1, 'plain git merge really conflicts');
assert.match(conflict.text, /CONFLICT.*research\/decisions.md/);
assert.equal(must(git(ours, ['show', ':2:research/decisions.md'])).text, oursText.trim());
assert.equal(must(git(ours, ['show', ':3:research/decisions.md'])).text, theirsText.trim());
observe('L18', 'plain git merge unresolved conflict markers', ours);
const a = blocks(oursText), b = blocks(theirsText);
write(ours, a.prefix + a.parts.join('') + b.parts.slice(10).join(''));
observe('L19', 'wrong conflict resolution: keep both divergent tails', ours);
write(ours, oursText);
const keptOne = observe('L20', 'wrong conflict resolution: keep only ours; lose theirs', ours, { limit: 'A complete valid branch survives; only an anchor retained from the discarded branch establishes its loss.' });
assert.equal(keptOne.currentAnchor, anchor(oursText), 'keeping ours preserves its own published anchor');
assert.notEqual(keptOne.currentAnchor, anchor(theirsText), 'discarded branch anchor detects lost entries');
details.push('L20: surviving anchor equals ours before merge and differs from the discarded theirs anchor.');
write(ours, a.prefix + a.parts.slice(0, 10).join('') + a.parts[10] + b.parts[10] + a.parts[11] + b.parts[11]);
observe('L21', 'wrong conflict resolution: interleave divergent tails', ours);
const merged = must(cli(ours, ['merge-log']));
assert.match(merged.text, /Merged:/, 'native merge-log consumes conflict stages');
const mergedEntries = entries(read(ours));
assert.equal(mergedEntries.length, 15, 'merge retains ten common + four divergent + marker');
for (const label of ['ours', 'theirs']) for (let i = 1; i <= 2; i += 1) {
  assert.equal(mergedEntries.filter(e => e.body.startsWith(`Invented ${label} branch ${i}.`)).length, 1, 'each branch entry retained once');
}
assert.equal(new Set(mergedEntries.map(e => e.seq)).size, 15, 'merge has unique sequence numbers');
assert.equal(observe('L22', 'CLI merge-log retains both tails and a MERGE marker', ours, { clean: true }).clean, true);
details.push(`L22 CLI: ${merged.text.split('\n')[0]}`);

async function concurrentRound(round) {
  const root = copyProject(base, `concurrent-${round}`);
  installKey(root, key);
  const bodies = [`Concurrent round ${round} writer A.`, `Concurrent round ${round} writer B.`];
  const results = await Promise.all(bodies.map(body => asyncLog(root, body)));
  const es = entries(read(root));
  const counts = bodies.map(body => es.filter(e => e.body.startsWith(body)).length);
  const lost = counts.filter(n => n !== 1).length;
  const duplicate = es.length - new Set(es.map(e => e.seq)).size;
  const result = observe(`C${String(round).padStart(2, '0')}`, `two concurrent CLI appends round ${round}`, root, { clean: true });
  const broken = Number(!result.clean);
  const refused = results.filter(r => r.code !== 0).length;
  const row = rows[rows.length - 1];
  row[2] = 'both entries once; unique seq; verified';
  row[5] = lost + duplicate + broken + refused > 0 ? 'FINDING' : 'no';
  details.push(`${row[0]}: CLI exits=${results.map(r => r.code).join(',')}; matching bodies=${counts.join(',')}; duplicate seq=${duplicate}; total entries=${es.length}. ${results.map(r => r.text).join(' / ')}`);
  return { lost, duplicate, broken, refused };
}
function printReport({ lost, duplicate, broken, refused }) {
  const report = [
    'SQ-323 — seal and decision-log stress probe',
    'Observed via real CLI review/status --key. Diagnostic text, not exit 0, decides detection.',
    'Baseline: fresh absent state directory, invented name, fixture canvas, ten CLI entries (one accept + nine logs).',
    'Expected for mutations: detected. Controls and concurrent valid appends: verified. LIMIT rows require a retained external anchor.',
    'Whitespace rows are literal byte mutations: an unchanged logical payload that verifies is still reported, not silently exempted.',
    '',
    'ID | case | expected | review verdict | status verdict | FINDING?',
    ...rows.map(row => row.map(cell => String(cell).replace(/\|/g, '/')).join(' | ')),
    '',
    'Evidence and assertions',
    ...details,
    `Concurrency (20 rounds, at most two CLI writers): missing/nonunique body occurrences=${lost}; duplicate seq=${duplicate}; nonverified rounds=${broken}; CLI refusals=${refused}.`,
    `Completed: ${rows.length} rows; ${rows.filter(row => row[5] === 'FINDING').length} FINDING rows; ${rows.filter(row => row[5] === 'LIMIT').length} LIMIT rows. Findings do not change exit status.`,
    'Not attempted: process crash recovery, hostile modification of the local secret, or automated comparison to an external published anchor.',
    'Raw per-case review/status output and fixture projects are retained in the fresh log-tamper-* evidence directory under PLACET_RESEARCH_PROBE_DIR (OS temp by default).',
    '',
  ].join('\n');
  process.stdout.write(report);
  fs.writeFileSync(path.join(scratch, 'log-tamper.txt'), report);
}
async function main() {
  const totals = { lost: 0, duplicate: 0, broken: 0, refused: 0 };
  for (let round = 1; round <= 20; round += 1) {
    const result = await concurrentRound(round);
    for (const metric of Object.keys(totals)) totals[metric] += result[metric];
  }
  printReport(totals);
}
main().catch(err => { console.error(`Probe infrastructure failure: ${err.stack}\nEvidence: ${scratch}`); process.exitCode = 1; });
