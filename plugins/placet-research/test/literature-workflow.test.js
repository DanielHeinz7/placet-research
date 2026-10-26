'use strict';

// The walkthrough that `references/literature-note.md` documents, on an invented
// paper project and a loopback fake gateway — never a live model. It runs the
// three stages in the documented order, inspects the rendered metadata and
// links, holds the canvas and the ledger byte-identical, and then corrupts a
// quotation and its locator to show that each failure blocks the final note.
// Every paper, project and model name here is invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const plugin = path.resolve(__dirname, '..');
const extractor = path.join(plugin, 'scripts/extract-paper.py');
const adapter = path.join(plugin, 'scripts/draft-literature-note.py');
const checker = path.join(plugin, 'scripts/verify-quotes.py');
const fixture = path.join(__dirname, 'fixtures/literature-note/regular.pdf');
const skill = path.join(plugin, 'skills/literature-note/SKILL.md');
const reference = path.join(plugin, 'references/literature-note.md');
const python = process.env.PYTHON || 'python3';

const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const flat = (text) => text.replace(/^> ?/gm, '').replace(/\s+/g, ' ');

const NOTE = `# Literature note [proposed]

## Factual account [proposed]

[proposed] The invented study follows twelve recorded meetings of one product
team over a quarter and reports that a proposal acknowledged in the next turn
and then dropped rarely comes back.

## Quotations

> "A proposal that is not taken up within the following two turns rarely returns
> to the floor." (p. 42)

## Project relevance [proposed]

[proposed] Compare the selected framing's account of how an idea survives.

## Transfer limits [proposed]

[proposed] One invented product team is not every team.

## Open questions [proposed]

[proposed] Attribution, numbers and paraphrase still need a human reading.
`;

const reply = (content) => ({ model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });

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

// The project the reference's walkthrough describes, the extraction of step 1,
// and the gateway of step 2. `mutate` rewrites what the fake gateway answers, so
// a corrupted response goes through the same documented command as a good one.
async function project(t, mutate = (text) => text) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-literature-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['research', 'sources', 'notes', 'local-cache']) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(fixture, path.join(root, 'sources/meeting-paper.pdf'));
  fs.writeFileSync(path.join(root, 'research/canvas.md'), '---\nprofile: is-qualitative\n---\n\n[proposed] Selected framing: how an idea survives a meeting.\n');
  fs.writeFileSync(path.join(root, 'research/decisions.md'), '# Decision log\n\nNo entries yet.\n');
  fs.writeFileSync(path.join(root, 'notes/selected-sibling.md'), '# Selected sibling\n\n[proposed] An invented sibling note.\n');

  const extraction = spawnSync(
    python,
    [extractor, path.join(root, 'sources/meeting-paper.pdf'), '--offset', '40', '--out', path.join(root, 'local-cache')],
    { cwd: plugin, encoding: 'utf8' },
  );

  const requests = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, payload: JSON.parse(text) });
      res.end(JSON.stringify(reply(mutate(NOTE))));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });

  const gateway = path.join(root, 'gateway.json');
  fs.writeFileSync(gateway, JSON.stringify({
    protocol: 'chat-completions',
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    model: 'fixture-model',
    contextBytes: 100000,
    maxOutputTokens: 2048,
    maxResponseBytes: 20000,
    timeoutSeconds: 10,
  }));
  const inputs = path.join(root, 'inputs.json');
  fs.writeFileSync(inputs, JSON.stringify({
    pdf: 'sources/meeting-paper.pdf',
    pageMap: 'local-cache/meeting-paper.page-map.json',
    output: 'notes/meeting-paper.proposed.md',
    bibliography: 'Invented meeting paper',
    version: 'fixture-v1',
    drafter: 'fixture-model',
    reader: 'unknown',
    readCoverage: 'unknown',
    context: ['research/canvas.md', 'notes/selected-sibling.md'],
  }));
  return {
    root,
    requests,
    extraction,
    args: ['--project', root, '--inputs', inputs, '--gateway-config', gateway],
    cache: path.join(root, 'local-cache'),
    pageMap: path.join(root, 'local-cache/meeting-paper.page-map.json'),
    output: path.join(root, 'notes/meeting-paper.proposed.md'),
    report: path.join(root, 'notes/meeting-paper.proposed.quote-check.json'),
    diagnostic: path.join(root, 'local-cache/meeting-paper.proposed.diagnostic.json'),
    draft: path.join(root, 'local-cache/meeting-paper.proposed.draft.md'),
    state: ['research/canvas.md', 'research/decisions.md'].map((name) => path.join(root, name)),
  };
}

function noFinalNote(s) {
  assert.equal(fs.existsSync(s.output), false, 'a failed run published a final note');
  assert.equal(fs.existsSync(s.report), false, 'a failed run published a quote report');
}

test('the documented walkthrough extracts, drafts and checks one invented paper', async (t) => {
  const s = await project(t);
  assert.equal(s.extraction.status, 0, s.extraction.stdout + s.extraction.stderr);
  assert.match(s.extraction.stdout, /printed pages: 41, 42, 43 \(offset \+40\)/);
  const stateBefore = s.state.map(hash);

  const result = await run(s.args);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // Step 2's rendered metadata: every value supplied by the caller, or unknown.
  const note = read(s.output);
  assert.match(note, /bibliography: "Invented meeting paper"/);
  assert.match(note, /source-version: "fixture-v1"/);
  assert.match(note, /reader: "unknown"/);
  assert.match(note, /read-coverage: "unknown"/);
  assert.match(note, /model: "fixture-model"/);
  assert.match(note, /status: "proposed"/);
  assert.match(note, new RegExp(hash(path.join(s.root, 'sources/meeting-paper.pdf'))));
  assert.match(note, /> "A proposal that is not taken up within the following two turns rarely returns\n> to the floor\." \(p\. 42\)/);
  assert.doesNotMatch(note, /\[(accepted|stated)\]|fact-checked|human-read/);

  // Every relative link resolves, from the note's directory, to the file it names.
  const links = [...note.matchAll(/\]\(([^)]+)\)/g)].map((m) => decodeURIComponent(m[1]));
  assert.deepEqual(links.map((link) => {
    const target = path.resolve(path.dirname(s.output), link);
    assert.equal(fs.existsSync(target), true, `${link} does not resolve`);
    return path.relative(s.root, target);
  }).sort(), [
    'notes/selected-sibling.md',
    'research/canvas.md',
    'sources/meeting-paper.pdf',
  ]);

  // Step 3's report is bound to the bytes it checked.
  const report = json(s.report);
  assert.equal(report.result, 'verified');
  assert.equal(report.noteSha256, hash(s.output));
  assert.equal(report.inventory.checked, 1);
  assert.equal(report.inventory.rejected, 0);
  assert.match(result.stdout, /1 found, 1 parsed, 1 checked, 0 rejected/);
  assert.match(result.stdout, /This check covers only verbatim wording on the claimed printed page\./);

  // One request, to the gateway, without tools and without touching state.
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, '/v1/chat/completions');
  assert.equal(s.requests[0].payload.stream, false);
  assert.equal(s.requests[0].payload.tools, undefined);
  assert.deepEqual(s.state.map(hash), stateBefore, 'the walkthrough changed the canvas or the ledger');
});

test('a corrupted quote and then a corrupted locator each block the final note', async (t) => {
  // Step 3 as the reference describes it: on a copy of the checked note.
  const s = await project(t);
  assert.equal((await run(s.args)).status, 0);
  const checked = read(s.output);

  const cases = [
    { name: 'quote', text: checked.replace('following two turns', 'following nineteen turns'), page: 42 },
    { name: 'locator', text: checked.replace('(p. 42)', '(p. 41)'), page: 41 },
  ];
  for (const corruption of cases) {
    const copy = path.join(s.cache, `corrupted-${corruption.name}.md`);
    fs.writeFileSync(copy, corruption.text);
    const checkedCopy = spawnSync(python, [checker, copy, '--page-map', s.pageMap], { cwd: plugin, encoding: 'utf8' });
    assert.equal(checkedCopy.status, 1, `a corrupted ${corruption.name} passed the check`);
    assert.match(checkedCopy.stdout + checkedCopy.stderr, new RegExp(`not in the source text of printed page ${corruption.page}`));
    const report = json(path.join(s.cache, `corrupted-${corruption.name}.quote-check.json`));
    assert.equal(report.result, 'failed');
    const failed = report.quotations.find((q) => q.status === 'failed');
    assert.equal(failed.printed, corruption.page, `the ${corruption.name} check failed on the wrong claim`);
    assert.match(failed.reason, new RegExp(`not in the source text of printed page ${corruption.page}`));
    assert.equal(report.noteSha256, hash(copy));
  }
  // The copy was checked with `--out` beside it; the published report stands.
  assert.equal(json(s.report).result, 'verified');

  // The same two corruptions through the documented draft command: the model
  // response never becomes a final note.
  for (const corruption of cases) {
    const p = await project(t, (text) => (corruption.name === 'quote' ? text.replace('following two turns', 'following nineteen turns') : text.replace('(p. 42)', '(p. 41)')));
    const stateBefore = p.state.map(hash);
    const result = await run(p.args);
    assert.notEqual(result.status, 0, `a corrupted ${corruption.name} was published`);
    noFinalNote(p);
    assert.equal(json(p.diagnostic).status, 'failed');
    assert.equal(json(p.diagnostic).reason, 'quotation-check-failed');
    assert.match(read(p.draft), corruption.name === 'quote' ? /nineteen turns/ : /\(p\. 41\)/);
    assert.deepEqual(p.state.map(hash), stateBefore, 'a failed run changed the canvas or the ledger');
  }
});

test('the skill and the reference carry the boundary the checker prints', async (t) => {
  const s = await project(t);
  assert.equal((await run(s.args)).status, 0);
  const printed = spawnSync(python, [checker, s.output, '--page-map', s.pageMap, '--out', s.cache], { cwd: plugin, encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stdout + printed.stderr);
  const boundary = printed.stdout.split('\n').map((line) => line.trim()).find((line) => line.startsWith('This check covers only verbatim wording'));
  assert.ok(boundary, 'the checker printed no wording-only boundary');
  assert.match(boundary, /It does not verify paraphrase, numbers or attribution, and it does not accept a research claim\./);
  for (const file of [skill, reference]) {
    assert.ok(flat(read(file)).includes(boundary), `${path.relative(plugin, file)} does not carry the printed boundary`);
  }
});
