'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAuthStatus, planLabel } = require('../agent/auth');

const FULL = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.invalid', orgId: 'org-fake', orgName: 'Fake Org', subscriptionType: 'pro' });

test('keeps loggedIn, method and plan, and nothing else', () => {
  const parsed = parseAuthStatus(FULL);
  assert.deepEqual(parsed, { loggedIn: true, method: 'claude.ai', plan: 'pro' });
  assert.doesNotMatch(JSON.stringify(parsed), /example\.invalid|Fake Org|org-fake/);
});

test('anything but loggedIn true is signed out', () => {
  assert.equal(parseAuthStatus('{"loggedIn":false}').loggedIn, false);
  assert.equal(parseAuthStatus('{"loggedIn":"yes"}').loggedIn, false);
  assert.equal(parseAuthStatus('not json').loggedIn, false);
  assert.equal(parseAuthStatus('').loggedIn, false);
});

test('plan labels are plain text, unknown plans show none', () => {
  assert.equal(planLabel('pro'), 'Claude Pro');
  assert.equal(planLabel('max'), 'Claude Max');
  assert.equal(planLabel('team'), 'Claude Team');
  assert.equal(planLabel('enterprise'), 'Claude Enterprise');
  assert.equal(planLabel('something-new'), null);
  assert.equal(planLabel(null), null);
});
