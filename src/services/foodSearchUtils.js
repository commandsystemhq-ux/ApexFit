export const FOOD_SEARCH_DEBOUNCE_MS = 400;
// The server cuts Open Food Facts off after 5 seconds; this is the browser's own limit, slightly longer so the
// server's answer normally arrives first.
export const FOOD_SEARCH_TIMEOUT_MS = 6000;
export const MAX_PORTION_GRAMS = 5000;

const ARABIC_LETTERS = /[\u0600-\u06FF]/;

// A run of 8 to 14 digits is a barcode; anything else with at least 2 characters is a name search.
export function classifyFoodQuery(text, locale = 'en') {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const digits = value.replace(/[\s-]/g, '');
  const lang = locale === 'ar' || ARABIC_LETTERS.test(value) ? 'ar' : 'en';
  if (/^\d{8,14}$/.test(digits)) return { barcode: digits, lang };
  if (value.length < 2) return null;
  return { q: value.slice(0, 80), lang };
}

export function buildFoodSearchUrl(query) {
  const params = new URLSearchParams(query.barcode ? { barcode: query.barcode, lang: query.lang } : { q: query.q, lang: query.lang });
  return `/api/food-search?${params}`;
}

export function parsePortionGrams(value) {
  const grams = Number(value);
  return Number.isFinite(grams) && grams > 0 && grams <= MAX_PORTION_GRAMS ? grams : null;
}

// Starting amount for a chosen food: the product's own serving when known, otherwise 100 g.
export function defaultPortionGrams(food) {
  return food?.serving_g || 100;
}

// Calories and macros for `grams` of a food given per 100 g. Returns null for an unusable amount.
export function scaleFoodPortion(per100g, grams) {
  const amount = parsePortionGrams(grams);
  if (!per100g || amount === null) return null;
  const scale = (value) => Math.round((Number(value || 0) * amount) / 10) / 10;
  return {
    calories: scale(per100g.calories),
    protein_g: scale(per100g.protein_g),
    carbs_g: scale(per100g.carbs_g),
    fat_g: scale(per100g.fat_g),
  };
}

// Runs only the latest scheduled call, after `delayMs` without a newer one.
export function createDebouncer(delayMs = FOOD_SEARCH_DEBOUNCE_MS) {
  let timer = null;
  return {
    schedule(run) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
