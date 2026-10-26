# literature-note fixtures

Invented PDFs for `test/literature-extraction.test.js`. They carry no publisher
text: the journal, the authors, the references and every sentence in them were
written for these tests, and the download banner points at `example.invalid`.

`make-fixtures.py` writes them with the Python standard library only — no
third-party package, no reportlab — and `references/literature-note.md`
documents how the extractor is meant to treat each one. Regenerate them with:

```
cd plugins/placet-research/test/fixtures/literature-note
python3 make-fixtures.py
```

| Fixture | What it exercises |
|---|---|
| `regular.pdf` | Footers 41, 42, 43: a constant `printed - physical` of +40, a download banner on page 1, a References section on page 3 |
| `irregular.pdf` | Footers 41, 43, 44: no constant offset, so only a confirmed map may number it |
| `missing-label.pdf` | Page 3 carries no footer label at all |
| `ambiguous-label.pdf` | The bare volume number `12` sits beside the footer label, so one band yields two candidates |
| `blank-page.pdf` | Page 2 has an empty content stream and no text layer |
| `repeated-body.pdf` | A sentence repeated on every page as body text, with the banner and references of `regular.pdf` |
| `verbatim.pdf` | One page for the quotation check: `cart` (whose substring must not match), a typographic apostrophe, `café`/`naïve` accents and an em dash. Its text is cp1252 bytes, the code page of the fixture font |

`irregular.confirmed-map.json` and `blank-page.confirmed-map.json` are the
researcher-confirmed page maps for those two fixtures: the first pairs
1→41, 2→43, 3→44, the second marks page 2 as explicitly unnumbered.

`quote-notes/` holds the invented notes for `test/literature-quotes.test.js`,
one per quotation-check assertion: `exact.md` (every quotation matches, one
delimiter pair curly, one quoted line from the references page), `mismatch.md`
(wrong page, one invented word, one unmapped page), `boundaries.md` (a
substring and a broken word boundary), `stitched.md` (the right words in the
wrong order, and page zero), `malformed.md` (a blockquote outside the section,
a blockquote without a locator, an inline quotation), `unsupported.md` (an
ellipsis and a page range), `empty.md` (a quotation section with nothing in
it), `repeated.md` (a passage that is on all three pages) and `unicode.md`
(accents, a ligature and a dash variant).
