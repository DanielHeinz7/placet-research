'use strict';
// The agent column: Claude Code's own terminal, the frame around it in the
// galley-proof world, and the first-run steps. Statement numbers in the
// output become links once the session view confirms they exist.
(function () {
  var host = window.agentColumn;
  var links = window.statementLinks;
  var $ = function (id) { return document.getElementById(id); };
  var state = null;

  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  function theme() {
    var s = getComputedStyle(document.documentElement);
    var v = function (n) { return s.getPropertyValue(n).trim(); };
    return {
      background: v('--paper'), foreground: v('--ink'), cursor: v('--ink'), selectionBackground: v('--line'),
      scrollbarSliderBackground: v('--line'), scrollbarSliderHoverBackground: v('--edge'), scrollbarSliderActiveBackground: v('--ink-2'),
    };
  }

  var term = new window.Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 13, theme: theme(),
    screenReaderMode: false, allowProposedApi: false, macOptionIsMeta: true, scrollback: 5000,
  });
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('term'));
  window.__term = term;
  dark.addEventListener('change', function () { term.options.theme = theme(); });

  term.onData(function (d) { host.write(d); });
  term.onResize(function (size) { host.resize(size.cols, size.rows); });
  new ResizeObserver(function () { if (!$('term-wrap').hidden) fit.fit(); }).observe($('term-wrap'));
  // Tab stays the terminal's; Ctrl+` leaves it (the app menu has the same key).
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type === 'keydown' && e.ctrlKey && e.key === '`') { host.focusView(); return false; }
    return true;
  });

  host.onData(function (d) { term.write(d); });
  host.onClear(function () { term.reset(); });
  host.onFocus(function () { if (!$('term-wrap').hidden) term.focus(); else { var b = document.querySelector('#panel .btn'); if (b) b.focus(); } });

  // -- Statement links ------------------------------------------------------
  var tip = $('tip');
  term.registerLinkProvider({
    provideLinks: function (y, callback) {
      var line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      var cells = [];
      for (var x = 0; x < line.length; x++) {
        var c = line.getCell(x);
        cells.push({ chars: c ? c.getChars() : '', width: c ? c.getWidth() : 1 });
      }
      var mapped = links.mapToCells(cells);
      var tokens = links.findStatementTokens(mapped.text);
      if (!tokens.length) return callback(undefined);
      Promise.all(tokens.map(function (tok) { return host.lookup(tok.num).then(function (words) { return { tok: tok, words: words }; }); })).then(function (found) {
        var out = found.filter(function (f) { return f.words; }).map(function (f) {
          return {
            range: { start: { x: mapped.cellAt[f.tok.start] + 1, y: y }, end: { x: mapped.cellAt[f.tok.end - 1] + 1, y: y } },
            text: f.tok.num,
            decorations: { underline: true, pointerCursor: true },
            activate: function () { tip.hidden = true; host.reveal(f.tok.num); },
            hover: function (event) {
              tip.textContent = f.tok.num + ' · ' + f.words;
              tip.hidden = false;
              tip.style.left = Math.max(8, Math.min(event.clientX + 12, window.innerWidth - tip.offsetWidth - 8)) + 'px';
              tip.style.top = (event.clientY + 16) + 'px';
            },
            leave: function () { tip.hidden = true; },
          };
        });
        callback(out.length ? out : undefined);
      });
    },
  });

  // -- Frame and steps --------------------------------------------------------
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text) n.textContent = text;
    return n;
  }
  function icon(id) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }
  function button(label, step, primary) {
    var b = el('button', { type: 'button', class: primary ? 'btn btn-primary' : 'btn' }, label);
    b.addEventListener('click', function () { host.run(step); });
    return b;
  }
  function step(title, sentence, done, action) {
    var li = el('li');
    var h = el('h2');
    if (done) h.appendChild(icon('i-done'));
    h.appendChild(document.createTextNode(title));
    li.appendChild(h);
    li.appendChild(el('p', {}, sentence));
    if (action) li.appendChild(action);
    return li;
  }
  function screenReaderSetting() {
    var label = el('label', { class: 'setting' });
    var box = el('input', { type: 'checkbox' });
    box.checked = state.screenReader;
    box.addEventListener('change', function () { host.run(box.checked ? 'screen-reader-on' : 'screen-reader-off'); });
    label.appendChild(box);
    label.appendChild(document.createTextNode('Plain output for screen readers (applies when the agent starts)'));
    return label;
  }

  function renderSteps(panel) {
    var installed = state.phase !== 'missing';
    var signedIn = state.phase === 'ready';
    var list = el('ol', { class: 'steps' });
    list.appendChild(step('Install Claude Code', "Downloads Claude Code from claude.ai into your home folder. Anthropic's terms apply.", installed,
      state.phase === 'missing' ? button('Install Claude Code', 'install', true) : null));
    list.appendChild(step('Sign in with Claude', 'Opens your browser to sign in. Works with Pro, Max and Team plans.', signedIn,
      state.phase === 'signed-out' ? button('Sign in with Claude', 'login', true) : null));
    list.appendChild(step('placet-research plugin', 'Bundled with the app, version ' + (state.pluginVersion || 'unknown') + '. Nothing to do.', true, null));
    panel.appendChild(list);
    var row = el('div', { class: 'row' });
    if (signedIn) {
      if (state.canContinue) {
        row.appendChild(button('Continue last conversation', 'continue', true));
        row.appendChild(button('New conversation', 'new', false));
      } else {
        row.appendChild(button('Start the agent', 'start', true));
      }
    }
    row.appendChild(button('Not now', 'not-now', false));
    panel.appendChild(row);
    if (signedIn) panel.appendChild(screenReaderSetting());
  }

  function render() {
    var panel = $('panel');
    panel.textContent = '';
    $('plan').textContent = state.plan || '';
    var g = $('guard');
    g.textContent = '';
    g.hidden = !state.guard || state.phase !== 'running' && state.phase !== 'exited';
    g.className = state.guard && state.guard.warn ? 'guard warn' : 'guard';
    if (state.guard) {
      g.appendChild(icon(state.guard.warn ? 'i-warn' : 'i-guard'));
      var words = el('span', {}, state.guard.text);
      if (state.guard.detail) words.appendChild(el('span', { class: 'detail' }, state.guard.detail));
      g.appendChild(words);
    }
    term.options.screenReaderMode = Boolean(state.screenReaderMode);

    var showTerm = ['step-running', 'step-failed', 'running', 'exited'].indexOf(state.phase) >= 0;
    $('term-wrap').hidden = !showTerm;
    if (showTerm) setTimeout(function () { fit.fit(); }, 0);

    if (state.phase === 'no-project') panel.appendChild(el('p', {}, 'Open a project to start the agent in its folder.'));
    if (state.phase === 'checking') panel.appendChild(el('p', {}, 'Looking for Claude Code…'));
    if (state.phase === 'missing' || state.phase === 'signed-out' || state.phase === 'ready') renderSteps(panel);
    if (state.phase === 'outdated') {
      panel.appendChild(el('p', {}, 'Claude Code needs an update for the guard to work. Installed: ' + state.version + ', needed: 2.1.295 or later.'));
      var r = el('div', { class: 'row' });
      r.appendChild(button('Update Claude Code', 'update', true));
      panel.appendChild(r);
    }
    if (state.phase === 'step-failed' || state.phase === 'exited') {
      panel.appendChild(el('p', {}, state.exit.words));
      var r2 = el('div', { class: 'row' });
      r2.appendChild(state.phase === 'exited' ? button('Start again', 'restart', true) : button('Try again', state.step, true));
      panel.appendChild(r2);
    }
  }

  host.onState(function (s) {
    var first = !state;
    state = s;
    if (first && s.fontUrl) {
      [['Hanken Grotesk', 'hanken-grotesk-latin-wght-normal.woff2'], ['Source Serif 4', 'source-serif-4-latin-wght-normal.woff2']].forEach(function (f) {
        new FontFace(f[0], 'url(' + s.fontUrl + f[1] + ')', { weight: '100 900' }).load().then(function (face) { document.fonts.add(face); }, function () {});
      });
    }
    render();
  });
})();
