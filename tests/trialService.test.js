import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrialWindow, getTrialState, TRIAL_DURATION_DAYS } from '../src/services/trialService.js';

test('trial window expires three calendar days after signup', () => {
  const { startedAt, endsAt } = createTrialWindow('2026-11-15T10:00:00.000Z');

  assert.equal(TRIAL_DURATION_DAYS, 3);
  assert.equal(startedAt, '2026-11-15T10:00:00.000Z');
  assert.equal(endsAt, '2026-11-18T10:00:00.000Z');
});

test('trial window rejects an invalid start date', () => {
  assert.throws(() => createTrialWindow('not a date'), {
    name: 'TypeError',
    message: 'Trial start date must be a valid date.',
  });
});

test('trial duration is exactly 72 hours across a daylight-saving transition', () => {
  const { startedAt, endsAt } = createTrialWindow('2026-03-07T15:00:00.000Z');
  assert.equal(new Date(endsAt).getTime() - new Date(startedAt).getTime(), 72 * 60 * 60 * 1000);
});

test('trial state expires at the exact end timestamp', () => {
  const trialEndsAt = '2026-11-18T10:00:00.000Z';

  assert.equal(getTrialState({ role: 'coach', trialEndsAt, subscriptionStatus: 'trialing' }, new Date('2026-11-18T09:59:59.999Z')), 'trialing');
  assert.equal(getTrialState({ role: 'coach', trialEndsAt, subscriptionStatus: 'trialing' }, new Date(trialEndsAt)), 'expired');
});

test('active subscription remains available after trial expiry', () => {
  assert.equal(getTrialState({
    role: 'coach',
    trialEndsAt: '2026-11-18T10:00:00.000Z',
    subscriptionStatus: 'active',
  }, new Date('2026-11-19T10:00:00.000Z')), 'active');
});

test('trial restrictions do not apply to client accounts', () => {
  assert.equal(getTrialState({ role: 'client', trialEndsAt: null, subscriptionStatus: null }), 'client');
});
