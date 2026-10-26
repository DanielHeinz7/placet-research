#!/usr/bin/env python3
"""Regenerates the invented PDFs and confirmed page maps in this directory.

Run it from anywhere:

    python3 make-fixtures.py

Every byte here is invented: the journal, the article, its references, the
reviewer acknowledgement and the download banner name no real publication, and
no publisher text is reproduced. The PDFs are assembled with the standard
library alone, so the fixtures do not need a PDF toolchain;
`scripts/extract-paper.py` reads them with the installed `pdftotext`.

Each `*.confirmed-map.json` carries the SHA-256 of the PDF bytes it was written
from, and this script writes the PDFs and their maps in the same run, so the
two stay bound to each other.

The layouts are the point of the fixtures:

- `regular.pdf` prints 41, 42, 43 on the three physical pages: one constant
  offset of +40.
- `irregular.pdf` prints 41, 43, 44: no constant offset, so only a confirmed
  map may number its pages.
- `missing-label.pdf` leaves the footer off its third page.
- `ambiguous-label.pdf` puts a bare volume number in the running head beside
  the footer page number, so a page carries two candidate labels.
- `blank-page.pdf` has a genuinely empty middle page.
- `repeated-body.pdf` repeats one body sentence on every page, and has a
  download banner on the first page and a references section on the last.
- `verbatim.pdf` is one page for the quotation check: a word whose substring
  must not match, a typographic apostrophe, two accented words and an em dash.
  It is written as cp1252 bytes, the code page of the fixture font, so
  `pdftotext` returns those characters rather than UTF-8 mojibake.
"""

import hashlib
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent

SCHEMA = "literature-note/page-map@1"
CONFIRMED_BY = "A. Researcher"
CONFIRMED_AT = "2026-10-05"

BANNER = "Downloaded from example.invalid for the use of a single reader."
RUNNING_HEAD = "Invented Journal of Organization Studies 12 (3)"
VOLUME_ONLY_HEAD = "12"

TITLE = "The unread agenda: proposals that never reach a decision"
BODY_1 = [
    "Abstract",
    "We follow twelve recorded meetings of one product team over a quarter and",
    "ask what happens to a proposal after it is spoken. The record shows that",
    "many proposals are acknowledged in the next turn and then never appear",
    "again in the conversation.",
    "Keywords: meetings, proposals, agenda, uptake",
]
BODY_2 = [
    "A proposal that is not taken up within the following two turns rarely",
    "returns to the floor. The pattern holds in all four rooms of the corpus,",
    "although the rooms differ in size and in who chairs them.",
]
REFERENCES = [
    "References",
    "Ahlers, M. (2019). Meeting routines and the life of an idea. Journal of",
    "  Invented Studies, 4(2), 111-130.",
    "Brennan, T. (2021). Who is heard when the room is full. Invented Press.",
    "Cordell, R. (2023). Turn taking without an agenda. Invented Press.",
]
REPEATED_BODY = "We thank the reviewers of this invented journal for their careful reading."

VERBATIM_TITLE = "Verbatim wording: accents, a dash and one cart"
# `café’s` carries the typographic apostrophe, `naïve` two accents
# and `—` the em dash: one page for the normalization the quotation check
# must and must not perform.
VERBATIM_BODY = [
    "The cart in the café’s reading room holds the figures that the",
    "naïve committee compares — a quarter of the argument at most.",
]


def escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_at(x, y, size, text):
    return "BT /F1 %d Tf 1 0 0 1 %d %d Tm (%s) Tj ET\n" % (size, x, y, escape(text))


def page_stream(header, body, footer):
    """A page: headers at the top, body below, footers at the bottom."""
    out = []
    y = 800
    for line in header:
        out.append(text_at(56, y, 8, line))
        y -= 11
    y = 740
    for line in body:
        out.append(text_at(56, y, 11, line))
        y -= 16
    y = 70
    for line in footer:
        out.append(text_at(56, y, 9, line))
        y += 12
    return "".join(out)


def build_pdf(streams, encoding="utf-8"):
    """A minimal PDF: catalog, page tree, one page plus content object each.

    The content streams carry the fixture text directly, so `encoding` is the
    code page the text is written as: the font declares `/WinAnsiEncoding`, so
    a page with characters outside ASCII must be written as cp1252.
    """
    count = len(streams)
    font_id = 3 + 2 * count
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join("%d 0 R" % (3 + 2 * i) for i in range(count))
    objects.append(("<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, count)).encode("ascii"))
    for index, stream in enumerate(streams):
        objects.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                "/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                % (font_id, 4 + 2 * index)
            ).encode("ascii")
        )
        data = stream.encode(encoding)
        objects.append(
            b"<< /Length "
            + str(len(data)).encode("ascii")
            + b" >>\nstream\n"
            + data
            + b"\nendstream"
        )
    objects.append(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    )
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += ("%d 0 obj\n" % number).encode("ascii") + obj + b"\nendobj\n"
    startxref = len(out)
    size = len(objects) + 1
    out += ("xref\n0 %d\n" % size).encode("ascii")
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += ("%010d 00000 n \n" % offset).encode("ascii")
    out += (
        "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, startxref)
    ).encode("ascii")
    return bytes(out)


def regular_pages():
    return [
        page_stream([BANNER, RUNNING_HEAD], [TITLE] + BODY_1, ["41"]),
        page_stream([RUNNING_HEAD], BODY_2, ["42"]),
        page_stream([RUNNING_HEAD], REFERENCES, ["43"]),
    ]


FIXTURE_PAGES = {
    "regular.pdf": regular_pages,
    "irregular.pdf": lambda: [
        page_stream([BANNER, RUNNING_HEAD], [TITLE] + BODY_1, ["41"]),
        page_stream([RUNNING_HEAD], BODY_2, ["43"]),
        page_stream([RUNNING_HEAD], REFERENCES, ["44"]),
    ],
    "missing-label.pdf": lambda: [
        page_stream([RUNNING_HEAD], [TITLE] + BODY_1, ["41"]),
        page_stream([RUNNING_HEAD], BODY_2, ["42"]),
        page_stream([RUNNING_HEAD], REFERENCES, []),
    ],
    "ambiguous-label.pdf": lambda: [
        page_stream([VOLUME_ONLY_HEAD, RUNNING_HEAD], [TITLE] + BODY_1, ["41"]),
        page_stream([VOLUME_ONLY_HEAD, RUNNING_HEAD], BODY_2, ["42"]),
        page_stream([VOLUME_ONLY_HEAD, RUNNING_HEAD], REFERENCES, ["43"]),
    ],
    "blank-page.pdf": lambda: [
        page_stream([RUNNING_HEAD], [TITLE] + BODY_1, ["41"]),
        "",
        page_stream([RUNNING_HEAD], BODY_2, ["43"]),
    ],
    "repeated-body.pdf": lambda: [
        page_stream([BANNER, RUNNING_HEAD], [TITLE, REPEATED_BODY] + BODY_1, ["41"]),
        page_stream([RUNNING_HEAD], [REPEATED_BODY] + BODY_2, ["42"]),
        page_stream([RUNNING_HEAD], [REPEATED_BODY] + REFERENCES, ["43"]),
    ],
    "verbatim.pdf": lambda: [
        page_stream([RUNNING_HEAD], [VERBATIM_TITLE] + VERBATIM_BODY, ["41"]),
    ],
}

# The text of every other fixture is ASCII; the page for the quotation check is
# not, and the fixture font declares /WinAnsiEncoding.
FIXTURE_ENCODING = {"verbatim.pdf": "cp1252"}

CONFIRMED_MAPS = {
    "irregular.confirmed-map.json": ("irregular.pdf", [41, 43, 44]),
    "blank-page.confirmed-map.json": ("blank-page.pdf", [41, None, 43]),
}


def write_confirmed_map(name, pdf_name, printed):
    pdf = (HERE / pdf_name).read_bytes()
    data = {
        "schema": SCHEMA,
        "pdfSha256": hashlib.sha256(pdf).hexdigest(),
        "confirmedBy": CONFIRMED_BY,
        "confirmedAt": CONFIRMED_AT,
        "pages": [
            {"physical": index, "printed": value}
            for index, value in enumerate(printed, 1)
        ],
    }
    (HERE / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main():
    for name, build in FIXTURE_PAGES.items():
        (HERE / name).write_bytes(build_pdf(build(), FIXTURE_ENCODING.get(name, "utf-8")))
    for name, (pdf_name, printed) in CONFIRMED_MAPS.items():
        write_confirmed_map(name, pdf_name, printed)


if __name__ == "__main__":
    main()
