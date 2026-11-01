'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../agent/sdk/connection');
const { startFakeModel } = require('./support/fake-model');

test('a gateway URL must be https, or http on this machine, without a password', () => {
  assert.deepEqual(c.validate({ kind: 'gateway', url: 'https://gw.example.edu/anthropic/', model: 'm' }), { ok: true, conn: { kind: 'gateway', url: 'https://gw.example.edu/anthropic', model: 'm' } });
  assert.equal(c.validate({ kind: 'gateway', url: 'http://127.0.0.1:18763', model: 'm' }).ok, true);
  assert.equal(c.validate({ kind: 'gateway', url: 'http://gw.example.edu', model: 'm' }).field, 'url');
  assert.equal(c.validate({ kind: 'gateway', url: 'https://u:p@gw.example.edu', model: 'm' }).field, 'url');
  assert.equal(c.validate({ kind: 'gateway', url: 'gw.example.edu', model: 'm' }).field, 'url');
});

test('each kind needs its fields', () => {
  assert.equal(c.validate({ kind: 'anthropic' }).field, 'model');
  assert.equal(c.validate({ kind: 'bedrock', region: 'Frankfurt', model: 'm', auth: 'key' }).field, 'region');
  assert.equal(c.validate({ kind: 'bedrock', region: 'eu-central-1', model: 'm', auth: 'profile', profile: 'a b' }).field, 'profile');
  assert.equal(c.validate({ kind: 'vertex', projectId: 'P', region: 'europe-west1', model: 'm' }).field, 'projectId');
  assert.equal(c.validate({ kind: 'other', model: 'm' }).field, 'kind');
});

test('the environment for each kind, and which variables are secret', () => {
  assert.deepEqual(c.envFor({ kind: 'anthropic', model: 'm' }, 'S'), { vars: { ANTHROPIC_API_KEY: 'S' }, secretNames: ['ANTHROPIC_API_KEY'] });
  assert.deepEqual(c.envFor({ kind: 'gateway', url: 'https://g', model: 'm' }, 'S'), { vars: { ANTHROPIC_BASE_URL: 'https://g', ANTHROPIC_AUTH_TOKEN: 'S' }, secretNames: ['ANTHROPIC_AUTH_TOKEN'] });
  assert.deepEqual(c.envFor({ kind: 'bedrock', region: 'eu-central-1', model: 'm', auth: 'key' }, 'S'), { vars: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1', AWS_BEARER_TOKEN_BEDROCK: 'S' }, secretNames: ['AWS_BEARER_TOKEN_BEDROCK'] });
  assert.deepEqual(c.envFor({ kind: 'bedrock', region: 'eu-central-1', model: 'm', auth: 'profile', profile: 'lab' }, null), { vars: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-central-1', AWS_PROFILE: 'lab' }, secretNames: [] });
  assert.deepEqual(c.envFor({ kind: 'vertex', projectId: 'lab-123456', region: 'europe-west1', model: 'm' }, null), { vars: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'lab-123456', CLOUD_ML_REGION: 'europe-west1' }, secretNames: [] });
});

test('the model list comes from /v1/models; a gateway without it gets a text field', async () => {
  const fake = await startFakeModel({ models: ['m-1', 'm-2'] });
  try {
    assert.deepEqual(await c.listModels({ kind: 'gateway', url: fake.url, model: '' }, 'tok'), ['m-1', 'm-2']);
    assert.equal(fake.requests[0].headers.authorization, 'Bearer tok');
    assert.equal(await c.listModels({ kind: 'gateway', url: `${fake.url}/nothing-here`, model: '' }, 'tok'), null);
  } finally { await fake.close(); }
});

test('failures in plain words', () => {
  const gw = { kind: 'gateway', url: 'https://gw.example.edu', model: 'm-9' };
  assert.equal(c.describeFailure({ code: 'authentication_failed', conn: gw }), 'The token was refused.');
  assert.equal(c.describeFailure({ code: 'authentication_failed', conn: { kind: 'anthropic', model: 'm' } }), 'The key was refused.');
  assert.equal(c.describeFailure({ code: 'model_not_found', conn: gw }), 'gw.example.edu does not offer m-9.');
  assert.equal(c.describeFailure({ code: 'unreachable', conn: gw }), 'Could not reach gw.example.edu.');
  assert.match(c.describeFailure({ code: 'rate_limit', conn: gw }), /Try again/);
});

test('test connection: ready, refused, unknown model, unreachable, server error', async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { binaryPath } = require('../agent/sdk/binary');
  const { buildTestOptions } = require('../agent/sdk/options');
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const base = { binary: binaryPath(), configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cfg-')), home: os.homedir(), appVersion: '0.0.0' };
  const run = (conn, secret) => c.testConnection({ query, conn, options: buildTestOptions({ ...base, conn, secret }) });

  const ready = await startFakeModel({ script: [[{ type: 'text', text: 'ready' }]] });
  assert.deepEqual(await run({ kind: 'gateway', url: ready.url, model: 'fake-model' }, 'tok'), { ok: true });
  await ready.close();

  const refused = await startFakeModel({ status: { code: 401, type: 'authentication_error', message: 'invalid token' } });
  assert.deepEqual(await run({ kind: 'gateway', url: refused.url, model: 'fake-model' }, 'tok'), { ok: false, error: 'The token was refused.' });
  await refused.close();

  const missing = await startFakeModel({ missingModel: 'fake-model' });
  assert.match((await run({ kind: 'gateway', url: missing.url, model: 'fake-model' }, 'tok')).error, /does not offer fake-model/);
  await missing.close();

  assert.match((await run({ kind: 'gateway', url: 'http://127.0.0.1:9', model: 'fake-model' }, 'tok')).error, /Could not reach 127\.0\.0\.1/);

  const broken = await startFakeModel({ status: { code: 500, type: 'api_error', message: 'Internal server error' } });
  assert.match((await run({ kind: 'gateway', url: broken.url, model: 'fake-model' }, 'tok')).error, /reported a server error\. Try again in a few minutes\./);
  await broken.close();
});
