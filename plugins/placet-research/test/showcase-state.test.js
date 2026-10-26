'use strict';

// The session view rendered from docs/media/showcase-state.json — the state file
// the README screenshots and the video's UI scenes are captured from (SQ-223).
// The page script runs against the same stub document as view.test.js, in
// fixture mode, so a schema change that would leave a screenshot blank or on the
// error path fails here instead. The file itself is generated, never hand-written:
// see docs/media/README.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'canvas.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'media', 'showcase-state.json'), 'utf8'));
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function stubNode() {
  const listeners = {};
  return {
    listeners,
    innerHTML: '',
    textContent: '',
    hidden: false,
    open: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    showModal() { this.open = true; },
    close() { this.open = false; (listeners.close || []).forEach((fn) => fn()); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

// view.test.js's mount(), reduced to what this file checks: the page loads the
// state through `?fixture=` and the given `?view=`.
async function mount(query) {
  const nodes = {};
  const node = (id) => nodes[id] || (nodes[id] = stubNode());
  // The notice bar carries the `hidden` attribute in the markup; showNotice is
  // what lifts it.
  node('notice').hidden = true;
  const fetchStub = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(state) });
  const documentStub = { getElementById: (id) => (id === 'body-shell' ? null : node(id)) };
  const location = { search: `?fixture=/fixture.json${query}`, hash: '', pathname: '/' };
  const historyStub = { replaceState(_state, _title, url) {
    const replaced = new URL(url, 'http://127.0.0.1');
    location.hash = replaced.hash;
    location.search = replaced.search;
  } };
  new Function('document', 'location', 'history', 'fetch', script)(documentStub, location, historyStub, fetchStub);
  await settle();
  return { app: node('app'), notice: node('notice'), noticeText: node('notice-text') };
}

// Optional browser coverage uses the repository's Playwright devDependency,
// the same one the screenshot script uses; the plugin and its ordinary Node
// tests need no browser.
let chromium;
try { ({ chromium } = require('playwright')); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

function luminance(rgb) {
  const channels = rgb.map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a, b) {
  const levels = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (levels[0] + 0.05) / (levels[1] + 0.05);
}

// Shrinking a role, restoring a muted ink or losing the column's growth must
// fail on the rendered showcase, not a CSS grep. The galley proof scrolls: the
// old "poster fits one screen" check is gone with the nine-card grid.
test('the rendered session view scales for projectors and keeps text contrast above AA', { skip: !chromium, timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    browser = await chromium.launch({ channel: 'chromium' });
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://session.test/**', (route) => route.fulfill({
    contentType: route.request().url().endsWith('fixture.json') ? 'application/json' : 'text/html',
    body: route.request().url().endsWith('fixture.json') ? JSON.stringify(state) : html,
  }));
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const [width, height] of [[1920, 1080], [1440, 900], [1024, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const view of ['poster', 'compare', 'agenda', 'log', 'element-3']) {
        await page.goto(`http://session.test/?fixture=/fixture.json&view=${view}`);
        await page.waitForSelector('section[data-view].active');
        const metrics = await page.evaluate(() => {
          const active = document.querySelector('section[data-view].active');
          const nodes = [active, ...active.querySelectorAll('*'), ...document.querySelectorAll('#chrome *')]
            .filter((node) => node.getClientRects().length && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()));
          const sizes = nodes.map((node) => parseFloat(getComputedStyle(node).fontSize));
          const tokens = getComputedStyle(document.documentElement);
          const rgb = (name) => tokens.getPropertyValue(name).trim().match(/[a-f\d]{2}/gi).map((hex) => parseInt(hex, 16));
          const names = ['--paper', '--panel', '--ink', '--ink-2', '--ink-3', '--red', '--red-ink', '--blue'];
          return {
            minimum: Math.min(...sizes),
            body: parseFloat(getComputedStyle(document.querySelector('.stext, .field-lead, .field-para')).fontSize),
            label: parseFloat(getComputedStyle(document.querySelector('.status-label')).fontSize),
            colors: Object.fromEntries(names.map((name) => [name, rgb(name)])),
          };
        });
        assert.ok(metrics.minimum >= 14, `${colorScheme} ${width} ${view}: smallest visible text is ${metrics.minimum}px`);
        for (const ink of ['--ink', '--ink-2', '--ink-3']) {
          for (const bg of ['--paper', '--panel']) {
            assert.ok(contrast(metrics.colors[ink], metrics.colors[bg]) >= 7, `${colorScheme}: ${ink} on ${bg} meets 7:1`);
          }
        }
        // Red and blue are the owner's fixed marks: used on bold words, buttons and links, held at AA.
        for (const mark of ['--red', '--blue']) assert.ok(contrast(metrics.colors[mark], metrics.colors['--paper']) >= 4.5, `${colorScheme}: ${mark} on paper meets 4.5:1`);
        assert.ok(contrast(metrics.colors['--red-ink'], metrics.colors['--red']) >= 4.5, `${colorScheme}: text on a red button meets 4.5:1`);
        if (width === 1440) assert.ok(Math.abs(metrics.body - 18) < 0.5 || view !== 'poster', 'the column is 18px at 1440');
        if (width === 1920) assert.ok(metrics.body >= 18, '1920px body reaches the projector floor');
        t.diagnostic(`${colorScheme} ${width} ${view}: body=${metrics.body}px label=${metrics.label}px min=${metrics.minimum}px`);
      }
    }
  }
});

const statements = state.elements.flatMap((e) => e.questions.flatMap((q) => q.statements));

test('the showcase state holds what the session view renders, in the schema it reads', () => {
  assert.equal(state.project, 'ai-assistants-interviews');
  assert.equal(state.elements.length, 9, 'nine fields');
  assert.equal(state.variants.length, 3, 'three framings to compare');
  assert.ok(state.decisions.some((d) => d.ref === 'framing chosen: trust'), 'one framing is chosen');
  for (const marker of ['accepted', 'stated', 'tentative', 'proposed']) {
    assert.ok(statements.some((s) => s.marker === marker), `a [${marker}] statement`);
  }
  // The galley proof's build fixture: an empty field and a field with two open suggestions.
  const asks = state.elements.map((e) => e.questions.flatMap((q) => q.statements).filter((s) => s.marker === 'proposed').length);
  assert.ok(state.elements.some((e) => e.questions.every((q) => q.statements.length === 0)), 'an empty field');
  assert.ok(asks.some((n) => n >= 2), 'a field with two open suggestions');
  assert.ok(state.decisions.some((d) => /^\d\.\d accepted$/.test(d.ref) && d.explained), 'an accepted statement with its sentence, for the decision line');
  assert.ok(state.agenda.fields.length > 0, 'something to talk about');
  assert.deepEqual([...new Set(state.decisions.map((d) => d.by))].sort(), ['A. Author', 'B. Supervisor']);
  assert.equal(state.review.ledger.status, 'verified', 'no broken ledger banner over the showcase');
});

for (const [label, view, query] of [
  ['the poster', 'poster', ''],
  ['History', 'log', '&view=log'],
  ['To talk about', 'agenda', '&view=agenda'],
]) {
  test(`the showcase state renders on ${label} without the error or notice path`, async () => {
    const page = await mount(query);
    assert.doesNotMatch(page.app.innerHTML, /Could not load the canvas/);
    assert.doesNotMatch(page.app.innerHTML, /role="alert"/);
    assert.doesNotMatch(page.app.innerHTML, /notices-banner/);
    assert.equal(page.notice.hidden, true, 'no notices banner was shown');
    assert.equal(page.noticeText.textContent, '');
    assert.match(page.app.innerHTML, new RegExp(`<section id="${view}"`), 'the view itself rendered');
  });
}

test('the poster shows every status word once at least, the decision line and a margin query with its slot', async () => {
  const poster = await mount('');
  const section = poster.app.innerHTML.match(/<section id="poster"[\s\S]*?<\/section>/)[0];
  for (const word of ['Decided', 'Said by the authors', 'Draft', 'Suggestion']) {
    assert.ok(section.includes(`<span class="status-word">${word}</span>`), `${word} is on the poster`);
  }
  assert.match(section, /<p class="setnote"><b>6 Oct 2026 &middot; A\. Author<\/b> &mdash; <q>I accept that these developers/);
  assert.match(section, /<div class="slot" id="slot-6\.1" aria-details="st-6\.1">Suggestion 1 would be set here<\/div>/);
  assert.match(section, /<article class="query next" id="st-6\.1"[^>]*aria-describedby="slot-6\.1"/);
  assert.match(section, /Nothing set yet\. 2 suggestions wait in the margin\./);
  assert.doesNotMatch(section.slice(8), /<section/, 'the poster holds no nested section');
});

test('the poster carries the paper title and the History both names', async () => {
  const poster = await mount('');
  assert.match(poster.app.innerHTML, /How senior developers decide whether to rely on an AI assistant/);
  const log = await mount('&view=log');
  assert.match(log.app.innerHTML, /A\. Author/);
  assert.match(log.app.innerHTML, /B\. Supervisor/);
});

// Expanding the unanswered group must preserve every prompt and its navigation;
// first-load guidance must not turn the read-only example into a writable view.
test('agenda disclosure keeps the discussion first and every unanswered prompt reachable', { skip: !chromium, timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    browser = await chromium.launch({ channel: 'chromium' });
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  const writes = [];
  await page.route('http://session.test/**', (route) => {
    if (route.request().method() !== 'GET') writes.push(route.request().url());
    return route.fulfill({
      contentType: new URL(route.request().url()).pathname === '/fixture.json' ? 'application/json' : 'text/html',
      body: new URL(route.request().url()).pathname === '/fixture.json' ? JSON.stringify(state) : html,
    });
  });
  for (const [width, height] of [[1440, 900], [320, 720]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://session.test/?fixture=/fixture.json');
    await page.waitForSelector('#poster.active');
    assert.equal(await page.locator('.poster-orientation').isVisible(), true, 'guidance appears on first load');
    await page.locator('#view-tabs [data-view-target="agenda"]').click();
    assert.equal(await page.locator('#agenda .agenda-item-open').count(), 1, 'the real discussion remains prominent');
    const gaps = page.locator('#agenda .agenda-gaps');
    assert.equal(await gaps.getAttribute('open'), null, 'unanswered group starts compact');
    assert.match(await gaps.locator(':scope > summary').textContent(), /22 questions in 9 fields/);
    assert.equal(await page.locator('#agenda .agenda-gap-field').count(), 9, 'one group per field');
    assert.equal(await page.locator('#agenda .agenda-gap-item').count(), 22, 'all prompts retained');
    await gaps.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.notEqual(await gaps.getAttribute('open'), null, 'keyboard opens the group');
    const field = page.locator('#agenda .agenda-gap-field').first();
    await field.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    const target = field.locator('.agenda-gap-item').first();
    assert.equal(await target.isVisible(), true, 'the unanswered prompt is available');
    const view = await target.getAttribute('data-view-target');
    await target.click();
    assert.equal(await page.locator('section[data-view="' + view + '"].active').count(), 1, 'prompt opens its field');
    assert.match(await page.locator('section.active .empty-note').textContent(), /Read-only example.*cannot be saved/);
    assert.equal(await page.locator('section.active [data-action], section.active textarea').count(), 0, 'fixture has no writable controls');
    await page.locator('#view-tabs [data-view-target="log"]').click();
    assert.doesNotMatch(await page.locator('#log').innerText(), /verified|seal|unverifiable/i, 'intact history has no integrity jargon');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, 'expanded navigation and history still reflow');
  }
  assert.deepEqual(writes, [], 'exploring the read-only example saves nothing');
});

async function openShowcase(t, viewport, colorScheme = 'light') {
  let browser;
  try { browser = await chromium.launch(); } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    browser = await chromium.launch({ channel: 'chromium' });
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.route('http://session.test/**', (route) => route.fulfill({
    contentType: new URL(route.request().url()).pathname === '/fixture.json' ? 'application/json' : 'text/html',
    body: new URL(route.request().url()).pathname === '/fixture.json' ? JSON.stringify(state) : html,
  }));
  await page.goto('http://session.test/?fixture=/fixture.json');
  await page.waitForSelector('#poster.active .query');
  return { page, errors };
}

// The signature interaction: each margin query is tied to its slot in the
// column by a programmatic relation a screen reader announces, and by a leader
// line that lights with it. Narrow, the query sits directly under its slot.
test('every margin query names its slot, the slot names it back, and focus lights the leader line and the slot', { skip: !chromium, timeout: 120000 }, async (t) => {
  const { page, errors } = await openShowcase(t, { width: 1440, height: 900 });
  const pairs = await page.evaluate(() => [...document.querySelectorAll('#poster .query')].map((query) => {
    const slot = document.getElementById(query.getAttribute('aria-describedby'));
    return {
      id: query.id, slotId: slot && slot.id, slotClass: slot && slot.className, back: slot && slot.getAttribute('aria-details'),
      dataSlot: query.getAttribute('data-slot'), named: Boolean(document.getElementById(query.getAttribute('aria-labelledby'))),
      line: Boolean(document.querySelector(`#poster .leader[data-q="${query.id}"]`)),
    };
  }));
  assert.equal(pairs.length, 3, 'the showcase holds three open suggestions');
  for (const pair of pairs) {
    assert.equal(pair.slotClass, 'slot');
    assert.equal(pair.back, pair.id, `${pair.id}: the slot points back at its query`);
    assert.equal(pair.dataSlot, pair.slotId);
    assert.ok(pair.named && pair.line, `${pair.id}: labelled, and a leader line is drawn`);
  }
  const accept = page.locator('#poster .query').nth(1).locator('[data-action="accept"]');
  await accept.focus();
  const lit = await page.evaluate(() => ({
    query: document.querySelectorAll('#poster .query.lit').length, slot: document.querySelectorAll('#poster .slot.lit').length, line: document.querySelectorAll('#poster .leader.lit').length,
    id: document.querySelector('#poster .query.lit').id,
  }));
  assert.deepEqual([lit.query, lit.slot, lit.line], [1, 1, 1], 'one query, its slot and its line light together');
  assert.equal(lit.id, pairs[1].id);
  await page.locator('#fieldnav .chip').first().focus();
  assert.equal(await page.locator('#poster .lit').count(), 0, 'moving focus away unlights them');
  assert.deepEqual(errors, []);
});

test('narrow, each query sits directly under its slot with no leader drawn', { skip: !chromium, timeout: 120000 }, async (t) => {
  const { page, errors } = await openShowcase(t, { width: 320, height: 720 });
  const narrow = await page.evaluate(() => ({
    underSlot: [...document.querySelectorAll('#poster .query')].every((q) => q.previousElementSibling && q.previousElementSibling.id === q.getAttribute('data-slot')
      && q.getBoundingClientRect().top >= q.previousElementSibling.getBoundingClientRect().bottom - 1),
    lines: document.querySelectorAll('#poster .leader').length,
    overflow: document.documentElement.scrollWidth,
  }));
  assert.equal(narrow.underSlot, true);
  assert.equal(narrow.lines, 0);
  assert.equal(narrow.overflow, 320, 'reflow holds at 320px');
  assert.deepEqual(errors, []);
});

test('Present: Enter on the control shows one field with its queries, arrow keys step, Escape leaves and returns focus', { skip: !chromium, timeout: 120000 }, async (t) => {
  const { page, errors } = await openShowcase(t, { width: 1440, height: 900 });
  const present = page.locator('#present');
  assert.equal(await present.isHidden(), true);
  await page.locator('.present-btn').focus();
  await page.keyboard.press('Enter');
  await present.waitFor({ state: 'visible' });
  assert.match(await present.locator('.present-bar .count').textContent(), /Field 6 of 9/, 'opens on the first field with a query waiting');
  assert.equal(await present.locator('.query').count(), 2, 'the field comes with its margin queries');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'present-title', 'focus moves to the field');
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), true, 'the page behind is inert');
  await page.keyboard.press('ArrowRight');
  assert.match(await present.locator('.present-bar .count').textContent(), /Field 7 of 9/);
  assert.equal(await present.locator('.query').count(), 0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.match(await present.locator('.present-bar .count').textContent(), /Field 5 of 9/);
  const projector = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#present .stext, #present .askline, #present .quiet')).fontSize));
  assert.ok(projector >= 21, `projector scale: ${projector}px`);
  await page.keyboard.press('Escape');
  assert.equal(await present.isHidden(), true);
  // Leaving full screen settles asynchronously: the browser parks focus on
  // <body> for a moment before the page's own refocus lands, and how long that
  // takes differs between the bundled headless shell and the full Chromium
  // build. Wait for the settled state instead of racing it.
  await page.waitForFunction(() => document.activeElement.className === 'present-btn', null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.activeElement.className), 'present-btn', 'focus returns to the control');
  assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
  assert.deepEqual(errors, []);
});

test('the fonts load from the plugin, with no request leaving the origin', { skip: !chromium, timeout: 120000 }, async (t) => {
  const { page } = await openShowcase(t, { width: 1440, height: 900 });
  const families = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map((f) => f.family.replace(/"/g, '')).sort();
  });
  assert.deepEqual([...new Set(families)], ['Hanken Grotesk', 'Source Serif 4']);
  assert.match(html, /url\("fonts\/source-serif-4-latin-wght-normal\.woff2"\)/);
  assert.match(html, /url\("fonts\/hanken-grotesk-latin-wght-normal\.woff2"\)/);
});
