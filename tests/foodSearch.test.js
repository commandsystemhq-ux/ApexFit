import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFoodCache, normalizeProduct, parseFoodQuery, per100gFrom, searchFoods } from '../api/_lib/foodSearch.js';
import {
  FOOD_SEARCH_DEBOUNCE_MS, buildFoodSearchUrl, classifyFoodQuery, createDebouncer, defaultPortionGrams, parsePortionGrams, scaleFoodPortion,
} from '../src/services/foodSearchUtils.js';
import { normalizeFoodEntry } from '../src/services/clientPriority2Utils.js';
import { translations } from '../src/i18n/translations.js';

const OATS = {
  code: '3017620422003', product_name: 'Oats', product_name_ar: 'شوفان', brands: 'Acme, Other', serving_quantity: '40',
  nutriments: { 'energy-kcal_100g': 372, proteins_100g: 13.5, carbohydrates_100g: 58.7, fat_100g: 7 },
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('products are normalized to per 100 g values and unusable ones are dropped', () => {
  assert.deepEqual(normalizeProduct(OATS, 'en'), {
    code: '3017620422003', name: 'Oats', brand: 'Acme', per100g: { calories: 372, protein_g: 13.5, carbs_g: 58.7, fat_g: 7 }, serving_g: 40,
  });
  assert.equal(normalizeProduct(OATS, 'ar').name, 'شوفان');
  assert.deepEqual(per100gFrom({ energy_100g: 418.4 }), { calories: 100, protein_g: 0, carbs_g: 0, fat_g: 0 });
  assert.equal(normalizeProduct({ ...OATS, nutriments: {} }), null);
  assert.equal(normalizeProduct({ ...OATS, product_name: '', product_name_ar: '', product_name_en: '' }), null);
  assert.equal(normalizeProduct(null), null);
});

test('queries are validated before anything is requested', () => {
  assert.deepEqual(parseFoodQuery({ barcode: ' 3017620422003 ' }), { type: 'barcode', value: '3017620422003', lang: 'en' });
  assert.deepEqual(parseFoodQuery({ q: '  شوفان  ', lang: 'ar' }), { type: 'name', value: 'شوفان', lang: 'ar' });
  assert.throws(() => parseFoodQuery({ barcode: '12ab' }), /valid barcode/);
  assert.throws(() => parseFoodQuery({ q: 'a' }), /at least 2/);
  assert.throws(() => parseFoodQuery({ q: 'x'.repeat(81) }), /too long/);
});

test('a search returns normalized items and the second identical search comes from the cache', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.match(url, /^https:\/\/world\.openfoodfacts\.org\/cgi\/search\.pl\?/);
    assert.ok(options.signal && options.headers['User-Agent']);
    return jsonResponse({ products: [OATS, { code: '1', product_name: 'No data', nutriments: {} }] });
  };
  const cache = createFoodCache();
  const first = await searchFoods({ q: 'Oats' }, { fetchImpl, cache });
  const second = await searchFoods({ q: ' oats ' }, { fetchImpl, cache });
  assert.equal(first.items.length, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test('a barcode lookup uses the product endpoint and an unknown barcode is an empty result', async () => {
  const urls = [];
  const found = await searchFoods({ barcode: '3017620422003' }, { fetchImpl: async (url) => { urls.push(url); return jsonResponse({ product: OATS }); }, cache: createFoodCache() });
  assert.match(urls[0], /\/api\/v2\/product\/3017620422003\.json/);
  assert.equal(found.items[0].name, 'Oats');
  const missing = await searchFoods({ barcode: '3017620422003' }, { fetchImpl: async () => jsonResponse({}, 404), cache: createFoodCache() });
  assert.deepEqual(missing.items, []);
});

test('a slow or failing food database turns into a quick 504 or 502 instead of hanging', async () => {
  const hanging = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  await assert.rejects(searchFoods({ q: 'slow' }, { fetchImpl: hanging, cache: createFoodCache(), timeoutMs: 25 }), { status: 504 });
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(searchFoods({ q: 'down' }, { fetchImpl: async () => jsonResponse({}, 503), cache: createFoodCache() }), { status: 502 });
  await assert.rejects(searchFoods({ q: 'net' }, { fetchImpl: async () => { throw new TypeError('fetch failed'); }, cache: createFoodCache() }), { status: 502 });
});

test('failures are not cached and cache entries expire', async () => {
  let now = 0;
  const cache = createFoodCache({ ttlMs: 100, max: 2, now: () => now });
  cache.set('a', [1]);
  assert.deepEqual(cache.get('a'), [1]);
  now = 101;
  assert.equal(cache.get('a'), undefined);
  cache.set('a', [1]); cache.set('b', [2]); cache.set('c', [3]);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), undefined);

  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) return jsonResponse({}, 500); return jsonResponse({ products: [OATS] }); };
  const shared = createFoodCache();
  await assert.rejects(searchFoods({ q: 'oats' }, { fetchImpl: flaky, cache: shared }), { status: 502 });
  assert.equal((await searchFoods({ q: 'oats' }, { fetchImpl: flaky, cache: shared })).items.length, 1);
});

test('the endpoint needs a signed-in client and the browser never receives a secret', () => {
  const endpoint = readFileSync(new URL('../api/food-search.js', import.meta.url), 'utf8');
  assert.match(endpoint, /authenticate\(req\)/);
  assert.match(endpoint, /requireRole\(userClient, 'client'\)/);
  assert.match(endpoint, /createRateLimiter/);
  const sources = ['../api/_lib/foodSearch.js', '../src/services/foodSearchService.js', '../src/services/foodSearchUtils.js', '../src/components/ClientFoodLogger.jsx']
    .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /VITE_[A-Z_]*(FOOD|OPENFOOD)/);
  assert.doesNotMatch(readFileSync(new URL('../src/services/foodSearchService.js', import.meta.url), 'utf8'), /openfoodfacts/i);
});

test('typed text is told apart as a barcode or a name, in Arabic or English', () => {
  assert.deepEqual(classifyFoodQuery('6001068 595 108'), { barcode: '6001068595108' });
  assert.deepEqual(classifyFoodQuery('  Chicken   breast '), { q: 'Chicken breast', lang: 'en' });
  assert.deepEqual(classifyFoodQuery('دجاج مشوي', 'en'), { q: 'دجاج مشوي', lang: 'ar' });
  assert.deepEqual(classifyFoodQuery('rice', 'ar'), { q: 'rice', lang: 'ar' });
  assert.equal(classifyFoodQuery('a'), null);
  assert.deepEqual(classifyFoodQuery('1234567'), { q: '1234567', lang: 'en' });
  assert.equal(buildFoodSearchUrl({ barcode: '6001068595108' }), '/api/food-search?barcode=6001068595108');
  assert.equal(buildFoodSearchUrl({ q: 'دجاج', lang: 'ar' }), `/api/food-search?q=${encodeURIComponent('دجاج')}&lang=ar`);
});

test('calories and macros scale with the grams and feed the existing save validation', () => {
  const per100g = { calories: 372, protein_g: 13.5, carbs_g: 58.7, fat_g: 7 };
  assert.deepEqual(scaleFoodPortion(per100g, 100), per100g);
  assert.deepEqual(scaleFoodPortion(per100g, '40'), { calories: 148.8, protein_g: 5.4, carbs_g: 23.5, fat_g: 2.8 });
  assert.deepEqual(scaleFoodPortion(per100g, 250.5), { calories: 931.9, protein_g: 33.8, carbs_g: 147.0, fat_g: 17.5 });
  for (const bad of ['', '0', '-5', 'abc', 5001]) assert.equal(scaleFoodPortion(per100g, bad), null);
  assert.equal(parsePortionGrams('12.5'), 12.5);
  assert.equal(defaultPortionGrams({ serving_g: 30 }), 30);
  assert.equal(defaultPortionGrams({ serving_g: null }), 100);

  const scaled = scaleFoodPortion(per100g, 150);
  const saved = normalizeFoodEntry({ meal_type: 'breakfast', food_name: 'Oats', ingredients: '150 g', ...Object.fromEntries(Object.entries(scaled).map(([key, value]) => [key, String(value)])) });
  assert.equal(saved.calories, 558);
  assert.equal(saved.protein_g, 20.3);
});

test('the debounce waits 400 ms and only the last call runs', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(FOOD_SEARCH_DEBOUNCE_MS, 400);
  const debouncer = createDebouncer();
  const ran = [];
  debouncer.schedule(() => ran.push('a'));
  context.mock.timers.tick(300);
  debouncer.schedule(() => ran.push('b'));
  context.mock.timers.tick(399);
  assert.deepEqual(ran, []);
  context.mock.timers.tick(1);
  assert.deepEqual(ran, ['b']);
  debouncer.schedule(() => ran.push('c'));
  debouncer.cancel();
  context.mock.timers.tick(1000);
  assert.deepEqual(ran, ['b']);
});

test('every language has the food search texts, Arabic in Arabic', () => {
  const keys = ['foodSearchLabel', 'foodSearchPlaceholder', 'foodSearchHint', 'foodSearching', 'foodSearchNoResults', 'foodSearchTimeout', 'foodSearchBusy', 'foodSearchUnavailable', 'foodPortionGrams', 'foodPortionHint', 'foodSearchClear', 'foodGramsUnit'];
  for (const locale of ['en', 'ar', 'de', 'fr', 'es']) {
    for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
  }
  assert.match(translations.ar.foodSearchLabel, /[\u0600-\u06FF]/);
  assert.match(translations.ar.foodPortionGrams, /[\u0600-\u06FF]/);
});
