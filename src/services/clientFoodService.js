import { requireSupabase } from './supabaseClient.js';
import { getCurrentUserId } from './clientIdentity.js';
import { normalizeFoodEntry } from './clientPriority2Utils.js';

export async function listFoodLogs(startDate, endDate) {
  const { data, error } = await requireSupabase()
    .from('client_food_logs')
    .select('id,logged_on,meal_type,food_name,ingredients,calories,protein_g,carbs_g,fat_g,created_at')
    .gte('logged_on', startDate)
    .lte('logged_on', endDate)
    .order('logged_on', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw error;
  return data || [];
}

export async function addFoodLog({ loggedOn, ...entry }) {
  const client = requireSupabase();
  const normalized = normalizeFoodEntry(entry);
  const { error } = await client
    .from('client_food_logs')
    .insert({ client_id: await getCurrentUserId(client), logged_on: loggedOn, ...normalized });
  if (error) throw error;
}

// Changes one saved entry. The same validation as a new entry runs first; the date and the owner stay as they were.
export async function updateFoodLog(id, entry) {
  const normalized = normalizeFoodEntry(entry);
  const { data, error } = await requireSupabase()
    .from('client_food_logs')
    .update(normalized)
    .eq('id', id)
    .select('id');
  if (error) throw error;
  if (!data?.length) throw new Error('This entry could not be found.');
}

export async function deleteFoodLog(id) {
  const { error } = await requireSupabase().from('client_food_logs').delete().eq('id', id);
  if (error) throw error;
}
