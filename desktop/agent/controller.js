'use strict';
// The agent column's state. Finds Claude Code, offers install, sign-in and
// update, starts one session at a time in the current project and watches for
// the plugin's marker. Electron-free: index.js wires it to the window, and
// test/agent-controller.test.js drives it with fakes.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { planLabel } = require('./auth');
const { claudeArgs, agentEnv } = require('./launch');
const { waitForMarker, classify, guardLine } = require('./marker');
const { readAgentStore, writeAgentStore } = require('./store');

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';

function exitWords(code) {
  return code === 0 ? 'Claude Code ended.' : `Claude Code stopped with exit code ${code}.`;
}

function createController(deps) {
  const events = new EventEmitter();
  const stored = readAgentStore(deps.dataDir);
  let state = {
    phase: 'no-project', version: null, plan: null, guard: null, exit: null, project: null, sessionProject: null,
    canContinue: false, screenReader: stored.screenReader, screenReaderMode: deps.screenReaderMode(), pluginVersion: deps.pluginVersion, step: null,
  };
  let found = null;
  let proc = null;
  let markerPath = null;
  let markerDone = Promise.resolve();
  let pathPromise = null;

  function set(patch) { state = { ...state, ...patch }; events.emit('state', state); }
  function loginPath() { if (!pathPromise) pathPromise = deps.loginPath(); return pathPromise; }

  async function refresh() {
    if (!state.project) return set({ phase: 'no-project' });
    // With the SDK way chosen, Claude Code stays off: nothing is checked,
    // installed or started, and this column's first run is skipped. The SDK
    // way's own controller owns the column then.
    if (readAgentStore(deps.dataDir).way === 'sdk') return;
    if (proc && (state.phase === 'running' || state.phase === 'step-running')) return;
    set({ phase: 'checking' });
    found = await deps.locate();
    if (!found) return set({ phase: 'missing', version: null, plan: null });
    if (!found.supported) return set({ phase: 'outdated', version: found.version, plan: null });
    const auth = await deps.authStatus(found.path);
    if (!auth.loggedIn) return set({ phase: 'signed-out', version: found.version, plan: null });
    set({
      phase: 'ready', version: found.version, plan: auth.method === 'claude.ai' ? planLabel(auth.plan) : null,
      canContinue: readAgentStore(deps.dataDir).started.includes(state.project),
    });
  }

  function endProcess() {
    if (proc) { const p = proc; proc = null; p.kill(); }
  }

  async function spawn(file, args, { cwd, marker = null }) {
    endProcess();
    events.emit('clear');
    const env = agentEnv({ base: deps.baseEnv, loginPath: await loginPath(), shimsDir: deps.shimsDir, electronPath: deps.electronPath, git: deps.git, markerPath: marker || '' });
    if (!marker) delete env.PLACET_RESEARCH_APP_MARKER;
    const p = deps.spawn({ file, args, cwd, env, cols: deps.cols || 80, rows: deps.rows || 24 });
    proc = p;
    p.onData((d) => { if (proc === p) events.emit('data', d); });
    return p;
  }

  async function runStep(step) {
    const p = step === 'install'
      ? await spawn('/bin/bash', ['-c', INSTALL], { cwd: deps.baseEnv.HOME || '/' })
      : await spawn(found.path, step === 'login' ? ['auth', 'login', '--claudeai'] : ['update'], { cwd: deps.baseEnv.HOME || '/' });
    set({ phase: 'step-running', step, exit: null });
    p.onExit((code) => {
      if (proc !== p) return;
      proc = null;
      if (code === 0) refresh();
      else set({ phase: 'step-failed', exit: { code, words: `The step did not finish (exit code ${code}). Its output stays above.` } });
    });
  }

  async function startSession(resume) {
    const dir = path.join(deps.dataDir, 'agent');
    fs.mkdirSync(dir, { recursive: true });
    if (markerPath) fs.rmSync(markerPath, { force: true });
    markerPath = path.join(dir, `marker-${crypto.randomUUID()}.json`);
    const thisMarker = markerPath;
    const folder = state.project;
    const p = await spawn(found.path, claudeArgs({ pluginRoot: deps.pluginRoot, resume, screenReader: state.screenReader }), { cwd: folder, marker: thisMarker });
    const started = readAgentStore(deps.dataDir).started.filter((s) => s !== folder);
    writeAgentStore(deps.dataDir, { way: 'claude-code', notNow: false, started: [folder, ...started] });
    let exited = false;
    set({ phase: 'running', sessionProject: folder, exit: null, guard: { text: 'Checking the guard…', detail: null, warn: false } });
    p.onExit((code) => {
      exited = true;
      if (proc !== p) return;
      proc = null;
      set({ phase: 'exited', exit: { code, words: exitWords(code) } });
    });
    markerDone = waitForMarker(thisMarker, {
      timeoutMs: deps.markerTimeoutMs || 15000, intervalMs: deps.markerIntervalMs || 250,
      exited: () => exited || proc !== p,
      onTimeout: () => { if (markerPath !== thisMarker) return; set({ guard: guardLine(classify(null, { bundledRoot: deps.pluginRoot }), { exited: false }) }); },
    }).then((marker) => {
      if (markerPath !== thisMarker) return;
      set({ guard: guardLine(classify(marker, { bundledRoot: deps.pluginRoot }), { exited }) });
    });
  }

  async function run(step) {
    if (step === 'install' || step === 'login' || step === 'update') return runStep(step);
    if (step === 'start' || step === 'new' || step === 'restart') return startSession(false);
    if (step === 'continue') return startSession(true);
    if (step === 'not-now') { endProcess(); writeAgentStore(deps.dataDir, { notNow: true }); return set({ phase: state.project ? 'ready' : 'no-project' }); }
    if (step === 'screen-reader-on' || step === 'screen-reader-off') {
      const on = step === 'screen-reader-on';
      writeAgentStore(deps.dataDir, { screenReader: on });
      return set({ screenReader: on });
    }
    return undefined;
  }

  async function setProject(folder) {
    const changed = state.project !== folder;
    set({ project: folder });
    // The SDK way listens for this to end a conversation in the old project.
    if (changed) events.emit('project', folder);
    return refresh();
  }

  return {
    state: () => state,
    on: (event, cb) => events.on(event, cb),
    refresh, run, setProject,
    markerSettled: () => markerDone,
    sessionRunning: () => Boolean(proc) && state.phase === 'running',
    write: (data) => { if (proc) proc.write(data); },
    resize: (cols, rows) => { deps.cols = cols; deps.rows = rows; if (proc) proc.resize(cols, rows); },
    dispose: () => endProcess(),
  };
}

module.exports = { createController, exitWords };
