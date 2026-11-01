'use strict';
// The panel page, rendered from disk in Chromium with a stand-in for the
// bridge the app's preload gives it. Playwright is a devDependency of the
// repository root, as for the plugin's rendered tests; without it the file is
// skipped, not failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let a11y = null;
try { a11y = require('../../plugins/placet-research/test/helpers/a11y'); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}
const skip = a11y && a11y.chromium ? false : 'Playwright is not installed; run `npm install && npm run setup:browsers` at the repository root.';

const panelUrl = pathToFileURL(path.join(__dirname, '..', 'agent', 'panel', 'panel.html')).href;
const gatewayConnection = { kind: 'gateway', model: 'gw-model-1' };
const sdkState = (connection = gatewayConnection, extra = {}) => ({ way: 'sdk', connection, kindName: connection ? (connection.kind === 'anthropic' ? 'Anthropic API key' : 'Institute gateway') : null, project: '/p', canResume: false, ...extra });

let browser = null;
test.before(async () => { if (!skip) browser = await a11y.launchChromium(); });
test.after(async () => { if (browser) await browser.close(); });

// What the app's preload provides, recording its calls. `cfg` is plain data;
// the stand-in runs inside the page.
function standIn(cfg) {
  const calls = [];
  const listeners = [];
  window.__calls = calls;
  window.__emit = (ev) => listeners.forEach((cb) => cb(ev));
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  const rec = (name, result) => (...args) => { calls.push([name, ...args]); return Promise.resolve(result(...args)); };
  window.agentPanel = {
    state: rec('state', () => cfg.state),
    chooseWay: rec('chooseWay', () => ({ ok: true })),
    hide: rec('hide', () => ({})),
    listModels: rec('listModels', () => ({ ok: true, models: ['m-a', 'm-b'] })),
    connect: rec('connect', () => cfg.connect || { ok: true }),
    removeConnection: rec('removeConnection', () => cfg.remove || { ok: true }),
    start: rec('start', () => cfg.start || { ok: true, model: 'gw-model-1', kindName: 'Institute gateway' }),
    send: rec('send', () => undefined),
    stop: rec('stop', () => undefined),
    answer: rec('answer', () => undefined),
    lookup: (n) => { calls.push(['lookup', n]); return later(cfg.lookupDelay || 0, (cfg.lookup || {})[n] || null); },
    reveal: rec('reveal', () => undefined),
    pickFile: rec('pickFile', () => cfg.file || null),
    openExternal: rec('openExternal', () => undefined),
    onEvent: (cb) => listeners.push(cb),
  };
}

async function open({ scheme = 'light', width = 480, height = 800, state = sdkState(), hash = '', ...cfg } = {}) {
  const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
  const page = await context.newPage();
  page.problems = [];
  page.on('pageerror', (err) => page.problems.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') page.problems.push(msg.text()); });
  await page.addInitScript(standIn, { state, ...cfg });
  await page.goto(panelUrl + hash);
  return page;
}
const calls = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c[0] === n), name);
const emit = (page, ev) => page.evaluate((e) => window.__emit(e), ev);
const active = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);
const closeAll = (page) => page.context().close();

// Each case runs in light and dark.
function both(name, fn, opts = {}) {
  for (const scheme of ['light', 'dark']) {
    test(`${name} (${scheme})`, { skip, timeout: 60000, ...opts }, () => fn(scheme));
  }
}

async function thread(scheme, extra = {}) {
  const page = await open({ scheme, ...extra });
  await page.locator('#v-thread').waitFor();
  await emit(page, { kind: 'guard', state: 'on', version: '0.9.0' });
  await page.waitForFunction(() => document.getElementById('h-state').textContent === 'Ready');
  return page;
}

both('first start: the choice, in tab order, with a visible focus ring', async (scheme) => {
  const page = await open({ scheme, state: { way: null, connection: null, kindName: null, project: '/p', canResume: false } });
  try {
    await page.locator('#choose-h').waitFor();
    assert.equal(await page.locator('#choose-h').textContent(), 'How should the agent connect?');
    assert.equal(await page.locator('#v-choose button').count(), 3);
    assert.deepEqual(await page.locator('#v-choose button').evaluateAll((b) => b.map((n) => (n.querySelector('strong') || n).textContent)), ['Claude Code, with your Claude plan', 'Pay per use', 'Not now']);
    await page.waitForFunction(() => document.activeElement.id === 'way-cc');
    const order = [await active(page)];
    for (let i = 0; i < 2; i++) { await page.keyboard.press('Tab'); order.push(await active(page)); }
    assert.deepEqual(order, ['way-cc', 'way-sdk', 'way-later']);
    const ratios = await a11y.focusContrastRatios(page);
    assert.ok(ratios.length >= 3);
    for (const r of ratios) assert.ok(r.ratio >= 3, `${r.label}: ${r.ratio}`);
    // The ring is drawn by the browser: three pixels wide, offset from the control.
    const ring = await page.locator('#way-later').evaluate((n) => { n.focus(); const s = getComputedStyle(n); return [s.outlineStyle, s.outlineWidth]; });
    assert.deepEqual(ring, ['solid', '3px']);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

both('first start: the choices go to the app', async (scheme) => {
  const page = await open({ scheme, state: { way: null, connection: null, kindName: null, project: '/p', canResume: false } });
  try {
    await page.locator('#way-later').click();
    assert.equal((await calls(page, 'hide')).length, 1);
    await page.locator('#way-cc').click();
    assert.deepEqual((await calls(page, 'chooseWay')).at(-1), ['chooseWay', 'claude-code']);
    await page.locator('#way-sdk').click();
    await page.locator('#connect-h').waitFor();
    assert.deepEqual((await calls(page, 'chooseWay')).at(-1), ['chooseWay', 'sdk']);
  } finally { await closeAll(page); }
});

both('first start: a project opened before a way is chosen keeps the choice', async (scheme) => {
  const page = await open({ scheme, state: { way: null, connection: null, kindName: null, project: null, canResume: false } });
  try {
    await page.locator('#choose-h').waitFor();
    await emit(page, { kind: 'project-changed' });
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'state').length >= 2);
    assert.equal(await page.locator('#v-choose').isVisible(), true);
    assert.equal(await page.locator('#v-connect').isVisible(), false);
    assert.equal(await page.locator('#v-thread').isVisible(), false);
    assert.equal((await calls(page, 'start')).length, 0);
    // Only the choice of Pay per use goes on to the connect form.
    await page.locator('#way-sdk').click();
    await page.locator('#connect-h').waitFor();
    assert.deepEqual((await calls(page, 'chooseWay')).at(-1), ['chooseWay', 'sdk']);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

both('connect: kind decides the fields, a refusal is told next to the button and keeps the secret', async (scheme) => {
  const page = await open({ scheme, state: sdkState(null), connect: { ok: false, error: 'The token was refused.' } });
  try {
    await page.locator('#connect-h').waitFor();
    assert.equal(await page.locator('#get-key').isVisible(), true);
    assert.equal(await page.locator('#l-url').isVisible(), false);
    await page.locator('input[name=kind][value=gateway]').check();
    assert.equal(await page.locator('#l-url').isVisible(), true);
    assert.equal(await page.locator('#get-key').isVisible(), false);
    await page.locator('#f-url').fill('https://gateway.example');
    await page.locator('#f-secret').fill('fake-secret-123');
    await page.locator('#f-model').fill('gw-model-1');
    await page.locator('#connect-go').click();
    await page.locator('#connect-error').waitFor();
    assert.equal(await page.locator('#connect-error').textContent(), 'The token was refused.');
    assert.equal(await page.locator('#f-secret').inputValue(), 'fake-secret-123');
    assert.equal(await page.locator('#connect-error').getAttribute('role'), 'alert');
    assert.equal(await page.locator('#connect-error svg').count(), 1);
    const [, draft, secret] = (await calls(page, 'connect')).at(-1);
    assert.deepEqual([draft.kind, draft.url, draft.model, secret], ['gateway', 'https://gateway.example', 'gw-model-1', 'fake-secret-123']);

    // Bedrock and Vertex ask for different things.
    await page.locator('input[name=kind][value=cloud]').check();
    assert.equal(await page.locator('#f-cloud').isVisible(), true);
    assert.equal(await page.locator('#f-bedrock-auth').isVisible(), true);
    assert.equal(await page.locator('#l-secret').isVisible(), false);
    await page.locator('input[name=bauth][value=key]').check();
    assert.equal(await page.locator('#l-secret').isVisible(), true);
    await page.locator('input[name=cloud][value=vertex]').check();
    assert.equal(await page.locator('#l-project').isVisible(), true);
    assert.equal(await page.locator('#f-bedrock-auth').isVisible(), false);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

both('connect: a refused field is marked and gets the focus, success moves on to the thread', async (scheme) => {
  const bad = await open({ scheme, state: sdkState(null), connect: { ok: false, field: 'url', error: 'The address must start with https://.' } });
  try {
    await bad.locator('input[name=kind][value=gateway]').check();
    await bad.locator('#connect-go').click();
    await bad.locator('#connect-error').waitFor();
    assert.equal(await bad.locator('#f-url').getAttribute('aria-invalid'), 'true');
    assert.equal(await bad.locator('#f-url').getAttribute('aria-describedby'), 'connect-error');
    assert.equal(await active(bad), 'f-url');
  } finally { await closeAll(bad); }
  const good = await open({ scheme, state: sdkState(null) });
  try {
    await good.locator('#f-secret').fill('fake-secret-123');
    await good.locator('#connect-go').click();
    await good.locator('#v-thread').waitFor();
    assert.equal(await good.locator('#f-secret').inputValue(), '');
    assert.equal((await calls(good, 'start')).length, 1);
    assert.equal(await good.locator('#h-model').textContent(), 'gw-model-1 · Institute gateway');
  } finally { await closeAll(good); }
});

both('thread: statement numbers become links from the finished text block only', async (scheme) => {
  const page = await thread(scheme, { lookup: { '3.4': 'Uptake may be a property' } });
  try {
    assert.equal(await page.locator('#h-guard-text').textContent(), 'Guard on · placet-research 0.9.0');
    await emit(page, { kind: 'you', text: 'What is 3.4?' });
    await emit(page, { kind: 'delta', text: 'see 3.' });
    await emit(page, { kind: 'delta', text: '4' });
    assert.equal(await page.locator('#pending').textContent(), 'see 3.4');
    assert.equal(await page.locator('#thread a').count(), 0);
    await emit(page, { kind: 'text', text: 'see 3.4 and 9.99' });
    await page.locator('#thread a.stmt').waitFor();
    assert.equal(await page.locator('#thread a').count(), 1);
    assert.equal(await page.locator('#thread a').textContent(), '3.4');
    assert.equal(await page.locator('#thread a').getAttribute('title'), 'Uptake may be a property');
    assert.equal(await page.locator('#thread li.agent').textContent(), 'Agentsee 3.4 and 9.99');
    assert.equal(await page.locator('#pending').textContent(), '');
    await page.locator('#thread a').click();
    assert.deepEqual((await calls(page, 'reveal')).at(-1), ['reveal', '3.4']);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

both('thread: web addresses, lists and tool lines', async (scheme) => {
  const page = await thread(scheme);
  try {
    await emit(page, { kind: 'text', text: 'Read https://example.org/a now.\n\n- one\n- **two**' });
    await page.locator('#thread li.agent ul').waitFor();
    assert.equal(await page.locator('#thread li.agent ul li').count(), 2);
    assert.equal(await page.locator('#thread li.agent strong').textContent(), 'two');
    await page.getByRole('button', { name: 'Open https://example.org/a' }).click();
    assert.deepEqual((await calls(page, 'openExternal')).at(-1), ['openExternal', 'https://example.org/a']);
    await emit(page, { kind: 'tool', id: 't1', line: 'Read research/canvas.md' });
    await page.locator('#thread details.tool summary').waitFor();
    assert.equal(await page.locator('#thread details.tool summary').textContent(), 'Read research/canvas.md');
  } finally { await closeAll(page); }
});

both('thread: events stay in order while a statement lookup is pending', async (scheme) => {
  const page = await thread(scheme, { lookupDelay: 250, lookup: { '3.4': 'Uptake may be a property' } });
  try {
    await emit(page, { kind: 'text', text: 'see 3.4' });
    await emit(page, { kind: 'tool', id: 't1', line: 'Read next.md' });
    await page.locator('#thread li.tool-line').waitFor();
    assert.deepEqual(await page.locator('#thread > li').evaluateAll((items) => items.map((n) => n.className)), ['agent', 'tool-line']);
  } finally { await closeAll(page); }
});

both('refusal: the line says whose step it is, in ink and not in red', async (scheme) => {
  const page = await thread(scheme);
  try {
    await emit(page, { kind: 'refusal', id: 'r1', tool: 'Bash', reason: 'accept is only for the researcher', statement: '3.2' });
    const line = page.locator('#thread li.refusal');
    await line.waitFor();
    assert.match(await line.locator('p').first().textContent(), /^\s*Refused by the guard: accepting is your step\.$/);
    assert.equal(await line.getByRole('button', { name: 'Open 3.2' }).count(), 1);
    const { color, ink } = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--ink)';
      document.body.append(probe);
      return { color: getComputedStyle(document.querySelector('#thread li.refusal')).color, ink: getComputedStyle(probe).color };
    });
    assert.equal(color, ink);
    await line.getByRole('button', { name: 'Open 3.2' }).click();
    assert.deepEqual((await calls(page, 'reveal')).at(-1), ['reveal', '3.2']);
    await emit(page, { kind: 'refusal', id: 'r2', tool: 'Write', reason: 'not yours', statement: null });
    await page.locator('#thread li.refusal').nth(1).waitFor();
    assert.match(await page.locator('#thread li.refusal').nth(1).locator('p').first().textContent(), /this step is yours\.$/);
  } finally { await closeAll(page); }
});

both('ask: focus goes to Allow once, Deny answers and closes the question', async (scheme) => {
  const page = await thread(scheme);
  try {
    await emit(page, { kind: 'ask', id: '7', line: 'run git status' });
    await page.locator('#thread li.ask').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Allow once');
    await page.getByRole('button', { name: 'Deny' }).click();
    assert.deepEqual((await calls(page, 'answer')).at(-1), ['answer', '7', false]);
    assert.equal(await page.getByRole('button', { name: 'Allow once' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Deny' }).isDisabled(), true);
    assert.equal(await page.locator('#thread li.ask .meta').textContent(), 'Denied.');
  } finally { await closeAll(page); }
});

both('model output is text: no element is made from it, and the policy blocks inline script', async (scheme) => {
  const page = await thread(scheme);
  try {
    await emit(page, { kind: 'text', text: '<img src=x onerror="window.pwned=1"> <b>bold</b>' });
    await page.locator('#thread li.agent').waitFor();
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.equal(await page.locator('#thread img').count(), 0);
    assert.equal(await page.locator('#thread b').count(), 0);
    assert.equal(await page.locator('#thread li.agent p').textContent(), '<img src=x onerror="window.pwned=1"> <b>bold</b>');
    // The policy allows the page's own scripts and styles only.
    const inline = await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.inline = 1'; document.body.append(s); return window.inline; });
    assert.equal(inline, undefined);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-|\*/);
  } finally { await closeAll(page); }
});

both('usage: dollars only for an Anthropic key', async (scheme) => {
  const gw = await thread(scheme);
  try {
    await emit(gw, { kind: 'usage', tokens: 1200, costUsd: 0.5, connKind: 'gateway' });
    assert.equal(await gw.locator('#usage').textContent(), 'This conversation: 1,200 tokens');
  } finally { await closeAll(gw); }
  const an = await thread(scheme, { state: sdkState({ kind: 'anthropic', model: 'm' }) });
  try {
    await emit(an, { kind: 'usage', tokens: 1200, costUsd: 0.5, connKind: 'anthropic' });
    assert.match(await an.locator('#usage').textContent(), /about \$0\.50 at Anthropic’s list prices$/);
  } finally { await closeAll(an); }
});

both('errors are told in the column with the next step, never as a toast', async (scheme) => {
  const page = await thread(scheme);
  try {
    await emit(page, { kind: 'error', code: 'rate_limit' });
    await emit(page, { kind: 'error', code: 'authentication_failed' });
    await page.locator('#thread li.problem').nth(1).waitFor();
    assert.equal(await page.locator('#thread li.problem').nth(0).textContent(), 'The model is busy or the usage limit is reached. Try again in a minute.');
    assert.match(await page.locator('#thread li.problem').nth(1).textContent(), /^The key was refused\. Change it in Agent settings\./);
    assert.equal(await page.locator('#thread li.problem svg').count(), 2);
    await page.locator('#thread').getByRole('button', { name: 'Agent settings' }).click();
    await page.locator('#settings-h').waitFor();
    // A guard that is off ends the conversation in words, with a way to try again.
    await page.locator('#s-back').click();
    await emit(page, { kind: 'guard', state: 'off', cause: 'The agent did not start within 30 seconds.' });
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.equal(await page.locator('#h-guard-text').textContent(), 'Guard off');
    assert.equal(await page.locator('#send').isDisabled(), true);
    assert.equal(await page.locator('#thread li.problem').last().locator('span').textContent(), 'The agent did not start within 30 seconds.');
    // A guard that started but found no paper project does not say it did not start.
    const noPaper = 'The placet-research guard started but found no paper project here. Open a folder made with New project… or Clone…';
    await emit(page, { kind: 'guard', state: 'off', cause: noPaper });
    await page.waitForFunction((t) => [...document.querySelectorAll('#thread li.problem span')].some((s) => s.textContent === t), noPaper);
    assert.equal(await page.locator('#thread li.problem').last().locator('span').textContent(), noPaper);
    // A start hook that did not run keeps the sentence before it.
    await emit(page, { kind: 'guard', state: 'off', cause: 'The placet-research start hook failed.' });
    await page.waitForFunction(() => [...document.querySelectorAll('#thread li.problem span')].some((s) => s.textContent === 'The guard did not start, so the agent stays off. The placet-research start hook failed.'));
  } finally { await closeAll(page); }
});

both('the thread is a log region and the streamed line is not announced', async (scheme) => {
  const page = await thread(scheme);
  try {
    assert.equal(await page.locator('#thread').getAttribute('role'), 'log');
    assert.equal(await page.locator('#pending').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.locator('#thread').evaluate((n) => n.tagName), 'OL');
  } finally { await closeAll(page); }
});

both('keyboard: Cmd+Enter sends, Send is off and Stop on while working, Escape keeps the draft', async (scheme) => {
  const page = await thread(scheme);
  try {
    await page.locator('#msg').focus();
    await page.keyboard.type('hello agent');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#msg').inputValue(), 'hello agent');
    await page.keyboard.press('Meta+Enter');
    assert.deepEqual((await calls(page, 'send')).at(-1), ['send', 'hello agent']);
    assert.equal(await page.locator('#send').isDisabled(), true);
    assert.equal(await page.locator('#stop').isVisible(), true);
    assert.equal(await page.locator('#h-state').textContent(), 'Working');
    assert.equal(await page.locator('#msg').inputValue(), '');
    // A second press while the agent works sends nothing.
    await page.locator('#msg').evaluate((n) => { n.readOnly = false; n.value = 'again'; });
    await page.keyboard.press('Control+Enter');
    assert.equal((await calls(page, 'send')).length, 1);
    await page.locator('#stop').click();
    assert.equal((await calls(page, 'stop')).length, 1);
    await emit(page, { kind: 'stopped', reason: 'by-person' });
    await page.locator('#thread li.meta').waitFor();
    assert.equal(await page.locator('#thread li.meta').textContent(), 'Stopped.');
    assert.equal(await page.locator('#send').isDisabled(), false);
    assert.equal(await page.locator('#stop').isVisible(), false);
    assert.equal(await page.locator('#h-state').textContent(), 'Stopped');
  } finally { await closeAll(page); }
});

both('the quick actions send their command and are off while working', async (scheme) => {
  const page = await thread(scheme, { file: '/tmp/note-source.pdf' });
  try {
    await page.getByRole('button', { name: 'Continue canvas' }).click();
    assert.deepEqual((await calls(page, 'send')).at(-1), ['send', '/placet-research:canvas']);
    assert.equal(await page.getByRole('button', { name: 'Review canvas' }).isDisabled(), true);
    assert.equal((await calls(page, 'send')).length, 1);
    await emit(page, { kind: 'turn-end' });
    await page.getByRole('button', { name: 'Literature note…' }).click();
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'send').length === 2);
    assert.deepEqual((await calls(page, 'send')).at(-1), ['send', '/placet-research:literature-note /tmp/note-source.pdf']);
  } finally { await closeAll(page); }
});

both('resume: the person chooses between the last conversation and a new one', async (scheme) => {
  const page = await open({ scheme, state: sdkState(gatewayConnection, { canResume: true }) });
  try {
    await page.locator('#resume').waitFor();
    await page.waitForFunction(() => document.activeElement.id === 'resume-go');
    assert.equal((await calls(page, 'start')).length, 0);
    await page.locator('#resume-go').click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'start'));
    assert.deepEqual((await calls(page, 'start')).at(-1), ['start', { resume: true }]);
    assert.equal(await page.locator('#resume').isVisible(), false);
    await emit(page, { kind: 'resume-failed' });
    await page.getByText('The last conversation could not be found; started a new one.').waitFor();
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'start').length === 2);
    assert.deepEqual((await calls(page, 'start')).at(-1), ['start', { resume: false }]);
  } finally { await closeAll(page); }
});

both('start: a missing key sends the person to the connect form with the words', async (scheme) => {
  const page = await open({ scheme, start: { ok: false, error: 'The key is no longer in the Keychain.', next: 'connect' } });
  try {
    await page.locator('#connect-h').waitFor();
    assert.equal(await page.locator('#connect-error').textContent(), 'The key is no longer in the Keychain.');
  } finally { await closeAll(page); }
});

both('settings: opens from the hash, asks before ending a conversation, and Back keeps it', async (scheme) => {
  const page = await open({ scheme, state: sdkState() });
  try {
    await page.locator('#v-thread').waitFor();
    await emit(page, { kind: 'guard', state: 'on', version: '0.9.0' });
    await emit(page, { kind: 'you', text: 'hello' });
    await page.locator('#thread li.you').waitFor();
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.locator('#settings-h').waitFor();
    assert.equal(await page.locator('#s-current').textContent(), 'Institute gateway, model gw-model-1.');
    assert.equal(await active(page), 's-change');
    // Cancel keeps everything and gives the focus back.
    await page.locator('#s-change').click();
    await page.locator('#dlg').waitFor();
    assert.match(await page.locator('#dlg-text').textContent(), /ends the current conversation/);
    assert.equal(await page.locator('#dlg-title').textContent(), 'End the conversation?');
    assert.equal(await page.locator('#dlg-ok').textContent(), 'End conversation');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('dlg').open);
    assert.equal(await active(page), 's-change');
    assert.equal(await page.locator('#v-connect').isVisible(), false);
    // Back returns to the running conversation without starting another.
    await page.locator('#s-back').click();
    assert.equal(await page.locator('#thread li.you').count(), 1);
    assert.equal((await calls(page, 'start')).length, 1);
    // Removing: asked first, then the connect form.
    await page.evaluate(() => { location.hash = ''; location.hash = '#settings'; });
    await page.locator('#s-remove').click();
    await page.locator('#dlg').waitFor();
    assert.match(await page.locator('#dlg-text').textContent(), /deletes the saved key from the Keychain/);
    assert.equal(await page.locator('#dlg-title').textContent(), 'Remove the saved key?');
    assert.equal(await page.locator('#dlg-ok').textContent(), 'Remove key');
    await page.locator('#dlg-ok').click();
    await page.locator('#connect-h').waitFor();
    assert.equal((await calls(page, 'removeConnection')).length, 1);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

both('settings: a key that cannot be removed is told in words and the connection stays', async (scheme) => {
  const page = await open({ scheme, hash: '#settings', remove: { ok: false, error: 'The saved key could not be removed from the Keychain. Try again, or delete it in Keychain Access.' } });
  try {
    await page.locator('#settings-h').waitFor();
    await page.locator('#s-remove').click();
    await page.locator('#s-error').waitFor();
    assert.match(await page.locator('#s-error').textContent(), /^The saved key could not be removed/);
    assert.equal(await page.locator('#v-connect').isVisible(), false);
    assert.equal(await active(page), 's-remove');
    // With no conversation to end, nothing is asked.
    await page.locator('#s-way').click();
    assert.deepEqual((await calls(page, 'chooseWay')).at(-1), ['chooseWay', 'claude-code']);
  } finally { await closeAll(page); }
});

both('reflow: no sideways scroll down to 280 px in any view, focus ring visible', async (scheme) => {
  const narrow = { scheme, width: 280, height: 700 };
  const check = async (page, label) => {
    await page.keyboard.press('Shift');                         // script focus shows the ring only after a key press
    const { document: doc, viewport } = await a11y.documentWidths(page);
    assert.ok(doc <= viewport, `${label}: document ${doc} wider than viewport ${viewport}`);
    for (const r of await a11y.focusContrastRatios(page)) assert.ok(r.ratio >= 3, `${label}, ${r.label}: ${r.ratio}`);
  };
  const choose = await open({ ...narrow, state: { way: null, connection: null, kindName: null, project: '/p', canResume: false } });
  try { await choose.locator('#choose-h').waitFor(); await check(choose, 'choose'); } finally { await closeAll(choose); }

  const connect = await open({ ...narrow, state: sdkState(null) });
  try {
    await connect.locator('#connect-h').waitFor();
    await connect.locator('input[name=kind][value=cloud]').check();
    await check(connect, 'connect, cloud');
    await connect.locator('input[name=kind][value=gateway]').check();
    await connect.locator('#f-url').fill(`https://${'long-gateway-name.'.repeat(6)}example`);
    await connect.evaluate(() => { document.getElementById('connect-error-text').textContent = 'The token was refused. Check it, then try again. '.repeat(3); document.getElementById('connect-error').hidden = false; });
    await check(connect, 'connect, gateway');
  } finally { await closeAll(connect); }

  const chat = await thread(scheme, { width: 280, height: 700 });
  try {
    await emit(chat, { kind: 'you', text: 'x'.repeat(120) });
    await emit(chat, { kind: 'text', text: `Read https://example.org/${'a'.repeat(100)} and \`${'b'.repeat(90)}\`\n\n- ${'word '.repeat(30)}` });
    await emit(chat, { kind: 'tool', id: 't', line: `Read ${'folder/'.repeat(30)}file.md` });
    await emit(chat, { kind: 'ask', id: '1', line: `run ${'long-command '.repeat(10)}` });
    await chat.locator('#thread li.ask').waitFor();
    await check(chat, 'thread');
    await chat.evaluate(() => { location.hash = '#settings'; });
    await chat.locator('#settings-h').waitFor();
    await check(chat, 'settings');
  } finally { await closeAll(chat); }
});

test('the page stays inside its policy: no remote address, no inline handler, no innerHTML', () => {
  const fs = require('node:fs');
  const dir = path.join(__dirname, '..', 'agent', 'panel');
  for (const f of ['panel.html', 'panel.css', 'panel.js', 'render.js', 'preload.js']) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f);
    assert.doesNotMatch(text, /@import|url\(\s*['"]?https?:/, f);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'panel.html'), 'utf8'), /\son[a-z]+=|<style|<script>[^<]/i);
  // Fonts come from the page's own files and nowhere else.
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(path.join(dir, 'panel.html'), 'utf8'))[1];
  assert.deepEqual(csp.split(';').map((d) => d.trim()).filter((d) => d.startsWith('font-src')), ["font-src 'self'"]);
});

// -- The six fixes from the finish review (SQ-319), at the two widths the review used. --

const WIDTHS = [280, 480];
function bothWidths(name, fn) {
  both(name, async (scheme) => { for (const width of WIDTHS) await fn(scheme, width); });
}
const box = (page, selector) => page.locator(selector).first().evaluate((n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; });
// How many lines the text inside a control is set on.
const lines = (locator) => locator.evaluate((n) => { const r = document.createRange(); r.selectNodeContents(n); return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size; });

bothWidths('fix 1: "Try again" and "Agent settings" stay whole words on one line', async (scheme, width) => {
  const page = await thread(scheme, { width, height: 800 });
  try {
    await emit(page, { kind: 'guard', state: 'off', cause: 'The placet-research start hook failed.' });
    const again = page.getByRole('button', { name: 'Try again' });
    await again.waitFor();
    assert.equal(await lines(again), 1, `Try again on ${await lines(again)} lines at ${width}px`);
    assert.ok((await box(page, '#thread li.problem button')).height < 60, 'Try again is one button-high');
    await emit(page, { kind: 'error', code: 'authentication_failed' });
    const settings = page.locator('#thread').getByRole('button', { name: 'Agent settings' });
    await settings.waitFor();
    assert.equal(await lines(settings), 1, `Agent settings on ${await lines(settings)} lines at ${width}px`);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

bothWidths('fix 2: one-line header, quick buttons in two columns, Send inside the first viewport', async (scheme, width) => {
  const page = await thread(scheme, { width, height: 800 });
  try {
    // Name, model and state sit on one line.
    await page.waitForFunction(() => document.getElementById('h-model').textContent);
    const tops = [];
    for (const s of ['.head h1', '#h-model', '#h-state']) { const b = await box(page, s); tops.push(Math.round((b.top + b.bottom) / 2)); }
    assert.ok(Math.max(...tops) - Math.min(...tops) <= 8, `header is not one line at ${width}px: ${tops}`);
    assert.ok((await box(page, '.head')).height < 70, 'header is one line high');
    // The guard line is still shown, and still says what it said.
    assert.equal(await page.locator('#h-guard').isVisible(), true);
    // Two columns of quick buttons.
    const [a, b] = [await box(page, '.quick button:nth-child(1)'), await box(page, '.quick button:nth-child(2)')];
    assert.equal(Math.round(a.top), Math.round(b.top), `first two quick buttons are not side by side at ${width}px`);
    assert.ok(b.left > a.right - 1);
    // Send, and the usage line under it, are on the first screen with an empty thread.
    const viewport = await page.evaluate(() => innerHeight);
    assert.ok((await box(page, '#send')).bottom <= viewport, `Send ends at ${(await box(page, '#send')).bottom} of ${viewport} at ${width}px`);
    assert.ok((await box(page, '#msg')).top < viewport);
    // And a small window still shows Send without scrolling past the log.
    await page.setViewportSize({ width, height: 600 });
    assert.ok((await box(page, '#send')).bottom <= 600, `Send ends at ${(await box(page, '#send')).bottom} of 600 at ${width}px`);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

bothWidths('fix 3: the dialog names the act: removing the key, not ending the conversation', async (scheme, width) => {
  const page = await open({ scheme, width, height: 800, state: sdkState() });
  try {
    await page.locator('#v-thread').waitFor();
    await emit(page, { kind: 'guard', state: 'on', version: '0.9.0' });
    await emit(page, { kind: 'you', text: 'hello' });
    await page.locator('#thread li.you').waitFor();
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.locator('#s-remove').click();
    await page.locator('#dlg').waitFor();
    assert.equal(await page.locator('#dlg-title').textContent(), 'Remove the saved key?');
    assert.equal(await page.locator('#dlg-ok').textContent(), 'Remove key');
    const body = await page.locator('#dlg-text').textContent();
    assert.match(body, /deletes the saved key from the Keychain/);
    assert.match(body, /conversation ends/);
    // The whole question is on screen, both buttons reachable.
    const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    for (const s of ['#dlg', '#dlg-ok', '#dlg-cancel']) { const b = await box(page, s); assert.ok(b.left >= 0 && b.right <= viewport.w && b.bottom <= viewport.h, `${s} leaves the screen at ${width}px`); }
    await page.locator('#dlg-cancel').click();
    // Changing the connection still names the end of the conversation, and the title returns with it.
    await page.locator('#s-change').click();
    await page.locator('#dlg').waitFor();
    assert.equal(await page.locator('#dlg-title').textContent(), 'End the conversation?');
    assert.equal(await page.locator('#dlg-ok').textContent(), 'End conversation');
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

bothWidths('fix 4: the quick buttons are disabled with Send, and look and announce it', async (scheme, width) => {
  const page = await thread(scheme, { width, height: 800, file: '/tmp/note-source.pdf' });
  try {
    const names = ['Continue canvas', 'Review canvas', 'Literature note…'];
    const state = async () => Promise.all(names.map((n) => page.getByRole('button', { name: n }).isDisabled()));
    const look = (n) => page.getByRole('button', { name: n }).evaluate((b) => { const s = getComputedStyle(b); return [s.color, s.backgroundColor, s.borderTopColor, s.cursor].join('|'); });
    assert.deepEqual(await state(), [false, false, false]);
    const enabledLook = await look(names[0]);
    // Working: off with Send.
    await page.locator('#msg').fill('hello');
    await page.locator('#send').click();
    assert.deepEqual(await state(), [true, true, true]);
    assert.notEqual(await look(names[0]), enabledLook, 'a disabled quick button looks like an enabled one');
    assert.equal(await page.getByRole('button', { name: names[0] }).evaluate((b) => getComputedStyle(b).cursor), 'not-allowed');
    await emit(page, { kind: 'turn-end' });
    assert.deepEqual(await state(), [false, false, false]);
    // Guard off: off, and they stay off until a guard comes on.
    await emit(page, { kind: 'guard', state: 'off', cause: 'The agent did not start within 30 seconds.' });
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    assert.deepEqual(await state(), [true, true, true]);
    assert.equal(await page.locator('#send').isDisabled(), true);
    // Trying again restarts: still off until the guard says on.
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'start').length === 2);
    assert.deepEqual(await state(), [true, true, true]);
    await emit(page, { kind: 'guard', state: 'on', version: '0.9.0' });
    assert.deepEqual(await state(), [false, false, false]);
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

bothWidths('fix 5: Source Serif 4 and Hanken Grotesk load from the files that ship with the plugin', async (scheme, width) => {
  const page = await thread(scheme, { width, height: 800 });
  try {
    await emit(page, { kind: 'text', text: 'An answer with *emphasis* and **weight**.' });
    await page.locator('#thread li.agent').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.waitForFunction(() => {
      const ok = new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')} ${f.style}`));
      return ok.has('Hanken Grotesk normal') && ok.has('Source Serif 4 normal') && ok.has('Source Serif 4 italic');
    }, null, { timeout: 5000 }).then(() => true, () => false);
    assert.equal(loaded, true, `the three faces did not load at ${width}px`);
    const failed = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family));
    assert.deepEqual(failed, []);
    // The agent's text is set in the serif, the chrome in the sans.
    const family = (selector) => page.locator(selector).first().evaluate((n) => getComputedStyle(n).fontFamily.split(',')[0].replace(/"/g, ''));
    assert.equal(await family('#thread li.agent p'), 'Source Serif 4');
    assert.equal(await family('.head h1'), 'Hanken Grotesk');
    assert.deepEqual(page.problems, []);
  } finally { await closeAll(page); }
});

bothWidths('fix 6: the connect error sits under the field it names; an earlier "Try again" is spent', async (scheme, width) => {
  const bad = await open({ scheme, width, height: 800, state: sdkState(null), connect: { ok: false, field: 'url', error: 'The address must start with https://.' } });
  try {
    await bad.locator('input[name=kind][value=gateway]').check();
    await bad.locator('#connect-go').click();
    await bad.locator('#connect-error').waitFor();
    const field = await box(bad, '#f-url');
    const error = await box(bad, '#connect-error');
    assert.ok(error.top >= field.bottom && error.top - field.bottom < 24, `the error is ${error.top - field.bottom}px below the field at ${width}px`);
    assert.equal(await bad.evaluate(() => document.getElementById('f-url').closest('label').nextElementSibling.id), 'connect-error');
    assert.equal(await active(bad), 'f-url');
    assert.equal(await bad.locator('#f-url').getAttribute('aria-describedby'), 'connect-error');
    // Another refusal, naming no field, is told above the button; the old place is left.
    await bad.locator('#f-url').fill('https://gateway.example');
    await bad.evaluate(() => { window.agentPanel.connect = () => Promise.resolve({ ok: false, error: 'The token was refused.' }); });
    await bad.locator('#connect-go').click();
    await bad.waitForFunction(() => document.getElementById('connect-error-text').textContent === 'The token was refused.');
    assert.equal(await bad.evaluate(() => document.getElementById('connect-error').nextElementSibling.id), 'connect-go');
    assert.equal(await bad.locator('#f-url').getAttribute('aria-invalid'), null);
    assert.deepEqual(bad.problems, []);
  } finally { await closeAll(bad); }

  const page = await thread(scheme, { width, height: 800 });
  try {
    await emit(page, { kind: 'guard', state: 'off', cause: 'The agent did not start within 30 seconds.' });
    await emit(page, { kind: 'guard', state: 'off', cause: 'The placet-research plugin did not load.' });
    await page.waitForFunction(() => document.querySelectorAll('#thread li.problem button').length === 2);
    const again = page.locator('#thread li.problem button');
    assert.deepEqual([await again.nth(0).isDisabled(), await again.nth(1).isDisabled()], [true, false]);
  } finally { await closeAll(page); }
});
