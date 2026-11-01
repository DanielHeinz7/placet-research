'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Playwright is a devDependency of the repository root, as for the plugin's
// rendered tests; the app itself does not depend on it. Without it the test is
// skipped, not failed.
let electron;
try { ({ _electron: electron } = require('playwright')); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}
const skip = electron ? false : 'Playwright is not installed; run `npm install && npm run setup:browsers` at the repository root.';

test('the app opens, shows the first-start page and keeps the token off disk', { skip, timeout: 120000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-desktop-'));
  // Playwright looks for Electron next to itself; this package has its own.
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, '..')], env: { ...process.env, PLACET_RESEARCH_TEST_USER_DATA: userData } });
  try {
    const win = await shellPage(app);
    // The window cannot be dragged narrower than this, so the sidebar and the
    // session view stay side by side.
    const minSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize());
    assert.equal(minSize[0], 960);
    await win.getByRole('button', { name: 'New project…' }).waitFor({ timeout: 90000 });
    assert.equal(await win.evaluate(() => typeof window.harnessHost.onUpdate), 'function');
    assert.equal(await win.evaluate(() => window.harnessHost.restartToUpdate().then(() => 'ok')), 'ok'); // a checkout has no updater; the call is a no-op
    assert.equal(new URL(win.url()).hash, '');
    const token = await win.evaluate(() => fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"x"}' }).then((r) => r.status));
    assert.equal(token, 403);                                     // the code was already redeemed by the shell
    for (const file of fs.readdirSync(userData, { recursive: true })) {
      const full = path.join(userData, String(file));
      if (fs.statSync(full).isFile()) assert.doesNotMatch(fs.readFileSync(full, 'latin1'), /[0-9a-f]{64}/, full);
    }
  } finally {
    await app.close();
  }
});

test('the agent column starts claude with the bundled plugin, the shims and a confirmed guard', { skip, timeout: 180000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-desktop-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-home-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude'), path.join(home, '.local', 'bin', 'claude'));
  fs.chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
  const project = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rh-proj-')), 'voice-uptake');
  fs.cpSync(path.join(__dirname, '..', '..', 'plugins', 'placet-research', 'test', 'fixtures', 'voice-uptake'), project, { recursive: true });
  require(path.join(__dirname, '..', '..', 'plugins', 'placet-research', 'hooks', 'lib', 'app-store.js')).remember(userData, project);
  // A person who has chosen Claude Code. With no way chosen, the column shows the SDK way's page instead.
  fs.writeFileSync(path.join(userData, 'agent.json'), JSON.stringify({ way: 'claude-code' }));

  const app = await electron.launch({
    executablePath: require('electron'), args: [path.join(__dirname, '..')],
    env: { ...process.env, HOME: home, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', PLACET_RESEARCH_TEST_USER_DATA: userData },
  });
  try {
    // Checked, not assumed: Electron's app.getPath('home') ignores an overridden
    // HOME on macOS and returns the real home, where the person's own claude
    // lives. The test retargets the app's home to the fake one with Electron's
    // own API before the project opens; the app itself stays as it is.
    await app.evaluate(({ app }, dir) => app.setPath('home', dir), home);
    const win = await shellPage(app);
    await win.getByRole('button', { name: path.basename(project) }).click();
    const column = await findPage(app, (p) => p.url().endsWith('column.html'));
    await column.getByRole('button', { name: 'Start the agent' }).click();
    await column.getByText('Guard on · placet-research').waitFor({ timeout: 30000 });
    await column.locator('.xterm-rows').getByText('I propose').waitFor();

    const args = fs.readFileSync(path.join(home, 'fake-claude.args'), 'utf8').trim().split('\n');
    assert.equal(args[0], '--plugin-dir');
    assert.equal(args[2], '--settings');
    assert.equal(args[3], '{"disableAllHooks":false,"enabledPlugins":{"placet-research@inline":true}}');
    assert.match(fs.readFileSync(path.join(home, 'fake-claude.node-path'), 'utf8'), /agent\/shims\/node$/m);
    assert.match(fs.readFileSync(path.join(home, 'fake-claude.node'), 'utf8'), /^\d+\.\d+\.\d+$/);
    assert.doesNotMatch(fs.readFileSync(path.join(home, 'fake-claude.env'), 'utf8'), /^ELECTRON_RUN_AS_NODE=/m);

    // 1.2b becomes a link that reveals the statement in the session view.
    const rows = column.locator('.xterm-rows div').first();
    const box = await rows.boundingBox();
    const cell = box.width / (await column.evaluate(() => window.__term.cols));
    const col = 'Claude Code 2.1.300: I propose '.length;
    await column.mouse.move(box.x + cell * (col + 1.5), box.y + box.height / 2);
    await column.getByRole('tooltip').getByText(/Uptake may be a property/).waitFor();
    await column.mouse.click(box.x + cell * (col + 1.5), box.y + box.height / 2);
    await win.frameLocator('#session-frame').locator('[id="st-1.2b"]:focus').waitFor();

    // The column page has no route to the local API.
    assert.equal(await column.evaluate(() => typeof window.harnessHost), 'undefined');
    assert.equal(await column.evaluate(() => fetch(location.origin).then(() => 'reached', () => 'blocked')), 'blocked');

    for (const file of fs.readdirSync(userData, { recursive: true })) {
      const full = path.join(userData, String(file));
      if (fs.statSync(full).isFile()) assert.doesNotMatch(fs.readFileSync(full, 'latin1'), /example\.invalid|Fake Org|org-fake/, full);
    }
  } finally {
    await app.close();
  }
});

// Checked, not assumed: app.windows() does list the page of the column's
// WebContentsView, so the CDP route the plan offered as a fallback is not
// needed. This is the branch that held.
async function findPage(app, match) {
  for (let i = 0; i < 100; i++) {
    const page = app.windows().find(match);
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('column page not found among app.windows()');
}

// The shell page, not the agent column's page: since the column became a
// WebContentsView created with the window, app.firstWindow() can return
// either, whichever loads first.
async function shellPage(app) {
  for (let i = 0; i < 900; i++) {
    const page = app.windows().find((p) => p.url().startsWith('http://127.0.0.1:'));
    if (page) return page;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('shell page not found among app.windows(): ' + app.windows().map((p) => p.url()).join(', '));
}
