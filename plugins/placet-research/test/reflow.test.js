'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'canvas.html'), 'utf8');
const state = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'media', 'showcase-state.json'), 'utf8');
// Restoring an unwrappable field strip or scrolling view tabs breaks access to
// fields and hides the active History tab on a 320px screen.
test('narrow navigation reflows instead of using a fixed-width horizontal strip', () => {
  assert.doesNotMatch(html, /min-width:\s*190px|overflow-x:\s*auto/);
  assert.match(html, /\.chips\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(html, /#view-tabs\s*\{[^}]*flex-wrap:\s*wrap/);
});

// Optional, as in showcase-state.test.js: Playwright comes from the repository
// root, installed with `npm install && npm run setup:browsers`. The plugin
// itself stays dependency-free, so the test skips when it is missing.
let chromium;
try { ({ chromium } = require('playwright')); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

const views = ['poster', 'compare', 'agenda', 'log', ...Array.from({ length: 9 }, (_, i) => `element-${i + 1}`)];

for (const [width, height] of [[320, 720], [390, 844], [600, 900], [768, 1024], [900, 1024]]) {
  test(`all session views reflow and keep navigation reachable at ${width}px`, { skip: !chromium, timeout: 120000 }, async (t) => {
    let browser;
    try { browser = await chromium.launch(); } catch (err) {
      if (!/Executable doesn't exist/.test(err.message)) throw err;
      browser = await chromium.launch({ channel: 'chromium' });
    }
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route('http://session.test/**', (route) => route.fulfill({
      contentType: route.request().url().endsWith('fixture.json') ? 'application/json' : 'text/html',
      body: route.request().url().endsWith('fixture.json') ? state : html,
    }));
    await page.goto('http://session.test/?fixture=/fixture.json&view=agenda');
    await page.waitForSelector('section[data-view].active');
    for (const view of views) {
      // Use the actual view controls: a field opens from the poster's "Open field".
      if (view.startsWith('element-')) {
        await page.locator('#view-tabs [data-view-target="poster"]').click();
        await page.locator(`#poster [data-view-target="${view}"]`).first().click();
      } else {
        await page.locator(`#view-tabs [data-view-target="${view}"]`).click();
      }
      await page.waitForSelector(`section[data-view="${view}"].active`);
      const metrics = await page.evaluate(() => {
        const stage = document.querySelector('#stage');
        const tabs = [...document.querySelectorAll('#view-tabs a')].map((node) => {
          const r = node.getBoundingClientRect();
          return { text: node.textContent, left: r.left, right: r.right, width: r.width, height: r.height };
        });
        const controls = [...document.querySelectorAll('button, summary, a')]
          .filter((node) => node.getClientRects().length)
          .map((node) => { const r = node.getBoundingClientRect(); return { text: node.textContent.trim(), width: r.width, height: r.height }; });
        return {
          documentWidth: document.documentElement.scrollWidth,
          stageWidth: stage.clientWidth, stageContent: stage.scrollWidth,
          tabs, controls,
          viewTop: document.querySelector('.view.active').getBoundingClientRect().top,
          chips: [...document.querySelectorAll('#fieldnav .chip')].map((node) => { const r = node.getBoundingClientRect(); return { text: node.getAttribute('aria-label'), left: r.left, right: r.right }; }),
          chipsBottom: document.querySelector('#fieldnav').getBoundingClientRect().bottom,
          comparisonContexts: [...document.querySelectorAll('#compare .cmp-context')].map((node) => getComputedStyle(node).position),
        };
      });
      assert.equal(metrics.documentWidth, width, `${view}: document scrollWidth equals viewport`);
      assert.equal(metrics.stageContent, metrics.stageWidth, `${view}: stage has no hidden horizontal overflow`);
      assert.ok(metrics.viewTop < height, view + ': selected content starts in the first screen');
      assert.equal(metrics.chips.length, 9, view + ': all nine field chips are reachable');
      for (const chip of metrics.chips) assert.ok(chip.left >= 0 && chip.right <= width, `${view}: chip "${chip.text}" is within the viewport`);
      assert.ok(metrics.chipsBottom <= metrics.viewTop + 1, view + ': the field chips sit above the content');
      for (const tab of metrics.tabs) {
        assert.ok(tab.left >= 0 && tab.right <= width, `${view}: ${tab.text} tab is within viewport`);
      }
      for (const control of metrics.controls) {
        assert.ok(control.width >= 24 && control.height >= 24, `${view}: ${control.text} target is at least 24x24 (${control.width}x${control.height})`);
      }
      if (view === 'compare' && width <= 600) {
        assert.equal(metrics.comparisonContexts.length, 27, 'each stacked comparison card retains its framing identity');
        assert.ok(metrics.comparisonContexts.every((position) => position === 'static'), 'stacked framing labels are visible, not sr-only');
      }
      t.diagnostic(`${width}x${height} ${view}: document.scrollWidth=${metrics.documentWidth}, stage=${metrics.stageContent}/${metrics.stageWidth}`);
      if (process.env.REFLOW_CAPTURE_DIR && [320, 390, 768].includes(width)) {
        fs.mkdirSync(process.env.REFLOW_CAPTURE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.REFLOW_CAPTURE_DIR, `${view}-${width}x${height}.png`) });
      }
    }
  });
}
