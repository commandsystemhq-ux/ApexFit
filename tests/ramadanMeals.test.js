import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { ramadanTranslations } from '../src/i18n/ramadanTranslations.js';
import { BASE_MEAL_TYPES, MEAL_LABELS, MEAL_TYPES, RAMADAN_MEAL_TYPES, mealTypesFor, normalizeFoodEntry } from '../src/services/clientPriority2Utils.js';
import { groupLogsByDay } from '../src/services/foodReviewUtils.js';
import { MEAL_LABELS as PLAN_LABELS, itemsOfMeal, validatePlan } from '../src/services/mealPlanUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  sara: '00000000-0000-4000-8000-0000000000c1',
};
let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const food = (meal_type, food_name, calories = 100) => ({ meal_type, food_name, grams: 100, calories, protein_g: 1, carbs_g: 10, fat_g: 1, alternatives: [] });

before(async () => { db = await createTestDatabase(); });

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com')", [ids.coach, ids.sara]);
});

// ------------------------------------------------------------------------------------------ the database

test('the food log accepts the three Ramadan meals and still refuses anything else', async () => {
  for (const meal of ['pre_iftar', 'iftar', 'suhoor', 'breakfast']) {
    const result = await as(ids.sara).sql('insert into public.client_food_logs (client_id, meal_type, food_name, calories) values ($1, $2, $3, 120)', [ids.sara, meal, `Food ${meal}`]);
    assert.equal(result.error, null, `${meal}: ${result.error?.message}`);
  }
  const bad = await as(ids.sara).sql("insert into public.client_food_logs (client_id, meal_type, food_name, calories) values ($1, 'brunch', 'x', 1)", [ids.sara]);
  assert.match(bad.error.message, /meal_type_check/);
  assert.equal((await rows('select count(*)::int as n from public.client_food_logs'))[0].n, 4);
});

test('a meal plan holds Ramadan meals and returns them in day order', async () => {
  const items = [food('suhoor', 'Foul'), food('dinner', 'Rice'), food('iftar', 'Dates'), food('pre_iftar', 'Water and dates'), food('breakfast', 'Oats'), food('snack', 'Nuts'), food('lunch', 'Salad')];
  const saved = await as(ids.coach).rpc('save_meal_plan', { p_plan_id: null, p_title: 'Ramadan', p_notes: '', p_is_template: true, p_client_id: null, p_items: items });
  assert.equal(saved.error, null, saved.error?.message);
  const plan = await as(ids.coach).rpc('get_meal_plan', { p_plan_id: saved.data });
  assert.deepEqual(plan.data.items.map((item) => item.meal_type), ['breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor']);
  assert.deepEqual(MEAL_TYPES, plan.data.items.map((item) => item.meal_type));
});

test('a plan still refuses an unknown meal and names the Ramadan meals in the message', async () => {
  const result = await as(ids.coach).rpc('save_meal_plan', { p_plan_id: null, p_title: 'x', p_notes: '', p_is_template: true, p_client_id: null, p_items: [food('brunch', 'x')] });
  assert.match(result.error.message, /Each food needs a meal: .*Ramadan/);
});

test('the client logs a Ramadan meal from the plan into the food log', async () => {
  const saved = await as(ids.coach).rpc('save_meal_plan', {
    p_plan_id: null, p_title: 'Ramadan', p_notes: '', p_is_template: false, p_client_id: ids.sara, p_items: [food('iftar', 'Dates', 150), food('suhoor', 'Foul', 300)],
  });
  assert.equal(saved.error, null, saved.error?.message);
  const mine = await as(ids.sara).rpc('get_my_meal_plan');
  assert.deepEqual(mine.data.items.map((item) => item.meal_type), ['iftar', 'suhoor']);
  const choices = mine.data.items.map((item) => ({ item_id: item.id, alternative: null }));
  const logged = await as(ids.sara).rpc('log_meal_plan_items', { p_plan_id: mine.data.id, p_date: new Date().toISOString().slice(0, 10), p_choices: choices });
  assert.equal(logged.error, null, logged.error?.message);
  const logs = await rows('select meal_type, food_name, calories from public.client_food_logs order by meal_type');
  assert.deepEqual(logs.map((log) => [log.meal_type, log.food_name, Number(log.calories)]), [['iftar', 'Dates', 150], ['suhoor', 'Foul', 300]]);
});

// ------------------------------------------------------------------------------------------ the app

test('the meal list: everyday meals always, Ramadan meals when switched on or already in use', () => {
  assert.deepEqual(BASE_MEAL_TYPES, ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.deepEqual(RAMADAN_MEAL_TYPES, ['pre_iftar', 'iftar', 'suhoor']);
  assert.deepEqual(mealTypesFor(false), ['breakfast', 'lunch', 'dinner', 'snack']);
  assert.deepEqual(mealTypesFor(true), ['breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor']);
  assert.deepEqual(mealTypesFor(false, ['iftar', 'lunch']), ['breakfast', 'lunch', 'iftar', 'dinner', 'snack']);
});

test('a Ramadan meal is a valid food log entry and is kept in a plan and in the day view', () => {
  assert.equal(normalizeFoodEntry({ meal_type: 'suhoor', food_name: 'Foul', calories: '300' }).meal_type, 'suhoor');
  assert.throws(() => normalizeFoodEntry({ meal_type: 'brunch', food_name: 'x', calories: '1' }));
  const items = [{ meal_type: 'iftar', food_name: 'Dates' }, { meal_type: 'lunch', food_name: 'Rice' }];
  assert.deepEqual(itemsOfMeal(items, 'iftar').map((item) => item.food_name), ['Dates']);
  const logs = [
    { logged_on: '2026-11-27', meal_type: 'suhoor', calories: 300 }, { logged_on: '2026-11-27', meal_type: 'iftar', calories: 150 }, { logged_on: '2026-11-27', meal_type: 'breakfast', calories: 100 },
  ];
  const [day] = groupLogsByDay(logs, '2026-11-27', 1);
  assert.deepEqual(day.meals.map((group) => group.meal), ['breakfast', 'iftar', 'suhoor']);
  assert.equal(day.totals.calories, 550);
  assert.equal(validatePlan({ title: 'T', is_template: true, client_id: null, items: [{ ...food('iftar', 'Dates'), grams: 100 }] }).valid, true);
});

test('every meal has a label in all five languages', () => {
  assert.equal(PLAN_LABELS, MEAL_LABELS);
  assert.deepEqual(Object.keys(MEAL_LABELS).sort(), [...MEAL_TYPES].sort());
  for (const locale of supportedLocales) {
    for (const key of Object.values(MEAL_LABELS)) assert.ok(translations[locale][key], `${locale}.${key}`);
    assert.deepEqual(Object.keys(ramadanTranslations[locale]).sort(), Object.keys(ramadanTranslations.en).sort());
    for (const key of Object.keys(ramadanTranslations.en)) assert.equal(translations[locale][key], ramadanTranslations[locale][key], `${locale}.${key}`);
  }
  assert.equal(translations.ar.mealPreIftar, 'قبل الإفطار');
  assert.equal(translations.ar.mealIftar, 'الإفطار');
  assert.equal(translations.ar.mealSuhoor, 'السحور');
});

test('the switch is offered in the plan editor and the food log, and the meal screens share one list of labels', () => {
  assert.match(read('src/components/MealPlanEditor.jsx'), /<RamadanToggle \/>/);
  assert.match(read('src/components/ClientFoodLogger.jsx'), /<RamadanToggle \/>/);
  assert.match(read('src/components/MealPlanEditor.jsx'), /mealTypesFor\(ramadan,/);
  assert.match(read('src/components/ClientFoodLogger.jsx'), /mealTypesFor\(ramadan,/);
  for (const file of ['src/components/ClientFoodLogger.jsx', 'src/components/ClientFoodReview.jsx', 'src/components/JackMealCard.jsx']) {
    assert.doesNotMatch(read(file), /const MEAL_LABELS = \{/, file);
  }
  assert.match(read('api/_lib/jackAccountabilityTools.js'), /enum: \['breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor'\]/);
  assert.ok(read('supabase/manual-setup.sql').includes('-- ===== 20261115004100_ramadan_meals.sql ====='));
});
