---
name: glossary-accept
description: Accept one glossary entry as a settled commitment of the project (researcher only). Usage — /placet-research:glossary-accept <id> --hash <64hex> --explained "<one sentence>" [--why <text>] [--rejected <text>]
disable-model-invocation: true
---

Before accepting, display the entry's canonical payload and its full SHA-256
binding digest (64 hex digits):

    ! node "<plugin root>/bin/placet-research.js" glossary show <id>

Read that payload. Then invoke this skill with the displayed hash, not a hash
recomputed automatically at acceptance time:

    /placet-research:glossary-accept <id> --hash <shown hash> --explained "<your sentence>"

Accepting a glossary entry:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/placet-research.js" glossary accept $ARGUMENTS`

The output above is the result. If it says "Accepted", the entry now carries
`[accepted]` and the decision log has a new DECISION named by the entry id,
binding the payload hash of the entry — its term, aliases, definition, cited
origin and distinctions — and sealed under this machine's key. Changing any
of those fields makes the acceptance stale, which `review` reports. If the
proposal changed after display, acceptance refuses without changing either
file. Display it again and read the new payload before deciding; do not retry
with a new hash on the researcher's behalf.

A missing or malformed hash, missing explanation, incomplete entry, unknown
id, unresolved origin, unmet element-4 dependency, missing sealing key or
broken decision log refuses by name. The glossary is published by an atomic
rename, then the decision is appended; a crash between these writes can leave
an [accepted] marker without a decision. Review labels that entry unlogged,
not a glossary acceptance. To recover that marker-only entry, the researcher
resets its marker in glossary.md to `[proposed]` by hand — the guard refuses
that edit to the model, because dropping a marker is removing a commitment —
and then you run `glossary show <id>` again, read the payload, and accept again
with the newly displayed binding digest and your own explanation. Do not repair
or invent a DECISION in the ledger.
The ledger keeps its eight-hex payload identifier; that identifier is not the
binding digest required by --hash.

On an I/O failure, recovery removes this call's partial ledger append first,
then restores the glossary, only while each file still matches this call's
written bytes. Before publication, acceptance re-reads glossary.md and refuses
if any bytes changed since it was loaded, preserving the concurrent edit.
These comparisons are not a cross-process lock: a writer can still race the
check and rename. Recovery can itself fail. This is not a cross-file transaction
or a guarantee against crashes.

Every accept needs an explanation: one sentence, in the researcher's own
words, of what they accept and why it holds, passed as
`--explained "<sentence>"`. Without it nothing is accepted. Do not write the
explanation for the researcher or suggest wording to copy; the sentence is
theirs. If it was missing, report the refusal and ask for their sentence.

If nothing was printed above, the arguments did not reach the command. After
showing and reading the payload, run it from the prompt with the `!` prefix,
which executes a shell command outside the model:

    ! node "<plugin root>/bin/placet-research.js" glossary accept <id> --hash <shown hash> --explained "<your sentence>"

Report the result to the researcher. Do not run `glossary accept` through the
Bash tool; the guard denies it, because acceptance is the researcher's act,
not the model's.
