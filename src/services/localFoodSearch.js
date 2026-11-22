import commonFoods from '../data/common-foods.json' with { type: 'json' };

const ARABIC_LETTERS = /[\u0600-\u06FF]/;
const MAX_LOCAL_RESULTS = 8;

export const hasArabic = (text) => ARABIC_LETTERS.test(String(text ?? ''));

// Makes spelling variants match: no diacritics or tatweel, alef/yeh/heh forms unified, Arabic digits as 0-9, lower case.
export function normalizeSearchText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "الشوفان" and "شوفان" are the same word for search.
const stripArticle = (word) => (word.length > 3 && word.startsWith('ال') ? word.slice(2) : word);
const tokensOf = (text) => normalizeSearchText(text).split(' ').filter(Boolean).map(stripArticle);

const index = commonFoods.foods.map((food) => {
  const names = [food.name.ar, food.name.en, ...food.aliases.ar, ...food.aliases.en];
  return {
    food,
    // One list of words per name, so "rice cooked" matches a name that has both words.
    terms: names.map((name) => tokensOf(name)),
    phrases: names.map((name) => tokensOf(name).join(' ')),
  };
});

function scoreEntry(entry, queryTokens, queryPhrase) {
  let best = 0;
  for (let index = 0; index < entry.terms.length; index += 1) {
    const words = entry.terms[index];
    const phrase = entry.phrases[index];
    let score = 0;
    if (phrase === queryPhrase) score = 100;
    else if (phrase.startsWith(queryPhrase)) score = 85;
    else if (queryTokens.every((token) => words.some((word) => word.startsWith(token)))) score = 70;
    else if (queryTokens.every((token) => phrase.includes(token))) score = 45;
    // The first name in each language (index 0 and 1) beats an alias.
    if (score && index > 1) score -= 5;
    best = Math.max(best, score);
  }
  return best;
}

// The search is by name only and works without a network. Results are shaped like the ones from /api/food-search.
// The name is shown in Arabic when the person writes Arabic or uses the app in Arabic, otherwise in English.
export function searchLocalFoods(text, { locale = 'en', limit = MAX_LOCAL_RESULTS } = {}) {
  const queryTokens = tokensOf(text);
  if (queryTokens.length === 0) return [];
  const queryPhrase = queryTokens.join(' ');
  if (queryPhrase.length < 2) return [];
  const language = locale === 'ar' || hasArabic(text) ? 'ar' : 'en';

  return index
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens, queryPhrase) }))
    .filter((item) => item.score > 0)
    // Equal scores keep the order of the data file, which lists the most common foods of each group first.
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry: { food } }) => ({
      code: `local:${food.id}`,
      name: food.name[language],
      brand: '',
      per100g: { ...food.per100g },
      serving_g: food.serving_g,
      source: 'local',
    }));
}

// Merges the instant local results with the ones from Open Food Facts: local first, and a product whose name is
// already in the list is not shown twice.
export function mergeFoodResults(local, remote, limit = 20) {
  const seen = new Set(local.map((item) => normalizeSearchText(item.name)));
  const merged = [...local];
  for (const item of remote) {
    const key = normalizeSearchText(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...item, source: item.source || 'openfoodfacts' });
  }
  return merged.slice(0, limit);
}

export const COMMON_FOOD_COUNT = commonFoods.foods.length;
