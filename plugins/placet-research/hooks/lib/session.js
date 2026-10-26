'use strict';

const seal = require('./seal');
const { loadState, ledgerRefusal } = require('./state');
const { headingRefusal, labelRefusal, today, refuse } = require('./log');

const MAX_OCCASION = 120;

// A session runs from its marker to the next one or the end of the log
// (spec §4). Only a person starts one; an open view is not a session.
function startSession({ root, occasion, pluginRoot } = {}) {
  const text = typeof occasion === 'string' ? occasion.trim() : '';
  if (!text || /[·\n]/.test(text) || text.length > MAX_OCCASION) {
    return refuse('invalid', `session start needs an occasion: one line of at most ${MAX_OCCASION} characters without a middle dot, e.g. "Supervision with B. Supervisor".`, true);
  }
  const bad = headingRefusal(text) || labelRefusal(text);
  if (bad) return refuse('invalid', bad);
  const state = loadState(root, { pluginRoot });
  if (state.error) return refuse(state.code, state.error);
  const refusal = ledgerRefusal(state);
  if (refusal) return refuse(refusal.code, `Cannot start a session: ${refusal.error}`);
  const logged = seal.sealedAppend(state.paths.decisions, { date: today(), kind: 'SESSION', ref: text, body: 'Session started.', by: state.by }, state.key);
  return { ok: true, seq: logged.seq, seal: logged.seal };
}

module.exports = { startSession };
