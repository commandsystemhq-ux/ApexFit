import { requireSupabase } from './supabaseClient.js';
import { groupOneRepMaxHistory } from './clientPriority2Utils.js';

export async function getOneRepMaxHistory() {
  const { data, error } = await requireSupabase().rpc('get_my_one_rep_max_history');
  if (error) throw error;
  return groupOneRepMaxHistory(data || []);
}
