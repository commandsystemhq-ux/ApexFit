// Exercise names and steps in the user's language, and the search text that matches the database's.

export const EXERCISE_LOCALES = ['ar', 'de', 'fr', 'es'];

const ACCENT_FROM = 'àâäáãåçéèêëíìîïñóòôöõúùûüýÿßÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ';
const ACCENT_TO = 'aaaaaaceeeeiiiinooooouuuuyysaaaaaaceeeeiiiinooooouuuuy';
const ACCENTS = new Map([...ACCENT_FROM].map((char, index) => [char, ACCENT_TO[index]]));
const ARABIC_FORMS = new Map([['\u0623', '\u0627'], ['\u0625', '\u0627'], ['\u0622', '\u0627'], ['\u0671', '\u0627'], ['\u0649', '\u064A'], ['\u0629', '\u0647']]);

// Must stay identical to normalize_search_text() in supabase/migrations/20261115002100_exercise_translations.sql.
export function normalizeSearchText(value) {
  const mapped = [...String(value ?? '').toLowerCase()].map((char) => ACCENTS.get(char) ?? ARABIC_FORMS.get(char) ?? char).join('');
  return mapped
    .replace(/[\u064B-\u0652\u0640\u0670]/g, '')
    .replace(/[-/_,.()'"+&:;!?%\\*]+/g, ' ')
    .replace(/(^| )\u0627\u0644(?=[^ ]{2})/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// The words a search must find, at most six. "Push up" and "ضغط" each become separate words.
export function searchTokens(term) {
  return normalizeSearchText(String(term ?? '').slice(0, 100)).split(' ').filter(Boolean).slice(0, 6);
}

export function localizedName(exercise, locale) {
  if (!exercise || locale === 'en') return '';
  const name = exercise.name_i18n?.[locale];
  return typeof name === 'string' && name.trim() && name.trim().toLowerCase() !== String(exercise.name || '').trim().toLowerCase() ? name.trim() : '';
}

// "Push-Up / تمرين الضغط" (the English name always comes first, then the name in the chosen language when there is one).
export function displayName(exercise, locale) {
  if (!exercise?.name) return '';
  const local = localizedName(exercise, locale);
  return local ? `${exercise.name} / ${local}` : exercise.name;
}

// The steps in the chosen language, or the English steps when that language has none yet.
export function localizedInstructions(exercise, locale) {
  const english = Array.isArray(exercise?.instructions) ? exercise.instructions : [];
  const translated = locale === 'en' ? null : exercise?.instructions_i18n?.[locale];
  if (Array.isArray(translated) && translated.length > 0 && translated.every((step) => typeof step === 'string')) {
    return { steps: translated, locale, translated: true };
  }
  return { steps: english, locale: 'en', translated: locale === 'en' };
}

export const textDirection = (locale) => (locale === 'ar' ? 'rtl' : 'ltr');