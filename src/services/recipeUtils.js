// Pure helpers for recipes: the form, the calories and macros calculated from the ingredients, one serving, the method
// as steps, and a portion of a recipe as an item of a meal plan. Nothing here touches the network.
import { MAX_PORTION_GRAMS } from './foodSearchUtils.js';
import { hydrateFood, newKey, sumFoods } from './mealPlanUtils.js';

export const MAX_RECIPE_INGREDIENTS = 40;
export const MAX_RECIPE_TITLE = 120;
export const MAX_RECIPE_DESCRIPTION = 1000;
export const MAX_RECIPE_INSTRUCTIONS = 6000;
export const MAX_SERVINGS = 50;
export const MAX_MINUTES = 1440;

const round1 = (value) => Math.round(Number(value || 0) * 10) / 10;

export function emptyRecipe() {
  return { id: null, title: '', description: '', instructions: '', servings: '1', prep_minutes: '', cook_minutes: '', items: [] };
}

// A recipe from the database (get_recipe) as the editable form.
export function hydrateRecipe(row) {
  return {
    id: row.id || null,
    title: row.title || '',
    description: row.description || '',
    instructions: row.instructions || '',
    servings: String(row.servings || 1),
    prep_minutes: row.prep_minutes === null || row.prep_minutes === undefined ? '' : String(row.prep_minutes),
    cook_minutes: row.cook_minutes === null || row.cook_minutes === undefined ? '' : String(row.cook_minutes),
    items: (row.ingredients || []).map((item) => ({ ...hydrateFood(item), key: newKey(), notes: item.notes || '' })),
  };
}

export function recipeTotals(items) {
  return { ...sumFoods(items), grams: round1(items.reduce((sum, item) => sum + Number(item.grams || 0), 0)) };
}

// The numbers of one serving. Servings that are not a whole number between 1 and 50 count as 1.
export function perServing(totals, servings) {
  const count = Number.isInteger(Number(servings)) && Number(servings) >= 1 && Number(servings) <= MAX_SERVINGS ? Number(servings) : 1;
  return {
    grams: round1(totals.grams / count),
    calories: round1(totals.calories / count),
    protein_g: round1(totals.protein_g / count),
    carbs_g: round1(totals.carbs_g / count),
    fat_g: round1(totals.fat_g / count),
  };
}

const minutes = (value) => {
  if (value === '' || value === null || value === undefined) return { ok: true, value: null };
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= MAX_MINUTES ? { ok: true, value: number } : { ok: false, value: null };
};

// Checks the form before saving. Errors are translation keys.
export function validateRecipe(form) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  const servings = Number(form.servings);
  const prep = minutes(form.prep_minutes);
  const cook = minutes(form.cook_minutes);
  if (title.length < 1 || title.length > MAX_RECIPE_TITLE) errors.title = 'rcErr_title';
  if (String(form.description ?? '').length > MAX_RECIPE_DESCRIPTION) errors.description = 'rcErr_description';
  if (String(form.instructions ?? '').length > MAX_RECIPE_INSTRUCTIONS) errors.instructions = 'rcErr_instructions';
  if (!Number.isInteger(servings) || servings < 1 || servings > MAX_SERVINGS) errors.servings = 'rcErr_servings';
  if (!prep.ok || !cook.ok) errors.time = 'rcErr_time';
  if (form.items.length === 0) errors.items = 'rcErr_noIngredients';
  else if (form.items.length > MAX_RECIPE_INGREDIENTS) errors.items = 'rcErr_tooMany';
  else if (form.items.some((item) => !(Number(item.grams) >= 1) || Number(item.grams) > MAX_PORTION_GRAMS)) errors.items = 'rcErr_grams';
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: {
      title,
      description: String(form.description ?? '').trim(),
      instructions: String(form.instructions ?? '').trim(),
      servings: Number.isInteger(servings) ? servings : 1,
      prepMinutes: prep.value,
      cookMinutes: cook.value,
      items: form.items.map((item) => ({
        food_name: item.food_name,
        food_ref: item.food_ref || null,
        grams: round1(item.grams),
        calories: round1(item.calories),
        protein_g: round1(item.protein_g),
        carbs_g: round1(item.carbs_g),
        fat_g: round1(item.fat_g),
        notes: String(item.notes || '').trim(),
      })),
    },
  };
}

// The method as separate steps: one per non-empty line, with a leading "1." or "1)" removed.
export function splitSteps(instructions) {
  return String(instructions ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+\s*[.)\-:]|[-*•])\s*/, '').trim())
    .filter(Boolean);
}

export const totalMinutes = (recipe) => (Number(recipe?.prep_minutes) || 0) + (Number(recipe?.cook_minutes) || 0);

// A portion of a saved recipe (the result of get_recipe / list_my_recipes) as a food of a meal plan: the title as the food
// name, the grams and numbers of `portions` servings, and a link back to the recipe so the client can open the method.
export function recipeToPlanFood(recipe, portions = 1) {
  const count = Number(portions);
  const amount = Number.isFinite(count) && count > 0 ? count : 1;
  const serving = recipe.per_serving || {};
  const grams = Math.min(MAX_PORTION_GRAMS, Math.max(1, round1(Number(serving.grams || 0) * amount)));
  return {
    ...hydrateFood({
      food_name: recipe.title,
      food_ref: null,
      grams,
      calories: Math.min(10000, round1(Number(serving.calories || 0) * amount)),
      protein_g: round1(Number(serving.protein_g || 0) * amount),
      carbs_g: round1(Number(serving.carbs_g || 0) * amount),
      fat_g: round1(Number(serving.fat_g || 0) * amount),
    }),
    recipe_id: recipe.id,
  };
}

export function filterRecipes(recipes, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return recipes;
  return recipes.filter((recipe) => String(recipe.title || '').toLowerCase().includes(needle));
}
