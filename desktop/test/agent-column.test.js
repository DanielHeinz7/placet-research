'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try { ({ chromium } = require('playwright')); } catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
// column.html loads xterm from desktop/node_modules; without it the page script throws before it registers its callbacks.
const missingPackages = ['@xterm/xterm/lib/xterm.js', '@xterm/addon-fit/lib/addon-fit.js']
  .map((p) => path.join(__dirname, '..', 'node_modules', p)).filter((p) => !fs.existsSync(p));
const skip = !chromium ? 'Playwright is not installed; run `npm install && npm run setup:browsers` at the repository root.'
  : missingPackages.length ? `The desktop packages are missing (${missingPackages.join(', ')}); run \`npm install\` in desktop/ to fetch them.`
  : false;
const PAGE = pathToFileURL(path.join(__dirname, '..', 'agent', 'column', 'column.html')).href;

const BASE = { version: '2.1.300', plan: 'Claude Pro', guard: null, exit: null, project: '/papers/a', sessionProject: null, canContinue: false, screenReader: false, screenReaderMode: false, pluginVersion: '0.5.0', step: null, fontUrl: null };

// The bundled headless shell may be missing; the full Chromium channel is the fallback the plugin's rendered tests take.
async function launch() {
  try { return await chromium.launch(); } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    return chromium.launch({ channel: 'chromium' });
  }
}

async function open(t, colorScheme) {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ colorScheme, viewport: { width: 560, height: 900 } })).newPage();
  await page.addInitScript(() => {
    const cbs = {};
    window.__calls = { run: [], write: [], reveal: [], lookups: [] };
    window.__words = { '1.2b': "Uptake may be a property of the meeting's …" };
    window.agentColumn = {
      onState: (cb) => { cbs.state = cb; }, onData: (cb) => { cbs.data = cb; }, onClear: (cb) => { cbs.clear = cb; }, onFocus: (cb) => { cbs.focus = cb; },
      run: (s) => window.__calls.run.push(s), write: (d) => window.__calls.write.push(d), resize: () => {},
      lookup: async (n) => { window.__calls.lookups.push(n); return window.__words[n] || null; },
      reveal: (n) => window.__calls.reveal.push(n), focusView: () => {},
    };
    window.__emit = (name, v) => cbs[name](v);
  });
  await page.goto(PAGE);
  return page;
}

test('the preload exposes window.agentColumn and nothing else', () => {
  const exposed = [];
  const sent = [];
  const stub = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push([name, api]) },
    ipcRenderer: { on: () => {}, send: (channel, payload) => sent.push([channel, payload]), invoke: (channel, payload) => { sent.push([channel, payload]); return Promise.resolve(null); } },
  };
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'electron' ? stub : load.call(this, request, ...rest); };
  try { require('../agent/column/preload.js'); } finally { Module._load = load; delete require.cache[require.resolve('../agent/column/preload.js')]; }
  assert.deepEqual(exposed.map(([name]) => name), ['agentColumn']);
  const api = exposed[0][1];
  assert.deepEqual(Object.keys(api).sort(), ['focusView', 'lookup', 'onClear', 'onData', 'onFocus', 'onState', 'resize', 'reveal', 'run', 'write']);
  api.run(5); api.reveal(1.2); api.resize(80, 24);
  assert.deepEqual(sent, [['column:run', '5'], ['column:reveal', '1.2'], ['column:resize', { cols: 80, rows: 24 }]], 'arguments are coerced before they leave the page');
});

for (const colorScheme of ['light', 'dark']) {
  test(`first run: the three steps, each saying what happens, in ${colorScheme}`, { skip, timeout: 60000 }, async (t) => {
    const page = await open(t, colorScheme);
    await page.evaluate((s) => window.__emit('state', s), { ...BASE, phase: 'missing', version: null, plan: null });
    await page.getByRole('heading', { name: 'Agent' }).waitFor();
    assert.match(await page.locator('body').textContent(), /Uses Claude Code with your Claude plan/);
    assert.match(await page.locator('body').textContent(), /Downloads Claude Code from claude\.ai into your home folder\. Anthropic's terms apply\./);
    assert.match(await page.locator('body').textContent(), /Opens your browser to sign in\. Works with Pro, Max and Team plans\./);
    assert.match(await page.locator('body').textContent(), /Bundled with the app.*0\.5\.0/);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Install Claude Code');
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(ring, 'none', 'visible focus');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.__calls.run), ['install']);
    assert.equal(await page.locator('img, svg[aria-label*="Claude" i]').count(), 0, 'no Claude or Anthropic logo');
  });

  test(`running: guard line, plan, terminal; numbers become links with the statement's words in ${colorScheme}`, { skip, timeout: 60000 }, async (t) => {
    const page = await open(t, colorScheme);
    await page.evaluate((s) => window.__emit('state', s), { ...BASE, phase: 'running', sessionProject: '/papers/a', guard: { text: 'Guard on · placet-research 0.5.0', detail: null, warn: false } });
    await page.evaluate(() => window.__emit('data', 'Claude Code 2.1.300: I propose 1.2b and 2.2.\r\n'));
    await page.getByText('Guard on · placet-research 0.5.0').waitFor();
    assert.match(await page.locator('header').textContent(), /Claude Pro/);
    const rows = page.locator('.xterm-rows');
    await rows.getByText('I propose').waitFor();
    // Hover over "1.2b": find its cell from the rendered row and move there.
    const box = await rows.locator('div').first().boundingBox();
    const cell = box.width / (await page.evaluate(() => window.__term.cols));
    const col = 'Claude Code 2.1.300: I propose '.length;
    await page.mouse.move(box.x + cell * (col + 1.5), box.y + box.height / 2);
    await page.getByRole('tooltip').getByText("Uptake may be a property of the meeting's …").waitFor();
    await page.mouse.click(box.x + cell * (col + 1.5), box.y + box.height / 2);
    assert.deepEqual(await page.evaluate(() => window.__calls.reveal), ['1.2b']);
    assert.ok(!(await page.evaluate(() => window.__calls.lookups)).includes('2.1.300'), 'a version is never looked up');
  });

  test(`no marker: the warning uses ink, an icon and words, not red, in ${colorScheme}`, { skip, timeout: 60000 }, async (t) => {
    const page = await open(t, colorScheme);
    await page.evaluate((s) => window.__emit('state', s), { ...BASE, phase: 'running', guard: { text: "Guard not confirmed. The agent's writes may not be checked in this session.", detail: 'The session did not start.', warn: true } });
    const warn = page.locator('.guard.warn');
    await warn.waitFor();
    assert.equal(await warn.locator('svg').count(), 1);
    const color = await warn.evaluate((el) => getComputedStyle(el).color);
    assert.notEqual(color, colorScheme === 'light' ? 'rgb(210, 35, 42)' : 'rgb(255, 113, 118)');
  });
}

test('exited and failed steps say what happened and offer the next step', { skip, timeout: 60000 }, async (t) => {
  const page = await open(t, 'light');
  await page.evaluate((s) => window.__emit('state', s), { ...BASE, phase: 'exited', exit: { code: 2, words: 'Claude Code stopped with exit code 2.' } });
  await page.getByText('Claude Code stopped with exit code 2.').waitFor();
  await page.getByRole('button', { name: 'Start again' }).click();
  await page.evaluate((s) => window.__emit('state', s), { ...BASE, phase: 'outdated', version: '2.1.200' });
  await page.getByText('Claude Code needs an update for the guard to work').waitFor();
  await page.getByRole('button', { name: 'Update Claude Code' }).click();
  assert.deepEqual(await page.evaluate(() => window.__calls.run), ['restart', 'update']);
});

test('the page cannot reach the network', { skip, timeout: 60000 }, async (t) => {
  const page = await open(t, 'light');
  const blocked = await page.evaluate(() => fetch('http://127.0.0.1:9/api/state').then(() => false, () => true));
  assert.equal(blocked, true);
  assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /connect-src 'none'/);
});

test('the first state loads Hanken Grotesk and Source Serif 4 from the plugin fonts the state names', { skip, timeout: 60000 }, async (t) => {
  const page = await open(t, 'light');
  const fontUrl = pathToFileURL(path.join(__dirname, '..', '..', 'plugins', 'placet-research', 'dashboard', 'fonts')).href + '/';
  await page.evaluate((s) => window.__emit('state', s), { ...BASE, phase: 'missing', version: null, plan: null, fontUrl });
  const loaded = await page.waitForFunction(() => {
    const families = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')));
    return families.has('Hanken Grotesk') && families.has('Source Serif 4');
  }, null, { timeout: 5000 }).then(() => true, () => false);
  assert.equal(loaded, true, 'both faces load from the folder in fontUrl');
  assert.deepEqual(await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family)), []);
  assert.equal(await page.evaluate(() => document.fonts.check('700 16px "Hanken Grotesk"')), true, 'the heading weight is covered by the variable face');
});
