'use strict';

const fs = require('node:fs');

const canvas = require('./canvas');
const project = require('./project');
const { statementsByHash, withMarker, QUESTION_ID } = require('./state');
const { refuse } = require('./log');

const PROMOTABLE = ['proposed', 'tentative'];

// [proposed] or [tentative] becomes [stated] in the canvas, and nothing else
// happens: [stated] is unsealed by design, so no log entry is written. The
// view always says which text it saw, and a changed text is refused.
function setStated({ root, questionId, match, expectedHash } = {}) {
  if (typeof questionId !== 'string' || !QUESTION_ID.test(questionId)) return refuse('invalid', 'setStated needs a question id like 3.1.');
  if (typeof expectedHash !== 'string' || !expectedHash) return refuse('invalid', 'setStated needs the text hash of the statement you saw (expectedHash).');
  const canvasFile = project.canvasPath(root);
  const canvasText = project.readIfExists(canvasFile);
  if (canvasText === null) return refuse('not-found', 'This is not a paper project: no research/canvas.md. Run placet-research init first.');

  const found = statementsByHash(canvas.parseCanvas(canvasText), questionId, expectedHash, match);
  if (!found.length) return refuse('stale', `Question ${questionId} no longer holds the statement you saw (text ${expectedHash}); reload and look again. Nothing is changed.`);
  if (found.length > 1) return refuse('ambiguous', `Question ${questionId} has ${found.length} statements with text ${expectedHash}; pick one with match.`);
  const [target] = found;
  if (target.marker === 'stated' || target.marker === 'accepted') return refuse('already', `Question ${questionId}: this statement is already [${target.marker}].`);
  if (!PROMOTABLE.includes(target.marker)) return refuse('invalid', `Question ${questionId}: only a [proposed] or [tentative] statement can be set to [stated]; this one is ${target.marker === null ? 'unmarked' : `[${target.marker}]`}.`);

  fs.writeFileSync(canvasFile, withMarker(canvasText, target, 'stated'));
  return { ok: true, text: target.text };
}

module.exports = { setStated };
