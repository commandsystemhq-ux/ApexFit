import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalDateString, normalizeBodyMetric, shiftDate, validateProgressPhoto } from '../src/services/clientTrackingUtils.js';

test('local date helpers keep calendar days stable across month boundaries', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.match(getLocalDateString(new Date('2026-03-01T12:00:00')), /^\d{4}-\d{2}-\d{2}$/);
});

test('body metrics require at least one valid measurement and enforce supported ranges', () => {
  assert.deepEqual(normalizeBodyMetric({ weight_kg: '72.5', body_fat_percentage: '', notes: '  weekly  ' }), {
    weight_kg: 72.5,
    body_fat_percentage: null,
    notes: 'weekly',
  });
  assert.throws(() => normalizeBodyMetric({ weight_kg: '', body_fat_percentage: '' }), /Enter weight or body fat/);
  assert.throws(() => normalizeBodyMetric({ weight_kg: '501', body_fat_percentage: '' }), /between 0.1 and 500/);
});

test('progress photo validation accepts only bounded image formats', () => {
  assert.doesNotThrow(() => validateProgressPhoto({ type: 'image/webp', size: 10 * 1024 * 1024 }));
  assert.throws(() => validateProgressPhoto({ type: 'image/gif', size: 100 }), /JPG, PNG, or WebP/);
  assert.throws(() => validateProgressPhoto({ type: 'image/jpeg', size: 10 * 1024 * 1024 + 1 }), /10 MB or smaller/);
});
