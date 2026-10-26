'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The isolation of test/app-api.test.js: no global git identity, the sealing
// key and the name under a temporary state directory, file:// links allowed so
// a bare remote on disk can be cloned.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.PLACET_RESEARCH_DIR;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-shell-state-'));
process.env.PLACET_RESEARCH_STATE_DIR = stateDir;
process.env.PLACET_RESEARCH_GIT_PROTOCOLS = 'https:ssh:file';

const { start } = require('../bin/canvas-serve');
const appGit = require('../hooks/lib/app-git');
const { runCli } = require('../hooks/lib/app-cli');
const { routes } = require('../hooks/lib/app-api');
const { chromium, launchChromium, focusContrastRatios, documentWidths } = require('./helpers/a11y');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app.html'), 'utf8');
const skip = !chromium;

const roots = [stateDir];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-shell-'));
  roots.push(dir);
  return dir;
}
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function sh(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const context = (dataDir, root = null) => {
  let current = root;
  return { dataDir, getRoot: () => current, setRoot: (r) => { current = r; } };
};

async function makeProject(folder = 'voice-uptake', title = 'Voice uptake') {
  const created = await routes.init({ parent: tmp(), folder, mode: 'brainstorming', title }, context(tmp()));
  assert.equal(created.ok, true, created.error);
  return created.current;
}

// A creates the project and pushes it to a bare remote; B clones it and joins
// with A's key (the setup of test/app-api.test.js).
async function twoPeopleSharingOneProject() {
  const a = await makeProject('shared', 'Shared');
  assert.equal((await runCli(a, ['name', 'A. Author'])).ok, true);
  assert.equal((await runCli(a, ['log', 'DISCOVERY', '1.1', '--body', 'Shared finding'])).ok, true);
  assert.equal((await appGit.commit(a, ['research'], 'Start the project', 'A. Author')).ok, true);
  const remote = path.join(tmp(), 'remote.git');
  sh(path.dirname(remote), 'init', '--bare', '-b', 'main', 'remote.git');
  sh(a, 'remote', 'add', 'origin', remote);
  sh(a, 'push', '-u', 'origin', 'main');
  const keyFile = path.join(tmp(), 'a.seal.key');
  assert.equal((await runCli(a, ['key', 'export', '--out', keyFile])).ok, true);
  const cloned = await appGit.clone({ url: `file://${remote}`, parent: tmp(), folder: 'shared' });
  assert.equal(cloned.ok, true, cloned.error);
  const b = cloned.root;
  assert.equal((await runCli(b, ['join', '--key-file', keyFile, '--name', 'B. Supervisor'])).ok, true);
  return { a, b, keyFile };
}

async function startApp(t, { open = null } = {}) {
  const srv = await start({ root: null, app: { dataDir: tmp() } });
  t.after(() => srv.close());
  if (open) {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/app/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Harness-Token': srv.token },
      body: JSON.stringify({ root: open }),
    });
    assert.equal((await res.json()).ok, true);
  }
  return srv;
}

async function openPage(t, srv, { viewport = { width: 1440, height: 900 }, colorScheme = 'light', host = false, userAgent, before } = {}) {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, colorScheme, userAgent });
  page.on('pageerror', (err) => t.diagnostic(`pageerror: ${err.message}`));
  if (host) {
    await page.addInitScript(() => {
      window.__agent = { bounds: [], projects: [], setups: 0, shown: null, lookup: null, reveal: null, focusView: null };
      window.harnessHost = {
        pickFolder: async () => window.__picked || null,
        pickFile: async () => window.__picked || null,
        saveFile: async () => window.__picked || null,
        reveal: async () => {},
        openExternal: async () => {},
        agentBounds: (rect) => { window.__agent.bounds.push(rect); },
        agentProject: (folder) => { window.__agent.projects.push(folder); },
        setUpAgent: () => { window.__agent.setups++; },
        onAgentShown: (cb) => { window.__agent.shown = cb; },
        onAgentLookup: (cb) => { window.__agent.lookup = cb; },
        onAgentReveal: (cb) => { window.__agent.reveal = cb; },
        onAgentFocusView: (cb) => { window.__agent.focusView = cb; },
        onUpdate: (callback) => { window.__sendUpdate = callback; },
        restartToUpdate: async () => { window.__restarted = (window.__restarted || 0) + 1; },
      };
    });
  }
  if (before) await before(page);
  await page.goto(srv.appUrl);
  return page;
}

// A copy of test/fixtures/<name> in a fresh folder, and its path.
function copyFixture(name) {
  const root = path.join(tmp(), name);
  fs.cpSync(path.join(__dirname, 'fixtures', name), root, { recursive: true });
  return root;
}

// Open a folder through Open project…: with the host bridge by Choose…, in a
// plain browser by typing the path into the field. Waits for the session view.
async function openFixture(page, root) {
  await page.getByRole('button', { name: 'Open project…' }).click();
  if (await page.evaluate(() => Boolean(window.harnessHost))) {
    await page.evaluate((picked) => { window.__picked = picked; }, root);
    await page.getByRole('button', { name: 'Choose…' }).click();
  } else {
    await page.getByLabel('Project folder').fill(root);
  }
  await page.locator('#dlg').getByRole('button', { name: 'Open project' }).click();
  await sessionView(page).locator('#poster.active').waitFor();
}

const sessionView = (page) => page.frameLocator('iframe[title="Session view"]');
const START_BUTTONS = ['New project…', 'Open project…', 'Clone from link…'];

// -- The page's source ------------------------------------------------------

test('app.html is self-contained and keeps the token out of every store', () => {
  const offenders = (html.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter((url) => !url.startsWith('http://www.w3.org/2000/svg'));
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /event\.origin !== location\.origin \|\| event\.source !== frame\.contentWindow/);
  assert.doesNotMatch(html, /role="status"/, 'outcomes are aria-live lines that stay, not status toasts');
  assert.doesNotMatch(html, /setTimeout/, 'nothing disappears on a timer');
});

// -- Rendered ------------------------------------------------------------------

for (const colorScheme of ['light', 'dark']) {
  test('Shell polish: first start and folder dialogs in ' + colorScheme, { skip, timeout: 120000 }, async (t) => {
    const srv = await startApp(t);
    const page = await openPage(t, srv, { colorScheme });
    await page.locator('#start').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Placet', exact: true }).count(), 1, 'first start names the app');
    const startBox = await page.locator('#start').boundingBox();
    assert.ok(Math.abs(startBox.x - (1440 - startBox.width) / 2) < 2, 'the first-start block is centred');
    if (process.env.APP_SHELL_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, colorScheme + '-start-1440.png') });
    for (const action of ['New project…', 'Clone from link…']) {
      await page.getByRole('button', { name: action, exact: true }).click();
      assert.doesNotMatch(await page.locator('#dlg').innerText(), /Letters, digits|research\/canvas\.md/, 'folder rules and paths do not lead the dialog');
      await page.locator('#f-parent').fill(tmp());
      await page.getByLabel('Name of the new folder').fill('My Paper');
      if (action === 'New project…') await page.getByLabel('Your name').fill('A. Author');
      else await page.locator('#f-url').fill('https://example.invalid/paper.git');
      await page.locator('#dlg button[type="submit"]').click();
      await page.locator('#f-folder[aria-invalid="true"]').waitFor();
      assert.match(await page.locator('#dlg-error').innerText(), /folder name may use letters, digits, dots, hyphens and underscores/i, 'the rule appears at the invalid name');
      assert.equal(await page.locator('#f-folder').evaluate((n) => n === document.activeElement), true, 'the invalid folder receives keyboard focus');
      if (action === 'New project…') {
        const radio = page.getByRole('radio', { name: /^Seed/ });
        const unchecked = await radio.evaluate((n) => ({ fill: getComputedStyle(n).backgroundColor, paper: getComputedStyle(document.body).backgroundColor }));
        assert.equal(unchecked.fill, unchecked.paper, 'unselected radios are hollow, not grey-filled');
        await radio.focus();
        await page.keyboard.press('Space');
        assert.equal(await radio.isChecked(), true, 'radio remains keyboard-operable');
        const primary = page.locator('#dlg button[type="submit"]');
        const enabledFill = await primary.evaluate((n) => getComputedStyle(n).backgroundColor);
        await primary.evaluate((n) => { n.disabled = true; });
        assert.notEqual(await primary.evaluate((n) => getComputedStyle(n).backgroundColor), enabledFill, 'primary and disabled fills differ');
        await primary.evaluate((n) => { n.disabled = false; });
        if (colorScheme === 'dark') assert.notEqual(await page.locator('#dlg').evaluate((n) => getComputedStyle(n).backgroundColor), unchecked.paper, 'dark dialog is distinct from the page');
        if (process.env.APP_SHELL_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, colorScheme + '-new-1440.png') });
      }
      await page.keyboard.press('Escape');
    }
  });

  test('Shell polish: project groups, latest outcomes and meeting navigation in ' + colorScheme, { skip, timeout: 120000 }, async (t) => {
    const root = await makeProject();
    const srv = await startApp(t, { open: root });
    const browser = await launchChromium();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme });
    await page.route('**/api/app/status', (r) => r.fulfill({ json: { ok: true, hasKey: true, shared: true, name: 'A. Author' } }));
    for (const action of ['update', 'send']) await page.route('**/api/app/' + action, (r) => r.fulfill({ json: { ok: true } }));
    await page.goto(srv.appUrl);
    await page.locator('#proj-name').waitFor();
    assert.deepEqual(await page.locator('#app-projects button').allTextContents(), START_BUTTONS.slice(1).concat(START_BUTTONS[0]), 'app-wide controls have their own group');
    assert.equal(await page.locator('#h-project').evaluate((n) => n.closest('section').querySelector('#btn-open') === null), true, 'Open is not mixed with this project');
    assert.match(await page.locator('#hint-send').innerText(), /co-authors/, 'Send has a one-line explanation');
    assert.equal(await page.locator('#btn-send').getAttribute('aria-describedby'), 'hint-send');
    await page.getByRole('button', { name: /^Get updates/ }).click();
    await page.waitForFunction(() => /already have/.test(document.getElementById('out-update').textContent));
    await page.getByRole('button', { name: 'Send my changes…' }).click();
    await page.locator('#dlg button[type="submit"]').click();
    await page.waitForFunction(() => /Sent\./.test(document.getElementById('out-send').textContent));
    assert.equal(await page.locator('#out-update').textContent(), '', 'Send replaces the older project outcome');
    assert.equal(await page.locator('#sidebar section[aria-labelledby="h-project"] .outcome:not(:empty)').count(), 1, 'only the latest outcome remains in the project group');
    const agenda = page.getByRole('button', { name: 'To talk about', exact: true });
    await agenda.click();
    await sessionView(page).locator('#agenda.active').waitFor();
    assert.equal(await sessionView(page).locator('#fieldnav').isVisible(), false, 'Fields is hidden on To talk about');
    const note = page.locator('#out-meeting');
    const noteBox = await note.boundingBox();
    assert.ok(noteBox.y >= 0 && noteBox.y + noteBox.height <= 900, 'meeting outcome is visible without manual scrolling');
    assert.match(await note.innerText(), /To talk about/);
    assert.equal(await sessionView(page).locator('#view-tabs .active').innerText(), 'To talk about');
    if (process.env.APP_SHELL_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, colorScheme + '-meeting-1440.png') });
    await page.getByRole('button', { name: 'Export minutes…' }).click();
    assert.match(await page.locator('#dlg').innerText(), /a text file \(Markdown, opens in any editor\)/);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 320, height: 720 });
    assert.deepEqual(await documentWidths(page), { document: 320, viewport: 320 }, 'project groups reflow to 320 px');
  });
}

test('first start: three ways in, each with one sentence, all reachable by Tab', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('heading', { name: 'Start with a paper project' }).waitFor();
  assert.equal(await page.locator('#sidebar').isVisible(), false, 'no project, no sidebar');
  assert.doesNotMatch(page.url(), /#|c=/, 'the code leaves the address bar');
  for (const name of START_BUTTONS) {
    const sentence = await page.getByRole('button', { name }).evaluate((b) => document.getElementById(b.getAttribute('aria-describedby')).textContent.trim());
    assert.match(sentence, /^[A-Z][^.]{20,}\.$/, `${name} is explained by one sentence`);
  }
  const reached = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    reached.push(await page.evaluate(() => document.activeElement.textContent.trim()));
  }
  assert.deepEqual(reached.filter((name) => START_BUTTONS.includes(name)), START_BUTTONS, 'Tab reaches the three buttons in order');
});

test('an open project: sidebar with name, folder, Meeting and People, and the session view gets the token', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const srv = await startApp(t, { open: root });
  const page = await openPage(t, srv);
  await page.locator('#proj-name').waitFor();
  assert.equal((await page.locator('#proj-name').textContent()).trim(), 'Voice uptake');
  assert.equal((await page.locator('#proj-path').textContent()).trim(), root);
  for (const name of ['Project', 'Meeting', 'People']) {
    assert.equal(await page.getByRole('heading', { level: 2, name, exact: true }).count(), 1, `${name} section`);
  }
  // A project made in the app has no shared copy yet: Share stands in for
  // Get updates and Send my changes.
  for (const name of ['Share with co-authors…', 'Open project…', 'Clone from link…', 'New project…', 'Start session…', 'To talk about', 'Export minutes…', 'Invite co-author…']) {
    assert.equal(await page.getByRole('button', { name: new RegExp(`^${name}`) }).count(), 1, name);
  }
  for (const name of ['Get updates', 'Send my changes…']) {
    assert.equal(await page.getByRole('button', { name: new RegExp(`^${name}`) }).count(), 0, `${name} waits for a shared copy`);
  }
  assert.equal(await page.locator('#btn-join').isVisible(), false, 'this machine holds the key: no Join');
  const view = sessionView(page);
  await view.locator('#poster.active').waitFor();
  assert.equal(await view.locator('#notice').evaluate((n) => n.hidden), true, 'the view took the token from the shell and never tried a code of its own');

  // After redemption neither the page nor the address holds the token or the code.
  const content = await page.content();
  assert.ok(!content.includes(srv.token), 'the page source does not include the token');
  assert.ok(!content.includes(srv.code), 'the page source does not include the code');
  const href = await page.evaluate(() => location.href);
  assert.ok(!href.includes(srv.token) && !href.includes(srv.code), 'the address holds neither');
  assert.equal(await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length])), '[0,0]');
});

test('Get updates with a conflict outside decisions.md: the message sits next to the button, names the file, and focus stays', { skip, timeout: 120000 }, async (t) => {
  const { a, b } = await twoPeopleSharingOneProject();
  fs.appendFileSync(path.join(a, 'research', 'canvas.md'), '\nA edit\n');
  fs.appendFileSync(path.join(b, 'research', 'canvas.md'), '\nB edit\n');
  assert.equal((await routes.send({}, context(tmp(), a))).ok, true);
  const srv = await startApp(t, { open: b });
  const page = await openPage(t, srv);
  const button = page.getByRole('button', { name: /^Get updates/ });
  await button.focus();
  await page.keyboard.press('Enter');
  const outcome = page.locator('#out-update');
  await page.waitForFunction(() => /canvas\.md/.test(document.getElementById('out-update').textContent));
  assert.match(await outcome.textContent(), /research\/canvas\.md/, 'the message names the file');
  assert.match(await outcome.textContent(), /Nothing was changed/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-update', 'focus stays on the button');
  assert.equal(await outcome.getAttribute('aria-live'), 'polite');
  const box = await Promise.all([button.boundingBox(), outcome.boundingBox()]);
  assert.ok(box[1].y > box[0].y && box[1].y - (box[0].y + box[0].height) < 120, 'the message is next to the button');
  assert.equal(await page.locator('[role="status"]').count(), 0);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.match(await outcome.textContent(), /research\/canvas\.md/, 'the message does not go away on its own');
  assert.equal(fs.existsSync(path.join(b, '.git', 'MERGE_HEAD')), false);
});

test('Get updates counts the new entries and Send reports what it did', { skip, timeout: 120000 }, async (t) => {
  const { a, b } = await twoPeopleSharingOneProject();
  assert.equal((await runCli(a, ['log', 'DISCOVERY', '1.1', '--body', 'From A'])).ok, true);
  assert.equal((await routes.send({}, context(tmp(), a))).ok, true);
  assert.equal((await runCli(b, ['log', 'DISCOVERY', '1.1', '--body', 'From B'])).ok, true);
  const srv = await startApp(t, { open: b });
  const page = await openPage(t, srv);
  await page.locator('#proj-name').waitFor();
  assert.deepEqual(await page.locator('#people li').allTextContents(), ['A. Author', 'B. Supervisor']);
  await page.getByRole('button', { name: /^Get updates/ }).click();
  await page.waitForFunction(() => /new entr/.test(document.getElementById('out-update').textContent));
  assert.match(await page.locator('#out-update').textContent(), /1 new entry in the decision log from [A-Z]\. [A-Za-z]+\. The two decision logs were merged\./);
  assert.equal((await page.locator('#update-badge').textContent()).trim(), '1 new');
  await page.getByRole('button', { name: 'Send my changes…' }).click();
  assert.match(await page.locator('#dlg').textContent(), /Uploads them to the shared copy/, 'the dialog says where the changes go');
  await page.locator('#dlg').getByRole('button', { name: 'Send changes' }).click();
  await page.waitForFunction(() => document.getElementById('out-send').textContent || document.getElementById('dlg-error')?.textContent);
  assert.match(await page.locator('#out-send').textContent(), /Sent\. The shared copy now holds all your changes\./, await page.locator('#dlg-error').textContent().catch(() => ''));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-send', 'focus returns to the control that opened the dialog');
});

test('a project whose canvas has Windows line endings: the sidebar says so in plain words', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const file = path.join(root, 'research', 'canvas.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  const srv = await startApp(t, { open: root });
  const page = await openPage(t, srv);
  await page.getByText(/Windows line endings \(CRLF\)/).first().waitFor();
});

test('in a plain browser, Open project… shows a labelled path field and no picker', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('button', { name: 'Open project…' }).click();
  const field = page.getByLabel('Project folder');
  assert.equal(await field.isVisible(), true);
  assert.equal(await page.locator('#dlg button[data-pick]').count(), 1, 'the template carries one Choose… button');
  assert.equal(await page.locator('#dlg button[data-pick]').isVisible(), false, 'and it is not shown without a host bridge');
  assert.equal(await field.evaluate((n) => document.activeElement === n), true, 'the dialog opens on its field');

  await field.fill(''); // the field starts in the home folder; an emptied one is still named
  await page.locator('#dlg').getByRole('button', { name: 'Open project' }).click();
  assert.equal(await field.getAttribute('aria-invalid'), 'true', 'an empty field is named, not skipped');
  assert.match(await page.locator('#dlg-error').textContent(), /Enter the folder/);

  await field.fill(tmp());
  await page.locator('#dlg').getByRole('button', { name: 'Open project' }).click();
  await page.waitForFunction(() => /no research canvas/.test(document.getElementById('dlg-error').textContent));
  const offer = page.getByRole('button', { name: 'Create a project instead…' });
  assert.equal(await offer.isVisible(), true, 'a folder without a canvas gets an offer to create one');
  await offer.click();
  assert.equal(await page.getByRole('heading', { name: 'New project' }).isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'start-open', 'Escape returns to the control that opened the first dialog');
});

test('with a host bridge, Choose… fills the field from the native picker', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const srv = await startApp(t);
  const page = await openPage(t, srv, { host: true });
  await page.getByRole('button', { name: 'Open project…' }).click();
  const choose = page.getByRole('button', { name: 'Choose…' });
  assert.equal(await choose.isVisible(), true);
  await page.evaluate((picked) => { window.__picked = picked; }, root);
  await choose.click();
  assert.equal(await page.getByLabel('Project folder').inputValue(), root);
  await page.locator('#dlg').getByRole('button', { name: 'Open project' }).click();
  await page.locator('#proj-name').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'proj-name', 'focus lands on the opened project');
  await sessionView(page).locator('#poster.active').waitFor();
  assert.match(await page.locator('#out-project').textContent(), /Opened /);
});

test('the session view reveals a statement by number and answers lookups', { skip, timeout: 120000 }, async (t) => {
  const root = copyFixture('voice-uptake');
  const page = await openPage(t, await startApp(t), { host: true });
  await openFixture(page, root);

  const ask = (num) => page.evaluate((n) => new Promise((resolve) => {
    const frame = document.getElementById('session-frame');
    window.addEventListener('message', function on(e) {
      if (e.data && e.data.type === 'harness-lookup-result' && e.data.id === 7) { window.removeEventListener('message', on); resolve(e.data.words); }
    });
    frame.contentWindow.postMessage({ type: 'harness-lookup', id: 7, num: n }, location.origin);
  }), num);
  assert.match(await ask('1.2b'), /^Uptake may be a property of the meeting's/);
  assert.equal(await ask('9.9'), null);

  await page.evaluate(() => document.getElementById('session-frame').contentWindow.postMessage({ type: 'harness-reveal', num: '1.2b' }, location.origin));
  await sessionView(page).locator('[id="st-1.2b"]:focus').waitFor();
});

test('the agent column appears beside the session view when the app shows it, and reports its bounds', { skip, timeout: 120000 }, async (t) => {
  const root = copyFixture('voice-uptake');
  const page = await openPage(t, await startApp(t), { host: true });
  await openFixture(page, root);
  assert.equal((await page.evaluate(() => window.__agent.projects)).length, 1, 'the shell tells the app once which folder is open');
  assert.equal(await page.locator('#agent-slot').isVisible(), false);
  await page.evaluate(() => window.__agent.shown(true));
  await page.locator('#agent-slot').waitFor();
  const last = await page.evaluate(() => window.__agent.bounds[window.__agent.bounds.length - 1]);
  const box = await page.locator('#agent-slot').boundingBox();
  assert.deepEqual(last, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) });
  const frameBox = await page.locator('#session-frame').boundingBox();
  assert.ok(frameBox.x + frameBox.width <= box.x + 1, 'the column sits right of the session view');
  await page.evaluate(() => window.__agent.shown(false));
  assert.equal(await page.evaluate(() => window.__agent.bounds[window.__agent.bounds.length - 1]), null);
  await page.getByRole('button', { name: 'Set up the agent…' }).click();
  assert.equal(await page.evaluate(() => window.__agent.setups), 1);
});

test('while a dialog is open the agent column gives up its room, and gets it back on close', { skip, timeout: 120000 }, async (t) => {
  // The app's column is a native view over #agent-slot and paints over any
  // part of the dialog that reaches into the slot.
  const root = copyFixture('voice-uptake');
  const page = await openPage(t, await startApp(t), { host: true });
  await page.setViewportSize({ width: 1000, height: 650 });
  await openFixture(page, root);
  await page.evaluate(() => window.__agent.shown(true));
  await page.locator('#agent-slot').waitFor();
  const lastBounds = () => page.evaluate(() => window.__agent.bounds[window.__agent.bounds.length - 1]);
  assert.notEqual(await lastBounds(), null);
  for (const [opener, close] of [['Start session…', 'Cancel'], ['Share with co-authors…', 'Escape']]) {
    await page.getByRole('button', { name: opener }).click();
    await page.locator('#dlg[open]').waitFor();
    assert.equal(await lastBounds(), null, `${opener} hides the column while it is open`);
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollLeft), 0, `${opener} does not scroll the shell sideways`);
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('#dlg').getByRole('button', { name: close }).click();
    // The dialog's close event comes a task after the open attribute goes.
    await page.waitForFunction(() => window.__agent.bounds[window.__agent.bounds.length - 1] !== null);
    const back = await lastBounds();
    const box = await page.locator('#agent-slot').boundingBox();
    assert.deepEqual(back, { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }, `the column is back after ${opener} closes`);
  }
});

test('the shell answers number lookups from the session view and reveals the statement', { skip, timeout: 120000 }, async (t) => {
  const root = copyFixture('voice-uptake');
  const page = await openPage(t, await startApp(t), { host: true });
  await openFixture(page, root);
  assert.match(await page.evaluate(() => window.__agent.lookup('1.2b')), /^Uptake may be a property/);
  assert.equal(await page.evaluate(() => window.__agent.lookup('2.1.300')), null);
  await page.evaluate(() => window.__agent.reveal('2.2'));
  await sessionView(page).locator('[id="st-2.2"]:focus').waitFor();
});

test('in a plain browser there is no agent column and no set-up entry', { skip, timeout: 120000 }, async (t) => {
  const root = copyFixture('voice-uptake');
  const page = await openPage(t, await startApp(t), { host: false });
  await openFixture(page, root);
  assert.equal(await page.locator('#agent-slot').isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Set up the agent…' }).count(), 0);
});

for (const colorScheme of ['light', 'dark']) {
  test(`the agent entries follow the sidebar in reading order, pass focus contrast, and fold at 320 px in ${colorScheme}`, { skip, timeout: 120000 }, async (t) => {
    const root = copyFixture('voice-uptake');
    const page = await openPage(t, await startApp(t), { host: true, colorScheme });
    await openFixture(page, root);
    await page.locator('#btn-share').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-agent-setup', 'Set up the agent… follows this project’s sharing control');
    const setup = (await focusContrastRatios(page)).find((item) => item.label === 'Set up the agent…');
    assert.ok(setup && setup.ratio >= 3, `Set up the agent…: focus contrast >= 3:1 (${setup && setup.ratio.toFixed(2)})`);

    await page.evaluate(() => window.__agent.shown(true));
    assert.equal(await page.locator('#btn-agent-setup').isVisible(), false, 'the entry goes while the column is shown');
    assert.equal(await page.locator('#agent-toggle').isVisible(), false, 'the toggle is for narrow windows only');
    await page.setViewportSize({ width: 320, height: 700 });
    const widths = await documentWidths(page);
    assert.equal(widths.document, widths.viewport, 'the page with the column reflows at 320 px');
    const toggle = page.getByRole('button', { name: 'Hide the agent' });
    assert.equal(await toggle.isVisible(), true, 'narrow windows get the toggle');
    assert.ok(await page.locator('#agent-slot').isVisible() && (await page.evaluate(() => window.__agent.bounds[window.__agent.bounds.length - 1])) !== null);
    await toggle.focus();
    const toggleRatio = (await focusContrastRatios(page)).find((item) => item.label === 'Hide the agent');
    assert.ok(toggleRatio && toggleRatio.ratio >= 3, `the toggle: focus contrast >= 3:1 (${toggleRatio && toggleRatio.ratio.toFixed(2)})`);
    await toggle.click();
    assert.equal(await page.locator('#agent-slot').isVisible(), false, 'folded, the slot goes');
    assert.equal(await page.evaluate(() => window.__agent.bounds[window.__agent.bounds.length - 1]), null, 'and the app is told there is no room for the column');
    assert.equal(await page.getByRole('button', { name: 'Show the agent' }).isVisible(), true);
  });
}

test('the whole flow from a browser tab: new project, session, agenda, minutes, invitation', { skip, timeout: 180000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  const parent = tmp();
  await page.getByRole('button', { name: 'New project…' }).click();
  assert.match(await page.locator('#dlg').textContent(), /with a research canvas and a decision log/, 'the dialog says what is created');
  assert.equal(await page.locator('#dlg input[name="mode"]').count(), 3);
  await page.getByLabel('Folder to create it in').fill(parent);
  await page.getByLabel('Name of the new folder').fill('paper-one');
  await page.getByLabel('Working title of the paper').fill('Why proposals get dropped');
  await page.getByLabel('Your name').fill('F. Author');
  await page.locator('#dlg').getByRole('radio', { name: /^Seed/ }).check();
  await page.locator('#dlg').getByRole('button', { name: 'Create project' }).click();
  await page.waitForFunction(() => document.getElementById('proj-name').textContent.length > 0);
  assert.equal((await page.locator('#proj-name').textContent()).trim(), 'Why proposals get dropped');
  assert.match(await page.locator('#proj-path').textContent(), /paper-one$/);
  assert.ok(fs.existsSync(path.join(parent, 'paper-one', 'research', 'canvas.md')));
  await sessionView(page).locator('#poster.active').waitFor();

  await page.getByRole('button', { name: 'To talk about', exact: true }).click();
  await sessionView(page).locator('#agenda.active').waitFor();

  await page.getByRole('button', { name: 'Start session…' }).click();
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  assert.equal(await page.getByLabel('What is the occasion?').getAttribute('aria-invalid'), 'true');
  await page.getByLabel('What is the occasion?').fill('Supervision');
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  await page.locator('#live').waitFor();
  assert.match(await page.locator('#live').textContent(), /Session running · 0:00/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'live');
  assert.match(fs.readFileSync(path.join(parent, 'paper-one', 'research', 'decisions.md'), 'utf8'), /SESSION · Supervision/);

  const minutes = path.join(tmp(), 'minutes.md');
  await page.getByRole('button', { name: 'Export minutes…' }).click();
  await page.getByLabel('Save the minutes as').fill(minutes);
  await page.locator('#dlg').getByRole('button', { name: 'Export minutes' }).click();
  await page.waitForFunction(() => /Saved the minutes/.test(document.getElementById('out-meeting').textContent));
  assert.ok(fs.existsSync(minutes));

  const keyFile = path.join(tmp(), 'paper-one.seal.key');
  await page.getByRole('button', { name: 'Invite co-author…' }).click();
  assert.match(await page.locator('#dlg').textContent(), /Do not paste it into a chat with an agent/);
  await page.getByLabel('Save the key file as').fill(keyFile);
  await page.locator('#dlg').getByRole('button', { name: 'Save key file' }).click();
  await page.waitForFunction(() => /Saved the key file/.test(document.getElementById('out-people').textContent));
  assert.ok(fs.existsSync(keyFile));
});

test('Join this project… appears only where the key is missing, and joins with a key file and a name', { skip, timeout: 120000 }, async (t) => {
  const { b, keyFile } = await twoPeopleSharingOneProject();
  // A second machine: same project, no key and no name in this state directory.
  const bare = await appGit.clone({ url: sh(b, 'remote', 'get-url', 'origin').trim(), parent: tmp(), folder: 'second' });
  assert.equal(bare.ok, true, bare.error);
  const joiner = bare.root;
  const keyPath = require('../hooks/lib/seal').keyPath(joiner);
  const saved = fs.existsSync(keyPath) ? fs.readFileSync(keyPath) : null;
  if (saved) fs.renameSync(keyPath, `${keyPath}.away`);
  t.after(() => { if (saved) fs.renameSync(`${keyPath}.away`, keyPath); });
  const srv = await startApp(t, { open: joiner });
  const page = await openPage(t, srv);
  const join = page.getByRole('button', { name: 'Join this project…' });
  await join.waitFor();
  await join.click();
  await page.getByLabel('Key file you received').fill(keyFile);
  await page.getByLabel('Your name').fill('C. Newcomer');
  await page.locator('#dlg').getByRole('button', { name: 'Join project' }).click();
  await page.waitForFunction(() => /You joined/.test(document.getElementById('out-people').textContent));
  assert.equal(await join.isVisible(), false, 'with the key in place Join goes away');
});

for (const colorScheme of ['light', 'dark']) {
  test(`keyboard path, focus contrast and reflow in ${colorScheme}`, { skip, timeout: 120000 }, async (t) => {
    const root = await makeProject();
    const srv = await startApp(t, { open: root });
    const page = await openPage(t, srv, { colorScheme });
    await page.locator('#proj-name').waitFor();
    await sessionView(page).locator('#poster.active').waitFor();

    // Keyboard path: the skip link, then the sidebar controls in reading order.
    const order = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => document.activeElement.id));
    }
    const expected = ['skip-link', 'btn-share', 'btn-session', 'btn-agenda', 'btn-minutes', 'btn-invite', 'btn-open', 'btn-clone', 'btn-new'];
    assert.deepEqual(order.slice(0, expected.length), expected, 'Tab walks the sidebar in reading order');

    const ratios = await focusContrastRatios(page);
    assert.ok(ratios.length >= 9, 'the sidebar controls were measured');
    for (const item of ratios) assert.ok(item.ratio >= 3, `${item.label}: focus contrast >= 3:1 (${item.ratio.toFixed(2)})`);
    t.diagnostic(`lowest focus contrast ${Math.min(...ratios.map((i) => i.ratio)).toFixed(2)}:1 in ${colorScheme}`);

    // Dialog fields show the same ring, and the dialog holds focus.
    await page.getByRole('button', { name: 'New project…' }).click();
    await page.locator('#dlg input[name="folder"]').focus();
    assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth), '3px');
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement === document.body || document.getElementById('dlg').contains(document.activeElement)), 'Tab never leaves the dialog');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-new', 'Escape returns to the invoker');

    // Reflow at 320 px: the sidebar stacks above the view, nothing scrolls sideways.
    await page.setViewportSize({ width: 320, height: 700 });
    let widths = await documentWidths(page);
    assert.equal(widths.document, widths.viewport, 'project page reflows at 320 px');
    await page.getByRole('button', { name: 'New project…' }).click();
    widths = await documentWidths(page);
    assert.equal(widths.document, widths.viewport, 'dialog reflows at 320 px');
    const bounds = await page.locator('#dlg').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320, 'the dialog fits the viewport');
  });
}

test('first-start page reflows at 320 px in light and dark', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv, { viewport: { width: 320, height: 700 } });
  await page.getByRole('heading', { name: 'Start with a paper project' }).waitFor();
  let widths = await documentWidths(page);
  assert.equal(widths.document, widths.viewport);
  await page.emulateMedia({ colorScheme: 'dark' });
  widths = await documentWidths(page);
  assert.equal(widths.document, widths.viewport);
  const ratios = await focusContrastRatios(page);
  for (const item of ratios) assert.ok(item.ratio >= 3, `${item.label}: focus contrast >= 3:1 (${item.ratio.toFixed(2)})`);
});

// -- The first author shares a project (spec 4.1) ----------------------------

// A computer with an empty home folder: no name, no keys. The server runs in
// this process, so the state directory it reads is the one set here.
function freshComputer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-computer-'));
  roots.push(dir);
  process.env.PLACET_RESEARCH_STATE_DIR = dir;
  t.after(() => { process.env.PLACET_RESEARCH_STATE_DIR = stateDir; });
  return dir;
}

function bareRemote(withCommit = false) {
  const dir = tmp();
  sh(dir, 'init', '--bare', '-b', 'main', 'remote.git');
  const url = `file://${path.join(dir, 'remote.git')}`;
  if (withCommit) {
    sh(dir, 'clone', url, 'seed');
    fs.writeFileSync(path.join(dir, 'seed', 'README.md'), 'files of someone else\n');
    sh(path.join(dir, 'seed'), 'add', '.');
    sh(path.join(dir, 'seed'), '-c', 'user.name=S', '-c', 'user.email=s@example.invalid', 'commit', '-m', 'readme');
    sh(path.join(dir, 'seed'), 'push', 'origin', 'main');
  }
  return { url, path: path.join(dir, 'remote.git') };
}

const nameOnThisComputer = (root) => require('../hooks/lib/identity').readName(root).name;

test('New project… asks for your name and writes it; the outcome names the next step', { skip, timeout: 180000 }, async (t) => {
  freshComputer(t);
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  const parent = tmp();
  await page.getByRole('button', { name: 'New project…' }).click();
  const dialog = page.locator('#dlg');
  assert.match(await dialog.textContent(), /git repository/, 'the dialog says the folder becomes a repository');
  const name = page.getByLabel('Your name');
  assert.equal(await name.inputValue(), '', 'this computer has no name yet');
  await page.getByLabel('Folder to create it in').fill(parent);
  await page.getByLabel('Name of the new folder').fill('first-paper');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  assert.equal(await name.getAttribute('aria-invalid'), 'true', 'a missing name is named, not skipped');
  assert.match(await page.locator('#dlg-error').textContent(), /Enter your name/);
  await name.fill('F. Newcomer');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await page.waitForFunction(() => /Created the project/.test(document.getElementById('out-project').textContent));
  const root = path.join(parent, 'first-paper');
  assert.equal(nameOnThisComputer(root), 'F. Newcomer');
  assert.equal(sh(root, 'rev-list', '--count', 'HEAD').trim(), '1', 'one commit of the research files');
  const outcome = await page.locator('#out-project').textContent();
  assert.match(outcome, /Share with co-authors…/);
  assert.match(outcome, /Start session…/);
  assert.doesNotMatch(outcome, /placet-research [a-z]/);

  // The name is known now: Start session… does not ask again.
  await page.getByRole('button', { name: 'Start session…' }).click();
  assert.equal(await page.getByLabel('Your name').count(), 0);
  await page.getByLabel('What is the occasion?').fill('Supervision');
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  await page.locator('#live').waitFor();

  // The next project's dialog starts with the name this computer has.
  await page.getByRole('button', { name: 'New project…' }).click();
  assert.equal(await page.getByLabel('Your name').inputValue(), 'F. Newcomer');
});

test('Start session… asks for a name where this computer has none, and an earlier error clears on the next try', { skip, timeout: 180000 }, async (t) => {
  freshComputer(t);
  const root = await makeProject();
  const srv = await startApp(t, { open: root });
  const page = await openPage(t, srv);
  await page.getByRole('button', { name: 'Start session…' }).click();
  const dialog = page.locator('#dlg');
  const name = page.getByLabel('Your name');
  assert.equal(await name.isVisible(), true);
  await dialog.getByRole('button', { name: 'Start session' }).click();
  assert.equal(await page.getByLabel('What is the occasion?').getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('#dlg-error').textContent(), /Name the occasion/);

  await page.getByLabel('What is the occasion?').fill('Supervision');
  await name.fill('G. Author');
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/app/session', async (route) => { await held; await route.continue(); });
  await dialog.getByRole('button', { name: /^(Start session|Working…)$/ }).click();
  await page.waitForFunction(() => /Working/.test(document.querySelector('#dlg button[type="submit"]').textContent));
  assert.equal((await page.locator('#dlg-error').textContent()).trim(), '', 'the earlier error is gone while the new request runs');
  assert.equal(await page.getByLabel('What is the occasion?').getAttribute('aria-invalid'), null);
  release();
  await page.locator('#live').waitFor();
  assert.equal(nameOnThisComputer(root), 'G. Author');
  assert.match(fs.readFileSync(path.join(root, 'research', 'decisions.md'), 'utf8'), /SESSION · Supervision/);
});

test('Share with co-authors… explains the steps, refuses a non-empty repository, shares into an empty one, and Invite shows the link', { skip, timeout: 240000 }, async (t) => {
  freshComputer(t);
  const root = await makeProject();
  assert.equal((await runCli(root, ['name', 'A. Author'])).ok, true);
  const srv = await startApp(t, { open: root });
  const page = await openPage(t, srv);
  const share = page.getByRole('button', { name: 'Share with co-authors…' });
  await share.waitFor();
  assert.equal(await page.getByRole('button', { name: /^Get updates/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Send my changes…' }).count(), 0);
  await share.click();
  const dialog = page.locator('#dlg');
  const text = await dialog.textContent();
  assert.match(text, /empty private repository on GitHub/);
  assert.match(text, /institute’s GitLab/);
  assert.match(text, /https link/);
  assert.match(text, /Clone from link…/);
  assert.match(text, /history as it is[\s\S]*everything else committed in this folder/, 'the dialog says what is uploaded');
  assert.match(text, /key that seals your entries stays on this computer/);
  assert.equal(await page.evaluate(() => document.activeElement.name), 'url', 'the dialog opens on its field');
  await dialog.getByRole('button', { name: 'Share project' }).click();
  assert.equal(await page.getByLabel('Link of the empty repository').getAttribute('aria-invalid'), 'true');

  // A repository that already holds files: refused in the dialog, nothing changed.
  const full = bareRemote(true);
  const heads = sh(full.path, 'for-each-ref');
  await page.getByLabel('Link of the empty repository').fill(full.url);
  await dialog.getByRole('button', { name: 'Share project' }).click();
  await page.waitForFunction(() => /already holds files/.test(document.getElementById('dlg-error').textContent));
  assert.match(await page.locator('#dlg-error').textContent(), /nothing was changed/);
  assert.equal(await page.getByLabel('Link of the empty repository').getAttribute('aria-invalid'), 'true');
  assert.equal(sh(root, 'remote').trim(), '');
  assert.equal(sh(full.path, 'for-each-ref'), heads);

  // An empty one: shared, and the outcome names the next step.
  const empty = bareRemote();
  await page.getByLabel('Link of the empty repository').fill(empty.url);
  await dialog.getByRole('button', { name: 'Share project' }).click();
  await page.waitForFunction(() => /Shared\./.test(document.getElementById('out-share').textContent));
  const outcome = await page.locator('#out-share').textContent();
  assert.match(outcome, /Invite co-author…/);
  assert.ok(outcome.includes(empty.url), 'the outcome shows the link');
  assert.equal(sh(empty.path, 'rev-list', '--count', 'main').trim(), '1');
  assert.equal(await share.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: /^Get updates/ }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Send my changes…' }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'proj-name', 'focus goes where the project begins');
  await page.getByRole('button', { name: 'Send my changes…' }).click();
  assert.doesNotMatch(await dialog.textContent(), /cloned from/, 'a project shared from here was not cloned');
  assert.match(await dialog.textContent(), /Uploads them to the shared copy,/);
  await page.keyboard.press('Escape');

  // Invite: the co-author needs the link and the key file.
  await page.getByRole('button', { name: 'Invite co-author…' }).click();
  assert.match(await dialog.textContent(), /two things/);
  assert.equal((await page.locator('#invite-link-line .link').textContent()).trim(), empty.url, 'the link from origin is shown');
  const keyFile = path.join(tmp(), 'first.seal.key');
  await page.getByLabel('Save the key file as').fill(keyFile);
  await dialog.getByRole('button', { name: 'Save key file' }).click();
  await page.waitForFunction(() => /Saved the key file/.test(document.getElementById('out-people').textContent));
  const invited = await page.locator('#out-people').textContent();
  assert.ok(invited.includes(empty.url) && /key file/.test(invited), 'the outcome repeats the link and the key file');
  assert.ok(fs.existsSync(keyFile));
});

test('a co-author who clones a project with an empty log sees Join at the top, and joins before working', { skip, timeout: 240000 }, async (t) => {
  freshComputer(t);
  const ctxA = context(tmp());
  assert.equal((await routes.init({ parent: tmp(), folder: 'shared', mode: 'brainstorming', title: 'Shared', name: 'A. Author' }, ctxA)).ok, true);
  const remote = bareRemote();
  assert.equal((await routes.share({ url: remote.url }, ctxA)).ok, true);
  const keyFile = path.join(tmp(), 'a.seal.key');
  assert.equal((await routes.invite({ out: keyFile }, ctxA)).ok, true);

  freshComputer(t);
  const cloned = await routes.clone({ url: remote.url, parent: tmp(), folder: 'shared' }, context(tmp()));
  assert.equal(cloned.ok, true, cloned.error);
  const b = cloned.current;
  const srv = await startApp(t, { open: b });
  const page = await openPage(t, srv);
  const line = page.locator('#join-line');
  await line.waitFor();
  assert.match(await line.textContent(), /has not joined this project yet/);
  assert.equal(await page.evaluate(() => document.getElementById('sidebar').firstElementChild.id), 'join-line', 'the first thing in the sidebar');
  const [lineBox, nameBox] = await Promise.all([line.boundingBox(), page.locator('#proj-name').boundingBox()]);
  assert.ok(lineBox.y < nameBox.y, 'above the project name, not below the fold');
  assert.equal(await page.getByRole('button', { name: 'Invite co-author…' }).count(), 0, 'no key to hand on');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btn-join', 'Tab reaches Join right after the skip link');

  // Before joining, an entry-writing action says why, in words and not as a command.
  await page.getByRole('button', { name: 'Start session…' }).click();
  await page.getByLabel('What is the occasion?').fill('Supervision');
  await page.getByLabel('Your name').fill('B. Supervisor');
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  await page.waitForFunction(() => /Join this project first/.test(document.getElementById('dlg-error').textContent));
  const refusal = await page.locator('#dlg-error').textContent();
  assert.match(refusal, /key file/);
  assert.doesNotMatch(refusal, /placet-research [a-z]|Do not run init/);
  assert.equal(fs.existsSync(require('../hooks/lib/seal').keyPath(b)), false, 'no key was created');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Join this project…' }).click();
  await page.getByLabel('Key file you received').fill(keyFile);
  await page.getByLabel('Your name').fill('B. Supervisor');
  await page.locator('#dlg').getByRole('button', { name: 'Join project' }).click();
  await page.waitForFunction(() => /You joined/.test(document.getElementById('out-people').textContent));
  assert.equal(await line.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Invite co-author…' }).isVisible(), true);

  await page.getByRole('button', { name: 'Start session…' }).click();
  assert.equal(await page.getByLabel('Your name').count(), 0, 'joining gave this computer its name');
  await page.getByLabel('What is the occasion?').fill('Supervision');
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  await page.locator('#live').waitFor();
  await page.getByRole('button', { name: 'Send my changes…' }).click();
  await page.locator('#dlg').getByRole('button', { name: 'Send changes' }).click();
  await page.waitForFunction(() => /Sent\./.test(document.getElementById('out-send').textContent));
  assert.match(sh(remote.path, 'show', 'main:research/decisions.md'), /SESSION · Supervision/, 'the shared copy holds the entry');
});

test('Clone from link… leads with the https link a co-author sent', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('button', { name: 'Clone from link…' }).click();
  const hint = await page.locator('#dlg label[for="f-url"] .hint').textContent();
  assert.match(hint, /^The https link your co-author sent you\./);
  assert.match(hint, /ssh:\/\/.*git@host:path/, 'the other forms are still named, after the first');
});

test('a second window with a used code says so and offers no controls',{ skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('heading', { name: 'Start with a paper project' }).waitFor();
  await page.goto('about:blank');
  await page.goto(`http://127.0.0.1:${srv.port}/app#c=${srv.code}`);
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /already opened elsewhere/);
  assert.equal(await page.getByRole('button').count(), 0);
});

for (const colorScheme of ['light', 'dark']) {
  test(`a ready update shows on the start page with a Restart now button (${colorScheme})`, { skip, timeout: 120000 }, async (t) => {
    const srv = await startApp(t);
    const page = await openPage(t, srv, { host: true, colorScheme });
    await page.getByRole('button', { name: 'New project…' }).first().waitFor();
    assert.equal(await page.locator('#out-app-start').textContent(), '');
    assert.equal(await page.locator('#start-restart').isVisible(), false);
    await page.evaluate(() => window.__sendUpdate({ state: 'ready', version: '9.9.9' }));
    await page.locator('#out-app-start', { hasText: 'Version 9.9.9 is ready. It installs when you quit Placet.' }).waitFor();
    const ratios = await focusContrastRatios(page);
    const restart = ratios.find((item) => /Restart now/.test(item.label));
    assert.ok(restart && restart.ratio >= 3, `Restart now: focus contrast >= 3:1 (${restart && restart.ratio.toFixed(2)})`);
    await page.locator('#start-restart').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__restarted), 1);
  });
}

test('in the sidebar: a failed check by hand says why and offers no restart', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t, { open: await makeProject() });
  const page = await openPage(t, srv, { host: true });
  await page.locator('#proj-name').waitFor();
  assert.equal(await page.locator('#app-group').isVisible(), false);
  await page.evaluate(() => window.__sendUpdate({ state: 'error', message: 'No connection to GitHub. Check again when you are online.' }));
  await page.locator('#out-app', { hasText: 'No connection to GitHub.' }).waitFor();
  assert.equal(await page.locator('#app-group').isVisible(), true);
  assert.equal(await page.locator('#btn-restart').isVisible(), false);
  assert.equal(await page.locator('#out-app').getAttribute('data-kind'), 'problem');
});

test('in a browser tab there is no update line at all', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('button', { name: 'New project…' }).first().waitFor();
  assert.equal(await page.evaluate(() => typeof window.__sendUpdate), 'undefined');
  assert.equal(await page.locator('#app-group').isVisible(), false);
  assert.equal(await page.locator('#out-app-start').textContent(), '');
});

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// The server of this run is on macOS or Linux. To see the page as a Windows
// server presents it, the answer of /api/app/projects is rewritten in flight.
async function asWindowsServer(page, home) {
  await page.route('**/api/app/projects', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, host: { platform: 'win32', home, sep: '\\' } } });
  });
}

test('browser mode: a path pasted with quotes opens the project', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('button', { name: 'Open project…' }).first().click();
  await page.getByLabel(/Project folder/).fill(`  "${root}"  `);
  await page.locator('#dlg').getByRole('button', { name: 'Open project' }).click();
  await page.locator('#proj-name').waitFor();
  assert.equal(await page.locator('#proj-name').isVisible(), true, 'the quoted, padded path reached the same check as a clean one');
});

test('browser mode: path fields start in the home folder and say how to copy a path', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  await page.getByRole('button', { name: 'New project…' }).first().click();
  assert.equal(await page.getByLabel(/Folder to create it in/).inputValue(), os.homedir(), 'the folder to create it in starts at the home folder');
  await page.getByText(/Option\+Command\+C/).first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open project…' }).first().click();
  assert.equal(await page.getByLabel(/Project folder/).inputValue(), os.homedir());
  await page.getByText(/Option\+Command\+C/).first().waitFor();
});

test('with a host bridge, path fields stay empty and the plain hints stay hidden', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv, { host: true });
  await page.getByRole('button', { name: 'New project…' }).first().click();
  assert.equal(await page.locator('#dlg #f-parent').inputValue(), '');
  assert.equal(await page.locator('#dlg [data-plain]:visible').count(), 0);
});

test('browser mode: after Export minutes, the path and a Copy path button', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const srv = await startApp(t, { open: root });
  const page = await openPage(t, srv);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const out = path.join(tmp(), 'minutes.md');
  await page.getByRole('button', { name: 'Start session…' }).click();
  await page.getByLabel('What is the occasion?').fill('Supervision');
  if (await page.locator('#dlg #f-name').count()) await page.locator('#dlg #f-name').fill('A. Author');
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  await page.locator('#live').waitFor();
  await page.getByRole('button', { name: 'Export minutes…' }).click();
  await page.getByLabel('Save the minutes as').fill(out);
  await page.locator('#dlg').getByRole('button', { name: 'Export minutes' }).click();
  await page.locator('#out-meeting').getByText(out).waitFor();
  const copy = page.locator('#out-meeting').getByRole('button', { name: 'Copy path' });
  await copy.waitFor();
  await copy.click();
  await page.locator('#out-meeting').getByRole('button', { name: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), out, 'the button copied the path');
  if (process.env.APP_SHELL_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, 'light-copy-path-1440.png') });
  const copyRatio =(await focusContrastRatios(page)).find((item) => item.label === 'Copied');
  assert.ok(copyRatio && copyRatio.ratio >= 3, `Copy path: focus contrast >= 3:1 (${copyRatio && copyRatio.ratio.toFixed(2)})`);
});

test('with a host bridge, the outcome after Export minutes has no Copy path button', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const srv = await startApp(t, { open: root });
  const page = await openPage(t, srv, { host: true });
  const out = path.join(tmp(), 'minutes.md');
  await page.evaluate((p) => { window.__picked = p; }, out);
  await page.getByRole('button', { name: 'Start session…' }).click();
  await page.getByLabel('What is the occasion?').fill('Supervision');
  if (await page.locator('#dlg #f-name').count()) await page.locator('#dlg #f-name').fill('A. Author');
  await page.locator('#dlg').getByRole('button', { name: 'Start session' }).click();
  await page.locator('#live').waitFor();
  await page.getByRole('button', { name: 'Export minutes…' }).click();
  await page.getByRole('button', { name: 'Choose…' }).click();
  await page.locator('#dlg').getByRole('button', { name: 'Export minutes' }).click();
  await page.locator('#out-meeting').getByText(/Saved the minutes/).waitFor();
  assert.equal(await page.locator('#out-meeting button').count(), 0);
});

test('browser mode: an open that warns about OneDrive opens the project and says what to do', { skip, timeout: 120000 }, async (t) => {
  const root = await makeProject();
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  const warning = 'This project lies in a folder synced by OneDrive. If git reports odd changes or locked files, move it to a folder outside OneDrive.';
  await page.route('**/api/app/open', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), warning } });
  });
  await page.getByRole('button', { name: 'Open project…' }).first().click();
  await page.getByLabel(/Project folder/).fill(root);
  await page.locator('#dlg').getByRole('button', { name: 'Open project' }).click();
  await page.locator('#out-project[data-kind="problem"]').waitFor();
  assert.equal(await page.locator('#out-project').innerText().then((s) => s.includes(warning)), true);
  assert.equal(await page.locator('#proj-name').isVisible(), true, 'the project is open anyway');
});

test('browser mode: the onedrive refusal of New project shows next to the button, in plain words', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const page = await openPage(t, srv);
  const error = 'This folder is synced by OneDrive (C:\\Users\\x\\OneDrive). Choose a folder outside OneDrive, for example C:\\Users\\x\\research.';
  await page.route('**/api/app/init', (route) => route.fulfill({ json: { ok: false, code: 'onedrive', error } }));
  await page.getByRole('button', { name: 'New project…' }).first().click();
  await page.getByLabel(/Name of the new folder/).fill('paper');
  await page.getByLabel('Your name').fill('A. Author');
  await page.locator('#dlg').getByRole('button', { name: 'Create project' }).click();
  await page.waitForFunction(() => /synced by OneDrive/.test(document.getElementById('dlg-error').textContent));
  assert.equal(await page.locator('#dlg-error').textContent(), error);
  assert.equal(await page.locator('[role="status"]').count(), 0, 'no toast');
});

test('a used link in a Windows browser names the start file', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const first = await openPage(t, srv);
  await first.getByRole('heading', { name: 'Start with a paper project' }).waitFor();
  const again = await openPage(t, srv, { userAgent: WINDOWS_UA });
  await again.getByRole('alert').waitFor();
  assert.match(await again.getByRole('alert').textContent(), /double-click Start placet-research again/);
  assert.doesNotMatch(await again.getByRole('alert').textContent(), /Ctrl\+C/);
  if (process.env.APP_SHELL_CAPTURE_DIR) await again.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, 'light-windows-used-link-1440.png') });
});

test('a used link in another browser names the terminal', { skip, timeout: 120000 }, async (t) => {
  const srv = await startApp(t);
  const first = await openPage(t, srv);
  await first.getByRole('heading', { name: 'Start with a paper project' }).waitFor();
  const again = await openPage(t, srv, { userAgent: MAC_UA });
  await again.getByRole('alert').waitFor();
  assert.match(await again.getByRole('alert').textContent(), /Ctrl\+C/);
});

for (const colorScheme of ['light', 'dark']) {
  test(`browser mode on Windows: dialogs name File Explorer and fit the page (${colorScheme})`, { skip, timeout: 120000 }, async (t) => {
    const srv = await startApp(t);
    const home = 'C:\\Users\\researcher';
    const page = await openPage(t, srv, { userAgent: WINDOWS_UA, colorScheme, before: (p) => asWindowsServer(p, home) });
    await page.getByRole('button', { name: 'Clone from link…' }).first().waitFor();
    await page.getByRole('button', { name: 'Clone from link…' }).first().click();
    const urlHint = await page.locator('#dlg label[for="f-url"] .hint').textContent();
    assert.match(urlHint, /^The https link your co-author sent you\./, 'the first sentence is unchanged');
    assert.match(urlHint, /an ssh link needs a key set up in a terminal/);
    assert.match(await page.locator('#dlg').innerText(), /right-click the folder \(Shift\+right-click on Windows 10\) and choose Copy as path/);
    assert.equal(await page.getByLabel(/Folder to download it into/).inputValue(), home);
    if (process.env.APP_SHELL_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, colorScheme + '-windows-clone-1440.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open project…' }).first().click();
    assert.equal(await page.getByLabel(/Project folder/).inputValue(), home);
    if (process.env.APP_SHELL_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.APP_SHELL_CAPTURE_DIR, colorScheme + '-windows-open-1440.png') });
    await page.setViewportSize({ width: 320, height: 720 });
    assert.deepEqual(await documentWidths(page), { document: 320, viewport: 320 }, 'the dialog reflows to 320 px');
  });
}
