import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAvatarPath, normalizeProfileForm, validateAvatarFile, validateSignupForm } from '../src/services/profileUtils.js';

test('avatar files must be small supported images', () => {
  assert.equal(validateAvatarFile({ type: 'image/png', size: 1024 }), null);
  assert.equal(validateAvatarFile({ type: 'image/gif', size: 1024 }), 'avatarTypeError');
  assert.equal(validateAvatarFile({ type: 'image/webp', size: 3 * 1024 * 1024 }), 'avatarSizeError');
  assert.equal(validateAvatarFile(null), 'avatarTypeError');
});

test('avatar paths live in the owner folder', () => {
  assert.equal(buildAvatarPath('user-1', { type: 'image/jpeg' }, 42), 'user-1/42.jpg');
  assert.throws(() => buildAvatarPath('user-1', { type: 'text/plain' }));
});

test('profile form trims values and ignores brand for clients', () => {
  const coach = normalizeProfileForm({ fullName: ' Sam ', brandName: ' Apex ', email: ' a@b.co ' }, 'coach');
  assert.deepEqual(coach.values, { fullName: 'Sam', brandName: 'Apex', email: 'a@b.co' });
  assert.equal(coach.valid, true);
  assert.equal(normalizeProfileForm({ brandName: 'Apex' }, 'client').values.brandName, '');
  const invalid = normalizeProfileForm({ fullName: 'x'.repeat(81), email: 'nope' }, 'coach');
  assert.equal(invalid.errors.fullName, 'profileNameTooLong');
  assert.equal(invalid.errors.email, 'authEmailInvalid');
});

test('signup form validation', () => {
  const ok = { role: 'coach', fullName: 'Sam', email: 'sam@example.com', password: 'longenough', confirmPassword: 'longenough' };
  assert.deepEqual(validateSignupForm(ok), {});
  assert.equal(validateSignupForm({ ...ok, role: '' }).role, 'authRoleRequired');
  assert.equal(validateSignupForm({ ...ok, password: 'short', confirmPassword: 'short' }).password, 'authPasswordShort');
  assert.equal(validateSignupForm({ ...ok, confirmPassword: 'different1' }).confirmPassword, 'authPasswordMismatch');
});
