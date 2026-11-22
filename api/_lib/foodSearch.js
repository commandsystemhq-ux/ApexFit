import { HttpError } from './http.js';

// Open Food Facts needs no key. Requests identify the app as its terms ask.
const OFF_HOST = 'https://world.openfoodfacts.org';
// Name searches use Open Food Facts' current search service (the old search.pl is often overloaded and answers 503).
const OFF_SEARCH_HOST = 'https://search.openfoodfacts.org';
const USER_AGENT = 'ApexFit/0.1 (food logger)';
const FIELDS = 'code,product_name,product_name_en,product_name_ar,generic_name,brands,serving_size,serving_quantity,nutriments';
const SEARCH_FIELDS = 'code,product_name,generic_name,brands,serving_quantity,nutriments';

export const FOOD_SEARCH_TIMEOUT_MS = 5000;
export const FOOD_CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_RESULTS = 12;
const KJ_PER_KCAL = 4.184;
const ARABIC_LETTERS = /[\u0600-\u06FF]/;

const round1 = (value) => Math.round(value * 10) / 10;

function nutrient(nutriments, key) {
  const value = Number(nutriments?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Per 100 g values. Calories fall back to kilojoules when the kcal field is missing.
export function per100gFrom(nutriments) {
  let calories = nutrient(nutriments, 'energy-kcal_100g');
  if (calories === null) {
    const kilojoules = nutrient(nutriments, 'energy_100g');
    calories = kilojoules === null ? null : kilojoules / KJ_PER_KCAL;
  }
  if (calories === null) return null;
  return {
    calories: round1(calories),
    protein_g: round1(nutrient(nutriments, 'proteins_100g') ?? 0),
    carbs_g: round1(nutrient(nutriments, 'carbohydrates_100g') ?? 0),
    fat_g: round1(nutrient(nutriments, 'fat_100g') ?? 0),
  };
}

// For Arabic users: the Arabic name first, then a general name that is already written in Arabic letters.
function pickName(product, lang) {
  const usable = (value) => typeof value === 'string' && value.trim();
  const arabicGeneral = usable(product.product_name) && ARABIC_LETTERS.test(product.product_name) ? product.product_name : null;
  const ordered = lang === 'ar'
    ? [product.product_name_ar, arabicGeneral, product.product_name, product.product_name_en, product.generic_name]
    : [product.product_name_en, product.product_name, product.product_name_ar, product.generic_name];
  const name = ordered.find(usable);
  return name ? name.trim().slice(0, 160) : '';
}

// Brands come as one text ("Acme, Other") from the product service and as a list from the search service.
function firstBrand(brands) {
  const first = Array.isArray(brands) ? brands[0] : typeof brands === 'string' ? brands.split(',')[0] : '';
  return typeof first === 'string' ? first.trim().slice(0, 80) : '';
}

// A product with no name or no calorie data cannot fill the form, so it is dropped.
export function normalizeProduct(product, lang = 'en') {
  if (!product || typeof product !== 'object') return null;
  const name = pickName(product, lang);
  const per100g = per100gFrom(product.nutriments);
  if (!name || !per100g) return null;
  const serving = Number(product.serving_quantity);
  return {
    code: String(product.code || '').replace(/\D/g, '').slice(0, 14),
    name,
    brand: firstBrand(product.brands),
    per100g,
    serving_g: Number.isFinite(serving) && serving > 0 && serving <= 5000 ? round1(serving) : null,
    source: 'openfoodfacts',
  };
}

// For Arabic users the products named in Arabic go first; the order inside each group is kept.
export function rankByLanguage(items, lang) {
  if (lang !== 'ar') return items;
  return [...items.filter((item) => ARABIC_LETTERS.test(item.name)), ...items.filter((item) => !ARABIC_LETTERS.test(item.name))];
}

export function parseFoodQuery(query = {}) {
  const lang = query.lang === 'ar' ? 'ar' : 'en';
  const barcode = String(query.barcode ?? '').trim();
  if (barcode) {
    if (!/^\d{8,14}$/.test(barcode)) throw new HttpError(400, 'Enter a valid barcode (8 to 14 digits).');
    return { type: 'barcode', value: barcode, lang };
  }
  const text = String(query.q ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 2) throw new HttpError(400, 'Type at least 2 characters to search.');
  if (text.length > 80) throw new HttpError(400, 'The search text is too long.');
  return { type: 'name', value: text, lang };
}

// `lc` / `langs` ask Open Food Facts for the person's language, so Arabic names come back when the product has them.
// The search text loses the characters that are query syntax there (quotes, colons, brackets).
export function buildFoodUrl({ type, value, lang = 'en' }) {
  if (type === 'barcode') return `${OFF_HOST}/api/v2/product/${value}.json?lc=${lang}&fields=${FIELDS}`;
  const params = new URLSearchParams({
    q: value.replace(/[":()[\]{}\\]/g, ' ').replace(/\s+/g, ' ').trim(),
    page_size: String(MAX_RESULTS),
    langs: lang === 'ar' ? 'ar,en' : 'en',
    fields: SEARCH_FIELDS,
  });
  return `${OFF_SEARCH_HOST}/search?${params}`;
}
export function createFoodCache({ ttlMs = FOOD_CACHE_TTL_MS, max = MAX_CACHE_ENTRIES, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key, value) {
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(key, { at: now(), value });
    },
    get size() { return entries.size; },
  };
}

// ------------------------------------------------------------------------------------------------ USDA FoodData Central

const USDA_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const MAX_USDA_RESULTS = 6;

function usdaNutrient(food, ids) {
  for (const id of ids) {
    const found = (food.foodNutrients || []).find((item) => Number(item.nutrientId) === id || String(item.nutrientNumber) === String(id));
    const value = Number(found?.value);
    if (found && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

// "CHICKEN, BROILERS OR FRYERS, BREAST, COOKED" -> "Chicken, broilers or fryers, breast, cooked"
export function tidyUsdaName(description) {
  const text = String(description ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return (text.charAt(0).toUpperCase() + text.slice(1)).slice(0, 160);
}

// USDA reports generic foods per 100 g. Energy comes as kcal (1008) or the Atwater kcal figures; kilojoules (1062) is the last resort.
export function normalizeUsdaFood(food) {
  if (!food || typeof food !== 'object') return null;
  const name = tidyUsdaName(food.description);
  let calories = usdaNutrient(food, [1008, 2047, 2048]);
  if (calories === null) {
    const kilojoules = usdaNutrient(food, [1062]);
    calories = kilojoules === null ? null : kilojoules / KJ_PER_KCAL;
  }
  if (!name || calories === null) return null;
  return {
    code: `usda:${food.fdcId}`,
    name,
    brand: '',
    per100g: {
      calories: round1(calories),
      protein_g: round1(usdaNutrient(food, [1003]) ?? 0),
      carbs_g: round1(usdaNutrient(food, [1005]) ?? 0),
      fat_g: round1(usdaNutrient(food, [1004]) ?? 0),
    },
    serving_g: null,
    source: 'usda',
  };
}

export function buildUsdaUrl(text) {
  const params = new URLSearchParams({ query: text, pageSize: String(MAX_USDA_RESULTS * 2), dataType: 'Foundation,SR Legacy' });
  return `${USDA_URL}?${params}`;
}

// ---------------------------------------------------------------------------------------------------- searching

// One request with its own 5 second limit. 404 can be accepted (an unknown barcode). Failures become 502 / 504 so the
// page can fall back to the built-in foods and manual entry.
async function requestJson(url, { fetchImpl, timeoutMs, headers, acceptNotFound = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, signal: controller.signal });
    if (response.status === 404 && acceptNotFound) return {};
    if (!response.ok) throw new HttpError(502, 'The food database is not available right now.');
    return await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'AbortError') throw new HttpError(504, 'The food database took too long to answer.');
    throw new HttpError(502, 'The food database is not available right now.');
  } finally {
    clearTimeout(timer);
  }
}

async function searchOpenFoodFacts(parsed, options) {
  const payload = await requestJson(buildFoodUrl(parsed), { ...options, acceptNotFound: parsed.type === 'barcode' });
  const found = payload?.hits ?? payload?.products;
  const products = parsed.type === 'barcode' ? [payload?.product] : (Array.isArray(found) ? found : []);
  return rankByLanguage(products.map((product) => normalizeProduct(product, parsed.lang)).filter(Boolean), parsed.lang);
}

async function searchUsda(parsed, options, usdaKey) {
  const payload = await requestJson(buildUsdaUrl(parsed.value), { ...options, headers: { 'X-Api-Key': usdaKey } });
  const foods = Array.isArray(payload?.foods) ? payload.foods : [];
  return foods.map(normalizeUsdaFood).filter(Boolean).slice(0, MAX_USDA_RESULTS);
}

// Returns { items, cached }. Generic foods come from USDA FoodData Central (English names, only when a key is set) and
// packaged products from Open Food Facts; both run at the same time. If one is down the other still answers; only when
// every source fails does it raise the 502 / 504 that makes the page fall back to the built-in foods. A partly failed
// answer is not cached.
export async function searchFoods(query, { fetchImpl = fetch, cache = createFoodCache(), timeoutMs = FOOD_SEARCH_TIMEOUT_MS, usdaKey = '' } = {}) {
  const parsed = parseFoodQuery(query);
  const key = `${parsed.type}:${parsed.lang}:${parsed.value.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return { items: cached, cached: true };

  const options = { fetchImpl, timeoutMs };
  const useUsda = Boolean(usdaKey) && parsed.type === 'name' && !ARABIC_LETTERS.test(parsed.value);
  const [off, usda] = await Promise.allSettled([searchOpenFoodFacts(parsed, options), useUsda ? searchUsda(parsed, options, usdaKey) : Promise.resolve([])]);
  if (off.status === 'rejected' && (!useUsda || usda.status === 'rejected')) throw off.reason;

  const items = [...(usda.status === 'fulfilled' ? usda.value : []), ...(off.status === 'fulfilled' ? off.value : [])].slice(0, MAX_RESULTS);
  if (off.status === 'fulfilled' && usda.status === 'fulfilled') cache.set(key, items);
  return { items, cached: false };
}