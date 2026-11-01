'use strict';
// The four ways to reach a model: what each needs, the environment the agent
// binary gets for it, and what a failure means in plain words.
const KIND_NAMES = { anthropic: 'Anthropic API key', gateway: 'Institute gateway', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex' };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ANTHROPIC = 'https://api.anthropic.com';
// A refused connection and a genuine server-side error both arrive as
// `server_error`; only the words tell them apart.
const UNREACHABLE_TEXT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|timeout/i;

const textOf = (msg) => (msg.message?.content || []).filter((block) => block && block.type === 'text').map((block) => block.text || '').join(' ');

const bad = (field, error) => ({ ok: false, field, error });
const text = (v) => (typeof v === 'string' ? v.trim() : '');

function validate(draft = {}) {
  const model = text(draft.model);
  if (!KIND_NAMES[draft.kind]) return bad('kind', 'Choose how the agent connects.');
  if (!model) return bad('model', 'Choose or type a model.');
  if (draft.kind === 'anthropic') return { ok: true, conn: { kind: 'anthropic', model } };
  if (draft.kind === 'gateway') {
    let u;
    try { u = new URL(text(draft.url)); } catch { return bad('url', 'Type the full address, starting with https://.'); }
    if (u.username || u.password) return bad('url', 'Leave the user name and password out of the address; the token goes in its own field.');
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))) return bad('url', 'The address must start with https:// (http:// only for this computer).');
    return { ok: true, conn: { kind: 'gateway', url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, model } };
  }
  if (draft.kind === 'bedrock') {
    const region = text(draft.region);
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) return bad('region', 'Type an AWS region such as eu-central-1.');
    if (draft.auth === 'key') return { ok: true, conn: { kind: 'bedrock', region, model, auth: 'key' } };
    const profile = text(draft.profile);
    if (draft.auth !== 'profile' || !/^[\w.+-]+$/.test(profile)) return bad('profile', 'Type the name of an AWS profile on this Mac, or use a Bedrock API key.');
    return { ok: true, conn: { kind: 'bedrock', region, model, auth: 'profile', profile } };
  }
  const projectId = text(draft.projectId);
  const region = text(draft.region);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) return bad('projectId', 'Type the Google Cloud project ID, such as my-lab-123456.');
  if (!/^([a-z]+-[a-z]+\d+|global)$/.test(region)) return bad('region', 'Type a Google Cloud region such as europe-west1, or global.');
  return { ok: true, conn: { kind: 'vertex', projectId, region, model } };
}

const needsSecret = (conn) => conn.kind === 'anthropic' || conn.kind === 'gateway' || (conn.kind === 'bedrock' && conn.auth === 'key');
const secretKind = (conn) => conn.kind;

function envFor(conn, secret) {
  switch (conn.kind) {
    case 'anthropic': return { vars: { ANTHROPIC_API_KEY: secret }, secretNames: ['ANTHROPIC_API_KEY'] };
    case 'gateway': return { vars: { ANTHROPIC_BASE_URL: conn.url, ANTHROPIC_AUTH_TOKEN: secret }, secretNames: ['ANTHROPIC_AUTH_TOKEN'] };
    case 'bedrock': return conn.auth === 'key'
      ? { vars: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: conn.region, AWS_BEARER_TOKEN_BEDROCK: secret }, secretNames: ['AWS_BEARER_TOKEN_BEDROCK'] }
      : { vars: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: conn.region, AWS_PROFILE: conn.profile }, secretNames: [] };
    case 'vertex': return { vars: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: conn.projectId, CLOUD_ML_REGION: conn.region }, secretNames: [] };
    default: throw new Error(`Unknown connection kind: ${conn.kind}`);
  }
}

function hostOf(conn) {
  if (conn.kind === 'gateway') return new URL(conn.url).host;
  if (conn.kind === 'bedrock') return `Amazon Bedrock (${conn.region})`;
  if (conn.kind === 'vertex') return `Google Vertex (${conn.region})`;
  return 'api.anthropic.com';
}

async function listModels(conn, secret, fetchImpl = fetch) {
  if (conn.kind !== 'anthropic' && conn.kind !== 'gateway') return null;
  const base = conn.kind === 'gateway' ? conn.url : ANTHROPIC;
  const headers = { 'anthropic-version': '2023-06-01', ...(conn.kind === 'gateway' ? { authorization: `Bearer ${secret}` } : { 'x-api-key': secret }) };
  let res;
  try { res = await fetchImpl(`${base}/v1/models?limit=100`, { headers }); } catch { throw Object.assign(new Error(describeFailure({ code: 'unreachable', conn })), { code: 'unreachable' }); }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(describeFailure({ code: 'authentication_failed', conn })), { code: 'authentication_failed' });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  return body && Array.isArray(body.data) ? body.data.map((m) => m.id).filter((id) => typeof id === 'string') : null;
}

function describeFailure({ code, conn }) {
  const host = hostOf(conn);
  switch (code) {
    case 'authentication_failed': return conn.kind === 'gateway' ? 'The token was refused.' : 'The key was refused.';
    case 'model_not_found': return `${host} does not offer ${conn.model}.`;
    case 'unreachable': return `Could not reach ${host}.`;
    case 'server_error': return `${host} reported a server error. Try again in a few minutes.`;
    case 'rate_limit':
    case 'overloaded': return 'The model is busy or the usage limit is reached. Try again in a minute.';
    case 'billing_error': return 'The account behind the key has no credit left.';
    case 'cloud_credential_error': return conn.kind === 'vertex' ? 'No Google sign-in was found on this Mac. Sign in with Google Cloud’s own tools, then try again.' : 'The AWS profile could not be used.';
    default: return `The model did not answer as expected (${code}).`;
  }
}

// One turn without tools or plugin: checks key, address and model name
// together. Spends a few tokens. Error codes follow Task 1, check C13.
async function testConnection({ query, options, conn, timeoutMs = 20000 }) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  // C13: by default the binary retries a 401 ten times and was still retrying
  // after 122 s; one retry ends it in about a second.
  const env = { ...options.env, CLAUDE_CODE_MAX_RETRIES: '1' };
  let code = null;
  let said = '';
  let answered = false;
  try {
    for await (const msg of query({ prompt: 'Reply with the word ready.', options: { ...options, abortController, env } })) {
      if (msg.type === 'assistant' && msg.error) { code = code || msg.error; said = said || textOf(msg); }
      if (msg.type === 'assistant' && !msg.error) answered = true;
      if (msg.type === 'result' && msg.subtype !== 'success') code = code || 'unknown';
    }
  } catch (err) {
    code = code || (abortController.signal.aborted ? 'unreachable' : 'unknown');
  } finally { clearTimeout(timer); }
  // C13: a refused connection arrives as the assistant error `server_error`
  // ("Connection refused ... ECONNREFUSED"), not as `unreachable`. A genuine
  // 500 reports `server_error` too, so the message text tells them apart.
  if (code === 'server_error' && UNREACHABLE_TEXT.test(said)) code = 'unreachable';
  if (!code && answered) return { ok: true };
  return { ok: false, error: describeFailure({ code: code || 'unreachable', conn }) };
}

module.exports = { KIND_NAMES, validate, needsSecret, secretKind, envFor, hostOf, listModels, describeFailure, testConnection };
