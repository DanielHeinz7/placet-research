'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeModel } = require('./support/fake-model');

test('the fake model streams scripted turns, then "done"', async () => {
  const fake = await startFakeModel({ script: [[{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]] });
  try {
    const call = () => fetch(`${fake.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'fake-model', stream: true, messages: [] }) }).then((r) => r.text());
    assert.match(await call(), /"name":"Bash"[\s\S]*"stop_reason":"tool_use"/);
    assert.match(await call(), /"text":"done"[\s\S]*"stop_reason":"end_turn"/);
    const models = await fetch(`${fake.url}/v1/models`).then((r) => r.json());
    assert.deepEqual(models.data.map((m) => m.id), ['fake-model']);
  } finally { await fake.close(); }
});

test('the fake model refuses a missing model and a scripted status', async () => {
  const fake = await startFakeModel({ missingModel: 'gone' });
  const r = await fetch(`${fake.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'gone', messages: [] }) });
  assert.equal(r.status, 404);
  await fake.close();
  const refused = await startFakeModel({ status: { code: 401, type: 'authentication_error', message: 'invalid x-api-key' } });
  assert.equal((await fetch(`${refused.url}/v1/models`)).status, 401);
  await refused.close();
});
