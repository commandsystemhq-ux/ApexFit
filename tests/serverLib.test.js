import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../api/_lib/crypto.js';
import { buildCheckoutParams, computeApplicationFee } from '../api/_lib/stripeCheckout.js';
import { NOTIFICATION_TYPES, buildPushMessage } from '../api/_lib/pushText.js';

const key = randomBytes(32).toString('base64');

test('stored secrets round-trip and reject tampering or wrong keys', () => {
  const encrypted = encryptSecret('refresh-token', key);
  assert.notEqual(encrypted, 'refresh-token');
  assert.equal(decryptSecret(encrypted, key), 'refresh-token');
  assert.notEqual(encryptSecret('refresh-token', key), encrypted);
  assert.throws(() => decryptSecret(encrypted, randomBytes(32).toString('base64')));
  assert.throws(() => decryptSecret(`${encrypted.slice(0, -2)}AA`, key));
  assert.throws(() => encryptSecret('x', 'short'), /32 bytes/);
});

test('checkout uses the stored invoice amount and routes funds to the coach account', () => {
  const invoice = { id: 'inv-1', invoice_number: 'INV-000001', description: '10 sessions', amount_cents: 50000, currency: 'usd' };
  const params = buildCheckoutParams({ invoice, destinationAccount: 'acct_1', appUrl: 'https://app.example', customerEmail: 'c@example.com', feePercent: 10 });
  assert.equal(params.line_items[0].price_data.unit_amount, 50000);
  assert.equal(params.line_items[0].price_data.currency, 'usd');
  assert.equal(params.payment_intent_data.transfer_data.destination, 'acct_1');
  assert.equal(params.payment_intent_data.application_fee_amount, 5000);
  assert.equal(params.metadata.invoice_id, 'inv-1');
  assert.equal(params.success_url, 'https://app.example/coach-hub?checkout=success');
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