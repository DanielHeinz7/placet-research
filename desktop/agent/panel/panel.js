'use strict';
// The SDK way's column page. Every piece of model text goes through
// agentRender and textContent; nothing is inserted as HTML.
(function () {
  const api = window.agentPanel;
  const $ = (id) => document.getElementById(id);
  const views = ['v-choose', 'v-connect', 'v-thread', 'v-settings'];
  const show = (id) => views.forEach((v) => { $(v).hidden = v !== id; });
  let connKind = null;
  let tokens = 0;
  let costUsd = 0;
  let pendingText = '';
  let started = false;                    // a conversation was started on this page

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }

  function icon(href) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i'); svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', href); svg.append(use);
    return svg;
  }

  // A problem in the thread: ink, the problem icon and words, never red.
  function problemItem(text, ...actions) {
    const li = el('li', 'problem');
    const words = el('span', null, text);
    li.append(icon('#i-problem'), words, ...actions);
    return li;
  }

  function inlineNode(piece, known) {
    if (piece.type === 'strong' || piece.type === 'em' || piece.type === 'code') return el(piece.type, null, piece.value);
    if (piece.type === 'url') {
      const wrap = el('span');
      const open = el('button', 'quiet', 'Open');
      open.type = 'button';
      open.setAttribute('aria-label', `Open ${piece.value}`);
      open.addEventListener('click', () => api.openExternal(piece.value));
      wrap.append(el('span', 'url', piece.value), ' ', open);
      return wrap;
    }
    if (piece.type === 'number' && known.get(piece.value)) {
      const a = el('a', 'stmt', piece.value);
      a.href = '#'; a.title = known.get(piece.value);
      a.addEventListener('click', (e) => { e.preventDefault(); api.reveal(piece.value); });
      return a;
    }
    return document.createTextNode(piece.value);
  }

  // Links are made from the finished text block, so "3." then "4" in two
  // streamed fragments still ends as one link 3.4.
  async function agentText(text) {
    const blocks = agentRender.renderBlocks(text);
    const numbers = new Set();
    for (const b of blocks) for (const item of b.items) for (const piece of item) if (piece.type === 'number') numbers.add(piece.value);
    const known = new Map(await Promise.all([...numbers].map(async (n) => [n, await api.lookup(n)])));
    const li = el('li', 'agent');
    li.append(el('span', 'who', 'Agent'));
    for (const block of blocks) {
      const node = el(block.tag);
      for (const item of block.items) {
        const holder = block.tag === 'p' ? node : node.appendChild(el('li'));
        for (const piece of item) holder.append(inlineNode(piece, known));
      }
      li.append(node);
    }
    return li;
  }

  function add(node) { $('thread').append(node); node.scrollIntoView({ block: 'end' }); return node; }

  // Send and the quick actions go together: each is native-disabled whenever
  // the agent cannot take a message (working, guard off, starting).
  function canSend(yes) {
    $('send').disabled = !yes;
    document.querySelectorAll('.quick button').forEach((b) => { b.disabled = !yes; });
  }

  function setWorking(on) {
    canSend(!on); $('stop').hidden = !on; $('msg').readOnly = on;
    $('h-state').textContent = on ? 'Working' : 'Ready';
  }

  // The header is one line, so a long model name is cut; the whole is its title.
  function setModel(text) { $('h-model').textContent = text; $('h-model').title = text; }

  function setGuard(on, text) {
    $('h-guard').hidden = false;
    $('h-guard-icon').setAttribute('href', on ? '#i-guard' : '#i-problem');
    $('h-guard-text').textContent = text;
  }

  function usageLine() {
    let line = `This conversation: ${tokens.toLocaleString('en')} tokens`;
    if (connKind === 'anthropic' && costUsd > 0) line += `, about $${costUsd.toFixed(2)} at Anthropic’s list prices`;
    $('usage').textContent = line;
  }

  function errorWords(code) {
    if (code === 'rate_limit' || code === 'overloaded') return 'The model is busy or the usage limit is reached. Try again in a minute.';
    if (code === 'authentication_failed') return 'The key was refused. Change it in Agent settings.';
    if (code === 'billing_error') return 'The account behind the key has no credit left. Add credit there, or change the connection in Agent settings.';
    return `The model did not answer as expected (${code}). Send your message again.`;
  }

  function settingsButton() {
    const b = el('button', 'quiet', 'Agent settings');
    b.type = 'button';
    b.addEventListener('click', () => enterSettings());
    return b;
  }

  async function onEvent(ev) {
    switch (ev.kind) {
      case 'guard':
        if (ev.state === 'on') { setGuard(true, `Guard on · placet-research ${ev.version}`); setWorking(false); }
        else {
          setGuard(false, 'Guard off'); $('h-state').textContent = 'Stopped';
          // Only the latest way back is live; an earlier one is spent.
          document.querySelectorAll('#thread .retry').forEach((b) => { b.disabled = true; });
          const again = el('button', 'retry', 'Try again'); again.type = 'button'; again.addEventListener('click', () => begin(false));
          add(problemItem(agentRender.guardLine(ev.cause), again));
          setWorking(false); canSend(false); $('h-state').textContent = 'Stopped';
        }
        break;
      case 'you': { const li = el('li', 'you'); li.append(el('span', 'who', 'You'), el('p', null, ev.text)); add(li); break; }
      case 'delta': pendingText += ev.text; $('pending').textContent = pendingText; $('log-wrap').scrollTop = $('log-wrap').scrollHeight; break;
      case 'text': pendingText = ''; $('pending').textContent = ''; add(await agentText(ev.text)); break;
      case 'tool': { const d = el('details', 'tool'); d.append(el('summary', null, ev.line)); add(el('li', 'tool-line')).append(d); break; }
      case 'refusal': {
        const li = el('li', 'refusal');
        const words = ev.tool === 'Bash' && /accept/.test(ev.reason) ? 'Refused by the guard: accepting is your step.' : 'Refused by the guard: this step is yours.';
        const p = el('p'); p.append(icon('#i-guard'), ' ', document.createTextNode(words)); li.append(p);
        if (ev.statement) { const b = el('button', 'quiet', `Open ${ev.statement}`); b.type = 'button'; b.addEventListener('click', () => api.reveal(ev.statement)); li.append(b); }
        const d = el('details'); d.append(el('summary', null, 'The guard’s reason'), el('p', null, ev.reason)); li.append(d);
        add(li); break;
      }
      case 'ask': {
        const li = el('li', 'ask');
        li.append(el('p', null, `The agent wants to: ${ev.line}`));
        const yes = el('button', null, 'Allow once'); const no = el('button', 'quiet', 'Deny');
        yes.type = 'button'; no.type = 'button';
        const done = (allow) => { api.answer(ev.id, allow); yes.disabled = true; no.disabled = true; li.append(el('p', 'meta', allow ? 'Allowed once.' : 'Denied.')); };
        yes.addEventListener('click', () => done(true)); no.addEventListener('click', () => done(false));
        li.append(yes, ' ', no); add(li); yes.focus(); break;
      }
      case 'usage': tokens += ev.tokens; costUsd += ev.costUsd; connKind = ev.connKind || connKind; usageLine(); break;
      case 'error': {
        const settings = ev.code === 'authentication_failed' || ev.code === 'billing_error';
        add(settings ? problemItem(errorWords(ev.code), settingsButton()) : problemItem(errorWords(ev.code)));
        break;
      }
      case 'turn-end':
      case 'not-sent': setWorking(false); break;
      case 'stopped':
        setWorking(false); $('h-state').textContent = 'Stopped';
        add(el('li', 'meta', ev.reason === 'by-person' ? 'Stopped.' : `The agent stopped (${ev.reason}). Start it again to go on.`));
        if (ev.reason !== 'by-person') { const again = el('button', 'retry', 'Start again'); again.type = 'button'; again.addEventListener('click', () => begin(false)); add(el('li', 'again')).append(again); }
        break;
      case 'resume-failed': begin(false, 'The last conversation could not be found; started a new one.'); break;
      case 'project-changed': enterThread('The conversation ended because another project was opened.'); break;
      default: break;
    }
  }

  // Events are handled one at a time, in the order they arrive: a text block
  // waits for its statement-number lookups, and nothing may pass it.
  let queue = Promise.resolve();
  const enqueue = (ev) => { queue = queue.then(() => onEvent(ev)).catch(() => {}); };

  function resetThread() {
    $('thread').replaceChildren(); $('pending').textContent = ''; $('usage').textContent = '';
    pendingText = ''; tokens = 0; costUsd = 0;
  }

  async function begin(resume, note) {
    $('resume').hidden = true;
    resetThread();
    if (note) add(el('li', 'meta', note));
    setGuard(false, ''); $('h-guard').hidden = true;
    $('h-state').textContent = 'Starting';
    canSend(false);
    const r = await api.start({ resume });
    if (!r.ok) {
      $('h-state').textContent = '';
      if (r.next === 'connect' || r.error === 'connect') return enterConnect(r.error === 'connect' ? '' : r.error);
      add(problemItem(r.error));
      return undefined;
    }
    started = true;
    setModel(`${r.model} · ${r.kindName}`);
    return undefined;
  }

  function enterChoose() { show('v-choose'); $('way-cc').focus(); }

  async function enterThread(note) {
    const s = await api.state();
    // No way chosen yet: the choice comes first, whatever brought the person here.
    if (!s.way) return enterChoose();
    show('v-thread');
    resetThread(); started = false;
    if (note) add(el('li', 'meta', note));
    setModel(s.connection ? `${s.connection.model} · ${s.kindName}` : '');
    connKind = s.connection && s.connection.kind;
    if (s.canResume) { $('resume').hidden = false; $('h-state').textContent = ''; $('resume-go').focus(); } else begin(false);
  }

  const FIELDS = { url: 'f-url', region: 'f-region', projectId: 'f-project', profile: 'f-profile', secret: 'f-secret', model: 'f-model' };

  function draft() {
    const kind = document.querySelector('input[name=kind]:checked').value;
    const cloud = document.querySelector('input[name=cloud]:checked').value;
    const k = kind === 'cloud' ? cloud : kind;
    return { kind: k, model: $('f-model').value, url: $('f-url').value, region: $('f-region').value, projectId: $('f-project').value, profile: $('f-profile').value, auth: document.querySelector('input[name=bauth]:checked').value };
  }

  function layoutConnect() {
    const d = draft();
    $('f-cloud').hidden = !(d.kind === 'bedrock' || d.kind === 'vertex');
    $('l-url').hidden = d.kind !== 'gateway';
    $('l-region').hidden = !(d.kind === 'bedrock' || d.kind === 'vertex');
    $('f-bedrock-auth').hidden = d.kind !== 'bedrock';
    $('l-project').hidden = d.kind !== 'vertex';
    $('l-secret').hidden = !(d.kind === 'anthropic' || d.kind === 'gateway' || (d.kind === 'bedrock' && d.auth === 'key'));
    $('get-key').parentElement.hidden = d.kind !== 'anthropic';
  }

  // The message sits right under the field it names; with no field (or one that
  // is not shown) it stays above the button that was pressed.
  function showConnectError(message, field) {
    for (const id of Object.values(FIELDS)) { $(id).removeAttribute('aria-invalid'); $(id).removeAttribute('aria-describedby'); }
    const input = field && FIELDS[field] && $(FIELDS[field]);
    const named = message && input && !input.closest('[hidden]') ? input : null;
    if (named) named.closest('label').after($('connect-error')); else $('connect-go').before($('connect-error'));
    $('connect-error').hidden = !message; $('connect-error-text').textContent = message || '';
    if (message) $('connect-error').scrollIntoView({ block: 'nearest' });
    if (named) { named.setAttribute('aria-invalid', 'true'); named.setAttribute('aria-describedby', 'connect-error'); named.focus(); }
  }

  function enterConnect(message) {
    show('v-connect'); layoutConnect(); showConnectError(message);
    document.querySelector('input[name=kind]:checked').focus();
  }

  async function enterSettings() {
    const s = await api.state();
    if (!s.connection) return;
    show('v-settings'); $('s-error').hidden = true;
    $('s-current').textContent = `${s.kindName}, model ${s.connection.model}.`;
    $('s-change').focus();
  }

  async function refreshModels() {
    const d = draft();
    if (!(d.kind === 'anthropic' || d.kind === 'gateway') || !$('f-secret').value) return;
    const r = await api.listModels(d, $('f-secret').value);
    const list = $('models'); list.replaceChildren();
    if (r.ok && r.models) for (const m of r.models) { const o = document.createElement('option'); o.value = m; list.append(o); }
  }

  // Ending a running conversation is asked first (spec 5.5, 7). The question is
  // a dialog in the page, as in the shell: it says what will happen, and focus
  // goes back to the control that opened it when the person cancels.
  // The title and the act name what happens: ending the conversation by default,
  // removing the key where that is what the button does.
  function confirmEnd(text, opener, act = { title: 'End the conversation?', ok: 'End conversation' }) {
    if ($('stop').hidden && !$('thread').children.length) return Promise.resolve(true);
    const dlg = $('dlg');
    $('dlg-title').textContent = act.title; $('dlg-ok').textContent = act.ok;
    $('dlg-text').textContent = text;
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => { const ok = dlg.returnValue === 'ok'; if (!ok) opener.focus(); resolve(ok); }, { once: true });
      dlg.showModal();
      $('dlg-cancel').focus();
    });
  }

  $('way-cc').addEventListener('click', () => api.chooseWay('claude-code'));
  $('way-sdk').addEventListener('click', async () => { await api.chooseWay('sdk'); enterConnect(); });
  $('way-later').addEventListener('click', () => api.hide());
  document.querySelectorAll('#v-connect input[type=radio]').forEach((r) => r.addEventListener('change', layoutConnect));
  $('f-secret').addEventListener('change', refreshModels);
  $('f-url').addEventListener('change', refreshModels);
  $('get-key').addEventListener('click', () => api.openExternal('https://console.anthropic.com/settings/keys'));
  $('connect-go').addEventListener('click', async () => {
    $('connect-go').disabled = true; showConnectError(''); $('h-state').textContent = 'Testing the connection';
    const r = await api.connect(draft(), $('f-secret').value);
    $('connect-go').disabled = false; $('h-state').textContent = '';
    if (!r.ok) { showConnectError(r.error, r.field); return; }
    $('f-secret').value = '';
    enterThread();
  });
  $('resume-go').addEventListener('click', () => begin(true));
  $('new-go').addEventListener('click', () => begin(false));
  $('compose').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('msg').value;
    if ($('send').disabled || !t.trim()) return;
    setWorking(true); api.send(t); $('msg').value = '';
  });
  $('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('compose').requestSubmit(); });
  $('stop').addEventListener('click', () => api.stop());
  document.querySelectorAll('.quick [data-cmd]').forEach((b) => b.addEventListener('click', () => { setWorking(true); api.send(b.dataset.cmd); }));
  $('q-note').addEventListener('click', async () => { const f = await api.pickFile(); if (f) { setWorking(true); api.send(`/placet-research:literature-note ${f}`); } });
  $('s-change').addEventListener('click', async () => {
    if (await confirmEnd('Changing the connection ends the current conversation. What the agent already wrote to the project stays.', $('s-change'))) enterConnect();
  });
  $('s-remove').addEventListener('click', async () => {
    if (!await confirmEnd('Removing the connection deletes the saved key from the Keychain. The current conversation ends too.', $('s-remove'), { title: 'Remove the saved key?', ok: 'Remove key' })) return;
    const r = await api.removeConnection();
    if (r && r.ok === false) { $('s-error-text').textContent = r.error; $('s-error').hidden = false; $('s-remove').focus(); return; }
    started = false; resetThread();
    enterConnect();
  });
  $('s-way').addEventListener('click', async () => {
    if (await confirmEnd('Switching to Claude Code ends the current conversation. The saved connection stays, so you can switch back.', $('s-way'))) api.chooseWay('claude-code');
  });
  $('s-back').addEventListener('click', () => { if (started) show('v-thread'); else enterThread(); });

  api.onEvent(enqueue);
  window.addEventListener('hashchange', () => { if (location.hash === '#settings') enterSettings(); });
  (async () => {
    const s = await api.state();
    if (location.hash === '#settings' && s.connection) return enterSettings();
    if (!s.way) return enterChoose();
    if (!s.connection) return enterConnect();
    return enterThread();
  })();
})();
