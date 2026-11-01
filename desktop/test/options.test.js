'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOptions, buildTestOptions, TOOLS } = require('../agent/sdk/options');

const base = { cwd: '/p', pluginRoot: '/plugin', binary: '/bin/claude', shimsDir: '/shims', shimEnv: { RH_ELECTRON: '/e', PATH: '/evil' }, configDir: '/cfg', home: '/h', appVersion: '1.2.3', canUseTool: async () => ({ behavior: 'deny', message: 'x' }) };
const gw = { kind: 'gateway', url: 'https://g', model: 'm' };

test('the exact option set of spec 5.3', () => {
  const o = buildOptions({ ...base, conn: gw, secret: 'S' });
  assert.equal(o.pathToClaudeCodeExecutable, '/bin/claude');
  assert.deepEqual(o.plugins, [{ type: 'local', path: '/plugin' }]);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.cwd, '/p');
  assert.deepEqual(o.tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'Task', 'WebFetch', 'WebSearch']);
  assert.deepEqual(o.tools, TOOLS);
  assert.equal(o.permissionMode, 'acceptEdits');
  assert.equal(o.canUseTool, base.canUseTool);
  assert.deepEqual(o.sandbox, { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, credentials: { envVars: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }] } });
  assert.equal(o.model, 'm');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.includeHookEvents, true);
  assert.equal('resume' in o, false);
  assert.equal(buildOptions({ ...base, conn: gw, secret: 'S', resume: 'abc' }).resume, 'abc');
});

test('env holds only the listed variables, and the shims cannot replace them', () => {
  const o = buildOptions({ ...base, conn: gw, secret: 'S' });
  assert.deepEqual(o.env, {
    RH_ELECTRON: '/e',
    PATH: '/shims:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'research-harness-desktop/1.2.3',
    ANTHROPIC_BASE_URL: 'https://g', ANTHROPIC_AUTH_TOKEN: 'S',
  });
});

test('never bypass, never a replaced prompt, never settings', () => {
  for (const conn of [gw, { kind: 'anthropic', model: 'm' }, { kind: 'vertex', projectId: 'lab-123456', region: 'global', model: 'm' }]) {
    const o = buildOptions({ ...base, conn, secret: 'S' });
    assert.equal(o.allowDangerouslySkipPermissions, undefined);
    assert.notEqual(o.permissionMode, 'bypassPermissions');
    assert.equal(o.systemPrompt, undefined);
    assert.equal(o.settings, undefined);
  }
});

test('every secret variable gets a sandbox deny', () => {
  const o = buildOptions({ ...base, conn: { kind: 'anthropic', model: 'm' }, secret: 'S' });
  assert.deepEqual(o.sandbox.credentials.envVars, [{ name: 'ANTHROPIC_API_KEY', mode: 'deny' }]);
  const v = buildOptions({ ...base, conn: { kind: 'vertex', projectId: 'lab-123456', region: 'global', model: 'm' }, secret: null });
  assert.deepEqual(v.sandbox.credentials.envVars, []);
});

test('the test turn has no tools, no plugin and one turn', () => {
  const o = buildTestOptions({ conn: gw, secret: 'S', binary: '/bin/claude', configDir: '/cfg', home: '/h', appVersion: '1.2.3' });
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.plugins, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.maxTurns, 1);
  assert.equal(o.env.ANTHROPIC_AUTH_TOKEN, 'S');
  assert.equal(o.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('only RH_ variables come through from the shims', () => {
  const shimEnv = { RH_ELECTRON: '/e', ANTHROPIC_BASE_URL: 'https://attacker.example', ANTHROPIC_API_KEY: 'PERSONAL-KEY', NODE_OPTIONS: '--require /x.js' };
  assert.equal(buildOptions({ ...base, shimEnv, conn: { kind: 'anthropic', model: 'm' }, secret: 'S' }).env.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(buildOptions({ ...base, shimEnv, conn: gw, secret: 'S' }).env, {
    RH_ELECTRON: '/e',
    PATH: '/shims:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_AGENT_SDK_CLIENT_APP: 'research-harness-desktop/1.2.3',
    ANTHROPIC_BASE_URL: 'https://g', ANTHROPIC_AUTH_TOKEN: 'S',
  });
});

test('a relative plugin folder is refused', () => {
  for (const pluginRoot of ['plugin', './plugin', '../plugin']) {
    assert.throws(() => buildOptions({ ...base, pluginRoot, conn: gw, secret: 'S' }), /absolute/);
  }
});

test('each call gets its own copy of the tools list', () => {
  buildOptions({ ...base, conn: gw, secret: 'S' }).tools.push('mcp__extra');
  assert.deepEqual(buildOptions({ ...base, conn: gw, secret: 'S' }).tools, ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'Task', 'WebFetch', 'WebSearch']);
  assert.equal(TOOLS.includes('mcp__extra'), false);
});
