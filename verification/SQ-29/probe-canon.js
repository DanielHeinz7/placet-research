'use strict';

// SQ-29 `canon` class: SQ-26's canonical commitment line. The identity of a
// commitment is seven fields joined by U+001F — element number, element title,
// question id, question text, marker, statement text, sorted tags. These probes
// ask whether a write can move content across a field boundary and leave the
// joined string identical, so that `committedSet` sees no change where the
// rendered canvas plainly changed.
//
// Every row goes through the real PreToolUse hook with `common.probe`, every
// ALLOWed write is applied, and the canvas is re-read.

const c = require('../probes/common');

const SEP = '\u001f';
const ACCEPTED = c.lineWith('[accepted]');
const STATED = c.lineWith('[stated]');

// A project whose canvas is already in a given state; the "before" is the
// researcher's file, and only the probe's own edit is judged by the guard.
function projectWith(replacements) {
  const root = c.makeProject();
  let text = c.canvasSrc;
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`fixture has no ${JSON.stringify(from.slice(0, 40))}`);
    text = text.replace(from, to);
  }
  c.fs.writeFileSync(c.canvasFile(root), text);
  return root;
}

function edit(root, oldString, newString, opts) {
  return Object.assign({ file_path: c.canvasFile(root), old_string: oldString, new_string: newString }, opts || {});
}

// ---- controls: the set rule holding over an accepted statement ----
{
  const root = projectWith([]);
  c.probe('K1', 'canon', 'control: reword the accepted statement of 1.1',
    root, 'Edit', edit(root, ACCEPTED, ACCEPTED.replace('serious consideration', 'real consideration')));
}
{
  const root = projectWith([[ACCEPTED, ACCEPTED.replace('[accepted]', '[accepted, src: interview-07]')]]);
  const seeded = ACCEPTED.replace('[accepted]', '[accepted, src: interview-07]');
  c.probe('K2', 'canon', 'control: move a plain tag into the statement text',
    root, 'Edit', edit(root, seeded, `${ACCEPTED.replace(' [accepted]', '')} src: interview-07 [accepted]`));
}

// ---- the text/tags boundary: the last two fields of the canonical line ----
// A tag that carries U+001F reproduces the boundary between the text field and
// the tags field, so text and tags can be re-cut without the join changing.
{
  const before = ACCEPTED.replace('[accepted]', `[accepted, src: interview-07${SEP}memo-02]`);
  const after = `${ACCEPTED.replace(' [accepted]', '')}${SEP}src: interview-07 [accepted, memo-02]`;
  const root = projectWith([[ACCEPTED, before]]);
  c.probe('K3', 'canon', 'accepted statement: a tag carrying U+001F lets the text field absorb it',
    root, 'Edit', edit(root, before, after));
}
{
  const before = `${ACCEPTED.replace(' [accepted]', '')}${SEP}src: interview-07 [accepted, memo-02]`;
  const after = ACCEPTED.replace('[accepted]', `[accepted, src: interview-07${SEP}memo-02]`);
  const root = projectWith([[ACCEPTED, before]]);
  c.probe('K4', 'canon', 'accepted statement: the same cut in the other direction, text back into the tag',
    root, 'Edit', edit(root, before, after));
}
{
  const before = ACCEPTED.replace('[accepted]', `[accepted, src: interview-07${SEP}memo-02]`);
  // Re-cut one character further, so the join really does change.
  const after = `${ACCEPTED.replace(' [accepted]', '')}${SEP}src: interview-0 [accepted, 7${SEP}memo-02]`;
  const root = projectWith([[ACCEPTED, before]]);
  c.probe('K5', 'canon', 'control: the same shape cut so the joined line differs by one character',
    root, 'Edit', edit(root, before, after));
}
{
  const before = ACCEPTED.replace('[accepted]', `[accepted, src: interview-07${SEP}memo-02]`);
  const after = `${ACCEPTED.replace(' [accepted]', '')}${SEP}src: interview-07 [stated, memo-02]`;
  const root = projectWith([[ACCEPTED, before]]);
  c.probe('K6', 'canon', 'control: the marker is its own field, so the cut cannot downgrade the statement',
    root, 'Edit', edit(root, before, after));
}

// ---- reachable in two model writes, with no researcher in between ----
{
  const root = c.makeProject();
  const plant = `${STATED.replace(/\s*\[stated\]\s*$/, '')} and the planted tag. [stated, alpha${SEP}beta]`;
  const first = c.probe('K7', 'canon', 'step 1: the model writes a new [stated] statement whose tag carries U+001F',
    root, 'Edit', edit(root, STATED, `${STATED}\n\n${plant}`));
  if (first.verdict.decision === 'ALLOW') {
    const shifted = plant.replace(` [stated, alpha${SEP}beta]`, `${SEP}alpha [stated, beta]`);
    c.probe('K8', 'canon', 'step 2: the model re-cuts its own commitment across the text/tags boundary',
      root, 'Edit', edit(root, plant, shifted));
  } else {
    c.probe('K8', 'canon', 'step 2 skipped: step 1 was refused', root, 'Edit', edit(root, 'x-not-present', 'y'));
  }
}

// ---- the earlier field boundaries, which are not free-form ----
{
  const root = projectWith([]);
  c.probe('K9', 'canon', 'control: rewrite the element 1 title with a U+001F in it',
    root, 'Edit', edit(root, '# 1 · ', `# 1 · ${SEP}1.1 `));
}
{
  const root = projectWith([]);
  c.probe('K10', 'canon', 'control: a tag that reproduces a marker name on a stated statement',
    root, 'Edit', edit(root, STATED, STATED.replace('[stated]', '[stated, accepted]')));
}
{
  const root = projectWith([]);
  c.probe('K11', 'canon', 'control: a tag that reproduces this question id',
    root, 'Edit', edit(root, ACCEPTED, ACCEPTED.replace('[accepted]', '[accepted, 1.1]')));
}

// ---- normalizeText: NFC folding across a committed statement ----
{
  const seeded = `${STATED.replace(/\s*\[stated\]\s*$/, '')} Café notes. [stated]`;
  const root = projectWith([[STATED, seeded]]);
  c.probe('K12', 'canon', 'control: NFD spelling of the same committed text (NFC folds it to the same commitment)',
    root, 'Edit', edit(root, seeded, seeded.replace('Café', 'Café')));
}

c.flush([
  'SQ-29 canon class -- SQ-26 canonical commitment line and committedSet.',
  'Driven through hooks/guard-promotion.js with a PreToolUse payload; every ALLOWed write',
  'was applied and the canvas re-read. U+001F is shown as \\u001f in the effect column.',
  '',
  'ID | class | ALLOW/DENY | effect | description',
].join('\n'));
