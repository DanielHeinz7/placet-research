// A small Markdown subset for agent text: paragraphs, lists, **strong**,
// *em*, `code`, statement numbers and web addresses. Returns plain data; the
// page builds DOM nodes from it with textContent, never innerHTML.
(function (root) {
  'use strict';
  const tokens = (t) => (root.statementLinks || require('../statement-links')).findStatementTokens(t);
  const URL_RE = /https:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;

  function plain(text) {
    const out = [];
    const marks = [];
    for (const m of text.matchAll(URL_RE)) marks.push({ type: 'url', index: m.index, length: m[0].length, value: m[0] });
    for (const n of tokens(text)) if (!marks.some((u) => n.start >= u.index && n.start < u.index + u.length)) marks.push({ type: 'number', index: n.start, length: n.end - n.start, value: n.num });
    marks.sort((a, b) => a.index - b.index);
    let at = 0;
    for (const m of marks) {
      if (m.index > at) out.push({ type: 'text', value: text.slice(at, m.index) });
      out.push({ type: m.type, value: m.value });
      at = m.index + m.length;
    }
    if (at < text.length) out.push({ type: 'text', value: text.slice(at) });
    return out;
  }

  function inline(text) {
    const out = [];
    // An underscore only opens emphasis at a word edge, so file_name_here stays as typed.
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w)/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      if (m.index > at) out.push(...plain(text.slice(at, m.index)));
      if (m[1] !== undefined) out.push({ type: 'code', value: m[1] });
      else if (m[2] !== undefined) out.push({ type: 'strong', value: m[2] });
      else out.push({ type: 'em', value: m[3] !== undefined ? m[3] : m[4] });
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(...plain(text.slice(at)));
    return out;
  }

  function renderBlocks(markdown) {
    const blocks = [];
    for (const chunk of String(markdown).split(/\n{2,}/)) {
      const lines = chunk.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*[-*] /.test(l))) blocks.push({ tag: 'ul', items: lines.map((l) => inline(l.replace(/^\s*[-*] /, ''))) });
      else if (lines.every((l) => /^\s*\d+\. /.test(l))) blocks.push({ tag: 'ol', items: lines.map((l) => inline(l.replace(/^\s*\d+\. /, ''))) });
      else blocks.push({ tag: 'p', items: [inline(lines.join(' '))] });
    }
    return blocks;
  }

  // The line shown when the guard did not come on. A cause says what happened
  // on its own ("started but found no paper project" must not follow "did not
  // start"); only a start hook that did not run needs the sentence before it.
  function guardLine(cause) {
    if (cause === 'sandbox') return 'The agent’s sandbox could not start, so the agent stays off.';
    if (/start hook/i.test(cause)) return `The guard did not start, so the agent stays off. ${cause}`;
    return String(cause);
  }

  const api = { renderBlocks, guardLine };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.agentRender = api;
})(typeof self !== 'undefined' ? self : this);
