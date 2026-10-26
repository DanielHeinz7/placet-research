# Stress probes

## Seal and decision log (SQ-323)

Run from the repository root, with Node and Git available:

```sh
node verification/stress/log/probe-log-tamper.js
```

The probe creates a fresh temporary state directory, an invented name, and a
fixture canvas. One acceptance and nine findings are written through the CLI.
Every mutation is checked through both `review --key` and `status --key`.
Native fixture clones produce a real Git conflict; `merge-log` must retain all
four branch entries exactly once with unique sequence numbers. Twenty rounds
start two CLI writers together, then count missing bodies, duplicate sequence
numbers, and broken chains. Scheduling makes the race count vary between runs.

Exit 0 means the probe completed, **not** that every case was safe. Exit 1 means
setup or a control assertion failed. Read the `FINDING?` column:

- `FINDING`: an unreported mutation, or a failed concurrent append invariant.
- `LIMIT`: a valid prefix, a substituted key with a fully re-sealed log, or a
  discarded valid branch. The report quotes the README’s earlier-anchor limit
  and compares retained anchors; the CLI does not fetch an external anchor.
- `no`: both consumers name the problem, including a refusal or an explicit
  `unverifiable` warning, or the valid control passes.

The checked-in `log/log-tamper.txt` is one observed run. Body-only trailing
spaces preserve the canonical sealed payload and still verify; this is flagged
under the ticket’s literal byte-mutation expectation, not claimed to permit a
semantic rewrite. Trailing spaces on *every* line instead produce an explicit
`unverifiable` warning. CRLF is refused before an anchor is printed; a BOM breaks
the first seal. Review and status usually exit 0 even when naming `BROKEN`.

All setup, names, keys, Git commits, and CLI invocations belong to throwaway
fixture projects. The script clears inherited project and Git routing variables
and keeps the `PLACET_RESEARCH_STATE_DIR` override inside JavaScript;
it never uses the real global state directory. Optional
`PLACET_RESEARCH_PROBE_DIR` selects the evidence parent (otherwise the OS temp
directory). Each run retains raw review/status output, its complete report, and
fixture repositories in a new `log-tamper-*` directory. Nothing under `plugins/`
or elsewhere in the source checkout is written by the probe. There is no
process-crash or secret-exfiltration test, and no full-suite or coverage claim.

## Load: log, canvas, and session view (SQ-325)

Run on macOS from the repository root after `npm ci` and `npm run setup:browsers`:

```sh
node verification/stress/load/load.js --quick
node verification/stress/load/load.js
```

Quick mode uses 100/1,000 sealed log entries and 50/500 canvas statements;
full mode adds 5,000/20,000 log entries and 2,000 statements. These are
**independent axes**: log cases hold the canvas at 50 statements, canvas cases
hold the log at 100 entries. Every case has 500 valid glossary entries. All
content is invented. Projects, keys, HOME, and harness state are isolated in
fresh temporary directories and removed afterward; no real project or global
harness state is read. `TMPDIR` can select a scratch directory.

Logs use production `seal.sealEntry` (the building block called by CLI
`sealedAppend`) and `decisions.formatEntry`. Building the chain in memory
avoids quadratic *fixture preparation*. The actual bytes are checked with
`seal.verifyChain`, including the expected verified entry count. Canvas and
glossary grammar/counts are asserted before measurement.

Each result is the median of three fresh process invocations: real CLI
`review` and `status`, a PreToolUse Edit that the guard must deny because it
changes a stated commitment, and a Bash `cat research/decisions.md` that the
guard must allow. Only the hook runs, not the proposed Edit or Bash tool.

For each sample the real CLI `serve --no-open` starts on an ephemeral localhost
port. HTML timing includes startup and complete HTML retrieval. Playwright
Chromium follows the real session URL and reads the live `/api/state`; render
timing includes startup, visible poster, nine fields, poster/agenda/log sections,
and two animation frames. Assertions check all entries and statements in the
DOM, all API seals, unique DOM IDs, no page errors, and navigation to History.
The browser is already launched, but each sample uses a fresh browser context.
No fixture-mode page or handcrafted state payload replaces the real server.

Full mode writes [the measured table and raw samples](load/load-results.txt).
Quick mode prints results without changing committed files. Both modes print
findings for crashes, output/render mismatches, medians above 5 seconds, guards
above 1 second, and adjacent-case timing growth exceeding input growth by more
than 1.5×. That last heuristic flags observations, not proven asymptotic
complexity. Runs on a busy host should be repeated before drawing conclusions.
Exit 0 means the observational run completed, **not** that no findings exist;
setup, invalid fixtures, or the overall deadline cause a nonzero exit.
Before measuring, both modes check median/failure formatting, threshold and
superlinear reporting, largest-case memory formatting, and DOM-count helpers
with explicitly synthetic inputs. Those checks do not enter the measured table,
raw samples, or findings. Live Chromium assertions still check the real DOM.

On macOS `/usr/bin/time -l` records peak RSS; the report gives the maximum of
three samples for the two largest independent cases. Server RSS excludes
Chromium and is not total system memory. The probe requires macOS and fails
explicitly on other platforms instead of offering an unmeasured RSS fallback.
Raw timings retain all three samples. The probe records source HEAD, plugin
tree identity, its own SHA-256, host, Node version, and elapsed time.

Bounds: one command/server at a time; one Chromium browser; 8-second per-operation
quick deadline / 30-second full deadline; overall 55-second quick / 8-minute full
budget. Child process groups are stopped on timeout and servers are stopped
between samples. These measurements cover short synthetic bodies on one local
filesystem, not manuscripts, variants, agent execution, or remote filesystems.
No plugin code is changed by this probe.

Measured on October 25, 2026 (Apple M2, Node 24.16.0): the full run completed
in 62.43 seconds. At 20,000 entries, median review/status were 4,197/727 ms,
HTML/render were 68/3,437 ms, and Edit/Bash guards were 72/61 ms. At 2,000
statements the guards were 74/37 ms. Peak server RSS was 445 MiB at 20,000
entries (Chromium excluded). No measured case crossed the thresholds, crashed,
or failed the render assertions; no superlinear ratio was flagged. These are
observations for these independent axes, not a capacity guarantee or a
measurement of the combined 20,000-entry/2,000-statement case.
