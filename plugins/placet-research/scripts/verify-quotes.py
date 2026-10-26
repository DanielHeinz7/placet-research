#!/usr/bin/env python3
"""Check the quotations of one literature note against one paper's extraction.

    verify-quotes.py NOTE.md --page-map PAPER.page-map.json [--out DIR]
    verify-quotes.py --verify QUOTE-REPORT.json

A quotation is one blockquote in the note's `Quotations` section:

    > "Verbatim wording." (p. 41)

Continuation lines within one blockquote are joined, so a printed line break
does not split a quotation. The claimed page is a printed page of the page map
`scripts/extract-paper.py` wrote; the quoted wording is compared against the
full extraction of the physical page that map gives that number. Only that
page is searched: a passage repeated elsewhere never matches by its first
occurrence.

The comparison keeps complete token sequences and normalizes case, typographic
quote and dash variants, ligatures, canonical accents and whitespace. It never
deletes a word, a digit or a word boundary: `art` is not `cart`, `car t` is not
`cart`, and an accented or non-Latin word is not its ASCII neighbour. Ellipses,
page ranges and cross-page quotations need a human: they fail this gate instead
of passing as a hint. The full extraction is the compared text, never the
lossy request view.

Exit codes: 0 every quotation in the inventory was parsed and matched its
claimed printed page; 1 the check did not pass (a mismatch, an unsupported,
malformed, misplaced or inline quotation, an uncheckable claimed page, or no
quotation inventory at all — `not checked: no quotations`), and also a usage
error; 4 an input is unreadable or invalid, or the page map establishes no
printed pages; 5 recorded evidence changed since the report was written.

This is source-text comparison, not a scientific quality score: it covers only
verbatim wording on the claimed printed page, and it accepts nothing.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import unicodedata

PAGE_MAP_SCHEMA = "literature-note/page-map@1"
REPORT_SCHEMA = "literature-note/quote-check@1"

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_INVALID = 4
EXIT_CHANGED = 5

DISCLAIMER = (
    "This check covers only verbatim wording on the claimed printed page. It does not verify "
    "paraphrase, numbers or attribution, and it does not accept a research claim. Project "
    "relevance and transfer judgments remain [proposed] for human review."
)

SECTION_HEADING = re.compile(r"^(#{1,6})[ \t]+quotations[ \t]*$", re.IGNORECASE)
HEADING = re.compile(r"^(#{1,6})[ \t]+\S")
BLOCK_MARKER = re.compile(r"^[ \t]{0,3}>[ \t]?")
QUOTATION = re.compile(
    r'^(?:"(?P<straight>.+)"|“(?P<curly>.+)”)[ \t]*\(p\.[ \t]*(?P<page>[0-9]{1,4})\)$'
)
PAGE_RANGE = re.compile(r"\(\s*pp?\.\s*[0-9]{1,4}\s*[-–—]\s*[0-9]{1,4}\s*\)")
TRAILING_LOCATOR = re.compile(r"\([^)]*\)[ \t]*$")
ELLIPSIS = re.compile(r"(?:\.\.\.|…)")
INLINE = re.compile(r'["“][^"”]{2,}["”][ \t]*\(p\.[ \t]*[0-9]{1,4}\)')

# Typographic variants collapse onto their plain form; ligatures expand into
# the letters they stand for. Nothing here adds or removes a word.
FOLD = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "‚": "'",
        "‛": "'",
        "′": "'",
        "“": '"',
        "”": '"',
        "„": '"',
        "‟": '"',
        "″": '"',
        "‐": "-",
        "‑": "-",
        "‒": "-",
        "–": "-",
        "—": "-",
        "―": "-",
        "−": "-",
        "ﬀ": "ff",
        "ﬁ": "fi",
        "ﬂ": "fl",
        "ﬃ": "ffi",
        "ﬄ": "ffl",
        "ﬅ": "ft",
        "ﬆ": "st",
    }
)


class Failure(Exception):
    """A stop with the exit code it leaves behind."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def stop(code, message):
    raise Failure(code, message)


def short(digest):
    return (digest or "")[:12]


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


def read_bytes(path, what):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError as error:
        stop(EXIT_INVALID, "cannot read the %s %s: %s" % (what, path, error.strerror or error))


def decode(raw, path, what):
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        stop(EXIT_INVALID, "the %s %s is not valid UTF-8" % (what, path))


def read_json(path, what, schema):
    raw = read_bytes(path, what)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        stop(EXIT_INVALID, "the %s %s is not readable JSON: %s" % (what, path, error))
    if not isinstance(data, dict) or data.get("schema") != schema:
        stop(EXIT_INVALID, "the %s %s must declare schema %r" % (what, path, schema))
    return data, raw


def split_pages(text):
    """The physical pages in order, the same way the extractor wrote them."""
    chunks = text.split("\f")
    if len(chunks) > 1 and chunks[-1].strip() == "":
        chunks.pop()
    return chunks


def normalize_tokens(text):
    """The compared form of one text: complete tokens, in order.

    Case, typographic variants, canonical accents and whitespace are folded
    away; letters, digits and marks are kept, and every other character ends
    the token it follows. Two texts compare equal only when their token
    sequences are equal, so a boundary change is a difference, not a match.
    """
    folded = unicodedata.normalize("NFC", text).translate(FOLD).casefold()
    tokens = []
    current = []
    for char in folded:
        if char.isalnum() or unicodedata.category(char).startswith("M"):
            current.append(char)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return tokens


def contains(haystack, needle):
    """Whether the complete token sequence `needle` occurs in `haystack`."""
    size = len(needle)
    if size == 0 or size > len(haystack):
        return False
    return any(haystack[start : start + size] == needle for start in range(len(haystack) - size + 1))


def quotation_section(lines):
    """The line span after the `Quotations` heading, or None.

    The section ends at the next heading of the same or a higher level. A note
    without that heading has no quotation section, and its blockquotes are not
    a place this gate may check.
    """
    for index, line in enumerate(lines):
        match = SECTION_HEADING.match(line)
        if not match:
            continue
        level = len(match.group(1))
        for other in range(index + 1, len(lines)):
            heading = HEADING.match(lines[other])
            if heading and len(heading.group(1)) <= level:
                return index + 1, other
        return index + 1, len(lines)
    return None


def inventory(lines):
    """Every blockquote in the note and every inline locator quotation.

    An unsupported quotation form is inventoried and rejected, never silently
    ignored: a blockquote outside the quotation section and an inline
    `"..." (p. N)` are findings, not prose.
    """
    section = quotation_section(lines)
    inside = range(*section) if section else range(0)
    items = []
    index = 0
    while index < len(lines):
        if BLOCK_MARKER.match(lines[index]):
            start = index
            parts = []
            while index < len(lines) and BLOCK_MARKER.match(lines[index]):
                parts.append(BLOCK_MARKER.sub("", lines[index]).strip())
                index += 1
            joined = " ".join(part for part in parts if part).strip()
            items.append(
                {"line": start + 1, "kind": "blockquote", "inSection": start in inside, "text": joined}
            )
            continue
        if INLINE.search(lines[index]):
            items.append(
                {"line": index + 1, "kind": "inline", "inSection": index in inside, "text": lines[index].strip()}
            )
        index += 1
    return items


def parse_block(text):
    """The quoted wording and claimed page of one joined blockquote, or the
    reason this gate cannot check it."""
    match = QUOTATION.match(text)
    if not match:
        if PAGE_RANGE.search(text):
            return None, "a page range (pp.) requires manual inspection"
        if TRAILING_LOCATOR.search(text):
            return None, "an unsupported locator; the gate allows one (p. N) with a positive integer"
        return None, 'not a quotation block: expected > "..." (p. N)'
    quoted = (match.group("straight") or match.group("curly") or "").strip()
    page = int(match.group("page"))
    if page < 1:
        return None, "page 0 is not a printed page; the locator must be a positive integer"
    if ELLIPSIS.search(quoted):
        return None, "an omission (an ellipsis) requires manual inspection"
    return (quoted, page), None


def evaluate(items, printed_of, pages):
    """Each inventory item with its location, claimed page and outcome."""
    results = []
    for item in items:
        entry = {
            "line": item["line"],
            "kind": item["kind"],
            "printed": None,
            "physical": None,
            "status": "rejected",
            "reason": None,
        }
        if item["kind"] == "inline":
            entry["reason"] = (
                'an inline quotation; the note template allows the blockquote form > "..." (p. N) '
                "in the quotation section"
            )
            results.append(entry)
            continue
        if not item["inSection"]:
            entry["reason"] = "a blockquote outside the quotation section"
            results.append(entry)
            continue
        parsed, reason = parse_block(item["text"])
        if parsed is None:
            entry["reason"] = reason
            results.append(entry)
            continue
        quoted, printed = parsed
        entry["printed"] = printed
        physical = printed_of.get(printed)
        entry["physical"] = physical
        if physical is None:
            entry["reason"] = "printed page %d is not in the page map" % printed
            results.append(entry)
            continue
        chunk = pages[physical - 1] if 1 <= physical <= len(pages) else ""
        if not chunk.strip():
            entry["reason"] = (
                "physical page %d carries no extractable text, so printed page %d is uncheckable"
                % (physical, printed)
            )
            results.append(entry)
            continue
        entry["status"] = "verified" if contains(normalize_tokens(chunk), normalize_tokens(quoted)) else "failed"
        if entry["status"] == "failed":
            entry["reason"] = "not in the source text of printed page %d (physical page %d)" % (printed, physical)
        results.append(entry)
    return results


def counts_of(results):
    checked = sum(1 for entry in results if entry["status"] in ("verified", "failed"))
    parsed = sum(1 for entry in results if entry["printed"] is not None)
    return {
        "found": len(results),
        "parsed": parsed,
        "checked": checked,
        "rejected": len(results) - checked,
    }


def result_of(results, counts):
    if not results:
        return "not-checked"
    if counts["checked"] == counts["found"] and all(entry["status"] == "verified" for entry in results):
        return "verified"
    return "failed"


def write_text(path, text):
    try:
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
    except OSError as error:
        stop(EXIT_INVALID, "cannot write %s: %s" % (path, error.strerror or error))


def run_check(options):
    if not options.note:
        stop(EXIT_FAILED, "give a NOTE.md to check, or --verify a recorded quote report")
    note_path = os.path.abspath(options.note)
    note_bytes = read_bytes(note_path, "note")
    note_text = decode(note_bytes, note_path, "note")
    if not options.page_map:
        stop(EXIT_FAILED, "the check needs --page-map PAGE-MAP.json: a note alone names no paper")
    map_path = os.path.abspath(options.page_map)
    sidecar, sidecar_raw = read_json(map_path, "page map", PAGE_MAP_SCHEMA)
    method = (sidecar.get("mapping") or {}).get("method")
    if method == "none":
        stop(
            EXIT_INVALID,
            "the page map %s establishes no printed pages (mapping.method: none); extract the paper "
            "with --offset N or a confirmed map before checking quotations" % options.page_map,
        )
    pages_of = sidecar.get("pages")
    if not isinstance(pages_of, list) or not pages_of:
        stop(EXIT_INVALID, "the page map %s lists no pages" % options.page_map)
    extraction_name = sidecar.get("extractionFile")
    if not isinstance(extraction_name, str) or not extraction_name:
        stop(EXIT_INVALID, "the page map %s names no full extraction" % options.page_map)
    extraction_path = os.path.join(os.path.dirname(map_path), extraction_name)
    extraction_bytes = read_bytes(extraction_path, "full extraction")
    digest = sha256_bytes(extraction_bytes)
    if digest != sidecar.get("extractionSha256"):
        stop(
            EXIT_CHANGED,
            "the full extraction %s is not the one the page map recorded (%s -> %s); re-extract the "
            "paper and re-confirm its pages before checking quotations"
            % (extraction_path, short(sidecar.get("extractionSha256")), short(digest)),
        )
    pages = split_pages(decode(extraction_bytes, extraction_path, "full extraction"))

    printed_of = {}
    for record in pages_of:
        if not isinstance(record, dict):
            stop(EXIT_INVALID, "the page map %s carries a page entry that is not an object" % options.page_map)
        printed = record.get("printed")
        physical = record.get("physical")
        if isinstance(printed, int) and not isinstance(printed, bool) and isinstance(physical, int):
            printed_of.setdefault(printed, physical)

    results = evaluate(inventory(note_text.split("\n")), printed_of, pages)
    counts = counts_of(results)
    result = result_of(results, counts)

    for entry in results:
        if entry["status"] == "verified":
            continue
        where = "line %d" % entry["line"]
        if entry["printed"] is not None:
            where += " (p. %d)" % entry["printed"]
        sys.stderr.write("verify-quotes.py: %s: %s\n" % (where, entry["reason"]))

    out_dir = os.path.abspath(options.out or os.path.dirname(note_path))
    if not os.path.isdir(out_dir):
        stop(EXIT_INVALID, "the output directory %s does not exist" % out_dir)
    report_path = os.path.join(out_dir, os.path.splitext(os.path.basename(note_path))[0] + ".quote-check.json")
    report = {
        "schema": REPORT_SCHEMA,
        "result": result,
        "noteFile": note_path,
        "noteSha256": sha256_bytes(note_bytes),
        "pdfFile": sidecar.get("pdfFile"),
        "pdfSha256": sidecar.get("pdfSha256"),
        "extractionFile": extraction_path,
        "extractionSha256": digest,
        "pageMapFile": map_path,
        "pageMapSha256": sha256_bytes(sidecar_raw),
        "inventory": counts,
        "quotations": results,
        "disclaimer": DISCLAIMER,
    }
    write_text(report_path, json.dumps(report, indent=2) + "\n")

    if result == "not-checked":
        print("not checked: no quotations")
        print("the note carries no blockquote in a `Quotations` section; that is not a passing check")
    elif result == "verified":
        print("ok: %d quotations verified on their claimed printed pages" % counts["checked"])
    else:
        print(
            "failed: %d of %d quotations were not verified on their claimed printed pages"
            % (counts["found"] - sum(1 for entry in results if entry["status"] == "verified"), counts["found"])
        )
    print(
        "quotations: %d found, %d parsed, %d checked, %d rejected"
        % (counts["found"], counts["parsed"], counts["checked"], counts["rejected"])
    )
    print(
        "source: %s, page map %s, extraction %s"
        % (
            os.path.basename(sidecar.get("pdfFile") or "?"),
            os.path.basename(map_path),
            os.path.basename(extraction_path),
        )
    )
    print("quote report: %s" % report_path)
    print(DISCLAIMER)
    return EXIT_OK if result == "verified" else EXIT_FAILED


def run_verify(options):
    report_path = os.path.abspath(options.verify)
    report, _ = read_json(report_path, "quote report", REPORT_SCHEMA)
    checks = [
        ("the note", report.get("noteFile"), report.get("noteSha256")),
        ("the PDF", report.get("pdfFile"), report.get("pdfSha256")),
        ("the full extraction", report.get("extractionFile"), report.get("extractionSha256")),
        ("the page map", report.get("pageMapFile"), report.get("pageMapSha256")),
    ]
    changes = []
    for what, path, recorded in checks:
        if not path or not recorded:
            changes.append("%s: the report records no %s" % (what, "path" if not path else "hash"))
            continue
        if not os.path.isfile(path):
            changes.append("%s: %s is gone" % (what, path))
            continue
        now = sha256_file(path)
        if now != recorded:
            changes.append(
                "%s changed since this report was written (%s -> %s)" % (what, short(recorded), short(now))
            )
    if changes:
        stop(
            EXIT_CHANGED,
            "the recorded quote report no longer matches: %s; check the note again" % "; ".join(changes),
        )
    print(
        "ok: %s still matches the note, the source and the page map it was checked against (result: %s)"
        % (os.path.basename(report_path), report.get("result"))
    )
    return EXIT_OK


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        stop(EXIT_FAILED, message)


def build_parser():
    parser = Parser(
        prog="verify-quotes.py",
        description="Check a literature note's quotations against one paper's full extraction.",
        epilog="Exit codes: 0 every quotation verified, 1 the check did not pass or the call is "
        "malformed, 4 unreadable or invalid input, 5 recorded evidence changed.",
    )
    parser.add_argument("note", nargs="?", default=None, help="the note whose quotations to check")
    parser.add_argument("--page-map", dest="page_map", default=None, help="the paper's page-map sidecar")
    parser.add_argument("--out", default=None, help="directory for the quote report (default: beside the note)")
    parser.add_argument("--verify", default=None, help="re-check a recorded quote report against the files on disk")
    return parser


def main(argv=None):
    options = build_parser().parse_args(argv)
    try:
        if options.verify:
            if options.note or options.page_map:
                stop(EXIT_FAILED, "--verify re-reads a recorded report; it takes no note and no --page-map")
            return run_verify(options)
        return run_check(options)
    except Failure as failure:
        sys.stderr.write("verify-quotes.py: %s\n" % failure.message)
        return failure.code


if __name__ == "__main__":
    sys.exit(main())
