# Alternative demo material: big-data communication amid COVID-19

This is a replacement dataset ready alongside the primary
[AI-assistants walkthrough](../../plugins/placet-research/README.md#walkthrough-the-three-capabilities-on-a-public-dataset),
not a change to that walkthrough. The researchers behind the data did not
write, check, or endorse the hand-written illustrative canvases here.

## Dataset and attribution

Elizabeth Ripley Johnson, María Castaño Martínez, and Selcen Ozturkcan,
*Interview Data on Challenges in big data based communication amid C19*,
Linnaeus University, Zenodo, 2022-03-10,
<https://doi.org/10.5281/zenodo.6344804>. The pinned record is **6344804**
(<https://zenodo.org/records/6344804>), the latest version shown on the record
page when checked on 2026-10-01. The record page and API list 13 interview
transcripts (`Copy of Interview 1 Transcript.pdf` through `Copy of Interview 13
Transcript.pdf`) and `Research participants.pdf` — **14 PDFs** in all.

The record states Creative Commons Attribution 4.0 International (**CC BY
4.0**), <https://creativecommons.org/licenses/by/4.0/>, and open access. Cite
the creators and pinned DOI when using these data. The PDFs are not committed:
`fetch.js` obtains the 14 files from that exact record and checks each against
the size and SHA-256 in `sources.json` before writing it. A missing or changed
file stops the fetch instead of silently substituting a newer version.

## PDF page citations

These PDFs have selectable text. Statements cite a PDF **and physical PDF
page**, for example `src: Copy of Interview 3 Transcript.pdf#page=5`. Open the
file under `interviews/` in a PDF reader at page 5 to check the passage. This
uses the PDF's own text and page numbering, so the example requires no
platform-specific extraction binary or extra dependency; it does not generate
or commit extracted copies. If your reader does not follow a `#page=` fragment,
open the named PDF and navigate to that page. A `src:` tag points to evidence,
not to an authorial endorsement of the interpretation.

## Switch from the primary example

In a **fresh project directory**, run:

```sh
node ~/placet-research/examples/big-data-communication/fetch.js
placet-research init --project big-data-communication --mode import
node ~/placet-research/examples/big-data-communication/recorded.js
placet-research review --variant credibility
```

The first command writes `interviews/`; it does not copy anything into this
repository. `recorded.js` is the **hand-written stand-in** for the model's
multiverse step: it creates `audience`, `credibility`, and `crisis` variants
through the same `init --variant` CLI as the primary example, then writes
proposals and tentative findings only. The lenses respectively ask how data
are translated for audiences, when a result is credible enough to present,
and how changing COVID guidance reaches dispersed workers. They are
alternative questions, not findings accepted by the researchers.

To exercise the rest of the CLI flow, compare the three variants and, if this
illustrative choice suits your purpose, choose `credibility` **before**
accepting anything on the main canvas:

```sh
placet-research choose credibility --why "The interviews describe both changing data and the decisions about whether to present it."
placet-research log DISCOVERY "3.1 check" --body "Does this question cover all communicators or only the interviewees here?"
placet-research accept 1.1 --explained "I accept the contrast between having data and deciding whether it can be presented because the cited interview gives both."
placet-research accept 3.1 --explained "I accept this as a question for these interviews while leaving its broader reach open."
placet-research status
placet-research review
```

Those `choose` and `accept` commands are **human acts**, not commands for a
model to run. The check question is deliberately still open at the second
accept, so the sealed log records it. The primary README explains the view,
read-only reviewer and released-key/anchor comparison; apply those steps to
this new project's `research/` directory without treating its example-specific
quoted output as this dataset's output.

## Files

- `sources.json`: the pinned DOI, licence, filenames, byte sizes and SHA-256.
- `fetch.js`: `node fetch.js [--into <dir>]`, default `./interviews`.
- `recorded.js` and `recorded/`: three hand-written, page-cited variant
  canvases; no transcript bytes are in the repository.
