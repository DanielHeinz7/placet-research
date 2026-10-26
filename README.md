# placet-research

placet-research is a harness for AI-native research: paper projects in which
agents do real work, not just answer questions. In a Claude Code session, agents
write competing framings of a study in parallel, raise check questions against
your argument, draft literature notes from your PDFs, and review the state of
the project. The harness keeps that work in the paper's own repository and
draws one line through it: agents propose, and only the researcher accepts.

Every acceptance comes with a sentence in the researcher's own words and lands
in a sealed decision log. Months later you can still say which parts of the
argument you committed to, why, and which parts an agent wrote that nobody
accepted.

Software teams use harnesses like this to let coding agents work on a codebase
under rules, checks, and decision rights. placet-research does the same for a
paper.

## What you work on: the canvas

A paper project gets one file, `research/canvas.md`. It follows the nine
elements of the AMJ Management Research Canvas (Dorobantu, Gruber, Ravasi &
Wellman, 2024; full reference below): the puzzle, the audience and
prior research, the research question, the theoretical constructs, the setting,
the design and analysis, the findings, the contributions, and the boundary
conditions. Each element holds short statements, and each statement carries a
marker saying where it stands:

```
- [proposed] Developers treat assistant output as a draft to verify, not as an answer.
- [stated] "We only interviewed people with five or more years of experience."
- [accepted] The study asks how senior developers decide when to trust an assistant.
```

`[proposed]` and `[tentative]` are the assistant's suggestions. `[stated]` is a
transcription of something you said. `[accepted]` means you read the statement
and committed to it. The file is plain Markdown under git, so you and your
co-authors can read it, diff it, and see how the framing changed.

The elements depend on each other. A contribution cannot be accepted before the
findings and constructs it rests on, and the tool tells you which pieces are still
missing. Treat it as a puzzle whose pieces have to fit, not as stages to get
through in order.

The session view shows the canvas as a nine-field poster:

![The poster shows the paper's nine fields with author statements and model proposals.](docs/media/poster.png)

## Who decides: you

You accept a statement with one sentence of your own about why it holds:

```sh
placet-research accept 3.1 --explained "The interviews show trust is negotiated case by case, so the question has to be about deciding, not about attitudes."
```

Without that sentence nothing is accepted. The acceptance is appended to
`research/decisions.md`, a log that only grows. Each entry is sealed with a key
that stays outside the repository, so an entry someone typed into the file by
hand does not verify, and a review names it.

Before you accept, the assistant can raise check questions. They do not block
you: you may accept with questions still open, and the log records which ones
were open at that moment.

A Claude Code hook refuses the assistant's own attempts to accept, to choose a
framing, to change what you said, or to write the log, as far as it can see
those attempts in its tool calls. It is a guardrail against an assistant
overstepping, not a lock. A script the assistant writes can call the same code
you call, and the seal cannot tell the two apart afterwards. The
[technical appendix](docs/technical-appendix.md#3-the-promotion-guard-and-its-perimeter)
shows a measured case.

## What else it does

- **Compare framings.** Parallel agents write the same study under several
  lenses, one framing each. You pick one; the others stay in the record together
  with your reason for setting them aside.
- **Review the record.** A read-only review lists open elements, stale
  acceptances (text changed after you accepted it), statements that carry
  neither a source nor an `unverified` tag, and log entries that do not verify. Someone you give the key to can run the
  same check on their own machine.
- **Keep a construct glossary.** `research/glossary.md` holds one definition
  per construct. Canvas statements and the manuscript cite entries, and when an
  accepted definition changes later, everything citing it is reported as stale.
- **Draft a literature note from a paper.** The assistant drafts a note from a
  local PDF, and the note is refused unless every quotation appears word for
  word on the printed page it cites. Paraphrase and numbers are not checked.
- **Work as two people.** A researcher and a supervisor can share one canvas,
  in one clone or two, prepare a meeting agenda from it, and export a protocol
  afterwards. The log records who wrote each entry, as a name, not as proof of
  identity.
- **Look at it in a browser.** `placet-research serve` opens a session view
  for meetings: the whole paper on one poster, what is still to discuss, and
  the history of decisions. You can comment and accept from there.

![To talk about shows the open question about the study's participants above the unanswered canvas questions.](docs/media/to-talk-about.png)

## What it does not do

It does not judge whether your research is good. It cannot tell whether a
`[stated]` line is a faithful transcription of what you said, or whether a
cited source supports the claim; the review lists both for you to look at. It
does not verify who someone is. The explanation you write is checked for being
there, not for showing understanding.

Scope is paper projects: journal articles, conference papers, book chapters.

## Try it

You need Claude Code. This copy is anonymized for review: `anonymous-owner` stands for
the account that hosts it. Then, in Claude Code:

    /plugin marketplace add anonymous-owner/placet-research
    /plugin install placet-research@placet-research

Run `placet-research doctor` to check the install, and
`placet-research install-cli` once so the command also works in your own
terminal. Open a paper project's repository and run `/placet-research:canvas`.

To see it on real material first, the
[walkthrough](plugins/placet-research/README.md#walkthrough-the-three-capabilities-on-a-public-dataset)
runs the whole sequence on 13 openly licensed interviews about AI assistants in
software engineering (Zenodo, CC BY 4.0): several framings, a choice between
them, an acceptance with an open question, a review, and a check of the log on
another machine. A test runs its commands and holds them to the output shown.

## Windows

placet-research runs on Windows in a browser tab, started from a zip on the release page.

### Install on Windows

1. Install [Git for Windows](https://git-scm.com/download/win) and the LTS version of
   [Node.js](https://nodejs.org) (22 or newer), each with its installer's defaults.
2. Download
   [placet-research-windows.zip](https://github.com/anonymous-owner/placet-research/releases/latest/download/placet-research-windows.zip)
   and unzip it.
3. Double-click `Start placet-research.cmd`. A black window opens, then your browser. Keep the
   black window open while you work; closing it stops placet-research.

Keep your projects outside OneDrive. To update, download the new zip and replace the folder; your
projects and your list of recent projects are stored elsewhere and stay. The same steps are in the
zip as `README.txt`.

Nothing in the Windows package has been tested on Windows yet: it is built and checked on a Mac only.

### Windows line endings

Git for Windows checks out text files with Windows line endings (CRLF) unless told otherwise.
placet-research reads only LF, so it refuses a canvas or decision log with CRLF and changes
nothing. A project whose `research` folder has a `.gitattributes` file keeps LF in every checkout.
`init` writes that file for new projects, and the desktop app clones with LF.

To repair a copy you cloned yourself: first run `git status` in the project folder. If it lists no
changes of your own, run

    git config core.autocrlf false
    git rm -r -q --cached research
    git checkout HEAD -- research

If it does list changes of yours, commit or copy them away first; the last two commands replace
the research files with the committed ones.

## Reference

Dorobantu, S., Gruber, M., Ravasi, D., & Wellman, N. (2024). The AMJ Management
Research Canvas: A tool for conducting and reporting empirical research.
*Academy of Management Journal, 67*(5), 1163–1174.
<https://doi.org/10.5465/amj.2024.4005>

The plugin does not ship the canvas article. It encodes its own questions,
modelled on the canvas and citing it.

## Further reading

- [Plugin reference](plugins/placet-research/README.md): install details,
  every skill and command, the session view, and the walkthrough.
- [Technical appendix](docs/technical-appendix.md): how the log is sealed, what
  the guard measurably catches and misses, the two-person merge, the glossary
  and literature-note checks, configuration, and releasing.
- [REFERENCES.md](REFERENCES.md): the methodological literature the question
  set is built on (the AMJ Management Research Canvas, the *Publishing in AMJ*
  series, and editorials from MIS Quarterly and JAIS).
- [Literature note reference](plugins/placet-research/references/literature-note.md):
  commands, exit codes, and a walkthrough on an invented paper.
