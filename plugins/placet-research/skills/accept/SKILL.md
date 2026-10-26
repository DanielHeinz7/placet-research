---
name: accept
description: Accept one statement of the research canvas as a commitment of the project (researcher only). Usage — /placet-research:accept <n.m> --explained "<one sentence>" [--match <substring>] [--why <text>] [--rejected <text>]
disable-model-invocation: true
---

Accepting a canvas statement:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/placet-research.js" accept $ARGUMENTS`

The output above is the result. If it says "Accepted", the statement now
carries `[accepted]` and the decision log has a new entry with the text hash
and the researcher's explanation, sealed under this machine's key. If check
questions on this question were still open, the output lists them and the
entry records them under "Open at acceptance": accepting despite them is
allowed, and the record says so. If it refused — no explanation, an unmet
dependency, an ambiguous question, nothing to accept, no sealing key on this
machine, a broken decision log — it names what to do.

Every accept needs an explanation: one sentence, in the researcher's own
words, of what they accept and why it holds, passed as
`--explained "<sentence>"`. Without it nothing is accepted. Do not write the
explanation for the researcher or suggest wording to copy; the sentence is
theirs, and that is the point of it. If it was missing, tell them the accept
was refused and ask for their sentence.

If nothing was printed above, the arguments did not reach the command. Run it
yourself from the prompt with the `!` prefix, which executes a shell command
outside the model:

    ! node "<plugin root>/bin/placet-research.js" accept <n.m> --explained "<your sentence>"

Report the result to the researcher. Do not run `accept` through the Bash tool;
the guard denies it, because acceptance is the researcher's act, not the
model's.
