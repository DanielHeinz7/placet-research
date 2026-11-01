'use strict';
// Has the guard been seen to start (spec 5.6)? Fed every SDK message in order;
// after each it answers null (not known yet), { state: 'on', version } or
// { state: 'off', cause }. "Off" is final: once given, it is the answer to
// every later message, so nothing turns the guard back on.
// The decision of 2026-10-15: the guard counts as started once placet-research's
// own SessionStart hook reports success with its context, and
// query.initializationResult() lists at least one placet-research: command.
// `init` is not required before the first message; if it arrives later
// without placet-research from the bundled path, that is a guard failure.
// SessionStart hooks from other sources (managed settings, another plugin)
// neither turn the guard on nor off. A hook_response does not say whose hook
// it was, so an answer that does not carry our context counts as ours only by
// elimination: once no SessionStart hook that started is still running.
// That assumes every SessionStart hook has started before the first answers,
// which is not checked against the bundled Claude Code. If another hook answers
// with a failure before ours starts, the guard reads off (SQ-317): the
// conversation ends without need, but a missing guard is never read as on.
// The version for the header line comes from the bundled manifest, not from
// reloadPlugins().
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_CAUSE = 'The placet-research plugin did not load.';
const HOOK_CAUSE = 'The guard’s start hook did not run. Settings installed on this Mac by your organisation may turn hooks off.';
const HOOK_FAILED_CAUSE = 'The placet-research start hook failed.';
const NO_PROJECT_CAUSE = 'The placet-research guard started but found no paper project here. Open a folder made with New project… or Clone…';

// The first line our SessionStart hook writes (hooks/inject-state.js).
const OUR_CONTEXT = /^placet-research · /;

// What one SessionStart answer says: 'ours', 'foreign' (something else was
// printed), 'silent' (success, nothing printed) or 'failed'. The hook's JSON
// is in stdout; `output` is stdout and stderr together.
function kindOf(msg) {
  if (msg.outcome !== 'success') return 'failed';
  const stdout = typeof msg.stdout === 'string' ? msg.stdout.trim() : '';
  if (!stdout) return 'silent';
  try { if (OUR_CONTEXT.test(JSON.parse(stdout).hookSpecificOutput.additionalContext)) return 'ours'; } catch { /* not our JSON */ }
  return 'foreign';
}

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function manifestVersion(pluginRoot) {
  for (const candidate of [path.join(pluginRoot, '.claude-plugin', 'plugin.json'), path.join(pluginRoot, 'plugin.json')]) {
    try {
      const version = JSON.parse(fs.readFileSync(candidate, 'utf8')).version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    } catch { /* try the next place the manifest may sit */ }
  }
  return null;
}

function hasOurCommands(commands) {
  return (commands || []).some((command) => command && typeof command.name === 'string' && command.name.startsWith('placet-research:'));
}

function createGuardCheck({ pluginRoot, commands = [] }) {
  const ourCommands = hasOurCommands(commands);
  const version = manifestVersion(pluginRoot);
  const bundled = realPath(pluginRoot);
  const running = new Set();   // SessionStart hooks that started and have not answered
  let answers = new Set();     // kinds answered since our hook was last settled
  let hook = null;             // our hook, last settled: 'ours' | 'failed' | 'silent'
  let initSeen = false;
  let initLists = false;
  let final = null;

  function decide() {
    if (final) return final;
    let d = null;
    if (initSeen && !initLists) d = { state: 'off', cause: PLUGIN_CAUSE };
    else if (hook === 'ours') d = ourCommands && version ? { state: 'on', version } : { state: 'off', cause: PLUGIN_CAUSE };
    else if (hook === 'failed') d = { state: 'off', cause: HOOK_FAILED_CAUSE };
    else if (hook === 'silent') d = { state: 'off', cause: NO_PROJECT_CAUSE };
    else if (initSeen) d = { state: 'off', cause: HOOK_CAUSE };
    if (d && d.state === 'off') final = d;
    return d;
  }

  function answered(msg) {
    const awaited = running.delete(msg.hook_id);
    const kind = kindOf(msg);
    answers.add(kind);
    if (kind === 'ours') hook = 'ours';
    // Once nothing is still running, a failed or silent answer was ours unless
    // one of the answers carried our context. Answers from other sources alone
    // change nothing, and one nobody waited for does not end the round.
    if (running.size || (!awaited && kind === 'foreign')) return;
    if (!answers.has('ours') && answers.has('failed')) hook = 'failed';
    else if (!answers.has('ours') && answers.has('silent')) hook = 'silent';
    answers = new Set();
  }

  return function feed(msg) {
    if (msg && msg.type === 'system') {
      if (msg.hook_event === 'SessionStart' && msg.subtype === 'hook_started') running.add(msg.hook_id);
      if (msg.hook_event === 'SessionStart' && msg.subtype === 'hook_response') answered(msg);
      if (msg.subtype === 'init') {
        initSeen = true;
        initLists = (msg.plugins || []).some((plugin) => plugin && plugin.name === 'placet-research'
          && typeof plugin.path === 'string' && realPath(plugin.path) === bundled);
      }
    }
    return decide();
  };
}

module.exports = { createGuardCheck };
