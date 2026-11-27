import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { calorieTranslations } from '../src/i18n/calorieTranslations.js';
import {
  ACTIVITY_FACTORS, ADJUSTMENT_LIMITS, ageFromBirthDate, calculate, computeBmr, computeMacros, computeTdee, goalFromIntake, parseNumber,
  targetCalories, validateCalculatorInput,
} from '../src/services/calorieCalculator.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const man = { sex: 'male', weightKg: 80, heightCm: 180, age: 30, bodyFatPct: 15 };
const woman = { sex: 'female', weightKg: 60, heightCm: 165, age: 28, bodyFatPct: null };
const form = (changes = {}) => ({
  sex: 'male', age: '30', heightCm: '180', weightKg: '80', bodyFatPct: '', activity: 'moderate', goal: 'maintain', formula: 'mifflin',
  split: 'goal', adjustmentPct: '', customProtein: '30', customCarbs: '40', customFat: '30', ...changes,
});

// ------------------------------------------------------------------------------------------ the formulas

test('Mifflin-St Jeor, revised Harris-Benedict and Katch-McArdle give the published values', () => {
  assert.equal(computeBmr('mifflin', man), 1780);
  assert.equal(computeBmr('mifflin', woman), 1330.25);
  assert.ok(Math.abs(computeBmr('harris', man) - 1853.632) < 1e-9);
  assert.ok(Math.abs(computeBmr('harris', woman) - 1392.343) < 1e-9);
  assert.ok(Math.abs(computeBmr('katch', man) - 1838.8) < 1e-9);
  assert.equal(computeBmr('katch', woman), null);
  assert.throws(() => computeBmr('other', man), RangeError);
});

test('TDEE multiplies the BMR by the activity factor', () => {
  assert.deepEqual(ACTIVITY_FACTORS, { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 });
  assert.equal(Math.round(computeTdee(1780, 'moderate')), 2759);
  assert.equal(Math.round(computeTdee(1780, 'sedentary')), 2136);
});

test('the goal moves the target: cut -20%, maintain 0, bulk +10%, with a custom percentage and a safe minimum', () => {
  assert.equal(targetCalories(2759, 'cut', { sex: 'male' }).calories, 2207);
  assert.equal(targetCalories(2759, 'maintain', { sex: 'male' }).calories, 2759);
  assert.equal(targetCalories(2759, 'bulk', { sex: 'male' }).calories, 3035);
  assert.equal(targetCalories(2759, 'cut', { sex: 'male', adjustmentPct: -10 }).calories, 2483);
  const floored = targetCalories(1400, 'cut', { sex: 'female' });
  assert.deepEqual([floored.calories, floored.floored, floored.min], [1200, true, 1200]);
  assert.deepEqual([targetCalories(1700, 'cut', { sex: 'male' }).calories, targetCalories(1700, 'cut', { sex: 'male' }).floored], [1500, true]);
  assert.equal(targetCalories(2000, 'cut', { sex: 'male', adjustmentPct: -90 }).adjustmentPct, ADJUSTMENT_LIMITS.min);
});

test('macros: by goal (protein per kg), fixed splits and custom percentages', () => {
  const byGoal = computeMacros({ calories: 2207, weightKg: 80, goal: 'cut' });
  assert.deepEqual(byGoal.grams, { protein: 176, carbs: 238, fat: 61 });
  assert.ok(Math.abs(byGoal.kcalFromMacros - 2207) <= 10);
  const balanced = computeMacros({ calories: 2000, weightKg: 80, split: 'balanced' });
  assert.deepEqual(balanced.grams, { protein: 150, carbs: 200, fat: 67 });
  assert.deepEqual(balanced.percent, { protein: 30, carbs: 40, fat: 30 });
  assert.deepEqual(computeMacros({ calories: 2000, weightKg: 80, split: 'high_protein' }).grams, { protein: 200, carbs: 175, fat: 56 });
  assert.deepEqual(computeMacros({ calories: 2000, weightKg: 80, split: 'low_carb' }).grams, { protein: 175, carbs: 125, fat: 89 });
  assert.deepEqual(computeMacros({ calories: 2000, weightKg: 80, split: 'custom', custom: { protein: 25, carbs: 50, fat: 25 } }).grams, { protein: 125, carbs: 250, fat: 56 });
  assert.throws(() => computeMacros({ calories: 2000, weightKg: 80, split: 'nope' }), RangeError);
});

test('by-goal macros stay sensible on a very low calorie target', () => {
  const low = computeMacros({ calories: 1200, weightKg: 100, goal: 'cut' });
  assert.ok(low.grams.protein * 4 <= 1200 * 0.4 + 4);
  assert.ok(low.grams.carbs >= 0 && low.grams.fat >= 0);
  assert.ok(Math.abs(low.kcalFromMacros - 1200) <= 25);
});

test('calculate returns every formula, the chosen BMR, TDEE, target and the payload for the client goal', () => {
  const check = validateCalculatorInput(form({ bodyFatPct: '15', formula: 'katch', goal: 'cut' }));
  assert.equal(check.ok, true);
  const result = calculate(check.values);
  assert.deepEqual(result.bmrs, { mifflin: 1780, harris: 1854, katch: 1839 });
  assert.equal(result.bmr, 1839);
  assert.equal(result.tdee, 2850);
  assert.equal(result.calories, 2280);
  assert.deepEqual(Object.keys(result.payload), ['calories', 'protein', 'carbs', 'fats']);
  assert.equal(result.payload.calories, 2280);
  const noFat = calculate(validateCalculatorInput(form()).values);
  assert.equal(noFat.bmrs.katch, null);
});

// ------------------------------------------------------------------------------------------ the form

test('the form accepts decimal commas and Arabic-Indic digits', () => {
  assert.equal(parseNumber('72,5'), 72.5);
  assert.equal(parseNumber('٨٠'), 80);
  assert.equal(parseNumber(' '), null);
  assert.equal(parseNumber('abc'), null);
  const check = validateCalculatorInput(form({ age: '٣٠', weightKg: '80,5' }));
  assert.equal(check.ok, true);
  assert.deepEqual([check.values.age, check.values.weightKg], [30, 80.5]);
});

test('the form reports each problem with a translation key', () => {
  const check = validateCalculatorInput(form({ sex: '', age: '5', heightCm: '', weightKg: '500', bodyFatPct: '80', activity: 'x', goal: 'x', formula: 'x', split: 'x' }));
  assert.equal(check.ok, false);
  assert.deepEqual(check.errors, {
    sex: 'ccErr_sex', age: 'ccErr_age', heightCm: 'ccErr_height', weightKg: 'ccErr_weight', bodyFatPct: 'ccErr_bodyFat',
    activity: 'ccErr_activity', goal: 'ccErr_goal', formula: 'ccErr_formula', split: 'ccErr_split',
  });
  for (const key of Object.values(check.errors)) assert.ok(translations.ar[key], key);
});

test('Katch-McArdle needs body fat, custom splits must add up to 100, and the adjustment is limited', () => {
  assert.equal(validateCalculatorInput(form({ formula: 'katch' })).errors.bodyFatPct, 'ccErr_katchNeedsFat');
  assert.equal(validateCalculatorInput(form({ split: 'custom', customProtein: '30', customCarbs: '40', customFat: '40' })).errors.split, 'ccErr_customSum');
  assert.equal(validateCalculatorInput(form({ split: 'custom', customProtein: '30', customCarbs: '40', customFat: '30' })).ok, true);
  assert.equal(validateCalculatorInput(form({ adjustmentPct: '40' })).errors.adjustmentPct, 'ccErr_adjustment');
  assert.equal(validateCalculatorInput(form({ goal: 'cut' })).values.adjustmentPct, -20);
});

test('age comes from the birth date and the goal from the intake form', () => {
  const today = new Date(2026, 10, 27);
  assert.equal(ageFromBirthDate('1996-11-27', today), 30);
  assert.equal(ageFromBirthDate('1996-11-28', today), 29);
  assert.equal(ageFromBirthDate('not a date', today), null);
  assert.equal(ageFromBirthDate('2030-01-01', today), null);
  assert.deepEqual(['fat_loss', 'muscle_gain', 'strength', 'endurance'].map(goalFromIntake), ['cut', 'bulk', 'maintain', 'maintain']);
});

// ------------------------------------------------------------------------------------------ the database

before(async () => { db = await createTestDatabase(); });

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
});

test('the coach gets the latest weight, body fat, intake height and goal already known for the client', async () => {
  await db.query("insert into public.client_body_metrics (client_id, measured_on, weight_kg, body_fat_percentage) values ($1, current_date - 10, 70, 24), ($1, current_date - 2, 68.5, null)", [ids.sara]);
  await db.query("insert into public.client_intake_forms (client_id, primary_goal, experience_level, training_days_per_week, equipment_access, height_cm) values ($1, 'fat_loss', 'beginner', 3, 'full_gym', 168)", [ids.sara]);
  const { data, error } = await as(ids.coach).rpc('get_client_calculator_data', { p_client_id: ids.sara });
  assert.equal(error, null, error?.message);
  assert.deepEqual(
    [Number(data.weight_kg), Number(data.body_fat_pct), Number(data.height_cm), data.height_source, data.intake_goal, data.target, data.sex],
    [68.5, 24, 168, 'intake', 'fat_loss', null, null],
  );
});

test('data is only given to the client coach', async () => {
  assert.match((await as(ids.other).rpc('get_client_calculator_data', { p_client_id: ids.sara })).error.message, /Client was not found/);
  assert.match((await as(ids.sara).rpc('get_client_calculator_data', { p_client_id: ids.sara })).error.message, /Client was not found/);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.match((await as(ids.coach).rpc('get_client_calculator_data', { p_client_id: ids.sara })).error.message, /Client was not found/);
});

test('sex, birth date, height, activity, goal and formula are remembered for the next calculation', async () => {
  const save = (values) => as(ids.coach).rpc('save_client_calculator_profile', {
    p_client_id: ids.sara, p_sex: 'female', p_birth_date: '1996-05-10', p_height_cm: 165.5, p_activity_level: 'light', p_goal: 'cut', p_formula: 'harris', ...values,
  });
  assert.equal((await save({})).error, null);
  await db.query("insert into public.client_intake_forms (client_id, primary_goal, experience_level, training_days_per_week, equipment_access, height_cm) values ($1, 'fat_loss', 'beginner', 3, 'full_gym', 168)", [ids.sara]);
  const { data } = await as(ids.coach).rpc('get_client_calculator_data', { p_client_id: ids.sara });
  assert.deepEqual(
    [data.sex, data.birth_date, Number(data.height_cm), data.height_source, data.activity_level, data.goal, data.formula],
    ['female', '1996-05-10', 165.5, 'profile', 'light', 'cut', 'harris'],
  );
  assert.equal((await save({ p_sex: 'male', p_birth_date: null, p_height_cm: null })).error, null);
  assert.equal((await rows('select count(*)::int as n from public.client_body_profiles'))[0].n, 1);
});

test('the remembered profile rejects values outside the allowed ranges and other coaches', async () => {
  const save = (values, userId = ids.coach) => as(userId).rpc('save_client_calculator_profile', {
    p_client_id: ids.sara, p_sex: 'male', p_birth_date: '1990-01-01', p_height_cm: 180, p_activity_level: 'moderate', p_goal: 'maintain', p_formula: 'mifflin', ...values,
  });
  assert.match((await save({ p_sex: 'other' })).error.message, /male or female/);
  assert.match((await save({ p_birth_date: '2024-01-01' })).error.message, /between 10 and 100/);
  assert.match((await save({ p_birth_date: '1900-01-01' })).error.message, /between 10 and 100/);
  assert.match((await save({ p_height_cm: 20 })).error.message, /Height/);
  assert.match((await save({ p_activity_level: 'extreme' })).error.message, /activity level/);
  assert.match((await save({ p_goal: 'x' })).error.message, /goal/);
  assert.match((await save({ p_formula: 'x' })).error.message, /formula/);
  assert.match((await save({}, ids.other)).error.message, /Client was not found/);
  const direct = await as(ids.coach).sql("insert into public.client_body_profiles (coach_id, client_id, sex) values ($1, $2, 'male')", [ids.coach, ids.sara]);
  assert.ok(direct.error, 'direct writes are refused');
});

test('applying the result writes the daily goal of the client through set_client_nutrition_targets', async () => {
  const result = calculate(validateCalculatorInput(form({ goal: 'cut' })).values);
  const applied = await as(ids.coach).rpc('set_client_nutrition_targets', {
    p_client_id: ids.sara, p_calories: result.payload.calories, p_protein: result.payload.protein, p_carbs: result.payload.carbs, p_fats: result.payload.fats,
  });
  assert.equal(applied.error, null, applied.error?.message);
  const [target] = await rows('select calories, protein_g, carbs_g, fats_g, set_by from public.nutrition_targets where client_id = $1', [ids.sara]);
  assert.deepEqual([target.calories, Number(target.protein_g), Number(target.carbs_g), Number(target.fats_g), target.set_by], [result.payload.calories, result.payload.protein, result.payload.carbs, result.payload.fats, ids.coach]);
  const { data } = await as(ids.coach).rpc('get_client_calculator_data', { p_client_id: ids.sara });
  assert.equal(data.target.calories, result.payload.calories);
});

// ------------------------------------------------------------------------------------------ the screens

test('every calculator text exists in all five languages and is merged into the app dictionary', () => {
  const keys = Object.keys(calorieTranslations.en).sort();
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(calorieTranslations[locale]).sort(), keys, locale);
    for (const key of keys) assert.equal(translations[locale][key], calorieTranslations[locale][key], `${locale}.${key}`);
  }
  assert.match(translations.ar.ccTitle, /[\u0600-\u06FF]/);
  for (const key of ['ccApplied', 'ccMissing', 'ccFromMeasurement', 'ccAdjustHint', 'ccFloored', 'ccCurrentTarget']) {
    const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join();
    for (const locale of supportedLocales) assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale}.${key}`);
  }
});

test('the calculator is in the client profile and in the nutrition section, and the migration is in the manual setup', () => {
  assert.match(read('src/pages/ClientsPage.jsx'), /<CalorieCalculator clientId=\{client\.client_id\} \/>/);
  assert.match(read('src/pages/MealPlansPage.jsx'), /<CalorieCalculatorPanel clients=\{state\.clients\} \/>/);
  assert.match(read('src/services/calorieCalculatorService.js'), /setClientNutritionTargets/);
  assert.ok(read('supabase/manual-setup.sql').includes('-- ===== 20261115004000_calorie_calculator.sql ====='));
});
