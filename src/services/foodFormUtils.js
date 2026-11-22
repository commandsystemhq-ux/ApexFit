import { parsePortionGrams } from './foodSearchUtils.js';

// The amount in grams is kept in front of the notes, for example "150 g · Acme" (the table has no grams column).
// The unit may be written in any language the app uses, so editing an old entry finds it again.
const PORTION_PREFIX = /^\s*(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram|grams|جم|جرام|غ|gramm|grammes?|gramos?)(?=[\s·\-–—,;:.]|$)\.?\s*(?:[·\-–—,;:]\s*)?/iu;

export function splitPortion(text) {
  const value = String(text ?? '');
  const match = PORTION_PREFIX.exec(value);
  if (!match) return { grams: '', notes: value.trim() };
  const grams = String(Number(match[1].replace(',', '.')));
  return { grams, notes: value.slice(match[0].length).trim() };
}

export function joinPortion({ grams, unit = 'g', notes = '' }) {
  const amount = parsePortionGrams(grams);
  const note = String(notes ?? '').trim();
  return [amount === null ? '' : `${amount} ${unit}`, note].filter(Boolean).join(' · ').slice(0, 1000);
}

const round1 = (value) => Math.round(value * 10) / 10;

// The values per 100 g that the numbers in the form imply for this amount, so a later change of the amount scales
// the person's own numbers instead of the database's. Null when the amount or calories are not usable.
export function basisFromValues({ calories, protein_g, carbs_g, fat_g }, grams) {
  const amount = parsePortionGrams(grams);
  const kcal = Number(calories);
  if (amount === null || calories === '' || calories === null || !Number.isFinite(kcal) || kcal < 0) return null;
  const per100 = (value) => (value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? 0 : round1((Number(value) * 100) / amount));
  return { calories: round1((kcal * 100) / amount), protein_g: per100(protein_g), carbs_g: per100(carbs_g), fat_g: per100(fat_g) };
}

// A saved log row as the strings the form fields hold.
export function entryToForm(log) {
  const text = (value) => (value === null || value === undefined ? '' : String(value));
  const { grams, notes } = splitPortion(log.ingredients);
  return {
    entry: {
      meal_type: log.meal_type,
      food_name: log.food_name || '',
      ingredients: notes,
      calories: text(log.calories),
      protein_g: text(log.protein_g),
      carbs_g: text(log.carbs_g),
      fat_g: text(log.fat_g),
    },
    grams,
  };
}

export const MACRO_FIELDS = ['calories', 'protein_g', 'carbs_g', 'fat_g'];
