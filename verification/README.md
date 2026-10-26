# Adversarial verification

The unit suite under `plugins/placet-research/test/` checks that the harness
does what it is supposed to do. These probes check the other thing: whether the
guard can be talked out of it.

They are here rather than on one machine because they have twice caught a live
hole while the unit suite reported green, and because the plugin's README makes
a claim about enforcement. A claim nobody can re-run is not evidence.

## Running them

    node verification/probes/probe-structural.js
    node verification/probes/probe-diff.js
    node verification/probes/probe-reconfirm.js
    node verification/probes/probe-benign.js --corpus verification/fixtures/benign-sample.jsonl

No arguments, no setup, no dependencies. Each script builds throwaway projects
in a temporary directory from the fixture canvas, drives every case through the
real `PreToolUse` hook with a hook payload, applies each write the guard
**allowed**, and re-reads the file to record what that write actually did. The
repository is never written to.

Output is one row per probe:

    ID | class | ALLOW/DENY | what the allowed write did | description

Reading it: a `DENY` row is the guard holding. An `ALLOW` row is only a finding
if the effect column shows the write changed something it should not have —
`LOST-COMMITTED`, `NEW-COMMITTED`, a status flip, or a `review[...]` count that
moved. Most `ALLOW` rows are negative controls and are supposed to be there; a
guard that denies everything is a wall, not a guard.

## Negative control

A green suite says nothing about a change unless the tests fail without it. That
check runs in a throwaway worktree of `HEAD`, so the caller's tree, index and
refs are never written to:

    node verification/negative-control.js --base <rev> --revert <path>[,<path>...] [--test-cmd "<shell command>"]

Each path is restored from `<base>` in that worktree — deleted there, when the
change added the file — and only then does the test command run. It defaults to
the plugin suite. Exit 0 means the tests failed under the revert: the control
bit, and the failing tests are named. Exit 1 means they passed, so nothing pins
the change. Exit 2 is for usage and setup errors, and for a run whose output
holds no test result at all — that is not evidence either way. The worktree is
removed again in every case, including on error or signal.

Its own cases:

    node --test verification/negative-control.test.js

## The corpus

| Script | Attacks |
|---|---|
| `probe-structural.js` | the document around a statement: moving it under another element, duplicating an element or question heading, rewriting a question's text or an element's title, the frontmatter |
| `probe-diff.js` | the statement itself and the decision log: rewording, downgrading, forging `[accepted]`, homoglyphs, invisible characters, marker-group variants, appending a forged `DECISION` entry |
| `probe-reconfirm.js` | a short regression pass over one case per family, for when only a quick check is wanted |
| `probe-benign.js` | the opposite direction: false positives. It replays Bash commands from projects that hold no research state through the hook and counts the DENYs; it never runs them. `--corpus verification/fixtures/benign-sample.jsonl` replays synthetic rows with expected verdicts (the SQ-76 and SQ-75 shapes plus two write controls) and exits 1 on an unexpected verdict. Any run that replays nothing (an empty corpus, or every row skipped) also exits 1. `--harvest` builds the corpus from exactly two path patterns: the main transcripts `~/.claude/projects/*/*.jsonl` and the subagent transcripts `~/.claude/projects/*/*/subagents/*.jsonl` (where Sidequest executors run much of their Bash). Each command takes its cwd from its own record, and a (cwd, command) pair found in both counts once, as main. It writes the corpus and a tab-separated report to the gitignored `verification/local/` and prints only counts (per origin, and DENYs per guard-reason prefix), because those commands come from private sessions. Limits: the corpus holds only commands Claude actually wrote, and a command rephrased after a denial appears in its rephrased form, so the DENY count is a lower bound. A cwd may have gained or lost research state since the command ran; rows are classified by the state at replay time, and a cwd that no longer exists is skipped. It measures the hook's decision, not what the command would have done. |

`recorded/` holds output from earlier runs, kept as a baseline to diff against:
the original pass that found the holes, the before-and-after pair from the
decision-log work, and the transcript of the live installation check.

## Benign replay deadlines

Each `probe-benign.js` hook process has a 10-second deadline, matching the
`PreToolUse` timeout in `plugins/placet-research/hooks/hooks.json`. A process
that reaches it is killed with `SIGKILL` and recorded as `TIMEOUT`, not
`HOOKERR`, even if it already printed a verdict. The summary always includes
`N timeouts`. Any timeout exits 1, including rows with a `known` ticket;
`scripts/release.js` also rejects a nonzero timeout count, regardless of
`--accept-denies`. Harvest stdout stays counts-only; detailed rows remain in
the local report. Regression checks use synthetic fixture hooks, not private
session data:

    node --test verification/probe-benign.test.js scripts/release.test.js

**Finding (SQ-333, source inspection):** the guard’s `wordNamesKeyFile` calls
`globLandsOnKeyFile`, which expands patterns using synchronous `fs.readdirSync`
calls with no internal deadline. A blocked directory read can therefore hold
a Bash tool call until the external hook timeout. This change bounds the
replay, not the guard’s directory reads. A macOS privacy prompt as the cause
of the reported directory blocks remains an assumption; this regression does
not attempt to reproduce that operating-system condition.

## Why the attacks are written down

Publishing a list of attacks tells a reader which ones were tried, and so
indirectly where to look for the ones that were not. That was weighed against
two things and lost.

First, the probes are mundane. They are Markdown edits — move a heading,
duplicate a question id, push a no-break space into a sentence — and shell
techniques that any manual page describes. Nothing here is a weapon outside
this plugin.

Second, this harness exists to support a claim about who may commit what in a
research project. Claims of that kind are checked, not believed. Anyone who
wants to know whether the guard holds should be able to find out in one command
rather than take the README's word for it.

## Adding a probe

Write the attack, run it against the **unmodified** guard first, and record
that verdict before changing anything. Both regressions this corpus caught were
visible only as a verdict flip against a measured baseline — read off the
previous report rather than re-measured, they would have been missed. Then keep
the effect column honest: a probe that reports `ALLOW` without saying what the
allowed write did proves nothing.
