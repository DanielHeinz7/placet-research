---
name: canvas-review
description: Use when reviewing a paper project's research canvas for gaps, incoherence, unmet dependencies, missing evidence, and statements the manuscript no longer supports. Argues against the canvas; writes only proposals.
---

# Reviewing the canvas

This review argues against the canvas. It does not tidy it. A review that only
checks whether the pieces fit produces a coherent canvas around a bad study.

## 1. The mechanical part

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/placet-research.js" review` and read the
report. It lists: empty elements; open elements (proposals only); dependency
violations; unmarked and untagged statements; conversational `[stated]`
statements; committed statements that the file holds but a reader of the
rendered canvas would not see; the state of the decision log's seal chain
(verified, unverifiable here, or broken at a named entry); acceptances whose
text hash no longer matches; accepted statements no verified log entry accounts for; and DECISION
entries that give no cover. Report all of it verbatim to the researcher first.

When the state directory holds a glossary, the report ends with `Glossary
mechanics`: entry structure and provenance, the glossary references in elements
3, 4, 7 and 8, the declared manuscripts' links and `constructs:` declarations,
the lexical cross-check of declared terms and aliases, and every accepted entry
whose payload no longer matches its sealed decision. Report that group too, and
keep the two lines it always prints — `Declared construct coverage checked;
undeclared constructs require human inspection.` and `Human construct judgment:
not performed by this check` — in what you tell the researcher. The group reads
only; it never repairs an entry, and neither do you.

A statement under "Committed but not visible" is not a parse error and not an
attack you should assume: an HTML comment or an indented block is also how a
researcher parks something. Report it plainly — the file and the rendered view
disagree, here is the statement, here is why it does not show — and let them
decide. Never silently re-expose it; that would be editing a commitment.

A broken decision log is the most consequential finding on the page: name the
entry and stop. The harness never repairs a ledger, and neither do you —
deciding which version is true is the researcher's act.

Then read the profile named in the canvas frontmatter under
`${CLAUDE_PLUGIN_ROOT}/references/profiles/` and
`${CLAUDE_PLUGIN_ROOT}/references/canvas-elements.md`.

## 2. Constructs — the judgment the mechanics cannot make

The glossary group checks structure, that declared references resolve, and that
an accepted entry still hashes to its decision. It cannot tell you whether the
definitions are right, so ask:

- Do the entries actually distinguish different things, or merely use different
  labels?
- Is the adopted definition appropriate for this study and supported by its
  source?
- Does the design measure or observe the construct the paper names?
- Did the manuscript introduce an undeclared construct, conflate terms, or
  change meaning while retaining the same words?

An accepted entry is the researcher's decision about the displayed text. It is
not a verdict on measurement validity, and it is not human judgment about the
construct — the mechanical report says so itself. A `definition changed since
acceptance` finding names the statements and manuscript locations that rest on
the entry and invalidates nothing: the researcher decides whether the new
wording changes their claims.

## 3. Fit — where elements contradict each other

Check these pairs and write what you find:

- 8 against 3: do the contributions answer the research question, or a
  different one?
- 9 against 5 and 6: do the boundary conditions contradict the setting or the
  design (a claim about "organizations" from one team; a process claim from a
  cross-section)?
- 4 against 7: in a qualitative profile, does the framework claim more than
  the findings show?
- 2 against 1: does the prior-research account start from the phenomenon, or
  is it gap-spotting ("little research has examined …")?
- 3 against 1: is the question the one the puzzle poses, or a narrower one
  that was easier to answer?

## 4. Refutation — one element at a time

For every element that holds a committed statement, write one paragraph
answering: **what would have to be true for this element to be wrong, and
does the material or the literature say it?** Try to refute before you report
fit. If you cannot construct a refutation, say that too — it is information.

## 5. Manuscript support

If the researcher names a manuscript, read it and check every `[stated]` and
`[accepted]` statement against it. List those the manuscript no longer
supports, with the section that contradicts them.

## 6. Untagged statements

For each statement in the "untagged" list, decide whether it makes a factual
claim. If it does, propose the tag: `src: <where>` if you can locate it,
`unverified` if you cannot. Do not add the tag to a `[stated]` or `[accepted]`
statement yourself; propose it alongside.

## What you write

Only `[proposed]` paragraphs in the canvas, next to the statement they concern,
`[proposed]` or `[tentative]` glossary entries for a construct the glossary
misses or words differently, and `DISCOVERY` entries recorded through the
harness, which seals them. You may not change, retitle or remove an entry the
researcher stated or accepted, and you never accept one yourself.

Word each DISCOVERY body as an open question the author team can sit down and
talk about, not a verdict. Name the field involved by its human question, not
by "element N", "RQ3", or a statement number — the element or statement number
belongs in `ref`, where the harness already keeps the machine reference. Follow
the named field with the one-sentence reason it matters.

Human questions, one per element: 1 What puzzles us? · 2 Who cares, and what
do they already know? · 3 What exactly do we ask? · 4 What is it made of? ·
5 Where do we look? · 6 How do we look? · 7 What did we find? · 8 What does it
change? · 9 Where does it stop?

    Before: "Element 5 reports a sample drawn mainly from the authors' networks; generalizability claim in 9.1 is not supported."
    After: "Our sample comes mostly from our own networks (Where do we look?). How far can the claim in Where does it stop? travel beyond them?"

    node "${CLAUDE_PLUGIN_ROOT}/bin/placet-research.js" log DISCOVERY "<element or n.m>" --body "<open question, field named by its human question> [proposed]"

Never write `research/decisions.md` yourself; the guard denies it, appends
included, because an entry the harness did not seal does not verify. Never
change a marker. When you are done, list the findings by element, most
consequential first, and stop — the researcher decides what to do with them.
