# Test fixtures

## constant-checking

`constant-checking/research/canvas.md`, `constant-checking/research/decisions.md`, and
`constant-checking-state.json` reconstruct the research canvas of a real, published paper:

> Gerlach, J. P., & Cenfetelli, R. T. (2020). Constant Checking Is Not Addiction: A Grounded
> Theory of IT-Mediated State-Tracking. *MIS Quarterly*, 44(4), 1705–1732.

The canvas content is a paraphrased reconstruction of the paper for testing purposes, written in
the `canvas` skill's import mode against the `is-qualitative` profile. Every statement carries a
`src: gerlach-cenfetelli-2020 p. <page>` tag pointing at the printed MIS Quarterly page range
(1705–1732); only construct definitions are quoted verbatim, and only in short fragments. It is
not an authoritative summary of the paper and should not be cited as one — go to the paper itself
for that. `constant-checking-state.json` is the exact `GET /api/state` response for this project,
produced by `viewState` from `bin/canvas-serve.js` against the fixture files above, not
hand-written.

## voice-uptake

`voice-uptake/research/canvas.md` and `voice-uptake/research/decisions.md` are an invented
fixture project (no real paper), used to exercise the canvas and decision-log format in `seed`
mode with a mix of empty, proposed, stated, and accepted statements.

## view-state-variants.json, view-state-chosen.json

The exact `GET /api/state` response of an invented scratch project (`voice-uptake`, three
framings: `power`, `sense-making`, `rituals`), read at two points of one run. `-variants` is
before a choice: the main canvas holds a proposed and a tentative statement, the three variants
differ in five fields, and two check questions (`#1`, `#2`) are open on 1.2. `-chosen` is after
`choose power` and an accept of 1.2 with an explanation, despite those two questions: the log
holds a framing-chosen entry and an explained accept with `Open at acceptance: #1, #2`, and
choosing is off. `make-variants-fixtures.js` writes both through the CLI and `viewState`, so
nothing in them is hand-written; run it again to regenerate (seals and text hashes change, the
shape does not). `view.test.js` and the screenshots of the view read them.

## view-state-broken.json

The same scratch project right after `choose power`, with the framing entry's Why reworded in
`decisions.md` after it was sealed: the ledger breaks at `#3`, the two check questions before it
still verify (`sealStatus` `verified, verified, broken`). `make-variants-fixtures.js` writes it
through `viewState` like the two above. `view.test.js` reads it for the seal marker and the
ledger banner (SQ-139).

## prechange-decisions.md

`prechange-decisions.md` is a sealed decision log written at revision `3792c3e`, before the entry's
own first line stopped being read as a field label and before a value carrying such a line became a
refusal (SQ-133). It is sealed with the key `Buffer.from('ab'.repeat(32), 'hex')`, which
`seal.test.js` keeps beside its assertions. Its point is to stay frozen: a test proves the current
code still verifies these bytes and parses the same fields out of them, so the seal and the label
grammar have to face a log that this code did not write.
