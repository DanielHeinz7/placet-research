'use strict';

// The session view's server (US-2). A human starts it with `placet-research
// serve` in their own terminal; it reads and writes nothing of its own. Every
// read and write goes through hooks/lib, the same code the CLI calls, and the
// only state held here is a write token and a single-use code, both in memory
// only. The URL handed to the browser and printed to the terminal carries the
// code, never the token: the view trades the code for the token once, through
// POST /api/session, so every other copy of the URL (terminal scrollback, a
// `ps` listing of the opener, browser history) is dead after that.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const childProcess = require('node:child_process');

const stateLib = require('../hooks/lib/state');
const profileLib = require('../hooks/lib/profile');
const projectLib = require('../hooks/lib/project');
const { parseDecisions } = require('../hooks/lib/decisions');
const { textHash } = require('../hooks/lib/hash');
const { mechanicalReview } = require('../hooks/lib/review');
const { acceptStatement, openChecks } = require('../hooks/lib/accept');
const { chooseFraming } = require('../hooks/lib/choose');
const { setStated } = require('../hooks/lib/stated');
const { appendLog } = require('../hooks/lib/log');
const { agendaOf, HUMAN_QUESTIONS } = require('../hooks/lib/agenda');
const appApi = require('../hooks/lib/app-api');

const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const CODE_TTL_MS = 60 * 1000;
const SESSION = '/api/session';
const APP_PREFIX = '/api/app/';

const PLACEHOLDER = '<!doctype html><meta charset="utf-8"><title>Research harness</title>'
  + '<p>The session view (dashboard/canvas.html) is not installed. The API is at <code>/api/state</code>.</p>\n';
const APP_PLACEHOLDER = '<!doctype html><meta charset="utf-8"><title>Research harness</title>'
  + '<p>The app page (dashboard/app.html) is not installed. The app routes are under <code>/api/app/</code>.</p>\n';

function readPage(pluginRoot, name, fallback) {
  try {
    return fs.readFileSync(path.join(pluginRoot, 'dashboard', name), 'utf8');
  } catch (_) {
    return fallback;
  }
}

function pluginVersion(pluginRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
  } catch (_) {
    return null;
  }
}

// What the view renders for one canvas — the main one or a variant's. The
// sealing key is loaded to judge the ledger and is never put into the payload.
// One function builds both, so a variant's state cannot drift from the main
// canvas's.
function canvasState(state, pluginRoot) {
  const statuses = profileLib.statusByNumber(state.parsed);
  const elements = state.parsed.elements.map((e) => ({
    ...e,
    status: statuses[e.number],
    questions: e.questions.map((q) => ({
      ...q,
      statements: q.statements.map((s) => ({ ...s, hash: textHash(s.text) })),
      // The check questions still open on this question, from the same library
      // function the accept path records as `openAtAccept`: the view and the
      // log must not hold two readings of what "open" means.
      openChecks: openChecks(state.decisionsText, q.id).map((c) => ({ seq: c.seq, body: c.body })),
    })),
  }));
  const report = mechanicalReview({ parsed: state.parsed, graph: state.graph, checks: state.checks, decisionsText: state.decisionsText, key: state.key });
  const { ledger } = report;
  // Same order of verdicts as review.js: after the break everything is broken,
  // before the first seal everything is legacy.
  const sealStatus = (e) => {
    if (ledger.verified.has(e.seq)) return 'verified';
    if (ledger.broken && e.seq >= ledger.broken.seq) return 'broken';
    if (ledger.legacy.includes(e.seq)) return 'legacy';
    return 'unverifiable';
  };
  return {
    version: pluginVersion(pluginRoot),
    project: state.parsed.frontmatter.project || null,
    frontmatter: state.parsed.frontmatter,
    // The active profile's graph, so the view never holds a copy of one.
    graph: state.graph || null,
    elements,
    violations: state.graph ? profileLib.dependencyViolations(state.parsed, state.graph) : [],
    review: { ...report, ledger: { ...ledger, verified: [...ledger.verified] } },
    decisions: parseDecisions(state.decisionsText).entries.map((e) => ({ ...e, sealStatus: sealStatus(e) })),
    profileError: state.profileError || null,
    keyError: state.keyError || null,
    // Spec §6: the same agenda the `agenda` command exports, and the human
    // questions it is headed by, so the view renders them and holds no copy.
    agenda: agendaOf(state.parsed, state.decisionsText),
    humanQuestions: HUMAN_QUESTIONS,
  };
}

// What GET /api/state answers: the main canvas's state, and the framings the
// project holds as variants, each with its own state. A variant's state
// carries no `variants` key of its own — a variant holds statements, not
// further framings.
function viewState(root, pluginRoot) {
  const state = stateLib.loadState(root, { pluginRoot });
  if (state.error) return { ok: false, code: state.code, error: state.error };
  const variants = projectLib.variantNames(root).map((name) => {
    const variant = stateLib.loadState(root, { pluginRoot, variant: name });
    const lens = variant.parsed.frontmatter.lens;
    return {
      name,
      lens: typeof lens === 'string' && lens.trim() ? lens.trim() : null,
      state: canvasState(variant, pluginRoot),
    };
  });
  return { ok: true, body: { ...canvasState(state, pluginRoot), variants } };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(bytes);
}

// The fonts the view ships (dashboard/fonts/): the page may fetch exactly
// these files from that directory and nothing else.
const FONTS = new Set([
  'hanken-grotesk-latin-wght-normal.woff2',
  'source-serif-4-latin-wght-normal.woff2',
  'source-serif-4-latin-wght-italic.woff2',
]);

function statusOf(result) {
  if (result.ok) return 200;
  return result.code === 'stale' ? 409 : 422;
}

function appStatusOf(result) {
  if (result.ok) return 200;
  return result.code === 'no-project' || result.code === 'conflict' ? 409 : 422;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('body too large'), { status: 413 });
    if (Number(req.headers['content-length']) > MAX_BODY) {
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => (size > MAX_BODY ? reject(tooLarge()) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

const str = (v) => (typeof v === 'string' ? v : undefined);

// acceptStatement treats a missing expectedHash as the CLI path and skips the
// staleness check, so the route itself insists on one (setStated does this in
// the lib).
const ROUTES = {
  '/api/accept': (b, ctx) => (typeof b.expectedHash !== 'string' || !b.expectedHash
    ? { ok: false, code: 'invalid', error: 'An accept from the view needs the text hash of the statement you saw (expectedHash).' }
    : acceptStatement({ root: ctx.root, questionId: b.questionId, match: str(b.match), why: str(b.why), explained: str(b.explained), rejected: str(b.rejected), expectedHash: b.expectedHash, pluginRoot: ctx.pluginRoot })),
  // Choosing a framing is the researcher's act, like an accept, and it is the
  // same library function the CLI calls: the two routes write the same bytes.
  '/api/choose': (b, ctx) => chooseFraming({ root: ctx.root, name: b.name, why: str(b.why), rejected: str(b.rejected), pluginRoot: ctx.pluginRoot }),
  '/api/stated': (b, ctx) => setStated({ root: ctx.root, questionId: b.questionId, match: str(b.match), expectedHash: b.expectedHash }),
  '/api/comment': (b, ctx) => appendLog({ root: ctx.root, kind: 'DISCOVERY', ref: b.ref, body: b.body, why: str(b.why), pluginRoot: ctx.pluginRoot }),
};

const sameSecret = (value, buf) => {
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value, 'utf8');
  return given.length === buf.length && crypto.timingSafeEqual(given, buf);
};

// Starts the server on 127.0.0.1 and a free port. Resolves to the port, the
// token, and the URL that carries the single-use code; the caller decides
// whether to print or open it. `log` receives the one line written when the
// code is redeemed, so the human sees in the terminal that the session was
// taken.
//
// `app = { dataDir }` turns on app mode for the desktop app: `root` may then be
// null, the routes under /api/app/ can open another project, and the resolved
// object carries `appUrl`, the shell page's URL with the same code.
function start({ root, pluginRoot = stateLib.defaultPluginRoot(), log = () => {}, codeTtlMs = CODE_TTL_MS, app } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenBuf = Buffer.from(token, 'utf8');
  // 128 bits, and shorter than the token so the two are never confused.
  const code = crypto.randomBytes(16).toString('hex');
  const codeBuf = Buffer.from(code, 'utf8');
  const codeExpires = Date.now() + codeTtlMs;
  let redeemed = false;
  // In app mode the current project can change; the project routes always act
  // on the one open now.
  let currentRoot = root;
  const ctx = { get root() { return currentRoot; }, pluginRoot };
  const appCtx = app ? { dataDir: app.dataDir, getRoot: () => currentRoot, setRoot: (r) => { currentRoot = r; } } : null;
  let host = null;
  let origin = null;

  // Every refusal of a check looks the same: which check failed is not said.
  // POST /api/session is the one POST without the token; it carries the code
  // in its body instead.
  const allowed = (req, url) => {
    if (req.headers.host !== host) return false;
    if (req.method !== 'POST') return true;
    if (url !== SESSION && !sameSecret(req.headers['x-harness-token'], tokenBuf)) return false;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return false;
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
    return true;
  };

  const handle = async (req, res) => {
    const url = req.url.split('?')[0];
    if (!allowed(req, url)) return send(res, 403, { ok: false, error: 'forbidden' });
    if (req.method === 'GET' && url === '/') {
      return send(res, 200, readPage(pluginRoot, 'canvas.html', PLACEHOLDER), 'text/html; charset=utf-8');
    }
    // The shell page, like the view, is fetched by navigation and so carries
    // no token; it holds no project data and trades the code like the view.
    if (appCtx && req.method === 'GET' && url === '/app') {
      return send(res, 200, readPage(pluginRoot, 'app.html', APP_PLACEHOLDER), 'text/html; charset=utf-8');
    }
    const font = req.method === 'GET' && /^\/fonts\/([a-z0-9-]+\.woff2)$/.exec(url);
    if (font && FONTS.has(font[1])) {
      try {
        return send(res, 200, fs.readFileSync(path.join(pluginRoot, 'dashboard', 'fonts', font[1])), 'font/woff2');
      } catch (_) {
        return send(res, 404, { ok: false, error: 'not found' });
      }
    }
    // The app's routes. allowed() lets a GET through on the Host alone; these
    // need the token whatever the method, since GET /api/app/projects lists
    // folders on the person's disk.
    let appRoute = null;
    if (appCtx && url.startsWith(APP_PREFIX)) {
      if (!sameSecret(req.headers['x-harness-token'], tokenBuf)) return send(res, 403, { ok: false, error: 'forbidden' });
      const name = url.slice(APP_PREFIX.length);
      appRoute = Object.prototype.hasOwnProperty.call(appApi.routes, name) ? appApi.routes[name] : null;
      if (!appRoute) return send(res, 404, { ok: false, error: 'not found' });
      if (req.method !== (name === 'projects' ? 'GET' : 'POST')) return send(res, 405, { ok: false, error: 'method not allowed' });
      if (name === 'projects') {
        const result = await appRoute({}, appCtx);
        return send(res, appStatusOf(result), result);
      }
    } else if (!currentRoot && url.startsWith('/api/') && url !== SESSION) {
      // App mode before a project is open: the code exchange still works.
      return send(res, 409, { ok: false, code: 'no-project', error: 'No project is open.' });
    }
    if (req.method === 'GET' && url === '/api/state') {
      const view = viewState(currentRoot, pluginRoot);
      return send(res, view.ok ? 200 : 422, view.ok ? view.body : view);
    }
    const route = appRoute || ROUTES[url];
    if (!route && url !== SESSION) return send(res, 404, { ok: false, error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      if (err.status === 413) return send(res, 413, { ok: false, code: 'invalid', error: 'The request body is over 64 KB.' });
      return send(res, 422, { ok: false, code: 'invalid', error: 'The request body is not JSON.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 422, { ok: false, code: 'invalid', error: 'The request body must be a JSON object.' });
    if (url === SESSION) {
      // One successful exchange per server run: after it, or once the code has
      // expired, every exchange is refused until the human restarts serve.
      if (redeemed || Date.now() > codeExpires || !sameSecret(body.code, codeBuf)) return send(res, 403, { ok: false, error: 'forbidden' });
      redeemed = true;
      log(`session code redeemed ${new Date().toISOString()}`);
      return send(res, 200, { ok: true, token });
    }
    if (appRoute) {
      const result = await appRoute(body, appCtx);
      return send(res, appStatusOf(result), result);
    }
    const result = route(body, ctx);
    // The app has no terminal: a refusal that names a command is shown in the
    // app's words. The command line and a plain `serve` keep theirs.
    const shown = appCtx ? appApi.appRefusal(result, currentRoot) : result;
    return send(res, statusOf(shown), shown);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { ok: false, code: 'error', error: err && err.message ? err.message : 'internal error' });
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const { port } = server.address();
      host = `${HOST}:${port}`;
      origin = `http://${host}`;
      resolve({
        server,
        port,
        token,
        code,
        url: `${origin}/#c=${code}`,
        ...(app ? { appUrl: `${origin}/app#c=${code}` } : {}),
        close: () => new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

// Hands the URL to the operating system's opener. Failure to open is not
// fatal: the URL is printed in the terminal as well.
function openInBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  try {
    const child = childProcess.spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch (_) {
    // printed URL is the fallback
  }
}

module.exports = { start, openInBrowser, viewState, MAX_BODY };
