// Text helpers shared by the food search and the script that builds the food list.

const ARABIC_LETTERS = /[\u0600-\u06FF]/;

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

