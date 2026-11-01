'use strict';
// Reads whether the person is signed in, and with which plan. email, orgId,
// orgName and every other key are dropped here and never stored or shown.
const PLAN_LABELS = { pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise' };

function parseAuthStatus(stdout) {
  let j = null;
  try { j = JSON.parse(stdout); } catch (_) { j = null; }
  if (!j || typeof j !== 'object') return { loggedIn: false, method: null, plan: null };
  return {
    loggedIn: j.loggedIn === true,
    method: typeof j.authMethod === 'string' ? j.authMethod : null,
    plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
  };
}

function planLabel(plan) {
  return Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : null;
}

async function authStatus(claudePath, { run }) {
  const res = await run(claudePath, ['auth', 'status', '--json'], { timeout: 15000 });
  return parseAuthStatus(res.stdout);
}

module.exports = { parseAuthStatus, planLabel, authStatus };
