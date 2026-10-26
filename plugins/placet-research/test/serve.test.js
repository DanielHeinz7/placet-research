'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const seal = require('../hooks/lib/seal');
const profileLib = require('../hooks/lib/profile');
const stateLib = require('../hooks/lib/state');
const { textHash } = require('../hooks/lib/hash');
const { HUMAN_QUESTIONS, agendaOf } = require('../hooks/lib/agenda');
const { readStore } = require('../hooks/lib/app-store');
const { start, viewState } = require('../bin/canvas-serve');

const pluginRoot = path.resolve(__dirname, '..');
const cli = path.join(pluginRoot, 'bin', 'placet-research.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');

delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-state-'));
process.env.PLACET_RESEARCH_STATE_DIR = stateDir;
// The name every entry carries as `By` (SQ-177), set here rather than taken
// from the machine's git config, so the expected bytes below are the same
// everywhere. The view reads the same file the CLI does.
const NAME = 'A. Researcher';
const nameFile = path.join(stateDir, 'name');
fs.writeFileSync(nameFile, `${NAME}\n`);

const SPEAKING = 'Speaking frequency is well documented; whether a proposal is taken up is not.';
const WHY = 'the gap is uptake, not voice';
// Every accept carries the researcher's explanation (US-3).
const EXPLAINED = 'I accept this because the fieldnotes show it.';
const REJECTED = 'reading uptake as a property of the proposal alone';
const CHOSEN_WHY = 'It explains the two meetings the power lens cannot.';
const CHOSEN_REJECTED = 'power: the minutes never record rank';
const roots = [];

function run(root, args) {
  return childProcess.spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    encoding: 'utf8',
  });
}

function copyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-serve-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'research'));
  for (const f of ['canvas.md', 'decisions.md']) fs.copyFileSync(path.join(fixtureDir, f), path.join(root, 'research', f));
  return root;
}

function keyedProject() {
  const root = copyFixture();
  const out = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(out.status, 0, out.stdout);
  return root;
}

// A second checkout of the same project: the same research/ tree and the same
// sealing key, so one write through each route must land byte-identical files.
function duplicate(root) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-serve-'));
  roots.push(copy);
  fs.cpSync(path.join(root, 'research'), path.join(copy, 'research'), { recursive: true });
  fs.mkdirSync(path.dirname(seal.keyPath(copy)), { recursive: true });
  fs.copyFileSync(seal.keyPath(root), seal.keyPath(copy));
  return copy;
}

// What the model writes into a canvas: a statement where its question's
// `_(empty)_` stands.
function addStatement(file, statement) {
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf('_(empty)_');
  assert.ok(at >= 0, `${file} has no empty placeholder`);
  fs.writeFileSync(file, `${text.slice(0, at)}${statement}${text.slice(at + '_(empty)_'.length)}`);
}

// A fresh project — no accepted statement yet, so a framing can be chosen —
// with two variants holding one statement each.
function projectWithVariants() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-serve-var-'));
  roots.push(root);
  const made = run(root, ['init', '--project', 'voice-uptake', '--mode', 'seed']);
  assert.equal(made.status, 0, made.stdout + made.stderr);
  for (const [name, lens] of [['power', 'power and hierarchy'], ['sense-making', 'collective sense-making: "who hears whom"']]) {
    const variant = run(root, ['init', '--variant', name, '--lens', lens]);
    assert.equal(variant.status, 0, variant.stdout + variant.stderr);
  }
  addStatement(path.join(root, 'research', 'variants', 'power', 'canvas.md'), 'Uptake follows rank rather than argument. [proposed, unverified]');
  addStatement(path.join(root, 'research', 'variants', 'sense-making', 'canvas.md'), 'Uptake follows whether a proposal fits the frame the room already shares. [tentative, unverified]');
  return root;
}

const read = (root, name) => fs.readFileSync(path.join(root, 'research', name), 'utf8');

function request(port, { method = 'GET', urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* html */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// `extra` overrides the default headers; a value of undefined leaves one out.
function post(srv, urlPath, payload, extra = {}) {
  const headers = {
    Host: `127.0.0.1:${srv.port}`,
    'Content-Type': 'application/json',
    'X-Harness-Token': srv.token,
    ...extra,
  };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
  return request(srv.port, { method: 'POST', urlPath, headers, body: JSON.stringify(payload) });
}

// A GET as the shell sends it: with the token when one is given.
function get(srv, urlPath, token) {
  const headers = { Host: `127.0.0.1:${srv.port}` };
  if (token) headers['X-Harness-Token'] = token;
  return request(srv.port, { urlPath, headers });
}

// Trades the server's single-use code for the token, as the view does.
async function redeem(srv) {
  const res = await post(srv, '/api/session', { code: srv.code }, { 'X-Harness-Token': undefined });
  assert.equal(res.status, 200, res.text);
  return res.json.token;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

test('the session server serves state, refuses what fails a check, and writes what the CLI writes', async (t) => {
  const root = keyedProject();
  const srv = await start({ root, pluginRoot });
  t.after(() => srv.close());
  assert.match(srv.token, /^[0-9a-f]{64}$/);
  assert.equal(srv.url, `http://127.0.0.1:${srv.port}/#c=${srv.code}`);
  assert.ok(!srv.url.includes(srv.token), 'the URL carries the code, never the token');
  const host = { Host: `127.0.0.1:${srv.port}` };

  // GET /api/state: the elements, each statement with its text hash, the
  // ledger's verified set as an array, and no key.
  const state = await request(srv.port, { urlPath: '/api/state', headers: host });
  assert.equal(state.status, 200);
  assert.equal(state.json.project, 'voice-uptake');
  assert.equal(state.json.elements.length, 9);
  const q12 = state.json.elements[0].questions.find((q) => q.id === '1.2');
  const speaking = q12.statements.find((s) => s.text === SPEAKING);
  assert.equal(speaking.hash, textHash(SPEAKING));
  assert.ok(Array.isArray(state.json.review.ledger.verified));
  assert.ok(Array.isArray(state.json.decisions));
  assert.ok(!('key' in state.json));
  const key = seal.readKey(root).toString('hex');
  assert.ok(!state.text.includes(key), 'the sealing key never leaves the process');

  const root200 = await request(srv.port, { urlPath: '/', headers: host });
  assert.equal(root200.status, 200);

  // Request checks: every refusal is a bare 403.
  const payload = { questionId: '1.2', expectedHash: textHash(SPEAKING) };
  const noToken = await post(srv, '/api/accept', payload, { 'X-Harness-Token': undefined });
  assert.equal(noToken.status, 403);
  assert.deepEqual(noToken.json, { ok: false, error: 'forbidden' });
  assert.equal((await post(srv, '/api/accept', payload, { 'X-Harness-Token': 'a'.repeat(64) })).status, 403);
  assert.equal((await post(srv, '/api/accept', payload, { 'X-Harness-Token': 'short' })).status, 403);
  assert.equal((await post(srv, '/api/accept', payload, { Host: `localhost:${srv.port}` })).status, 403);
  assert.equal((await request(srv.port, { urlPath: '/api/state', headers: { Host: `evil.example:${srv.port}` } })).status, 403);
  assert.equal((await post(srv, '/api/accept', payload, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(srv, '/api/accept', payload, { Origin: `http://localhost:${srv.port}` })).status, 403);
  assert.equal((await post(srv, '/api/accept', payload, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal(read(root, 'decisions.md'), fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8'), 'no refused request wrote anything');

  // A body over 64 KB is refused before it is parsed.
  const big = await post(srv, '/api/comment', { ref: '1', body: 'x'.repeat(70 * 1024) });
  assert.equal(big.status, 413);

  // A stale hash is 409, another refusal 422.
  const stale = await post(srv, '/api/accept', { questionId: '1.2', expectedHash: '00000000', explained: EXPLAINED });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'stale');
  const bad = await post(srv, '/api/accept', { questionId: '99', expectedHash: textHash(SPEAKING) });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.code, 'invalid');
  // An accept without expectedHash would skip the staleness check; it is 422.
  for (const body of [{ questionId: '1.2', match: 'chairing' }, { questionId: '1.2', expectedHash: '' }]) {
    const noHash = await post(srv, '/api/accept', body);
    assert.equal(noHash.status, 422, noHash.text);
    assert.equal(noHash.json.code, 'invalid');
  }
  assert.equal(read(root, 'decisions.md'), fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8'), 'an accept without expectedHash wrote nothing');

  // Two check questions on 1.2, logged as the model logs them: DISCOVERY
  // entries with ref "<n.m> check". They are open until a DECISION on 1.2.
  // The second checkout is taken first, so both logs start from the same bytes
  // and the comparison below is about the two routes, not about two histories.
  const second = duplicate(root);
  const CHECKS = ['How would a chairing-style study code this meeting?', 'Do the minutes record who spoke first?'];
  const checks = [];
  for (const question of CHECKS) {
    const logged = await post(srv, '/api/comment', { ref: '1.2 check', body: question });
    assert.equal(logged.status, 200, logged.text);
    checks.push({ seq: logged.json.seq, body: `${question}\n**By:** ${NAME}` });
    const cli = run(second, ['log', 'DISCOVERY', '1.2 check', '--body', question]);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  }
  assert.equal(read(root, 'decisions.md'), read(second, 'decisions.md'), 'both logs hold the same checks');

  const opened = await request(srv.port, { urlPath: '/api/state', headers: host });
  const openOn = (state, id) => state.json.elements[0].questions.find((q) => q.id === id).openChecks;
  assert.deepEqual(openOn(opened, '1.2'), checks, '/api/state shows the open checks of 1.2');
  assert.deepEqual(openOn(opened, '1.1'), [], 'a question without a check shows none');

  // Accept through HTTP, with the same Origin a same-origin page sends and
  // with `rejected` forwarded; then the CLI accepts the same statement with
  // the same inputs on a second copy holding the same key.
  const accepted = await post(srv, '/api/accept', { ...payload, why: WHY, explained: EXPLAINED, rejected: REJECTED }, { Origin: `http://127.0.0.1:${srv.port}` });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.ok, true);
  assert.equal(accepted.json.hash, textHash(SPEAKING));
  assert.deepEqual(accepted.json.openAtAccept, checks.map((c) => c.seq), 'the accept records exactly the checks /api/state showed');

  const out = run(second, ['accept', '1.2', '--match', 'Speaking frequency', '--why', WHY, '--explained', EXPLAINED, '--rejected', REJECTED]);
  assert.equal(out.status, 0, out.stdout);
  assert.equal(read(root, 'decisions.md'), read(second, 'decisions.md'));
  assert.equal(read(root, 'canvas.md'), read(second, 'canvas.md'));

  // The DECISION closes the checks it recorded.
  const closed = await request(srv.port, { urlPath: '/api/state', headers: host });
  assert.deepEqual(openOn(closed, '1.2'), [], 'the accept closes the checks it recorded');

  // A comment is always a sealed DISCOVERY.
  const comment = await post(srv, '/api/comment', { ref: '1.2', body: 'Ask the supervisor about chairing.', kind: 'DECISION' });
  assert.equal(comment.status, 200, comment.text);
  assert.match(read(root, 'decisions.md'), new RegExp(`## \\[#${comment.json.seq}\\] \\d{4}-\\d{2}-\\d{2} · DISCOVERY · 1\\.2 · seal ${comment.json.seal}`));

  // Nothing the server touched holds the token.
  for (const dir of [...roots, stateDir]) {
    for (const f of filesUnder(dir)) assert.ok(!fs.readFileSync(f, 'utf8').includes(srv.token), `${f} contains the token`);
  }
});

test('POST /api/choose writes what the CLI choose writes, and takes the same checks as accept', async (t) => {
  const root = projectWithVariants();
  const srv = await start({ root, pluginRoot });
  t.after(() => srv.close());
  const payload = { name: 'sense-making', why: CHOSEN_WHY, rejected: CHOSEN_REJECTED };
  const before = { log: read(root, 'decisions.md'), canvas: read(root, 'canvas.md') };

  // The same request checks as /api/accept: every refusal is a bare 403.
  assert.deepEqual((await post(srv, '/api/choose', payload, { 'X-Harness-Token': undefined })).json, { ok: false, error: 'forbidden' });
  assert.equal((await post(srv, '/api/choose', payload, { 'X-Harness-Token': 'a'.repeat(64) })).status, 403);
  assert.equal((await post(srv, '/api/choose', payload, { Host: `localhost:${srv.port}` })).status, 403);
  assert.equal((await post(srv, '/api/choose', payload, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(srv, '/api/choose', payload, { Origin: `http://localhost:${srv.port}` })).status, 403);
  assert.equal((await post(srv, '/api/choose', payload, { 'Content-Type': 'text/plain' })).status, 403);
  assert.equal(read(root, 'decisions.md'), before.log, 'no refused choose wrote a log entry');
  assert.equal(read(root, 'canvas.md'), before.canvas, 'no refused choose replaced the canvas');

  // The same project on a second checkout with the same key: the server
  // chooses on one, the CLI on the other.
  const second = duplicate(root);
  const chosen = await post(srv, '/api/choose', payload, { Origin: `http://127.0.0.1:${srv.port}` });
  assert.equal(chosen.status, 200, chosen.text);
  assert.equal(chosen.json.ok, true);
  assert.equal(chosen.json.name, 'sense-making');
  assert.equal(chosen.json.lens, 'collective sense-making: "who hears whom"');
  assert.equal(chosen.json.rejected, CHOSEN_REJECTED);

  const out = run(second, ['choose', 'sense-making', '--why', CHOSEN_WHY, '--rejected', CHOSEN_REJECTED]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.equal(read(root, 'decisions.md'), read(second, 'decisions.md'));
  assert.equal(read(root, 'canvas.md'), read(second, 'canvas.md'));
});

test('/api/choose refuses while the main canvas holds an accepted statement, and writes nothing', async (t) => {
  // A fresh project with a variant, then an accepted statement on the main
  // canvas: a framing is chosen before anything is accepted (US-3/B).
  const root = projectWithVariants();
  addStatement(path.join(root, 'research', 'canvas.md'), 'Uptake is what needs explaining. [accepted]');
  const srv = await start({ root, pluginRoot });
  t.after(() => srv.close());
  const before = { log: read(root, 'decisions.md'), canvas: read(root, 'canvas.md') };

  // The refusal is the library's own, and its code is what surfaces: the
  // wording of this refusal is SQ-136's to change, the code is not.
  const refused = await post(srv, '/api/choose', { name: 'power', why: CHOSEN_WHY });
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.json.ok, false);
  assert.equal(refused.json.code, 'already');
  assert.equal(read(root, 'decisions.md'), before.log);
  assert.equal(read(root, 'canvas.md'), before.canvas);

  // The same request on the same project without that statement succeeds, so
  // the refusal above is about the acceptance and not about the call.
  const free = projectWithVariants();
  const other = await start({ root: free, pluginRoot });
  t.after(() => other.close());
  assert.equal((await post(other, '/api/choose', { name: 'power', why: CHOSEN_WHY })).status, 200);
});

test('/api/state lists every variant with its name, lens and state, and none without', async (t) => {
  const root = projectWithVariants();
  const srv = await start({ root, pluginRoot });
  t.after(() => srv.close());
  const state = await request(srv.port, { urlPath: '/api/state', headers: { Host: `127.0.0.1:${srv.port}` } });
  assert.equal(state.status, 200, state.text);
  assert.deepEqual(state.json.variants.map((v) => [v.name, v.lens]), [
    ['power', 'power and hierarchy'],
    ['sense-making', 'collective sense-making: "who hears whom"'],
  ]);

  // Each variant carries its own state: its own statements and its own log,
  // under the project's one key.
  const power = state.json.variants[0];
  assert.ok(!('variants' in power.state), 'a variant holds no variants of its own');
  assert.equal(power.state.project, 'voice-uptake');
  assert.equal(power.state.elements.length, state.json.elements.length);
  const stated = power.state.elements[0].questions.find((q) => q.id === '1.1').statements[0];
  assert.equal(stated.text, 'Uptake follows rank rather than argument.');
  assert.equal(stated.marker, 'proposed');
  assert.equal(stated.hash, textHash(stated.text));
  assert.equal(power.state.elements[0].status.status, 'open');
  const main = state.json.elements[0].questions.find((q) => q.id === '1.1').statements;
  assert.ok(!main.some((s) => s.text === stated.text), 'the variant statement is not the main canvas\'s');

  // A project that holds no variants lists none.
  const plain = keyedProject();
  const bare = await start({ root: plain, pluginRoot });
  t.after(() => bare.close());
  const none = await request(bare.port, { urlPath: '/api/state', headers: { Host: `127.0.0.1:${bare.port}` } });
  assert.deepEqual(none.json.variants, []);
});

test('viewState sends the active profile graph, and null with the error for an unknown profile', () => {
  const root = copyFixture();
  const s = viewState(root, pluginRoot).body;
  assert.deepEqual(s.graph, profileLib.loadProfile('is-qualitative', pluginRoot).graph);
  const canvasFile = path.join(root, 'research', 'canvas.md');
  fs.writeFileSync(canvasFile, fs.readFileSync(canvasFile, 'utf8').replace(/^profile: .*$/m, 'profile: is-quantitative'));
  assert.deepEqual(viewState(root, pluginRoot).body.graph, profileLib.loadProfile('is-quantitative', pluginRoot).graph);
  fs.writeFileSync(canvasFile, fs.readFileSync(canvasFile, 'utf8').replace(/^profile: .*$/m, 'profile: no-such-profile'));
  const broken = viewState(root, pluginRoot).body;
  assert.equal(broken.graph, null);
  assert.match(broken.profileError, /profile not found/);
});

test('viewState passes the active profile\'s checks to the review', () => {
  const root = copyFixture();
  // `is-qualitative` declares no `checks` block: the review reports nothing.
  assert.deepEqual(viewState(root, pluginRoot).body.review.findingsBeforeHypotheses, []);
  const canvasFile = path.join(root, 'research', 'canvas.md');
  fs.writeFileSync(canvasFile, fs.readFileSync(canvasFile, 'utf8').replace(/^profile: .*$/m, 'profile: is-quantitative'));
  // A finding (element 7) with no DECISION on 4 or 6 before it: the check the
  // profile declares reports both.
  fs.appendFileSync(path.join(root, 'research', 'decisions.md'), '\n## [#4] 2026-09-16 · DISCOVERY · 7 Findings\n\nUptake was recorded weeks after the meeting. [tentative]\n');
  assert.deepEqual(viewState(root, pluginRoot).body.review.findingsBeforeHypotheses, [{ element: 4, finding: 4 }, { element: 6, finding: 4 }]);
});

test('the single-use code is traded for the token once, and is no token itself', async (t) => {
  const root = keyedProject();
  const logged = [];
  const srv = await start({ root, pluginRoot, log: (line) => logged.push(line) });
  t.after(() => srv.close());
  assert.match(srv.code, /^[0-9a-f]{32}$/);
  const session = (body, extra) => post(srv, '/api/session', body, { 'X-Harness-Token': undefined, ...extra });
  const payload = { questionId: '1.2', expectedHash: textHash(SPEAKING) };

  // The code is not a write token.
  assert.equal((await post(srv, '/api/accept', payload, { 'X-Harness-Token': srv.code })).status, 403);
  // The exchange takes the same Host, Origin and Content-Type checks as every POST.
  assert.equal((await session({ code: srv.code }, { Host: `localhost:${srv.port}` })).status, 403);
  assert.equal((await session({ code: srv.code }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await session({ code: srv.code }, { 'Content-Type': 'text/plain' })).status, 403);
  // A wrong code is refused and does not burn the right one.
  assert.equal((await session({ code: '0'.repeat(32) })).status, 403);
  assert.equal((await session({})).status, 403);
  assert.deepEqual(logged, []);

  const first = await session({ code: srv.code }, { Origin: `http://127.0.0.1:${srv.port}` });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, { ok: true, token: srv.token });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /^session code redeemed \d{4}-\d{2}-\d{2}T\S+Z$/);

  // A second redemption is refused, and says nothing about the token.
  const again = await session({ code: srv.code });
  assert.equal(again.status, 403);
  assert.deepEqual(again.json, { ok: false, error: 'forbidden' });
  assert.equal(logged.length, 1);

  // The token it handed out writes; the code still does not.
  assert.equal((await post(srv, '/api/accept', payload, { 'X-Harness-Token': srv.code })).status, 403);
  const accepted = await post(srv, '/api/accept', { ...payload, why: WHY, explained: EXPLAINED });
  assert.equal(accepted.status, 200, accepted.text);
});

test('an expired code is refused', async (t) => {
  const srv = await start({ root: keyedProject(), pluginRoot, codeTtlMs: -1 });
  t.after(() => srv.close());
  assert.equal((await post(srv, '/api/session', { code: srv.code }, { 'X-Harness-Token': undefined })).status, 403);
});

test('placet-research serve --no-open prints the code URL, never the token, and stops on SIGINT', { skip: process.platform === 'win32' }, async (t) => {
  const root = keyedProject();
  const child = childProcess.spawn(process.execPath, [cli, 'serve', '--no-open'], {
    cwd: root,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // A failed assertion must not leave the server running.
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let lines = 1;
  let onLine = null;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    stdout += c;
    if (onLine && stdout.split('\n').length > lines) onLine();
  });
  const nextLine = () => new Promise((resolve, reject) => {
    onLine = () => { onLine = null; lines += 1; resolve(); };
    if (stdout.split('\n').length > lines) onLine();
    child.once('exit', () => reject(new Error(`serve exited early: ${stdout}`)));
  });
  await nextLine();
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{32})\n$/.exec(stdout);
  assert.ok(m, stdout);

  // Redeem the printed code as the view would; the terminal says so, and the
  // token the server hands back never appears in stdout.
  const port = Number(m[1]);
  const res = await request(port, {
    method: 'POST',
    urlPath: '/api/session',
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: m[2] }),
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.json.token, /^[0-9a-f]{64}$/);
  await nextLine();
  assert.match(stdout.split('\n')[1], /^session code redeemed \d{4}-\d{2}-\d{2}T\S+Z$/);

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.equal(stdout.split('\n').filter(Boolean).length, 2);
  assert.ok(!/[0-9a-f]{64}/.test(stdout), 'stdout holds no 64-hex token');
  assert.ok(!stdout.includes(res.json.token));
});

test('a write from the view carries the name of the person who started the server', async (t) => {
  // The name belongs to the person, not to the clone: serve reads the same
  // user-wide file the CLI reads, so a comment from the view lands with a By
  // field like every other entry — under the name set here, not the one the
  // other tests in this file use.
  fs.writeFileSync(nameFile, 'B. Supervisor\n');
  t.after(() => fs.writeFileSync(nameFile, `${NAME}\n`));

  const root = keyedProject();
  const srv = await start({ root, pluginRoot });
  t.after(() => srv.close());

  const comment = await post(srv, '/api/comment', { ref: '1.2', body: 'Ask the supervisor about chairing.' });
  assert.equal(comment.status, 200, comment.text);
  assert.match(read(root, 'decisions.md'), new RegExp(`## \\[#${comment.json.seq}\\] \\d{4}-\\d{2}-\\d{2} · DISCOVERY · 1\\.2 · seal ${comment.json.seal}\\nAsk the supervisor about chairing\\.\\n\\*\\*By:\\*\\* B\\. Supervisor\\n`));
});

test('viewState carries the agenda and the human questions, computed by agendaOf', () => {
  const root = copyFixture();
  const { ok, body } = viewState(root, pluginRoot);
  assert.equal(ok, true);
  const state = stateLib.loadState(root, { pluginRoot });
  assert.deepEqual(body.agenda, agendaOf(state.parsed, state.decisionsText));
  assert.deepEqual(body.humanQuestions, HUMAN_QUESTIONS);
});

function appDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-app-data-'));
  roots.push(dir);
  return dir;
}

test('app mode: no project open, token required, open switches the project', async (t) => {
  const srv = await start({ root: null, pluginRoot, app: { dataDir: appDataDir() } });
  t.after(() => srv.close());
  assert.equal(srv.appUrl, `http://127.0.0.1:${srv.port}/app#c=${srv.code}`);
  // The code exchange works with no project open.
  const token = await redeem(srv);
  // The app's routes need the token, the GET among them too.
  assert.equal((await get(srv, '/api/app/projects', null)).status, 403);
  assert.equal((await get(srv, '/api/app/projects', 'a'.repeat(64))).status, 403);
  assert.equal((await post(srv, '/api/app/open', { root: '/' }, { 'X-Harness-Token': undefined })).status, 403);
  const none = await get(srv, '/api/app/projects', token);
  assert.equal(none.status, 200, none.text);
  assert.equal(none.json.current, null);
  const state = await get(srv, '/api/state', token);
  assert.equal(state.status, 409);
  assert.equal(state.json.code, 'no-project');
  assert.equal((await post(srv, '/api/comment', { ref: '1.2', body: 'x' })).status, 409);
  const root = keyedProject();
  const opened = await post(srv, '/api/app/open', { root }, { 'X-Harness-Token': token });
  assert.equal(opened.json.ok, true, opened.text);
  const now = await get(srv, '/api/state', token);
  assert.equal(now.status, 200, now.text);
  assert.equal(now.json.project, 'voice-uptake');
  // The project routes write into the project that was opened.
  const comment = await post(srv, '/api/comment', { ref: '1.2', body: 'Opened from the app.' }, { 'X-Harness-Token': token });
  assert.equal(comment.status, 200, comment.text);
  assert.match(read(root, 'decisions.md'), /Opened from the app\./);
  assert.equal((await get(srv, '/api/app/projects', token)).json.current, root);
  assert.equal((await post(srv, '/api/app/nope', {}, { 'X-Harness-Token': token })).status, 404);
  assert.equal((await post(srv, '/api/app/projects', {}, { 'X-Harness-Token': token })).status, 405);
  assert.equal((await get(srv, '/api/app/open', token)).status, 405);
  const notProject = await post(srv, '/api/app/open', { root: appDataDir() }, { 'X-Harness-Token': token });
  assert.equal(notProject.status, 422);
  assert.equal(notProject.json.code, 'not-project');
});

test('app mode serves the shell page and project mode does not', async (t) => {
  const app = await start({ root: null, pluginRoot, app: { dataDir: appDataDir() } });
  t.after(() => app.close());
  const page = await get(app, '/app', null);
  assert.equal(page.status, 200);
  assert.match(page.text, /^<!doctype html>/i);
  const plain = await start({ root: keyedProject(), pluginRoot });
  t.after(() => plain.close());
  assert.equal(plain.appUrl, undefined);
  assert.equal((await get(plain, '/app', null)).status, 404);
  assert.equal((await get(plain, '/api/app/projects', plain.token)).status, 404);
});

test('app mode: a view refusal for a project without a key names no command, and the CLI keeps its sentence', async (t) => {
  // Today's sentence for a project with no key and an unsealed log: the bytes
  // the app replaces and the command line keeps.
  const NO_KEY = 'No sealing key for this project on this machine, so nothing is written: an entry counts only if it verifies (§4.7). Run `placet-research init --project <slug> --mode <mode>` once here to create the key, then retry.';
  const root = copyFixture();
  const srv = await start({ root, pluginRoot, app: { dataDir: appDataDir() } });
  t.after(() => srv.close());
  const token = await redeem(srv);
  const refused = await post(srv, '/api/comment', { ref: '1.2', body: 'Ask about chairing.' }, { 'X-Harness-Token': token });
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.json.code, 'no-key');
  assert.equal(refused.json.error, 'Join this project first. The key file comes from the co-author who created the project: they save it with Invite co-author… and give it to you by mail or on a USB stick.');
  assert.equal(read(root, 'decisions.md'), fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8'), 'nothing was written');

  // The same project served the way the CLI serves it, and the CLI itself.
  const plain = await start({ root, pluginRoot });
  t.after(() => plain.close());
  const served = await post(plain, '/api/comment', { ref: '1.2', body: 'Ask about chairing.' });
  assert.equal(served.status, 422);
  assert.equal(served.json.code, 'ledger');
  assert.equal(served.json.error, `Cannot log: ${NO_KEY}`);
  const cli = run(root, ['log', 'DISCOVERY', '1.2', '--body', 'Ask about chairing.']);
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(cli.stdout, `Cannot log: ${NO_KEY}\n`);
});

test('placet-research serve --app starts without a project and prints the app URL', { skip: process.platform === 'win32' }, async (t) => {
  const cwd = appDataDir();
  const dataDir = appDataDir();
  const child = childProcess.spawn(process.execPath, [cli, 'serve', '--app', '--app-data', dataDir, '--no-open'], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => { stdout += c; if (stdout.includes('Keep this window open')) resolve(); });
    child.once('exit', () => reject(new Error(`serve exited early: ${stdout}`)));
  });
  // The URL first, then what the start says to the person (SQ-313): the
  // keep-open line, and no Git line while git is found.
  const m = /^http:\/\/127\.0\.0\.1:(\d+)\/app#c=([0-9a-f]{32})\nplacet-research is running in your browser\. Keep this window open while you work; close it to stop\.\n$/.exec(stdout);
  assert.ok(m, stdout);
  const srv = { port: Number(m[1]), code: m[2] };
  const token = await redeem(srv);
  const projects = await get(srv, '/api/app/projects', token);
  assert.equal(projects.status, 200, projects.text);
  assert.equal(projects.json.current, null, 'a folder without a canvas opens no project');
  const root = keyedProject();
  assert.equal((await post(srv, '/api/app/open', { root }, { 'X-Harness-Token': token })).json.ok, true);
  assert.deepEqual(readStore(dataDir).recent, [root], 'recent projects land in --app-data');
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  assert.ok(!stdout.includes(token));
});

// Review Focus 5: git missing is a line, not a refusal. The start still prints
// the URL; the Git line comes before the keep-open line.
test('serve --app without git still starts and says that git was not found', { skip: process.platform === 'win32' }, async (t) => {
  const child = childProcess.spawn(process.execPath, [cli, 'serve', '--app', '--app-data', appDataDir(), '--no-open'], {
    cwd: appDataDir(),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, PLACET_RESEARCH_GIT: path.join(os.tmpdir(), 'rh-no-such-dir', 'git') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => { stdout += c; if (stdout.includes('Keep this window open')) resolve(); });
    child.once('exit', () => reject(new Error(`serve exited early: ${stdout}`)));
  });
  const lines = stdout.trimEnd().split('\n');
  assert.match(lines[0], /^http:\/\/127\.0\.0\.1:\d+\/app#c=[0-9a-f]{32}$/);
  assert.match(lines[1], /^Git was not found\. /);
  assert.match(lines[2], /^placet-research is running in your browser\. Keep this window open/);
  assert.equal(lines.length, 3, stdout);
});

test('the usage names serve --app', () => {
  const out = run(appDataDir(), ['--help']);
  assert.match(out.stdout, /^placet-research serve --app \[--app-data <dir>\] \[--no-open\]$/m);
});

test.after(() => {
  for (const dir of [...roots, stateDir]) fs.rmSync(dir, { recursive: true, force: true });
});

// The view's fonts are served from dashboard/fonts/ by name: the three files it
// references and no other path, with the headers every other answer carries.
test('GET /fonts/<file>.woff2 serves only the allowlisted font files, with the same headers as the rest', async (t) => {
  const srv = await start({ root: keyedProject(), pluginRoot });
  t.after(() => srv.close());
  const host = { Host: `127.0.0.1:${srv.port}` };
  const raw = (urlPath, headers = host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const fontDir = path.join(pluginRoot, 'dashboard', 'fonts');
  const served = ['hanken-grotesk-latin-wght-normal.woff2', 'source-serif-4-latin-wght-normal.woff2', 'source-serif-4-latin-wght-italic.woff2'];
  for (const name of served) {
    const got = await raw(`/fonts/${name}`);
    assert.equal(got.status, 200, name);
    assert.equal(got.headers['content-type'], 'font/woff2');
    assert.equal(got.headers['cache-control'], 'no-store');
    assert.equal(got.headers['x-content-type-options'], 'nosniff');
    assert.equal(got.headers['referrer-policy'], 'no-referrer');
    assert.equal(Number(got.headers['content-length']), got.body.length);
    assert.deepEqual(got.body, fs.readFileSync(path.join(fontDir, name)), `${name} arrives byte for byte`);
    assert.equal(got.body.subarray(0, 4).toString('latin1'), 'wOF2');
  }
  // Present on disk but not allowlisted, traversal, other methods, a foreign Host.
  for (const urlPath of ['/fonts/OFL-HankenGrotesk.txt', '/fonts/', '/fonts', '/fonts/missing.woff2',
    '/fonts/..%2Fcanvas.html', '/fonts/../canvas.html', '/fonts/%2e%2e/bin/canvas-serve.js', '/fonts/hanken-grotesk-latin-wght-normal.woff2/x']) {
    assert.equal((await raw(urlPath)).status, 404, urlPath);
  }
  assert.equal((await raw(`/fonts/${served[0]}`, { Host: 'evil.example' })).status, 403, 'the Host check covers fonts');
  assert.equal((await request(srv.port, { method: 'POST', urlPath: `/fonts/${served[0]}`, headers: { ...host, 'Content-Type': 'application/json', 'X-Harness-Token': srv.token }, body: '{}' })).status, 404);
  assert.deepEqual(fs.readdirSync(fontDir).filter((f) => f.endsWith('.woff2')).sort(), [...served].sort(), 'every shipped font file is on the list, and no other');
});
