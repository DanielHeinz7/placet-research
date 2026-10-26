# Media

## showcase-state.json

One canvas as the session view reads it, so the README's pictures and the video's
UI scenes can be captured from the same state. The file is the view's own answer
to `GET /api/state` (`viewState` in `plugins/placet-research/bin/canvas-serve.js`),
not hand-written state: a walkthrough project, read after `trust` was chosen as
the framing, `1.1` accepted, `3.1` stated through the same function the view's
`POST /api/stated` calls, the check question on `3.1` still open, and a
supervision session started under a second name. It is built with the
walkthrough's own steps — `examples/ai-assistants-interviews/recorded.js` plus
`init`, `choose`, `log`, `accept`, `session start` and `name` — the same pattern
`plugins/placet-research/test/fixtures/make-variants-fixtures.js` follows.

`plugins/placet-research/test/showcase-state.test.js` loads the file through the
fixture path of the view (`?fixture=`) and fails when a schema change would leave
a screenshot on the view's error path.

The session view's galley-proof layout is built and captured against this one
file, so it holds every status word at least once (Decided on 1.1, Said by the
authors on 3.1, Draft on 7.1, Suggestion on 9.1), several empty fields, and one
field with two open suggestions: two `[proposed, unverified]` statements on `6.1`
(about the 13 interviews and how they are read), added to the generated state
with their text hashes and the counts that follow from them (the field's status,
`review.statuses`, `review.open`, `review.empty`, and `6.1` leaving
`agenda.gaps`). `test/showcase-state.test.js` fails if one of those goes missing.

The state carries no glossary: `canvasState` calls `mechanicalReview` without the
glossary text, so no glossary entry reaches the view, and the view renders none.

### Where the content comes from

The canvas texts and every `src: Interview_Pnn.md` citation are the walkthrough's,
drawn from the interviews of Hristova, M. Y., Gala Scaramuzza, R., Popovici,
C.-E., Burelli, P., & Tell, P. *Understanding AI Assistance in Professional
Software Engineering: An Interview Study of Development Practices and Workflows.*
PROFES 2026 (paper); replication package *Understanding AI Assistance in
Professional Software Engineering - Replication Package*, IT University of
Copenhagen, Zenodo, 2026-09-22, <https://doi.org/10.5281/zenodo.22893731>, under
CC BY 4.0. Cite the paper and the record as
[`examples/ai-assistants-interviews/README.md`](../../examples/ai-assistants-interviews/README.md)
asks; the demo's canvases are an illustration of the tool, not the authors'
framing of their study. The people in the state (`A. Author`, `B. Supervisor`)
are invented.

## Capturing a screenshot

```console
$ node scripts/capture-session-view.js --view log --out shot.png
wrote …/shot.png (1440x900, 184144 bytes)
```

The script serves `plugins/placet-research/dashboard/canvas.html` and this state
on a free localhost port, opens the page in fixture mode and screenshots the
viewport with Playwright Chromium. It prints the path and the size of the file it
wrote:

| Option | |
|---|---|
| `--view <name>` | `poster` (default), `compare`, `agenda`, `log`, `element-<n>` |
| `--width`, `--height` | viewport in pixels, default 1440x900 for the README; 1920x1080 for video stills |
| `--out <file>` | PNG to write, default `session-view.png` in the current directory |
| `--dark` | render the session view in its dark colour scheme |

Playwright is not a dependency of the plugin — it is a devDependency of this
repository, needed by this script and by the rendered tests. Install it and its
Chromium once from the repository root, then run the script from anywhere in the
repository:

```console
$ npm install && npm run setup:browsers
```

## Committed screenshots

These PNGs are committed at 1440x900. The root and plugin READMEs use the light
captures; `poster-dark.png` shows the same poster in the dark colour scheme.
Each file is under 250 KB as captured, so no resizing or lossy conversion was
needed.

| File | View | Size (bytes) |
|---|---|---:|
| [poster.png](poster.png) | Poster | 159164 |
| [to-talk-about.png](to-talk-about.png) | To talk about | 119957 |
| [history.png](history.png) | History | 201955 |
| [element.png](element.png) | Field 3: Research Question | 152417 |
| [poster-dark.png](poster-dark.png) | Poster, dark | 159932 |

These are the exact capture commands, run from the repository root after
`npm install && npm run setup:browsers`:

```sh
node scripts/capture-session-view.js --view poster --width 1440 --height 900 --out docs/media/poster.png
node scripts/capture-session-view.js --view agenda --width 1440 --height 900 --out docs/media/to-talk-about.png
node scripts/capture-session-view.js --view log --width 1440 --height 900 --out docs/media/history.png
node scripts/capture-session-view.js --view element-3 --width 1440 --height 900 --out docs/media/element.png
node scripts/capture-session-view.js --view poster --dark --width 1440 --height 900 --out docs/media/poster-dark.png
```

The captures use the committed
`showcase-state.json`; the people named in them are invented, as described above.
