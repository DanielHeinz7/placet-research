'use strict';
// Copies the plugin into build/plugin for electron-builder's extraResources,
// without its tests and any installed modules.
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', 'plugins', 'placet-research');
const dest = path.join(__dirname, '..', 'build', 'plugin');
const skip = new Set([path.join(src, 'test'), path.join(src, 'node_modules')]);

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true, filter: (p) => !skip.has(p) });
console.log(`bundled ${src} -> ${dest}`);
