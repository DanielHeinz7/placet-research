'use strict';
// The SDK way end to end in the real app: the real agent binary against the
// fake model (test/support/fake-model.js) and the fake `security`
// (test/support/fake-security.js). No key, gateway or account of anyone is
// used. Playwright is a devDependency of the repository root, as for
// smoke.test.js; without it the test is skipped, not failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startFakeModel } = require('./support/fake-model');
const { fakeSecurity, trackDir } = require('./support/fake-security');

let electron;
try { ({ _electron: electron } = require('playwright')); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}
const skip = electron ? false : 'Playwright is not installed; run `npm install && npm run setup:browsers` at the repository root.';

const pluginRoot = path.join(__dirname, '..', '..', 'plugins', 'placet-research');
const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;

test('the SDK way: connect through the Keychain, a guarded turn, links, and no token on disk', { skip, timeout: 300000 }, async () => {
  const token = `fake-secret-${crypto.randomBytes(12).toString('hex')}`;
  // 1. The first turn answers the connection test; the second is the person's message.
  const model = await startFakeModel({
    script: [[{ type: 'text', text: 'ready' }], [{ type: 'text', text: 'Statement 1.1 holds; 9.999 does not exist.' }]],
  });
  // 2. The fake security stands in for the login Keychain.
  const sec = fakeSecurity();
  const userData = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-desktop-')));
  const home = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-home-')));
  // 3. A copy of the fixture project, opened through the shell's own dialog.
  const project = path.join(trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-proj-'))), 'voice-uptake');
  fs.cpSync(path.join(pluginRoot, 'test', 'fixtures', 'voice-uptake'), project, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'), args: [path.join(__dirname, '..')],
    env: { ...process.env, HOME: home, PLACET_RESEARCH_TEST_USER_DATA: userData, PLACET_RESEARCH_TEST_SECURITY: sec.bin },
  });
  try {
    const win = await shellPage(app);
    // The column's page offers the choice of way until the person picks one.
    const column = await findPage(app, (p) => p.url().endsWith('panel.html'));
    await column.getByRole('button', { name: /Pay per use/ }).click();
    await openProject(app, win, column, project);

    // 4. The column: the institute gateway at the fake's address, the token, the model.
    await column.getByLabel('Institute gateway').check();
    await column.getByLabel('Gateway address').fill(model.url);
    await column.getByLabel('Key or token').fill(token);
    await column.getByLabel('Model', { exact: true }).fill('fake-model');
    await column.getByRole('button', { name: 'Test connection and continue' }).click();

    // 5. The guard is seen to start before the first message goes out.
    await column.locator('#h-guard-text').filter({ hasText: 'Guard on' }).waitFor({ timeout: 90000 });
    assert.equal(await column.locator('#h-guard-text').textContent(), `Guard on · placet-research ${pluginVersion}`);

    // 6. A message, the reply with a link for 1.1 and plain text for 9.999.
    await column.locator('#msg').fill('Hello');
    await column.getByRole('button', { name: 'Send', exact: true }).click();
    const reply = column.locator('li.agent');
    await reply.getByText('does not exist').waitFor({ timeout: 60000 });
    assert.deepEqual(await reply.locator('a.stmt').allTextContents(), ['1.1']);
    assert.equal(await reply.locator('a', { hasText: '9.999' }).count(), 0);
    await reply.locator('a.stmt', { hasText: '1.1' }).click();
    await win.frameLocator('#session-frame').locator('[id="st-1.1"]:focus').waitFor();

    // 7. The column page has no host bridge of the shell and no route to the local API.
    const shellOrigin = new URL(win.url()).origin;
    assert.equal(await column.evaluate(() => typeof window.harnessHost), 'undefined');
    assert.equal(await column.evaluate(() => fetch('/api/state').then(() => 'reached', () => 'blocked')), 'blocked');
    assert.equal(await column.evaluate((origin) => fetch(`${origin}/api/state`).then(() => 'reached', () => 'blocked'), shellOrigin), 'blocked');

    // The token went through the fake Keychain to the fake model, as a bearer token.
    assert.ok(Object.values(sec.items()).includes(token), 'the token was stored through security');
    assert.ok(model.requests.some((r) => r.headers.authorization === `Bearer ${token}`), 'the fake model received the token as a bearer token');
  } finally {
    await app.close();
    await model.close();
  }

  // 8. No file under the user data folder contains the token.
  let scanned = 0;
  for (const file of fs.readdirSync(userData, { recursive: true })) {
    const full = path.join(userData, String(file));
    if (!fs.statSync(full).isFile()) continue;
    scanned += 1;
    assert.ok(!fs.readFileSync(full, 'latin1').includes(token), `the token is in ${path.relative(userData, full)}`);
  }
  assert.ok(scanned > 0, 'the scan found files to look through');
});

test('the SDK way: a project opened before a way is chosen keeps the choice of way', { skip, timeout: 120000 }, async () => {
  const sec = fakeSecurity();
  const userData = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-desktop-')));
  const home = trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-home-')));
  const project = path.join(trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-proj-'))), 'voice-uptake');
  fs.cpSync(path.join(pluginRoot, 'test', 'fixtures', 'voice-uptake'), project, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'), args: [path.join(__dirname, '..')],
    env: { ...process.env, HOME: home, PLACET_RESEARCH_TEST_USER_DATA: userData, PLACET_RESEARCH_TEST_SECURITY: sec.bin },
  });
  try {
    const win = await shellPage(app);
    const column = await findPage(app, (p) => p.url().endsWith('panel.html'));
    await column.locator('#choose-h').waitFor();
    await openProject(app, win, column, project);
    // The project came first: the column still asks, and has not gone on to the connect form.
    await new Promise((r) => setTimeout(r, 1000)); // room for the column to act on the project change
    await column.locator('#choose-h').waitFor({ state: 'visible' });
    assert.equal(await column.locator('#v-connect').isVisible(), false);
    assert.equal(await column.locator('#v-thread').isVisible(), false);
    await column.getByRole('button', { name: /Pay per use/ }).click();
    await column.locator('#connect-h').waitFor({ state: 'visible' });
  } finally {
    await app.close();
  }
});

// Opens the project through the shell's own dialog and waits until the app has passed it on to the column.
async function openProject(app, win, column, project) {
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, project);
  await win.locator('#start-open').click();
  await win.getByRole('button', { name: 'Choose…' }).click();
  await win.getByRole('button', { name: 'Open project', exact: true }).click();
  await win.getByText(/^Opened .*voice-uptake\.$/).waitFor({ timeout: 60000 });
  for (let i = 0; i < 100 && !(await column.evaluate(() => window.agentPanel.state())).project; i++) await new Promise((r) => setTimeout(r, 100));
}

// The column's page is a WebContentsView; app.windows() lists it (see smoke.test.js).
async function findPage(app, match) {
  for (let i = 0; i < 300; i++) {
    const page = app.windows().find(match);
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('page not found among app.windows(): ' + app.windows().map((p) => p.url()).join(', '));
}

const shellPage = (app) => findPage(app, (p) => p.url().startsWith('http://127.0.0.1:'));
