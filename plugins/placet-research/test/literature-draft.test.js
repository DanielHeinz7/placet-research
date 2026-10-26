'use strict';

// Real local extraction/checking and a loopback HTTP fixture; never a live model.
// Removing the adapter's respective input, response or publication check must
// break these assertions. All paper, context and model names are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const plugin = path.resolve(__dirname, '..');
const adapter = path.join(plugin, 'scripts/draft-literature-note.py');
const extractor = path.join(plugin, 'scripts/extract-paper.py');
const checker = path.join(plugin, 'scripts/verify-quotes.py');
const fixtures = path.join(__dirname, 'fixtures/literature-note');
const python = process.env.PYTHON || 'python3';
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const body = '# Literature note [proposed]\n\n## Factual account [proposed]\n\n[proposed] An invented study follows meetings.\n\n## Quotations\n\n> "A proposal that is not taken up within the following two turns rarely returns to the floor." (p. 42)\n\n## Project relevance [proposed]\n\n[proposed] Compare the selected framing.\n\n## Transfer limits [proposed]\n\n[proposed] One invented team is not all teams.\n\n## Open questions [proposed]\n\n[proposed] Inspect attribution and numbers manually.\n';
const reply = (content = body, reason = 'stop') => ({ model: 'fixture-model', choices: [{ finish_reason: reason, message: { role: 'assistant', content } }] });

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [adapter, ...args], { cwd: plugin, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function setup(t, handler = (_req, res) => res.end(JSON.stringify(reply()))) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-draft-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'research/variants/alternate'), { recursive: true });
  fs.mkdirSync(path.join(root, 'notes'));
  fs.mkdirSync(path.join(root, 'cache'));
  fs.copyFileSync(path.join(fixtures, 'regular.pdf'), path.join(root, 'paper.pdf'));
  fs.writeFileSync(path.join(root, 'research/canvas.md'), 'DO NOT SEND MAIN CANVAS');
  fs.writeFileSync(path.join(root, 'research/variants/alternate/canvas.md'), '[proposed] Selected framing only.');
  fs.writeFileSync(path.join(root, 'research/variants/alternate/decisions.md'), 'DO NOT CHANGE LEDGER');
  fs.writeFileSync(path.join(root, 'unselected.md'), 'DO NOT SEND SIBLING');
  const extraction = spawnSync(python, [extractor, path.join(root, 'paper.pdf'), '--offset', '40', '--out', path.join(root, 'cache')], { cwd: plugin, encoding: 'utf8' });
  assert.equal(extraction.status, 0, extraction.stdout + extraction.stderr);
  const requests = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, payload: JSON.parse(text), text });
      handler(req, res, requests);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const gateway = path.join(root, 'gateway.json');
  writeJson(gateway, { protocol: 'chat-completions', endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model: 'fixture-model', contextBytes: 100000, maxOutputTokens: 2048, maxResponseBytes: 20000, timeoutSeconds: 10 });
  const inputs = path.join(root, 'inputs.json');
  const input = { pdf: 'paper.pdf', pageMap: 'cache/paper.page-map.json', output: 'notes/proposal.md', bibliography: 'Invented meeting paper', version: 'fixture-v1', drafter: 'fixture-model', reader: 'unknown', readCoverage: 'unknown', context: ['research/variants/alternate/canvas.md'] };
  writeJson(inputs, input);
  const args = ['--project', root, '--variant', 'alternate', '--inputs', inputs, '--gateway-config', gateway];
  return { root, requests, input, inputs, gateway, args, output: path.join(root, 'notes/proposal.md'), report: path.join(root, 'notes/proposal.quote-check.json'), diagnostic: path.join(root, 'cache/proposal.diagnostic.json') };
}

function noFinal(s) {
  assert.equal(fs.existsSync(s.output), false);
  assert.equal(fs.existsSync(s.report), false);
  assert.equal(json(s.diagnostic).status, 'failed');
}

test('supplied frontmatter and explicit variant inputs produce only a hash-bound proposal', async (t) => {
  const s = await setup(t);
  const before = hash(path.join(s.root, 'research/variants/alternate/decisions.md'));
  const result = await run(s.args, { HTTP_PROXY: 'http://127.0.0.1:1', PLACET_RESEARCH_LIBRARY: path.join(s.root, 'unselected.md') });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const note = read(s.output);
  assert.match(note, /status: "proposed"/);
  assert.match(note, /bibliography: "Invented meeting paper"/);
  assert.match(note, /source-version: "fixture-v1"/);
  assert.match(note, /reader: "unknown"/);
  assert.match(note, /read-coverage: "unknown"/);
  assert.match(note, /model: "fixture-model"/);
  assert.match(note, new RegExp(hash(path.join(s.root, 'paper.pdf'))));
  assert.match(note, /\[Source PDF\]\(\.\.\/paper.pdf\)/);
  assert.match(note, /\.\.\/research\/variants\/alternate\/canvas.md/);
  const report = json(s.report);
  assert.equal(report.result, 'verified');
  assert.equal(report.noteFile, s.output);
  assert.equal(report.noteSha256, hash(s.output));
  assert.equal(report.inventory.checked, 1);
  assert.match(result.stdout, /does not accept a research claim/);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, '/v1/chat/completions');
  assert.equal(s.requests[0].payload.model, 'fixture-model');
  assert.equal(s.requests[0].payload.stream, false);
  assert.equal(s.requests[0].payload.tools, undefined);
  assert.equal(s.requests[0].headers.authorization, undefined);
  const sent = JSON.stringify(s.requests[0].payload);
  assert.match(sent, /Selected framing only/);
  assert.doesNotMatch(sent, /DO NOT SEND|DO NOT CHANGE/);
  assert.equal(hash(path.join(s.root, 'research/variants/alternate/decisions.md')), before);
  const checked = spawnSync(python, [checker, '--verify', s.report], { cwd: plugin, encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr);
});

test('failed quotation retains only a local diagnostic draft', async (t) => {
  const s = await setup(t, (_req, res) => res.end(JSON.stringify(reply(body.replace('following two turns', 'following nineteen turns')))));
  const result = await run(s.args);
  assert.notEqual(result.status, 0);
  noFinal(s);
  assert.match(read(path.join(s.root, 'cache/proposal.draft.md')), /nineteen turns/);
  assert.equal(json(s.diagnostic).reason, 'quotation-check-failed');
});

test('existing note or report is never overwritten or sent to the gateway', async (t) => {
  for (const name of ['output', 'report']) {
    const s = await setup(t);
    fs.writeFileSync(s[name], 'KEEP ORIGINAL');
    const result = await run(s.args);
    assert.notEqual(result.status, 0);
    assert.equal(read(s[name]), 'KEEP ORIGINAL');
    assert.equal(s.requests.length, 0);
  }
});

test('source and request-map changes refuse before egress', async (t) => {
  for (const name of ['paper.pdf', 'cache/paper.full.txt', 'cache/paper.request.txt']) {
    const s = await setup(t);
    fs.appendFileSync(path.join(s.root, name), 'changed');
    const result = await run(s.args);
    assert.notEqual(result.status, 0);
    noFinal(s);
    assert.equal(s.requests.length, 0);
  }
});

test('source-map changes during a request cannot publish a final note', async (t) => {
  let s;
  s = await setup(t, (_req, res) => {
    fs.appendFileSync(path.join(s.root, 'cache/paper.page-map.json'), ' ');
    res.end(JSON.stringify(reply()));
  });
  const result = await run(s.args);
  assert.notEqual(result.status, 0);
  noFinal(s);
  assert.equal(s.requests.length, 1);
});

test('missing metadata, escaping context and unselected state refuse before egress', async (t) => {
  for (const patch of [{ version: '' }, { context: ['../outside.md'] }, { context: ['research/canvas.md'] }, { context: ['unselected-missing.md'] }, { output: 'research/variants/alternate/canvas.md' }]) {
    const s = await setup(t);
    writeJson(s.inputs, { ...s.input, ...patch });
    assert.notEqual((await run(s.args)).status, 0);
    assert.equal(s.requests.length, 0);
    assert.equal(read(path.join(s.root, 'research/variants/alternate/canvas.md')), '[proposed] Selected framing only.');
  }
});

test('a differently cased name or a hard link of another state file is never context', async (t) => {
  for (const kind of ['case-variant', 'hard-link']) {
    const s = await setup(t);
    const alias = kind === 'case-variant' ? 'research/CANVAS.md' : 'research/alias.md';
    if (kind === 'hard-link') fs.linkSync(path.join(s.root, 'research/canvas.md'), path.join(s.root, alias));
    writeJson(s.inputs, { ...s.input, context: [alias] });
    const result = await run(s.args);
    assert.notEqual(result.status, 0, kind);
    assert.equal(s.requests.length, 0, kind);
    assert.equal(read(path.join(s.root, 'research/canvas.md')), 'DO NOT SEND MAIN CANVAS');
    // A hard link exists on every filesystem, so the refusal names the guard.
    if (kind === 'hard-link') assert.match(result.stderr, /unselected-state-context/);
  }
});

test('context overflow refuses instead of truncating the selected inputs', async (t) => {
  const s = await setup(t);
  writeJson(s.gateway, { ...json(s.gateway), contextBytes: 50 });
  const result = await run(s.args);
  assert.notEqual(result.status, 0);
  noFinal(s);
  assert.equal(json(s.diagnostic).reason, 'context-overflow');
  assert.equal(s.requests.length, 0);
});

test('timeout, truncated output and malformed templates never publish or retry', async (t) => {
  const cases = [
    (_req, _res) => {},
    (_req, res) => res.end(JSON.stringify(reply(body, 'length'))),
    (_req, res) => res.end(JSON.stringify(reply(body.replace('## Transfer limits [proposed]', '## Other')))),
    (_req, res) => res.end(JSON.stringify(reply('---\nreader: invented-human\n---\n' + body))),
    (_req, res) => res.end(JSON.stringify(reply(body.replace('[proposed] One invented', '[accepted] One invented')))),
    (_req, res) => res.end(JSON.stringify(reply(body + '\n[link](../../unselected.md)'))),
    (_req, res) => res.end(JSON.stringify(reply('x'.repeat(21000)))),
    (_req, res) => res.end('{broken json'),
  ];
  for (const handler of cases) {
    const s = await setup(t, handler);
    writeJson(s.gateway, { ...json(s.gateway), timeoutSeconds: 2 });
    const start = Date.now();
    assert.notEqual((await run(s.args)).status, 0);
    assert.ok(Date.now() - start < 5000, 'owned deadline must terminate the request');
    noFinal(s);
    assert.equal(s.requests.length, 1);
  }
});

test('links in every form and unmarked prose never become a published note', async (t) => {
  const preface = body.replace('# Literature note [proposed]\n\n', '# Literature note [proposed]\n\nAn invented remark.\n\n');
  const cases = [
    ['bare URL', body.replace('follows meetings.', 'follows meetings. See https://example.invalid/paper.'), 'unsupported-response-markup'],
    ['reference link', body.replace('follows meetings.', 'follows meetings [record][inv].'), 'unsupported-response-markup'],
    ['link definition', body.replace('follows meetings.', 'follows meetings.\n\n[inv]: ../../unselected.md'), 'unsupported-response-markup'],
    ['unmarked H1 preface', preface, 'proposal-marker-required'],
    ['unmarked section prose', body.replace('[proposed] Compare the selected framing.', 'Compare the selected framing.'), 'proposal-marker-required'],
    ['non-blockquote Quotations line', body.replace('## Quotations\n\n', '## Quotations\n\nAn invented remark.\n\n'), 'quotation-blockquote-required'],
  ];
  for (const [name, content, reason] of cases) {
    const s = await setup(t, (_req, res) => res.end(JSON.stringify(reply(content))));
    const result = await run(s.args);
    assert.notEqual(result.status, 0, name);
    assert.equal(s.requests.length, 1, name);
    noFinal(s);
    assert.equal(json(s.diagnostic).reason, reason, name);
  }
  // The same preface carrying the marker is prose the template allows.
  const s = await setup(t, (_req, res) => res.end(JSON.stringify(reply(body.replace('# Literature note [proposed]\n\n', '# Literature note [proposed]\n\n[proposed] An invented preface.\n\n')))));
  assert.equal((await run(s.args)).status, 0);
});

test('HTTP errors and redirects do not leak response diagnostics or use a fallback', async (t) => {
  for (const status of [302, 400, 403, 500]) {
    const s = await setup(t, (_req, res) => {
      res.writeHead(status, { Location: '/alternate' });
      res.end('INVENTED_PRIVATE_RESPONSE');
    });
    const result = await run(s.args);
    assert.notEqual(result.status, 0);
    noFinal(s);
    assert.doesNotMatch(result.stdout + result.stderr + read(s.diagnostic), /INVENTED_PRIVATE_RESPONSE/);
    assert.equal(s.requests.length, 1);
  }
});

test('only an explicit credential-free loopback endpoint is admitted', async (t) => {
  for (const endpoint of ['https://example.invalid/v1/chat/completions', 'http://name@127.0.0.1:1/v1/chat/completions', 'http://127.0.0.1:1/v1/chat/completions?token=INVENTED_PRIVATE_CONFIG']) {
    const s = await setup(t);
    writeJson(s.gateway, { ...json(s.gateway), endpoint });
    const result = await run(s.args);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /INVENTED_PRIVATE_CONFIG|name@|example.invalid/);
    assert.equal(s.requests.length, 0);
  }
});

test('explicit library pointer resolves one selected paper without scanning the library', async (t) => {
  const s = await setup(t);
  const library = path.join(s.root, 'library');
  fs.mkdirSync(library);
  fs.renameSync(path.join(s.root, 'paper.pdf'), path.join(library, 'selected.pdf'));
  fs.writeFileSync(path.join(library, 'unselected.txt'), 'DO NOT SEND LIBRARY');
  const mapPath = path.join(s.root, 'cache/paper.page-map.json');
  writeJson(mapPath, { ...json(mapPath), pdfFile: path.join(library, 'selected.pdf') });
  const { pdf: _pdf, ...input } = s.input;
  writeJson(s.inputs, { ...input, libraryPointer: 'selected.pdf' });
  const result = await run(s.args, { PLACET_RESEARCH_LIBRARY: library });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(JSON.stringify(s.requests[0].payload), /DO NOT SEND LIBRARY/);
  assert.match(read(s.output), /\.\.\/library\/selected.pdf/);
});


test('cache reports and dangling output links cannot be overwritten', async (t) => {
  for (const kind of ['cache-report', 'output-link']) {
    const s = await setup(t);
    const target = kind === 'cache-report' ? path.join(s.root, 'cache/proposal.draft.quote-check.json') : path.join(s.root, 'notes/not-created.md');
    if (kind === 'cache-report') fs.writeFileSync(target, 'KEEP CACHE REPORT');
    else fs.symlinkSync(target, s.output);
    const result = await run(s.args);
    assert.notEqual(result.status, 0);
    assert.equal(s.requests.length, 0);
    if (kind === 'cache-report') assert.equal(read(target), 'KEEP CACHE REPORT');
    else assert.equal(fs.existsSync(target), false);
  }
});

test('publication collisions preserve the winner and diagnostic edits cannot alter a successful note', async (t) => {
  for (const collision of ['output', 'report']) {
    let s;
    s = await setup(t, (_req, res) => {
      fs.writeFileSync(s[collision], 'CONCURRENT WINNER');
      res.end(JSON.stringify(reply()));
    });
    assert.notEqual((await run(s.args)).status, 0);
    assert.equal(read(s[collision]), 'CONCURRENT WINNER');
    const other = collision === 'output' ? 'report' : 'output';
    assert.equal(fs.existsSync(s[other]), false);
  }
  const s = await setup(t);
  assert.equal((await run(s.args)).status, 0);
  const before = hash(s.output);
  fs.writeFileSync(path.join(s.root, 'cache/proposal.draft.md'), 'LOCAL CORRECTION');
  assert.equal(hash(s.output), before);
});

test('a tampered mapping and an empty or inline quote inventory fail closed', async (t) => {
  const badMap = await setup(t);
  const mapPath = path.join(badMap.root, 'cache/paper.page-map.json');
  const map = json(mapPath);
  map.pages[1].printed = 99;
  writeJson(mapPath, map);
  assert.notEqual((await run(badMap.args)).status, 0);
  assert.equal(badMap.requests.length, 0);
  for (const replacement of ['[proposed] No quotations supplied.', '"A proposal that is not taken up within the following two turns rarely returns to the floor." (p. 42)']) {
    const s = await setup(t, (_req, res) => res.end(JSON.stringify(reply(body.replace(/^>.*$/m, replacement)))));
    assert.notEqual((await run(s.args)).status, 0);
    noFinal(s);
    assert.equal(s.requests.length, 1);
  }
});


test('the configured byte budget measures the same UTF-8 payload sent on the wire', async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.root, s.input.context[0]), 'Invented context: ' + '漢'.repeat(1000));
  assert.equal((await run(s.args)).status, 0);
  const measured = Buffer.byteLength(s.requests[0].text.replace(/\\u6f22/g, '漢'));
  fs.unlinkSync(s.output);
  fs.unlinkSync(s.report);
  writeJson(s.gateway, { ...json(s.gateway), contextBytes: measured });
  const result = await run(s.args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(Number(s.requests[1].headers['content-length']), measured);
});
