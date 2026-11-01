# File formats and the 1.x contract

This page specifies the on-disk formats and compatibility boundary for placet-research 1.0. The implementation references describe main commit `3ccaa631a96589447278a5937e5915d4b1d681ff`, the pre-release source for this contract. The promise is forward compatibility within 1.x: files written by 1.0 will be read and verified by every 1.x release, with the same key. Projects created before 1.0 are not covered; set them up anew at release. This is a compatibility promise, not a claim that a future release has already been tested.

The paths below use the default project directory, `research/`. `PLACET_RESEARCH_DIR` selects another directory, resolved against the project root. The canvas, log, and optional glossary belong in version control; the secret key does not.[^paths]

## 1. `research/canvas.md`

The canvas is UTF-8 Markdown with LF line endings and a scalar frontmatter block. This is the header written for a main canvas with a title:

```markdown
---
project: "example-study"
title: "How teams decide"
outlet: ""
profile: is-qualitative
created: 2026-10-26
mode: brainstorming
canvas-schema: 2
---
```

`project` is the project slug. `title` is optional; without it the view uses the slug. `outlet` holds the target venue, including an empty string when none was supplied. `profile` names the dependency graph and checks; the default is `is-qualitative`, and `is-quantitative` also ships. `created` is a UTC calendar date, not an event timestamp. `mode` is `brainstorming`, `seed`, or `import`. `canvas-schema` is written as `2`. The reader is a small `key: value` parser, not a general YAML implementation: double-quoted scalars use JSON-compatible escaping. Do not rely on YAML arrays, nested mappings, or arbitrary YAML escapes.[^canvas-header]

The body has nine elements. Element headings have exactly the form `# N · Title`; question headings have the form `## N.M Question text`, under the element named by `N`. The shipped elements are:

1. Puzzle
2. Audience and Prior Research
3. Research Question
4. Theoretical Constructs and Relationships
5. Research Setting
6. Research Design and Analysis
7. Findings
8. Contributions
9. Boundary Conditions and Limitations

The question numbers are identifiers, not Markdown list numbers. Duplicate element or question headings, or a question under the wrong element, are reported rather than merged into one reading. `_(empty)_` is the empty-question placeholder.[^canvas-body]

```markdown
# 3 · Research Question

## 3.1 In one sentence: what does this study answer?

How do teams decide which suggestions to verify? [proposed, unverified]
Teams describe verification as a shared task. [tentative, src: notes/interviews.md#verification]
```

A statement ends in a bracket group. Its first comma-separated token must be one of `[proposed]`, `[tentative]`, `[stated]`, or `[accepted]`; remaining tokens are evidence tags. `proposed` and `tentative` are uncommitted material. `stated` records what the researcher said, while `accepted` records a commitment made through the approval path. Both `stated` and `accepted` are protected commitments. The parser recognizes the marker, not the truth of those descriptions: typing `[accepted]` does not supply a verified acceptance.[^markers]

A statement may wrap across lines. A recognized trailing marker closes it even without a blank line before the next statement; otherwise a blank line ends a paragraph. The statement numbers shown to readers are derived from file order within a question: `3.1`, then `3.1b`, then `3.1c`. These suffixes are not stored as statement IDs in the canvas. Reordering statements can change their displayed numbers. The CLI accepts the question ID `3.1`, with `--match` when it must distinguish candidates, not a displayed suffix.[^numbers]

`src:` tags retain the source pointer, for example `src: notes/interviews.md#verification`. A glossary citation is `src: glossary.md#felt-safety`, relative to the selected state directory. A tag is a declaration of provenance, not a check that the source supports the statement. The parser keeps tags as strings; the glossary review resolves references to the selected glossary, including its entry ID and authorization state.[^sources]

The related form `<!-- constructs: felt-safety, speaking-frequency -->` belongs in a declared manuscript, not in the canvas marker group. The review reads these comma-separated IDs from HTML comments outside excluded code and bibliography regions. They declare construct use for the paragraph they accompany, or the preceding prose paragraph when standing alone. Manuscripts can instead link directly to the glossary, for example `[felt safety](research/glossary.md#felt-safety)`. Neither form proves that the definition is appropriate.[^constructs]

Use LF, not CRLF. The canvas parser reports CRLF, state-loading write paths refuse a CRLF canvas or log, and glossary parsing also reports it. Converting a sealed file behind the verifier is not a repair: the prefix of the log is byte-sensitive.[^line-endings]

## 2. `research/decisions.md`

The main log starts with the project title and a key fingerprint:

```text
# Decision log — example-study

Seal key: <16 hex>
```

`<16 hex>` stands for 16 lowercase hexadecimal characters, not a literal placeholder in a real log. The fingerprint is the first 16 hex characters of HMAC-SHA256 under the project key over the UTF-8 label `placet-research seal key`. Only a `Seal key:` line before the first parsed entry names the key. It detects a wrong key even before the log has entries; it does not reveal the key.[^key-line]

An entry has this layout; the placeholders denote the encoded hash and seal:

```text
## [#1] 2026-10-26 · DECISION · 3.1 accepted · text <8 hex> · seal <16 hex>
How do teams decide which suggestions to verify? [accepted, unverified]
**By:** Researcher A
**Why:** The question concerns a decision process.
**Explained:** I accept this question because the material describes how teams decide.
**Rejected:** A question about individual attitudes alone.
**Open at acceptance:** #2, #3
**Supersedes:** #4
```

This is a field-layout illustration, not a valid chain: its references and placeholders are not a sample record. The heading uses `## [#<sequence>] YYYY-MM-DD · <KIND> · <ref>`, optionally followed by ` · text <8 lowercase hex>` and then ` · seal <16 lowercase hex>`. The date is a UTC calendar date. The text hash and seal have separate jobs. Canvas acceptance uses the first eight hex characters of SHA256 over the normalized statement text; the seal authenticates the entry in its chain.[^entry]

The first body line is entry text. The optional labeled fields follow in this order: `By`, `Why`, `Explained`, `Rejected`, `Discarded`, `Open at acceptance`, `Supersedes`; the example shows all but `Discarded`, which only a framing choice writes. Writers include `By` on new entries. Fields can continue over following lines; values are trimmed when read. `Open at acceptance` is a comma-separated list of `#<sequence>` references. It records `DISCOVERY` entries whose ref is exactly `<question ID> check` and whose sequence is later than the last `DECISION` on that question. Those open checks are recorded, not an acceptance veto. `Supersedes` names one prior entry as `#<sequence>`; the prior entry remains in the file. `Discarded` records every other variant directory as it stood at the moment of a framing choice, sorted by name and separated by `; `: `<name> sha256:<64 lowercase hex>` is the SHA-256 of that variant’s `canvas.md` bytes, as `shasum -a 256` prints it, and `<name> missing` marks a variant whose canvas was absent; `none` means there was no other variant. The researcher’s own `Rejected` text does not change it. Like every field it is part of the sealed body. A framing choice written before the field existed has no `Discarded` line and verifies and reads as before. `review` compares each recorded digest with the file as it is now and lists the result under `Discarded framings`; a difference is reported, not enforced. Free text supplied to writers may not inject entry headings or labeled field lines.[^fields]

`By` comes from the user-wide name file, then `git config user.name` if no name is set there. It is a statement of authorship, not verified identity. A key holder can write any name.[^identity]

The five entry kinds are:

- `DECISION`: an approval-path entry, including a canvas acceptance, a glossary acceptance, or a framing choice. Ordinary `log` cannot write it.
- `CONSTRAINT`: a recorded constraint; the profile-switch path also uses this kind.
- `DISCOVERY`: a finding or check question.
- `SESSION`: a marker written by `session start`, with the occasion as its ref. A session runs until the next SESSION marker or the end of the log.
- `MERGE`: a marker written after reconciling divergent logs. SESSION and MERGE participate in the chain but are not acceptance cover or open checks.[^kinds]

The append path assigns `maxSeq + 1`, starting at `#1`, and puts one blank line between entries. Appending does not rewrite earlier entries. A divergent two-person merge is the explicit exception to leaving the working log unchanged: it keeps the incoming log, renumbers and re-seals the local divergent entries after it, rewrites `Supersedes` and `Open at acceptance`, and appends MERGE. Narrative entry numbers are not rewritten. Originals remain in git history; an entry number is therefore a position in a particular log, not a permanent global ID.[^append-merge]

### The seal algorithm

Each entry seal is the first 16 lowercase hex characters of HMAC-SHA256 over this ordered list, joined with the single character U+001F and encoded as UTF-8:

```text
previous seal, decimal sequence, date, kind, ref, text hash or empty string, normalized body
```

The commas above describe a list; they are not input bytes. The body includes the entry text and all labeled fields. Normalization applies Unicode NFC, collapses runs of space, tab, CR, and LF to one ASCII space, then trims the result. It does not use compatibility normalization. The first sealed entry uses the full lowercase SHA256 hex digest of every UTF-8 byte before its heading as the previous value, including the separator before that heading. Each later entry uses the preceding entry’s 16-hex seal.[^algorithm]

A verified chain means the sealed entries recompute under the key. A broken chain means verification found an inconsistency: a wrong key fingerprint, CRLF, an altered prefix or entry, a missing link, or an unsealed entry after sealing began. The report identifies the first failing location; appending refuses a broken chain rather than repairing it. A missing key is a different outcome, `unverifiable`, not evidence of tampering. The implementation can report an unsealed legacy prefix separately, but that does not extend the 1.x promise to pre-1.0 projects.[^verification]

The seal is not a byte-for-byte file digest: ordinary body reflow can leave it unchanged. `review` also prints an anchor containing the last seal, maximum sequence, and full SHA256 of `decisions.md` as received. Comparing it with a previously retained anchor can detect a rewritten record. A key holder can re-seal a log; an anchor generated only after that rewrite does not expose it.[^anchor]

## 3. `research/glossary.md`

The optional glossary uses schema 1. Its frontmatter declares `glossary-schema: 1` and may declare `manuscripts`, a semicolon-separated list of project-root-relative Markdown files. Omitting that list means manuscript coverage was not requested.

```markdown
---
glossary-schema: 1
manuscripts: paper.md; sections/theory.md
---

## felt-safety

Term: Felt safety
Aliases: perceived safety
Definition: A participant’s expectation that expressing a concern will not expose them to interpersonal harm.
Origin: own-definition
Distinctions: This is an expectation, not an observed count of speaking turns; no neighboring construct is declared here.
[proposed]
```

The level-two heading is a unique lowercase ID, consisting of letters or digits separated by single hyphens. The fields appear once, in this order: `Term`, optional `Aliases` (comma-separated labels), `Definition`, `Origin`, `Distinctions`. Values can wrap; a blank line ends a value. `Origin` is `own-definition` or `src: <project-relative file>#<anchor>`; `pending` definitions and `unverified` origins describe incomplete proposals. Distinction links use `[term](#entry-id)` and must resolve to entries. Duplicate IDs, ambiguous labels, misordered fields, and malformed blocks are reported, not silently discarded.[^glossary]

The authorization marker stands alone after the fields, without tags. It can be `[proposed]`, `[tentative]`, `[stated]`, or `[accepted]`. Acceptance changes it to `[accepted]` and appends a sealed DECISION with ref `glossary <id> accepted`. The bound payload is a JSON array of the ID, normalized term, aliases in declared order, definition, origin text, and distinctions. The marker is excluded. The log carries its eight-hex text hash and the JSON payload; `glossary show` supplies the full 64-hex SHA256 binding digest required by `glossary accept --hash`. A marker alone does not establish acceptance, and changed accepted text is reported as stale.[^glossary-binding]

## 4. Variants

A variant lives at `research/variants/<name>/canvas.md`, with its own `decisions.md` and optional `glossary.md` beside it. Names match `[a-z0-9][a-z0-9-]{0,39}`. A variant canvas carries `project`, `variant`, `lens`, `profile`, `created`, `mode`, and `canvas-schema: 2`; initialization uses the same element and question body as the main template. Its log title is `# Decision log — <project> · variant <name>`.[^variants]

Each variant log has a separate chain, but all variants use the main project’s key. Variant initialization does not write a separate `Seal key:` line; variant writes check the main log’s key line. `accept` and `glossary accept` operate on the main state only. Choosing a framing copies its canvas body into the main canvas, retains the main frontmatter, and records a framing DECISION whose `Discarded` field holds the SHA-256 of each other variant canvas; it is not acceptance of each statement.[^variant-key]

## 5. The key file

`seal.key` contains 32 random bytes encoded as 64 hex characters. Creation uses mode `0600` and exclusive creation, never replacing an existing key. Export adds a trailing LF; readers trim surrounding whitespace and accept uppercase or lowercase hex. This is a shared secret, not a public verification key.[^key-file]

The normal location is:

```text
<PLACET_RESEARCH_STATE_DIR>/<project-root digest>/seal.key
```

The default state root is `~/.claude/placet-research`. The directory name is the first 24 lowercase hex characters of SHA256 over the project’s real root path; if realpath resolution fails, the implementation uses the resolved absolute path. A symlink to the same checkout therefore finds the same key, while a clone elsewhere does not. `PLACET_RESEARCH_DIR` changes the paper files’ location, not this key lookup. Keep the state root and exported keys outside the repository.[^key-location]

`key export --out <file>.seal.key` writes a new file with creation mode `0600` and refuses to overwrite an existing path. Transfer it privately. `join --key-file <file> --name "<name>"` checks it against the clone’s log, installs the key at that clone’s local root-derived location, and sets the name. A stored different key is replaced only when the main log’s fingerprint identifies the incoming key as the project’s. `join` does not delete the transfer file. Reviewers who only need verification can use `review --key <file>` without joining.[^handover]

## What 1.0 promises

Every 1.x release will read and verify the canvas, log, glossary, and variant formats written by 1.0. The seal algorithm, key fingerprint, and key-file encoding above remain supported. Verification still requires the matching key; compatibility does not make an edited or broken chain valid.

The 18 top-level CLI commands and their existing flags remain supported. New flags may be added; existing flags will not be removed. The interface is `placet-research` (or `node <plugin>/bin/placet-research.js`); brackets below denote optional arguments, not literal characters:[^cli]

| Command | Arguments and flags |
|---|---|
| `init` | `--project <slug> --mode brainstorming\|seed\|import [--outlet <name>] [--title <text>] [--profile <id>]`; or `--variant <name> --lens <text> [--mode brainstorming\|seed\|import]` |
| `status` | `[--variant <name>] [--key <file>]` |
| `review` | `[--variant <name>] [--key <file>]` |
| `agenda` | `[--out <file>]` |
| `accept` | `<n.m> --explained <text> [--match <substring>] [--why <text>] [--rejected <text>]` |
| `glossary` | `show <id>`; or `accept <id> --hash <64hex> --explained <text> [--why <text>] [--rejected <text>]` |
| `choose` | `<name> --why <text> [--rejected <text>]` |
| `log` | `DISCOVERY\|CONSTRAINT <ref> --body <text> [--why <text>] [--supersedes <n>] [--variant <name>]` |
| `title` | `[<text>]` |
| `profile` | `[<id>]` |
| `name` | `[<name>]` |
| `key` | `export --out <file>.seal.key` |
| `join` | `--key-file <file> --name "<name>"` |
| `merge-log` | `[--skip-decision <n>]` (one number, separated from the flag by a space) |
| `session` | `start "<occasion>"`; or `protocol [<n>] [--out <file>]` |
| `serve` | `[--no-open]`; or `--app [--app-data <dir>] [--no-open]` |
| `doctor` | no arguments required |
| `install-cli` | `[--dir <path>]` |

The environment variables remain supported: `PLACET_RESEARCH_DIR` for project state files, `PLACET_RESEARCH_LIBRARY` for local full-text material (including `libraryPointer` resolution), and `PLACET_RESEARCH_STATE_DIR` for machine-local state and the key.[^environment]

The refusals listed in the plugin README’s [What it enforces](../plugins/placet-research/README.md#what-it-enforces) remain refusals within the visible-tool-call perimeter: model writes creating acceptance, changing or removing protected commitments, promoting proposals, rewriting existing headings or frontmatter, or directly writing the log; shell writes to state files; and tool access to the machine-local harness state directory, including reads. A write the guard cannot judge is refused. Logged acceptance still requires verified cover. This promise preserves those controls; it does not turn them into an operating-system security boundary.[^enforcement]

## What 1.0 does not promise

- **Pre-1.0 projects.** There is no promise to read or migrate them. Set projects up anew at the 1.0 release.
- **Verified identity or human intent.** `By` and a verified seal do not prove who ran a call, that a person approved it, or that a claim is true.
- **A closed bypass perimeter.** M27 in the technical appendix is the measured runtime-path bypass: code constructs a library path and calls the same choice function a person can call. Data-carried write targets, such as paths inside a patch passed to `git apply` or an archive extracted with `tar -x`, are also outside this guarantee. A visible-command guard is not a sandbox; absence of a refusal is not proof that such a payload is safe. This page does not claim a new perimeter measurement.[^limits]
- **The desktop app.** Its packaging and workflow are not the 1.x compatibility contract. Keeping CLI flags, including the app-launch flags, does not freeze the desktop application.
- **Agent hosts other than Claude Code.** The hook and skill enforcement contract is for Claude Code, even though mechanical CLI verification needs no model session.
- **The session view’s appearance or URLs, or skill wording.** These may change without changing the on-disk contract.
- **Unmeasured Windows support.** A package built or checked on a Mac is not evidence that it works on Windows. Windows compatibility is not promised without measurement on Windows.[^platform]

## Implementation references

Paths and line numbers below are repository-relative at the source commit named above. They establish the current encoding and behavior, not evidence of future-release testing.

[^paths]: `plugins/placet-research/hooks/lib/project.js:6-8`, `plugins/placet-research/hooks/lib/project.js:20-62`; `plugins/placet-research/README.md:521-537`.
[^canvas-header]: `plugins/placet-research/bin/placet-research.js:127-139`, `plugins/placet-research/bin/placet-research.js:262-290`; `plugins/placet-research/hooks/lib/canvas.js:86-110`; `plugins/placet-research/hooks/lib/state.js:57-60`; `plugins/placet-research/README.md:543-549`.
[^canvas-body]: `plugins/placet-research/references/canvas-elements.md:14-138`; `plugins/placet-research/hooks/lib/canvas.js:11-12`, `plugins/placet-research/hooks/lib/canvas.js:133-164`, `plugins/placet-research/hooks/lib/canvas.js:167-239`.
[^markers]: `plugins/placet-research/hooks/lib/canvas.js:7-9`, `plugins/placet-research/hooks/lib/canvas.js:113-120`, `plugins/placet-research/hooks/lib/canvas.js:345-384`; `plugins/placet-research/hooks/lib/accept.js:98-112`.
[^numbers]: `plugins/placet-research/hooks/lib/canvas.js:182-234`; `plugins/placet-research/hooks/lib/numbers.js:2-18`; `plugins/placet-research/hooks/lib/accept.js:35-49`.
[^sources]: `plugins/placet-research/hooks/lib/canvas.js:113-120`; `plugins/placet-research/hooks/lib/review.js:386-406`; `plugins/placet-research/hooks/lib/glossary.js:344-367`; `plugins/placet-research/README.md:514-518`.
[^constructs]: `plugins/placet-research/hooks/lib/review.js:108-166`, `plugins/placet-research/hooks/lib/review.js:217-225`, `plugins/placet-research/hooks/lib/review.js:485-495`; `plugins/placet-research/references/construct-glossary.md:47-51`; `docs/technical-appendix.md:248-262`.
[^line-endings]: `plugins/placet-research/hooks/lib/canvas.js:167-175`; `plugins/placet-research/hooks/lib/state.js:43-48`; `plugins/placet-research/hooks/lib/glossary.js:168-185`; `plugins/placet-research/hooks/lib/seal.js:174-181`.
[^key-line]: `plugins/placet-research/hooks/lib/decisions.js:14-16`; `plugins/placet-research/hooks/lib/seal.js:88-128`; `plugins/placet-research/bin/placet-research.js:279-290`.
[^entry]: `plugins/placet-research/hooks/lib/decisions.js:5-12`, `plugins/placet-research/hooks/lib/decisions.js:106-117`; `plugins/placet-research/hooks/lib/hash.js:6-10`; `plugins/placet-research/hooks/lib/log.js:9-10`.
[^fields]: `plugins/placet-research/hooks/lib/decisions.js:44-117`; `plugins/placet-research/hooks/lib/choose.js:56-102`; `plugins/placet-research/hooks/lib/accept.js:18-26`, `plugins/placet-research/hooks/lib/accept.js:93-112`; `plugins/placet-research/hooks/lib/log.js:13-37`, `plugins/placet-research/hooks/lib/log.js:58-74`.
[^identity]: `plugins/placet-research/hooks/lib/identity.js:11-20`, `plugins/placet-research/hooks/lib/identity.js:49-78`; `docs/technical-appendix.md:88-101`.
[^kinds]: `plugins/placet-research/hooks/lib/decisions.js:5-8`; `plugins/placet-research/hooks/lib/log.js:47-74`; `plugins/placet-research/hooks/lib/accept.js:100-112`, `plugins/placet-research/hooks/lib/accept.js:184-196`; `plugins/placet-research/hooks/lib/choose.js:174-185`; `plugins/placet-research/hooks/lib/session.js:9-23`; `plugins/placet-research/bin/placet-research.js:660-704`; `plugins/placet-research/hooks/lib/merge.js:133-139`.
[^append-merge]: `plugins/placet-research/hooks/lib/decisions.js:120-135`; `plugins/placet-research/hooks/lib/seal.js:330-356`; `plugins/placet-research/hooks/lib/merge.js:32-46`, `plugins/placet-research/hooks/lib/merge.js:120-140`; `docs/technical-appendix.md:103-144`.
[^algorithm]: `plugins/placet-research/hooks/lib/canvas.js:19-29`; `plugins/placet-research/hooks/lib/seal.js:147-157`, `plugins/placet-research/hooks/lib/seal.js:196-206`, `plugins/placet-research/hooks/lib/seal.js:212-226`; `docs/technical-appendix.md:11-29`.
[^verification]: `plugins/placet-research/hooks/lib/seal.js:164-209`, `plugins/placet-research/hooks/lib/seal.js:348-351`; `plugins/placet-research/hooks/lib/state.js:108-114`.
[^anchor]: `plugins/placet-research/hooks/lib/seal.js:131-144`; `docs/technical-appendix.md:53-70`.
[^glossary]: `plugins/placet-research/hooks/lib/glossary.js:43-80`, `plugins/placet-research/hooks/lib/glossary.js:107-165`, `plugins/placet-research/hooks/lib/glossary.js:168-305`; `plugins/placet-research/references/construct-glossary.md:15-88`.
[^glossary-binding]: `plugins/placet-research/hooks/lib/glossary.js:241-254`, `plugins/placet-research/hooks/lib/glossary.js:370-395`; `plugins/placet-research/hooks/lib/accept.js:174-205`; `plugins/placet-research/bin/placet-research.js:531-561`.
[^variants]: `plugins/placet-research/hooks/lib/project.js:25-62`; `plugins/placet-research/bin/placet-research.js:163-194`.
[^variant-key]: `plugins/placet-research/hooks/lib/state.js:18-21`, `plugins/placet-research/hooks/lib/state.js:49-53`, `plugins/placet-research/hooks/lib/state.js:100-106`; `plugins/placet-research/bin/placet-research.js:503-506`, `plugins/placet-research/bin/placet-research.js:543-549`; `plugins/placet-research/hooks/lib/choose.js:169-185`.
[^key-file]: `plugins/placet-research/hooks/lib/seal.js:24-81`; `plugins/placet-research/bin/placet-research.js:730-749`.
[^key-location]: `plugins/placet-research/hooks/lib/ledger.js:11-47`; `plugins/placet-research/hooks/lib/seal.js:31-32`; `docs/technical-appendix.md:13`.
[^handover]: `plugins/placet-research/bin/placet-research.js:730-823`, `plugins/placet-research/bin/placet-research.js:325-333`; `docs/technical-appendix.md:132-140`.
[^cli]: `plugins/placet-research/bin/placet-research.js:29-51`, `plugins/placet-research/bin/placet-research.js:842-854`, `plugins/placet-research/bin/placet-research.js:1319-1336`.
[^environment]: `plugins/placet-research/hooks/lib/project.js:20-23`; `plugins/placet-research/hooks/lib/ledger.js:11-12`; `plugins/placet-research/scripts/draft-literature-note.py:100-109`; `plugins/placet-research/README.md:531-549`; `docs/technical-appendix.md:319-332`.
[^enforcement]: `plugins/placet-research/README.md:492-519`; `plugins/placet-research/hooks/guard-promotion.js:133-185`; perimeter qualifications in `docs/technical-appendix.md:31-37`, `docs/technical-appendix.md:132-140`.
[^limits]: `docs/technical-appendix.md:37`, `docs/technical-appendix.md:68-72`, `docs/technical-appendix.md:373`. These are the appendix’s historical observations, not a new probe run for this page. The compatibility decision excludes data-carried targets; no new patch or archive probe is asserted here.
[^platform]: `docs/technical-appendix.md:72`; `README.md:128-153` records that the Windows package has not been tested on Windows.
