'use strict';
// Statement numbers. A statement is numbered by its question: 3.1, then 3.1b,
// 3.1c for further statements of the same question (the scheme the session
// view has used since SQ-239, moved here unchanged). The view keeps an inline
// copy of statementNumber, because its page loads no script files;
// test/numbers.test.js checks the two are the same text.

function statementNumber(q, index) { return q.id + (index ? String.fromCharCode(97 + index) : ''); }

function numberedStatements(parsed) {
  const out = [];
  for (const element of parsed.elements) {
    for (const q of element.questions) {
      q.statements.forEach((st, index) => {
        out.push({ num: statementNumber(q, index), question: q.id, index, marker: st.marker, text: st.text, hidden: Boolean(st.hidden) });
      });
    }
  }
  return out;
}

function openProposalNumbers(parsed) {
  return numberedStatements(parsed).filter((s) => s.marker === 'proposed' && !s.hidden).map((s) => s.num);
}

module.exports = { statementNumber, numberedStatements, openProposalNumbers };
