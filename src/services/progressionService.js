import { requireSupabase } from './supabaseClient.js';

async function call(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// Looks at the real workouts again and writes any new suggestions; nothing about the plan changes.
export const refreshSuggestions = (clientId = null) => call('refresh_progression_suggestions', { p_client_id: clientId });
export const listSuggestions = ({ clientId = null, status = 'pending' } = {}) => call('list_progression_suggestions', { p_client_id: clientId, p_status: status });
export const decideSuggestion = (suggestionId, apply) => call('decide_progression_suggestion', { p_suggestion_id: suggestionId, p_apply: apply });

// The targets the coach applied for the signed-in client.
export async function listMyExerciseTargets() {
  const { data, error } = await requireSupabase().from('client_exercise_targets').select('exercise_id,target_weight_kg,target_reps');
  if (error) throw error;
  return data || [];
}