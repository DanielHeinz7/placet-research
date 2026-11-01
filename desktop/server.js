'use strict';
// Runs in an Electron utilityProcess: starts the plugin's server in app mode
// and hands the main process the URL with the single-use code. The token
// never leaves this process except to the page that redeems the code.
const path = require('node:path');

const pluginRoot = process.env.PLACET_RESEARCH_PLUGIN;
const { start } = require(path.join(pluginRoot, 'bin', 'canvas-serve.js'));

start({ root: null, pluginRoot, app: { dataDir: process.env.PLACET_RESEARCH_APP_DATA } }).then(
  (running) => process.parentPort.postMessage({ url: running.appUrl }),
  (err) => process.parentPort.postMessage({ error: err.message }),
);
