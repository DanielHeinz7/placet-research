---
name: check
description: Advisory check of one canvas statement before the researcher accepts it. Reads the statement, its tags and the sources they name, and records each open question as a DISCOVERY. Never accepts, never edits, never approves. Usage — /placet-research:check <n.m>
disable-model-invocation: true
argument-hint: <n.m>
allowed-tools: Read, Grep, Glob, Bash(placet-research status:*), Bash(placet-research log DISCOVERY:*)
---

# Checking one statement before it is accepted

You were asked to check statement `$ARGUMENTS` (form `n.m`: element n,
statement m). This is advisory. The researcher accepts or does not; you have
no part in that, and the view shows your questions next to the accept button
so they can weigh them.

## 1. Read

1. Run `placet-research status` and open
   `research/canvas.md`. Find statement `$ARGUMENTS`. If there is none, say so
   and stop.
2. Read the statement, its marker and its evidence tags. For every
   `src: <id>`, find the memo, document or reference it names and read the
   passage. An `unverified` tag, or a missing one on a factual claim, is
   itself a finding.
3. Read the statements it depends on, using the dependency graph in the
   profile named in the canvas frontmatter under
   `${CLAUDE_PLUGIN_ROOT}/references/profiles/`.

## 2. Ask

Look for what a careful co-author would ask before signing this statement:

- Does the named source say what the statement says, or something narrower?
- Is a factual claim untagged, or tagged `unverified`?
- Does it stretch past its dependencies (a claim in 8 that the findings in 7
  do not carry)?
- Is a word doing more work than the evidence: "all", "always", "causes"?
- Does another statement in the canvas contradict it?

Write only questions the researcher can answer. If you find nothing to ask,
write nothing and say plainly that you found no open question; do not
manufacture one, and do not describe the statement as fine, sound or ready.

## 3. Write — the only write you make

One entry per open question, one question per entry, through the harness so
it is sealed:

    placet-research log DISCOVERY "<n.m> check" --body "<question>"

The ref is exactly `<n.m> check`; the harness counts entries with that ref as
the open check questions of the statement. Word the body as a question, and
name the field by its human question (1 What puzzles us? · 2 Who cares, and
what do they already know? · 3 What exactly do we ask? · 4 What is it made
of? · 5 Where do we look? · 6 How do we look? · 7 What did we find? · 8 What
does it change? · 9 Where does it stop?), not as "element N". Keep the body
one paragraph of plain text. Never start a line in it with `**Why:**`,
`**Explained:**`, `**Rejected:**`, `**Open at acceptance:**` or
`**Supersedes:**`; those belong to the harness.

## What you never do

- Never accept, and never tell the researcher the statement is ready to be
  accepted. Say what is open; stop.
- Never edit, retag or remark on the statement in `canvas.md`. Your output is
  the log entries and the list below.
- Never write `research/decisions.md` yourself; the guard denies it.
- Never state a verdict: no "looks good", "sound", "approved", "passes". Your
  silence on a point is not a finding either.

## Report

List the questions you recorded, each with its `#seq` from the log and the
tag or source it came from. If you recorded none, say "no open question
found" and list what you read, so the researcher can see how far the check
went. Then stop.
