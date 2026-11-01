#!/usr/bin/env node
'use strict';
// Runs the "Assumed, not checked" list of the Agent SDK spec (section 3), and
// what the later tasks need to know, against the real Claude Code binary that
// ships with the SDK. The model is always a local fake (test/support/fake-model.js):
// no key, gateway, account or subscription login is used, and the only
// network traffic is to 127.0.0.1.
//
//   node scripts/check-agent-sdk.js [--only C1,C5,...]
//
// One line per check: PASS|FAIL|INFO <id> <what was seen>. Exit 0 when no line
// is FAIL, 1 otherwise. The messages of C3 are written to
// test/fixtures/sdk-messages/guard.jsonl with paths replaced by /project,
// /plugin, /config and /home.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { binaryPath } = require('../agent/sdk/binary');
const { startFakeModel } = require('../test/support/fake-model');
const { startLoggingProxy } = require('../test/support/logging-proxy');
const { shimEnv } = require('../test/support/shim-env');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.join(DESKTOP, '..');
const PLUGIN_SRC = path.join(REPO, 'plugins', 'placet-research');
const PROJECT_SRC = path.join(PLUGIN_SRC, 'test', 'fixtures', 'voice-uptake');
const GUARD_FIXTURE = path.join(DESKTOP, 'test', 'fixtures', 'sdk-messages', 'guard.jsonl');
const MIN_VERSION = [2, 1, 295];

// The SDK's package.json is not in its "exports", so it is read as a file.
const sdkVersion = () => JSON.parse(fs.readFileSync(path.join(DESKTOP, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
let tmpRoot = null;
let scrubs = [];

function scrub(text) {
  let out = String(text);
  for (const [from, to] of scrubs) out = out.split(from).join(to);
  return out;
}
function emit(status, id, text) {
  const line = `${status} ${id} ${scrub(text)}`;
  lines.push(line);
  console.log(line);
}
const pass = (id, text) => emit('PASS', id, text);
const fail = (id, text) => emit('FAIL', id, text);
const info = (id, text) => emit('INFO', id, text);
const verdict = (id, ok, text) => (ok ? pass : fail)(id, text);

// ---------- one query against the real binary ----------

function userMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null };
}

// A fresh project copy, plugin copy and config folder for one run.
function freshDirs(label) {
  const base = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  const project = path.join(base, 'voice-uptake');
  const plugin = path.join(base, 'plugin');
  const config = path.join(base, 'config');
  fs.cpSync(PROJECT_SRC, project, { recursive: true });
  fs.cpSync(PLUGIN_SRC, plugin, { recursive: true });
  fs.mkdirSync(config);
  scrubs = [[project, '/project'], [plugin, '/plugin'], [config, '/config'], ...scrubs.filter(([, to]) => !['/project', '/plugin', '/config'].includes(to))];
  return { base, project, plugin, config };
}

function baseEnv(dirs, fake, secret) {
  return {
    PATH: `${path.join(DESKTOP, 'agent', 'shims')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: os.homedir(),
    CLAUDE_CONFIG_DIR: dirs.config,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_BASE_URL: fake.url,
    ANTHROPIC_AUTH_TOKEN: secret,
    ANTHROPIC_SMALL_FAST_MODEL: 'fake-small',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fake-small',
    ...shimEnv(),
  };
}

// Everything the binary was asked and answered, from the requests the fake saw:
// the tool calls the model made and the results it was shown, whatever the SDK
// chose to forward.
function seenTools(fake) {
  const uses = new Map();
  const results = new Map();
  for (const r of fake.requests) {
    if (r.method !== 'POST' || !r.url.startsWith('/v1/messages') || r.url.includes('count_tokens')) continue;
    let body;
    try { body = JSON.parse(r.body); } catch { continue; }
    for (const m of body.messages || []) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input });
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('');
          results.set(b.tool_use_id, { text, isError: !!b.is_error });
        }
      }
    }
  }
  return [...uses].map(([id, u]) => ({ id, ...u, result: results.get(id) || null }));
}
// The binary lists the subagent tool as Task and shows it to the model as Agent; both names are one tool here.
const sameTool = (a, b) => a === b || (['Task', 'Agent'].includes(a) && ['Task', 'Agent'].includes(b));
const toolsNamed = (fake, name) => seenTools(fake).filter((t) => sameTool(t.name, name));

// Runs one query to its end. `prompts` go in one after the other, each after
// the result of the one before; `waitMs` holds the first back, to see what the
// binary does without a message.
async function drive(ctx, o = {}) {
  const { sdk, secret } = ctx;
  const dirs = o.dirs || freshDirs(o.label || 'run');
  const fake = o.fake || await startFakeModel(o.fakeOpts || {});
  const calls = [];
  const messages = [];
  const stderr = [];
  const state = { pending: null, error: null, timedOut: false };
  const env = { ...baseEnv(dirs, fake, secret), ...(o.env || {}) };
  for (const k of o.dropEnv || []) delete env[k];
  const options = {
    cwd: dirs.project,
    pathToClaudeCodeExecutable: binaryPath(),
    plugins: o.noPlugin ? [] : [{ type: 'local', path: dirs.plugin }],
    settingSources: [],
    model: 'fake-model',
    includeHookEvents: true,
    includePartialMessages: true,
    permissionMode: 'acceptEdits',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'Task', 'WebFetch', 'WebSearch'],
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      credentials: { envVars: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }] },
    },
    env,
    stderr: (d) => stderr.push(d),
    canUseTool: async (toolName, input, opts) => {
      calls.push({ toolName, blockedPath: opts.blockedPath || null });
      const verdictFor = o.decide ? o.decide(toolName, input) : 'allow';
      return verdictFor === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'denied by the check script' };
    },
    ...(o.options || {}),
  };
  const prompts = o.prompts || [];
  let q = null;
  let probe = null;
  async function* input() {
    if (o.waitMs) await sleep(o.waitMs);
    if (o.probe) {
      try { probe = await o.probe(q); } catch (err) { probe = { error: err.message }; }
    }
    for (const text of prompts) {
      let release;
      state.pending = new Promise((r) => { release = r; });
      state.release = release;
      yield userMessage(text);
      await state.pending;
    }
  }
  const t0 = Date.now();
  q = sdk.query({ prompt: input(), options });
  const timer = setTimeout(() => { state.timedOut = true; try { q.close(); } catch { /* already closed */ } if (state.release) state.release(); }, o.timeoutMs || 120000);
  const times = [];
  try {
    for await (const m of q) {
      messages.push(m);
      times.push(Date.now());
      if (m.type === 'result' && state.release) state.release();
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    clearTimeout(timer);
    if (state.release) state.release();
  }
  const ms = Date.now() - t0;
  const keepFake = o.fake;
  if (!keepFake) await fake.close();
  return { messages, times, probe, calls, fake, dirs, ms, error: state.error, timedOut: state.timedOut, stderr: stderr.join('').trim(), secret };
}

const results = (run) => run.messages.filter((m) => m.type === 'result');
const init = (run) => run.messages.find((m) => m.type === 'system' && m.subtype === 'init');
const brief = (s, n = 160) => { const t = scrub(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };

// ---------- the checks ----------

const bash = (command) => ({ type: 'tool_use', name: 'Bash', input: { command } });

async function c1() {
  const out = childProcess.execFileSync(binaryPath(), ['--version'], { encoding: 'utf8' }).trim();
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  const v = m ? m.slice(1).map(Number) : [0, 0, 0];
  const ok = v[0] > MIN_VERSION[0] || (v[0] === MIN_VERSION[0] && (v[1] > MIN_VERSION[1] || (v[1] === MIN_VERSION[1] && v[2] >= MIN_VERSION[2])));
  verdict('C1', ok, `binary says "${out}"; needs ${MIN_VERSION.join('.')} or later; SDK ${sdkVersion()}`);
}

function additionalContext(hr) {
  const raw = hr.stdout || hr.output || '';
  try {
    const j = JSON.parse(raw);
    return j.hookSpecificOutput?.additionalContext ?? j.additionalContext ?? raw;
  } catch { return raw; }
}

async function c2(ctx) {
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms))]);
  const run = await drive(ctx, {
    label: 'c2',
    waitMs: 20000,
    prompts: [],
    timeoutMs: 90000,
    // What the host can ask before the first message: the initialize answer and the plugin list.
    probe: async (query) => ({
      init: await withTimeout(query.initializationResult(), 15000).catch((e) => ({ error: e.message })),
      plugins: await withTimeout(query.reloadPlugins(), 15000).catch((e) => ({ error: e.message })),
    }),
  });
  const order = run.messages.filter((m) => m.type === 'system').map((m) => `${m.subtype}${m.hook_event ? `(${m.hook_event}${m.outcome ? `:${m.outcome}` : ''})` : ''}`);
  const hr = run.messages.find((m) => m.type === 'system' && m.subtype === 'hook_response' && m.hook_event === 'SessionStart');
  const ini = init(run);
  const listed = ini?.plugins?.find((p) => p.name.startsWith('placet-research'));
  const ctxText = hr ? String(additionalContext(hr)).trim() : '';
  const ok = !!hr && hr.outcome === 'success' && ctxText.startsWith('placet-research') && !!listed && listed.path === run.dirs.plugin && run.fake.requests.every((r) => !r.url.startsWith('/v1/messages'));
  verdict('C2', ok, `no user message for 20 s; order of system messages: ${order.join(', ') || 'none'}; SessionStart outcome ${hr?.outcome || 'missing'}, context starts "${brief(ctxText, 40)}"; init lists ${listed ? `${listed.name} ${listed.version || ''} from ${listed.path}` : 'no placet-research plugin'}; model requests before a message: ${run.fake.requests.filter((r) => r.url.startsWith('/v1/messages')).length}${run.error ? `; query ended with: ${brief(run.error)}` : ''}`);
  if (ini) {
    info('C2', `init: claude_code_version ${ini.claude_code_version}; permissionMode ${ini.permissionMode}; apiKeySource ${ini.apiKeySource}; tools ${ini.tools.join(',')}; plugins ${ini.plugins.map((p) => p.name).join(',')}`);
    ctx.tools = ini.tools;
  }
  const p = run.probe || {};
  const ir = p.init || {};
  const pr = p.plugins || {};
  const harness = (pr.plugins || []).find((x) => x.name.startsWith('placet-research'));
  info('C2', `asked with no message yet: initializationResult ${ir.error ? `failed: ${ir.error}` : `answered (plugins_applied ${ir.plugins_applied}, hooks_applied ${ir.hooks_applied}, ${(ir.commands || []).filter((c) => c.name.startsWith('placet-research')).length} placet-research commands such as ${(ir.commands || []).filter((c) => c.name.startsWith('placet-research')).slice(0, 2).map((c) => c.name).join(', ')}, ${(ir.models || []).length} models)`}; reloadPlugins ${pr.error ? `failed: ${pr.error}` : `listed ${(pr.plugins || []).map((x) => `${x.name} ${x.version || ''} ${x.path}`).join('; ')}`}${harness ? '' : ' (no placet-research)'}`);

  // The same start with a first message: where does init fall against the hook and the first model request?
  const withMsg = await drive(ctx, { label: 'c2b', prompts: ['hello'] });
  const firstReq = withMsg.fake.requests.find((r) => r.method === 'POST' && r.url.startsWith('/v1/messages'));
  const idx = (pred) => withMsg.messages.findIndex(pred);
  const hrIdx = idx((m) => m.type === 'system' && m.subtype === 'hook_response' && m.hook_event === 'SessionStart');
  const initIdx = idx((m) => m.type === 'system' && m.subtype === 'init');
  const t0 = withMsg.times[0];
  info('C2', `with a first message: message order ${withMsg.messages.filter((m) => m.type !== 'stream_event').slice(0, 6).map((m) => `${m.type}${m.subtype ? `/${m.subtype}` : ''}`).join(', ')}; SessionStart response at index ${hrIdx}, init at index ${initIdx}; init arrived ${firstReq && withMsg.times[initIdx] ? `${withMsg.times[initIdx] - firstReq.at} ms ${withMsg.times[initIdx] <= firstReq.at ? 'before' : 'after'} the first model request` : 'unknown relative to the first model request'}`);
}

async function c3(ctx) {
  const dirs = freshDirs('c3');
  const canvas = path.join(dirs.project, 'research', 'canvas.md');
  const before = fs.readFileSync(canvas);
  const run = await drive(ctx, {
    dirs,
    prompts: ['Please do the two steps.'],
    fakeOpts: { script: [
      [bash('placet-research accept 3.2 --explained "x"')],
      [{ type: 'tool_use', name: 'Read', input: { file_path: canvas } }],
      [{ type: 'tool_use', name: 'Edit', input: { file_path: canvas, old_string: 'rather than of the proposal. [proposed]', new_string: 'rather than of the proposal. [accepted]' } }],
    ] },
  });
  const b = toolsNamed(run.fake, 'Bash')[0]?.result?.text || '';
  const e = toolsNamed(run.fake, 'Edit')[0]?.result?.text || '';
  const unchanged = Buffer.compare(before, fs.readFileSync(canvas)) === 0;
  verdict('C3', b.startsWith('PreToolUse:Bash hook error:') && e.startsWith('PreToolUse:Edit hook error:') && unchanged, `Bash result "${brief(b, 90)}"; Edit result "${brief(e, 90)}"; canvas bytes ${unchanged ? 'unchanged' : 'CHANGED'}; canUseTool called for: ${run.calls.map((c) => c.toolName).join(',') || 'nothing'}`);
  fs.mkdirSync(path.dirname(GUARD_FIXTURE), { recursive: true });
  fs.writeFileSync(GUARD_FIXTURE, `${run.messages.map((m) => scrub(JSON.stringify(m))).join('\n')}\n`);
  info('C3', `${run.messages.length} messages written to test/fixtures/sdk-messages/guard.jsonl`);
}

async function c4(ctx) {
  const run = await drive(ctx, { label: 'c4', prompts: ['status please'], fakeOpts: { script: [[bash('placet-research status')]] } });
  const t = toolsNamed(run.fake, 'Bash')[0]?.result;
  verdict('C4', !!t && !t.isError && t.text.includes('voice-uptake'), `tool result ${t ? (t.isError ? 'is an error' : 'is not an error') : 'missing'}: "${brief(t?.text || '', 140)}"${run.error ? `; query ended with: ${brief(run.error)}` : ''}`);
}

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function c5c6(ctx) {
  const run = await drive(ctx, { label: 'c5', prompts: ['show the environment'], fakeOpts: { script: [[bash('env')], [bash('echo "[$ANTHROPIC_AUTH_TOKEN]"')]] } });
  const [e, echo] = toolsNamed(run.fake, 'Bash');
  const envText = e?.result?.text || '';
  const echoText = echo?.result?.text || '';
  const sawEnv = envText.includes('PATH=');
  verdict('C5', sawEnv && !envText.includes(ctx.secret) && !echoText.includes(ctx.secret) && /\[\]/.test(echoText), `"env" ${sawEnv ? `printed ${envText.split('\n').length} lines` : `did not run: "${brief(envText, 100)}"`}${envText.includes(ctx.secret) ? ', secret present' : ', secret absent'}; the echo printed "${brief(echoText, 60)}"; ANTHROPIC_AUTH_TOKEN in "env": ${/ANTHROPIC_AUTH_TOKEN/.test(envText) ? 'listed' : 'not listed'}`);
  const hits = [];
  const scan = (dir) => { const all = filesUnder(dir); for (const f of all) if (fs.readFileSync(f).includes(ctx.secret)) hits.push(f); return all.length; };
  const nConfig = scan(run.dirs.config);
  const configHits = hits.length;
  const nProject = scan(run.dirs.project);
  verdict('C6', configHits === 0, `${nConfig} files under the config folder, ${configHits} contain the secret${configHits ? `: ${hits.slice(0, configHits).join(', ')}` : ''}; ${nProject} files in the project folder, ${hits.length - configHits} contain it`);
}

async function c7(ctx) {
  const proxy = await startLoggingProxy();
  try {
    const run = await drive(ctx, { label: 'c7', prompts: ['hello'], env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
    const done = results(run).length === 1;
    verdict('C7', proxy.hosts.length === 0, `hosts the binary tried to reach through the proxy: ${proxy.hosts.length ? proxy.hosts.join(', ') : 'none'}; the turn ${done ? 'finished' : 'did not finish'}`);
  } finally { await proxy.close(); }
}

async function c8(ctx) {
  const taskName = ctx.tools && ctx.tools.includes('Agent') && !ctx.tools.includes('Task') ? 'Agent' : 'Task';
  const dirs = freshDirs('c8');
  const run = await drive(ctx, {
    dirs,
    prompts: ['try five tools'],
    decide: (name) => (name === 'WebFetch' ? 'deny' : 'allow'),
    fakeOpts: { script: [
      [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.org', prompt: 'summarise' } }],
      [{ type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } }],
      [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(dirs.project, 'research', 'notes-check.md'), content: 'a new line\n' } }],
      [{ type: 'tool_use', name: 'Skill', input: { skill: 'placet-research:canvas' } }],
      [{ type: 'tool_use', name: taskName, input: { description: 'check', prompt: 'Reply with one word.', subagent_type: 'general-purpose' } }],
    ] },
  });
  for (const name of ['WebFetch', 'Read', 'Write', 'Skill', taskName]) {
    const asked = run.calls.filter((c) => sameTool(c.toolName, name));
    const seen = toolsNamed(run.fake, name)[0];
    info('C8', `${name}: canUseTool ${asked.length ? `called (blockedPath ${asked[0].blockedPath || 'none'})` : 'not called'}; the model was shown "${brief(seen?.result?.text || 'no result', 90)}"`);
  }
  const r = results(run)[0];
  info('C8', `canUseTool saw, in order: ${run.calls.map((c) => c.toolName).join(',') || 'nothing'}; tool calls the model made: ${seenTools(run.fake).map((t) => `${t.name}${t.result ? '' : ' (no result seen)'}`).join(', ')}; result ${r ? `${r.subtype}, ${r.num_turns} turns` : 'none'}${run.error ? `; query ended with: ${brief(run.error)}` : ''}`);
}

async function c9(ctx) {
  const taskName = ctx.tools && ctx.tools.includes('Agent') && !ctx.tools.includes('Task') ? 'Agent' : 'Task';
  const run = await drive(ctx, {
    label: 'c9',
    prompts: ['delegate'],
    fakeOpts: { script: [
      [{ type: 'tool_use', name: taskName, input: { description: 'check', prompt: 'Run the command.', subagent_type: 'general-purpose' } }],
      [bash('placet-research accept 3.2 --explained "x"')],
    ] },
  });
  const t = toolsNamed(run.fake, 'Bash')[0]?.result?.text;
  verdict('C9', typeof t === 'string' && t.startsWith('PreToolUse:Bash hook error:'), `the subagent's Bash result: "${brief(t || 'none seen', 110)}" (subagent tool "${taskName}")${run.error ? `; query ended with: ${brief(run.error)}` : ''}`);
}

async function c10() {
  const file = path.join(DESKTOP, 'agent', 'sdk', 'keychain.js');
  if (!fs.existsSync(file)) { info('C10', 'not run: agent/sdk/keychain.js does not exist yet; this check runs at the end of Task 3'); return; }
  const { saveSecret, readSecret, removeSecret } = require(file);
  const opts = { service: 'research-harness-desktop-check' };
  const secret = 'a b"c\\d ü';
  try {
    await saveSecret('anthropic', secret, opts);
    const back = await readSecret('anthropic', opts);
    await removeSecret('anthropic', opts);
    const gone = await readSecret('anthropic', opts);
    verdict('C10', back === secret && gone === null, `read ${back === secret ? 'equals' : 'DIFFERS from'} what was written; after remove, read is ${gone === null ? 'null' : 'not null'}`);
  } catch (err) {
    await removeSecret('anthropic', opts).catch(() => {});
    fail('C10', `keychain call failed: ${err.code || ''} ${brief(err.message)}`);
  }
}

async function c11(ctx) {
  const token = `fake-bedrock-${crypto.randomBytes(8).toString('hex')}`;
  const fake = await startFakeModel({});
  try {
    const run = await drive(ctx, {
      label: 'c11',
      fake,
      prompts: ['hello'],
      timeoutMs: 90000,
      dropEnv: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
      env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1', AWS_BEARER_TOKEN_BEDROCK: token, ANTHROPIC_BEDROCK_BASE_URL: fake.url },
      options: { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, credentials: { envVars: [{ name: 'AWS_BEARER_TOKEN_BEDROCK', mode: 'deny' }] } } },
    });
    const got = fake.requests.filter((r) => r.headers.authorization === `Bearer ${token}`);
    verdict('C11', got.length > 0, `${fake.requests.length} requests reached the fake; ${got.length} carried "authorization: Bearer fake-bedrock-..."; paths: ${[...new Set(fake.requests.map((r) => r.url.split('?')[0].replace(/\/model\/[^/]+/, '/model/<id>')))].join(', ') || 'none'}; real Bedrock stays untested${run.error ? `; query ended with: ${brief(run.error)}` : ''}`);
  } finally { await fake.close(); }
}

async function c12(ctx) {
  const id = crypto.randomUUID();
  const run = await drive(ctx, { label: 'c12', prompts: ['hello'], options: { resume: id }, timeoutMs: 60000 });
  const kinds = run.messages.filter((m) => m.type !== 'stream_event').map((m) => `${m.type}${m.subtype ? `/${m.subtype}` : ''}${m.is_error ? ' (error)' : ''}`);
  const r = results(run)[0];
  info('C12', `resume of a session that does not exist: messages ${kinds.join(', ') || 'none'}; result ${r ? `${r.subtype}${r.errors ? ` errors=${JSON.stringify(r.errors)}` : ''}` : 'none'}; the query ${run.error ? `threw "${brief(run.error, 200)}"` : 'ended without throwing'}${run.stderr ? `; stderr "${brief(run.stderr, 200)}"` : ''}; ${run.ms} ms`);
}

async function c13(ctx) {
  const cases = [
    ['401 authentication_error', { fakeOpts: { status: { code: 401, type: 'authentication_error', message: 'invalid x-api-key' } } }],
    ['connection refused (127.0.0.1:9)', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }, timeoutMs: 150000 }],
    ['404 model not found', { fakeOpts: { missingModel: 'fake-model' } }],
    // The binary's retry count can be lowered; these two show whether a test turn can end quickly.
    ['401 authentication_error with CLAUDE_CODE_MAX_RETRIES=1', { fakeOpts: { status: { code: 401, type: 'authentication_error', message: 'invalid x-api-key' } }, env: { CLAUDE_CODE_MAX_RETRIES: '1' }, timeoutMs: 60000 }],
    ['connection refused with CLAUDE_CODE_MAX_RETRIES=1', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', CLAUDE_CODE_MAX_RETRIES: '1' }, timeoutMs: 60000 }],
  ];
  for (const [name, extra] of cases) {
    const run = await drive(ctx, { label: 'c13', prompts: ['Reply with the word ready.'], noPlugin: true, options: { tools: [], maxTurns: 1 }, ...extra });
    const assistantErr = run.messages.filter((m) => m.type === 'assistant').map((m) => m.error).filter(Boolean);
    const retries = run.messages.filter((m) => m.type === 'system' && m.subtype === 'api_retry');
    const apiRetries = `${retries.length}${retries[0] ? ` (first: attempt ${retries[0].attempt} of ${retries[0].max_retries}, status ${retries[0].error_status}, error ${retries[0].error}, wait ${retries[0].retry_delay_ms} ms)` : ''}`;
    const r = results(run)[0];
    info('C13', `${name}: assistant error "${assistantErr.join(',') || 'none'}"; result subtype "${r ? `${r.subtype}${r.is_error ? ', is_error' : ''}` : 'none'}"; api retry messages ${apiRetries}; ended after ${run.ms} ms${run.timedOut ? ' (cut off by the script, still running)' : ''}${run.error ? `; threw "${brief(run.error, 160)}"` : ''}`);
  }
}

async function c14(ctx) {
  const run = await drive(ctx, { label: 'c14', prompts: ['first', 'second'], fakeOpts: { model: 'claude-sonnet-4-5' }, options: { model: 'claude-sonnet-4-5' }, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5' } });
  const rs = results(run);
  const u = (r) => `usage in/out ${r.usage?.input_tokens}/${r.usage?.output_tokens}, total_cost_usd ${r.total_cost_usd}, num_turns ${r.num_turns}`;
  const per = rs.length === 2 && rs[1].usage?.input_tokens === rs[0].usage?.input_tokens;
  info('C14', `${rs.length} results; ${rs.map((r, i) => `turn ${i + 1}: ${u(r)}`).join('; ')}; the fake reports 10/5 tokens per request, so ${rs.length === 2 ? (per ? 'usage is per turn' : 'usage is cumulative') : 'no verdict'} for usage; total_cost_usd ${rs.length === 2 ? (rs[1].total_cost_usd > rs[0].total_cost_usd * 1.5 ? 'is cumulative' : 'looks per turn') : 'no verdict'}`);
}

async function c15(ctx) {
  const run = await drive(ctx, { label: 'c15', prompts: ['/placet-research:canvas'] });
  const messagesRequests = run.fake.requests.filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'));
  const mainRequests = messagesRequests.filter((r) => { try { return JSON.parse(r.body).model === 'fake-model'; } catch { return false; } });
  const last = mainRequests[mainRequests.length - 1];
  const marker = 'You are filling';
  const ini = init(run);
  info('C15', `main-model requests ${mainRequests.length}; the last ${last && last.body.includes(marker) ? 'contains' : 'does not contain'} text from skills/canvas/SKILL.md ("${marker}"); any request contains it: ${mainRequests.some((r) => r.body.includes(marker))}; init slash_commands include placet-research:canvas: ${!!ini?.slash_commands?.some((c) => c === 'placet-research:canvas')}; result ${results(run)[0]?.subtype || 'none'}`);
}

function c16() {
  const dist = path.join(DESKTOP, 'dist');
  const apps = fs.existsSync(dist) ? fs.readdirSync(dist).flatMap((a) => (fs.existsSync(path.join(dist, a)) && fs.statSync(path.join(dist, a)).isDirectory() ? fs.readdirSync(path.join(dist, a)).filter((s) => s.startsWith('mac')).map((s) => path.join(dist, a, s)) : [])) : [];
  const app = apps.map((d) => fs.readdirSync(d).filter((n) => n.endsWith('.app')).map((n) => path.join(d, n))).flat().find((p) => p.includes(`mac-${process.arch}`) || p.includes(`${path.sep}${process.arch}${path.sep}`));
  if (!app) { fail('C16', `no built app for ${process.arch} under dist/; run "npm run dist" first`); return; }
  const bin = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', `claude-agent-sdk-darwin-${process.arch}`, 'claude');
  scrubs.push([app, '<app>']);
  if (!fs.existsSync(bin)) { fail('C16', `${bin} does not exist: the binary is not unpacked outside app.asar`); return; }
  const v = childProcess.spawnSync(bin, ['--version'], { encoding: 'utf8' });
  verdict('C16', v.status === 0 && /\d+\.\d+\.\d+/.test(v.stdout), `unpacked binary ${v.status === 0 ? `runs and prints "${v.stdout.trim()}"` : `exited ${v.status}: ${brief(v.stderr)}`}`);
  const cs = childProcess.spawnSync('codesign', ['-dv', bin], { encoding: 'utf8' });
  const text = `${cs.stdout}${cs.stderr}`;
  const pick = (key) => (text.split('\n').find((l) => l.startsWith(key)) || '').trim();
  info('C16', `codesign: ${[pick('Authority='), pick('Signature='), pick('flags='), pick('Identifier=')].filter(Boolean).join('; ') || brief(text)}`);
}

// ---------- main ----------

const ALL = ['C1', 'C2', 'C3', 'C4', 'C5', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15', 'C16'];

async function main(argv) {
  const only = argv[0] === '--only' ? argv[1].split(',') : null;
  if (argv.length && !only) { console.error('usage: node scripts/check-agent-sdk.js [--only C1,C5,...]'); return 2; }
  const want = (id) => !only || only.includes(id) || (id === 'C5' && only.includes('C6'));
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-sdk-check-')));
  const secret = `fake-secret-${crypto.randomBytes(8).toString('hex')}`;
  scrubs = [[tmpRoot, '/tmp'], [os.homedir(), '/home'], [os.userInfo().username, 'user'], [secret, '<secret>']];
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const ctx = { sdk, secret, tools: null };
  const steps = { C1: c1, C2: c2, C3: c3, C4: c4, C5: c5c6, C7: c7, C8: c8, C9: c9, C10: c10, C11: c11, C12: c12, C13: c13, C14: c14, C15: c15, C16: c16 };
  info('C0', `SDK ${sdkVersion()}; node ${process.version}; ${process.platform}-${process.arch}; ${new Date().toISOString().slice(0, 10)}`);
  for (const id of ALL) {
    if (!want(id)) continue;
    try { await steps[id](ctx); } catch (err) { fail(id, `the check itself failed: ${brief(err.stack || err.message, 300)}`); }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  return lines.some((l) => l.startsWith('FAIL')) ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`check-agent-sdk: ${err.stack}`); process.exitCode = 1; });
