# Demo material: interviews on AI assistants in software engineering

The data for the walkthrough in
[the plugin README](../../plugins/placet-research/README.md#walkthrough-the-three-capabilities-on-a-public-dataset).
It is not stored in this repository. `fetch.js` downloads it from Zenodo and
keeps a file only if its size and sha256 match the values pinned in
`sources.json`.

## The dataset

Hristova, M. Y., Gala Scaramuzza, R., Popovici, C.-E., Burelli, P., & Tell, P.
*Understanding AI Assistance in Professional Software Engineering: An Interview
Study of Development Practices and Workflows.* PROFES 2026 (paper). Replication
package: *Understanding AI Assistance in Professional Software Engineering -
Replication Package*, IT University of Copenhagen, Zenodo, 2026-09-22,
<https://doi.org/10.5281/zenodo.22893731>.

- **Content.** De-identified transcripts of 13 semi-structured interviews with
  senior developers (more than five years of experience, daily use of AI coding
  assistants) from seven companies, in Markdown, plus the record's own
  `README.md`. The demo uses those 14 files.
- **Licence.** Creative Commons Attribution 4.0 International (CC BY 4.0),
  <https://creativecommons.org/licenses/by/4.0/>. The record's metadata says
  `cc-by-4.0` and `open` access for this version; it was read from the Zenodo
  API on 2026-10-01. The demo adds no change to the files: it fetches them
  unmodified and cites them by file name (`src: Interview_P05.md`).
- **Attribution.** Cite the paper and the record above when you use the data.
  Nothing in this repository was written or endorsed by the authors. The canvases
  the walkthrough builds are an illustration of a tool, not the authors' framing
  of their study.

## Pinned version, and why not a newer one

The pin is **record 22893731**, version 1 of the concept record 22893730
(2026-09-22). Its file list, read from the Zenodo API on 2026-10-01:

| Version | Record | Date | Files |
|---|---|---|---|
| 1 | 22893731 | 2026-09-22 | 13 interviews, questionnaire CSV, interview guide PDF, coding spreadsheet, README (17 files) |
| 2 | 22902703 | 2026-09-22 | coding spreadsheet and a Miro export (2 files) |
| 3 (latest) | 22975092 | 2026-09-26 | coding spreadsheet (1 file) |

Versions 2 and 3 keep the same description, which still lists the interview
files, but no longer carry them. Only version 1 holds the transcripts, so it is
the one pinned, and the demo fetches it rather than copying the transcripts into
this repository. If the authors withdrew the transcripts on purpose, a fetch
from version 1 keeps working only as long as Zenodo serves it; `fetch.js` says
so and stops if a file is gone or differs.

## Files

- `fetch.js`: `node fetch.js [--into <dir>]`, default `./interviews`.
- `sources.json`: the record, the licence, and each file's size and sha256.
- `recorded.js` and `recorded/`: the three framings (`workflow`, `trust`,
  `role`) the walkthrough uses in place of a live multiverse run. They were
  written by hand from the interviews, each statement citing the interview files
  it rests on. They hold `[proposed]` and `[tentative]` statements only.
