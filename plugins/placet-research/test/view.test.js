'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { viewState: buildViewState } = require('../bin/canvas-serve');
const { header, formatEntry } = require('../hooks/lib/decisions');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'canvas.html'), 'utf8');

test('canvas.html is self-contained: no http(s) URLs other than 127.0.0.1', () => {
  const matches = html.match(/https?:\/\/[^\s"'<>)]*/g) || [];
  const offenders = matches.filter((url) => !url.startsWith('http://127.0.0.1'));
  assert.deepEqual(offenders, []);
});

test('canvas.html reads a single-use code from location.hash and trades it for the token', () => {
  assert.match(html, /location\.hash/);
  assert.match(html, /\[#&\]\)c=/);
  assert.doesNotMatch(html, /\[#&\]\)t=/, 'the URL no longer carries the token');
  assert.match(html, /'\/api\/session'/);
  assert.match(html, /This session link was already used\. Stop `serve` and start it again\./);
});

test('the pages carry the product name Placet, not the old name', () => {
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'app.html'), 'utf8');
  const serve = fs.readFileSync(path.join(__dirname, '..', 'bin', 'canvas-serve.js'), 'utf8');
  assert.match(html, /<title>Placet — canvas<\/title>/);
  assert.match(html, /<span class="brand-text">Placet <span class="brand-sep">\/<\/span> Canvas<\/span>/);
  assert.match(appHtml, /<title>Placet<\/title>/);
  for (const text of [html, appHtml, serve]) assert.doesNotMatch(text, /Research harness/);
});

test('canvas.html keeps the token in memory only', () => {
  assert.doesNotMatch(html, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test('canvas.html clears the code from the URL with history.replaceState', () => {
  assert.match(html, /history\.replaceState/);
});

test('canvas.html supports fixture mode via the fixture query param', () => {
  assert.match(html, /fixture/);
  assert.match(html, /location\.search/);
});

test('canvas.html takes the dependency graph from the state, not from a copy of a profile', () => {
  assert.doesNotMatch(html, /PROFILE_GRAPHS/);
  assert.doesNotMatch(html, /'is-qualitative':\s*\{/);
  assert.match(html, /s\.graph/);
});

test('canvas.html sends the harness token and JSON content type on writes', () => {
  assert.match(html, /X-Harness-Token/);
  assert.match(html, /application\/json/);
});

test('canvas.html opens on the poster: the initial view is "poster" and the poster section is rendered', () => {
  assert.match(html, /var activeView = 'poster';/);
  assert.match(html, /<section id="poster" data-view="poster"/);
  assert.match(html, /tabButton\('poster', 'Poster'\)/);
});

test('canvas.html gives a poster card a "to talk about" line that opens that field in the To talk about tab', () => {
  assert.match(html, /data-view-target="agenda" data-scroll-to="agenda-field-/);
  assert.match(html, /id="agenda-field-'/);
});

test('the view holds no copy of the agenda logic or the human questions; it renders what the server sends', () => {
  assert.doesNotMatch(html, /What puzzles us\?/);
  assert.doesNotMatch(html, /function gapQuestions|function agendaFindings/);
  assert.match(html, /s\.agenda/);
  assert.match(html, /humanQuestions/);
});

test('canvas.html shows the paper title once: the top bar carries no title', () => {
  assert.doesNotMatch(html, /project-name|project-tag/);
  assert.equal((html.match(/esc\(paperTitle\(/g) || []).length, 1);
});

// The entry-body functions are pure; lift them out of the page's script so
// the rendered text can be checked without a browser.
function lift(names) {
  const src = names.map((name) => {
    const from = html.indexOf(`  function ${name}(`);
    assert.notEqual(from, -1, `${name} is in canvas.html`);
    return html.slice(from, html.indexOf('\n  }\n', from) + 4);
  }).join('\n');
  const labelDecl = html.match(/  var ENTRY_LABEL = .*;\n/)[0] + html.match(/  var STATUS_WORD = .*;\n/)[0];
  return new Function(`${labelDecl}${src}\nreturn { ${names.join(', ')} };`)();
}

const { renderEntryBody } = lift(['esc', 'renderStatus', 'parseFindingBody', 'renderEntryBody', 'seqLinks']);
const viewState = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'view-state.json'), 'utf8'));

function visibleText(markup) {
  return markup.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

test('a DECISION with a why renders its text, a superscript page and a quiet Why line, no raw markup', () => {
  const entry = viewState.decisions.find((d) => d.kind === 'DECISION' && /src:/.test(d.body) && /\*\*Why:\*\*/.test(d.body));
  assert.ok(entry, 'the fixture holds a sealed DECISION with a src and a why');
  const markup = renderEntryBody(entry.body);
  const text = visibleText(markup);
  assert.doesNotMatch(text, /\*\*/);
  assert.doesNotMatch(text, /\[accepted/);
  assert.doesNotMatch(text, /src:/);
  assert.match(markup, /<sup class="src-ref">p\. 1706<\/sup>/);
  assert.match(markup, /<span class="entry-note">Why: The study starts from the phenomenon, not from a gap\.<\/span>/);
  assert.ok(text.startsWith('Decided Authors How can we understand how members'));
});

test('a DISCOVERY with a why renders its text and a quiet Why line, no asterisks', () => {
  const entry = viewState.decisions.find((d) => d.kind === 'DISCOVERY' && /\*\*Why:\*\*/.test(d.body));
  assert.ok(entry, 'the fixture holds a DISCOVERY with a why');
  const markup = renderEntryBody(entry.body);
  assert.doesNotMatch(visibleText(markup), /\*\*/);
  assert.match(markup, /<span class="entry-note">Why: The puzzle may hold for only one group\.<\/span>/);
  assert.equal(visibleText(markup).split(' Why:')[0], 'Ask whether the twelve meetings cover more than one team.');
});

test('a Discarded line reads as its own quiet note, not as more of the Rejected text', () => {
  const markup = renderEntryBody(`Framing power chosen.\n**Rejected:** rituals\n**Discarded:** rituals sha256:${'a'.repeat(64)}; sense-making missing`);
  assert.match(markup, /<span class="entry-note">Rejected: rituals<\/span>/);
  assert.match(markup, new RegExp(`<span class="entry-note">Discarded: rituals sha256:${'a'.repeat(64)}; sense-making missing</span>`));
  assert.doesNotMatch(visibleText(markup), /\*\*/);
});

test('no fixture entry renders a raw label or an accepted marker, and Rejected and Supersedes read as quiet lines too', () => {
  for (const d of viewState.decisions) {
    const text = visibleText(renderEntryBody(d.body));
    assert.doesNotMatch(text, /\*\*/, `#${d.seq}`);
    assert.doesNotMatch(text, /\[accepted/, `#${d.seq}`);
  }
  const markup = renderEntryBody('Text. [accepted]\n**Why:** because\nit is so\n**Rejected:** other\n**Supersedes:** #2');
  assert.match(markup, /Why: because it is so<\/span>/);
  assert.match(markup, /Rejected: other<\/span>/);
  assert.match(markup, /Supersedes: #2<\/span>/);
  assert.equal(visibleText(markup).split(' Why:')[0], 'Decided Authors Text.');
});

test('History, To talk about and the element view all render an entry body through renderEntryBody', () => {
  assert.equal((html.match(/renderEntryBody\(d\.body\)/g) || []).length, 3);
  assert.equal((html.match(/parseFindingBody\(/g) || []).length, 2, 'declared once, called once (by renderEntryBody)');
});

test('an entry body shows Explained as a quiet line and Open at acceptance as #seq links into History', () => {
  const markup = renderEntryBody('Speaking frequency is well documented. [accepted]\n**Why:** gap\n**Explained:** Earlier work counts who speaks,\nnot whether a proposal is taken up.\n**Open at acceptance:** #4, #7');
  assert.match(markup, /<span class="entry-note">Explained: Earlier work counts who speaks, not whether a proposal is taken up\.<\/span>/);
  assert.match(markup, /Open at acceptance: <button type="button" class="seq-link" data-view-target="log" data-scroll-to="entry-4">#4<\/button>, <button type="button" class="seq-link" data-view-target="log" data-scroll-to="entry-7">#7<\/button><\/span>/);
  assert.doesNotMatch(visibleText(markup), /\*\*/);
});

test('an entry body never reads its first line as a label, like the library', () => {
  const markup = renderEntryBody('**Explained:** I said so\n**Why:** real');
  assert.ok(visibleText(markup).startsWith('**Explained:** I said so'), 'the first line is the text');
  assert.match(markup, /Why: real<\/span>/);
  assert.doesNotMatch(markup, /entry-note">Explained/);
  assert.doesNotMatch(renderEntryBody('Text.\n  **Explained:** indented is text, not a label'), /entry-note">Explained/);
});

// The page script runs here against a stub document, so what the view renders
// and sends is checked without a browser. Nothing is stubbed that the page
// decides: the stubs only hold what it writes into them and record its fetches.
const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
const variantsState = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'view-state-variants.json'), 'utf8'));
const chosenState = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'view-state-chosen.json'), 'utf8'));
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function stubNode() {
  const listeners = {};
  return {
    listeners,
    innerHTML: '',
    textContent: '',
    hidden: false,
    open: false,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    showModal() { this.open = true; },
    close() { this.open = false; (listeners.close || []).forEach((fn) => fn()); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

// `routes` maps a URL to a state, or to a function of the request returning
// `{ status, body }`. `mode` 'fixture' loads the state from `?fixture=`;
// 'live' trades the code in the hash for the token 'T' first.
async function mount({ state, query = '', mode = 'fixture', hash = mode === 'fixture' ? '' : '#c=abc123', routes = {} }) {
  const nodes = {};
  const node = (id) => nodes[id] || (nodes[id] = stubNode());
  const errorBox = { textContent: '' };
  node('dlg').querySelector = (selector) => (selector === '.dlg-error' ? errorBox : null);
  // The notice bar carries the `hidden` attribute in the markup; showNotice is
  // what lifts it.
  node('notice').hidden = true;
  const calls = [];
  const all = { '/fixture.json': state, '/api/state': state, '/api/session': { ok: true, token: 'T' }, ...routes };
  const fetchStub = (url, opts) => {
    calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : undefined });
    const route = all[url];
    const res = typeof route === 'function' ? route(opts) : { status: route ? 200 : 404, body: route };
    return Promise.resolve({ ok: res.status < 400, status: res.status, json: () => Promise.resolve(res.body) });
  };
  const documentStub = { getElementById: (id) => (id === 'body-shell' ? null : node(id)) };
  const location = mode === 'fixture'
    ? { search: `?fixture=/fixture.json${query}`, hash, pathname: '/' }
    : { search: '', hash, pathname: '/' };
  const historyStub = { replaceState(_state, _title, url) {
    const replaced = new URL(url, 'http://127.0.0.1');
    location.hash = replaced.hash;
    location.search = replaced.search;
  } };
  new Function('document', 'location', 'history', 'fetch', script)(documentStub, location, historyStub, fetchStub);
  await settle();
  const app = node('app');
  const dlg = node('dlg');
  return {
    app,
    dlg,
    errorBox,
    notice: node('notice'),
    noticeText: node('notice-text'),
    calls,
    location,
    writes: () => calls.filter((c) => c.opts && c.opts.method === 'POST' && c.url !== '/api/session'),
    click(attrs) {
      const btn = { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
      app.listeners.click[0]({ preventDefault() {}, target: { closest: (selector) => {
        const attr = /\[(data-[\w-]+)\]/.exec(selector);
        return attr && attr[1] in attrs ? btn : null;
      } } });
    },
    async submit(values) {
      const elements = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, setAttribute() {}, getAttribute() { return 'dlg-error'; }, focus() {} }]));
      dlg.listeners.submit[0]({ preventDefault() {}, target: { elements } });
      await settle();
    },
  };
}

const statementIn = (state, id, marker) => state.elements.flatMap((e) => e.questions).find((q) => q.id === id).statements.find((s) => s.marker === marker);

// Removing a status, hiding its word, or losing authors/model ownership in
// any consumer must fail, even when that consumer still renders the prose.
for (const [marker, word, owner] of [
  ['accepted', 'Decided', 'Authors'],
  ['stated', 'Said by the authors', 'Authors'],
  ['tentative', 'Draft', 'Model proposal'],
  ['proposed', 'Suggestion', 'Model proposal'],
]) {
  test(`${word} is visibly labelled with ownership and a non-colour cue in every reading view`, async () => {
    const state = structuredClone(viewState);
    const element = state.elements[0];
    element.questions.forEach((q) => { q.statements = []; });
    element.questions[0].statements = [{ text: 'Status example.', marker, tags: [], hash: 'status-example' }];
    const finding = { seq: 99, kind: 'DISCOVERY', ref: '1', date: '2026-10-06', body: `Status example. [${marker}]`, by: 'A. Author' };
    state.decisions = [finding];
    state.agenda.fields = [{ number: 1, question: 'What puzzles us?', findings: [finding] }];
    const page = await mount({ state });
    const ownership = owner === 'Authors' ? 'authors' : 'model';
    const label = `<span class="status-label status-label-${ownership}"><span class="status-word">${word}</span><span class="status-owner">${owner}</span></span>`;
    for (const id of ['poster', 'element-1', 'agenda', 'log']) {
      const section = page.app.innerHTML.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))[0];
      assert.ok(section.includes(label), `${id} exposes ${word} and ${owner} as visible markup`);
      assert.doesNotMatch(section, /\[(accepted|stated|tentative|proposed)\]|src:/, 'internal markers stay out of the view');
    }
    assert.ok(page.app.innerHTML.includes('Status example.'), 'the statement still renders');
  });
}

test('unmarked prose is not attributed to authors or models by guessing', () => {
  assert.doesNotMatch(renderEntryBody('Plain prose. [src: example p. 3]'), /status-label/);
  assert.doesNotMatch(renderEntryBody('Plain prose. [unknown]'), /status-label/);
});

test('Framings: one column per variant, headed by name and lens, with differing fields marked and identical ones faded', async () => {
  const page = await mount({ state: variantsState, query: '&view=compare' });
  const markup = page.app.innerHTML;
  assert.match(markup, /data-view-target="compare"[^>]*>Framings</, 'the tab exists while the project holds variants');
  assert.match(markup, /--k:3/);
  for (const v of variantsState.variants) {
    assert.match(markup, new RegExp(`<h2 class="cmp-name">${v.name}</h2><p class="cmp-lens">Lens: ${v.lens.replace(/"/g, '&quot;')}</p>`));
  }
  // The fixture's variants share fields 1, 5, 8 and 9 and word 2, 3, 4, 6 and 7
  // differently (7 is filled in one variant only): 4 rows faded, 5 marked.
  assert.equal((markup.match(/class="field-card cmp-card cmp-same"/g) || []).length, 4 * 3);
  assert.equal((markup.match(/class="field-card cmp-card cmp-diff"/g) || []).length, 5 * 3);
  assert.equal((markup.match(/<span class="diff-tag" aria-hidden="true">Differs<\/span>/g) || []).length, 5 * 3);
  assert.match(markup, /What puzzles us\?<span class="cmp-row-caption">&middot; the same in every framing<\/span>/);
  assert.match(markup, /Who cares, and what do they already know\?<span class="cmp-row-caption">&middot; differs between framings<\/span>/);
  // A card leads with one sentence and keeps the rest of the field one click away.
  assert.match(markup, /<summary>All 3 statements/);
});

test('Framings: a field differs when any statement in it differs, not only the lead', () => {
  const { fieldDiffers } = lift(['variantElement', 'fieldSignature', 'fieldDiffers']);
  const element = (texts) => ({ number: 1, questions: [{ id: '1.1', statements: texts.map((text) => ({ text })) }] });
  const variant = (texts) => ({ state: { elements: [element(texts)] } });
  assert.equal(fieldDiffers([variant(['A', 'B']), variant(['A', 'B'])], 1), false);
  assert.equal(fieldDiffers([variant(['A', 'B']), variant(['A', 'C'])], 1), true, 'the second statement differs under the same lead');
  assert.equal(fieldDiffers([variant(['A']), variant([])], 1), true, 'answered in one, empty in the other');
  assert.equal(fieldDiffers([variant(['A  b']), variant(['A b'])], 1), false, 'whitespace is not a difference');
});

test('Framings: choosing is disabled with a one-line reason while the main canvas holds an accepted or stated statement', async () => {
  const open = await mount({ state: variantsState, query: '&view=compare' });
  assert.doesNotMatch(open.app.innerHTML, /choose-note/);
  assert.equal((open.app.innerHTML.match(/data-action="choose" data-variant="[a-z-]+">/g) || []).length, 3, 'all three buttons are enabled');

  const accepted = await mount({ state: chosenState, query: '&view=compare' });
  assert.equal((accepted.app.innerHTML.match(/data-action="choose" data-variant="[a-z-]+" disabled aria-describedby="choose-note">/g) || []).length, 3);
  assert.match(accepted.app.innerHTML, /<p class="choose-note" id="choose-note">Choosing is off: the main canvas already holds 1 accepted \(1\.2\)\. A framing is chosen before anything is accepted\.<\/p>/);

  // A [stated] statement blocks too (US-3 story log #3), and is named.
  const stated = JSON.parse(JSON.stringify(variantsState));
  statementIn(stated, '1.2', 'tentative').marker = 'stated';
  const said = await mount({ state: stated, query: '&view=compare' });
  assert.match(said.app.innerHTML, /holds 1 said by the authors \(1\.2\)\. A choice would replace what the authors said\./);
  assert.match(said.app.innerHTML, /data-variant="power" disabled/);
});

test('Choose dialog: rejected is prefilled with the other variants and their lenses, the reason is required, and the POST carries both', async () => {
  const page = await mount({
    state: variantsState,
    mode: 'live',
    routes: { '/api/choose': () => ({ status: 200, body: { ok: true } }) },
  });
  page.click({ 'data-action': 'choose', 'data-variant': 'power' });
  assert.equal(page.dlg.open, true);
  assert.match(page.dlg.innerHTML, /Choose the &ldquo;power&rdquo; framing/);
  const prefill = 'rituals (lens: meeting routines and turn-taking); sense-making (lens: collective sense-making: &quot;who hears whom&quot;)';
  assert.ok(page.dlg.innerHTML.includes(`<textarea name="rejected" rows="3">${prefill}</textarea>`));
  assert.match(page.dlg.innerHTML, /<button type="submit" class="action-btn action-btn-primary">Choose this framing<\/button>/);

  await page.submit({ why: '  ', rejected: 'x' });
  assert.match(page.errorBox.textContent, /Say why you choose this framing/);
  assert.equal(page.writes().length, 0, 'an empty reason sends nothing');

  const rejected = 'rituals (lens: meeting routines and turn-taking); sense-making';
  await page.submit({ why: ' Rank is recorded for every meeting. ', rejected });
  const [sent] = page.writes();
  assert.equal(sent.url, '/api/choose');
  assert.equal(sent.opts.headers['X-Harness-Token'], 'T');
  assert.deepEqual(sent.body, { name: 'power', why: 'Rank is recorded for every meeting.', rejected });
  assert.equal(page.dlg.open, false, 'the dialog closes on success');
  assert.equal(page.calls.filter((c) => c.url === '/api/state').length, 2, 'the view reloads the state after a choice');
});

test('Choose dialog: an empty rejected is left out so the server applies its default, and a refusal is shown inside the dialog', async () => {
  const refusal = 'The main canvas already holds 1 [stated] statement, which choosing a framing would delete: 1.2 "Speaking frequency is well documented".';
  const page = await mount({
    state: variantsState,
    mode: 'live',
    routes: { '/api/choose': () => ({ status: 422, body: { ok: false, code: 'already', error: refusal } }) },
  });
  page.click({ 'data-action': 'choose', 'data-variant': 'rituals' });
  await page.submit({ why: 'Routines decide who can propose.', rejected: '   ' });
  assert.deepEqual(page.writes()[0].body, { name: 'rituals', why: 'Routines decide who can propose.' });
  assert.equal(page.errorBox.textContent, refusal, "the server's own message, unchanged");
  assert.equal(page.dlg.open, true, 'the dialog stays open, the typed text with it');
});

test('Accept dialog: the explanation is required, open checks are listed with their #seq, and the button says Accept anyway', async () => {
  const page = await mount({
    state: variantsState,
    mode: 'live',
    routes: { '/api/accept': () => ({ status: 200, body: { ok: true } }) },
  });
  const tentative = statementIn(variantsState, '1.2', 'tentative');
  page.click({ 'data-action': 'accept', 'data-question': '1.2', 'data-hash': tentative.hash });
  const dialogMarkup = page.dlg.innerHTML;
  assert.match(dialogMarkup, /In your own words, why does this hold\?/);
  assert.match(dialogMarkup, /<blockquote class="dlg-quote">Speaking frequency is well documented; whether a proposal is taken up is not\.<\/blockquote>/);
  assert.doesNotMatch(dialogMarkup, /contenteditable/);
  assert.match(dialogMarkup, /<span class="seq">#1<\/span>Does the twelve-meeting corpus hold enough proposals/);
  assert.match(dialogMarkup, /<span class="seq">#2<\/span>Which source says speaking frequency is &quot;well documented&quot;/);
  assert.match(dialogMarkup, />Accept anyway<\/button>/);
  assert.ok(dialogMarkup.indexOf('dlg-checks') < dialogMarkup.indexOf('dlg-actions'), 'the open checks sit above the buttons');

  await page.submit({ explained: '   ', why: '' });
  assert.match(page.errorBox.textContent, /Say in your own words why this holds/);
  assert.equal(page.writes().length, 0, 'a blank explanation sends nothing');

  await page.submit({ explained: ' The fieldnotes show it. ', why: 'the gap' });
  assert.deepEqual(page.writes().map((c) => [c.url, c.body]), [['/api/accept', {
    questionId: '1.2',
    expectedHash: tentative.hash,
    explained: 'The fieldnotes show it.',
    why: 'the gap',
  }]]);
  assert.equal(page.dlg.open, false);
});

test('Accept dialog: without open checks the button reads Accept and no check section is shown', async () => {
  const page = await mount({ state: variantsState, mode: 'live' });
  page.click({ 'data-action': 'accept', 'data-question': '1.1', 'data-hash': statementIn(variantsState, '1.1', 'proposed').hash });
  assert.match(page.dlg.innerHTML, />Accept<\/button>/);
  assert.doesNotMatch(page.dlg.innerHTML, /Accept anyway|dlg-checks/);
});

test('Accept dialog: a refusal of the explanation is shown inside the dialog and a stale statement reloads the state', async () => {
  const tentative = statementIn(variantsState, '1.2', 'tentative');
  const refusal = 'An explanation cannot hold a line that starts with **Why:**.';
  let answer = { status: 422, body: { ok: false, code: 'invalid', error: refusal } };
  const page = await mount({ state: variantsState, mode: 'live', routes: { '/api/accept': () => answer } });
  page.click({ 'data-action': 'accept', 'data-question': '1.2', 'data-hash': tentative.hash });
  await page.submit({ explained: 'text', why: '' });
  assert.equal(page.errorBox.textContent, refusal);
  assert.equal(page.dlg.open, true);
  answer = { status: 409, body: { ok: false, code: 'stale', error: 'stale' } };
  await page.submit({ explained: 'text', why: '' });
  assert.equal(page.dlg.open, false);
  assert.equal(page.calls.filter((c) => c.url === '/api/state').length, 2, 'the stale answer reloads the state');
});

// SQ-170: the accept is written, the dialog closes, and only the reload of the
// state fails. The dialog error box is not on screen any more, so the failure
// has to land in the notice bar or the researcher sees a stale canvas and no
// reason for it.
test('Accept dialog: a reload that fails after the write shows the notice bar, not a hidden dialog error', async () => {
  const tentative = statementIn(variantsState, '1.2', 'tentative');
  let answered = 0;
  const page = await mount({
    state: variantsState,
    mode: 'live',
    routes: {
      '/api/state': () => {
        answered += 1;
        return answered === 1 ? { status: 200, body: variantsState } : { status: 500, body: { ok: false, error: 'boom' } };
      },
      '/api/accept': () => ({ status: 200, body: { ok: true } }),
    },
  });
  page.click({ 'data-action': 'accept', 'data-question': '1.2', 'data-hash': tentative.hash });
  await page.submit({ explained: 'The fieldnotes show it.', why: '' });

  assert.deepEqual(page.writes().map((c) => c.url), ['/api/accept'], 'the accept went through');
  assert.equal(page.dlg.open, false, 'the dialog stayed closed: the accept is recorded');
  assert.equal(page.calls.filter((c) => c.url === '/api/state').length, 2, 'the second state call is the reload that failed');
  assert.equal(page.errorBox.textContent, '', 'nothing is written into the closed dialog');
  assert.equal(page.notice.hidden, false, 'the notice bar is visible');
  assert.match(page.noticeText.textContent, /failed to load state \(500\)/);
});

test('Accept dialog: a failure while the dialog is still open stays inside the dialog', async () => {
  const tentative = statementIn(variantsState, '1.2', 'tentative');
  const page = await mount({
    state: variantsState,
    mode: 'live',
    routes: { '/api/accept': () => ({ status: 500, body: { ok: false } }) },
  });
  page.click({ 'data-action': 'accept', 'data-question': '1.2', 'data-hash': tentative.hash });
  await page.submit({ explained: 'The fieldnotes show it.', why: '' });
  assert.equal(page.dlg.open, true, 'the dialog stays open so the typed text survives');
  assert.equal(page.errorBox.textContent, 'Request failed (500).');
  assert.equal(page.noticeText.textContent, '', 'the notice bar stays quiet while the dialog can speak');
});

test('fixture mode opens a view or a dialog from the URL, and its confirm button writes nothing', async () => {
  const accept = await mount({ state: variantsState, query: '&dialog=accept:1.2' });
  assert.equal(accept.dlg.open, true);
  assert.match(accept.dlg.innerHTML, /Accept anyway/);
  await accept.submit({ explained: 'because', why: '' });
  assert.equal(accept.errorBox.textContent, 'Fixture mode: nothing is written.');
  assert.equal(accept.writes().length, 0);

  const choose = await mount({ state: variantsState, query: '&view=compare&dialog=choose:sense-making' });
  assert.match(choose.dlg.innerHTML, /Choose the &ldquo;sense-making&rdquo; framing/);
  assert.equal(choose.writes().length, 0);
});

test('History shows the framing choice and the explained accept with #seq links that land on their entries', async () => {
  const page = await mount({ state: chosenState, query: '&view=log' });
  const markup = page.app.innerHTML;
  assert.match(markup, /<li class="history-card" id="entry-3" tabindex="-1"><p class="history-meta">#3 &middot; Framing chosen &middot; \d{4}-\d{2}-\d{2} &middot; power<\/p>/);
  assert.match(markup, /Framing power \(lens: power and hierarchy\) chosen; its statements are copied into the main canvas\.<span class="entry-note">Why: Every one of the twelve meetings records rank/);
  assert.match(markup, /<span class="entry-by">By A\. Researcher<\/span>/);
  assert.match(markup, /<span class="entry-note">Rejected: rituals \(lens: meeting routines and turn-taking\); sense-making/);
  assert.match(markup, /<li class="history-card" id="entry-4" tabindex="-1"><p class="history-meta">#4 &middot; Decision &middot; \d{4}-\d{2}-\d{2} &middot; What puzzles us\?<\/p>/);
  assert.match(markup, /<span class="entry-note">Explained: Earlier work counts who speaks/);
  assert.match(markup, /Open at acceptance: <button[^>]*data-scroll-to="entry-1">#1<\/button>, <button[^>]*data-scroll-to="entry-2">#2<\/button>/);
  for (const id of ['entry-1', 'entry-2']) assert.ok(markup.includes(`id="${id}"`), `${id} exists for the link to land on`);
  assert.doesNotMatch(markup.replace(/<[^>]*>/g, ' '), /\*\*/, 'no raw label survives in any view');
});

// SQ-139 (F6 of SQ-132): the state already says which entries verify; the view
// has to say it too, or a forged `framing chosen` reads like the researcher's own.
const brokenState = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'view-state-broken.json'), 'utf8'));
const cardOf = (markup, seq) => markup.match(new RegExp(`<li class="history-card" id="entry-${seq}"[\\s\\S]*?</li>`))[0];

test('History: a changed DECISION carries a visible warning, and the ledger banner names where it breaks', async () => {
  assert.deepEqual(brokenState.decisions.map((d) => d.sealStatus), ['verified', 'verified', 'broken'], 'the fixture is a real broken log');
  const page = await mount({ state: brokenState, query: '&view=log' });
  const markup = page.app.innerHTML;

  const forged = cardOf(markup, 3);
  assert.match(forged, /#3 &middot; Framing chosen &middot; \d{4}-\d{2}-\d{2} &middot; power &middot; Record changed<\/p>/, 'the status word sits in the quiet meta line');
  assert.match(forged, /<p class="seal-flag" role="note"><span aria-hidden="true">&#9888;<\/span> Decision record cannot be confirmed: the saved history changed here: this entry&#39;s heading or text changed\.<\/p>/);
  assert.match(visibleText(forged), /Decision record cannot be confirmed/, 'the marker is text, not only colour');

  assert.match(markup, /<div class="notices-banner" role="alert"><p>Decision history has changed\. The first affected entry is <button type="button" class="seq-link" data-view-target="log" data-scroll-to="entry-3">#3<\/button> \(this entry&#39;s heading or text changed\)\./);
});

// SQ-294 (F3): a key that is not the project's changed no entry, so the banner
// names the key instead of linking to an entry that was never touched.
test('History: a key that is not the project\'s is named as the cause, and the banner links to no entry', async () => {
  const state = JSON.parse(JSON.stringify(brokenState));
  state.review.ledger.broken = { seq: 0, line: 3, why: 'key' };
  state.review.ledger.verified = [];
  state.decisions.forEach((d) => { d.sealStatus = 'broken'; });
  const markup = (await mount({ state, query: '&view=log' })).app.innerHTML;
  assert.match(markup, /<div class="notices-banner" role="alert"><p>Decision history cannot be checked here: the key on this device is not the project&#39;s\.<\/p>/);
  assert.doesNotMatch(markup, /entry-0|data-scroll-to="entry-0"/, 'no link to an entry no key question was asked about');
  assert.doesNotMatch(markup, /the saved record no longer matches/);
  assert.match(cardOf(markup, 3), /Decision record cannot be confirmed: the key on this device is not the project&#39;s\./);
  // The same break in an entry reads as it always did, so the text above is
  // about the key and not about the banner.
  const content = (await mount({ state: brokenState, query: '&view=log' })).app.innerHTML;
  assert.match(content, /The first affected entry is <button[^>]*data-scroll-to="entry-3">#3<\/button>/);
});

test('History: an intact entry has no integrity status or warning, and a verified log has no banner', async () => {
  const broken = await mount({ state: brokenState, query: '&view=log' });
  for (const seq of [1, 2]) {
    const card = cardOf(broken.app.innerHTML, seq);
    assert.doesNotMatch(card, /&middot; verified|seal-flag|Record changed|Cannot check/i);
    assert.doesNotMatch(card, /seal-flag|Decision record cannot be confirmed/i);
  }
  const chosen = await mount({ state: chosenState, query: '&view=log' });
  assert.doesNotMatch(chosen.app.innerHTML, /seal-flag|does not verify|notices-banner/i, 'a verified DECISION (framing or accept) is marked nowhere');
  assert.match(cardOf(chosen.app.innerHTML, 4), /#4 &middot; Decision &middot; \d{4}-\d{2}-\d{2} &middot; What puzzles us\?<\/p>/);
});

test('History: a legacy or unverifiable DECISION is marked too, a legacy DISCOVERY only names its status, and there is no banner without a break', async () => {
  const state = JSON.parse(JSON.stringify(chosenState));
  state.decisions[0].sealStatus = 'legacy';
  state.decisions[2].sealStatus = 'unverifiable';
  state.decisions[3].sealStatus = 'legacy';
  const page = await mount({ state, query: '&view=log' });
  const markup = page.app.innerHTML;
  assert.match(cardOf(markup, 1), /&middot; Older record; cannot check for changes<\/p>/);
  assert.doesNotMatch(cardOf(markup, 1), /seal-flag/);
  assert.match(cardOf(markup, 3), /&middot; Cannot check for changes on this device<\/p><p class="seal-flag"[^>]*><span aria-hidden="true">&#9888;<\/span> Decision record cannot be confirmed: changes cannot be checked on this device\.<\/p>/);
  assert.match(cardOf(markup, 4), /Decision record cannot be confirmed: it predates checks for changes/);
  assert.doesNotMatch(markup, /notices-banner/);
  // A state from before the view read seal status shows nothing extra.
  const older = JSON.parse(JSON.stringify(chosenState));
  older.decisions.forEach((d) => { delete d.sealStatus; });
  delete older.review;
  const plain = await mount({ state: older, query: '&view=log' });
  assert.doesNotMatch(plain.app.innerHTML, /seal-flag|notices-banner|&middot; verified/);
});

// The agenda is the server's now: the tab renders every open field and every
// unanswered question the state carries, and the poster chip counts the same
// list the tab renders.
test('To talk about renders the agenda the server sends: every open field with its findings, every gap question', async () => {
  const page = await mount({ state: variantsState, query: '&view=agenda' });
  const markup = page.app.innerHTML;
  const text = visibleText(markup);
  assert.ok(variantsState.agenda.fields.length, 'the fixture puts a field on the agenda');
  assert.ok(variantsState.agenda.gaps.length, 'the fixture leaves questions unanswered');
  for (const f of variantsState.agenda.fields) {
    assert.match(markup, new RegExp(`id="agenda-field-${f.number}"`), `field ${f.number} is on the tab`);
    assert.ok(text.includes(f.question), `field ${f.number} is named by its human question`);
    for (const d of f.findings) {
      assert.ok(text.includes(visibleText(renderEntryBody(d.body))), `finding #${d.seq} is on the tab`);
    }
    assert.match(markup, new RegExp(`data-scroll-to="agenda-field-${f.number}">${f.findings.length} thing`), `the poster chip counts field ${f.number}'s findings`);
  }
  for (const g of variantsState.agenda.gaps) {
    assert.ok(text.includes(g.text), `${g.questionId} is named as unanswered`);
    assert.match(markup, new RegExp(`class="agenda-gap-item" data-view-target="element-${g.number}"`), `${g.questionId} opens its field`);
  }
});

test('Agenda groups unanswered questions by field below the discussion, collapsed on arrival', async () => {
  const state = structuredClone(variantsState);
  state.agenda.gaps = [
    { number: 2, question: 'Who cares?', questionId: '2.1', text: 'Who reads this?' },
    { number: 9, question: 'Where does it stop?', questionId: '9.1', text: 'What are the limits?' },
    { number: 2, question: 'Who cares?', questionId: '2.2', text: 'What do they know?' },
  ];
  const page = await mount({ state, query: '&view=agenda' });
  const agenda = page.app.innerHTML.match(/<section id="agenda"[\s\S]*?<\/section>/)[0];
  assert.match(agenda, /<details class="agenda-gaps"><summary>Not answered yet <span[^>]*>3 questions in 2 fields<\/span> <span[^>]*>\(expand to see the questions\)<\/span><\/summary>/);
  assert.ok(agenda.indexOf('agenda-list') < agenda.indexOf('agenda-gaps'), 'discussion comes first');
  assert.equal((agenda.match(/class="agenda-gap-field"/g) || []).length, 2, 'one group per field, even for non-adjacent gaps');
  assert.match(agenda, /<strong>Who cares\?<\/strong> <span[^>]*>2 questions<\/span>/);
  assert.match(agenda, /<strong>Where does it stop\?<\/strong> <span[^>]*>1 question<\/span>/);
  assert.equal((agenda.match(/Not answered yet/g) || []).length, 1, 'no repeated prefix');
  for (const text of ['Who reads this?', 'What do they know?', 'What are the limits?']) assert.ok(agenda.includes(text), text);
  assert.doesNotMatch(agenda, /<details[^>]* open/);
});

test('Agenda omits the unanswered group when all questions have answers', async () => {
  const state = structuredClone(variantsState);
  state.agenda = { fields: [], gaps: [] };
  const page = await mount({ state, query: '&view=agenda' });
  const agenda = page.app.innerHTML.match(/<section id="agenda"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(agenda, /agenda-gaps/);
  assert.match(agenda, /Nothing to talk about right now/);
});

test('statement text is never editable in the view, and a state without variants shows no Framings tab', async () => {
  const page = await mount({ state: variantsState, query: '&view=compare' });
  assert.doesNotMatch(page.app.innerHTML, /<textarea|contenteditable|<input/);
  assert.doesNotMatch(html, /contenteditable/);
  const plain = await mount({ state: viewState, query: '&view=compare' });
  assert.doesNotMatch(plain.app.innerHTML, /data-view-target="compare"|id="compare"/, 'an older or variant-free state has no comparison');
  assert.match(plain.app.innerHTML, /id="poster"/);
});

test('canvas.html reads By as an entry field, so it is never shown as raw body text', () => {
  assert.match(html, /ENTRY_LABEL = \/\^\\\*\\\*\(By\|Why\|/);
});

// Task 9: real viewState output, not hand-written dashboard state. Dropping a
// name renderer, filtering the shared agenda, or stripping the entire hash
// must fail these tests. Each marker deliberately starts with a field number.
function namesFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-view-names-'));
  const saved = Object.fromEntries(['PLACET_RESEARCH_DIR', 'PLACET_RESEARCH_STATE_DIR'].map((k) => [k, process.env[k]]));
  try {
    const research = path.join(root, 'research');
    fs.mkdirSync(research);
    const canvas = fs.readFileSync(path.join(__dirname, 'fixtures', 'voice-uptake', 'research', 'canvas.md'), 'utf8');
    fs.writeFileSync(path.join(research, 'canvas.md'), canvas.replace(
      'Speaking frequency is well documented; whether a proposal is taken up is not. [stated]',
      'Speaking frequency is well documented; whether a proposal is taken up is not. [accepted]',
    ));
    process.env.PLACET_RESEARCH_DIR = 'research';
    process.env.PLACET_RESEARCH_STATE_DIR = path.join(root, 'state');
    fs.mkdirSync(process.env.PLACET_RESEARCH_STATE_DIR);
    fs.writeFileSync(path.join(process.env.PLACET_RESEARCH_STATE_DIR, 'name'), 'A. Researcher\n');
    const entries = [
      { kind: 'DISCOVERY', ref: '2 Audience', body: 'Ask A about prior work.', by: 'A. Researcher' },
      { kind: 'DISCOVERY', ref: '2 Audience', body: 'Ask B about assumptions.', by: 'B. Supervisor' },
      { kind: 'DISCOVERY', ref: '2 Audience', body: 'An older unnamed finding.' },
      { kind: 'SESSION', ref: '2 October supervision', body: 'Session started.', by: 'A. Researcher' },
      { kind: 'MERGE', ref: 'from 2 clone', body: 'Replayed entries 6, 7.\nAnother detail.', by: 'A. Researcher' },
    ];
    fs.writeFileSync(path.join(research, 'decisions.md'), header('names-fixture') + entries.map((e, i) => formatEntry({ seq: i + 1, date: '2026-10-02', ...e })).join('\n'));
    const result = buildViewState(root, path.resolve(__dirname, '..'));
    assert.equal(result.ok, true, result.error);
    return result.body;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const namesState = namesFixture();
const sectionOf = (page, id) => page.app.innerHTML.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`))[0];
const filterButtons = (page) => [...sectionOf(page, 'log').matchAll(/<button[^>]*data-by="([^"]*)"[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)]
  .map((m) => ({ by: m[1], pressed: m[2], label: m[3] }));
const historySeqs = (page) => [...sectionOf(page, 'log').matchAll(/class="history-card" id="entry-(\d+)"/g)].map((m) => Number(m[1]));

// 1. An author line in all three entry consumers; no duplicate body-field By.
test('Names: History, field findings and agenda show one quiet name line, or bare unknown', async () => {
  const page = await mount({ state: namesState });
  for (const id of ['log', 'element-2', 'agenda']) {
    const markup = sectionOf(page, id);
    for (const label of ['By A. Researcher', 'By B. Supervisor', 'unknown']) {
      assert.ok(markup.includes(`class="entry-by">${label}</`), `${id}: ${label}`);
    }
    assert.doesNotMatch(visibleText(markup), /By unknown|By:|\*\*By/);
  }
  const field = sectionOf(page, 'element-2');
  assert.equal((field.match(/class="entry-by"/g) || []).length, 3, 'one line per finding');
});

// 2. Markers are not findings, even when their refs start with a field number.
test('Names: SESSION is a dated separator and MERGE is a quiet summary, neither a finding', async () => {
  const page = await mount({ state: namesState, query: '&view=log' });
  const log = sectionOf(page, 'log');
  assert.match(log, /role="separator"[^>]*>[\s\S]*?Session: 2 October supervision &middot; 2026-10-02/);
  assert.match(log, /class="merge-line">Merged from 2 clone &mdash; Replayed entries 6, 7\./);
  assert.deepEqual(historySeqs(page), [1, 2, 3], 'markers are not cards');
  assert.doesNotMatch(log, /Another detail\./, 'only the first merge body line is shown');
  for (const id of ['element-2', 'agenda']) {
    assert.doesNotMatch(sectionOf(page, id), /Session started|Replayed entries|2 October supervision/);
  }
});

// 3. Accessibility: one active name; All on first load.
test('Names: the History filter offers All, both names and unknown with exactly one pressed button', async () => {
  const page = await mount({ state: namesState, query: '&view=log' });
  assert.match(sectionOf(page, 'log'), /class="by-filter" role="group" aria-label="Show entries by"/);
  assert.deepEqual(filterButtons(page).map((b) => [b.label, b.pressed]), [
    ['All', 'true'], ['A. Researcher', 'false'], ['B. Supervisor', 'false'], ['unknown', 'false'],
  ]);
});

// 4. The entry lists narrow; the shared agenda and status/count consumers do not.
test('Names: choosing B narrows History and field findings without changing agenda, poster or badges', async () => {
  const page = await mount({ state: namesState, query: '&view=log' });
  const before = Object.fromEntries(['agenda', 'poster', 'element-1'].map((id) => [id, sectionOf(page, id)]));
  assert.ok(namesState.elements.some((e) => e.status.status === 'accepted'), 'fixture includes an accepted field');
  page.click({ 'data-by': 'B. Supervisor' });
  assert.deepEqual(historySeqs(page), [2]);
  assert.match(sectionOf(page, 'log'), /role="separator"/);
  assert.doesNotMatch(sectionOf(page, 'log'), /Merged from/);
  const field = sectionOf(page, 'element-2');
  assert.match(field, /Ask B about assumptions/);
  assert.doesNotMatch(field, /Ask A about prior work|An older unnamed finding/);
  for (const id of Object.keys(before)) assert.equal(sectionOf(page, id), before[id], `${id} stays unchanged`);
  assert.deepEqual(filterButtons(page).filter((b) => b.pressed === 'true').map((b) => b.label), ['B. Supervisor']);
});

// 5. The fragment is the only persistent state; fixture query survives too.
test('Names: clicking B writes the encoded fragment and reload restores that filter', async () => {
  const page = await mount({ state: namesState, query: '&view=log' });
  page.click({ 'data-by': 'B. Supervisor' });
  assert.equal(page.location.hash, '#by=B.%20Supervisor');
  assert.equal(page.location.search, '?fixture=/fixture.json&view=log');
  const reloaded = await mount({ state: namesState, query: '&view=log', hash: page.location.hash });
  assert.deepEqual(historySeqs(reloaded), [2]);
  assert.deepEqual(filterButtons(reloaded).filter((b) => b.pressed === 'true').map((b) => b.label), ['B. Supervisor']);
});

// 6. Trading c= must not erase by=; a code-free live reload is filtered too.
test('Names: stripping the single-use code preserves by and applies it before and after a live reload', async () => {
  const page = await mount({ state: namesState, mode: 'live', hash: '#c=abc123&by=B.%20Supervisor' });
  assert.equal(page.location.hash, '#by=B.%20Supervisor');
  assert.deepEqual(historySeqs(page), [2]);
  assert.deepEqual(page.calls.find((c) => c.url === '/api/session').body, { code: 'abc123' });
  const reloaded = await mount({ state: namesState, mode: 'live', hash: page.location.hash });
  assert.deepEqual(historySeqs(reloaded), [2]);
  assert.equal(reloaded.calls.some((c) => c.url === '/api/session'), false, 'a reload does not redeem again');
});

// 7. No browser storage; unknown and All follow the same delegated DOM path.
test('Names: unknown and All filter without browser storage and an absent name leaves All active', async () => {
  const page = await mount({ state: namesState });
  page.click({ 'data-by': 'unknown' });
  assert.equal(page.location.hash, '#by=unknown');
  assert.deepEqual(historySeqs(page), [3]);
  assert.deepEqual(filterButtons(page).filter((b) => b.pressed === 'true').map((b) => b.label), ['unknown']);
  page.click({ 'data-by': '' });
  assert.equal(page.location.hash, '');
  assert.deepEqual(historySeqs(page), [1, 2, 3]);
  const absent = await mount({ state: namesState, hash: '#by=Nobody' });
  assert.deepEqual(filterButtons(absent).filter((b) => b.pressed === 'true').map((b) => b.label), ['All']);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
});

// Browser checks use live session routes: fixture mode suppresses statement actions.
const { chromium: keyboardChromium, launchChromium, focusContrastRatios } = require('./helpers/a11y');
for (const colorScheme of ['light', 'dark']) {
  test('Field navigation polish across window widths in ' + colorScheme, { skip: !keyboardChromium, timeout: 120000 }, async (t) => {
    const browser = await launchChromium();
    t.after(() => browser.close());
    const page = await browser.newPage({ colorScheme });
    await page.route('http://session.test/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith('/fonts/')) return route.fulfill({ path: path.join(__dirname, '../dashboard', pathname) });
      if (pathname === '/api/session') return route.fulfill({ json: { ok: true, token: 'T' } });
      return route.fulfill({ contentType: pathname === '/api/state' ? 'application/json' : 'text/html', body: pathname === '/api/state' ? JSON.stringify(variantsState) : html });
    });
    await page.goto('http://session.test/#c=abc123');
    await page.locator('#poster.active').waitFor();
    assert.equal(await page.locator('#notice').isVisible(), false, 'the authenticated fixture starts without a session-link error');
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1440, 1024, 900, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const chips = page.locator('#fieldnav .chip');
      assert.equal(await chips.count(), 9);
      for (const chip of await chips.all()) {
        const title = await chip.getAttribute('title');
        assert.ok(title, 'number-only fields keep their hover name');
        assert.ok((await chip.getAttribute('aria-label')).includes(title), 'number-only fields keep their screen-reader name');
      }
      const name = page.locator('#fieldnav [data-chip="8"] .chip-name');
      if (width === 1440) {
        assert.equal(await name.innerText(), 'Contributions');
        assert.equal(await name.evaluate((n) => getComputedStyle(n).whiteSpace), 'nowrap', 'Contributions cannot strand its last letter on another line');
        assert.equal(await name.evaluate((n) => n.scrollWidth <= n.clientWidth), true, 'Contributions fits in full at desktop width');
      }
      const empty = page.locator('#fieldnav .chip.empty').first();
      const ink = await empty.evaluate((n) => ({ text: getComputedStyle(n).color, border: getComputedStyle(n).borderTopColor, ink: getComputedStyle(document.body).color, style: getComputedStyle(n).borderTopStyle }));
      assert.equal(ink.text, ink.ink, 'empty fields use active ink, not disabled grey');
      assert.equal(ink.border, ink.ink);
      assert.equal(ink.style, 'dashed', 'the pinned empty-field marker stays');
      await empty.focus();
      const ratios = await focusContrastRatios(page);
      assert.ok(ratios.every((r) => r.ratio >= 3), 'visible-control keyboard focus has sufficient contrast');
      const sizes = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.equal(sizes[0], sizes[1], 'fields reflow without horizontal page scroll at ' + width);
      if (process.env.SESSION_A11Y_CAPTURE_DIR) {
        fs.mkdirSync(process.env.SESSION_A11Y_CAPTURE_DIR, { recursive: true });
        await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
        await page.screenshot({ path: path.join(process.env.SESSION_A11Y_CAPTURE_DIR, colorScheme + '-fields-' + width + '.png') });
      }
    }
    for (const view of ['agenda', 'log']) {
      await page.locator('#view-tabs [data-view-target="' + view + '"]').click();
      assert.equal(await page.locator('#fieldnav').isVisible(), false, 'Fields is absent on ' + view);
    }
    await page.locator('#view-tabs [data-view-target="agenda"]').click();
    const gaps = page.locator('.agenda-gaps');
    const summary = gaps.locator(':scope > summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await gaps.getAttribute('open'), '', 'question count expands with the keyboard');
    const fieldSummary = gaps.locator('details > summary').first();
    await fieldSummary.click();
    assert.ok(await gaps.getByRole('button').first().isVisible(), 'the count leads to the actual questions by field');
    await page.locator('#view-tabs [data-view-target="poster"]').click();
    assert.equal(await page.locator('#fieldnav').isVisible(), true, 'Fields returns on Poster');
  });

  test('live keyboard navigation, dialog errors and return focus in ' + colorScheme, { skip: !keyboardChromium, timeout: 120000 }, async (t) => {
    const browser = await launchChromium();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 320, height: 720 }, colorScheme });
    const writes = [];
    page.on('pageerror', (err) => t.diagnostic('pageerror: ' + err.message));
    let refuse = true;
    await page.route('http://session.test/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let body = html;
      let status = 200;
      if (pathname === '/api/state') body = variantsState;
      else if (pathname === '/api/session') body = { ok: true, token: 'T' };
      else if (pathname.startsWith('/api/')) {
        writes.push({ pathname, payload: route.request().postDataJSON() });
        status = refuse ? 400 : 200;
        body = refuse ? { error: 'Please explain this decision without a status marker.' } : { ok: true };
      }
      return route.fulfill({ status, contentType: typeof body === 'string' ? 'text/html' : 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) });
    });
    await page.goto('http://session.test/#c=abc123');
    await page.waitForSelector('#poster.active');
    const posterLink = page.locator('#view-tabs [data-view-target="poster"]');
    assert.equal(await posterLink.getAttribute('aria-current'), 'page', 'active view is identified as the current page, not a toggle');
    assert.equal(await posterLink.evaluate((node) => node.tagName), 'A', 'view navigation uses links');
    await page.locator('#poster [data-view-target="element-1"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#element-1.active');
    assert.equal(await page.locator('#element-1 h1').evaluate((node) => node === document.activeElement), true, 'poster to element places focus on the field heading');
    for (const view of ['poster', 'agenda', 'log', 'compare']) {
      const link = page.locator('#view-tabs [data-view-target="' + view + '"]');
      await link.focus();
      await page.keyboard.press('Enter');
      assert.equal(await link.getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#' + view + '.active h1').count(), 1, 'each reading view has one top-level heading');
      const hierarchy = await page.locator('#' + view + '.active').evaluate((section) => [...section.querySelectorAll('h1,h2,h3,h4')].map((node) => Number(node.tagName.slice(1))));
      for (let i = 1; i < hierarchy.length; i++) assert.ok(hierarchy[i] <= hierarchy[i - 1] + 1, 'reading headings do not skip a level');
      if (process.env.SESSION_A11Y_CAPTURE_DIR) {
        fs.mkdirSync(process.env.SESSION_A11Y_CAPTURE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SESSION_A11Y_CAPTURE_DIR, colorScheme + '-' + view + '-320.png') });
      }
    }
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#stage').evaluate((node) => node === document.activeElement), true, 'skip link reaches the current reading landmark even when poster is hidden');
    const choose = page.locator('#compare button[data-action="choose"]').first();
    await choose.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#dlg textarea[name="why"]').evaluate((node) => node === document.activeElement), true, 'choose opens on the required labelled field');
    await page.keyboard.press('Escape');
    assert.equal(await choose.evaluate((node) => node === document.activeElement), true, 'Escape returns to the framing invoker');
    await page.keyboard.press('Enter');
    await page.locator('#dlg button[type="submit"]').click();
    assert.equal(await page.locator('#dlg [name="why"]').getAttribute('aria-invalid'), 'true', 'choose validation identifies its required field');
    assert.equal(await page.locator('#dlg [name="why"]').getAttribute('aria-describedby'), 'dlg-error');
    await page.keyboard.press('Escape');
    await page.locator('#view-tabs [data-view-target="poster"]').click();
    await page.locator('#poster [data-view-target="element-1"]').first().click();
    const accept = page.locator('#element-1 button[data-action="accept"]').first();
    await accept.focus();
    await page.keyboard.press('Enter');
    const input = page.locator('#dlg [name="explained"]');
    assert.equal(await input.evaluate((node) => node === document.activeElement), true, 'accept opens on its required field');
    assert.ok(await input.evaluate((node) => node.labels.length > 0), 'accept field has an accessible label');
    await page.locator('#dlg button[type="submit"]').click();
    assert.equal(await input.getAttribute('aria-invalid'), 'true', 'required-sentence validation identifies its field');
    assert.equal(await input.getAttribute('aria-describedby'), 'dlg-error', 'validation error is associated with the field');
    assert.equal(await input.evaluate((node) => node === document.activeElement), true, 'error puts focus on the field that needs correction');
    assert.equal(writes.length, 0, 'empty required fields do not write');
    if (process.env.SESSION_A11Y_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.SESSION_A11Y_CAPTURE_DIR, colorScheme + '-accept-error-320.png') });
    const bounds = await input.evaluate((node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: innerHeight }; });
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height, 'required field is fully visible in a narrow modal');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => document.activeElement === document.body || document.querySelector('#dlg').contains(document.activeElement)), 'Tab never reaches the inert app');
    }
    await page.keyboard.press('Escape');
    assert.equal(await accept.evaluate((node) => node === document.activeElement), true, 'Escape returns to the statement invoker');
    await page.keyboard.press('Enter');
    await input.fill('The evidence supports our claim.');
    await page.locator('#dlg button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('.dlg-error').textContent.includes('status marker'));
    assert.equal(await input.getAttribute('aria-invalid'), 'true', 'server refusal remains associated with the required sentence');
    assert.equal(await input.inputValue(), 'The evidence supports our claim.', 'server refusal preserves the researcher text');
    refuse = false;
    await page.locator('#dlg button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('#dlg').open && document.activeElement === document.querySelector('#element-1 h1'));
    const note = page.locator('#element-1 textarea[data-comment-body-for]');
    await page.locator('#element-1 button[data-action="comment"]').click();
    assert.equal(await note.getAttribute('aria-invalid'), 'true', 'inline note errors identify the required textarea');
    const errorId = await note.getAttribute('aria-describedby');
    assert.ok(await page.locator('#' + errorId).textContent(), 'inline note error is associated and visible');
    await note.fill('Discuss scope at the meeting.');
    await page.locator('#element-1 button[data-action="comment"]').click();
    await page.waitForFunction(() => document.activeElement === document.querySelector('#element-1 h1'));
    await page.locator('#element-1 button[data-action="stated"]').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement === document.querySelector('#element-1 h1'));
    assert.ok(writes.some((write) => write.pathname === '/api/stated'), 'direct mark-as-said remains keyboard operable');
    assert.ok(writes.some((write) => write.pathname === '/api/comment' && write.payload.body === 'Discuss scope at the meeting.'), 'inline note saves through its existing endpoint');
    const focus = await page.locator('#element-1 h1').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const stage = document.querySelector('#stage').getBoundingClientRect();
      const css = getComputedStyle(node);
      return { top: rect.top, bottom: rect.bottom, stageTop: stage.top, stageBottom: stage.bottom, outline: css.outlineWidth };
    });
    assert.ok(focus.top >= focus.stageTop && focus.bottom <= focus.stageBottom, 'returned focus is not obscured by rail or scroll boundaries');
    assert.equal(focus.outline, '3px', 'returned heading has a visible focus indicator');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#element-1 button[data-action="accept"]').first().focus();
    await page.keyboard.press('Enter');
    await page.locator('#dlg [name="explained"]').focus();
    if (process.env.SESSION_A11Y_CAPTURE_DIR) await page.screenshot({ path: path.join(process.env.SESSION_A11Y_CAPTURE_DIR, colorScheme + '-accept-1440.png') });
    await page.locator('#dlg button[data-dlg="cancel"]').click();
    assert.equal(await page.locator('#element-1 button[data-action="accept"]').first().evaluate((node) => node === document.activeElement), true, 'Cancel returns focus to the original accept control');
    // The focus ring surrounds each control on its containing surface, not its fill.
    await page.evaluate(() => { document.querySelector('#notice').hidden = false; });
    await page.keyboard.press('Tab');
    const ratios = await focusContrastRatios(page);
    for (const item of ratios) assert.ok(item.ratio >= 3, item.label + ': focus contrast >= 3:1 (' + item.ratio.toFixed(2) + ')');
    t.diagnostic('lowest visible-control focus contrast ' + Math.min(...ratios.map((item) => item.ratio)).toFixed(2) + ':1');
  });
}

// The change mark: on a statement that differs from the view's previous state
// read, never on the first read, never a toast, and a name only where the state
// names one (an accepted statement carries its accepter in the log).
test('Change mark: "New · just now" on a statement changed since the last read, a name only for an accepted one, cleared by the next read, never a notice', async () => {
  const before = structuredClone(viewState);
  const questions = (s) => s.elements.flatMap((e) => e.questions);
  const q = questions(before).find((x) => x.statements.some((s) => s.marker === 'tentative' || s.marker === 'proposed'));
  const target = q.statements.find((s) => s.marker === 'tentative' || s.marker === 'proposed');
  const stated = structuredClone(before);
  questions(stated).find((x) => x.id === q.id).statements.find((s) => s.text === target.text).marker = 'stated';
  const accepted = structuredClone(stated);
  questions(accepted).find((x) => x.id === q.id).statements.find((s) => s.text === target.text).marker = 'accepted';
  accepted.decisions.push({ seq: 90, kind: 'DECISION', ref: `${q.id} accepted`, date: '2026-10-15', body: `${target.text} [accepted]`, by: 'B. Supervisor', explained: 'Because I say so.', sealStatus: 'verified' });
  const reads = [before, stated, accepted, accepted];
  let n = 0;
  const page = await mount({ state: before, mode: 'live', routes: { '/api/state': () => ({ status: 200, body: reads[Math.min(n++, reads.length - 1)] }), '/api/stated': { ok: true } } });
  const marks = () => page.app.innerHTML.match(/<span class="newmark">[^<]*<\/span>/g) || [];
  const act = async () => { page.click({ 'data-action': 'stated', 'data-question': q.id, 'data-hash': target.hash }); await settle(); };
  assert.deepEqual(marks(), [], 'the first read marks nothing');
  await act();
  assert.deepEqual(marks(), ['<span class="newmark">New &middot; just now</span>'], 'no author in the state, so none is shown');
  await act();
  assert.deepEqual(marks(), ['<span class="newmark">New &middot; B. Supervisor &middot; just now</span>'], 'the log names who accepted');
  await act();
  assert.deepEqual(marks(), [], 'the next read without a change clears the mark');
  assert.equal(page.notice.hidden, true, 'no toast or notice for a change');
});

test('Field chips carry number and name: tooltip and accessible name for every field, width by statement count, empty fields dashed', async () => {
  const page = await mount({ state: viewState });
  const nav = page.app.innerHTML.match(/<nav id="fieldnav"[\s\S]*?<\/nav>/)[0];
  for (const e of viewState.elements) {
    const count = e.questions.reduce((sum, q) => sum + q.statements.length, 0);
    const chip = nav.match(new RegExp(`<li style="--n:(\\d+)"><a class="chip( empty)?[^"]*"[^>]*data-chip="${e.number}"[^>]*>`));
    assert.ok(chip, `field ${e.number} has a chip`);
    assert.equal(Number(chip[1]), count, `field ${e.number}: chip width follows its ${count} statements`);
    assert.equal(Boolean(chip[2]), count === 0, `field ${e.number}: dashed exactly when empty`);
    assert.match(chip[0], new RegExp(`title="${e.title.replace(/&/g, '&amp;')}"`), `field ${e.number}: tooltip carries the name`);
    assert.match(chip[0], new RegExp(`aria-label="${e.number} ${e.title.replace(/&/g, '&amp;')}, `), `field ${e.number}: the accessible name starts with number and name`);
  }
});

test('a statement number is addressable by fragment and survives the code redemption', async () => {
  const live = await mount({ state: viewState, mode: 'live', hash: '#c=abc123&st-3.1' });
  assert.equal(live.location.hash, '#st-3.1', 'the code is stripped, the statement address stays');
  assert.match(live.app.innerHTML, /id="st-1\.1"/);
  assert.match(live.app.innerHTML, /<a class="sid" href="#st-1\.1" aria-label="Statement 1\.1">1\.1<\/a>/);
});

// Embedded in the app's shell, the view takes its token and its tab from the
// shell by message. Only its own parent, from its own origin, may speak to it.
async function embeddedViewPage(t, shellScript) {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const context =await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await context.newPage();
  const seen = { writes: [], stateReads: 0, sessions: 0 };
  page.on('pageerror', (err) => t.diagnostic('pageerror: ' + err.message));
  const shell = '<!doctype html><title>shell</title><iframe id="view" src="/" title="Session view" style="width:900px;height:700px"></iframe>'
    + '<iframe id="other" src="/blank" title="Other" style="width:10px;height:10px"></iframe><script>' + shellScript + '</script>';
  const answer = (route, status, body, type) => route.fulfill({ status, contentType: type, body: typeof body === 'string' ? body : JSON.stringify(body) });
  await context.route('http://session.test/**', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/state') { seen.stateReads += 1; return answer(route, 200, variantsState, 'application/json'); }
    if (pathname === '/api/session') { seen.sessions += 1; return answer(route, 200, { ok: true, token: 'T-from-shell' }, 'application/json'); }
    if (pathname.startsWith('/api/')) {
      seen.writes.push({ pathname, token: request.headers()['x-harness-token'], payload: request.postDataJSON() });
      return answer(route, 200, { ok: true }, 'application/json');
    }
    if (pathname === '/blank') return answer(route, 200, '<!doctype html><title>blank</title>', 'text/html');
    if (pathname === '/shell') return answer(route, 200, shell, 'text/html');
    return answer(route, 200, html, 'text/html');
  });
  return { page, context, seen };
}

const viewFrame = (page) => page.frames().find((f) => f.url() === 'http://session.test/');
// The tab's label, without the count badge some tabs carry.
const activeTab = async (frame) => (await frame.locator('#view-tabs [aria-current="page"]').evaluate((a) => a.firstChild.textContent)).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tellView = (target, message, origin) => target.evaluate(([m, o]) => document.getElementById('view').contentWindow.postMessage(m, o === '*' ? '*' : location.origin), [message, origin]);

test('embedded in the shell: the view announces itself, takes its token and tab from the shell, and reads state on refresh', { skip: !keyboardChromium, timeout: 120000 }, async (t) => {
  // The shell redeems its own code, then answers the view's ready message.
  const { page, seen } = await embeddedViewPage(t, `
    window.log = [];
    window.addEventListener('message', async (event) => {
      window.log.push([event.origin, event.data && event.data.type]);
      if (!event.data || event.data.type !== 'harness-ready' || event.source !== document.getElementById('view').contentWindow) return;
      const res = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'abc123' }) });
      const { token } = await res.json();
      event.source.postMessage({ type: 'harness-token', token }, location.origin);
      event.source.postMessage({ type: 'harness-tab', tab: 'to-talk-about' }, location.origin);
    });`);
  await page.goto('http://session.test/shell');
  const frame = viewFrame(page);
  await frame.waitForSelector('#agenda.active');
  assert.deepEqual(await page.evaluate(() => window.log), [['http://session.test', 'harness-ready']], 'the view announces itself once, from its own origin');
  assert.equal(await activeTab(frame), 'To talk about', 'the shell switched the view to To talk about');
  assert.equal(await frame.locator('#notice').evaluate((n) => n.hidden), true, 'no "link already used" notice: the view never tried to redeem a code');
  assert.equal(seen.sessions, 1, 'only the shell redeemed a code');

  // Accept sits on the poster and the field views; the agenda only points to them.
  await tellView(page, { type: 'harness-tab', tab: 'poster' });
  await frame.waitForSelector('#poster.active');
  await frame.locator('#poster button[data-action="accept"]').first().click();
  assert.equal(await frame.locator('#dlg').evaluate((dlg) => dlg.open), true, 'Accept opens the sentence dialog');
  await frame.locator('#dlg textarea[name="explained"]').fill('The fieldnotes show it.');
  await frame.locator('#dlg button[type="submit"]').click();
  await frame.waitForFunction(() => !document.getElementById('dlg').open);
  assert.equal(seen.writes.length, 1);
  assert.equal(seen.writes[0].pathname, '/api/accept');
  assert.equal(seen.writes[0].token, 'T-from-shell', 'the write carries the token the shell sent');

  const reads = seen.stateReads;
  await tellView(page, { type: 'harness-refresh' });
  for (let i = 0; i < 50 && seen.stateReads === reads; i += 1) await pause(20);
  assert.equal(seen.stateReads, reads + 1, 'harness-refresh reads /api/state now');

  await tellView(page, { type: 'harness-tab', tab: 'history' });
  await frame.waitForSelector('#log.active');
  assert.equal(await activeTab(frame), 'History');
  await tellView(page, { type: 'harness-tab', tab: 'constructor' });
  await tellView(page, { type: 'harness-tab', tab: 'compare' });
  await pause(100);
  assert.equal(await activeTab(frame), 'History', 'a tab name the shell does not use changes nothing');
});

test('embedded in the shell: a message from another origin or another window changes nothing', { skip: !keyboardChromium, timeout: 120000 }, async (t) => {
  // This shell never answers the view: any token the view ends up with came from a stranger.
  const { page, context, seen } = await embeddedViewPage(t, '');
  await page.goto('http://session.test/shell');
  const frame = viewFrame(page);
  await frame.waitForSelector('#poster.active');
  const messages = [{ type: 'harness-token', token: 'T-stolen' }, { type: 'harness-tab', tab: 'history' }, { type: 'harness-refresh' }];
  const readsBefore = seen.stateReads;

  // Another window, same origin: a sibling frame is not the view's parent.
  const other = page.frames().find((f) => f.url() === 'http://session.test/blank');
  await other.evaluate((list) => { const view = window.parent.frames[0]; list.forEach((m) => view.postMessage(m, location.origin)); }, messages);

  // Another origin: a data: page that embeds the view is its parent, but not its origin.
  const outsider = await context.newPage();
  await outsider.goto('data:text/html,' + encodeURIComponent('<iframe id="view" src="http://session.test/"></iframe>'));
  const embedded = outsider.frames().find((f) => f.url() === 'http://session.test/');
  await embedded.waitForSelector('#poster.active');
  const readsMid = seen.stateReads;
  for (const m of messages) await tellView(outsider, m, '*');
  await pause(300);

  assert.equal(await activeTab(frame), 'Poster', 'a sibling window cannot switch the tab');
  assert.equal(await activeTab(embedded), 'Poster', 'another origin cannot switch the tab');
  assert.equal(seen.stateReads, readsMid, 'neither can make the view read state');
  assert.equal(readsMid - readsBefore, 1, 'the only extra read is the outsider view loading itself');
  // Neither stranger gave the view a token: a write is refused in the view and never sent.
  for (const target of [frame, embedded]) {
    await target.locator('#poster button[data-action="stated"]').first().click({ force: true });
    await pause(200);
    assert.equal(await target.locator('#notice').evaluate((n) => n.hidden), false, 'the view says it has no session');
  }
  assert.deepEqual(seen.writes, [], 'no write reached the server');
});

test('embedded in the shell: a tab named before the canvas has loaded raises no error and still holds', { skip: !keyboardChromium, timeout: 120000 }, async (t) => {
  // The shell names the tab as soon as the view is ready, and the state answer is held
  // back, so the view has drawn nothing yet when the tab arrives.
  const { page } = await embeddedViewPage(t, `
    window.addEventListener('message', (event) => {
      if (!event.data || event.data.type !== 'harness-ready' || event.source !== document.getElementById('view').contentWindow) return;
      event.source.postMessage({ type: 'harness-tab', tab: 'to-talk-about' }, location.origin);
    });`);
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.route('http://session.test/api/state', async (route) => { await pause(500); return route.fallback(); });
  await page.goto('http://session.test/shell');
  const frame = viewFrame(page);
  await frame.waitForSelector('#agenda.active');
  assert.equal(await activeTab(frame), 'To talk about', 'the early tab holds once the canvas is drawn');
  assert.deepEqual(errors, [], 'the early tab raised no error in the view');
});
