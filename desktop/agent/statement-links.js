'use strict';
// Statement numbers in the agent's output: question id N.k (N 1 to 9, k 1 to
// 999), optionally a letter for further statements of the question (3.1b), as
// hooks/lib/numbers.js numbers them. Not part of a longer number such as
// 2.1.300 or 0.5.0. Loaded by the column page as a plain script, and by tests
// through require. Sub-project 3 uses this file unchanged.
(function (root) {
  var TOKEN = /(?<![\w.])([1-9]\.[1-9]\d{0,2}[a-z]?)(?![\w]|\.\d)/g;

  function findStatementTokens(text) {
    var out = [];
    var m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(String(text))) !== null) out.push({ num: m[1], start: m.index, end: m.index + m[1].length });
    return out;
  }

  // xterm keeps one cell per column; a wide character fills two cells, the
  // second with empty chars. Link ranges are in cells, matches in string
  // indices, so each string index gets the cell it came from.
  function mapToCells(cells) {
    var text = '';
    var cellAt = [];
    for (var x = 0; x < cells.length; x++) {
      var chars = cells[x].chars;
      if (!chars && cells[x].width === 0) continue;
      var s = chars || ' ';
      for (var i = 0; i < s.length; i++) cellAt.push(x);
      text += s;
    }
    return { text: text, cellAt: cellAt };
  }

  var api = { findStatementTokens: findStatementTokens, mapToCells: mapToCells };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.statementLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
