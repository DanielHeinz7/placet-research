'use strict';
// Measuring helpers for the rendered tests of the session view and the shell
// page: starting Chromium, the focus-ring contrast of every visible control,
// and how far a page overflows its viewport.

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND') throw err;
}

// Playwright's own Chromium when it is installed, the system channel otherwise.
async function launchChromium() {
  try { return await chromium.launch(); } catch (err) {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    return chromium.launch({ channel: 'chromium' });
  }
}

// The focus ring surrounds each control on its containing surface, not its fill:
// contrast of the outline against the first opaque ancestor background. Runs in
// the page, so it is self-contained.
function focusContrastRatios(page) {
  return page.evaluate(() => {
    const luminance = (rgb) => rgb.map((c) => c / 255).map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
    const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    return [...document.querySelectorAll('a,button,summary,input,textarea,[tabindex]')].filter((node) => node.getClientRects().length && !node.disabled).map((node) => {
      node.focus();
      let parent = node.parentElement;
      while (parent && getComputedStyle(parent).backgroundColor === 'rgba(0, 0, 0, 0)') parent = parent.parentElement;
      const css = getComputedStyle(node);
      const foreground = luminance(rgb(css.outlineColor));
      const background = luminance(rgb(getComputedStyle(parent).backgroundColor));
      return { label: node.textContent.trim().slice(0, 40), ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
    });
  });
}

// Width of the laid-out document against the viewport; equal means the page
// reflows instead of scrolling sideways.
function documentWidths(page) {
  return page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
}

module.exports = { chromium, launchChromium, focusContrastRatios, documentWidths };
