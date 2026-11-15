import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret, signState, verifyState } from '../api/_lib/crypto.js';
import { buildAuthUrl, buildCalendarEvent, eventIdForSession, parseIdTokenEmail } from '../api/_lib/googleCalendar.js';
import { buildCheckoutParams, computeApplicationFee } from '../api/_lib/stripeCheckout.js';
import { NOTIFICATION_TYPES, buildPushMessage } from '../api/_lib/pushText.js';

const key = randomBytes(32).toString('base64');

test('stored Google tokens round-trip and reject tampering or wrong keys', () => {
  const encrypted = encryptSecret('refresh-token', key);
  assert.notEqual(encrypted, 'refresh-token');
  assert.equal(decryptSecret(encrypted, key), 'refresh-token');
  assert.notEqual(encryptSecret('refresh-token', key), encrypted);
  assert.throws(() => decryptSecret(encrypted, randomBytes(32).toString('base64')));
  assert.throws(() => decryptSecret(`${encrypted.slice(0, -2)}AA`, key));
  assert.throws(() => encryptSecret('x', 'short'), /32 bytes/);
});

test('OAuth state is signed, expires, and cannot be forged', () => {
  const now = Date.now();
  const state = signState({ coachId: 'abc' }, key, 600, now);
  assert.equal(verifyState(state, key, now + 1000).coachId, 'abc');
  assert.equal(verifyState(state, key, now + 601_000), null);
  assert.equal(verifyState(state, randomBytes(32).toString('base64'), now), null);
  const [body] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ coachId: 'evil', exp: 9999999999 })).toString('base64url');
  assert.equal(verifyState(`${forged}.${state.split('.')[1]}`, key, now), null);
  assert.notEqual(forged, body);
  assert.equal(verifyState('garbage', key), null);
});

test('calendar events are idempotent and carry session details', () => {
  const id = '3f2b8a4e-1c6d-4e7f-9a0b-123456789abc';
  assert.equal(eventIdForSession(id), '3f2b8a4e1c6d4e7f9a0b123456789abc');
  assert.match(eventIdForSession(id), /^[a-v0-9]{5,}$/);
  const event = buildCalendarEvent({
    id, title: 'PT session', starts_at: '2026-12-01T10:00:00+00:00', ends_at: '2026-12-01T11:00:00+00:00',
    location: 'Gym', notes: 'Legs', status: 'completed',
  }, 'Sam');
  assert.equal(event.summary, 'PT session — Sam');
  assert.equal(event.start.dateTime, '2026-12-01T10:00:00.000Z');
  assert.equal(event.location, 'Gym');
  assert.match(event.description, /Legs/);
  assert.equal(buildCalendarEvent({ id, title: 'T', starts_at: '2026-12-01T10:00:00Z', ends_at: '2026-12-01T11:00:00Z', location: '', notes: '', status: 'scheduled' }, '').summary, 'T');
});

test('Google helpers parse ID tokens and build offline consent URLs', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'coach@example.com' })).toString('base64url');
  assert.equal(parseIdTokenEmail(`h.${payload}.s`), 'coach@example.com');
  assert.equal(parseIdTokenEmail('broken'), null);
  const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://app/api/google?action=callback', state: 's' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.match(url.searchParams.get('scope'), /calendar\.events/);
});

test('checkout uses the stored invoice amount and routes funds to the coach account', () => {
  const invoice = { id: 'inv-1', invoice_number: 'INV-000001', description: '10 sessions', amount_cents: 50000, currency: 'usd' };
  const params = buildCheckoutParams({ invoice, destinationAccount: 'acct_1', appUrl: 'https://app.example', customerEmail: 'c@example.com', feePercent: 10 });
  assert.equal(params.line_items[0].price_data.unit_amount, 50000);
  assert.equal(params.line_items[0].price_data.currency, 'usd');
  assert.equal(params.payment_intent_data.transfer_data.destination, 'acct_1');
  assert.equal(params.payment_intent_data.application_fee_amount, 5000);
  assert.equal(params.metadata.invoice_id, 'inv-1');
  assert.equal(params.success_url, 'https://app.example/?checkout=success#coachHub');
  assert.equal('application_fee_amount' in buildCheckoutParams({ invoice, destinationAccount: 'acct_1', appUrl: 'https://a' }).payment_intent_data, false);
  assert.equal(computeApplicationFee(333, 2.5), 8);
});

test('push messages exist for every type and locale and fall back to English', () => {
  for (const locale of ['en', 'ar', 'de', 'fr', 'es']) {
    for (const type of NOTIFICATION_TYPES) {
      const message = buildPushMessage(type, locale);
      assert.ok(message.title && message.body);
    }
  }
  assert.equal(buildPushMessage('message', 'xx').title, buildPushMessage('message', 'en').title);
  assert.throws(() => buildPushMessage('unknown', 'en'), /Unsupported/);
});