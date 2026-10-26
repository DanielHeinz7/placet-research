# Changelog

Release notes for researchers using placet-research in Claude Code. Releases before 0.7.0 were called research-harness, and their notes keep that name.

## 0.7.0 (2026-10-26)

This release renames the plugin to placet-research and adds no new capability. It makes the decision log name the key it is sealed with, so a wrong key is caught even before the first entry, and it refuses research files with Windows line endings instead of misreading them. Most of the other work since 0.6.0 prepares the desktop app, Placet, which is still not distributed; those changes are listed separately at the end.

### Changed

- The plugin, its command line tool and its skills are now called placet-research: `placet-research status`, `/placet-research:canvas`, the folder `plugins/placet-research/` and environment variables beginning with `PLACET_RESEARCH_`. Remove the old plugin with `claude plugin uninstall research-harness@research-harness` before you install placet-research, so that only one guard runs, and run `install-cli` again for the new command name. The first time placet-research runs, it moves the folder `~/.claude/research-harness`, which holds each project’s sealing key, to `~/.claude/placet-research`, so existing decision logs keep verifying. Research projects themselves are unchanged.
- `init` writes a `Seal key: <16 hex>` line under the title of a new decision log. The value is a keyed hash of the project’s key and gives nothing away about the key itself. A key that does not match the line makes the chain read as broken, so `join`, every write, `merge-log`, `review` and `doctor` refuse a wrong key even while the log holds no sealed entry, and each says that the key is not the project’s. `status`, `session protocol` and the dashboard name the key as the cause and point to `join`, instead of reporting a changed entry. Writes to a variant log check the key against the main log’s line. Old projects without the line keep working; `key export` adds the line to such a log.
- `init` refuses to create a key on a computer that has none when the log already names one, and points to `join`. `join` replaces a stored key that the log contradicts when the key file you give matches the log, and says which key it kept. `init --project` refuses a name with a line break.
- `init` writes `research/.gitattributes` with `* text eol=lf`, so research files keep LF line endings in every checkout, also with Git for Windows. An existing `.gitattributes` is left alone. The README has a section on repairing an older clone.
- `serve --app` refuses Node.js older than 22, says when Git was not found, and reminds you to keep the window open. On Windows, `install-cli` explains how to start placet-research instead, and a missing Git names Git for Windows. The app page in a browser helps with folder paths (Copy as path, Option+Command+C) and refuses or warns about project folders inside OneDrive on Windows.
- The repository has a root `package.json` whose only development dependency is Playwright, so the browser-rendered tests and the screenshot script run after `npm install && npm run setup:browsers` without `NODE_PATH`. The plugin itself still ships no dependencies.

### Fixed

- A canvas, glossary or decision log with Windows line endings (CRLF) used to read as empty: a canvas with no statements, or a log with no entries that still passed its own seal check. Now `status`, `review`, `accept`, `choose`, `log` and the app sidebar all refuse it with one message that names the file and the first such line. The guard refuses an agent’s edit of such a file. Nothing is rewritten for you.
- Two processes that write to the decision log at the same moment, such as the session view and an agent recording a finding, used to give two entries the same number and leave a log that no longer verified; every later write was then refused. Each write now waits its turn. If another process holds the log for five seconds, the write stops without changing anything and asks you to try again. A lock left behind by a process that ended is cleared on its own.
- The guard now refuses shell writes to the research state through a path that starts with `~/`, such as `printf … >> ~/papers/study/research/decisions.md`, including appends, copies and in-place edits. Before, such a path was not recognized as the research state. Reads still pass, and a quoted `~` stays a literal folder name, as in Bash.
- `placet-research doctor` is described with all its checks in the plugin README, including the name the log is written under.

### Desktop app (not distributed yet)

The app is not part of this release. These changes are in the repository for the next one:

- New project asks for your name, makes the folder a git repository, and Share with co-authors… uploads the project to an empty repository; an interrupted share can be finished by pasting the same link again. Join this project… appears whenever the computer has no key for the project. Send, Update and Share commit only the research files, refuse links that carry a password, and give up on a silent network command after 120 seconds with a sentence instead of hanging.
- Messages in the app never name a terminal command, and every git failure reads as a sentence with the next step. The app uses the git it brings with it when looking up your name.
- The window keeps a column for the agent, never gets narrower than 960 px, and moves the agent column aside while a dialog is open. The agent panel fits a 280 px column and asks before it removes a saved key. The shell page shows where an app update stands.
- The agent starts the bundled plugin with a fixed set of options and checks that the guard started before the first message. A server error is told apart from an unreachable host.
- The SessionStart hook writes a marker for the app when `RESEARCH_HARNESS_APP_MARKER` names a path; without the variable its output is unchanged.

## 0.6.0 (2026-10-15)

The session view has a new look. It is now set like a galley proof. Statements are numbered like 3.4, and the open questions an agent raised stand in the margin beside the statement they ask about. This release also adds a construct glossary, a way to turn one paper into a literature note whose quotations are checked against the printed page, and an app mode for the session server. The app mode is groundwork for a desktop app, which is not part of this release and is not distributed yet.

### Added

- A construct glossary in `research/glossary.md`. `research-harness glossary show <id>` prints an entry with its payload and hash. After you read it, `research-harness glossary accept <id> --hash <shown hash> --explained "<your sentence>"` marks the entry `[accepted]` and seals a decision in the log. A proposal that changed since you looked refuses, and so does an entry whose origin does not resolve or whose element 4 dependencies are not accepted. The model may propose entries but never accepts one, and the guard denies it the command.
- Canvas statements and manuscripts can cite glossary entries (`src: glossary.md#felt-safety`, `<!-- constructs: felt-safety -->`). `research-harness review` ends with a "Glossary mechanics" group that checks entry structure, declared coverage in the canvas and the manuscript, terms used without a link, and definitions that changed after acceptance. It names what depends on a changed entry and invalidates nothing. It also states that human judgment of the constructs was not performed. The `canvas` and `canvas-review` skills and both profiles describe the glossary, and the README has a short section on it.
- A `literature-note` skill that drafts a literature note from one paper you select, through a local gateway. `scripts/extract-paper.py` turns the PDF into text with a checked printed-page map, and `scripts/verify-quotes.py` checks every quotation against the page the note claims. It rejects a quotation from another page, an invented word, an ellipsis or a page range, and a note with no quotations does not pass. The check covers wording only. The skill never accepts a claim, and the plugin reference has a walkthrough on an invented paper.
- `research-harness serve --app [--app-data <dir>] [--no-open]` starts the session server in app mode. It starts without a paper project, opens the project of the folder it runs in if there is one, and prints the URL of the app page at `/app`. The page offers New project, Open project and Clone from link, and with a project open a sidebar with Get updates, Send my changes, Start session, Agenda, Export minutes and Invite co-author. Each dialog says what it will do before it does it. Recent projects are kept in `--app-data`, by default `~/.research-harness`. `serve` without `--app` works as before.
- The session view shows each statement's status and who owns it, in the poster, the element view, To talk about, History and Framings. Text and spacing scale with the window, so the view reads on a projector, and light and dark colours have higher contrast.
- At the start of a Claude Code session, the summary lists the open proposals by statement number, for example `Open proposals by number (cite statements as 3.1 or 3.1b): 1.2b, 2.2`. These are the numbers the session view shows, so you and the agent name the same statement.

### Changed

- **The guard now needs Claude Code 2.1.295 or newer.** It blocks the tool call when it times out, crashes or cannot start. Before, Claude Code ran the call unjudged in that case, and a slow Node start on a busy machine was enough. While the guard cannot answer, every tool call in every project is blocked. `SessionStart` still fails open.
- The session view is set as a galley proof. What the authors said or decided stands in one numbered column. What an agent proposes waits in the margin as a query, tied to its statement by a leader line, until you accept it with a sentence of your own. Field chips show each field's number and, in a wide window, its name. A statement can be linked by its number (`#st-3.1`), and a statement changed since your last read carries a "New" mark. Present shows one field and its queries at projector scale. The poster prints on one A4 landscape page in three columns, and a fuller canvas runs on to a second page instead of being set smaller. Its margin has a "Go to the first query" link. Source Serif 4 and Hanken Grotesk ship with the plugin.
- The session view no longer scrolls sideways down to 320 px. The tab bar wraps, the field list and the framing comparison stack, and every control is at least 24 by 24 pixels. On a narrow window the field rail sits below the selected view.
- The agenda puts discussion items first and groups unanswered questions by field. The poster explains how to comment and decide, and read-only examples say that nothing can be saved. History leaves out intact record checks and describes changed or unchecked records in plain words.
- Keyboard use and screen readers get more: view links identify the current page, headings follow the reading order, the skip link reaches the current content, and errors in the accept and framing-choice dialogs and in inline notes are tied to their field. Saving a note or marking a statement as said returns focus to the field.
- `research-harness merge-log` now merges two logs that both started from the same empty log, as happens when a project is shared before anything is logged and both people then log. Before, it refused and Get updates reported a failed merge. Logs from another project, sealed under another key, or starting with an unsealed entry are still refused.

### Fixed

- The guard no longer lets data in a heredoc reach a command that removes research state. `xargs rm <<'EOF'` with `research/canvas.md` in the body, `cat <<'EOF' | xargs rm`, and a `while read` loop over a heredoc listing `research` are denied. Heredoc text is split the way `xargs` splits it, and an unquoted heredoc is judged as bash expands it, so `$PWD/research/canvas.md` counts. A `read` loop and `xargs -d` or `read -d` with another delimiter are judged item by item. Commands that only read, such as `git commit -F - <<'EOF'`, and paths outside the state still pass.
- `research-harness merge-log` refuses before it touches `research/decisions.md` when our log carries no seal and theirs holds no entries. Before, it wrote the file and then failed its own check, leaving the file modified.
- A glossary acceptance is checked against the full definition that was reviewed, so a short identifier that collides can no longer hide a changed entry. Acceptance checks for a concurrent edit before it writes, and a failed write restores the glossary without overwriting that edit. A glossary changed during acceptance now gives the usual one-line refusal instead of a stack trace. An id that two headings share is not treated as accepted. The `glossary-accept` skill explains how to recover from a marker that was never logged.

### Under the hood

- Internal modules for the coming desktop app: `hooks/lib/app-git.js` (clone, update, commit and send without a shell), `hooks/lib/app-cli.js` (runs the plugin CLI for one project), `hooks/lib/app-store.js` and `hooks/lib/app-api.js` (recent projects and the app's routes). Nothing outside `serve --app` calls them. Embedded in the app page, the session view takes its token and tab from the page by message and ignores other origins.
- The session view can reveal and look up a statement by its number when the coming desktop app asks for it.
- The README pictures come from a committed `docs/media/showcase-state.json` that a test keeps renderable, with `scripts/capture-session-view.js` to capture them, and the READMEs show five captures of the session view.
- New tests for literal note paths in a notes-only research directory, and the suite now passes on a machine without a git `user.name`.

## 0.5.0 (2026-10-02)

Two people, one canvas: a researcher and a supervisor can now run a session on the same canvas, from one machine or from two git clones. The README's new section "Two people, one canvas" walks through the setup.

### Added

- Every entry in the decision log names who wrote it, as a `**By:**` line sealed with the rest of the entry. Set your name once with `research-harness name "A. Researcher"`; without it the name comes from `git config user.name`. The name is a statement, not proof: whoever holds the sealing key can write any name, and the seal only keeps it from changing afterwards. Older entries without a name show as "unknown".
- `research-harness session start "<occasion>"` marks the start of a session in the log. `research-harness session protocol [<n>]` prints what that session accepted and noted and which checks were still open at its end, with the seal status; `--out <file>` writes it to a file.
- `research-harness agenda [--out <file>]` prints the "To talk about" tab as Markdown before a session: the fields with findings that are not yet accepted, and the questions nobody has answered. The tab in the session view and the command now come from the same code.
- A second clone joins without a new key. The key holder runs `research-harness key export --out <file>.seal.key` (the key is never printed) and hands the file over in person; the second person runs `research-harness join --key-file <file> --name "<name>"`, which checks the key against the log before copying it. `init` in a clone whose log is already sealed now refuses and points to `join`, so nobody creates a second key by accident.
- `research-harness merge-log` repairs a `git pull --no-rebase` that conflicted on `research/decisions.md`: it keeps the other clone's log as it is and seals your new entries after it, with a `MERGE` entry that says what moved. It refuses and writes nothing when the other copy does not verify under the project key, and when one of your acceptances would land after a check question the other person opened. In that case `merge-log --skip-decision <n>` merges without that acceptance; set the statement's marker in `research/canvas.md` back by hand and accept it again.
- The session view shows each entry's author, marks sessions as dividers and merges as quiet lines, and filters History and field findings by name. The filter is kept in the address (`#by=<name>`), never in browser storage.
- A second canvas profile, `is-quantitative`, for experiments and surveys that test hypotheses: prior research leads to the question, the question to the hypotheses, then sample and design. Start a canvas with `init --profile is-quantitative` or switch an existing one with `research-harness profile is-quantitative`; the switch is logged. Its reasons cite methods articles from MISQ, ISR and JAIS. Under this profile, `review` reports any finding that was logged before the hypotheses and the design were accepted. It reports and never blocks. The session view draws its dependency graph from whichever profile the canvas uses.
- `research-harness doctor` also checks that a name is set and that the key here verifies the log, and notes a missing git remote, `pull.rebase` set to true, and two session markers in a row.

### Changed

- The model may now run `research-harness agenda` and `research-harness session protocol`, which only print, but not with `--out` or any other flag. `name`, `session start`, `merge-log`, `key export` and `join` stay your steps. No tool may read, copy or write a file ending in `.seal.key`.

### Fixed

- Three ways for the model to run a refused subcommand such as `accept` through the guard are closed: a flag placed before the subcommand, words added by `xargs`, and `$'…'` quoting.

## 0.4.3 (2026-10-01)

### Fixed

- A sealing key file that is empty or not a valid key is now refused, and nothing is written to the decision log. Before, such a file was used as-is, so entries could be sealed with an empty key that anyone could reproduce. If research-harness now refuses to write because of the key, restore the key file from where you keep its copy.
- Review no longer counts an accepted statement as logged just because another question holds the same text and has a decision. Each acceptance needs a decision for its own question.
- A statement inside a code block that is closed by a shorter or different fence (for example three backticks inside a block opened with four) is now reported as hidden, as it renders.
- Command options that need a value, such as `--match`, `--title`, `--profile` or `--why`, are refused when you give none. Before, the option was dropped silently; a bare `--match` could accept the only candidate without checking it. `log --supersedes` likewise refuses a missing number, zero, or an entry the log does not have.
- In the session view, if reloading the page fails after you saved something in a dialog, a notice now says so instead of leaving you with an out-of-date view.
- `research-harness doctor` now notices a terminal command that cannot run: one without execute permission, or one in `~/.local/bin` when that folder is not on your PATH. It tells you the fix, the same line `install-cli` prints.

### Changed

- Every place that tells you how to accept a statement now includes the explanation it requires: the README quick start, the canvas skill, the guard's refusal messages and the summary Claude Code reads at session start. The model is told not to write that sentence for you.
- The README's instructions for verifying a record you received use the installed `research-harness` command. The record-review skill cites a statement by its number, marker and exact words and no longer asks for a hash that no command prints.
- Each release now appears on GitHub with these notes.

## 0.4.2 (2026-10-01)

- When the model's shell command hides which `research-harness` subcommand it would run, the refusal now asks for the subcommand to be spelled out. It no longer incorrectly says the command is trying to accept a statement.
- A technical appendix explains what the sealed research record proves, how to verify a received record, and the limits of the model's tool restrictions. A verified seal does not identify the person who wrote an entry or establish that a research claim is true.

## 0.4.1 (2026-10-01)

- Closed shell-write routes to the canvas and decision log through symbolic links and differently capitalized paths. Links that would put a variant's state outside the research directory are also refused.
- `sed -n` is no longer assumed to be read-only when its script can write a file or run a command, including a write after a label. `less` options that save input to a file are also refused over research state; ordinary reads still work.
- Fixed false refusals of text replacements in unrelated notes when the replacement contains the word `Research`.
- Added a second public-data walkthrough about big-data communication during COVID-19. It uses pinned interview PDFs and page-cited framing alternatives. Start a fresh demo project for this example; the first walkthrough's interview-specific claims and expected output do not transfer.

## 0.4.0 (2026-10-01)

### Added

- Compare alternative framings of the same study. Give `/research-harness:canvas` several lenses to create separate variant canvases, then compare them in the session view's Framings tab. Differences are marked by field, and you can expand each field beyond its lead sentence.
- Choose a framing in the browser or with `research-harness choose <name> --why "<reason>"`. The chosen statements become the main canvas; the alternatives remain available. The decision log records your reason and what you set aside. Acceptance still happens separately on the main canvas.
- `/research-harness:check <n.m>` asks questions about a statement and its sources and records them for discussion. Open check questions appear before acceptance. You may accept with questions still open; the log records which ones were open at that point.
- `/research-harness:record-review` is a read-only review mode instructed to answer from the recorded canvas and decision log, cite the entries or statements it uses, and say "not in the record" when the record does not answer.
- Verify a received record on another machine with `research-harness review --key <file>` or `research-harness status --key <file>`. Review prints an anchor to compare with one retained independently when the record was submitted or published. Someone holding the key can re-seal a rewritten log, so a newly printed anchor alone is not evidence against rewriting.
- A public-data walkthrough lets you try framing comparison, acceptance with an explanation, and record verification on interviews about AI coding assistants. It includes recorded example framings so you can follow the CLI workflow without generating them yourself.

### Changed

- Every acceptance now requires your explanation of what you accept and why it holds. On upgrade, add `--explained "<your sentence>"` to `research-harness accept` and `/research-harness:accept`; the browser asks for it in a dialog. An empty explanation is refused without writing anything. Existing sealed log entries still verify.
- Choosing a framing refuses to overwrite a main canvas containing stated or accepted statements. The refusal lists the stated statements so you can decide where they belong before choosing.

### Fixed

- History now shows whether each entry verifies and warns when the log is broken. Mechanical review reports unverified framing choices as well as unverified acceptances.
- Free text in log entries can no longer masquerade as an explanation, a superseded decision, or an open-check list. A framing lens containing line breaks is recorded as one line, so it cannot insert extra fields into the chosen-framing entry.
- The acceptance, check and record-review skills no longer pre-approve general Node commands that could bypass their intended permissions.

## 0.3.6 (2026-09-30)

- Running `init` on a clone with an already-sealed decision log no longer creates a different key and falsely reports that log as broken. It leaves the record unchanged and explains where the original key belongs.
- To append sealed entries from another checkout, copy the original sealing key from the machine where the project started. Without that key, the received log remains "unverifiable here" rather than broken.

## 0.3.5 (2026-09-30)

- `research-harness title "<text>"` sets or changes the title of an existing canvas without changing its statements or decision log. With no text, it prints the current title. If `init --title` encounters an existing canvas, it now points you to this command.
- The session view renders reasons, rejected alternatives and superseded decisions as readable lines instead of showing raw Markdown labels and authorization tags.

## 0.3.4 (2026-09-30)

- When Node.js is missing from your terminal's PATH, the installed command now says so instead of incorrectly reporting that the plugin is not installed.

## 0.3.3 (2026-09-30)

- Run `research-harness` from your own terminal after the one-time `research-harness install-cli` setup. The installed launcher finds the current plugin after updates, prints any PATH setup you need, and refuses to overwrite a command it did not create. It does not edit your shell configuration.
- `research-harness doctor` now checks whether the terminal command is installed and tells you how to set it up if it is missing.
- Installation instructions now explain the GitHub access and git credentials needed to install from a private repository.

## 0.3.2 (2026-09-30)

- `research-harness serve` now opens a poster of the study's nine canvas elements. Cards lead with the authors' own statements; suggestions appear as Idea notes. Expand a card to read the rest, or open To talk about and History. The poster also prints on one landscape A4 page.
- Cards with review findings link directly to the questions to discuss. `/research-harness:canvas-review` now phrases findings as open questions using the field's human-readable question, instead of presenting them as verdicts about numbered elements.
- Set a new project's paper title with `research-harness init --title "<text>"`. The session view uses it as the heading. This option does not change the title of an existing canvas.

## 0.3.1 (2026-09-29)

- The model can use `for`, `while` and `until` loops to read research state when every command in the loop is read-only and no redirect writes a file. Loops that write to state or run acceptance are still refused.

## 0.3.0 (2026-09-29)

### Added

- Start `research-harness serve` yourself to open a local browser view of the canvas and decision log. Read the nine-element overview, inspect a field, work through the discussion agenda, and print the canvas.
- From the session view, add comments, mark a proposal as your own stated position, or accept a statement. Browser acceptance records the same sealed decision as CLI acceptance and refuses if the statement has changed since you saw it.
- `research-harness doctor` checks plugin settings, exercises the restriction on model acceptance, and checks for this project's sealing key. Run it after installation or enabling the plugin, then restart Claude Code: it checks settings, not whether an already-running session loaded them.
- Feedback and bug-report templates ask for the command, plugin version and error you encountered. They warn you to keep canvas and decision-log text out of public issues.

### Changed

- The session URL carries a single-use code that expires after 60 seconds. Once the view loads, a saved copy of that URL cannot authorize another session. Restart the server if the code has expired or has already been used.
- More wrapped or inline calls to acceptance and the session server are refused to the model. You start the server and make approvals yourself; these restrictions are not a sandbox for arbitrary programs.

### Fixed

- `--help`, `-h`, and calling the CLI without a subcommand now display help successfully. Project and outlet values containing colons or quotes no longer produce invalid canvas frontmatter.
- Reduced false shell refusals caused by patterns in text replacements, interpreter programs passed through standard input, and variables holding ordinary commands that happen to name a research-harness checkout.

## 0.2.1 (2026-09-29)

- In repositories without a research canvas or decision log, ordinary file moves and search patterns under a notes directory named `research` are no longer mistaken for writes to research state. Commands that could create or overwrite the canvas or log remain checked.
- Shell brace expansion and literal loop values can no longer hide a write to research state. A loop variable that is reassigned inside the command is treated as unknown rather than trusted to keep its original value.

## 0.2.0 (2026-09-23)

### Changed

- Model-side shell checks now follow more command wrappers and inspect programs passed directly to supported shells and interpreters. Command substitutions and scripts supplied through standard input can no longer hide the covered writes or acceptance calls.
- In a paper project, a shell write whose destination comes from a command substitution the harness cannot resolve may be refused. Use a literal path when you need the model to work on an unrelated file.

### Fixed

- Reduced interference in repositories with no canvas or decision log: a bare word `research`, an unresolved path, or a pattern matching a nonexistent state directory no longer triggers the paper-project read-only rule. Explicit paths that could create research state are still checked.
- Protected state remains recognized when its path contains brackets or a symbolic-link ancestor. Ordinary array text and shell output redirection such as `2>&1` are no longer mistaken for state-file writes.
- Invisible control characters can no longer change the interpretation of a stated or accepted commitment without being reported as a parse problem. Free-text reasons and rejected alternatives can no longer insert a fake log-entry heading that breaks later acceptance.
- `status` and `review` report an unreadable canvas with a short filesystem error instead of a stack trace.
- Status, review and the session summary now distinguish proposals from open elements. A field containing only suggestions is reported as open with a proposal count, rather than as "open (+1 open)".

## 0.1.0 (2026-09-21)

The first installable research-harness plugin.

### Added

- `/research-harness:canvas` builds a nine-element research canvas through dialogue. Start from brainstorming, a seed idea, or an existing manuscript. The canvas and decision log are Markdown you can keep in your paper's repository.
- An initial qualitative information-systems profile supplies questions, dependencies between elements, and readings on problematization and publishing. The plugin includes its own questions and source references, not copies of the cited publications.
- `/research-harness:canvas-review` challenges the canvas and records findings. Its mechanical report flags empty fields, proposals without commitments, unmet dependencies, missing evidence tags, and acceptances whose recorded text no longer matches.
- `/research-harness:accept <n.m>` accepts a statement and records the decision against its text. It refuses when prerequisite elements are not accepted and asks you to select a candidate when a question has more than one statement.
- A short summary at session start tells Claude Code where the project stands and shows decisions not yet seen in that session. Repositories without a canvas receive no summary.
- Model writes are checked to preserve stated and accepted commitments, including their questions and evidence tags. The model may propose alternatives and transcribe your words, but recognized attempts to accept, rewrite commitments or directly edit the decision log are refused. Ordinary reflow does not invalidate an acceptance.
- Decision-log entries carry chained seals. Review distinguishes verified entries, entries that cannot be verified on this machine, and a broken log. The sealing key stays outside the paper repository; older unsealed entries are reported as legacy, not silently treated as verified approvals.
- CLI operations initialize a project, show its status, review it, accept statements, and append findings or constraints. Initialization does not overwrite an existing canvas, and a broken log is not automatically repaired.
- Review also flags stated or accepted statements hidden in HTML comments or indented code blocks, so commitments that disappear from the rendered canvas do not disappear from the discussion.
