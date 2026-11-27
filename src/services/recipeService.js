import { requireSupabase } from './supabaseClient.js';

async function call(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// The coach's recipes with their totals and one-serving numbers (no ingredients), newest first.
export const listMyRecipes = async () => (await call('list_my_recipes')) || [];

// One recipe in full: for the coach who owns it, or for a client whose meal plan contains it.
export const getRecipe = (recipeId) => call('get_recipe', { p_recipe_id: recipeId });
export const deleteRecipe = (recipeId) => call('delete_recipe', { p_recipe_id: recipeId });

export const saveRecipe = ({ id = null, title, description, instructions, servings, prepMinutes, cookMinutes, items }) => call('save_recipe', {
  p_recipe_id: id, p_title: title, p_description: description, p_instructions: instructions, p_servings: servings,
  p_prep_minutes: prepMinutes, p_cook_minutes: cookMinutes, p_items: items,
});
