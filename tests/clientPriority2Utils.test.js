import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countProgramContents,
  groupOneRepMaxHistory,
  normalizeFoodEntry,
  normalizeIntakeForm,
  summarizeFoodDay,
} from '../src/services/clientPriority2Utils.js';

test('intake form normalization validates choices and bounds', () => {
  const base = { primary_goal: 'strength', experience_level: 'beginner', training_days_per_week: '4', equipment_access: 'full_gym', height_cm: '', injuries: ' knee ', medical_conditions: '', dietary_preferences: '', additional_notes: '' };
  assert.deepEqual(normalizeIntakeForm(base), {
    primary_goal: 'strength', experience_level: 'beginner', training_days_per_week: 4, equipment_access: 'full_gym',
    height_cm: null, injuries: 'knee', medical_conditions: '', dietary_preferences: '', additional_notes: '',
  });
  assert.throws(() => normalizeIntakeForm({ ...base, training_days_per_week: '8' }), /between 1 and 7/);
  assert.throws(() => normalizeIntakeForm({ ...base, primary_goal: 'other' }), /valid goal/);
  assert.throws(() => normalizeIntakeForm({ ...base, height_cm: '20' }), /Height must be between 50 and 275/);
  assert.throws(() => normalizeIntakeForm({ ...base, injuries: 'x'.repeat(1001) }), /cannot exceed 1000/);
});

test('food entries require a name and calories and keep optional macros nullable', () => {
  assert.deepEqual(normalizeFoodEntry({ meal_type: 'lunch', food_name: ' Rice ', ingredients: '', calories: '350.5', protein_g: '', carbs_g: '70', fat_g: '' }), {
    meal_type: 'lunch', food_name: 'Rice', ingredients: '', calories: 350.5, protein_g: null, carbs_g: 70, fat_g: null,
  });
  assert.throws(() => normalizeFoodEntry({ meal_type: 'lunch', food_name: '  ', calories: '10' }), /food or meal name/);
  assert.throws(() => normalizeFoodEntry({ meal_type: 'lunch', food_name: 'x', calories: '' }), /Enter the calories/);
  assert.throws(() => normalizeFoodEntry({ meal_type: 'brunch', food_name: 'x', calories: '1' }), /valid meal/);
  assert.throws(() => normalizeFoodEntry({ meal_type: 'lunch', food_name: 'x', calories: '10001' }), /Calories must be between/);
});

test('food day summary totals calories and macros', () => {
  assert.deepEqual(summarizeFoodDay([
    { calories: 300.5, protein_g: 20, carbs_g: null, fat_g: 5.25 },
    { calories: '199.5', protein_g: null, carbs_g: 40, fat_g: null },
  ]), { calories: 500, protein_g: 20, carbs_g: 40, fat_g: 5.3, count: 2 });
  assert.equal(summarizeFoodDay([]).calories, 0);
});

test('one-rep-max history is grouped per exercise with best, latest and change', () => {
  const grouped = groupOneRepMaxHistory([
    { exercise_id: 'a', exercise_name: 'Squat', workout_date: '2026-02-01', estimated_one_rep_max: 126.7, top_weight_kg: 100, top_reps: 8 },
    { exercise_id: 'a', exercise_name: 'Squat', workout_date: '2026-01-01', estimated_one_rep_max: 116.7, top_weight_kg: 100, top_reps: 5 },
    { exercise_id: 'b', exercise_name: 'Bench', workout_date: '2026-03-01', estimated_one_rep_max: 80, top_weight_kg: 70, top_reps: 4 },
    { exercise_id: 'b', exercise_name: 'Bench', workout_date: '2026-02-01', estimated_one_rep_max: 85, top_weight_kg: 75, top_reps: 4 },
  ]);
  assert.deepEqual(grouped.map((exercise) => exercise.name), ['Bench', 'Squat']);
  const [bench, squat] = grouped;
  assert.equal(squat.records[0].workout_date, '2026-01-01');
  assert.equal(squat.change, 10);
  assert.equal(squat.best.estimated_one_rep_max, 126.7);
  assert.equal(bench.best.estimated_one_rep_max, 85);
  assert.equal(bench.latest.estimated_one_rep_max, 80);
  assert.equal(bench.change, -5);
});

test('program contents are counted for template cards', () => {
  assert.deepEqual(countProgramContents({ days: [{ exercises: [{}, {}] }, { exercises: [] }, {}] }), { dayCount: 3, exerciseCount: 2 });
  assert.deepEqual(countProgramContents({}), { dayCount: 0, exerciseCount: 0 });
});