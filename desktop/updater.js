'use strict';
// App updates for builds signed with a Developer ID (spec 4.5). The signing
// mode comes from package.json, where dist.js writes it: electron-updater's
// own isUpdaterActive() only asks whether the app is packaged, and an ad-hoc
// build could not install an update anyway (Squirrel.Mac checks the signature).
const fs = require('node:fs');
const path = require('node:path');

const DAY = 24 * 60 * 60 * 1000;
const OFFLINE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_/;

function plainError(err) {
  const text = String((err && err.message) || err);
  if (OFFLINE.test(text)) return 'No connection to GitHub. Check again when you are online.';
  return `The update check did not work: ${text.split('\n')[0].slice(0, 200)}`;
}

// The one setting, "check automatically". It lives beside the app's other
// data (sub-project 1, spec 3.5), never in a project.
function fileSettings(dir) {
  const file = path.join(dir, 'updates.json');
  return {
    get() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).automatic !== false;
      } catch {
        return true;
      }
    },
    set(automatic) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ automatic: Boolean(automatic) })}\n`);
    },
  };
}

function createUpdater({ signing, autoUpdater, settings, send, every = setInterval }) {
  if (signing !== 'developer-id') return null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  let last = null;
  let byHand = false;
  const tell = (msg) => { last = msg; send(msg); };
  // An automatic check speaks only when an update is ready; one by hand always answers.
  autoUpdater.on('update-available', (info) => { if (byHand) tell({ state: 'downloading', version: info.version }); byHand = false; });
  autoUpdater.on('update-not-available', (info) => { if (byHand) tell({ state: 'current', version: info && info.version }); byHand = false; });
  autoUpdater.on('update-downloaded', (info) => tell({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => { if (byHand) tell({ state: 'error', message: plainError(err) }); byHand = false; });

  const check = (manual) => {
    byHand = manual;
    // The 'error' event carries the message; the rejection adds nothing.
    return Promise.resolve().then(() => autoUpdater.checkForUpdates()).catch(() => {});
  };
  return {
    start() {
      if (settings.get()) check(false);
      every(() => { if (settings.get()) check(false); }, DAY);
    },
    checkNow: () => check(true),
    restart: () => autoUpdater.quitAndInstall(),
    last: () => last,
  };
}

module.exports = { createUpdater, fileSettings, plainError, DAY };
