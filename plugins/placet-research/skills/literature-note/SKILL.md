---
name: literature-note
description: Use when drafting a literature note from one explicitly selected local paper — extract it, draft it through the approved local gateway, and check every quotation against the printed page it claims before a note is proposed. Writes one proposal; never accepts a claim.
---

# A literature note from one paper

One paper, one note, one request. The researcher supplies the paper and the
selected context; you run the local stages through the plugin's own scripts and
report what came back. What this produces is a proposal.

## The boundary, in these words

Every result you report carries this, verbatim:

> This check covers only verbatim wording on the claimed printed page. It does
> not verify paraphrase, numbers or attribution, and it does not accept a
> research claim. Project relevance and transfer judgments remain [proposed] for
> human review.

A green check says the quoted words stand on the page the note claims. It says
nothing about whether the quotation supports the sentence around it, whether a
number belongs to the study named beside it, or whether any of it is relevant to
this project. Never label the note `fact-checked` or `human-read`; never move a
statement to `[stated]` or `[accepted]`; never say the note is ready. You never
accept anything: relevance, transfer limits and open questions stay `[proposed]`
until the researcher decides, and there is no note-acceptance ledger. If an idea
from the note belongs in the canvas, the canvas skill proposes it there and the
researcher accepts it with
`/placet-research:accept <n.m> --explained "<their sentence>"`.

## No generic subagent, no exemption

The drafting request goes through the approved local gateway route below — not
through a generic drafting subagent, and not by asking for a Sidequest scope
exemption to run one. The paper text needs no tools, no repository permissions
and no acceptance authority, and a subagent would carry all three. An approved
gateway route is also not permission to bypass a refused action: if the route
itself refuses, stop and report the refusal. Do not substitute another provider,
add an endpoint, or change hooks or permissions.

## 1. Get the explicit inputs

Ask the researcher for each of these. Do not invent one and do not go looking:

- one local PDF path, or one explicit library pointer relative to
  `PLACET_RESEARCH_LIBRARY`;
- the paper's bibliographic identity and version;
- the output path for the proposal;
- the selected context: the current framing, the hypothesis if there is one, and
  any sibling note they name.

Missing identity, a permission nobody granted, or unreadable source bytes is a
stop you report, never a prompt to invent metadata. Do not scan the library, do
not discover sibling projects, and do not silently substitute another version of
the paper. Write `unknown` for a reader or a read coverage nobody supplied —
never a name, never an assumption.

## 2. Extract and pin the printed page

From the plugin directory:

    python3 "${CLAUDE_PLUGIN_ROOT}/scripts/extract-paper.py" <paper.pdf> --offset <N> --out <cache dir>

A constant offset is accepted only when the labels on every physical page agree
with it. Exit 3 means the numbering was refused: ask the researcher for the
confirmed physical-to-printed map and run again with `--map`. Never coerce a
Roman or unnumbered page to an integer, never guess a missing label, and never
extrapolate from one running head. Keep the full extraction — `full.txt`, not the
reduced request view — for the check. A missing `pdftotext` is a dependency
failure, never a passing check.
`${CLAUDE_PLUGIN_ROOT}/references/literature-note.md` documents the CLI, the
page-map sidecar and the exit codes.

## 3. Draft through the approved gateway

Write the input JSON documented in the reference — the paper, the page map, the
output path, the supplied metadata and the explicit context list — and run:

    python3 "${CLAUDE_PLUGIN_ROOT}/scripts/draft-literature-note.py" --project <project> --inputs <inputs.json> --gateway-config <gateway.json>

The gateway configuration is the researcher's already approved local route.
It is an input, never a default you pick, and a config file is not evidence that
the route's owner or upstream destination is approved. Do not add a provider
branch, retry with another model, follow a redirect, or put a key in an argument
or a log. On a timeout, a truncated response or a context overflow the run
leaves a local diagnostic draft and no final note; report it and stop rather
than retrying with different settings.

## 4. Check the quotations — this is the gate

The adapter runs `verify-quotes.py` against the full extraction before it
publishes anything, and publishes only on a clean result. The check compares
each blockquote's wording as a contiguous sequence of words against the page the
note claims, and nothing else: not a paraphrase, not a number, not an
attribution. A wrong page, one changed word, an unsupported or unparsed
quotation form, an ellipsis or a page range is a failure, and a note whose
`Quotations` section is empty is `not checked: no quotations` — not a pass.

After any manual edit, the saved report is stale. Re-run the check yourself,
with the note and the same page map:

    python3 "${CLAUDE_PLUGIN_ROOT}/scripts/verify-quotes.py" <note.md> --page-map <paper.page-map.json>

Read the exit code and the printed inventory; a corrupted quotation or a
corrupted locator exits 1 and the edited note is not a checked note. Never edit
the note to make a check pass, and never widen the matcher. An unreadable input
or a changed PDF, map or extraction is a different failure, not a pass.

## 5. Report

Show the quotation inventory (found, parsed, checked, rejected), the source and
version with the PDF hash, what failed and where, and the `[proposed]` judgment
sections. Name the factual checks the gate cannot make — paraphrase, numbers,
attribution — and hand those to the researcher with the relevance and transfer
decisions. Then stop. The note is a proposal, and you do not accept it.
