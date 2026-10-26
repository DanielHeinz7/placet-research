# Literature note: local extraction, printed-page map and quotation check

This file documents the local stages of the literature-note design
(`docs/superpowers/specs/literature-note-design.md`). It covers that design's
package 1, turning one local PDF into a full text, a reduced request view and a
page map that says which printed page each physical page is, and package 2, the
fail-closed check of a note's quotations against that paper. Package 3 adds the
configured direct drafting adapter below, package 4 the `literature-note` skill
and the walkthrough that runs all three stages on an invented paper. Nothing
here establishes a reviewed note or an accepted claim, and no note-acceptance
ledger exists.

## Why the printed page is the anchor

A reader finds a claim in the published article by its printed page number.
The PDF's own page index is not that number: covers, inserted front matter and
numbering restarts move it. Every page map therefore records both the physical
index used to read the file and the printed page a reader would cite, and the
extraction keeps enough evidence to defend that pairing.

## Running the extractor

```
python3 scripts/extract-paper.py PAPER.pdf [--offset N | --map FILE] [--out DIR] [--extractor NAME]
python3 scripts/extract-paper.py PAPER.pdf --verify PAGE-MAP.json
```

Run it from the plugin directory. Everything happens on this machine: the
installed `pdftotext` for the text, Python's standard library for hashing and
JSON. There is no network request, no OCR and no automatic dependency install.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Extraction or verification succeeded |
| 1 | Usage error, or a verification that did not pass its checks |
| 2 | A required tool (`pdftotext`, `python3`) is missing. This is a dependency failure, never a passing check |
| 3 | The printed-page numbering was refused, or no map was supplied for an irregular document |
| 4 | Unreadable or invalid input: missing PDF, malformed page map, a map that is not bound to these PDF bytes |
| 5 | Recorded evidence changed: the PDF, the confirmed map or the extraction is not the one that was mapped |

For the fixture PDFs this is:

```
python3 scripts/extract-paper.py test/fixtures/literature-note/regular.pdf --offset 40 --out /tmp/paper
python3 scripts/extract-paper.py test/fixtures/literature-note/irregular.pdf --map test/fixtures/literature-note/irregular.confirmed-map.json --out /tmp/paper
python3 scripts/extract-paper.py test/fixtures/literature-note/regular.pdf --verify /tmp/paper/regular.page-map.json
```

## Outputs

Named after the PDF stem, written into `--out` (default: beside the PDF):

- `<stem>.full.txt` — the complete local extraction, physical pages joined by a
  form feed, raw headers and footers included. This is the copy the quotation
  check must read; local caches and extracted text stay untracked.
- `<stem>.request.txt` — the reduced request view (below). Lossy, and never the
  basis of a check.
- `<stem>.page-map.json` — the sidecar described next.

## The page-map sidecar

`schema` is `literature-note/page-map@1`. The map is bound to the bytes it was
made from, so a changed PDF can be detected rather than silently re-used:

| Field | Meaning |
|---|---|
| `pdfFile`, `pdfSha256` | The PDF this map was made from |
| `physicalPages` | Number of physical pages read, including blank ones |
| `mapping.method` | `offset`, `confirmed-map` or `none` |
| `mapping.offset` | The constant offset used, for `offset` |
| `mapping.mapFile`, `mapping.mapSha256`, `mapping.confirmedBy`, `mapping.confirmedAt` | The confirmed map and who confirmed it, for `confirmed-map` |
| `extractionFile`, `extractionSha256`, `requestFile`, `requestSha256` | Relative to the sidecar's directory |
| `requestLossy`, `omittedFromRequest` | What the request view dropped: `bannerLines`, `labelLines`, `referenceLines` |
| `uncheckablePages` | Physical pages with no extractable text; recorded, never guessed |
| `pages[]` | Per page: `physical`, `printed`, `printedSource`, `hasText`, `chars`, `textSha256`, what the `label` looked like and in which `bands`, any `labelProblem`, and whether the map `agreesWithLabel` |

## Printed-page authority

A constant offset is a candidate, never authority by itself. `--offset N` is
accepted only when the labels found on every physical page agree with it:
consistent header/footer positions, a constant `printed - physical`, and
unique, monotonic labels. A contradictory label, a numbering restart, inserted
unnumbered front matter, an ambiguous header, a missing label or otherwise
insufficient evidence refuses automatic numbering with exit 3 and names the
readings it saw. A single running head does not justify extrapolating the rest
of the document, and bare digits in prose are not page labels.

For irregular numbering, pass `--map FILE` with an explicit researcher-confirmed
physical-to-printed map covering every page, including entries that are
explicitly unnumbered (`"printed": null`). The map must declare the same schema,
be bound to the same `pdfSha256`, list each physical page once, and list printed
numbers uniquely and in increasing order. Without it the extractor refuses and
asks for one; it never invents a number, coerces a Roman or unnumbered page to
an integer, or extrapolates from a partial label set.

## The request view

`request.txt` removes only identified furniture: download banners and licences,
the page-number label lines the map identified, and the references section
(everything from a `References` heading onward) — each with its count recorded
in `omittedFromRequest`. Repeated body text is not a header and stays. The
request view exists to reduce model input; the checker must use `full.txt`, and
nothing about a check may depend on lines a filter removed.

## Recording and invalidating evidence

`--verify` re-reads the PDF and the text files and compares their SHA-256
against the sidecar. A changed PDF, an edited page map or an edited extraction
invalidates the earlier record and exits 5: re-extract and re-confirm rather
than trusting the stale map. Pages with no extractable text (scanned images, real
blank pages) are listed in `uncheckablePages` and can only be reported as
unchecked; the extractor does not infer their content, and blank pages keep
their physical index so that later pages do not shift.

## Running the quotation check

```
python3 scripts/verify-quotes.py NOTE.md --page-map PAPER.page-map.json [--out DIR]
python3 scripts/verify-quotes.py --verify QUOTE-REPORT.json
```

Run it from the plugin directory. `verify-quotes.py` reads the note and the
paper's `full.txt` (never the request view) and compares every quotation
against the physical page that the claimed printed page maps to. Only the
claimed page is searched: a quotation that really is somewhere else in the
paper fails here.

The note grammar is one form, a blockquote inside the note's `Quotations`
section:

```
## Quotations

> "A passage exactly as the page carries it." (p. 42)
```

A quotation may continue over several `>` lines; those lines are joined before
comparison. Everything else is inventoried and rejected rather than ignored: a
blockquote outside the `Quotations` section, a blockquote that is not
`> "..." (p. N)`, an inline `"..." (p. N)` inside prose, an omitted passage (an
ellipsis) and a page range (`pp. 42-43`). A note whose quotation section holds
nothing is `not checked: no quotations`, which is not a pass.

Comparison normalizes only what is typographic: NFC composition, the
typographic quotes and dashes folded onto their plain form, the `ﬁ` ligature
expanded to the letters it stands for, case folded, and the wording compared as
a contiguous sequence of words — never as a substring, never with word
boundaries squashed. Accents and letters are not folded: `café` is not `cafe`
and `naïve` is not `naive`.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every quotation was found on the printed page it claims |
| 1 | Not a pass: a quotation was not verified, a quotation form was rejected, the inventory was empty, or the call was malformed |
| 4 | Unreadable or invalid input, including a page map whose `mapping.method` is `none` and that therefore establishes no printed pages |
| 5 | Recorded evidence changed: the note, the PDF, the page map or the full extraction is not the one that was checked |

For the fixtures this is:

```
python3 scripts/verify-quotes.py test/fixtures/literature-note/quote-notes/exact.md --page-map /tmp/paper/regular.page-map.json --out /tmp/paper
```

### The quote report

`<note-stem>.quote-check.json` is written into `--out` (default: beside the
note), for a failing check as well. Its `schema` is
`literature-note/quote-check@1`:

| Field | Meaning |
|---|---|
| `result` | `verified`, `failed` or `not-checked` |
| `noteFile`, `noteSha256`, `pdfFile`, `pdfSha256`, `extractionFile`, `extractionSha256`, `pageMapFile`, `pageMapSha256` | The exact bytes this result is bound to |
| `inventory` | `found`, `parsed`, `checked`, `rejected` |
| `quotations[]` | Per quotation: `line`, `kind`, `printed`, `physical`, `status` (`verified`, `failed` or `rejected`) and the `reason` for anything that is not verified |
| `disclaimer` | The boundary below, stored with the result |

`--verify` re-reads the note, the PDF, the full extraction and the page map and
compares their SHA-256 against the report; any change exits 5 and the note has
to be checked again. A refused run (exit 4 or 5) writes no report at all, so no
later reader mistakes a refusal for a checked result.

## The boundary of a checked quotation

```
This check covers only verbatim wording on the claimed printed page. It does not
verify paraphrase, numbers or attribution, and it does not accept a research
claim. Project relevance and transfer judgments remain [proposed] for human
review.
```

The wording is printed on every outcome and stored in the report, so a
successful check cannot be quoted without its boundary.

## What these stages do not do

They do not accept a research claim or touch the canvas or the decisions log.
The adapter and the skill draft proposals; acceptance stays with the researcher
on the existing canvas path, and a note has no acceptance of its own. A checked
quotation is one input to a note, never a reviewed note, and neither a
successful extraction nor a verified quotation follows from, or replaces, a
human reading.


## Configured direct draft adapter

Run from the plugin directory after extraction and printed-page mapping:

```sh
python3 scripts/draft-literature-note.py --project /path/to/paper-project --inputs /path/to/inputs.json --gateway-config /path/to/local-gateway.json
```

Add `--variant alternate` for a selected variant. The adapter calls the existing
`stateDirOf` in `hooks/lib/project.js`, including `PLACET_RESEARCH_DIR`.
It reads only the explicit paper, extraction/map and listed context files.
It does not scan a library, discover sibling projects, read the canvas implicitly
or write a canvas, glossary or decisions log. Python 3.11+, Node and the existing
local extraction/checking tools are required. Exit 0 means a new proposal and
its quote report were saved; every refusal exits 1. No agent exemption, tools,
provider fallback or automatic acceptance is involved.

The input JSON has these fields (all values below are invented):

```json
{
  "pdf": "sources/meeting-paper.pdf",
  "pageMap": "local-cache/meeting-paper.page-map.json",
  "output": "notes/meeting-paper.proposed.md",
  "bibliography": "Invented meeting paper",
  "version": "fixture-v1",
  "drafter": "selected-model",
  "reader": "unknown",
  "readCoverage": "unknown",
  "context": ["research/canvas.md", "notes/selected-sibling.md"]
}
```

Paths are explicit and project-relative, with symlink/traversal escapes refused.
For an explicitly selected library paper, replace `pdf` with `libraryPointer`,
relative to `PLACET_RESEARCH_LIBRARY`; that one PDF may be outside the project.
Supply exactly one of them. The page map must name those same PDF bytes.

For a Zotero-stored PDF, for example, set `PLACET_RESEARCH_LIBRARY` to the
`storage` subfolder of the Zotero data directory and supply
`"libraryPointer": "ABCD1234/Author - 2020 - Title.pdf"` instead of `pdf`.
The key and filename in this example are invented; use the stored PDF’s actual
folder key and filename. Zotero is optional; any configured local library works.

`context` is mandatory, even when empty. A canvas, glossary or decisions file
in that list must belong to the selected main/variant state; the check folds
the name's case and compares existing files by inode, so a differently cased
name or a hard link of another state's authority is refused too. Other local
sibling notes must be individually named; missing files stop the request. Every metadata
field is supplied by the caller; use `unknown` rather than inventing a reader or
read coverage. The adapter renders quoted YAML scalar frontmatter itself and
creates ordinary relative Markdown links to checked source/context targets.
Model-generated frontmatter and links are rejected.

The gateway JSON names an already approved local route. It has exactly:

```json
{
  "protocol": "chat-completions",
  "endpoint": "http://127.0.0.1:PORT/v1/chat/completions",
  "model": "selected-model",
  "contextBytes": 100000,
  "maxOutputTokens": 2048,
  "maxResponseBytes": 20000,
  "timeoutSeconds": 60
}
```

Replace `PORT` and the model with the existing approved route's configured
values; this is a schema example, not a runnable service configuration.
There are no public endpoint, model or context defaults. Only explicit HTTP
loopback IP literals (`127.0.0.1`, `::1`) with a port and path are admitted.
Userinfo, query strings, fragments, credentials and extra config fields are
refused. The local gateway owns any upstream authentication. This adapter does
not read keys, call an authenticated provider directly, honor proxy environment
variables, follow redirects or retry. A loopback gateway does not mean inference
happens on the user's computer. A config file is not evidence that a gateway's
owner or upstream egress is approved; establish that separately before use.

The wire request is non-streaming chat-completions JSON with `model`,
`max_tokens`, `stream: false` and two `messages` (system instructions and user
data). No tools are supplied. Paper data and selected judgment context are
separate JSON string-valued data blocks; embedded instructions grant no authority.
The configured `contextBytes` bounds the complete UTF-8 request payload, not a
claimed tokenizer count. Configure it conservatively for the approved service's
context window. Oversized input is refused, never shortened; HTTP context errors
also refuse without retries. The complete response must be bounded JSON, name
the requested model, have one assistant text choice and `finish_reason: stop`.
An error, tool call, refusal, different model or truncation cannot become a note.
A single subprocess owns the HTTP request; the parent kills and waits for it
at the configured total deadline (at most 600 seconds), including slow replies.
Gateway error bodies and configuration values are not copied to diagnostics.

The required body headings, in order, are:

```markdown
# Literature note [proposed]
## Factual account [proposed]
## Quotations
## Project relevance [proposed]
## Transfer limits [proposed]
## Open questions [proposed]
```

Every section must contain text. Non-quotation paragraphs start `[proposed]`,
including prose between the H1 and the first H2; a paragraph without the marker
is refused. Quotations use the strict blockquote grammar above, and every
non-blank line of that section must be one — the checker would otherwise pass
a prose line inside `Quotations` uninventoried. No generated frontmatter,
links, HTML, code fences, `[stated]`, `[accepted]`, `fact-checked` or
`human-read` labels are allowed; a bare `scheme://` URL, an inline
`[text](target)` or reference `[text][id]` link and a `[id]: ...` definition are
links as well and are refused. The final quote check uses the full extraction,
not the lossy request view. Source, map, config and selected-context edits
during the request refuse publication. All source hashes are rechecked before
publication.

Use a local, untracked extraction/cache directory. Failed responses stay beside
the selected page map as `<output-stem>.draft.md` and a static
`<output-stem>.diagnostic.json`; a failed quote check also keeps its local report.
A failure before receiving text has only the diagnostic, not an invented draft.
An existing diagnostic/draft/report refuses a new run: choose a separate proposal
stem or deliberately move the old diagnostic before correction. The adapter does
not manage `.gitignore`; exclude caches, raw responses and proposed excerpts
from publication yourself. Publishing excerpts requires a separate human decision.

On success, only the new proposed note and `<output-stem>.quote-check.json`
are published at the selected output location. Publication refuses existing
notes/reports, including concurrent winners; it never silently overwrites them.
Staging files are removed on success, so editing a later diagnostic cannot alter
the saved note. The report binds the exact final note, PDF, full extraction and
map hashes. Re-run `verify-quotes.py` after any manual edit. The printed result
shows the quotation inventory, supplied version and PDF hash and always carries
the wording-only disclaimer. Paraphrase, numbers, attribution, relevance and
transfer limits still need human inspection.

### Manual live gateway smoke gate (not run by this package)

With the researcher present, inspect the process, user-settings, project-settings and
local-settings configuration levels without printing credentials. Confirm the
existing gateway's owner, protocol, selected model, upstream destination and
context/output limits before passing its configuration to the adapter. This is
a new egress route and requires the researcher's approval; a refused route is a stop,
not permission to substitute another provider or change hooks or permissions.
The design's backlog-reported subagent refusal was not reproduced by these
local tests and does not justify an exemption.

Then run the documented extractor -> adapter -> quotation check sequence on
one invented paper and invented project context using that approved route.
Record only the configured model, status, elapsed time and final quotation count
in private verification evidence; keep keys, paper contents and raw responses out
of public logs. Verify the saved report with `verify-quotes.py --verify` and
inspect the proposal metadata and relative links. If the service is unavailable,
record its live behavior as UNVERIFIED. The package's tests exercise a local fake
HTTP server only: no gateway request or four-level live-wiring validation was run.
Independent candidate review of egress selection and final-output publication
is required before integration; mocked HTTP cannot establish endpoint ownership.

## The skill

`skills/literature-note/SKILL.md` walks the stages above in one order: the
researcher supplies the explicit inputs, the model extracts and pins the printed
pages, the adapter drafts through the approved gateway, and the quotation check
decides what may become a note. The skill repeats the boundary above in the same
words and says that the check covers wording only — not paraphrase, not numbers,
not attribution. It never accepts: no `[stated]`, no `[accepted]`, no
`fact-checked` or `human-read` label, and no note-acceptance ledger. An idea the
note raises moves into the canvas as a proposal through the canvas skill, and the
researcher accepts it there.

The request comes from this workflow, directly through the gateway. There is no
generic subagent and no Sidequest scope exemption for one: the paper text needs
no tools, no repository permissions and no acceptance authority, and a subagent
would carry all three. A refused route is a stop, not permission to substitute a
provider or change hooks.

## Walkthrough: extraction, draft and check

The walkthrough runs on an invented paper project. Every name in it is made up,
and `test/literature-workflow.test.js` executes exactly these commands against
the `regular.pdf` fixture and a loopback fake gateway, never a live model:

    invented-paper-project/
      research/canvas.md          the selected framing (main state)
      research/decisions.md       the ledger; the walkthrough must not touch it
      sources/meeting-paper.pdf   the invented paper, printed pages 41 to 43
      notes/selected-sibling.md   the sibling note named as context
      local-cache/                extraction, page map and any draft; untracked
      inputs.json                 the explicit inputs shown above

Run each command from the plugin directory.

1. Extract and pin the pages:

       python3 scripts/extract-paper.py <project>/sources/meeting-paper.pdf --offset 40 --out <project>/local-cache

   Exit 0, printed pages 41, 42 and 43, and `local-cache/meeting-paper.page-map.json`
   carries the SHA-256 of those PDF bytes.

2. Draft through the approved gateway. Write the input JSON shown above, then:

       python3 scripts/draft-literature-note.py --project <project> --inputs <project>/inputs.json --gateway-config <approved-gateway.json>

   Exit 0 writes `<project>/notes/meeting-paper.proposed.md` and its
   `meeting-paper.proposed.quote-check.json`, whose `result` is `verified` and
   whose `inventory.checked` counts the quotations. The frontmatter carries the
   supplied bibliography and version, `unknown` reader and read coverage, and
   the model identifier; the links are ordinary relative Markdown links that
   resolve. `research/canvas.md` and `research/decisions.md` are byte-identical
   to before.

3. Check, and show what the gate refuses:

       python3 scripts/verify-quotes.py <project>/notes/meeting-paper.proposed.md --page-map <project>/local-cache/meeting-paper.page-map.json

   Exit 0. Then corrupt one word of a quotation in a copy of the note and check
   the copy: exit 1, naming the line, the printed page and the reason. Restore
   the word, change that quotation's locator to a page the passage is not on,
   and check again: exit 1 as well. Each failure blocks final output — the
   adapter publishes only after its own clean check, and a corrupted response
   leaves `<project>/local-cache/meeting-paper.proposed.diagnostic.json` and a
   local draft, with no note and no report at the output path.
