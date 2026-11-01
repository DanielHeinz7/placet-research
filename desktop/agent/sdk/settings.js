'use strict';
// What the SDK way keeps in the app's data folder: the connection without
// its secret, and the last session ID per project.
const fs = require('node:fs');
const path = require('node:path');

const file = (dataDir) => path.join(dataDir, 'agent-sdk.json');

function readSettings(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(file(dataDir), 'utf8')) || {};
    return { connection: s.connection || null, sessions: s.sessions || {} };
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return { connection: null, sessions: {} };
    throw err;
  }
}

function writeSettings(dataDir, patch) {
  if (patch.connection && Object.keys(patch.connection).some((k) => /secret|key|token/i.test(k))) throw new Error('A secret does not belong in the settings file.');
  const next = { ...readSettings(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file(dataDir));
}

module.exports = { readSettings, writeSettings };
