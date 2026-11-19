import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../api/_lib/crypto.js';
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