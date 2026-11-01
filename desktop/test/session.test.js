'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSession, askLine } = require('../agent/sdk/session');
const { startFakeModel } = require('./support/fake-model');

const repo = path.join(__dirname, '..', '..');
const pluginSrc = path.join(repo, 'plugins', 'placet-research');

// Task 5 takes the guard's version from the bundled manifest, so the unit
// tests hand it a plugin folder of their own with a known version.
const unitPluginRoot = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sdk-plugin-'));
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'placet-research', version: '0.5.0' }));
  return dir;
})();

const RESULT = { type: 'result', subtype: 'success', usage: {}, total_cost_usd: 0 };

// A query stand-in: yields the given messages, then answers each input with
// `reply`. initializationResult() is the second half of the guard's start
// signals (Task 1's C2): it lists the placet-research commands before any message.
function fakeQuery(messages, reply = [RESULT]) {
  const calls = { interrupted: 0, closed: 0, prompts: [] };
  const query = ({ prompt, options }) => {
    calls.options = options;
    const it = (async function* () {
      for (const m of messages) yield m;
      for await (const user of prompt) { calls.prompts.push(user.message.content); for (const m of reply) yield m; }
    })();
    return Object.assign(it, {
      interrupt: async () => { calls.interrupted += 1; },
      close: () => { calls.closed += 1; it.return(); },
      initializationResult: async () => ({ commands: [{ name: 'placet-research:canvas' }] }),
    });
  };
  return { query, calls };
}
// As in the recording: the hook's JSON is in stdout; output adds stderr to it.
const hookJson = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'placet-research · paper project' } });
const hook = { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart', outcome: 'success', output: hookJson, stdout: hookJson, stderr: '' };
const init = (root) => ({ type: 'system', subtype: 'init', session_id: 's-1', model: 'm', plugins: [{ name: 'placet-research', path: root, version: '0.5.0' }] });

test('nothing is sent before the guard is on', async () => {
  const events = [];
  const { query } = fakeQuery([]);
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: (e) => events.push(e), startTimeoutMs: 50 });
  assert.equal(s.send('hello'), false);
  await s.start();
  assert.deepEqual(events.at(-1), { kind: 'guard', state: 'off', cause: 'The agent did not start within 30 seconds.' });
});

test('guard on, then a message goes out and Send is blocked until the turn ends', async () => {
  const events = [];
  const { query, calls } = fakeQuery([hook, init(unitPluginRoot)]);
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: (e) => events.push(e) });
  const running = s.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events.find((e) => e.kind === 'guard'), { kind: 'guard', state: 'on', version: '0.5.0' });
  assert.equal(s.send('first'), true);
  assert.equal(s.send('second'), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.prompts, ['first']);
  assert.equal(s.send('third'), true);
  s.close();
  await running;
});

test('a later init without the plugin from the bundled path stops the turn', async () => {
  const events = [];
  const { query, calls } = fakeQuery([hook], [init('/elsewhere'), { type: 'assistant', message: { content: [{ type: 'text', text: 'after init' }] } }, RESULT]);
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: (e) => events.push(e) });
  const running = s.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.send('first'), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events.filter((e) => e.kind === 'guard'), [
    { kind: 'guard', state: 'on', version: '0.5.0' },
    { kind: 'guard', state: 'off', cause: 'The placet-research plugin did not load.' },
  ]);
  assert.equal(calls.closed, 1);
  assert.deepEqual(events.slice(events.findIndex((e) => e.kind === 'guard' && e.state === 'off') + 1), []);
  assert.equal(s.send('second'), false);
  s.close();
  await running;
});

test('a sandbox that cannot start keeps the agent off', async () => {
  const events = [];
  const query = () => Object.assign((async function* () { throw new Error('Sandbox is not available on this system'); })(), { interrupt: async () => {}, close: () => {} });
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: (e) => events.push(e) });
  await s.start();
  assert.deepEqual(events.filter((e) => e.kind === 'guard'), [{ kind: 'guard', state: 'off', cause: 'sandbox' }]);
});

test('stop during a tool call denies the open ask and interrupts', async () => {
  const events = [];
  const { query, calls } = fakeQuery([hook, init(unitPluginRoot)]);
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: (e) => events.push(e) });
  const running = s.start();
  await new Promise((r) => setImmediate(r));
  const asked = calls.options.canUseTool('WebFetch', { url: 'https://example.org' }, { signal: new AbortController().signal });
  assert.equal(events.at(-1).kind, 'ask');
  await s.interrupt();
  assert.deepEqual(await asked, { behavior: 'deny', message: 'The researcher stopped the agent.' });
  assert.equal(calls.interrupted, 1);
  assert.deepEqual(events.at(-1), { kind: 'stopped', reason: 'by-person' });
  s.close();
  await running;
});

test('close denies open asks', async () => {
  const { query, calls } = fakeQuery([hook, init(unitPluginRoot)]);
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: () => {} });
  const running = s.start();
  await new Promise((r) => setImmediate(r));
  const asked = calls.options.canUseTool('WebSearch', { query: 'q' }, { signal: new AbortController().signal });
  s.close();
  assert.equal((await asked).behavior, 'deny');
  await running;
});

test('allow once passes the input through; Skill, Task and Agent do not ask', async () => {
  const events = [];
  const { query, calls } = fakeQuery([hook, init(unitPluginRoot)]);
  const s = createSession({ query, options: (canUseTool) => ({ canUseTool }), pluginRoot: unitPluginRoot, cwd: '/p', onEvent: (e) => events.push(e) });
  const running = s.start();
  await new Promise((r) => setImmediate(r));
  const sig = { signal: new AbortController().signal };
  assert.equal((await calls.options.canUseTool('Skill', { skill: 'x' }, sig)).behavior, 'allow');
  // C8: the binary lists the subagent tool as `Task`, the model calls it `Agent`.
  assert.equal((await calls.options.canUseTool('Task', { description: 'x' }, sig)).behavior, 'allow');
  assert.equal((await calls.options.canUseTool('Agent', { description: 'x' }, sig)).behavior, 'allow');
  const asked = calls.options.canUseTool('WebFetch', { url: 'https://example.org' }, sig);
  s.answer(events.at(-1).id, true);
  assert.deepEqual(await asked, { behavior: 'allow', updatedInput: { url: 'https://example.org' } });
  const denied = calls.options.canUseTool('WebFetch', { url: 'https://example.org' }, sig);
  s.answer(events.at(-1).id, false);
  assert.deepEqual(await denied, { behavior: 'deny', message: 'The researcher declined.' });
  s.close();
  await running;
});

test('ask lines in plain words', () => {
  assert.equal(askLine('WebFetch', { url: 'https://example.org/a' }), 'Fetch https://example.org/a');
  assert.equal(askLine('WebSearch', { query: 'uptake' }), 'Search the web for “uptake”');
  assert.equal(askLine('Read', { file_path: '/etc/hosts' }, '/etc/hosts'), 'Read /etc/hosts, outside the project');
  assert.equal(askLine('Edit', { file_path: '/tmp/x' }, '/tmp/x'), 'Edit /tmp/x, outside the project');
  assert.equal(askLine('Bash', { command: 'curl x' }), 'Run curl x');
});

// Integration: real SDK and binary, bundled plugin, fake model.
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sdk-'));
  fs.cpSync(path.join(pluginSrc, 'test', 'fixtures', 'voice-uptake'), path.join(dir, 'project'), { recursive: true });
  fs.cpSync(pluginSrc, path.join(dir, 'plugin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'config'));
  return { dir, cwd: path.join(dir, 'project'), pluginRoot: path.join(dir, 'plugin'), configDir: path.join(dir, 'config') };
}

async function realSession(scriptFor, extra = {}) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { buildOptions } = require('../agent/sdk/options');
  const { binaryPath } = require('../agent/sdk/binary');
  const { shimEnv } = require('./support/shim-env');
  const p = project();
  const fake = await startFakeModel({ script: scriptFor(p) });
  const secret = `fake-secret-${require('node:crypto').randomBytes(8).toString('hex')}`;
  const events = [];
  const conn = { kind: 'gateway', url: fake.url, model: 'fake-model' };
  const s = createSession({
    query, pluginRoot: p.pluginRoot, cwd: p.cwd, onEvent: (e) => events.push(e),
    options: (canUseTool) => buildOptions({ conn, secret, cwd: p.cwd, pluginRoot: p.pluginRoot, binary: binaryPath(), shimsDir: path.join(__dirname, '..', 'agent', 'shims'), shimEnv: shimEnv(), configDir: p.configDir, home: os.homedir(), appVersion: '0.0.0-test', canUseTool, ...extra }),
  });
  return { s, events, fake, p, secret };
}
const until = async (events, pred, ms = 60000) => { const end = Date.now() + ms; while (!events.some(pred)) { if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events.map((e) => e.kind))}`); await new Promise((r) => setTimeout(r, 100)); } };

test('real binary: accept and promotion are refused, the canvas is unchanged', { timeout: 120000 }, async () => {
  const { s, events, fake, p } = await realSession((p) => [
    [{ type: 'tool_use', name: 'Bash', input: { command: 'placet-research accept 3.2 --explained "x"', description: 'accept' } }],
    [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(p.cwd, 'research', 'canvas.md'), old_string: 'rather than of the proposal. [proposed]', new_string: 'rather than of the proposal. [accepted]' } }],
    [{ type: 'text', text: 'Both were refused.' }],
  ]);
  const canvas = path.join(p.cwd, 'research', 'canvas.md');
  const before = fs.readFileSync(canvas);
  const running = s.start();
  await until(events, (e) => e.kind === 'guard');
  assert.equal(events.find((e) => e.kind === 'guard').state, 'on');
  assert.equal(s.send('Accept 3.2 and promote the chairing statement.'), true);
  await until(events, (e) => e.kind === 'turn-end');
  assert.deepEqual(events.filter((e) => e.kind === 'refusal').map((e) => e.tool), ['Bash', 'Edit']);
  assert.deepEqual(fs.readFileSync(canvas), before);
  s.close(); await running; await fake.close();
});

test('real binary: a sandboxed env shows no secret, and no file holds it', { timeout: 120000 }, async () => {
  const { s, events, fake, p, secret } = await realSession(() => [
    [{ type: 'tool_use', name: 'Bash', input: { command: 'env', description: 'env' } }],
    [{ type: 'text', text: 'done' }],
  ]);
  const running = s.start();
  await until(events, (e) => e.kind === 'guard');
  s.send('Show the environment.');
  await until(events, (e) => e.kind === 'turn-end');
  const toolResults = fake.requests.map((r) => r.body).join('\n');
  assert.match(toolResults, /HOME=/);
  assert.ok(!toolResults.includes(secret), 'the secret reached the model through env');
  s.close(); await running; await fake.close();
  for (const file of fs.readdirSync(p.configDir, { recursive: true })) {
    const full = path.join(p.configDir, String(file));
    if (fs.statSync(full).isFile()) assert.ok(!fs.readFileSync(full, 'latin1').includes(secret), full);
  }
});

test('resume of a missing session', { timeout: 120000 }, async () => {
  const { s, events, fake } = await realSession(() => [], { resume: '00000000-0000-4000-8000-000000000000' });
  await s.start();
  assert.ok(events.some((e) => e.kind === 'resume-failed'), JSON.stringify(events));
  await fake.close();
});
