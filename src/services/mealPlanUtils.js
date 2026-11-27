import { basisFromValues } from './foodFormUtils.js';
import { MEAL_LABELS, MEAL_TYPES } from './clientPriority2Utils.js';
import { MAX_PORTION_GRAMS, parsePortionGrams, scaleFoodPortion } from './foodSearchUtils.js';

export { MEAL_LABELS, MEAL_TYPES };
export const MAX_PLAN_FOODS = 60;
export const MAX_ALTERNATIVES = 5;
export const MAX_TITLE = 120;

const round1 = (value) => Math.round(Number(value || 0) * 10) / 10;
let counter = 0;
export const newKey = () => `mp-${Date.now().toString(36)}-${(counter += 1)}`;

// A food as the plan keeps it: the amount in grams, the numbers for that amount, and the numbers per 100 g that make
// changing the amount recalculate everything.
function build({ food_name, food_ref = null, grams, per100, values }) {
  const scaled = per100 ? scaleFoodPortion(per100, grams) : null;
  const numbers = scaled || values;
  return {
    food_name,
    food_ref,
    grams: Number(grams),
    per100: per100 || null,
    calories: round1(numbers?.calories),
    protein_g: round1(numbers?.protein_g),
    carbs_g: round1(numbers?.carbs_g),
    fat_g: round1(numbers?.fat_g),
  };
}

// A result of the food search (the 1,200 local foods or Open Food Facts) with its starting amount.
export function foodFromSearch(result, grams = null) {
  const amount = parsePortionGrams(grams ?? result.serving_g ?? 100) ?? 100;
  return build({ food_name: result.name, food_ref: result.code || null, grams: amount, per100: result.per100g });
}

// A food typed in by hand: the numbers are for the amount given. They are kept per 100 g so the amount can change later.
export function foodFromManual({ name, grams, calories, protein_g = '', carbs_g = '', fat_g = '' }) {
  const errors = {};
  const label = String(name ?? '').trim();
  const amount = parsePortionGrams(grams);
  const kcal = Number(calories);
  if (label.length < 1 || label.length > 160) errors.name = 'mpErr_name';
  if (amount === null) errors.grams = 'mpErr_grams';
  if (calories === '' || calories === null || !Number.isFinite(kcal) || kcal < 0 || kcal > 10000) errors.calories = 'mpErr_calories';
  for (const [key, value] of [['protein_g', protein_g], ['carbs_g', carbs_g], ['fat_g', fat_g]]) {
    if (value !== '' && value !== null && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1000)) errors[key] = 'mpErr_macro';
  }
  if (Object.keys(errors).length) return { errors, food: null };
  const values = { calories: kcal, protein_g: Number(protein_g || 0), carbs_g: Number(carbs_g || 0), fat_g: Number(fat_g || 0) };
  return { errors, food: build({ food_name: label, grams: amount, per100: basisFromValues(values, amount), values }) };
}

// Same food, new amount: the numbers follow.
export function withGrams(food, grams) {
  const amount = parsePortionGrams(grams);
  if (amount === null) return { ...food, grams };
  return build({ ...food, grams: amount, per100: food.per100 || basisFromValues(food, food.grams), values: food });
}

// The grams of an alternative that bring it closest to the calories of the original food.
export function gramsToMatchCalories(per100, targetCalories) {
  const perGram = Number(per100?.calories) / 100;
  if (!(perGram > 0) || !(Number(targetCalories) > 0)) return 100;
  return Math.min(MAX_PORTION_GRAMS, Math.max(1, Math.round(Number(targetCalories) / perGram)));
}

// A saved item or alternative (from the database) as an editable food.
export function hydrateFood(row) {
  const food = {
    food_name: row.food_name,
    food_ref: row.food_ref || null,
    grams: Number(row.grams),
    calories: round1(row.calories),
    protein_g: round1(row.protein_g),
    carbs_g: round1(row.carbs_g),
    fat_g: round1(row.fat_g),
  };
  return { ...food, per100: basisFromValues(food, food.grams) };
}

export function hydratePlan(plan) {
  return {
    id: plan.id || null,
    title: plan.title || '',
    notes: plan.notes || '',
    is_template: Boolean(plan.is_template),
    client_id: plan.client_id || null,
    items: (plan.items || []).map((item) => ({
      ...hydrateFood(item),
      key: newKey(),
      meal_type: item.meal_type,
      notes: item.notes || '',
      recipe_id: item.recipe_id || null,
      alternatives: (item.alternatives || []).map((alt) => ({ ...hydrateFood(alt), key: newKey() })),
    })),
  };
}

export function emptyPlan() {
  return { id: null, title: '', notes: '', is_template: true, client_id: null, items: [] };
}

export function sumFoods(foods) {
  const total = foods.reduce((sum, food) => ({
    calories: sum.calories + Number(food.calories || 0),
    protein_g: sum.protein_g + Number(food.protein_g || 0),
    carbs_g: sum.carbs_g + Number(food.carbs_g || 0),
    fat_g: sum.fat_g + Number(food.fat_g || 0),
  }), { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
  return { calories: round1(total.calories), protein_g: round1(total.protein_g), carbs_g: round1(total.carbs_g), fat_g: round1(total.fat_g) };
}

export function itemsOfMeal(items, meal) {
  return items.filter((item) => item.meal_type === meal);
}

export const mealTotals = (items, meal) => sumFoods(itemsOfMeal(items, meal));
export const planTotals = (items) => sumFoods(items);

const pickFood = (food) => ({
  food_name: food.food_name,
  food_ref: food.food_ref || null,
  grams: round1(food.grams),
  calories: round1(food.calories),
  protein_g: round1(food.protein_g),
  carbs_g: round1(food.carbs_g),
  fat_g: round1(food.fat_g),
});

// What the database function save_meal_plan receives.
export function toItemsPayload(items) {
  return items.map((item) => ({
    ...pickFood(item),
    meal_type: item.meal_type,
    notes: String(item.notes || '').trim(),
    recipe_id: item.recipe_id || null,
    alternatives: (item.alternatives || []).map(pickFood),
  }));
}

// Checks the plan before it is saved. Errors are translation keys.
export function validatePlan({ title, notes, is_template, client_id, items }) {
  const errors = {};
  const name = String(title ?? '').trim();
  if (name.length < 1 || name.length > MAX_TITLE) errors.title = 'mpErr_title';
  if (String(notes ?? '').length > 2000) errors.notes = 'mpErr_notes';
  if (!is_template && !client_id) errors.client = 'mpErr_client';
  if (items.length === 0) errors.items = 'mpErr_noFoods';
  if (items.length > MAX_PLAN_FOODS) errors.items = 'mpErr_tooMany';
  if (items.some((item) => !MEAL_TYPES.includes(item.meal_type) || !(Number(item.grams) >= 1) || Number(item.grams) > MAX_PORTION_GRAMS)) errors.items = 'mpErr_grams';
  return { valid: Object.keys(errors).length === 0, errors, payload: { title: name, notes: String(notes ?? '').trim(), items: toItemsPayload(items) } };
}

// For the client: the choice made for each food of a meal ("original" or the position of an alternative) as the log call wants it.
export function buildLogChoices(items, selections = {}) {
  return items.map((item) => {
    const picked = selections[item.id];
    return { item_id: item.id, alternative: Number.isInteger(picked) && picked >= 0 && picked < (item.alternatives || []).length ? picked : null };
  });
}

// The numbers of a food as the client has chosen it (the food itself or one of its alternatives).
export function chosenFood(item, selections = {}) {
  const picked = selections[item.id];
  return Number.isInteger(picked) && item.alternatives?.[picked] ? item.alternatives[picked] : item;
}