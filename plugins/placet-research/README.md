# placet-research

A research harness for paper projects. It keeps the framing of a study — the
nine elements of the AMJ Management Research Canvas (Dorobantu, Gruber,
Ravasi & Wellman, 2024, *Academy of Management Journal* 67(5), 1163–1174,
<https://doi.org/10.5465/amj.2024.4005>) — as version-controlled
state inside the paper's own repository, and it enforces one line: **an agent
may propose, but only the researcher accepts.**

## Install

From Claude Code:

    /plugin marketplace add anonymous-owner/placet-research
    /plugin install placet-research@placet-research

Or from a local checkout: `/plugin marketplace add /path/to/placet-research`.

### Private repository

This repository is private, so your GitHub account needs an invitation, and git
needs a credential Claude Code can use without prompting: either `gh auth login`
followed by `gh auth setup-git`, or an SSH key loaded in ssh-agent with
`github.com` in your `known_hosts`. Claude Code tries SSH first, then HTTPS. See
"Grant access to a private marketplace" in
<https://code.claude.com/docs/en/plugins/host-marketplace>.

Run `placet-research doctor` first: it checks that the plugin is enabled in
your settings, that the promotion guard is actually denying what it should, that
this project has its sealing key, that this machine has a name to write into the
log, and that it can run the CLI from a terminal, and prints one line per
problem it finds. The name comes from `placet-research name "<your name>"`, or
from `git config user.name` if you never set one. It reads settings files
rather than Claude Code's own running state, so it cannot see whether a Claude
Code process you already have open actually loaded the plugin — restart the
session after installing or enabling it.

Then run `placet-research install-cli` once. Claude Code puts the plugin's
`bin/` directory on the Bash tool's PATH only, so the bare command works inside
a session and nowhere else. `install-cli` writes a small `placet-research` shim
into `~/.local/bin` (or `--dir <path>`) that finds the plugin's current install
path at every run — plugin updates leave it working — and prints the one `PATH`
line to add if that directory is not one your terminal reads. It edits no shell
rc file, and it refuses to overwrite a file that is not its own shim.

In any repository without `research/canvas.md` the plugin stays silent, with one
exception: a command or tool call that names the `research/` location is still
judged there, because creating or removing that directory is how the state
comes into being.

## Use

In a paper project's repository:

1. `/placet-research:canvas` — creates `research/canvas.md` and
   `research/decisions.md` if they do not exist, then works through the
   elements with you. Everything it writes is `[proposed]`, `[tentative]`, or
   a `[stated]` transcription of your words.
2. `/placet-research:accept 3.1 --explained "<your sentence>"` — you accept a
   statement and say in one sentence of your own what you accept and why it
   holds; without that sentence nothing is accepted. The CLI promotes it to
   `[accepted]`, appends a sealed decision-log entry carrying a hash of the
   text and your sentence, and refuses if an element it depends on is not
   accepted yet.
3. `/placet-research:canvas-review` — argues against the canvas: gaps,
   contradictions between elements, unmet dependencies, claims without a
   source, acceptances whose text has since changed, and the state of the
   decision log's seal chain.

At every session start the plugin injects a short summary: which elements are
empty, which hold only proposals, which dependencies are violated, which
decisions you have not seen yet, and whether the decision log verifies.

### On a clone that is not the machine the project started on

The sealing key of the decision log lives outside the repository and is not
committed, so a fresh clone has none and the log reads as *unverifiable here*.
`placet-research init` leaves such a log alone: while it already carries seals
init creates no key, prints the path the key belongs at, and changes nothing.
Entries sealed elsewhere stay unverifiable on this machine; that is the honest
answer, and the review says so rather than reporting a problem.

To write sealed entries on this clone, copy `seal.key` from the machine the
project started on to that printed path. Only a log that carries no seal yet —
empty, or written before the seal existed — gets a key from
`init --project <slug> --mode <mode>` here.

### Verifying a record you received

You do not have to take a record on trust, and you do not need the machine that
wrote it. The authors send you two things: the sealing key as a file, and the
anchor they published for the record. Then, in your own checkout:

    placet-research review --key <key file>

`--key` verifies with the key you were given instead of the one this machine
would read, and `status` takes it the same way. A key file that cannot be read,
or that does not hold 32 bytes, is refused in one line before anything is
judged. The file is a secret, so keep it out of the repository as the authors
keep their `seal.key` out. The report carries the anchor of the record in front
of you:

    ## Anchor
    Anchor: last seal 9c53940787bd2e3a, maxSeq 4, decisions.md sha256 a388c0f0…

Compare that line with the one the authors published. The same anchor is the
same record: every seal recomputes under their key, and not a byte of
`decisions.md` has moved since they wrote it down.

The limit is worth stating plainly. The authors hold the key, so an anchor
printed today would match a rewritten log too — what detects a rewrite is an
anchor published *earlier*: a git tag, the submitted manuscript, a mail. Keep
that copy, because your comparison is against it. And a seal proves a machine
that held the key, never which person used it.

## Walkthrough: the three capabilities on a public dataset

This walks through what the harness does beyond holding a canvas, on interviews
anyone can download:

1. **A framing multiverse.** The model writes the same study under several
   lenses. You compare the framings side by side and choose one. The ones you
   set aside stay in the record, and the log says why.
2. **Accept with understanding.** Every accept carries a sentence in your own
   words. The model can ask questions before you accept; you may accept with
   some still open, and the log records which ones were.
3. **Review the record.** A read-only reviewer answers from the record and
   nothing else, and anyone holding a released key and the published anchor can
   check the record on their own machine.

The material is 13 de-identified interviews with senior software developers
about working with AI coding assistants (Hristova, Gala Scaramuzza, Popovici,
Burelli & Tell, PROFES 2026), Zenodo record 22893731, CC BY 4.0. The canvases
below show what a framing under each lens could say. They are not the authors'
framing of their own study, and the authors neither wrote nor checked them. The pinned
version, what the later versions hold, and the attribution are in
`examples/ai-assistants-interviews/README.md`.

A replacement is ready alongside it: [big-data communication amid COVID-19](../../examples/big-data-communication/README.md), Zenodo record 6344804 (CC BY 4.0). To switch, start a fresh project and run that example's `fetch.js` and `recorded.js` in place of the two paths below, then follow its `credibility` variant CLI steps; the primary walkthrough's interview-specific claims and printed lines do not transfer. The replacement README gives the pinned PDFs, page-citation rule, attribution and commands.

Three steps are yours alone: `choose`, `accept`, and `serve`. The model never
runs them and the guard denies them to it. Steps marked *Claude* are what the
model does in a Claude Code session; the commands it runs are shown, so you can
see what lands in the record. Blocks that start with `$` and show output are the
ones the demo test runs, in this order, and compares with what is printed here;
a long output is cut with `…`, and a seal or hash that differs on every run is
shown as `<seal>`, `<sha256>` or `<hash>`.

`~/placet-research` below is your clone of this repository, and
`placet-research` is the command `install-cli` put on your terminal's PATH
(see Install).

### 1. Get the interviews and start a project

```sh
mkdir ~/rh-demo && cd ~/rh-demo
git init
node ~/placet-research/examples/ai-assistants-interviews/fetch.js
```

`fetch.js` downloads the 13 interviews and the record's own README from the
pinned Zenodo version into `interviews/`, prints one `ok` line per file, and
writes a file only if its size and sha256 match the values pinned in
`sources.json`. It ends with `14 files match the pinned record`.

```console
$ placet-research init --project ai-assistants-interviews --mode import --title "How senior developers decide whether to rely on an AI assistant"
Created research/canvas.md, research/decisions.md and research/.gitattributes (profile is-qualitative, mode import).
Sealing key created at <key file> (mode 0600, outside the repository). It seals every entry of the decision log written on this machine; it is never committed.
Every element is empty. That is the correct starting state.
```

Note the key's path: `<key file>` above is what you hand a reviewer in step 7.

### 2. The multiverse (Claude)

In Claude Code, in `~/rh-demo`, give the `canvas` skill three lenses and the
interviews:

```text
/placet-research:canvas
Multiverse mode over interviews/. Three lenses:
workflow — where in a task the assistant is brought in, and what makes a developer hand work over to it
trust — what a developer does before relying on what the assistant produced
role — what the developer takes the assistant to be, and what that makes of the developer's own work
```

The skill tells Claude to start one subagent per lens. Each runs
`placet-research init --variant <name> --lens "<text>"`, fills its own
`research/variants/<name>/canvas.md` from the interviews with `[proposed]` and
`[tentative]` statements that carry `src:` tags, and runs
`placet-research review --variant <name>`. The skill tells it to stop there and
not rank the framings; it could not choose one anyway, because the guard denies
`choose` to the model. The canvases a live run writes differ from run to run, so
the rest of this walkthrough uses a recorded run, written by hand from the
interviews and shipped in `examples/ai-assistants-interviews/recorded/`. This
script runs the same `init --variant` calls and writes those statements:

```console
$ node ~/placet-research/examples/ai-assistants-interviews/recorded.js
Wrote the recorded statements into research/variants/workflow/canvas.md (lens: where in a task the assistant is brought in, and what makes a developer hand work over to it).
Wrote the recorded statements into research/variants/trust/canvas.md (lens: what a developer does before relying on what the assistant produced).
Wrote the recorded statements into research/variants/role/canvas.md (lens: what the developer takes the assistant to be, and what that makes of the developer's own work).
```

Each variant is a full state directory with its own canvas and its own log, and
holds four statements: under 1.1, 3.1, 7.1 and 9.1. The mechanical review of one
of them:

```console
$ placet-research review --variant trust
# Mechanical review — variant trust (lens: what a developer does before relying on what the assistant produced)
…
## Open elements (proposals only)
1, 3, 7, 9
…
## Decision log
empty: no entries yet
…
```

### 3. Compare and choose (yours)

The view opens on the poster; this capture shows a later state of the example,
with the trust framing chosen, the puzzle accepted, and the research question
recorded as said.

![The poster shows the paper's nine fields with author statements and model proposals.](../../docs/media/poster.png)

Run `placet-research serve` in your own terminal. A **Framings** tab appears
while the project holds variants: one column per framing, headed by its name and
lens, one row per field. A field whose statements differ between framings is
tagged "Differs"; a field that reads the same in every framing is faded.
**Choose this framing** asks for your reason and shows what you are setting
aside, prefilled from the other framings and their lenses, as the text that will
be logged; you can edit it. Or choose in the terminal, which is the same act
through the same code. Do one of the two, not both:

```console
$ placet-research choose trust --why "The interview guide's last section asks how outputs are validated, so this is the framing the material can answer."
Chose framing trust (lens: what a developer does before relying on what the assistant produced): 4 statements copied into research/canvas.md.
Logged as #1 with text <hash>, sealed <seal>. Rejected: role (lens: what the developer takes the assistant to be, and what that makes of the developer's own work); workflow (lens: where in a task the assistant is brought in, and what makes a developer hand work over to it)
```

The trust framing's statements are now the main canvas, still `[proposed]` and
`[tentative]`. The entry in `research/decisions.md` carries your reason and what
you set aside, and the two other variants stay under `research/variants/` as the
record of what was compared. `choose` refuses while the main canvas holds an
`[accepted]` or a `[stated]` statement, so the choice comes before anything is
accepted.

### 4. Check one statement (Claude)

Before you accept 3.1, ask the model to read it:

```text
/placet-research:check 3.1
```

The `check` skill tells Claude to read the statement, its tags and the sources
they name, and to write each open question as a DISCOVERY entry. It is advisory:
the skill forbids accepting, editing, and calling a statement ready. What it runs
is this (the question you get will differ; the recorded one is mine):

```console
$ placet-research log DISCOVERY "3.1 check" --body "3.1 speaks of senior developers in general; the dataset README says all 13 participants have more than five years of experience and use an assistant daily. Does the question mean these 13 or senior developers in general?"
Logged #2 DISCOVERY 3.1 check, sealed <seal>.
```

### 5. Accept with an explanation, despite an open question (yours)

An accept without your explanation is refused:

```console refused
$ placet-research accept 1.1
Accepting 1.1 needs your explanation: one sentence, in your own words, of what you accept and why it holds (--explained <text>). Nothing is accepted.
```

Write your own sentence; the ones below are mine. Element 3 depends on element 1
in the profile's graph, so 1.1 goes first:

```console
$ placet-research accept 1.1 --explained "I accept that these developers say they do not take the assistant's output on trust; what they do instead is the puzzle."
Accepted 1.1 (was [proposed]): Developers who use an AI assistant every day say they still do not take its output on trust. The puzzle is what they do instead.
Logged as #3 with text <hash>, sealed <seal>.
```

Now 3.1, with the check question still open. In the view, **Accept…** opens a
dialog that shows the statement, asks "In your own words, why does this hold?",
will not send an empty answer, and lists the open check questions with the `#seq`
of the entry that asked each; with some open, the button reads **Accept anyway**.
In the terminal:

```console
$ placet-research accept 3.1 --explained "The question is the one the interview guide's last section asks; I accept it knowing it may name these 13 rather than senior developers in general."
Accepted 3.1 (was [proposed]): How do senior developers decide whether to rely on what an AI assistant produced?
Accepted with open check questions: #2.
Logged as #4 with text <hash>, sealed <seal>.
```

The question did not block the accept, and the entry says it was open. The
session summary now:

```console
$ placet-research status
placet-research · paper project "ai-assistants-interviews" · profile is-qualitative · mode import
Elements: 1 accepted · 2 empty · 3 accepted · 4 empty · 5 empty · 6 empty · 7 open (1 proposal) · 8 empty · 9 open (1 proposal)
Empty: 2, 4, 5, 6, 8 · Open (proposals only): 7, 9
Dependency violations: none · Stale acceptances: none · Ledger: verified
…
```

The framing can no longer be swapped out from under the accepted statements:

```console refused
$ placet-research choose workflow --why "Second thoughts."
The main canvas already holds 2 [accepted] statements (1.1, 3.1); a framing is chosen before anything is accepted, so nothing is changed.
```

### 6. Review the record (Claude, read-only)

Open a new Claude Code session in `~/rh-demo` and run the reviewer:

```text
/placet-research:record-review
```

The skill has no Write, no Edit and no command that changes state. It is told to
answer only from the canvas, the decision log, the mechanical review and git
read verbs, to cite a log entry by `#seq` (with the text hash it recorded) and a
statement by `n.m`, its marker and its exact words, to keep a proposal apart
from an accepted statement, and to say "not in the record" when the record does
not answer. Ask it two things a reviewer would ask:

```text
Which framing did the authors choose, and what did they set aside?
Was anything accepted while a question about it was still open?
```

The record holds the answers in three kinds of line, which the reviewer cites:

```console
$ grep -E '^\*\*(Rejected|Explained|Open at acceptance):\*\*' research/decisions.md
**Rejected:** role (lens: …); workflow (lens: …)
**Explained:** I accept that these developers say they do not take the assistant's output on trust; what they do instead is the puzzle.
**Explained:** The question is the one the interview guide's last section asks; I accept it knowing it may name these 13 rather than senior developers in general.
**Open at acceptance:** #2
```

The first question is answered by entry #1 (what was set aside, and your
reason); the second by entry #4, which names #2 as open at acceptance. A third
question, such as whether a pilot study was run, is not in the record, and the
reviewer's answer is "not in the record".

### 7. Verify the record on another machine

The reviewer needs no access to yours. Send them the `research/` folder, the
key file from step 1, and the anchor you published earlier (see "Verifying a
record you received" above). Their checkout holds a copy of `research/` and no
key of its own; in it, `/placet-research:record-review --key <key file>` runs
the reviewer of step 6 against the released key. The review it opens with, first
without the key and then with it:

```console clone
$ placet-research review
…
## Decision log
unverifiable here: no sealing key on this machine …
…
## Anchor
Anchor: last seal <seal>, maxSeq 4, decisions.md sha256 <sha256>
…
```

```console clone
$ placet-research review --key <key file>
…
## Decision log
verified: 4 sealed entries

## Anchor
Anchor: last seal <seal>, maxSeq 4, decisions.md sha256 <sha256>
…
```

Both runs print the same `Anchor:` line as yours. If anyone changes a byte of
`decisions.md` after the key was released, the review under `--key` says which
entry no longer verifies and names `BROKEN`, and the anchor differs from the
published one. What this does not show: a seal proves a machine that held the
key, not which person used it, and an anchor printed now cannot tell a rewrite by
the key's holder from the original; only a copy published earlier can.

## Feedback

Report problems as GitHub Issues: *friction* when something took longer than it
should have or confused you, *bug* when a result is wrong or something crashes.
[Open an issue](https://github.com/anonymous-owner/placet-research/issues/new/choose)
and the template asks for the command, what happened, and your plugin version.

Issues are public, so keep unpublished canvas and decision text out of them.

## The commands

The skills above are the normal way in. The CLI underneath them is
`node "${CLAUDE_PLUGIN_ROOT}/bin/placet-research.js"` — the same program
`install-cli` puts on your terminal's PATH under the bare name:

| Command | What it does |
|---|---|
| `init --project <slug> --mode brainstorming\|seed\|import [--outlet <name>] [--profile <id>]` | creates the canvas, the log and the sealing key |
| `init --variant <name> --lens <text>` | creates one framing of the project under its own lens, a state directory of its own |
| `status [--variant <name>] [--key <file>]` | the summary the session hook injects |
| `review [--variant <name>] [--key <file>]` | the mechanical half of `canvas-review`, and the anchor of the log |
| `choose <name> --why <text> [--rejected <text>]` | the researcher's act: makes one variant the main canvas and logs what was set aside; the model may not run it |
| `accept <n.m> --explained <text> [--match <substring>] [--why <text>] [--rejected <text>]` | the researcher's act, with a sentence in their own words; the model may not run it |
| `glossary show <id>` | prints a glossary entry's payload and binding digest for acceptance |
| `glossary accept <id> --hash <64hex> --explained <text> [--why <text>] [--rejected <text>]` | accepts a glossary entry against the digest from `glossary show`, with a sentence in the researcher's own words; the model may not run it |
| `log DISCOVERY\|CONSTRAINT <ref> --body <text> [--why <text>] [--supersedes <n>] [--variant <name>]` | appends a sealed entry — how the model records a finding or a check question |
| `title [<text>]` | sets the paper's title in the canvas frontmatter, or prints the one it has |
| `profile [<id>]` | prints the current research profile, or changes it and logs a CONSTRAINT |
| `agenda` | prints the session's discussion agenda; the model may run it only without flags |
| `agenda --out <file>` | writes the agenda to a Markdown file; the model may not run it |
| `session start "<occasion>"` | appends a sealed session marker to the log; the model may not run it |
| `session protocol [<n>]` | prints the latest session's protocol, or the one starting at log entry `<n>`; the model may run it only without flags |
| `session protocol [<n>] --out <file>` | writes the session protocol to a Markdown file; the model may not run it |
| `name [<name>]` | prints or sets the local name carried by future log entries; the model may not run it |
| `key export --out <file>.seal.key` | exports the project's sealing key to a new file with mode `0600`, never to the terminal; the model may not run it |
| `join --key-file <file> --name "<name>"` | checks and imports a shared project key, sets the local name and runs `doctor`; the model may not run it |
| `merge-log [--skip-decision <n>]` | merges conflicting decision logs after `git pull --no-rebase`, optionally leaving out one decision; the model may not run it |
| `serve [--no-open]` | opens the session view in your browser; the model may not run it |
| `doctor` | checks that the plugin is enabled, that the old research-harness plugin is not running beside it, and that the guard denies what it should |
| `install-cli [--dir <path>]` | writes the terminal shim (default `~/.local/bin`) that `serve` needs outside Claude Code |

## Session view

    placet-research serve

Run this in your own terminal, not through Claude Code, and run
`placet-research install-cli` once there first: Claude Code puts the plugin's
`bin/` on the Bash tool's PATH only, and the bare `serve` command has to be one
your own shell can resolve. The guard refuses both
the `serve` subcommand and a direct run of `bin/canvas-serve.js`, because
starting the server is the researcher's act. It refuses to start at all
without a `research/canvas.md` already in place.

The command binds to `127.0.0.1` on a random port, opens a browser tab whose
URL carries a single-use code, and prints that same URL to your terminal in
case the browser does not open on its own. On load the view trades the code
for the write token, once. The token lives only in the server's memory and
the open tab; stop the server with Ctrl-C and it is gone. The terminal
prints `session code redeemed` with the time when that happens. If the view
says the link was already used, stop `serve` and start it again.

The view opens on the poster and reads like the paper's argument, not a form:

- the poster shows the whole paper on one screen, nine fields in argument
  order. Each field is a plain question with the first statement under it,
  written the way the authors would say it. Where a field has findings, a
  quiet line at the foot of its card ("2 things to talk about") opens the
  "To talk about" tab at that field;

  ![The poster shows the paper's nine fields with author statements and model proposals.](../../docs/media/poster.png)

- "To talk about" is where a meeting starts: the fields with something to
  discuss, and the questions nobody has answered yet;

  ![To talk about shows the open question about the study's participants above the unanswered canvas questions.](../../docs/media/to-talk-about.png)

- "History" lists what has been said and decided, in order;

  ![History shows the chosen framing, an open question, and the puzzle acceptance with its explanation and author.](../../docs/media/history.png)

- the element view, reached with "More" on a card, shows one field with all its
  statements as prose. A suggestion made by the model appears as an "Idea"
  note, sources appear as page numbers, and an open question says "Not
  answered yet".

  ![Field 3 shows the research question recorded as said, unanswered prompts, and an open discussion note.](../../docs/media/element.png)

The poster's large heading is the paper's title, from the `title:` line in the
canvas frontmatter, which `placet-research title "<text>"` sets; without one
it falls back to the project slug.

The markers, seals and `src:` paths stay in `canvas.md` and `decisions.md`;
the view just does not show them as codes.

From the view you can comment (it appears as a "To talk about" note and is
written as a DISCOVERY entry), set a statement to `[stated]`, and accept a
statement, through the same code the CLI calls, so the decision-log entry it
writes is byte-identical to a CLI accept. Statement text is not editable here
— that stays the CLI and `canvas-review`.

Print the page for a coauthor who wants a paper copy: the print stylesheet
puts the poster on its own A4 landscape page and hides the comment and accept
controls.

One limit worth stating plainly: a model given a browser-automation tool in
the same session could read the open tab and click through an accept itself.
Close the tab when you are done. And a model that reads your terminal or a
process listing in the second before the view loads, and redeems the code
first, takes the session; you then see the "already used" message instead of
a working view.

## What it enforces

A hook denies any write by the model that would create an `[accepted]`
statement, alter or remove a `[stated]` or `[accepted]` statement, promote a
proposal, rewrite a heading or the frontmatter, or write the decision log at
all. A commitment is the statement together with what gives it meaning: its
element, that element's title, its question, the question's text, its marker,
its text, and its evidence tags. Moving an accepted statement to another
element changes no bytes of it and is refused.

Shell access to the two state files is read-only, judged by lexing the command
rather than by matching strings in it. The harness's own state directory, which
holds the sealing key, is closed to every tool including reads. When the hook
cannot judge a write, it denies it and says why.

The decision log is tamper-evident: each entry carries a seal chained over its
own content and the seal before it, under a per-project key created by `init`,
mode 0600, outside the repository. An acceptance counts as logged only if its
entry verifies, so an entry planted outside the harness covers nothing and the
review names it. Entries written before the seal existed are reported once as
unverifiable, never as broken.

What it does not enforce, because it cannot: whether a `[stated]` transcription
is faithful, and whether a cited source actually supports a claim. The review
lists both for you. And the model runs as the same user you do, so no purely
local secret is beyond its reach — what the seal buys is that forging an entry
is no longer writing a line of Markdown, and that an unforged forgery is
visible.

## Files in your project

    research/
      canvas.md       nine elements, numbered questions, statements with markers
      glossary.md     construct definitions, each proposed or accepted
      decisions.md    append-only log: DECISION | CONSTRAINT | DISCOVERY | SESSION | MERGE, each sealed

Both belong in Git. The canvas is a record of framing; it cites material with
`src:` tags and never quotes it. The sealing key does not belong in Git and is
not written inside the repository.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PLACET_RESEARCH_DIR` | state directory inside the project | `research` |
| `PLACET_RESEARCH_LIBRARY` | local full-text copies of the cited editorials | unset |
| `PLACET_RESEARCH_STATE_DIR` | session ledger and sealing key, outside the paper | `~/.claude/placet-research` |

Zotero is one option for the library: set `PLACET_RESEARCH_LIBRARY` to the
`storage` subfolder of its data directory and use `<key>/<filename>` as the
`libraryPointer` for a stored PDF.

The genre profile is named in the canvas frontmatter (`profile: is-qualitative`).
Two profiles ship: `is-qualitative` (the default) and `is-quantitative` for
hypothesis-testing experiments and surveys. `placet-research profile` prints
the active one; `placet-research profile <id>` switches an existing canvas and
records the switch in the decision log. Under `is-quantitative`, the review
also reports findings logged before the hypotheses and the design were
accepted (`references/preregistration.md`). Others are a Markdown file each
under `references/profiles/` — contributions welcome.

## Where the questions come from

The question set is the plugin's own wording, modelled on the canvas by
Dorobantu, Gruber, Ravasi & Wellman (2024), read alongside the seven-part
*Publishing in AMJ* series and the MIS Quarterly editorial on phenomenon-focused
problematization. Full references in the repository's `REFERENCES.md`. None of
those texts ships with the plugin.

## Development

    cd plugins/placet-research
    node --test test/*.test.js

Plain Node, no dependencies, no build. Shared code is in `hooks/lib/`; both
hooks and the CLI require it by relative path.

When developing the plugin inside Claude Code, the guard deliberately refuses
`NAME=value` before a harness invocation. Run the command without the leading
assignment, or work from a shell outside Claude Code. This friction falls on
plugin contributors; researchers do not need the assignment because Claude Code
sets `CLAUDE_PLUGIN_ROOT`.
