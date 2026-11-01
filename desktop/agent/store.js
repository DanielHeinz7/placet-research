'use strict';
// What the app remembers about the agent, in its own data folder. No email,
// organisation, token or credential ever goes here.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { way: null, notNow: false, screenReader: false, started: [] };

function file(dataDir) { return path.join(dataDir, 'agent.json'); }

function readAgentStore(dataDir) {
  try {
    const j = JSON.parse(fs.readFileSync(file(dataDir), 'utf8'));
    return {
      way: j.way === 'claude-code' || j.way === 'sdk' ? j.way : null,
      notNow: j.notNow === true,
      screenReader: j.screenReader === true,
      started: Array.isArray(j.started) ? j.started.filter((s) => typeof s === 'string').slice(0, 50) : [],
    };
  } catch (_) {
    return { ...DEFAULTS, started: [] };
  }
}

function writeAgentStore(dataDir, patch) {
  const next = { ...readAgentStore(dataDir), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file(dataDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file(dataDir));
  return next;
}

module.exports = { readAgentStore, writeAgentStore };
