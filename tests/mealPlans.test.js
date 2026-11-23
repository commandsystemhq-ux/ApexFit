import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { mealPlanTranslations } from '../src/i18n/mealPlanTranslations.js';
import { COMMON_FOOD_COUNT, searchLocalFoods } from '../src/services/localFoodSearch.js';
import {
  buildLogChoices, chosenFood, emptyPlan, foodFromManual, foodFromSearch, gramsToMatchCalories, hydratePlan, itemsOfMeal, mealTotals, planTotals,
  toItemsPayload, validatePlan, withGrams,
} from '../src/services/mealPlanUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003300_meal_plans.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  trainer: '00000000-0000-4000-8000-0000000000d1',
};

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function refused(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

const oats = { meal_type: 'breakfast', food_name: 'Oats', food_ref: 'local:oats', grams: 60, calories: 233.4, protein_g: 7.9, carbs_g: 40, fat_g: 4.1, notes: 'with milk', alternatives: [{ food_name: 'Whole wheat bread', food_ref: null, grams: 90, calories: 220, protein_g: 9, carbs_g: 38, fat_g: 3 }] };
const chicken = { meal_type: 'lunch', food_name: 'Chicken breast', grams: 150, calories: 247.5, protein_g: 46.5, carbs_g: 0, fat_g: 5.4, alternatives: [] };
const snack = { meal_type: 'snack', food_name: 'Banana', grams: 118, calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4 };
const save = (userId, overrides = {}) => as(userId).rpc('save_meal_plan', {
  p_plan_id: null, p_title: 'Cutting plan', p_notes: 'Drink water', p_is_template: true, p_client_id: null, p_items: [oats, chicken, snack], ...overrides,
});

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Fit' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara Ali', 'sara@example.com'), ($3, $4, 'Omar Hassan', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
});

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('a coach saves a template with meals, grams, macros and alternatives, and reads it back in meal order', async () => {
  const id = await ok(save(ids.coach));
  const plan = await ok(as(ids.coach).rpc('get_meal_plan', { p_plan_id: id }));
  assert.deepEqual([plan.title, plan.is_template, plan.client_id, plan.notes], ['Cutting plan', true, null, 'Drink water']);
  assert.deepEqual(plan.items.map((item) => [item.meal_type, item.food_name, Number(item.grams), Number(item.calories)]), [
    ['breakfast', 'Oats', 60, 233.4], ['lunch', 'Chicken breast', 150, 247.5], ['snack', 'Banana', 118, 105],
  ]);
  assert.equal(plan.items[0].notes, 'with milk');
  assert.deepEqual(plan.items[0].alternatives, [{ food_name: 'Whole wheat bread', food_ref: null, grams: 90, calories: 220, protein_g: 9, carbs_g: 38, fat_g: 3 }]);
});

test('editing replaces the foods, keeps the order inside each meal and can switch a plan to a client', async () => {
  const id = await ok(save(ids.coach));
  const second = { ...chicken, food_name: 'Rice', grams: 200, calories: 260 };
  await ok(save(ids.coach, { p_plan_id: id, p_title: 'Renamed', p_items: [chicken, second], p_is_template: false, p_client_id: ids.sara }));
  const plan = await ok(as(ids.coach).rpc('get_meal_plan', { p_plan_id: id }));
  assert.deepEqual([plan.title, plan.is_template, plan.client_id], ['Renamed', false, ids.sara]);
  assert.deepEqual(plan.items.map((item) => [item.food_name, item.position]), [['Chicken breast', 0], ['Rice', 1]]);
});

test('plans are checked: name, foods, numbers, alternatives, client and who is asking', async () => {
  await refused(save(ids.coach, { p_title: '  ' }), /plan name/);
  await refused(save(ids.coach, { p_notes: 'n'.repeat(2001) }), /Notes/);
  await refused(save(ids.coach, { p_items: { not: 'an array' } }), /up to 60/);
  await refused(save(ids.coach, { p_items: Array.from({ length: 61 }, () => snack) }), /up to 60/);
  await refused(save(ids.coach, { p_items: [{ ...snack, meal_type: 'brunch' }] }), /Each food needs a meal/);
  await refused(save(ids.coach, { p_items: [{ ...snack, grams: 0 }] }), /name, grams and calories/);
  await refused(save(ids.coach, { p_items: [{ ...snack, calories: 10001 }] }), /name, grams and calories/);
  await refused(save(ids.coach, { p_items: [{ ...snack, food_name: '' }] }), /name, grams and calories/);
  await refused(save(ids.coach, { p_items: [{ ...snack, protein_g: -1 }] }), /name, grams and calories/);
  await refused(save(ids.coach, { p_items: [{ ...snack, notes: 'n'.repeat(301) }] }), /note/);
  await refused(save(ids.coach, { p_items: [{ ...snack, alternatives: Array.from({ length: 6 }, () => oats.alternatives[0]) }] }), /up to 5 alternatives/);
  await refused(save(ids.coach, { p_items: [{ ...snack, alternatives: [{ food_name: 'x', grams: 0, calories: 1 }] }] }), /alternative needs/);
  await refused(save(ids.coach, { p_is_template: true, p_client_id: ids.sara }), /does not belong to a client/);
  await refused(save(ids.coach, { p_is_template: false, p_client_id: ids.omar }), /active client/);
  await refused(save(ids.coach, { p_is_template: false, p_client_id: null }), /or save the plan as a template/);
  await refused(save(ids.sara), /active coach/);
  assert.deepEqual(await rows('select id from public.meal_plans'), []);
});

test('an assistant trainer cannot manage meal plans', async () => {
  const memberId = await ok(as(ids.coach).rpc('invite_trainer', { p_email: 'tina@example.com', p_role_title: '', p_permissions: { manage_programs: true } }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
  await refused(save(ids.trainer), /active coach/);
  assert.deepEqual(await ok(as(ids.trainer).from('meal_plans').select('id')), []);
});

test('giving a template to a client makes a copy and leaves the template as it was', async () => {
  const id = await ok(save(ids.coach));
  const copyId = await ok(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: id, p_client_id: ids.sara }));
  assert.notEqual(copyId, id);
  const copy = await ok(as(ids.coach).rpc('get_meal_plan', { p_plan_id: copyId }));
  assert.deepEqual([copy.is_template, copy.client_id, copy.source_template_id, copy.items.length], [false, ids.sara, id, 3]);
  await ok(save(ids.coach, { p_plan_id: id, p_title: 'Template changed', p_items: [snack] }));
  assert.equal((await ok(as(ids.sara).rpc('get_my_meal_plan'))).items.length, 3);
  await refused(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: id, p_client_id: ids.omar }), /active client/);
  await refused(as(ids.other).rpc('assign_meal_plan', { p_plan_id: id, p_client_id: ids.omar }), /not found/);
});

test('a client sees only the plan given to them, a coach only their own plans', async () => {
  const mine = await ok(save(ids.coach));
  await ok(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: mine, p_client_id: ids.sara }));
  await ok(save(ids.other, { p_title: 'Ben plan' }));

  const sara = await ok(as(ids.sara).rpc('get_my_meal_plan'));
  assert.deepEqual([sara.title, sara.coach_name, sara.items.length], ['Cutting plan', 'Amal Fit', 3]);
  assert.equal(await ok(as(ids.omar).rpc('get_my_meal_plan')), null);
  assert.deepEqual((await ok(as(ids.coach).from('meal_plans').select('title').order('title', { ascending: true }))).map((row) => row.title), ['Cutting plan', 'Cutting plan']);
  assert.deepEqual((await ok(as(ids.other).from('meal_plans').select('title'))).map((row) => row.title), ['Ben plan']);
  assert.deepEqual((await ok(as(ids.sara).from('meal_plans').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  assert.equal((await ok(as(ids.sara).from('meal_plan_items').select('id'))).length, 3);
  assert.deepEqual(await ok(as(ids.omar).from('meal_plan_items').select('id')), []);
  await refused(as(ids.omar).rpc('get_meal_plan', { p_plan_id: mine }), /not found/);
  await refused(as(ids.other).rpc('get_meal_plan', { p_plan_id: mine }), /not found/);
  await refused(as(ids.coach).rpc('get_my_meal_plan'), /client account/);
});

test('nobody writes the meal plan tables directly and a plan can only be changed or deleted by its coach', async () => {
  const id = await ok(save(ids.coach));
  const copyId = await ok(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: id, p_client_id: ids.sara }));
  assert.ok((await as(ids.sara).sql("update public.meal_plans set title = 'Mine now' where id = $1", [copyId])).error);
  assert.ok((await as(ids.sara).sql('delete from public.meal_plan_items')).error);
  assert.ok((await as(ids.coach).sql("insert into public.meal_plans (coach_id, title) values ($1, 'direct')", [ids.coach])).error);
  assert.ok((await as(ids.coach).sql("update public.meal_plan_items set calories = 1")).error);
  await refused(save(ids.other, { p_plan_id: id }), /not found/);
  await refused(as(ids.other).rpc('delete_meal_plan', { p_plan_id: id }), /not found/);
  await refused(as(ids.sara).rpc('delete_meal_plan', { p_plan_id: id }), /active coach/);
  await ok(as(ids.coach).rpc('delete_meal_plan', { p_plan_id: copyId }));
  assert.equal(await ok(as(ids.sara).rpc('get_my_meal_plan')), null);
  assert.equal((await rows('select count(*)::int as n from public.meal_plan_items where plan_id = $1', [copyId]))[0].n, 0);
  assert.equal((await rows('select count(*)::int as n from public.meal_plan_items where plan_id = $1', [id]))[0].n, 3);
});

test('a client copies a meal, or a single food with the alternative they chose, into their food log', async () => {
  const id = await ok(save(ids.coach));
  await ok(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: id, p_client_id: ids.sara }));
  const plan = await ok(as(ids.sara).rpc('get_my_meal_plan'));
  const breakfast = plan.items.find((item) => item.meal_type === 'breakfast');
  const lunch = plan.items.find((item) => item.meal_type === 'lunch');

  assert.equal(await ok(as(ids.sara).rpc('log_meal_plan_items', { p_plan_id: plan.id, p_date: (await rows('select current_date::text as d'))[0].d, p_choices: buildLogChoices([breakfast, lunch], { [breakfast.id]: 0 }) })), 2);
  const logs = await rows('select meal_type, food_name, ingredients, calories::float as calories, protein_g::float as protein_g from public.client_food_logs where client_id = $1 order by meal_type', [ids.sara]);
  assert.deepEqual(logs, [
    { meal_type: 'breakfast', food_name: 'Whole wheat bread', ingredients: '90 g', calories: 220, protein_g: 9 },
    { meal_type: 'lunch', food_name: 'Chicken breast', ingredients: '150 g', calories: 247.5, protein_g: 46.5 },
  ]);
  const today = (await rows('select current_date::text as d'))[0].d;
  assert.equal(await ok(as(ids.sara).rpc('log_meal_plan_items', { p_plan_id: plan.id, p_date: today, p_choices: [{ item_id: breakfast.id, alternative: null }] })), 1);
  assert.equal((await rows('select count(*)::int as n from public.client_food_logs where client_id = $1', [ids.sara]))[0].n, 3);
});

test('logging a plan meal is limited to the client\'s own plan, real foods, real alternatives and recent days', async () => {
  const id = await ok(save(ids.coach));
  await ok(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: id, p_client_id: ids.sara }));
  const plan = await ok(as(ids.sara).rpc('get_my_meal_plan'));
  const item = plan.items[0];
  const today = (await rows('select current_date::text as d'))[0].d;
  const log = (userId, args) => as(userId).rpc('log_meal_plan_items', { p_plan_id: plan.id, p_date: today, p_choices: [{ item_id: item.id, alternative: null }], ...args });

  await refused(log(ids.omar), /not found/);
  await refused(log(ids.coach), /client account/);
  await refused(log(ids.sara, { p_date: '2020-01-01' }), /last 30 days/);
  await refused(log(ids.sara, { p_date: '2999-01-01' }), /last 30 days/);
  await refused(log(ids.sara, { p_choices: [] }), /between 1 and 20/);
  await refused(log(ids.sara, { p_choices: [{ item_id: item.id, alternative: 4 }] }), /does not exist/);
  await refused(log(ids.sara, { p_choices: [{ item_id: '00000000-0000-4000-8000-000000000999', alternative: null }] }), /not part of this plan/);
  await refused(log(ids.sara, { p_choices: [{ item_id: 'nonsense', alternative: null }] }), /not part of this plan/);
  assert.equal((await rows('select count(*)::int as n from public.client_food_logs'))[0].n, 0);
});

// ------------------------------------------------------------------------------------- the numbers

test('the built-in list has 1,200+ foods that can be found in Arabic and English with numbers per 100 g', () => {
  assert.ok(COMMON_FOOD_COUNT >= 1200, `${COMMON_FOOD_COUNT} foods`);
  const rice = searchLocalFoods('rice', { locale: 'en' });
  assert.ok(rice.length > 0);
  assert.ok(rice[0].per100g.calories > 0);
  assert.ok(searchLocalFoods('كشري', { locale: 'ar' }).length > 0);
});

test('a food from the search is worked out for the amount, and changing the amount recalculates it', () => {
  const food = foodFromSearch({ code: 'local:x', name: 'Rice', per100g: { calories: 130, protein_g: 2.7, carbs_g: 28, fat_g: 0.3 }, serving_g: 150 });
  assert.deepEqual([food.grams, food.calories, food.protein_g, food.carbs_g, food.fat_g], [150, 195, 4.1, 42, 0.5]);
  const more = withGrams(food, 200);
  assert.deepEqual([more.grams, more.calories, more.carbs_g], [200, 260, 56]);
  assert.equal(withGrams(food, '').grams, '');
  assert.equal(withGrams(food, '').calories, 195);
  assert.equal(withGrams(food, 99999).grams, 99999);
});

test('a food typed by hand keeps its numbers per 100 g, so a new amount scales them', () => {
  const { food, errors } = foodFromManual({ name: ' Home koshari ', grams: '300', calories: '450', protein_g: '12', carbs_g: '75', fat_g: '9' });
  assert.deepEqual(errors, {});
  assert.deepEqual([food.food_name, food.calories, food.per100.calories], ['Home koshari', 450, 150]);
  assert.equal(withGrams(food, 150).calories, 225);
  const bad = foodFromManual({ name: '', grams: '0', calories: '', protein_g: '-1' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['calories', 'grams', 'name', 'protein_g']);
  assert.equal(bad.food, null);
});

test('an alternative is given the amount that matches the calories of the original food', () => {
  assert.equal(gramsToMatchCalories({ calories: 250 }, 500), 200);
  assert.equal(gramsToMatchCalories({ calories: 0 }, 500), 100);
  assert.equal(gramsToMatchCalories({ calories: 1 }, 100000), 5000);
});

test('totals are per meal and per day, and a saved plan reopens with its numbers per 100 g', () => {
  const plan = hydratePlan({ id: 'p', title: 'T', items: [{ ...oats, id: 'i1' }, { ...chicken, id: 'i2' }, { ...snack, id: 'i3' }] });
  assert.equal(plan.items.length, 3);
  assert.equal(itemsOfMeal(plan.items, 'lunch').length, 1);
  assert.deepEqual(mealTotals(plan.items, 'breakfast'), { calories: 233.4, protein_g: 7.9, carbs_g: 40, fat_g: 4.1 });
  assert.deepEqual(planTotals(plan.items), { calories: 585.9, protein_g: 55.7, carbs_g: 67, fat_g: 9.9 });
  assert.equal(plan.items[0].alternatives[0].food_name, 'Whole wheat bread');
  assert.ok(plan.items[0].per100.calories > 0);
  assert.equal(withGrams(plan.items[0], 120).calories, 466.8);
});

test('a plan is checked before it is saved and sent in the shape the database expects', () => {
  const items = hydratePlan({ items: [oats, chicken] }).items;
  const good = validatePlan({ title: ' Cut ', notes: '', is_template: true, client_id: null, items });
  assert.equal(good.valid, true);
  assert.equal(good.payload.title, 'Cut');
  assert.deepEqual(Object.keys(good.payload.items[0]).sort(), ['alternatives', 'calories', 'carbs_g', 'fat_g', 'food_name', 'food_ref', 'grams', 'meal_type', 'notes', 'protein_g']);
  assert.deepEqual(toItemsPayload(items)[0].alternatives[0], { food_name: 'Whole wheat bread', food_ref: null, grams: 90, calories: 220, protein_g: 9, carbs_g: 38, fat_g: 3 });
  assert.equal(validatePlan({ ...emptyPlan(), title: '', items }).errors.title, 'mpErr_title');
  assert.equal(validatePlan({ ...emptyPlan(), title: 'x', items: [] }).errors.items, 'mpErr_noFoods');
  assert.equal(validatePlan({ title: 'x', is_template: false, client_id: null, items }).errors.client, 'mpErr_client');
  assert.equal(validatePlan({ ...emptyPlan(), title: 'x', items: [{ ...items[0], grams: '' }] }).errors.items, 'mpErr_grams');
  assert.equal(validatePlan({ ...emptyPlan(), title: 'x', items: Array.from({ length: 61 }, () => items[0]) }).errors.items, 'mpErr_tooMany');
});

test('the client\'s choice of alternative decides what is shown, counted and logged', () => {
  const plan = hydratePlan({ items: [{ ...oats, id: 'i1' }, { ...chicken, id: 'i2' }] });
  const [first, second] = plan.items.map((item, index) => ({ ...item, id: `i${index + 1}` }));
  assert.equal(chosenFood(first, {}).food_name, 'Oats');
  assert.equal(chosenFood(first, { i1: 0 }).food_name, 'Whole wheat bread');
  assert.equal(chosenFood(first, { i1: 3 }).food_name, 'Oats');
  assert.deepEqual(buildLogChoices([first, second], { i1: 0, i2: 0 }), [{ item_id: 'i1', alternative: 0 }, { item_id: 'i2', alternative: null }]);
});

// ---------------------------------------------------------------------------------------- the screens

test('the coach builds plans on /meal-plans and the client sees and logs them in Food', () => {
  assert.match(read('src/routes.js'), /mealPlans: \{ path: '\/meal-plans'.*access: 'coach'/);
  assert.match(read('src/App.jsx'), /<MealPlansPage \/>/);
  const portal = read('src/pages/ClientPortalPage.jsx');
  assert.match(portal, /<ClientMealPlan onLogged=/);
  assert.match(portal, /<ClientFoodLogger key=\{foodVersion\} \/>/);
  const editor = read('src/components/MealPlanEditor.jsx');
  for (const piece of ['FoodPicker', 'saveMealPlan', 'MAX_ALTERNATIVES', 'getNutritionTarget', 'FoodTargetProgress']) assert.ok(editor.includes(piece), piece);
  assert.match(read('src/components/FoodPicker.jsx'), /searchLocalFoods/);
  assert.match(read('src/components/ClientMealPlan.jsx'), /logMealPlanItems\(/);
  const service = read('src/services/mealPlanService.js');
  for (const name of ['save_meal_plan', 'assign_meal_plan', 'delete_meal_plan', 'get_meal_plan', 'get_my_meal_plan', 'log_meal_plan_items']) assert.ok(service.includes(`'${name}'`), name);
});

test('every text the meal plan screens use exists in every language, with the same placeholders', () => {
  const sources = ['src/pages/MealPlansPage.jsx', 'src/components/MealPlanEditor.jsx', 'src/components/FoodPicker.jsx', 'src/components/ClientMealPlan.jsx', 'src/services/mealPlanUtils.js', 'src/routes.js'];
  const used = new Set();
  for (const file of sources) for (const match of read(file).matchAll(/['"`]((?:mp[A-Z][A-Za-z]*|mpErr_[A-Za-z]+|navMealPlans))['"`]/g)) used.add(match[1]);
  assert.ok(used.size >= 50, `${used.size} keys`);
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(mealPlanTranslations[locale]).sort(), Object.keys(mealPlanTranslations.en).sort(), locale);
    for (const key of used) assert.ok(translations[locale][key], `${locale}.${key}`);
    for (const key of Object.keys(mealPlanTranslations.en)) assert.equal(placeholders(mealPlanTranslations[locale][key]), placeholders(mealPlanTranslations.en[key]), `${locale}.${key}`);
  }
  for (const key of ['mpTitle', 'mpLogMeal', 'mpAddAlternative', 'navMealPlans']) assert.match(translations.ar[key], /[\u0600-\u06FF]/, key);
});
