#!/usr/bin/env python3
"""Extract one local paper with `pdftotext` and record a validated printed-page map.

    extract-paper.py PAPER.pdf [--offset N | --map FILE] [--out DIR] [--extractor NAME]
    extract-paper.py PAPER.pdf --verify PAGE-MAP.json

The full extraction keeps every physical page in order, header and footer text
included, and stays the text the quotation check reads. `<stem>.request.txt` is
a lossy second view for a model request: identified page-number labels, banner
lines and the references section are omitted, and nothing else. The page map
`<stem>.page-map.json` records the printed number of each physical page and
binds itself to the PDF bytes, the extraction bytes and the map it used.

A page-number label is a bare integer in the first or last two non-empty lines
of a physical page. It numbers the pages automatically only when every page
carries exactly one such label, in the same header or footer position, with
unique and increasing values at a constant offset. Anything else — a missing
label, two candidates on one page, a numbering restart, an offset that does not
hold — refuses automatic numbering and asks for `--map`, a
researcher-confirmed physical-to-printed map bound to the same PDF bytes. A
constant offset is a candidate for confirmation, never authority by itself.

Exit codes: 0 ok; 1 usage; 2 `pdftotext` is missing; 3 printed-page authority
refused; 4 an input is unreadable or invalid; 5 recorded evidence no longer
matches the files on disk. Missing tools and refused numbering are not a
passing check.

Nothing here reads or writes the network. The PDF stays where it is; every
output is local and untracked, and no extracted paper text is bundled with the
plugin.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

SCHEMA = "literature-note/page-map@1"

EXIT_OK = 0
EXIT_USAGE = 1
EXIT_DEPENDENCY = 2
EXIT_REFUSED = 3
EXIT_INVALID = 4
EXIT_CHANGED = 5

BAND_LINES = 2
TIMEOUT_SECONDS = 120

BARE_INTEGER = re.compile(r"^[0-9]{1,4}$")
BANNER = re.compile(r"downloaded\s+(from|by)|provided\s+by|licensed\s+to|https?://", re.IGNORECASE)
REFERENCES_HEADING = re.compile(r"^references$", re.IGNORECASE)


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


def read_json(path, what):
    raw = read_bytes(path, what)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        stop(EXIT_INVALID, "the %s %s is not readable JSON: %s" % (what, path, error))
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        stop(EXIT_INVALID, "the %s %s must declare schema %r" % (what, path, SCHEMA))
    return data, raw


def resolve_extractor(name):
    found = shutil.which(name)
    if not found:
        stop(
            EXIT_DEPENDENCY,
            "pdftotext is not available (looked for %r): install poppler or pass "
            "--extractor; a missing extractor is not a passing check" % name,
        )
    return found


def run_extractor(extractor, pdf_path):
    try:
        done = subprocess.run(
            [extractor, "-enc", "UTF-8", pdf_path, "-"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        stop(EXIT_INVALID, "pdftotext did not finish within %d s on %s" % (TIMEOUT_SECONDS, pdf_path))
    except OSError as error:
        stop(EXIT_DEPENDENCY, "pdftotext could not be started (%s)" % error)
    if done.returncode != 0:
        lines = done.stderr.decode("utf-8", "replace").strip().splitlines()
        stop(
            EXIT_INVALID,
            "pdftotext could not read %s (exit %d): %s"
            % (pdf_path, done.returncode, lines[-1] if lines else "no message"),
        )
    try:
        return done.stdout.decode("utf-8")
    except UnicodeDecodeError:
        stop(EXIT_INVALID, "the pdftotext output for %s is not valid UTF-8; inspect this PDF by hand" % pdf_path)


def split_pages(text):
    """The physical pages in order.

    pdftotext ends every page with a form feed, so the chunk after the last one
    is that separator's own tail and is dropped. A genuinely blank page keeps
    its empty chunk and its index.
    """
    chunks = text.split("\f")
    if len(chunks) > 1 and chunks[-1].strip() == "":
        chunks.pop()
    return chunks


def band_indices(lines):
    """The line indices of the header and footer bands: the first and the last
    two non-empty lines. Only these may carry a page-number label."""
    filled = [index for index, line in enumerate(lines) if line.strip()]
    return {"header": filled[:BAND_LINES], "footer": filled[-BAND_LINES:]}


def observe_page(chunk):
    """What one physical page's bands say about its printed number."""
    lines = chunk.split("\n")
    bands = band_indices(lines)
    candidates = {}
    for where in ("header", "footer"):
        for index in bands[where]:
            text = lines[index].strip()
            if BARE_INTEGER.match(text):
                candidates.setdefault(int(text), set()).add(where)
    if len(candidates) > 1:
        return {"value": None, "bands": [], "candidates": sorted(candidates), "problem": "ambiguous"}
    if not candidates:
        return {"value": None, "bands": [], "candidates": [], "problem": "missing"}
    value = next(iter(candidates))
    return {
        "value": value,
        "bands": sorted(candidates[value]),
        "candidates": sorted(candidates),
        "problem": None,
    }


def infer_offset(observations):
    """The one constant offset every page supports, or a refusal."""
    for number, record in enumerate(observations, 1):
        if record["problem"] == "missing":
            stop(
                EXIT_REFUSED,
                "physical page %d carries no page-number label in its header or footer; "
                "automatic printed numbering is refused. Extract again with --map FILE and a "
                "researcher-confirmed physical-to-printed map." % number,
            )
        if record["problem"] == "ambiguous":
            stop(
                EXIT_REFUSED,
                "physical page %d has %s as candidate labels in one band; the header or footer is "
                "ambiguous, so automatic printed numbering is refused. Extract again with --map FILE."
                % (number, record["candidates"]),
            )
    positions = {tuple(record["bands"]) for record in observations}
    if len(positions) > 1:
        detail = ", ".join(
            "physical %d in %s" % (number, "+".join(record["bands"]))
            for number, record in enumerate(observations, 1)
        )
        stop(
            EXIT_REFUSED,
            "the page-number label does not sit in the same header/footer position on every page "
            "(%s); automatic printed numbering is refused." % detail,
        )
    labels = [record["value"] for record in observations]
    if labels != sorted(set(labels)):
        stop(
            EXIT_REFUSED,
            "the printed labels %s are not unique and increasing across the physical pages; "
            "automatic printed numbering is refused." % labels,
        )
    offset = labels[0] - 1
    if any(value - number != offset for number, value in enumerate(labels, 1)):
        readings = ", ".join("%d -> %d" % (number, value) for number, value in enumerate(labels, 1))
        stop(
            EXIT_REFUSED,
            "the printed labels do not keep a constant offset from the physical pages (%s); "
            "automatic printed numbering is refused. Extract again with --map FILE and a "
            "researcher-confirmed map, including an explicit entry for every page you quote."
            % readings,
        )
    return offset


def positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def load_confirmed_map(path, pdf_sha256, page_count):
    """The researcher-confirmed physical-to-printed map, checked against the PDF
    bytes it claims to describe."""
    data, raw = read_json(path, "page map")
    if data.get("pdfSha256") != pdf_sha256:
        stop(
            EXIT_INVALID,
            "the page map %s is not bound to these PDF bytes (the map says %s, the PDF is %s); "
            "confirm the map against the PDF being extracted"
            % (path, short(data.get("pdfSha256")), short(pdf_sha256)),
        )
    entries = data.get("pages")
    if not isinstance(entries, list) or not entries:
        stop(EXIT_INVALID, "the page map %s lists no pages" % path)
    printed_of = {}
    for entry in entries:
        if not isinstance(entry, dict):
            stop(EXIT_INVALID, "the page map %s carries a page entry that is not an object" % path)
        physical = entry.get("physical")
        printed = entry.get("printed")
        if not positive_int(physical):
            stop(EXIT_INVALID, "the page map %s has an entry without a positive integer physical page" % path)
        if printed is not None and not positive_int(printed):
            stop(
                EXIT_INVALID,
                "the page map %s maps physical page %d to %r; a printed page is a positive integer "
                "or null for an unnumbered page" % (path, physical, printed),
            )
        if physical in printed_of:
            stop(EXIT_INVALID, "the page map %s names physical page %d twice" % (path, physical))
        if physical > page_count:
            stop(
                EXIT_INVALID,
                "the page map %s names physical page %d, but the PDF has %d pages"
                % (path, physical, page_count),
            )
        printed_of[physical] = printed
    values = [printed for number, printed in sorted(printed_of.items()) if printed is not None]
    if len(values) != len(set(values)):
        stop(EXIT_INVALID, "the page map %s gives one printed page to two physical pages (%s)" % (path, values))
    if values != sorted(values):
        stop(EXIT_INVALID, "the page map %s is not increasing in printed page (%s)" % (path, values))
    return printed_of, data, sha256_bytes(raw)


def request_view(pages, observations):
    """The lossy view a model request may carry.

    Only identified furniture is dropped: the page-number label and banner
    lines in a header or footer band, and the references section with
    everything after it. Repetition alone never removes a line; a repeated
    body sentence is body text, not a header.
    """
    omitted = {"bannerLines": 0, "labelLines": 0, "referenceLines": 0}
    out = []
    inside_references = False
    for chunk, observation in zip(pages, observations):
        lines = chunk.split("\n")
        bands = band_indices(lines)
        keep = []
        for index, line in enumerate(lines):
            text = line.strip()
            if inside_references:
                omitted["referenceLines"] += 1 if text else 0
                continue
            if text and REFERENCES_HEADING.match(text):
                inside_references = True
                omitted["referenceLines"] += 1
                continue
            if not text:
                keep.append(line)
                continue
            band = "header" if index in bands["header"] else ("footer" if index in bands["footer"] else None)
            if band and BANNER.search(text):
                omitted["bannerLines"] += 1
                continue
            if (
                band
                and observation["value"] is not None
                and BARE_INTEGER.match(text)
                and int(text) == observation["value"]
            ):
                omitted["labelLines"] += 1
                continue
            keep.append(line)
        out.append("\n".join(keep))
    return "\f".join(out), omitted


def write_text(path, text):
    try:
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
    except OSError as error:
        stop(EXIT_INVALID, "cannot write %s: %s" % (path, error.strerror or error))


def printed_line(records):
    return ", ".join(
        "unnumbered" if record["printed"] is None else str(record["printed"]) for record in records
    )


def run_extract(options):
    pdf_path = os.path.abspath(options.pdf)
    if not os.path.isfile(pdf_path):
        stop(EXIT_INVALID, "the PDF %s does not exist" % options.pdf)
    if options.offset is not None and options.map_path:
        stop(EXIT_USAGE, "--offset and --map are alternatives; give one of them")
    out_dir = os.path.abspath(options.out or os.path.dirname(pdf_path))
    if not os.path.isdir(out_dir):
        stop(EXIT_INVALID, "the output directory %s does not exist" % out_dir)

    pdf_bytes = read_bytes(pdf_path, "PDF")
    pdf_sha256 = sha256_bytes(pdf_bytes)
    extractor = resolve_extractor(options.extractor)
    text = run_extractor(extractor, pdf_path)
    if not text:
        stop(EXIT_INVALID, "pdftotext extracted nothing from %s; the file may be unreadable or not a PDF" % options.pdf)
    pages = split_pages(text)
    observations = [observe_page(chunk) for chunk in pages]

    if options.offset is not None:
        offset = infer_offset(observations)
        printed_of = {number: number + offset for number in range(1, len(pages) + 1)}
        method, map_file, map_sha, confirmed = "offset", None, None, {}
    elif options.map_path:
        printed_of, map_data, map_sha = load_confirmed_map(options.map_path, pdf_sha256, len(pages))
        method = "confirmed-map"
        map_file = os.path.abspath(options.map_path)
        offset = None
        confirmed = {"confirmedBy": map_data.get("confirmedBy"), "confirmedAt": map_data.get("confirmedAt")}
    else:
        printed_of = {}
        method, map_file, map_sha, confirmed = "none", None, None, {}
        offset = None

    records = []
    for number, (chunk, observation) in enumerate(zip(pages, observations), 1):
        printed = printed_of.get(number)
        records.append(
            {
                "physical": number,
                "printed": printed,
                "printedSource": None if printed is None else method,
                "hasText": bool(chunk.strip()),
                "chars": len(chunk.strip()),
                "textSha256": sha256_bytes(chunk.encode("utf-8")),
                "label": {
                    "value": observation["value"],
                    "bands": observation["bands"],
                    "candidates": observation["candidates"],
                },
                "labelProblem": observation["problem"],
                "agreesWithLabel": None
                if printed is None or observation["value"] is None
                else printed == observation["value"],
            }
        )

    view_text, omitted = request_view(pages, observations)
    stem = os.path.splitext(os.path.basename(pdf_path))[0]
    full_path = os.path.join(out_dir, stem + ".full.txt")
    view_path = os.path.join(out_dir, stem + ".request.txt")
    map_path = os.path.join(out_dir, stem + ".page-map.json")
    full_text = "\f".join(pages)
    write_text(full_path, full_text)
    write_text(view_path, view_text)

    sidecar = {
        "schema": SCHEMA,
        "pdfFile": pdf_path,
        "pdfSha256": pdf_sha256,
        "physicalPages": len(pages),
        "mapping": {
            "method": method,
            "offset": offset,
            "mapFile": map_file,
            "mapSha256": map_sha,
            "confirmedBy": confirmed.get("confirmedBy"),
            "confirmedAt": confirmed.get("confirmedAt"),
        },
        "extractionFile": os.path.basename(full_path),
        "extractionSha256": sha256_bytes(full_text.encode("utf-8")),
        "requestFile": os.path.basename(view_path),
        "requestSha256": sha256_bytes(view_text.encode("utf-8")),
        "requestLossy": True,
        "omittedFromRequest": omitted,
        "uncheckablePages": [record["physical"] for record in records if not record["hasText"]],
        "pages": records,
    }
    write_text(map_path, json.dumps(sidecar, indent=2) + "\n")

    print("ok: %d physical pages in %s" % (len(pages), options.pdf))
    if method == "offset":
        print("printed pages: %s (offset %+d)" % (printed_line(records), offset))
    elif method == "confirmed-map":
        print(
            "printed pages: %s (confirmed map %s, %s)"
            % (printed_line(records), os.path.basename(map_file), confirmed.get("confirmedBy") or "no confirmer")
        )
    else:
        print("printed pages: not established; add --offset N or --map FILE before checking quotations")
    print("full text: %s" % full_path)
    print("page map: %s" % map_path)
    print(
        "request view: %s (lossy: %d banner, %d label, %d reference lines omitted)"
        % (view_path, omitted["bannerLines"], omitted["labelLines"], omitted["referenceLines"])
    )
    uncheckable = sidecar["uncheckablePages"]
    if uncheckable:
        sys.stderr.write(
            "extract-paper.py: warning: physical page(s) %s carry no extractable text; they are "
            "uncheckable, and this run does not guess their content\n" % uncheckable
        )
    return EXIT_OK


def run_verify(options):
    if options.offset is not None or options.map_path:
        stop(EXIT_USAGE, "--verify re-reads a recorded page map; it takes no --offset and no --map")
    sidecar_path = os.path.abspath(options.verify)
    sidecar, _ = read_json(sidecar_path, "page map")
    pdf_path = os.path.abspath(options.pdf)
    if not os.path.isfile(pdf_path):
        stop(EXIT_INVALID, "the PDF %s does not exist" % options.pdf)
    directory = os.path.dirname(sidecar_path)
    mapping = sidecar.get("mapping") if isinstance(sidecar.get("mapping"), dict) else {}
    checks = [
        ("the PDF bytes", sidecar.get("pdfSha256"), pdf_path),
        ("the full extraction", sidecar.get("extractionSha256"), os.path.join(directory, sidecar.get("extractionFile") or "")),
        ("the request view", sidecar.get("requestSha256"), os.path.join(directory, sidecar.get("requestFile") or "")),
        ("the confirmed page map", mapping.get("mapSha256"), mapping.get("mapFile") or ""),
    ]
    changes = []
    for what, recorded, path in checks:
        if not recorded:
            continue
        if not path or not os.path.isfile(path):
            changes.append("%s: %s is gone" % (what, path or "no path recorded"))
            continue
        now = sha256_file(path)
        if now != recorded:
            changes.append("%s changed since this map was recorded (%s -> %s)" % (what, short(recorded), short(now)))
    if changes:
        stop(EXIT_CHANGED, "the recorded page map no longer matches: %s; re-extract and re-check" % "; ".join(changes))
    print(
        "ok: %s still matches %s and the extraction beside it"
        % (os.path.basename(sidecar_path), os.path.basename(pdf_path))
    )
    return EXIT_OK


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        stop(EXIT_USAGE, message)


def build_parser():
    parser = Parser(
        prog="extract-paper.py",
        description="Extract a paper with pdftotext and record a validated printed-page map.",
        epilog="Exit codes: 0 ok, 1 usage, 2 pdftotext missing, 3 numbering refused, "
        "4 unreadable input, 5 recorded evidence changed.",
    )
    parser.add_argument("pdf", help="the local paper to extract")
    parser.add_argument(
        "--offset",
        type=int,
        default=None,
        help="candidate printed-page offset, validated against the labels on every page",
    )
    parser.add_argument("--map", dest="map_path", default=None, help="a researcher-confirmed page map (JSON)")
    parser.add_argument("--out", default=None, help="directory for the outputs (default: beside the PDF)")
    parser.add_argument("--extractor", default="pdftotext", help="the pdftotext binary to run")
    parser.add_argument("--verify", default=None, help="re-check a recorded page map against the files on disk")
    return parser


def main(argv=None):
    options = build_parser().parse_args(argv)
    try:
        if options.verify:
            return run_verify(options)
        return run_extract(options)
    except Failure as failure:
        sys.stderr.write("extract-paper.py: %s\n" % failure.message)
        return failure.code


if __name__ == "__main__":
    sys.exit(main())
