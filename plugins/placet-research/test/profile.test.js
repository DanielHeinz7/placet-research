'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const canvas = require('../hooks/lib/canvas');
const profile = require('../hooks/lib/profile');
const review = require('../hooks/lib/review');
const { textHash } = require('../hooks/lib/hash');

const pluginRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures', 'voice-uptake', 'research');
const canvasText = fs.readFileSync(path.join(fixtureDir, 'canvas.md'), 'utf8');
const decisionsText = fs.readFileSync(path.join(fixtureDir, 'decisions.md'), 'utf8');

test('parseGraph reads the fenced graph block into numeric adjacency', () => {
  const graph = profile.parseGraph('text\n```graph\n1 <-\n3 <- 1\n9 <- 1, 3\n```\nmore');
  assert.deepEqual(graph, { 1: [], 2: [], 3: [1], 4: [], 5: [], 6: [], 7: [], 8: [], 9: [1, 3] });
  assert.throws(() => profile.parseGraph('no block here'), /graph block/);
  assert.throws(() => profile.parseGraph('```graph\n3 <- 3\n```'), /depends on itself/);
});

test('loadProfile loads is-qualitative and rejects unknown or unsafe ids', () => {
  const p = profile.loadProfile('is-qualitative', pluginRoot);
  assert.equal(p.id, 'is-qualitative');
  assert.deepEqual(p.graph[5], [3, 9]);
  assert.deepEqual(p.graph[4], [2, 7]);
  assert.throws(() => profile.loadProfile('../etc', pluginRoot), /profile id/);
  assert.throws(() => profile.loadProfile('does-not-exist', pluginRoot), /not found/);
});

test('dependencyViolations reports accepted elements whose dependencies are not accepted', () => {
  const graph = profile.loadProfile('is-qualitative', pluginRoot).graph;
  // Fixture: element 1 is stated (not accepted) → no violations.
  assert.deepEqual(profile.dependencyViolations(canvas.parseCanvas(canvasText), graph), []);
  // Accept 3.1 while element 1 stays stated → violation on 3.
  const text = canvasText.replace('[stated, src: memo-03]', '[accepted, src: memo-03]');
  const violations = profile.dependencyViolations(canvas.parseCanvas(text), graph);
  assert.deepEqual(violations, [{ element: 3, missing: [{ element: 1, status: 'stated' }] }]);
});

test('mechanicalReview assembles statuses, empties, open elements and untagged statements', () => {
  const graph = profile.loadProfile('is-qualitative', pluginRoot).graph;
  const report = review.mechanicalReview({ parsed: canvas.parseCanvas(canvasText), graph, decisionsText });
  assert.equal(report.statuses[1].status, 'stated');
  assert.deepEqual(report.empty, [4, 6, 7, 8, 9]);
  assert.deepEqual(report.open, [2]);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.unmarked, []);
  // untagged: every statement without an evidence tag
  assert.deepEqual(report.untagged.map((s) => s.question), ['1.1', '1.2', '1.2', '5.1']);
  // conversationalStated: the stated ones among them
  assert.deepEqual(report.conversationalStated.map((s) => s.question), ['1.2', '5.1']);
});

test('parseChecks reads an optional fenced checks block and refuses unknown names', () => {
  assert.deepEqual(profile.parseChecks('no block'), []);
  assert.deepEqual(profile.parseChecks('x\n```checks\nhypotheses-before-data\n```\n'), ['hypotheses-before-data']);
  assert.throws(() => profile.parseChecks('```checks\nsomething-else\n```'), /unknown check: something-else/);
});

test('loadProfile loads is-quantitative with the hypothetico-deductive graph and its check', () => {
  const p = profile.loadProfile('is-quantitative', pluginRoot);
  assert.deepEqual(p.graph, { 1: [], 2: [1], 3: [1, 2], 4: [2, 3], 5: [3, 4], 6: [4, 5], 7: [6], 8: [2, 4, 7], 9: [5, 7] });
  assert.deepEqual(p.checks, ['hypotheses-before-data']);
});

test('is-qualitative carries no checks, so its review is unchanged', () => {
  assert.deepEqual(profile.loadProfile('is-qualitative', pluginRoot).checks, []);
});

test('mechanicalReview cross-checks acceptances against the decision log', () => {
  const graph = profile.loadProfile('is-qualitative', pluginRoot).graph;
  const acceptedText = "When do members' suggestions in organizational meetings receive serious consideration rather than polite acknowledgement?";
  const goodLog = decisionsText.replace('text 3b7a1c9e', `text ${textHash(acceptedText)}`);
  const ok = review.mechanicalReview({ parsed: canvas.parseCanvas(canvasText), graph, decisionsText: goodLog });
  assert.deepEqual(ok.staleAcceptances, []);
  // The hash matches, but a legacy entry carries no seal and so gives no
  // cover (§4.4, §4.7): the acceptance is reported, naming the entry that
  // claims it and why that claim cannot be checked.
  assert.deepEqual(ok.unloggedAcceptances.map((s) => [s.question, s.coveredBy]), [['1.1', { seq: 3, state: 'legacy' }]]);
  // The fixture's placeholder hash does not match → the acceptance is stale
  // and the accepted statement has no matching log entry.
  const bad = review.mechanicalReview({ parsed: canvas.parseCanvas(canvasText), graph, decisionsText });
  assert.deepEqual(bad.staleAcceptances.map((e) => e.seq), [3]);
  assert.deepEqual(bad.unloggedAcceptances.map((s) => s.question), ['1.1']);
});
