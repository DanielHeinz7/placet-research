#!/usr/bin/env node
'use strict';

// An observational probe, not a performance gate. Product failures are reported;
// fixture/infrastructure failures make the run nonzero. No plugin files are edited.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const REPO = path.resolve(__dirname, '../../..');
const PLUGIN = path.join(REPO, 'plugins/placet-research');
const CLI = path.join(PLUGIN, 'bin/placet-research.js');
const GUARD = path.join(PLUGIN, 'hooks/guard-promotion.js');
const lib = (name) => require(path.join(PLUGIN, 'hooks/lib', name));
const seal = lib('seal');
const decisions = lib('decisions');
const quick = process.argv.includes('--quick');
const samples = 3;
const mode = { false: 'full', true: 'quick' }[quick];
const timeout = { quick: 8000, full: 30000 }[mode];
const deadline = performance.now() + { quick: 55000, full: 480000 }[mode];
const columns = ['review', 'status', 'guard-edit', 'guard-bash', 'html', 'render'];
const active = new Set();
const findings = [];
const raw = [];
let scratch;

function remaining() {
  const ms = Math.min(timeout, deadline - performance.now());
  assert(ms > 0, 'owned run deadline exceeded');
  return Math.ceil(ms);
}

function envFor(root) {
  return { ...process.env, CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: PLUGIN,
    PLACET_RESEARCH_DIR: 'research', PLACET_RESEARCH_STATE_DIR: path.join(scratch, 'state'),
    HOME: scratch, USERPROFILE: scratch, XDG_CONFIG_HOME: path.join(scratch, 'config') };
}

function canvasText(statements) {
  let canvas = '---\nproject: invented-load-study\noutlet: Invented Journal\nprofile: is-qualitative\ncreated: 2026-01-01\nmode: seed\ncanvas-schema: 2\n---\n';
  let index = 0;
  for (let e = 1; e <= 9; e += 1) {
    canvas += `\n# ${e} · Invented field ${e}\n`;
    for (let q = 1; q <= 3; q += 1) {
      canvas += `\n## ${e}.${q} What is invented question ${e}.${q}?\n\n`;
      const n = Math.floor(statements / 27) + (index < statements % 27 ? 1 : 0);
      index += 1;
      for (let s = 0; s < n; s += 1) {
        canvas += `Invented observation ${e}-${q}-${s} concerns construct-${(index + s) % 500} in a fictional setting. [stated]\n`;
      }
    }
  }
  return canvas;
}

function glossaryText() {
  let glossary = '---\nglossary-schema: 1\n---\n';
  for (let i = 0; i < 500; i += 1) {
    glossary += `\n## construct-${i}\n\nTerm: construct-${i}\nAliases: alias-${i}\nDefinition: Invented definition ${i}.\nOrigin: own-definition\nDistinctions: Not construct-${(i + 1) % 500}.\n[proposed]\n`;
  }
  return glossary;
}

function logText(count, key) {
  // sealEntry is the CLI's sealedAppend building block. Build once in O(n),
  // rather than re-reading/verifying the whole prefix at every append (O(n²)).
  // Verify the complete bytes with the production parser and chain verifier.
  const prefix = `${decisions.header('invented-load-study')}\n${seal.keyLine(key)}\n\n`;
  let previous = seal.anchorOf(prefix);
  const chunks = [prefix];
  for (let seq = 1; seq <= count; seq += 1) {
    const entry = seal.sealEntry(previous, { seq, date: '2026-01-01', kind: 'DISCOVERY',
      ref: '1.1 Invented observation', body: `Invented log finding ${seq}. [tentative]`, by: 'Invented researcher' }, key);
    chunks.push(entry.text, '\n');
    previous = entry.seal;
  }
  const text = chunks.join('');
  const chain = seal.verifyChain(text, key);
  assert.equal(chain.status, 'verified', 'fixture chain verifies');
  assert.equal(chain.verified.size, count, 'every fixture entry is sealed');
  assert.equal(decisions.parseDecisions(text).maxSeq, count, 'fixture sequence count');
  return text;
}

function validateCanvas(canvas, statements) {
  const parsed = lib('canvas').parseCanvas(canvas);
  assert.deepEqual(parsed.problems, [], 'fixture canvas grammar');
  assert.equal(parsed.elements.flatMap((e) => e.questions.flatMap((q) => q.statements)).length, statements, 'fixture statement count');
}

function validateGlossary(glossary) {
  const terms = lib('glossary').parseGlossary(glossary);
  assert.equal(terms.entries.length, 500, 'fixture glossary count');
  assert.deepEqual(terms.problems, [], 'fixture glossary grammar');
  assert(terms.entries.every((e) => e.problems.length === 0), 'fixture glossary entries valid');
}

function fixture(label, count, statements) {
  const root = fs.mkdtempSync(path.join(scratch, `${label}-`));
  const research = path.join(root, 'research');
  fs.mkdirSync(research);
  const env = envFor(root);
  process.env.PLACET_RESEARCH_STATE_DIR = env.PLACET_RESEARCH_STATE_DIR;
  seal.createKey(root);
  const canvas = canvasText(statements);
  const glossary = glossaryText();
  validateCanvas(canvas, statements);
  validateGlossary(glossary);
  fs.writeFileSync(path.join(research, 'canvas.md'), canvas);
  fs.writeFileSync(path.join(research, 'glossary.md'), glossary);
  fs.writeFileSync(path.join(research, 'decisions.md'), logText(count, seal.readKey(root)));
  return { root, env, count, statements, label };
}

function rssOf(stderr) {
  const m = /(?:^|\n)\s*(\d+)\s+maximum resident set size/.exec(stderr);
  assert(m, 'macOS time reports peak RSS');
  return Number(m[1]) / 1024 / 1024;
}

function invocation(args) {
  return { command: '/usr/bin/time', args: ['-l', process.execPath, ...args] };
}

function recordFailure(f, operation, detail) {
  findings.push(`${f.label} ${operation}: ${detail}`);
}

function kill(child, signal) {
  try { process.kill(-child.pid, signal); } catch (_) { /* already exited */ }
}

async function commandSample(f, operation, args, input, expected) {
  const command = invocation(args);
  const start = performance.now();
  const child = cp.spawn(command.command, command.args, { cwd: f.root, env: f.env,
    detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  let stdout = ''; let stderr = ''; let error = '';
  const result = await new Promise((resolve) => {
    const timer = setTimeout(kill, remaining(), child, 'SIGKILL');
    child.once('error', (err) => { error = err.message; });
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('close', (status, signal) => { clearTimeout(timer); active.delete(child); resolve({ status, signal }); });
    child.stdin.on('error', () => {}); // A failed process may close stdin first.
    child.stdin.end(JSON.stringify(input));
  });
  const ms = performance.now() - start;
  const detail = `${error}exit ${result.status}, signal ${String(result.signal).replace('null', 'none')}`;
  let assertionPassed = false;
  try {
    assert.equal(result.status, 0);
    assert.equal(error, '');
    assert(expected(stdout));
    assertionPassed = true;
  } catch (_) { recordFailure(f, operation, `${detail}; output assertion failed; ${stdout.slice(0, 300)}`); }
  return { ms, rssMiB: rssOf(stderr), status: result.status, assertionPassed, detail };
}

async function stop(child) {
  await new Promise((resolve) => {
    const timer = setTimeout(kill, 1000, child, 'SIGKILL');
    child.once('close', () => { clearTimeout(timer); resolve(); });
    kill(child, 'SIGINT');
  });
  active.delete(child);
}

async function stopAll() {
  for (const child of active) await stop(child);
}

function idOf(node) { return node.id; }

function domCounts() {
  const ids = [...document.querySelectorAll('[id]')].map(idOf);
  return {
    entries: document.querySelectorAll('#log [id^="entry-"]').length,
    statements: document.querySelectorAll('#poster .st').length,
    fieldStatements: document.querySelectorAll('.field-view .field-para:not(.field-gap)').length,
    sections: document.querySelectorAll('#poster,#agenda,#log,#compare').length,
    duplicateIds: ids.length - new Set(ids).size,
  };
}

async function serveSample(f, browser) {
  const command = invocation([CLI, 'serve', '--no-open']);
  const start = performance.now();
  const child = cp.spawn(command.command, command.args, { cwd: f.root, env: f.env,
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.add(child);
  child.once('close', () => active.delete(child));
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const contexts = [];
  let htmlMs = null;
  let renderMs = null;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('serve URL deadline exceeded')), remaining());
      const fail = (err) => { clearTimeout(timer); reject(err); };
      child.once('error', fail);
      child.once('exit', (code) => fail(new Error(`serve exited ${code} before URL`)));
      child.stdout.on('data', (data) => {
        stdout += data;
        for (const match of stdout.matchAll(/http:\/\/127\.0\.0\.1:\d+\/[^\s]*/g)) {
          clearTimeout(timer); resolve(match[0]);
        }
      });
    });
    // Fetching HTML does not redeem the single-use session code.
    const response = await fetch(url, { signal: AbortSignal.timeout(remaining()) });
    assert.equal(response.status, 200, 'serve HTML status');
    assert.match(await response.text(), /id="app"/, 'serve session HTML');
    htmlMs = performance.now() - start;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    contexts.push(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.setDefaultTimeout(remaining());
    const statePromise = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/state');
    await page.goto(url, { waitUntil: 'load', timeout: remaining() });
    const state = await (await statePromise).json();
    await page.locator('#poster.active').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('#app .field-view').length === 9);
    await page.evaluate('new Promise(requestAnimationFrame).then(() => new Promise(requestAnimationFrame))');
    renderMs = performance.now() - start;
    const counts = await page.evaluate(`(() => { const idOf = ${idOf.toString()}; return (${domCounts.toString()})(); })()`);
    assert.equal(state.decisions.length, f.count, 'API returns every log entry');
    assert(state.decisions.every((d) => d.sealStatus === 'verified'), 'API entries all verify');
    assert.equal(counts.entries, f.count, 'DOM renders every log entry');
    assert.equal(counts.statements, f.statements, 'poster renders every canvas statement');
    assert.equal(counts.fieldStatements, f.statements, 'fields render every canvas statement');
    assert.equal(counts.sections, 3, 'poster, agenda and log rendered (compare requires variants)');
    assert.equal(counts.duplicateIds, 0, 'DOM IDs stay unique at size');
    await page.locator('[data-view-target="log"]').first().click();
    await page.locator('#log.active').waitFor({ state: 'visible' });
    assert.deepEqual(errors, [], 'session view has no page errors');
    return { htmlMs, renderMs, counts };
  } catch (err) {
    recordFailure(f, 'serve/render', err.message);
    return { htmlMs, renderMs, error: err.message };
  } finally {
    for (const context of contexts) await context.close();
    await stopAll();
    // time(1) writes RSS only once its child has exited.
    raw.push({ fixture: f.label, operation: 'serve-rss', rssMiB: rssOf(stderr) });
  }
}

function median(values) {
  const present = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return present.length === samples ? present[1] : null;
}
const shown = (n) => n === null ? 'FAILED' : n.toFixed(1);

async function measure(f, browser) {
  const edit = { cwd: f.root, session_id: 'invented-load-session', hook_event_name: 'PreToolUse', tool_name: 'Edit',
    tool_input: { file_path: path.join(f.root, 'research/canvas.md'), old_string: 'Invented observation 1-1-0', new_string: 'Revised invented observation 1-1-0' } };
  const bash = { ...edit, tool_name: 'Bash', tool_input: { command: 'cat research/decisions.md' } };
  const commands = [
    ['review', [CLI, 'review'], null, (s) => /# Mechanical review[\s\S]*verified/.test(s)],
    ['status', [CLI, 'status'], null, (s) => /1 stated[\s\S]*9 stated/.test(s)],
    // Editing a researcher-stated commitment must be denied. The Bash read
    // must be allowed; neither guard invocation actually performs the tool.
    ['guard-edit', [GUARD], edit, (s) => JSON.parse(s).hookSpecificOutput.permissionDecision === 'deny'],
    ['guard-bash', [GUARD], bash, (s) => s.trim() === ''],
  ];
  const row = { label: f.label, entries: f.count, statements: f.statements };
  for (const [operation, args, input, expected] of commands) {
    const runs = [];
    for (let i = 0; i < samples; i += 1) runs.push(await commandSample(f, operation, args, input, expected));
    raw.push({ fixture: f.label, operation, runs });
    row[operation] = median(runs.map((r) => r.ms));
    row[`${operation}-rss`] = Math.max(...runs.map((r) => r.rssMiB));
  }
  const serves = [];
  for (let i = 0; i < samples; i += 1) serves.push(await serveSample(f, browser));
  raw.push({ fixture: f.label, operation: 'serve-render', runs: serves });
  row.html = median(serves.map((r) => r.htmlMs));
  row.render = median(serves.map((r) => r.renderMs));
  row['serve-rss'] = Math.max(...raw.filter((r) => r.fixture === f.label && r.operation === 'serve-rss').map((r) => r.rssMiB));
  return row;
}

function thresholdFindings(row) {
  return [
    ...columns.filter((col) => row[col] > 5000).map((col) => `${row.label} ${col}: >5 s (${shown(row[col])} ms)`),
    ...['guard-edit', 'guard-bash'].filter((col) => row[col] > 1000).map((col) => `${row.label} ${col}: exceeds ~1 s budget`),
  ];
}

function ratioFindings(a, b, series) {
  const size = { log: 'entries', canvas: 'statements' }[series];
  const growth = b[size] / a[size];
  return columns.filter((col) => b[col] / a[col] > growth * 1.5).map((col) =>
    `Possible superlinear ${series} ${col}: time ×${(b[col] / a[col]).toFixed(2)} for input ×${growth.toFixed(2)}; repeat on an idle host before inferring complexity`);
}

function scanFindings(rows) {
  const result = rows.flatMap(thresholdFindings);
  for (const series of ['log', 'canvas']) {
    const group = rows.filter((r) => r.label.startsWith(series));
    for (let i = 1; i < group.length; i += 1) result.push(...ratioFindings(group[i - 1], group[i], series));
  }
  return result;
}

function memoryRows(rows) {
  return rows.filter((r) => [r.entries === 20000, r.statements === 2000].includes(true)).map((r) =>
    `${r.label}: ${['review', 'status', 'guard-edit', 'guard-bash', 'serve'].map((c) => `${c}=${shown(r[`${c}-rss`])}`).join(', ')}`);
}

function findingLines(items) {
  if (items.length) return items;
  return ['None: no >5 s median, >1 s guard, crash, rendering mismatch, or flagged superlinear ratio in measured cases.'];
}

function report(rows, elapsed) {
  findings.push(...scanFindings(rows));
  return [
    `Load stress probe (${mode}), ${new Date().toISOString()}`,
    `Probe SHA-256: ${crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}`,
    `Plugin tree: ${cp.execFileSync('git', ['rev-parse', 'HEAD:plugins/placet-research'], { cwd: REPO, encoding: 'utf8' }).trim()}`,
    `Source HEAD: ${cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()}`,
    `Node ${process.version}; ${process.platform}/${process.arch}; ${os.cpus()[0].model}; elapsed ${(elapsed / 1000).toFixed(2)} s`,
    'Invented temporary projects only; isolated empty state directory at run start.',
    'Valid chains: production seal.sealEntry + decisions.formatEntry; complete seal.verifyChain asserted for every entry.',
    'Independent axes: log varies with 50 statements; canvas varies with 100 log entries. Every project has 500 glossary entries.',
    'Wall ms, median of 3 fresh processes (no warmup; OS caches may be warm). HTML/render measured from CLI spawn; browser already launched.',
    'Render readiness: visible poster + 9 fields + poster/agenda/log sections + two animation frames; all DOM statements/log entries and API seals asserted; history navigation checked.',
    'case | entries | statements | review | status | guard Edit | guard Bash | serve HTML | rendered',
    ...rows.map((r) => `${r.label} | ${r.entries} | ${r.statements} | ${columns.map((c) => shown(r[c])).join(' | ')}`),
    '', 'Peak RSS MiB (/usr/bin/time -l, maximum of 3 per command; server only, excludes Chromium; not summed):',
    ...memoryRows(rows),
    '', 'Findings (thresholds flag observations, not pass/fail admission):',
    ...findingLines(findings),
    '', 'Limits: single host; startup-inclusive timing; synthetic short bodies; no manuscript files; no variants, agent runtime or remote filesystem; no claim about sizes beyond those measured.',
    'Quick mode excludes 5,000/20,000 log entries and 2,000 statements; no largest-case memory claim in quick mode.',
    '', 'Raw samples:', JSON.stringify(raw, null, 2), '',
  ].join('\n');
}

function selfCheck() {
  assert.equal(shown(null), 'FAILED', 'failed sample formatting');
  assert.equal(median([1, null, 3]), null, 'incomplete sample median');
  assert.equal(shown(median([3, 1, 2])), '2.0', 'three-sample median');
  assert.equal(findingLines([]).length, 1, 'empty findings');
  const tiny = { label: 'log-test', entries: 1, statements: 1, ...Object.fromEntries(columns.map((c) => [c, 1])) };
  const large = { ...tiny, label: 'log-large', entries: 20000, ...Object.fromEntries(columns.map((c) => [c, 6000])),
    ...Object.fromEntries(['review', 'status', 'guard-edit', 'guard-bash', 'serve'].map((c) => [`${c}-rss`, null])) };
  assert.equal(findingLines(scanFindings([tiny, { ...large, entries: 2 }])).length, 14, 'threshold and superlinear findings');
  assert.equal(memoryRows([large, { ...large, label: 'canvas-large', entries: 100, statements: 2000 }]).length, 2, 'largest-case memory rows');
  const savedDocument = global.document;
  global.document = { querySelectorAll: () => [] };
  assert.equal(domCounts().duplicateIds, 0, 'empty DOM ID count');
  assert.equal(idOf({ id: 'invented' }), 'invented', 'DOM ID projection');
  global.document = savedDocument;
}

async function measureCases(browser) {
  const rows = [];
  const cases = { quick: [[100, 1000], [50, 500]], full: [[100, 1000, 5000, 20000], [50, 500, 2000]] }[mode];
  for (const n of cases[0]) rows.push(await measure(fixture(`log-${n}`, n, 50), browser));
  for (const n of cases[1]) rows.push(await measure(fixture(`canvas-${n}`, 100, n), browser));
  return rows;
}

async function runProbe() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ timeout: remaining() });
  try { return await measureCases(browser); }
  finally { await stopAll(); await browser.close(); }
}

async function main() {
  assert.equal(process.platform, 'darwin', 'load probe requires macOS /usr/bin/time -l');
  selfCheck();
  const start = performance.now();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-load-'));
  const originalEnv = { ...process.env };
  try {
    const rows = await runProbe();
    const output = report(rows, performance.now() - start);
    console.log(output);
    const destinations = { quick: os.devNull, full: path.join(__dirname, 'load-results.txt') };
    fs.writeFileSync(destinations[mode], output);
  } finally {
    process.env = originalEnv;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(`load probe failed: ${err.stack}`); process.exitCode = 1; });
