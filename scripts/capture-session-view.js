#!/usr/bin/env node
'use strict';

// Screenshots of the session view, taken from the committed state file at a
// fixed viewport size: the README's pictures and the video's UI scenes are
// captures of the same canvas, so nobody hand-makes them (SQ-223).
//
//   node scripts/capture-session-view.js --view log --out shot.png
//   node scripts/capture-session-view.js --width 1920 --height 1080 --out frame.png
//
// It serves plugins/placet-research/dashboard/canvas.html and
// docs/media/showcase-state.json on a free localhost port and opens the page in
// the mode the view reads fixtures in: `?fixture=<path>`. Playwright is not a
// dependency of the plugin — it is a devDependency of the repository, needed
// only here and in the rendered tests (see docs/media/README.md).

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseArgs } = require('node:util');

const repoRoot = path.resolve(__dirname, '..');
const canvasFile = path.join(repoRoot, 'plugins', 'placet-research', 'dashboard', 'canvas.html');
const stateFile = path.join(repoRoot, 'docs', 'media', 'showcase-state.json');

// The dashboard is one self-contained file; only the state comes from elsewhere.
const FILES = {
  '/': { file: canvasFile, type: 'text/html; charset=utf-8' },
  '/canvas.html': { file: canvasFile, type: 'text/html; charset=utf-8' },
  '/fixture.json': { file: stateFile, type: 'application/json' },
};

const USAGE = `Usage: node scripts/capture-session-view.js [options]

  --view <name>    poster (default), compare, agenda, log, element-<n>
  --width <px>     viewport width, default 1440
  --height <px>    viewport height, default 900
  --out <file>     PNG to write, default session-view.png in the current directory
  --dark           render the session view in its dark colour scheme
  -h, --help       this text

The page is the session view in fixture mode, rendered from
docs/media/showcase-state.json. Run it from anywhere in the repository
after \`npm install && npm run setup:browsers\`; the committed screenshots
and their commands are listed in docs/media/README.md.`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      view: { type: 'string', default: 'poster' },
      width: { type: 'string', default: '1440' },
      height: { type: 'string', default: '900' },
      out: { type: 'string', default: 'session-view.png' },
      dark: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (err) {
  console.error(`capture-session-view: ${err.message}\n\n${USAGE}`);
  process.exit(2);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const size = (name) => {
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`capture-session-view: --${name} needs a whole number of pixels, not ${JSON.stringify(values[name])}`);
    process.exit(2);
  }
  return n;
};
const width = size('width');
const height = size('height');
const out = path.resolve(process.cwd(), values.out);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  console.error('capture-session-view: Playwright is not installed. Get it with `npm install && npm run setup:browsers`.');
  process.exit(1);
}

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    const entry = FILES[pathname];
    if (!entry) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`not found: ${pathname}\n`);
      return;
    }
    res.writeHead(200, { 'content-type': entry.type });
    res.end(fs.readFileSync(entry.file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Playwright comes with two Chromium builds: the browser itself and the smaller
// headless shell it opens by default. Either one takes the same screenshot, so
// when only the full build is installed the launch falls back to it.
async function launch() {
  try {
    return await chromium.launch();
  } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    return chromium.launch({ channel: 'chromium' });
  }
}

async function main() {
  const { server, port } = await serve();
  const browser = await launch();
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: values.dark ? 'dark' : 'light',
    });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', (err) => failures.push(err.message));
    await page.goto(`http://127.0.0.1:${port}/?fixture=/fixture.json&view=${encodeURIComponent(values.view)}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#app section[data-view]').length > 0);

    // A view name the dashboard does not have renders nothing: say so here,
    // where the names it does have are known, instead of writing a blank PNG.
    const views = await page.evaluate(() => [...document.querySelectorAll('#app section[data-view]')]
      .map((s) => s.getAttribute('data-view')));
    if (!views.includes(values.view)) {
      throw new Error(`the dashboard has no view "${values.view}"; it has ${views.join(', ')}`);
    }
    const shown = await page.evaluate(() => [...document.querySelectorAll('#app section[data-view].active')]
      .map((s) => s.getAttribute('data-view')));
    if (!shown.includes(values.view)) {
      throw new Error(`the view "${values.view}" did not come up; the page shows ${shown.join(', ') || 'nothing'}`);
    }
    const alert = await page.evaluate(() => {
      const box = document.querySelector('#app [role="alert"]');
      const notice = document.getElementById('notice');
      if (box) return box.textContent.trim();
      return notice && !notice.hidden ? notice.textContent.trim() : null;
    });
    if (alert) throw new Error(`the view shows an error or a notice: ${alert}`);
    if (failures.length) throw new Error(`the page threw: ${failures.join('; ')}`);

    // Two frames, so the first paint and the view switch are behind us.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`wrote ${out} (${width}x${height}, ${fs.statSync(out).size} bytes)`);
}

main().catch((err) => {
  console.error(`capture-session-view: ${err.message}`);
  process.exit(1);
});
