'use strict';
// A local stand-in for the Anthropic Messages API, so the real agent binary
// can run against scripted turns without a network or a model. A request for
// the main model takes the next turn of the script; other models (the
// binary's small helper calls) and an empty script get the text "done".
const http = require('node:http');

function readBody(req) {
  return new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); });
}
function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function error(res, code, type, message) { json(res, code, { type: 'error', error: { type, message } }); }

let ids = 0;
function stream(res, model, blocks) {
  const id = ++ids;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const part of b.parts || [b.text]) send('content_block_delta', { index, delta: { type: 'text_delta', text: part } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${id}_${index}`, name: b.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    send('content_block_stop', { index });
  });
  const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', {});
  res.end();
}

function startFakeModel({ script = [], model = 'fake-model', models = [model], status = null, missingModel = null } = {}) {
  const turns = script.slice();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body, at: Date.now() });
    if (status) return error(res, status.code, status.type, status.message);
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      return json(res, 200, { data: models.map((m) => ({ type: 'model', id: m, display_name: m })), has_more: false });
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages/count_tokens')) return json(res, 200, { input_tokens: 1 });
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      const msg = JSON.parse(body);
      if (msg.model === missingModel) return error(res, 404, 'not_found_error', `model: ${msg.model}`);
      const blocks = msg.model === model && turns.length ? turns.shift() : [{ type: 'text', text: 'done' }];
      return stream(res, msg.model, blocks);
    }
    error(res, 404, 'not_found_error', `${req.method} ${req.url}`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

module.exports = { startFakeModel };
