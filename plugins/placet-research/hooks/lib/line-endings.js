'use strict';
// Git for Windows checks text files out with CRLF line endings by default
// (core.autocrlf=true). The parsers split on \n and anchor headings at the end
// of a line, so a CRLF file would read as an empty canvas, or as an empty log
// that verifies. A CR before an LF is therefore refused everywhere, never
// repaired: the harness does not rewrite a ledger or a canvas.
const README_ANCHOR = 'https://github.com/anonymous-owner/placet-research#windows-line-endings';

function firstCrlfLine(text) {
  const s = String(text || '');
  const at = s.indexOf('\r\n');
  if (at < 0) return null;
  let line = 1;
  for (let i = 0; i < at; i += 1) if (s.charCodeAt(i) === 10) line += 1;
  return line;
}

function crlfProblem(line) {
  return `line ${line}: Windows line endings (CRLF), which placet-research does not read; nothing was changed. See ${README_ANCHOR}`;
}

function crlfRefusal(file, line) {
  return `${file} has Windows line endings (CRLF) from line ${line}, so placet-research cannot read it. Nothing was changed. See ${README_ANCHOR}`;
}

module.exports = { README_ANCHOR, firstCrlfLine, crlfProblem, crlfRefusal };
