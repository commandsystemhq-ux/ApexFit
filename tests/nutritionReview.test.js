import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildUsdaUrl, createFoodCache, normalizeUsdaFood, searchFoods, tidyUsdaName } from '../api/_lib/foodSearch.js';
import { MIN_FOODS, buildFoods, energyProblem, parseLine, readParts, slugify } from '../scripts/build-common-foods.mjs';
import { devFoodSearch } from '../scripts/vite-dev-food-search.mjs';
import { buildTargetProgress, calorieAdherence, groupLogsByDay } from '../src/services/foodReviewUtils.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115002800_coach_food_log_review.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
  await db.query(
    `insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, calories, protein_g) values
       ($1, current_date, 'breakfast', 'Oats', 155.6, 6.8), ($1, current_date, 'lunch', 'Rice', 195, 4), ($2, current_date, 'lunch', 'Omar lunch', 500, 20)`,
    [ids.sara, ids.omar],
  );
});

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('a coach reads the food log of their own active clients and nobody else\'s', async () => {
  const mine = await as(ids.coach).from('client_food_logs').select('food_name');
  assert.deepEqual(mine.data.map((row) => row.food_name).sort(), ['Oats', 'Rice']);
  const others = await as(ids.other).from('client_food_logs').select('food_name');
  assert.deepEqual(others.data.map((row) => row.food_name), ['Omar lunch']);
  const own = await as(ids.sara).from('client_food_logs').select('food_name');
  assert.equal(own.data.length, 2);
  assert.deepEqual((await as(ids.omar).from('client_food_logs').select('food_name')).data.map((row) => row.food_name), ['Omar lunch']);
});

test('the coach view is read-only: no insert, update or delete, and the client keeps control', async () => {
  const coach = as(ids.coach);
  assert.ok((await coach.sql("insert into public.client_food_logs (client_id, meal_type, food_name, calories) values ($1, 'snack', 'Injected', 1)", [ids.sara])).error);
  await coach.sql("update public.client_food_logs set calories = 1 where client_id = $1", [ids.sara]);
  await coach.sql('delete from public.client_food_logs where client_id = $1', [ids.sara]);
  assert.deepEqual((await rows("select food_name, calories::float as calories from public.client_food_logs where client_id = $1 order by food_name", [ids.sara])), [
    { food_name: 'Oats', calories: 155.6 }, { food_name: 'Rice', calories: 195 },
  ]);
  const edit = await as(ids.sara).sql("update public.client_food_logs set calories = 160 where food_name = 'Oats'");
  assert.equal(edit.error, null);
});

test('an archived client, a coach without a plan and another client see nothing more', async () => {
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual((await as(ids.coach).from('client_food_logs').select('food_name')).data, []);
  await db.query("update public.coach_clients set status = 'active' where client_id = $1", [ids.sara]);
  assert.equal((await as(ids.coach).from('client_food_logs').select('food_name')).data.length, 2);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coach]);
  assert.deepEqual((await as(ids.coach).from('client_food_logs').select('food_name')).data, []);
  assert.equal((await as(ids.omar).from('client_food_logs').select('food_name')).data.length, 1);
});

test('the coach sets the daily goal and the client sees it next to what they logged', async () => {
  const set = await as(ids.coach).rpc('set_client_nutrition_targets', { p_client_id: ids.sara, p_calories: 2000, p_protein: 150, p_carbs: 200, p_fats: 60 });
  assert.equal(set.error, null, set.error?.message);
  const seenByClient = await as(ids.sara).from('nutrition_targets').select('calories,protein_g,carbs_g,fats_g,set_by').eq('client_id', ids.sara).maybeSingle();
  assert.equal(seenByClient.data.calories, 2000);
  assert.equal(seenByClient.data.set_by, ids.coach);
  assert.equal((await as(ids.coach).from('nutrition_targets').select('calories').eq('client_id', ids.sara).maybeSingle()).data.calories, 2000);
  assert.equal((await as(ids.other).from('nutrition_targets').select('calories').eq('client_id', ids.sara).maybeSingle()).data, null);
  assert.match((await as(ids.other).rpc('set_client_nutrition_targets', { p_client_id: ids.sara, p_calories: 1, p_protein: null, p_carbs: null, p_fats: null })).error.message, /not found/);
});

// ------------------------------------------------------------------------------------- the numbers

test('progress against the goal shows what is eaten, what is left and when it is over', () => {
  const rowsFor = buildTargetProgress({ calories: 2000, protein_g: 150, carbs_g: null, fats_g: 60 }, { calories: 2150.4, protein_g: 75, carbs_g: 10, fat_g: 20 });
  assert.deepEqual(rowsFor.map((row) => row.key), ['calories', 'protein', 'fat']);
  const [calories, protein, fat] = rowsFor;
  assert.deepEqual([calories.eaten, calories.remaining, calories.over, calories.percent], [2150.4, -150.4, true, 100]);
  assert.deepEqual([protein.remaining, protein.percent, protein.over], [75, 50, false]);
  assert.equal(fat.remaining, 40);
  assert.deepEqual(buildTargetProgress(null, { calories: 1 }), []);
  assert.deepEqual(buildTargetProgress({ calories: null }, {}), []);
  assert.equal(buildTargetProgress({ calories: 2000 }, undefined)[0].eaten, 0);
});

test('a client\'s days are grouped newest first with their meals and averages', () => {
  const logs = [
    { id: 'a', logged_on: '2026-11-20', meal_type: 'lunch', calories: 600, protein_g: 40, carbs_g: 60, fat_g: 20 },
    { id: 'b', logged_on: '2026-11-20', meal_type: 'breakfast', calories: 300, protein_g: 10, carbs_g: 40, fat_g: 8 },
    { id: 'c', logged_on: '2026-11-18', meal_type: 'dinner', calories: 2500, protein_g: 100, carbs_g: 200, fat_g: 90 },
  ];
  const days = groupLogsByDay(logs, '2026-11-20', 3);
  assert.deepEqual(days.map((day) => [day.date, day.count]), [['2026-11-20', 2], ['2026-11-19', 0], ['2026-11-18', 1]]);
  assert.deepEqual(days[0].meals.map((group) => group.meal), ['breakfast', 'lunch']);
  assert.equal(days[0].totals.calories, 900);
  assert.deepEqual(calorieAdherence(days, { calories: 2000 }), { loggedDays: 2, withinGoal: 1, average: 1700 });
  assert.equal(calorieAdherence(days, null), null);
  assert.deepEqual(calorieAdherence(groupLogsByDay([], '2026-11-20', 2), { calories: 2000 }), { loggedDays: 0, withinGoal: 0, average: 0 });
});

test('the coach\'s Clients page and the client\'s Food page show the nutrition views', () => {
  const clients = read('src/pages/ClientsPage.jsx');
  for (const piece of ['ClientFoodReview', 'clientTabFood', "setDetailTab('food')", 'role="tabpanel"']) assert.ok(clients.includes(piece), piece);
  const review = read('src/components/ClientFoodReview.jsx');
  assert.match(review, /listClientFoodLogs/);
  assert.match(review, /setClientNutritionTargets/);
  assert.doesNotMatch(review, /addFoodLog|updateFoodLog|deleteFoodLog/);
  const logger = read('src/components/ClientFoodLogger.jsx');
  for (const piece of ['getNutritionTarget', 'FoodTargetProgress', 'buildTargetProgress', 'foodTargetTitle']) assert.ok(logger.includes(piece), piece);
});

test('every language has the nutrition review texts', () => {
  const keys = ['foodTargetTitle', 'foodTargetByCoach', 'foodTargetNone', 'foodTargetLeft', 'foodTargetOver', 'clientTabProfile', 'clientTabFood', 'foodReviewLoadError', 'foodReviewReadOnly',
    'foodReviewTarget', 'foodReviewNoTarget', 'foodReviewRange', 'foodReviewDays', 'foodReviewAdherence', 'foodReviewAverage', 'foodReviewNoLogs', 'foodReviewNothingLogged', 'foodSourceUsda'];
  for (const locale of supportedLocales) for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
  assert.equal(translations.ar.clientTabFood, 'التغذية وسجل الطعام');
});

// ------------------------------------------------------------------------------------------- the layout

test('the page header is solid, the menu stays visible on tablets and the duplicate tab strip is gone where the menu is', () => {
  const css = read('src/styles/app.css');
  assert.match(css, /\.topbar \{[^}]*background: #080a0f;/);
  assert.doesNotMatch(css.match(/\.topbar \{[^}]*\}/)[0], /backdrop-filter|rgba\(8, 10, 15/);
  assert.match(css, /@media \(min-width: 561px\) and \(max-width: 820px\) \{\s*\.sidebar, \[dir='rtl'\] \.sidebar \{ transform: none;/);
  assert.match(css, /@media \(min-width: 561px\) \{ \.client-feature-tabs\.portal-tabs \{ display: none; \} \}/);
  assert.match(read('src/pages/ClientPortalPage.jsx'), /client-feature-tabs portal-tabs/);
  assert.match(read('src/components/AppShell.jsx'), /is-rail/);
});

// ------------------------------------------------------------------------------- USDA and Open Food Facts

const OFF_ITEM = { code: '1', product_name: 'Oat flakes', nutriments: { 'energy-kcal_100g': 370, proteins_100g: 13, carbohydrates_100g: 60, fat_100g: 7 } };
const USDA_FOOD = {
  fdcId: 173904, description: 'OATS, REGULAR AND QUICK, NOT FORTIFIED, DRY',
  foodNutrients: [
    { nutrientId: 1008, value: 379 }, { nutrientId: 1003, value: 13.15 }, { nutrientId: 1004, value: 6.52 }, { nutrientId: 1005, value: 67.7 },
  ],
};
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });

test('USDA foods are normalized per 100 g, with a readable name', () => {
  assert.equal(tidyUsdaName('CHICKEN, BROILERS OR FRYERS, BREAST'), 'Chicken, broilers or fryers, breast');
  assert.deepEqual(normalizeUsdaFood(USDA_FOOD), {
    code: 'usda:173904', name: 'Oats, regular and quick, not fortified, dry', brand: '', per100g: { calories: 379, protein_g: 13.2, carbs_g: 67.7, fat_g: 6.5 }, serving_g: null, source: 'usda',
  });
  assert.equal(normalizeUsdaFood({ fdcId: 1, description: 'KJ only', foodNutrients: [{ nutrientId: 1062, value: 418.4 }] }).per100g.calories, 100);
  assert.equal(normalizeUsdaFood({ fdcId: 2, description: 'No energy', foodNutrients: [] }), null);
  assert.equal(normalizeUsdaFood(null), null);
  const url = new URL(buildUsdaUrl('oats'));
  assert.equal(url.origin + url.pathname, 'https://api.nal.usda.gov/fdc/v1/foods/search');
  assert.equal(url.searchParams.get('query'), 'oats');
  assert.equal(url.searchParams.has('api_key'), false);
});

test('English searches use USDA and Open Food Facts together, with the key in a header and a cache', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return String(url).includes('usda.gov') ? json({ foods: [USDA_FOOD] }) : json({ products: [OFF_ITEM] });
  };
  const cache = createFoodCache();
  const result = await searchFoods({ q: 'oats', lang: 'en' }, { fetchImpl, cache, usdaKey: 'secret-key' });
  assert.deepEqual(result.items.map((item) => item.source), ['usda', 'openfoodfacts']);
  assert.equal(calls.length, 2);
  const usdaCall = calls.find((call) => String(call.url).includes('usda.gov'));
  assert.equal(usdaCall.options.headers['X-Api-Key'], 'secret-key');
  assert.ok(!calls.some((call) => String(call.url).includes('secret-key')));
  assert.ok(calls.every((call) => call.options.signal));
  assert.equal((await searchFoods({ q: 'oats', lang: 'en' }, { fetchImpl, cache, usdaKey: 'secret-key' })).cached, true);
  assert.equal(calls.length, 2);
});

test('Arabic searches and searches without a key skip USDA, and Open Food Facts is asked for Arabic', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return json({ products: [OFF_ITEM] }); };
  await searchFoods({ q: 'شوفان', lang: 'ar' }, { fetchImpl, cache: createFoodCache(), usdaKey: 'k' });
  await searchFoods({ q: 'oats', lang: 'en' }, { fetchImpl, cache: createFoodCache(), usdaKey: '' });
  assert.ok(urls.every((url) => url.includes('openfoodfacts.org')));
  assert.match(urls[0], /langs=ar%2Cen/);
  assert.doesNotMatch(buildUsdaUrl('x'), /openfoodfacts/);
});

test('one source failing still answers, both failing raises the error, and a partial answer is not cached', async () => {
  const cache = createFoodCache();
  const usdaDown = async (url) => (String(url).includes('usda.gov') ? json({}, 503) : json({ products: [OFF_ITEM] }));
  const partial = await searchFoods({ q: 'oats', lang: 'en' }, { fetchImpl: usdaDown, cache, usdaKey: 'k' });
  assert.deepEqual(partial.items.map((item) => item.source), ['openfoodfacts']);
  assert.equal(cache.size, 0);

  const offDown = async (url) => (String(url).includes('usda.gov') ? json({ foods: [USDA_FOOD] }) : json({}, 500));
  assert.deepEqual((await searchFoods({ q: 'rice', lang: 'en' }, { fetchImpl: offDown, cache, usdaKey: 'k' })).items.map((item) => item.source), ['usda']);

  await assert.rejects(searchFoods({ q: 'rice', lang: 'en' }, { fetchImpl: async () => json({}, 500), cache, usdaKey: 'k' }), { status: 502 });
  const hang = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const started = Date.now();
  await assert.rejects(searchFoods({ q: 'slow', lang: 'en' }, { fetchImpl: hang, cache, usdaKey: 'k', timeoutMs: 25 }), { status: 504 });
  assert.ok(Date.now() - started < 1000);
});

test('the endpoint reads the USDA key from the server environment only', () => {
  assert.match(read('api/food-search.js'), /usdaKey: process\.env\.USDA_API_KEY/);
  assert.match(read('.env.example'), /^USDA_API_KEY=$/m);
  assert.doesNotMatch(read('.env.example'), /VITE_[A-Z_]*USDA/);
  const client = ['src/services/foodSearchService.js', 'src/services/foodSearchUtils.js', 'src/components/ClientFoodLogger.jsx'].map(read).join('\n');
  assert.doesNotMatch(client, /usda\.gov|USDA_API_KEY|X-Api-Key/);
});

// ------------------------------------------------------------------------------------ the dev server

function runDevMiddleware(plugin, { method = 'GET', url }) {
  let handler;
  plugin.configureServer({ middlewares: { use: (path, fn) => { assert.equal(path, '/api/food-search'); handler = fn; } } });
  const res = { statusCode: 0, headers: {}, body: '' };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (text) => { res.body = text; };
  return handler({ method, url }, res).then(() => ({ status: res.statusCode, body: JSON.parse(res.body), headers: res.headers }));
}

test('npm run dev answers /api/food-search itself, with the same results and errors as production', async () => {
  const plugin = devFoodSearch({ fetchImpl: async () => json({ products: [OFF_ITEM] }) });
  assert.equal(plugin.apply, 'serve');
  const ok = await runDevMiddleware(plugin, { url: '/?q=oats&lang=en' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.items[0].name, 'Oat flakes');
  assert.match(ok.headers['Content-Type'], /application\/json/);
  const again = await runDevMiddleware(plugin, { url: '/?q=oats&lang=en' });
  assert.equal(again.body.cached, true);

  assert.equal((await runDevMiddleware(plugin, { url: '/?q=a' })).status, 400);
  assert.equal((await runDevMiddleware(plugin, { url: '/?q=oats', method: 'POST' })).status, 405);
  const down = await runDevMiddleware(devFoodSearch({ fetchImpl: async () => json({}, 500) }), { url: '/?q=oats' });
  assert.deepEqual([down.status, typeof down.body.error], [502, 'string']);
});

test('the dev answer is wired into vite.config.js for the dev server only', () => {
  const config = read('vite.config.js');
  assert.match(config, /devFoodSearch\(\{ usdaKey: env\.USDA_API_KEY/);
  assert.match(config, /loadEnv\(mode, process\.cwd\(\), ''\)/);
  assert.match(read('scripts/vite-dev-food-search.mjs'), /apply: 'serve'/);
  assert.doesNotMatch(config, /define\s*:/);
});

// ------------------------------------------------------------------------------------- the food list

test('the food list is built from the parts files, checks every line and keeps at least 1000 foods', () => {
  assert.equal(MIN_FOODS, 1000);
  assert.equal(slugify('Chicken breast (grilled)!'), 'chicken-breast-grilled');
  assert.equal(energyProblem({ calories: 389, protein_g: 16.9, carbs_g: 66.3, fat_g: 6.9 }), null);
  assert.match(energyProblem({ calories: 100, protein_g: 50, carbs_g: 50, fat_g: 50 }), /macros give/);
  assert.equal(energyProblem({ calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }), null);

  assert.ok(parseLine('Oats|شوفان|389|16.9|66.3|6.9|40|اوتس', 'x').food.serving_g === 40);
  for (const bad of ['Oats|شوفان|389|16.9', 'Oats|oats|389|16.9|66.3|6.9', '|شوفان|1|1|1|1', 'Oats|شوفان؟|389|16.9|66.3|6.9', 'Oats|شوفان|-1|1|1|1', 'Oats|شوفان|950|1|1|1', 'Oats|شوفان|100|60|60|1', 'Oats|شوفان|500|1|1|1']) {
    assert.ok(parseLine(bad, 'x').error, bad);
  }

  const built = buildFoods([
    { name: 'a.txt', text: '# comment\nRice|أرز|130|2.7|28.2|0.3|150|رز\n\nRice cooked|الأرز|130|2.7|28.2|0.3\nBroken line' },
    { name: 'b.txt', text: 'Rice|أرز مطبوخ|130|2.7|28.2|0.3' },
  ]);
  assert.equal(built.foods.length, 2);
  assert.equal(built.duplicates, 1);
  assert.equal(built.errors.length, 1);
});

test('the shipped list matches the parts files, with 1000+ unique foods that need no network', () => {
  const shipped = JSON.parse(read('src/data/common-foods.json'));
  const { foods, errors } = buildFoods(readParts());
  assert.deepEqual(errors, []);
  assert.ok(shipped.foods.length >= 1000);
  assert.equal(shipped.foods.length, foods.length);
  assert.deepEqual(shipped.foods.map((food) => food.id), foods.map((food) => food.id));
  assert.equal(new Set(shipped.foods.map((food) => food.id)).size, shipped.foods.length);
  const categories = {
    egyptian: 'كشري', gulf: 'كبسة', levant: 'مناقيش', maghreb: 'طاجين', fish: 'سلمون', sweets: 'كنافة', fastFood: 'بيج ماك', supplements: 'واي بروتين',
  };
  for (const [, word] of Object.entries(categories)) assert.ok(shipped.foods.some((food) => food.name.ar.includes(word)), word);
});
