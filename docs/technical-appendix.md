# Technical appendix: the research record

Sections 1–8 describe the implementation at main commit `4b382f3445fa127406cb30950b3b040138c5bcdb` (release 0.4.1), checked on 1 October 2026, except where a 0.5 addition is noted. Their source line numbers and measured counts refer to that commit. Section 9 describes the two-person commands at main `01e6d576fbd85675021509eedede26ce3b2bf31a`; it does not extend the earlier perimeter measurements. Sections 10–14 moved here from the top-level README on 6 October 2026 (main `aceeac4`) without change to their content. The [public-data walkthrough](../plugins/placet-research/README.md#walkthrough-the-three-capabilities-on-a-public-dataset) demonstrates framing comparison, acceptance with an explanation, and review of the record. Its console commands are exercised by `demo.test.js`; a person's completion time has not been measured. The recorded run demonstrates the mechanism, not the quality of a live model's research judgment.[^demo]

## 1. State and write paths

The durable project record is Markdown: `canvas.md` holds statements and their authorization markers; `decisions.md` holds the log. Their directory defaults to `research/` and can be changed with `PLACET_RESEARCH_DIR`. A variant has its own pair of files under `research/variants/<name>/`, or the corresponding configured state directory. Each variant log has a separate seal chain, but all variants use the project root's key.[^state]

Acceptance, framing choice and sealed log appends use shared functions in `hooks/lib`; the terminal CLI and the browser server call those same functions. This does **not** mean every canvas write goes through the library: the CLI writes initialization scaffolding and titles directly, and the model may use guarded Write/Edit calls to change proposals. The guard is the control on those model tool calls. These are ordinary files, not an immutable storage service.[^paths]

## 2. What the seal covers

Initialization creates a random 32-byte key, stored as 64 hexadecimal characters in `seal.key`, with creation mode `0600`. It does not replace an existing key. The containing directory is keyed by a digest of the project's real root path under `PLACET_RESEARCH_STATE_DIR` (default `~/.claude/placet-research`), outside the paper repository in the default setup. A clone at a different root therefore does not acquire the original key automatically. Main and variant logs share this per-root key.[^key]

For each entry, the seal is the first 16 hexadecimal characters (64 bits) of HMAC-SHA256 over these fields, separated by U+001F:

```text
previous seal | sequence | date | kind | ref | text hash | normalized body
```

The vertical bars here denote separators; they are not literal bytes in the input. The body includes the explanation and other labelled fields. The first sealed entry chains onto a SHA256 digest of the entire preceding file prefix; subsequent entries chain onto the previous seal. Body normalization makes ordinary reflow and collapsed spaces insensitive to the seal. The chain is therefore not a byte-for-byte fingerprint of the whole file. The anchor described below supplies that fingerprint.[^seal]

`review` keeps these outcomes distinct:

- `verified`: the sealed entries recompute under the supplied or local key. A legacy prefix is reported separately; its individual entries do not become verified acceptances.
- `BROKEN at #…`: an entry fails verification, or an unsealed entry follows a sealed one. The report names the first failing entry and line. The append path refuses to extend a broken chain.
- `unverifiable here`: sealed entries exist but this machine has no key. An entirely unsealed legacy log is reported as `unverifiable`; an empty log as `empty`.

The mechanical review also compares accepted canvas text with recorded text hashes. It reports stale acceptances and accepted statements without verified log cover. Verification concerns the record, not whether a research claim is true.[^review]

## 3. The promotion guard and its perimeter

The plugin registers `guard-promotion.js` as a Claude Code `PreToolUse` hook without a tool matcher. For writes it can inspect, the model may add or change `[proposed]` and `[tentative]` statements, and transcribe a new `[stated]` statement. It may not relabel an existing proposal as stated, create an `[accepted]` statement, or change or remove an existing stated or accepted commitment. It may run initialization and mechanical status/review, and append findings through `log DISCOVERY` or `log CONSTRAINT`. The advisory `check` skill records questions using `log DISCOVERY "<n.m> check"`; it does not accept.[^guard]

Recognized model invocations of `accept`, `choose` and `serve` are denied. Direct writes to `decisions.md` are denied, including appends. The same file judgment applies to canvas and log files nested below the state directory. Tool payloads naming the harness key/state directory are denied even for reads. The perimeter probe measures key reads, symlink paths, shell wrappers and the human-only verbs. At the cited main revision it also denies the previously vulnerable `sed -n` write routes, including a write after a semicolon-terminated label.[^perimeter]

These are bounded controls on visible tool calls, **not a guarantee that a model cannot accept or choose**. In the measured probe, row M27 constructs a library path at runtime in `node -e`, calls the framing-choice function, and produces a sealed `framing chosen` entry that verifies. The guard does not see that invocation. A script written in one call and run in a later call is also opaque to it. A verified seal cannot retrospectively distinguish such a call from a researcher calling the same function.[^limits]

## 4. Accept with understanding

Both approval routes call `acceptStatement`. A missing, empty or whitespace-only explanation returns `explanation-required` before a write; a successful accept records `**Explained:**`. The requested explanation is one sentence in the researcher's own words. The implementation checks that text is nonempty, not that it is one sentence, personally written, or evidence of understanding.[^accept]

Immediately before accepting, the library computes `openAtAccept` from the log: every `DISCOVERY` with ref exactly `<n.m> check` whose sequence is greater than the last `DECISION` on that question. If any exist, their sequence numbers are written as `**Open at acceptance:** #a, #b`. Earlier checks are closed by a decision on the question; unrelated discoveries do not count. CLI/library byte-identity tests assert the exact explanation, field order and open-check numbers. The server uses the same function.[^checks]

Open checks do not block acceptance. The view lists them and offers “Accept anyway.” There is no required successful check and no model verdict in the acceptance function; the server calls no model for approval. Mechanical prerequisites still apply, including dependency status, a usable seal chain and an unambiguous target (with a stale-text check for browser requests). A mandatory model verdict would give model-authored questions authority the record cannot justify: the record supplies no verified actor identity.[^advisory]

## 5. Framing alternatives and the chosen record

The canvas skill's multiverse procedure assigns the same material and a different lens to each variant worker, then reviews each variant. `init --variant <name> --lens <text>` records the variant and lens in frontmatter. `status`, `review` and `log` can address a variant; `accept` is restricted to the main canvas. The view compares variants by field; generation is a skill procedure, not a model call made by the server.[^variants]

`choose <name> --why <text> [--rejected <text>]` keeps the main frontmatter and copies the chosen variant's body into the main canvas. It appends a sealed main-log `DECISION` with ref `framing chosen: <name>`, a text hash of the variant canvas, the reason, and rejected alternatives. If no rejected text is supplied, the default lists the other variant names and their lenses. The variants remain in place; the entry does not embed complete snapshots of the rejected canvases or make them immutable. Choice is refused if the main canvas contains stated or accepted statements, or if the chosen variant contains a planted acceptance. Mechanical review treats framing decisions as decisions requiring verification, but not as statement acceptances.[^choose]

## 6. Verification on another machine

From the received paper project, with the CLI installed, a reviewer can run:

```sh
placet-research review --key /path/to/released-key-file
placet-research status --key /path/to/released-key-file
```

The authors must hand over the key file separately; the example does not ship a committed key. `--key` supplies a verification-only override. An unreadable file or one that is not a 32-byte hex key is refused without a verification report; a valid but wrong key yields a broken-chain verdict. A received sealed log does not get a replacement key merely by running `init`.[^external]

Every `review` prints `Anchor:` followed by the last seal, the maximum sequence number, and SHA256 of the received `decisions.md` bytes. This needs no key. Compare it with a copy retained independently at submission or an earlier publication, not merely an anchor delivered alongside the current log. A key holder can rewrite the log and recompute every seal consistently. An earlier external anchor exposes that rewrite as a different record; a newly printed anchor matches the rewritten log too. The released key gives its recipient the same ability to recompute seals. The anchor fingerprints `decisions.md`, not the entire project or dataset.[^anchor]

## 7. Honest limits

The 0.4.1 entry format had no actor or identity field; 0.5 adds the `By` statement described in §9, not verified identity. A verified chain establishes consistency under the shared key, not which person wrote it, which machine actually ran a call, or whether a human approved it. The runtime-path bypass above is an observed example. Dates are UTC calendar dates (`YYYY-MM-DD`), not event timestamps. Ed25519 public-key seals and verified actor identity remain unimplemented. Neither a seal nor an explanation assesses source quality or guarantees understanding.[^identity]

A guard that gives no verdict blocks the call. By default Claude Code lets a tool call continue when a `PreToolUse` hook times out ([hooks documentation](https://code.claude.com/docs/en/hooks), "Timeouts"), so the guard's hook sets `onFailure: "block"`: a timeout, a crash or a failed start refuses the call instead ("Block the action when a hook fails"; Claude Code 2.1.295 or later). The guard's limit is 10 seconds. On a machine under heavy load, other hooks running before the same call can push it past that, and tool calls are then refused until the load drops.

The model-assisted canvas, check and record-review skills require Claude Code. The record-review skill is instructed to answer only from the canvas, log, mechanical report and git reads, cite log entries by `#seq` and statements by number, marker and exact words (it never computes a hash of a current statement), and otherwise say “not in the record.” Tests check its permissions and instructions, not reliable compliance by every model. Mechanical verification with the Node CLI is available without a model session. The demo tests run the recorded CLI workflow, not a live end-to-end model review or a timed human session.[^access]

## 8. Reproducing the measurements

The following commands ran on 1 October 2026 in an isolated checkout whose HEAD and `refs/heads/main` both named `4b382f3445fa127406cb30950b3b040138c5bcdb`. They measure that main revision, not later changes to main.

```sh
# From the repository root:
node --test plugins/placet-research/test/*.test.js
node verification/SQ-29/probe-perimeter.js
```

The test runner reported **306 passed, 0 failed, 0 skipped**, exit 0. The perimeter command exited 0 and printed **41 rows: 38 DENY, 3 ALLOW** (M17, M27 and M28 allowed). This is an observational probe, not 41 successful security assertions: M27 is the known sealed-choice bypass, and M28 creates the link whose later writes M29 and M30 deny. These counts come from this run, not the older counts in design documents. Named assertions supporting the claims are cited below.

## 9. Two people and one sealed log

### Names and session entries

Every new entry carries `**By:** <name>`, from the user-wide name setting or,
if unset, `git config user.name`. Old entries without it read as "unknown".
`By` is a statement, not proof: whoever holds the key can write any name. The
name is part of the body, which was already under seal. The seal formula has
not changed, so existing seals remain valid.[^by]

`SESSION` and `MERGE` are the two new kinds. `session start "<occasion>"`
writes a SESSION marker; the session lasts until the next marker or the end of
the log. `merge-log` writes MERGE to record moved or omitted entries. The
ordinary `log` command cannot write either kind. Review and accept ignore them
when computing acceptance cover, stale acceptances and open checks; both kinds
still participate in chain verification.[^kinds]

### Merge algorithm

The CLI reads ours from git stage 2 and theirs from stage 3 during a merge
conflict on the log. It refuses a rebase, where those roles are swapped. The
pure merge in `hooks/lib/merge.js` follows these steps:[^merge]

1. Verify both chains under our key; refuse a missing key or broken chain, and require theirs to be verified, not merely unbroken.
2. Find the shared prefix by sequence and seal for sealed entries; the text above the first entry and shared unsealed entries must match byte for byte.
3. If one log is a prefix of the other, keep the longer log unchanged, without a MERGE entry.
4. Otherwise keep theirs unchanged, then renumber and re-seal our divergent copies after it; rewrite `Supersedes` and `Open at acceptance` references through the same map.
5. Append a sealed MERGE entry naming the incoming commit and the moves or omissions, verify the result, and write it only if verification succeeds.

Re-sealing moved copies is possible because both clones hold the same project
key. Their dates, kinds, refs, text hashes and names stay the same; only the
sequence, mapped reference fields and seals change. The MERGE entry records
the moves. The original entries remain in git history. This is a consistent
new chain under a shared key, not proof of an independent author's identity.
Both clones must run 0.5; an incoming log without verifiable seals is refused.
The command does not merge the canvas, stage files or commit.

Moving an acceptance after the other clone's newly opened check would falsely
close that check, so the merge refuses without writing. After aborting and
pulling again without rebase, `merge-log --skip-decision <n>` leaves that one
DECISION out of the moved copies and records the omission. It refuses a skip
that would leave a dangling reference. The canvas may still have an
`[accepted]` marker: the person resets it by hand after merging, reads the
check, and accepts again. [Section 10](#10-two-people-terminal-steps) gives
the terminal steps.[^merge]

### Guard boundaries and known limits

The guard allows the model to print `agenda` and `session protocol [<n>]` only
with no flags. Exports with `--out`, and `name`, `session start`, `merge-log`,
`key` and `join`, are human steps. Tool calls naming a path ending in
`.seal.key` are refused, including reads.[^two-person-guard]

The guard does not see exported key-file names built at run time or
whole-directory reads that do not name the key file.

A later merge that moves an earlier MERGE entry leaves the old entry numbers
in that entry's narrative text stale; only the two reference fields above are
rewritten.

## 10. Two people: terminal steps

These are the steps §9 describes, as a person types them.

A researcher and supervisor can work on one canvas at one machine or in two git
clones, including remotely. The log records both people's entries. Both clones
must run placet-research 0.5 and share the project's sealing key. A clone still
on a pre-seal version cannot merge its log with a sealing clone: `merge-log`
refuses an incoming log that does not verify under the shared key.

For two clones, the key holder first exports the existing project key from the
original project, in their own terminal:

```sh
placet-research key export --out /path/outside-repo/project.seal.key
```

The output file must end in `.seal.key`. It is created with mode `0600`; the
command never prints the key. Hand over the file separately, not as plain-text
mail, not through a command line or transcript, and not through the repository.

The second person installs the plugin as described in
[Install](../plugins/placet-research/README.md#install), runs
`placet-research install-cli` once in Claude Code to make the terminal command
available, and clones the paper project. In their own terminal:

```sh
git clone <project-url> paper-project
cd paper-project
placet-research join --key-file /path/outside-repo/project.seal.key --name "B. Supervisor"
```

`join` checks the key against the log before copying it and sets the local name.
It runs `doctor` and tells you when the exported file can be deleted; it does
not delete it. Do not initialize a second key for a sealed log.

In each clone, make pulls use a merge rather than a rebase:

```sh
git config pull.rebase false
```

At one machine no key handover is needed. Before each person's writes, set
`placet-research name "A. Researcher"` or
`placet-research name "B. Supervisor"` as appropriate. The name setting is
user-wide, not per project; without it the CLI uses `git config user.name`.
`By` is a statement, not proof: whoever holds the key can write any name.

Before the session, export the agenda, which contains the view's "To talk about"
items. Then mark the start of the session:

```sh
placet-research agenda --out agenda.md
placet-research session start "Supervision on the study framing"
```

After the session, export its protocol:

```sh
placet-research session protocol --out protocol.md
```

This selects the latest session. To select an earlier one, put its SESSION entry
number after `protocol`, for example `placet-research session protocol 12`.
A session runs until the next SESSION marker or the end of the log; there is no
end command. People send the agenda and protocol themselves.

When a pull conflicts on `research/decisions.md`, run the following inside that
merge, not during a rebase:

```sh
placet-research merge-log
git add research/decisions.md
git commit
```

Resolve any other conflicts before committing. `merge-log` keeps the other
clone's log unchanged and moves your divergent entries after it, renumbered and
re-sealed. It records the moves in a MERGE entry. It handles only the log; git
handles `canvas.md` and other files. The text above the first entry and all
shared unsealed entries must match byte for byte.

A merge is refused if moving your acceptance after a check the other clone
opened would make that unseen check read as closed. Nothing is written. Follow
the refusal's entry number: abort with `git merge --abort`, pull again with
`git pull --no-rebase`, then run `placet-research merge-log --skip-decision <n>`.
For example, `placet-research merge-log --skip-decision 12` leaves out DECISION
12; do not put `#` before the number in a shell command. The omitted entry stays
in git history and the MERGE entry records it. Stage and commit as above.
The statement in `canvas.md` may still read `[accepted]`: reset its marker by
hand to its previous non-accepted marker after the merge, then accept it again
with `placet-research accept <n.m> --explained "<your sentence>"` after reading
the other person's check. The tool does not reset the canvas marker for you.

These setup and writing steps belong to people: the guard refuses model calls
to `name`, `key`, `join`, `session start` and `merge-log`, and reads or writes
naming a path ending in `.seal.key`. The model may run `agenda` and
`session protocol [<n>]` only without any flag. The `--out` exports above are
human steps too.

## 11. The construct glossary and the literature note

### Construct glossary

A project may keep `research/glossary.md` beside the canvas: one entry per
construct, with its term, aliases, definition, a local origin, and the
distinctions from neighbouring constructs. A canvas statement cites an entry as
`src: glossary.md#felt-safety`; a manuscript links it as
`[felt safety](research/glossary.md#felt-safety)`. Agents propose entries and
never accept them. The researcher accepts one with
`/placet-research:glossary-accept <id> --explained "<their sentence>"`, and the
sealed decision log binds that entry's payload, so a later change to a
definition is reported as stale rather than silently inherited by what cites
it. `review` adds a `Glossary mechanics` group for entry structure and
provenance, declared canvas and manuscript coverage, a lexical cross-check, and
accepted-text stability. It cannot judge whether a definition is the right one
for the study, and says so.

### Literature note

A literature note is drafted from one local paper, and what it produces is a
proposal before it is anything else. A page map binds each printed page of the
PDF to the physical page it was read from, so a quotation's printed-page locator
can be checked at all. The drafting request goes through an already approved
local gateway route, and before any note is saved, every quotation is compared
against the page the note claims — wording only, as a contiguous sequence of
words, with typographic variants folded and word boundaries kept intact. A
passage from another page, one invented word, a reversed run, or a quotation
form the gate cannot read word for word refuses the note, and a note with no
quotations does not pass either.

```
This check covers only verbatim wording on the claimed printed page. It does not
verify paraphrase, numbers or attribution, and it does not accept a research
claim. Project relevance and transfer judgments remain [proposed] for human
review.
```

`/placet-research:literature-note` walks a researcher through the sequence, and
[the plugin reference](../plugins/placet-research/references/literature-note.md)
documents the commands, the exit codes and a walkthrough on an invented paper.
No source PDF or extracted text ships with the plugin, and no note-acceptance
ledger exists: an idea the note raises becomes a canvas proposal through the
canvas skill, which the researcher then accepts or not.

## 12. Design notes

### A contract, not a path

The contract is **"a paper project repo."** Where that repo lives is
configuration.

The plugin must not hard-wire any root — least of all its author's local
convention. It ships through Toolshed to other researchers, and they do not have
that root. Toolshed stands in the same relationship to its own author's
directories.

A repository counts as a paper project when it contains `research/canvas.md`.
Nothing else. In any other repository the plugin stays silent, except that a
command or tool call naming the `research/` location is still judged there.

### Where the rules come from

The harness's question set is derived from published methodological and
craft literature — the AMJ Management Research Canvas, the seven-part
*Publishing in AMJ* series, the MIS Quarterly editorial on phenomenon-focused
problematization, and two JAIS pieces on writing. Full references in
[REFERENCES.md](../REFERENCES.md).

The plugin does not ship these texts. It encodes its own question set, modelled
on them and citing them, and points at a local full-text collection through
`PLACET_RESEARCH_LIBRARY`.

## 13. Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PLACET_RESEARCH_DIR` | state directory inside the paper repo | `research/` |
| `PLACET_RESEARCH_LIBRARY` | local full-text collection of the cited works | unset |
| `PLACET_RESEARCH_STATE_DIR` | session ledger and the decision log's sealing key, outside the paper repo | `~/.claude/placet-research` |

Zotero is one option for the library: set `PLACET_RESEARCH_LIBRARY` to the
`storage` subfolder of its data directory and use `<key>/<filename>` as the
`libraryPointer` for a stored PDF.

The genre profile is not an environment variable — it is named in the canvas
frontmatter (`profile: is-qualitative`) so it travels with the project.

## 14. Releasing

    node scripts/release.js <version> "<summary>" [--dry-run] [--trailer "<line>"] [--accept-denies]

Run it from a clean `main`. It refuses unless the version is semver and greater
than the one in both manifests, runs the plugin tests, the perimeter probe and
the guard's false-positive replay (`verification/probes/probe-benign.js`) over
the newest harvest in `verification/local/`, and only then sets the version in
`.claude-plugin/marketplace.json` (twice) and
`plugins/placet-research/.claude-plugin/plugin.json`, commits
`Release <version>: <summary>`, pushes `main`, and updates the installed plugin.

The replay's DENY count is compared with the last release's, kept in the
gitignored `verification/local/release-baseline.json`; more DENYs stop the
release unless `--accept-denies` is given. Without a harvest the script refuses
and names the command to make one
(`node verification/probes/probe-benign.js --harvest`). `--dry-run` runs the
checks and prints the remaining commands without running them.

## Evidence references

Paths below are repository-relative; `P` means `plugins/placet-research/`. For sections 1–8, test names refer to tests executed, with none skipped, in the measured 0.4.1 suite above. The 0.5 source references are listed separately at the end.

[^demo]: `P/test/demo.test.js:174-185`, test “every console block of the walkthrough runs in README order and prints what the README shows”; `:234-277`, tests “the three recorded framings are proposals and findings only, tagged with sources that exist” and “the reviewer's copy verifies only under the released key, and a changed byte is named”. The test uses the recorded workflow; no human timing was run for this appendix.

[^state]: `P/hooks/lib/project.js:19-54`; `P/hooks/lib/state.js:19-54` loads the key by root; `P/test/variants.test.js`, test “init --variant creates a full state directory with variant and lens in the frontmatter”.

[^paths]: `P/bin/placet-research.js:104-141,201-203,317-327,361-367,419`; `P/bin/canvas-serve.js:146-155`; `P/hooks/lib/accept.js:43-109`; `P/hooks/lib/choose.js:62-131`; `P/hooks/lib/log.js:49-72`. Tests: `P/test/lib-write.test.js`, “acceptStatement writes the same canvas and decisions.md bytes as placet-research accept”; `P/test/serve.test.js`, “POST /api/choose writes what the CLI choose writes, and takes the same checks as accept”.

[^key]: `P/hooks/lib/seal.js:22-76`; `P/hooks/lib/ledger.js:11-32`; `P/test/seal.test.js`, test “createKey writes 32 random bytes under the harness state root with mode 0600 and never overwrites”.

[^seal]: `P/hooks/lib/seal.js:79-109,153-180`; `P/hooks/lib/decisions.js:94-103`. Tests in `P/test/seal.test.js`: “sealOf is 16 hex of an HMAC over the previous seal and the canonical entry, reflow-insensitive in the body” and “sealedAppend chains the first sealed entry onto the hash of everything before it and every later one onto the previous seal”.

[^review]: `P/hooks/lib/seal.js:124-166`; `P/hooks/lib/review.js:18-99,130-143`. `P/test/cli.test.js`, test “review reports a verified, an unverifiable-here and a broken ledger, and names the cover an unlogged acceptance lacks”.

[^guard]: `P/hooks/hooks.json:15-27`; `P/hooks/guard-promotion.js:116-184,235-246,1822-1827`; `P/skills/check/SKILL.md`. `P/test/guard-promotion.test.js`, tests “editing, adding and removing proposals is allowed”, “transcribing a new [stated] statement is allowed; tagging a proposal is allowed”, and “creating an [accepted] statement is denied”; `P/test/skills.test.js`, “check: its only write instruction is log DISCOVERY "<n.m> check"”.

[^perimeter]: `P/hooks/guard-promotion.js:1728-1736,2117-2120,2240-2254,2361-2378`; command `node verification/SQ-29/probe-perimeter.js`, rows M1-M16, M19-M26, M29-M40 and M18. `P/test/guard-promotion.test.js`, test “SQ-145: a sed script that can write or run is refused however sed is told to run it”. Fixes are included in main: `9d840c6` (SQ-145/SQ-148 integration) and `4b382f3` (0.4.1 release).

[^limits]: Command `node verification/SQ-29/probe-perimeter.js`, M27 output: `ALLOW ... chain under the session key: verified | sealed framing chosen: alpha #1`. The later-call script boundary is documented in `docs/superpowers/specs/2026-09-15-placet-research-mvp-design.md:832-844`; it was not separately re-probed for this appendix.

[^accept]: `P/hooks/lib/accept.js:43-57,95-109`; `P/hooks/lib/decisions.js:94-103`; `P/test/lib-write.test.js`, test “an accept without an explanation is refused as explanation-required, and nothing is written”.

[^checks]: `P/hooks/lib/accept.js:90-119`; `P/test/lib-write.test.js:168-213`, test “with open check questions, the CLI and the library write the same bytes and record exactly the open checks”. It asserts `[4, 5]`, then `[9]` after a decision closes the earlier checks, and absence of the labelled line when no checks remain.

[^advisory]: `P/hooks/lib/accept.js:58-93`; `P/bin/canvas-serve.js:146-155`; `P/skills/check/SKILL.md`; `P/hooks/lib/decisions.js:18-38`. `P/test/view.test.js`, test “Accept dialog: the explanation is required, open checks are listed with their #seq, and the button says Accept anyway”; the open-check byte-identity test above exercises successful acceptance despite checks.

[^variants]: `P/skills/canvas/SKILL.md:79-119`; `P/bin/placet-research.js:104-141`; `P/test/variants.test.js`, tests “status, review and log take --variant and read and write only that variant” and “accept works on the main canvas only”; `P/test/view.test.js`, “Framings: one column per variant, headed by name and lens, with differing fields marked and identical ones faded”.

[^choose]: `P/hooks/lib/choose.js:62-142`; `P/hooks/lib/hash.js:5-10`; `P/hooks/lib/review.js:58-71`. `P/test/variants.test.js:166-196`, “choose copies the variant's statements into the main canvas and seals a framing DECISION in the main log”; tests “choose refuses while the main canvas holds a [stated] statement, names it, and writes nothing” and “mechanicalReview does not count a framing-chosen DECISION as an acceptance”.

[^external]: `P/bin/placet-research.js:233-244`; `P/hooks/lib/seal.js:51-63`; `P/test/cli.test.js`, tests “a record received from elsewhere verifies with --key <file>, and a wrong key reads as broken”, “--key refuses a file it cannot read, one that is not 32 bytes, and a missing path”, and “init in a clone whose log is already sealed creates no key, and review then says unverifiable rather than broken”. Key handover is described in `P/README.md:82-107`.

[^anchor]: `P/hooks/lib/seal.js:83-109`; `P/bin/placet-research.js:301`; `P/test/cli.test.js`, test “the anchor line is stable for an unchanged record and moves when a byte moves”; `P/test/demo.test.js:257-277` asserts the same anchor across author, keyless reviewer and keyed reviewer, and a different anchor after tampering. Re-sealing by a key holder follows from the HMAC input and the absence of any external authority in verification; that scenario was not separately executed here.

[^identity]: `P/hooks/lib/decisions.js:9,18-38,94-103` (entry fields, no actor); `P/hooks/lib/seal.js:99-109` (symmetric HMAC, no Ed25519); `P/hooks/lib/log.js:9-11` (UTC day date); `P/hooks/lib/accept.js:50-53` (nonempty explanation check). Stage 2 names deferred work in the proposal, not a shipped identity mechanism.

[^access]: `P/skills/record-review/SKILL.md` and `P/skills/check/SKILL.md`; `P/test/skills.test.js`, tests “record-review grants no Write, Edit or NotebookEdit and no broad Bash” and “record-review is invoked by the researcher, cites, and says "not in the record"”; `P/bin/placet-research.js:1-20` (Node CLI imports); `P/test/demo.test.js:174-185,257-277` (recorded CLI verification). No live model-compliance trial was run for this appendix.

The following references concern the 0.5 sources at `01e6d57`, not the 0.4.1 measurements above.

[^by]: `P/hooks/lib/identity.js`, `P/hooks/lib/decisions.js`, `P/hooks/lib/seal.js`. Assertions: `P/test/identity.test.js`, “readName: the file first, then git config user.name, then a refusal naming the command”; `P/test/decisions.test.js`, “By is a field: formatEntry writes it first, parseDecisions reads it back, old entries read null”; `P/test/seal.test.js`, “a seal over an entry with By recomputes, and changing the name breaks it”.

[^kinds]: `P/hooks/lib/session.js`, `P/hooks/lib/review.js`, `P/hooks/lib/accept.js`, `P/hooks/lib/decisions.js`. Assertions: `P/test/session.test.js`, “startSession appends one sealed SESSION entry: the occasion as ref, the name as By”; `P/test/decisions.test.js`, “SESSION and MERGE parse, format and verify in one chain”. Review considers DECISIONs for acceptance cover; `openChecks` in `accept.js` considers DECISIONs and DISCOVERY checks, not markers.

[^merge]: `P/hooks/lib/merge.js`, `P/bin/placet-research.js` (`mergeLog`). Assertions: `P/test/merge.test.js`, “divergence: theirs unchanged, ours renumbered and re-sealed after it, references rewritten, one MERGE” and “legacy bytes before the first seal compare exactly, even when theirs verifies”; `P/test/merge-log.test.js`, “a pushed copy that replaced a sealed entry with an unsealed one is refused, and nothing is written” and “the check refusal names --skip-decision, and the skip drops the acceptance and points at the marker”. `rewriteRefs` rewrites only `Supersedes` and `Open at acceptance`, leaving narrative text unchanged, including an earlier MERGE entry's numbers.

[^two-person-guard]: `P/hooks/guard-promotion.js` (`printsOnly`, `keyFileVerdict`). Assertions: `P/test/guard-promotion.test.js`, “0.5 subcommands: agenda and session protocol read; every writing one is the person's”, “SQ-185: agenda and session protocol pass only as literal words without flags” and “SQ-185: a key file is denied under every spelling the guard can read”. These cover visible spellings, not key-file names constructed at run time or unnamed whole-directory reads.
