'use strict';
// The desktop app's own memory: recent projects. Lives in the app's data
// folder, never in a project, and holds no token, key or credential.
const fs = require('node:fs');
const path = require('node:path');

const MAX_RECENT = 10;

function storeFile(dataDir) {
  return path.join(dataDir, 'app-state.json');
}

function readStore(dataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(dataDir), 'utf8'));
    return { recent: Array.isArray(data.recent) ? data.recent.filter((p) => typeof p === 'string') : [] };
  } catch {
    return { recent: [] };
  }
}

function remember(dataDir, root) {
  const recent = [root, ...readStore(dataDir).recent.filter((p) => p !== root)].slice(0, MAX_RECENT);
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${storeFile(dataDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ recent }, null, 2)}\n`);
  fs.renameSync(tmp, storeFile(dataDir));
  return recent;
}

module.exports = { readStore, remember, MAX_RECENT };
