import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipeTranslations } from '../src/i18n/recipeTranslations.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { PAGES, navigationFor } from '../src/routes.js';
import { searchLocalFoods } from '../src/services/localFoodSearch.js';
import { foodFromSearch, hydratePlan, toItemsPayload, validatePlan } from '../src/services/mealPlanUtils.js';
import {
  emptyRecipe, filterRecipes, hydrateRecipe, perServing, recipeToPlanFood, recipeTotals, splitSteps, totalMinutes, validateRecipe,
} from '../src/services/recipeUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
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

const rice = { food_name: 'Rice', food_ref: 'rice', grams: 200, calories: 260, protein_g: 5, carbs_g: 56, fat_g: 0.6, notes: '' };
const chicken = { food_name: 'Chicken breast', food_ref: null, grams: 300, calories: 495, protein_g: 93, carbs_g: 0, fat_g: 11, notes: 'diced' };
const saveRecipe = (userId, overrides = {}) => as(userId).rpc('save_recipe', {
  p_recipe_id: null, p_title: 'Chicken and rice', p_description: 'A simple lunch', p_instructions: '1. Cook the rice\n2. Fry the chicken', p_servings: 2,
  p_prep_minutes: 10, p_cook_minutes: 25, p_items: [rice, chicken], ...overrides,
});
const planItem = (overrides = {}) => ({ meal_type: 'lunch', food_name: 'Chicken and rice', food_ref: null, grams: 250, calories: 377.5, protein_g: 49, carbs_g: 28, fat_g: 5.8, notes: '', alternatives: [], ...overrides });
const savePlan = (userId, items, overrides = {}) => as(userId).rpc('save_meal_plan', { p_plan_id: null, p_title: 'Plan', p_notes: '', p_is_template: true, p_client_id: null, p_items: items, ...overrides });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client', fullName: 'Omar' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($1, $3, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.omar],
  );
});

// ------------------------------------------------------------------------------------------ the database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = read('supabase/migrations/20261115004500_recipes.sql').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(read('supabase/migrations/20261115004500_recipes.sql'));
});

test('a coach saves a recipe and reads it back with totals for the whole recipe and for one serving', async () => {
  const id = await ok(saveRecipe(ids.coach));
  const recipe = await ok(as(ids.coach).rpc('get_recipe', { p_recipe_id: id }));
  assert.equal(recipe.title, 'Chicken and rice');
  assert.equal(recipe.servings, 2);
  assert.deepEqual(recipe.ingredients.map((item) => [item.position, item.food_name, Number(item.grams)]), [[0, 'Rice', 200], [1, 'Chicken breast', 300]]);
  assert.deepEqual(recipe.totals, { grams: 500, calories: 755, protein_g: 98, carbs_g: 56, fat_g: 11.6 });
  assert.deepEqual(recipe.per_serving, { grams: 250, calories: 377.5, protein_g: 49, carbs_g: 28, fat_g: 5.8 });

  const list = await ok(as(ids.coach).rpc('list_my_recipes'));
  assert.equal(list.length, 1);
  assert.equal(list[0].ingredients, undefined, 'the list does not carry the ingredients');
  assert.equal(list[0].per_serving.calories, 377.5);

  const changed = await ok(saveRecipe(ids.coach, { p_recipe_id: id, p_title: 'Rice only', p_servings: 1, p_items: [rice] }));
  assert.equal(changed, id);
  const again = await ok(as(ids.coach).rpc('get_recipe', { p_recipe_id: id }));
  assert.equal(again.ingredients.length, 1);
  assert.equal(again.per_serving.calories, 260);
});

test('recipe input is validated: name, servings, times, ingredients, ownership, role and limits', async () => {
  await refused(saveRecipe(ids.coach, { p_title: '   ' }), /between 1 and 120/);
  await refused(saveRecipe(ids.coach, { p_servings: 0 }), /Servings must be between 1 and 50/);
  await refused(saveRecipe(ids.coach, { p_servings: 51 }), /Servings must be between 1 and 50/);
  await refused(saveRecipe(ids.coach, { p_prep_minutes: -1 }), /0 and 1440/);
  await refused(saveRecipe(ids.coach, { p_cook_minutes: 2000 }), /0 and 1440/);
  await refused(saveRecipe(ids.coach, { p_instructions: 'x'.repeat(6001) }), /6000/);
  await refused(saveRecipe(ids.coach, { p_items: [] }), /between 1 and 40 ingredients/);
  await refused(saveRecipe(ids.coach, { p_items: Array.from({ length: 41 }, () => rice) }), /between 1 and 40 ingredients/);
  await refused(saveRecipe(ids.coach, { p_items: [{ ...rice, grams: 0 }] }), /Each ingredient/);
  await refused(saveRecipe(ids.coach, { p_items: [{ ...rice, calories: 20000 }] }), /Each ingredient/);
  await refused(saveRecipe(ids.coach, { p_items: [{ ...rice, notes: 'x'.repeat(201) }] }), /note can be up to 200/);
  await refused(saveRecipe(ids.sara), /active coach/);
  const theirs = await ok(saveRecipe(ids.other));
  await refused(saveRecipe(ids.coach, { p_recipe_id: theirs }), /not found/);
  await refused(as(ids.coach).rpc('delete_recipe', { p_recipe_id: theirs }), /not found/);
  await db.query("insert into public.recipes (coach_id, title) select $1, 'R' || g from generate_series(1, 300) g", [ids.coach]);
  await refused(saveRecipe(ids.coach, { p_title: 'One too many' }), /up to 300/);
});

test('recipes are private to their coach: the tables cannot be written, and a client cannot open one that is not in their plan', async () => {
  const id = await ok(saveRecipe(ids.coach));
  assert.equal((await as(ids.coach).from('recipes')).data.length, 1);
  assert.deepEqual((await as(ids.other).from('recipes')).data, []);
  assert.deepEqual((await as(ids.sara).from('recipes')).data, []);
  assert.deepEqual((await as(ids.sara).from('recipe_ingredients')).data, []);
  for (const sql of ["insert into public.recipes (coach_id, title) values ($1, 'x')", "update public.recipes set title = 'hacked'", 'delete from public.recipes']) {
    const result = await as(ids.coach).sql(sql, sql.includes('$1') ? [ids.coach] : []);
    assert.match(result.error.message, /permission denied/, sql);
  }
  await refused(as(ids.sara).rpc('get_recipe', { p_recipe_id: id }), /not found/);
  await refused(as(ids.other).rpc('get_recipe', { p_recipe_id: id }), /not found/);
  await refused(as(ids.sara).rpc('list_my_recipes'), /active coach/);
});

test('a recipe goes into a meal plan; the client who receives the plan can read the recipe, nobody else can', async () => {
  const recipe = await ok(saveRecipe(ids.coach));
  const template = await ok(savePlan(ids.coach, [planItem({ recipe_id: recipe })]));
  const saved = await ok(as(ids.coach).rpc('get_meal_plan', { p_plan_id: template }));
  assert.equal(saved.items[0].recipe_id, recipe);

  const given = await ok(as(ids.coach).rpc('assign_meal_plan', { p_plan_id: template, p_client_id: ids.sara }));
  const mine = await ok(as(ids.sara).rpc('get_my_meal_plan'));
  assert.equal(mine.id, given);
  assert.equal(mine.items[0].recipe_id, recipe);
  const opened = await ok(as(ids.sara).rpc('get_recipe', { p_recipe_id: recipe }));
  assert.equal(opened.instructions, '1. Cook the rice\n2. Fry the chicken');
  assert.equal(opened.ingredients.length, 2);
  await refused(as(ids.omar).rpc('get_recipe', { p_recipe_id: recipe }), /not found/);

  await ok(as(ids.coach).rpc('delete_meal_plan', { p_plan_id: given }));
  await refused(as(ids.sara).rpc('get_recipe', { p_recipe_id: recipe }), /not found/);
});

test('a plan can only use the coach own recipes, and deleting a recipe keeps the foods in the plans', async () => {
  const theirs = await ok(saveRecipe(ids.other));
  await refused(savePlan(ids.coach, [planItem({ recipe_id: theirs })]), /your own recipes/);
  await refused(savePlan(ids.coach, [planItem({ recipe_id: 'not-a-uuid' })]), /recipe is not valid/);
  const plain = await ok(savePlan(ids.coach, [planItem({ recipe_id: null }), planItem({ recipe_id: '' })]));
  assert.equal((await ok(as(ids.coach).rpc('get_meal_plan', { p_plan_id: plain }))).items.every((item) => item.recipe_id === null), true);

  const mine = await ok(saveRecipe(ids.coach));
  const plan = await ok(savePlan(ids.coach, [planItem({ recipe_id: mine })]));
  await ok(as(ids.coach).rpc('delete_recipe', { p_recipe_id: mine }));
  const after = await ok(as(ids.coach).rpc('get_meal_plan', { p_plan_id: plan }));
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].recipe_id, null);
  assert.equal(after.items[0].food_name, 'Chicken and rice');
  assert.equal((await rows('select count(*)::int as n from public.recipe_ingredients where recipe_id = $1', [mine]))[0].n, 0, 'the ingredients go with the recipe');
});

// ------------------------------------------------------------------------------------------ the app

test('ingredients from the built-in foods add up to the recipe and one serving', () => {
  const [first] = searchLocalFoods('rice', { locale: 'en', limit: 1 });
  assert.ok(first, 'the built-in list finds rice');
  const food = foodFromSearch(first, 200);
  const form = { ...emptyRecipe(), title: 'Rice', servings: '2', items: [{ ...food, key: 'a', notes: '' }, { ...food, key: 'b', notes: '' }] };
  const totals = recipeTotals(form.items);
  assert.equal(totals.grams, 400);
  assert.equal(totals.calories, Math.round(food.calories * 2 * 10) / 10);
  assert.equal(perServing(totals, 2).calories, Math.round((totals.calories / 2) * 10) / 10);
  assert.equal(perServing(totals, 'x').calories, totals.calories, 'bad servings count as one');
  assert.equal(perServing(totals, 0).grams, 400);
  assert.equal(validateRecipe(form).valid, true);
});

test('the recipe form reports each problem with a translation key and sends the arguments the database expects', () => {
  const food = { ...rice, key: 'a', per100: { calories: 130 } };
  const good = validateRecipe({ ...emptyRecipe(), title: '  Pilaf ', servings: '4', prep_minutes: '10', cook_minutes: '', instructions: ' 1. Cook ', items: [food] });
  assert.equal(good.valid, true);
  assert.deepEqual({ ...good.payload, items: undefined }, { title: 'Pilaf', description: '', instructions: '1. Cook', servings: 4, prepMinutes: 10, cookMinutes: null, items: undefined });
  assert.deepEqual(Object.keys(good.payload.items[0]).sort(), ['calories', 'carbs_g', 'fat_g', 'food_name', 'food_ref', 'grams', 'notes', 'protein_g']);

  const bad = validateRecipe({ title: '', description: 'x'.repeat(1001), instructions: 'x'.repeat(6001), servings: '0', prep_minutes: '-5', cook_minutes: '', items: [] });
  assert.deepEqual(bad.errors, { title: 'rcErr_title', description: 'rcErr_description', instructions: 'rcErr_instructions', servings: 'rcErr_servings', time: 'rcErr_time', items: 'rcErr_noIngredients' });
  assert.equal(validateRecipe({ ...emptyRecipe(), title: 'x', servings: '1.5', items: [food] }).errors.servings, 'rcErr_servings');
  assert.equal(validateRecipe({ ...emptyRecipe(), title: 'x', items: Array.from({ length: 41 }, () => food) }).errors.items, 'rcErr_tooMany');
  assert.equal(validateRecipe({ ...emptyRecipe(), title: 'x', items: [{ ...food, grams: 0 }] }).errors.items, 'rcErr_grams');
});

test('a saved recipe becomes an editable form, and its method reads as numbered steps', () => {
  const form = hydrateRecipe({ id: 'r1', title: 'Pilaf', servings: 3, prep_minutes: 5, cook_minutes: null, ingredients: [{ ...rice, id: 'i1', position: 0 }] });
  assert.deepEqual([form.id, form.servings, form.prep_minutes, form.cook_minutes, form.items.length], ['r1', '3', '5', '', 1]);
  assert.equal(form.items[0].per100.calories, 130);
  assert.deepEqual(splitSteps('1. Chop\n2) Fry\n\n- Serve\n  Enjoy  '), ['Chop', 'Fry', 'Serve', 'Enjoy']);
  assert.deepEqual(splitSteps(''), []);
  assert.equal(totalMinutes({ prep_minutes: 10, cook_minutes: 25 }), 35);
  assert.equal(totalMinutes({}), 0);
  assert.deepEqual(filterRecipes([{ title: 'Chicken rice' }, { title: 'Oats' }], ' CHICK ').map((item) => item.title), ['Chicken rice']);
});

test('a portion of a recipe becomes one food of the plan with the numbers of those servings and a link to the recipe', () => {
  const recipe = { id: 'r1', title: 'Chicken and rice', per_serving: { grams: 250, calories: 377.5, protein_g: 49, carbs_g: 28, fat_g: 5.8 } };
  const one = recipeToPlanFood(recipe, 1);
  assert.deepEqual([one.food_name, one.grams, one.calories, one.protein_g, one.recipe_id], ['Chicken and rice', 250, 377.5, 49, 'r1']);
  assert.equal(one.per100.calories, 151, 'changing the grams in the plan keeps scaling the numbers');
  const half = recipeToPlanFood(recipe, 0.5);
  assert.deepEqual([half.grams, half.calories], [125, 188.8]);
  assert.equal(recipeToPlanFood(recipe, 'x').grams, 250, 'a bad portion count counts as one');

  const plan = hydratePlan({ title: 'Cut', is_template: true, items: [{ ...planItem(), id: 'x', recipe_id: 'r1' }] });
  assert.equal(plan.items[0].recipe_id, 'r1');
  const items = [{ ...one, key: 'k', meal_type: 'lunch', notes: '', alternatives: [] }];
  assert.equal(toItemsPayload(items)[0].recipe_id, 'r1');
  assert.equal(validatePlan({ title: 'Plan', notes: '', is_template: true, client_id: null, items }).valid, true);
});

test('the Recipes page is a coach page in the Training menu, reachable from the meal plan builder and visible to the client', () => {
  assert.equal(PAGES.recipes.path, '/recipes');
  assert.equal(PAGES.recipes.access, 'coach');
  const training = navigationFor('coach').find((section) => section.group === 'navGrpTraining');
  assert.ok(training.items.includes('recipes'));
  assert.ok(training.items.indexOf('recipes') > training.items.indexOf('mealPlans'));
  assert.equal(navigationFor('client').flatMap((section) => section.items).includes('recipes'), false);
  assert.match(read('src/App.jsx'), /<Route path=\{PAGES\.recipes\.path\} element=\{<RecipesPage \/>\} \/>/);
  assert.match(read('src/components/MealPlanEditor.jsx'), /<RecipePicker onPick=\{\(food\) => addFood\(meal, food\)\}/);
  const client = read('src/components/ClientMealPlan.jsx');
  assert.match(client, /item\.recipe_id && <button[\s\S]*?openRecipe\(item\.recipe_id\)/);
  assert.match(client, /<RecipeView recipe=\{recipeDialog\.recipe\} \/>/);
  assert.match(read('src/components/RecipeView.jsx'), /recipe-steps/);
});

test('every recipe text exists in every language with the same placeholders', () => {
  const keys = Object.keys(recipeTranslations.en);
  assert.ok(keys.length >= 45);
  for (const key of keys) {
    for (const locale of supportedLocales) {
      assert.ok(String(recipeTranslations[locale][key]).trim(), `${locale} ${key}`);
      assert.equal(translations[locale][key], recipeTranslations[locale][key], 'no other dictionary overrides it');
    }
  }
  assert.match(translations.ar.rcMethod, /[\u0600-\u06FF]/);
  assert.match(translations.ar.navRecipes, /[\u0600-\u06FF]/);
});
