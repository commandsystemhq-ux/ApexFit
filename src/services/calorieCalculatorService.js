import { setClientNutritionTargets } from './healthService.js';
import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// What is already known about the client: latest weight and body fat, height, remembered sex / birth date /
// activity / goal / formula and the current daily goal.
export const getCalculatorData = (clientId) => rpc('get_client_calculator_data', { p_client_id: clientId });

export const saveCalculatorProfile = (clientId, { sex, birthDate, heightCm, activity, goal, formula }) => rpc('save_client_calculator_profile', {
  p_client_id: clientId,
  p_sex: sex || null,
  p_birth_date: birthDate || null,
  p_height_cm: heightCm ?? null,
  p_activity_level: activity || null,
  p_goal: goal || null,
  p_formula: formula || null,
});

// Writes the result as the client's daily goal (nutrition_targets) through set_client_nutrition_targets.
export const applyToClientGoal = (clientId, payload) => setClientNutritionTargets(clientId, payload);
