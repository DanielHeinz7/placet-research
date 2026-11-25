---
name: source-check
description: Use when checking, per citation in a manuscript draft, whether the cited source says what the draft claims — finds the passage in the full text through Josh Holstein's paperlib, has paperlib confirm the quotation against the PDF, and writes a ledger of verdicts with page and passage into the paper repo. Proposes; never accepts, never edits the draft. Usage — /placet-research:source-check <draft.md|draft.tex>
argument-hint: <draft file>
allowed-tools: Read, Grep, Glob, Write, Bash(paperlib search:*), Bash(paperlib list:*), Bash(paperlib show:*), Bash(paperlib verify-quote:*), Bash(paperlib where:*)
---

# Source check, one row per citation

You were asked to check the citations in `$ARGUMENTS`. The result is a ledger
at `research/source-check.md` in the paper repo. It proposes verdicts; the
authors accept or reject them. You never edit the draft.

## Before you start

1. `paperlib where` must print the library the paper uses. If `paperlib` is
   missing, stop and say so: install it from `DSIWI4/paper-library` with
   `./install.sh --home <library> --skip-mcp`; do not rebuild its search or
   quote check here.
2. `paperlib list --tag <paper tag>` shows which sources have a full text.
   Full texts come into Zotero first (skill `literatur`), then into paperlib
   with `paperlib add <pdf> --bib <entry> --tag <paper tag>`. A source without
   a full text gets the verdict `not checked`; never judge it from its title or
   abstract.

## 1. List the citations

Read the draft in full. Make one row per citation occurrence that makes a
claim: author and year as written, the paragraph number, and the claim in the
draft's own words, short. Two sources in one parenthesis are two rows. Press
and web sources count too; they stay `not checked` unless their page is in the
library.

## 2. Find the passage

For each row with a full text:

    paperlib search "<the claim in your words>" --citekey <key> --limit 3

Read the hits, and the page around them if a hit is cut off. Choose one
sentence or clause that carries the claim and copy it exactly from the hit,
without the `**` marks and without ellipses. Then:

    paperlib verify-quote <key> "<the sentence>"

Only a `FOUND` quotation may stand behind a verdict. If it says `NOT FOUND`,
correct the quote from the `matched_text` it prints, or pick another passage.

## 3. Propose a verdict

- `supports`: the passage says what the draft claims.
- `partly`: the passage says something narrower, broader or with a condition
  the draft drops. Say what differs in the note.
- `does not`: the passage contradicts the claim, or the source is about
  something else. Say what it says instead.
- `not found`: the full text is in the library, but no passage carries the
  claim after three searches with different wording.
- `not checked`: no full text, or the claim is about a press or web source
  that is not in the library.

## 4. Write the ledger

Write the proposal as JSON to `research/source-check.proposal.json` in the paper
repo, so the ledger can be rebuilt when new full texts arrive:

    {"draft": "<path relative to the repo>", "rows": [
      {"citation": "Floridi (2020)", "paragraph": 2, "claim": "…",
       "citekey": "<key or null>", "verdict": "supports", "quote": "…", "note": "…"}]}

Then, from the paper repo:

    node ${CLAUDE_PLUGIN_ROOT}/scripts/source-check.js research/source-check.proposal.json --out research/source-check.md

The script asks paperlib again for every quote. A verdict whose quote paperlib
does not find becomes `not checked`, with the similarity in the note. Do not
edit the ledger by hand afterwards; change the proposal and run it again.

## What you never do

- Never edit the draft, its markers, or the Claude Doc. Proposals for the text
  go into the report below, as a list for the authors.
- Never state a verdict without a quote that `verify-quote` found.
- Never call a source checked because its bibliographic data is right; that is
  a different check.
- Never commit to, push to or open issues on `DSIWI4/paper-library`. Problems
  with paperlib go into the report for the researcher to raise with Josh.

## Report

The tally line the script prints, the path of the ledger, then a short list
for the authors: every `partly`, `does not` and `not found` row with what the
draft could say instead, and every `not checked` row with what full text is
missing. Pages in the ledger are PDF pages, counted from 1; say so when you
quote one.
