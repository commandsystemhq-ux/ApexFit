import { requireSupabase } from './supabaseClient.js';

// The daily goal of one person: the signed-in client's own, or (for a coach) one of their clients'. Row-level security
// decides who may read it; there is at most one row per client.
export async function getNutritionTarget(clientId) {
  const { data, error } = await requireSupabase()
    .from('nutrition_targets')
    .select('calories,protein_g,carbs_g,fats_g,set_by,updated_at')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// A coach's read-only view of a client's food log (the database refuses any change by a coach).
export async function listClientFoodLogs(clientId, startDate, endDate) {
  const { data, error } = await requireSupabase()
    .from('client_food_logs')
    .select('id,logged_on,meal_type,food_name,ingredients,calories,protein_g,carbs_g,fat_g,created_at')
    .eq('client_id', clientId)
    .gte('logged_on', startDate)
    .lte('logged_on', endDate)
    .order('logged_on', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return data || [];
}
