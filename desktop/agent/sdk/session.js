'use strict';
// One conversation in the current project. The person's messages go in
// through a queue; thread events come out. Nothing is sent before the guard
// is seen to start (spec 5.6). Task 1's C2 showed that `init` does not arrive
// until the first message, so the two signals that do exist beforehand are the
// SessionStart hook_response and the placet-research commands of
// initializationResult(); guard-check decides on those. Every open ask is
// denied when the turn is stopped or the conversation ends, so nothing waits
// forever.
const { createGuardCheck } = require('./guard-check');
const { createMapper } = require('./events');

// C8: the binary lists the subagent tool as `Task`, the model calls it `Agent`;
// neither reaches canUseTool, and the two names are one tool here.
const NO_ASK = new Set(['Skill', 'Task', 'Agent']);

function askLine(toolName, input = {}, blockedPath) {
  const outside = blockedPath ? ', outside the project' : '';
  switch (toolName) {
    case 'WebFetch': return `Fetch ${input.url}`;
    case 'WebSearch': return `Search the web for “${input.query}”`;
    case 'Read': return `Read ${input.file_path}${outside}`;
    case 'Edit':
    case 'Write': return `${toolName} ${input.file_path}${outside}`;
    case 'Bash': return `Run ${String(input.command || '').split('\n')[0]}`;
    default: return `Use ${toolName}`;
  }
}

function createInbox() {
  const queue = [];
  let wake = null;
  let ended = false;
  return {
    push(item) { queue.push(item); if (wake) { wake(); wake = null; } },
    end() { ended = true; if (wake) { wake(); wake = null; } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue; }
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

function createSession({ query, options, pluginRoot, cwd, onEvent, startTimeoutMs = 30000 }) {
  const inbox = createInbox();
  const asks = new Map();
  let nextAsk = 1;
  let guard = null;
  let busy = false;
  let q = null;
  let sawInit = false;
  let closed = false;

  const denyAll = (message) => { for (const [id, a] of asks) { asks.delete(id); a.resolve({ behavior: 'deny', message }); } };

  const canUseTool = (toolName, input, { signal, blockedPath } = {}) => {
    if (NO_ASK.has(toolName)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      const id = String(nextAsk++);
      asks.set(id, { resolve, input });
      if (signal) signal.addEventListener('abort', () => { if (asks.delete(id)) resolve({ behavior: 'deny', message: 'The request was cancelled.' }); });
      onEvent({ kind: 'ask', id, line: askLine(toolName, input, blockedPath) });
    });
  };

  // The guard goes on once. A later "off" (an init without the plugin from the
  // bundled path, or our start hook failing) stops the turn and ends the
  // conversation; nothing turns it back on.
  function decide(d) {
    if (guard === 'off' || guard === d.state) return;
    guard = d.state;
    onEvent({ kind: 'guard', ...d });
    if (d.state === 'off') close();
  }

  async function start() {
    const opts = options(canUseTool);
    q = query({ prompt: inbox, options: opts });
    // The guard has to be decided from what is there before the first message,
    // so the commands are asked for first. Without them, or without a
    // SessionStart hook that succeeded, guard-check leaves the guard off.
    let commands = [];
    try {
      if (typeof q.initializationResult === 'function') commands = (await q.initializationResult()).commands || [];
    } catch { /* no commands to show: the guard stays off */ }
    const check = createGuardCheck({ pluginRoot, commands });
    const map = createMapper({ cwd });
    const timer = setTimeout(() => decide({ state: 'off', cause: 'The agent did not start within 30 seconds.' }), startTimeoutMs);
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') sawInit = true;
        // Every message goes to the check, also after "on": init comes only
        // with the first message, just before the first model request. Once
        // the guard is off, nothing more from this query reaches the thread.
        const d = check(msg);
        if (d) { clearTimeout(timer); decide(d); }
        if (guard === 'off') break;
        for (const ev of map(msg)) {
          if (ev.kind === 'turn-end') busy = false;
          onEvent(ev);
        }
      }
    } catch (err) {
      const text = String((err && err.message) || 'exit');
      // With sandbox.failIfUnavailable at its default, a missing sandbox ends
      // the query before init; the panel words it (spec 8).
      if (!guard && /sandbox/i.test(text)) decide({ state: 'off', cause: 'sandbox' });
      else if (!closed) onEvent({ kind: 'stopped', reason: text });
    } finally {
      clearTimeout(timer);
      if (opts.resume && !sawInit) onEvent({ kind: 'resume-failed' });
      else if (!guard) decide({ state: 'off', cause: 'The agent stopped before it started.' });
      denyAll('The conversation ended.');
    }
  }

  function send(text) {
    if (guard !== 'on' || busy || closed || typeof text !== 'string' || !text.trim()) return false;
    busy = true;
    onEvent({ kind: 'you', text });
    inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    return true;
  }

  async function interrupt() {
    denyAll('The researcher stopped the agent.');
    if (q) await q.interrupt();
    busy = false;
    onEvent({ kind: 'stopped', reason: 'by-person' });
  }

  function answer(id, allow) {
    const a = asks.get(id);
    if (!a) return;
    asks.delete(id);
    a.resolve(allow ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: 'The researcher declined.' });
  }

  function close() {
    if (closed) return;
    closed = true;
    denyAll('The conversation ended.');
    inbox.end();
    if (q) q.close();
  }

  return { start, send, interrupt, answer, close };
}

module.exports = { createSession, askLine };
