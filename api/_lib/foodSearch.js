import { HttpError } from './http.js';

// Open Food Facts needs no key. Requests identify the app as its terms ask.
const OFF_HOST = 'https://world.openfoodfacts.org';
const USER_AGENT = 'ApexFit/0.1 (food logger)';
const FIELDS = 'code,product_name,product_name_en,product_name_ar,generic_name,brands,serving_size,serving_quantity,nutriments';

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
    brand: typeof product.brands === 'string' ? product.brands.split(',')[0].trim().slice(0, 80) : '',
    per100g,
    serving_g: Number.isFinite(serving) && serving > 0 && serving <= 5000 ? round1(serving) : null,
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

// `lc` asks Open Food Facts for the person's language, so Arabic names come back when the product has them.
export function buildFoodUrl({ type, value, lang = 'en' }) {
  if (type === 'barcode') return `${OFF_HOST}/api/v2/product/${value}.json?lc=${lang}&fields=${FIELDS}`;
  const params = new URLSearchParams({
    search_terms: value, search_simple: '1', action: 'process', json: '1', lc: lang, page_size: String(MAX_RESULTS), fields: FIELDS,
  });
  return `${OFF_HOST}/cgi/search.pl?${params}`;
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

// Returns { items, cached }. A slow or failing Open Food Facts raises a 504/502 so the page can fall back to manual entry.
export async function searchFoods(query, { fetchImpl = fetch, cache = createFoodCache(), timeoutMs = FOOD_SEARCH_TIMEOUT_MS } = {}) {
  const parsed = parseFoodQuery(query);
  const key = `${parsed.type}:${parsed.lang}:${parsed.value.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return { items: cached, cached: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;
  try {
    const response = await fetchImpl(buildFoodUrl(parsed), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404 && parsed.type === 'barcode') payload = {};
    else if (!response.ok) throw new HttpError(502, 'The food database is not available right now.');
    else payload = await response.json();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === 'AbortError') throw new HttpError(504, 'The food database took too long to answer.');
    throw new HttpError(502, 'The food database is not available right now.');
  } finally {
    clearTimeout(timer);
  }

  const products = parsed.type === 'barcode' ? [payload?.product] : (Array.isArray(payload?.products) ? payload.products : []);
  const items = rankByLanguage(products.map((product) => normalizeProduct(product, parsed.lang)).filter(Boolean), parsed.lang).slice(0, MAX_RESULTS);
  cache.set(key, items);
  return { items, cached: false };
}
