import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HABIT_GOALS,
  calculateGoalPercent,
  filterByDateRange,
  getLocalDateString,
  normalizeBodyMetric,
  shiftDate,
  summarizeSeries,
  summarizeWorkoutSets,
  validateProgressPhoto,
} from '../src/services/clientTrackingUtils.js';

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

test('workout summary counts only completed sets and calculates volume', () => {
  const summary = summarizeWorkoutSets([
    { sets: [{ reps: '10', weight_kg: '50', done: true }, { reps: '8', weight_kg: '', done: true }, { reps: '10', weight_kg: '50', done: false }] },
    { sets: [{ reps: '5', weight_kg: '20.5', done: true }] },
  ]);
  assert.deepEqual(summary, { totalSets: 4, completedSets: 3, volumeKg: 602.5, percent: 75 });
  assert.equal(summarizeWorkoutSets([]).percent, 0);
});

test('series summaries ignore empty values and report change', () => {
  const data = [
    { weight_kg: 80 }, { weight_kg: null }, { weight_kg: '78.5' }, { weight_kg: 79 },
  ];
  assert.deepEqual(summarizeSeries(data, 'weight_kg'), {
    count: 3, latest: 79, change: -1, min: 78.5, max: 80, average: 79.17,
  });
  assert.equal(summarizeSeries([{ weight_kg: null }], 'weight_kg'), null);
});

test('date range filter keeps the requested trailing window', () => {
  const items = [{ measured_on: '2026-01-01' }, { measured_on: '2026-02-01' }, { measured_on: '2026-02-10' }];
  assert.equal(filterByDateRange(items, 'measured_on', 30, '2026-02-10').length, 2);
  assert.equal(filterByDateRange(items, 'measured_on', 0, '2026-02-10').length, 3);
});

test('habit goal percentages are bounded and tolerate empty input', () => {
  assert.equal(calculateGoalPercent('4', HABIT_GOALS.sleepHours), 50);
  assert.equal(calculateGoalPercent('20000', HABIT_GOALS.steps), 100);
  assert.equal(calculateGoalPercent('', HABIT_GOALS.waterLiters), 0);
  assert.equal(calculateGoalPercent('abc', HABIT_GOALS.waterLiters), 0);
});