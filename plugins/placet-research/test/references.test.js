'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const canvas = require('../hooks/lib/canvas');

const refDir = path.resolve(__dirname, '..', 'references');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'canvas.md'), 'utf8');

test('canvas-elements.md parses as an empty canvas with the fixture\'s question ids', () => {
  const template = canvas.parseCanvas(fs.readFileSync(path.join(refDir, 'canvas-elements.md'), 'utf8'));
  assert.equal(template.problems.length, 0, template.problems.join('; '));
  assert.equal(template.elements.length, 9);
  const ids = template.elements.flatMap((e) => e.questions.map((q) => q.id));
  const fixtureIds = canvas.parseCanvas(fixture).elements.flatMap((e) => e.questions.map((q) => q.id));
  assert.deepEqual(ids, fixtureIds);
  assert.equal(canvas.allStatements(template).length, 0, 'the template carries no statements');
});

// The citation lives in the frontmatter because everything below it is body
// text that `init` copies and `parseCanvas` reads as statements.
test('the template carries its source in the frontmatter, not in the body', () => {
  const template = canvas.parseCanvas(fs.readFileSync(path.join(refDir, 'canvas-elements.md'), 'utf8'));
  assert.equal(typeof template.frontmatter.source, 'string', 'the template frontmatter names no source');
  assert.match(template.frontmatter.source, /Dorobantu/);
  assert.match(template.frontmatter.source, /doi\.org/);
});

const read = (name) => fs.readFileSync(path.join(refDir, name), 'utf8').replace(/\s+/g, ' ');

// SQ-205: the profiles describe the enforcement `accept` performs, and the
// glossary's format rules cross genres while its timing stays with the profile.
test('both profiles describe acceptance-order enforcement as the executable rule', () => {
  for (const name of ['profiles/is-qualitative.md', 'profiles/is-quantitative.md']) {
    const text = read(name);
    assert.doesNotMatch(text, /never enforced/, `${name} still reports the graph as unenforced`);
    assert.match(text, /`accept` refuses the acceptance/, name);
    assert.match(text, /construct-glossary\.md/, name);
    assert.match(text, /across genres/, name);
  }
});

test('the qualitative profile lets a definition arrive late and keeps it visible', () => {
  const text = read('profiles/is-qualitative.md');
  assert.match(text, /sensitizing terms/);
  assert.match(text, /Definition: pending/);
  assert.match(text, /element 4's edges, `4 <- 2, 7`/);
});

test('the quantitative profile keeps glossary acceptance out of preregistration and 4.1', () => {
  const text = read('profiles/is-quantitative.md');
  assert.match(text, /not registry preregistration/);
  assert.match(text, /accepting one accepts no 4\.1 hypothesis/);
  assert.match(text, /element 4's `4 <- 2, 3` edges/);
});

test('amj-map places the glossary in element 4 work, not in a Sparrowe and Mayer prescription', () => {
  const text = read('amj-map.md');
  assert.match(text, /relations and mechanisms of 4\.2 and 4\.3/);
  assert.match(text, /does not itself ground a hypothesis/);
  assert.match(text, /neither the file format nor its mechanical checks are a prescription from Sparrowe and Mayer \(2011\)/);
});

test('every reference cites its source and none quotes it', () => {
  for (const name of ['canvas-elements.md', 'amj-map.md', 'problematization.md']) {
    const text = fs.readFileSync(path.join(refDir, name), 'utf8');
    assert.match(text, /Dorobantu|Monteiro|Colquitt/, `${name} cites nothing`);
    assert.match(text, /doi\.org|jstor\.org/, `${name} has no resolvable reference`);
  }
});
