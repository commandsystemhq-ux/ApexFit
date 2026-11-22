import { requireSupabase } from './supabaseClient.js';
import { DASHBOARD_DAYS } from './dashboardUtils.js';

// Everything on the coach's dashboard in one call; the database answers only for the signed-in active coach and only
// about that coach's own clients and records.
export async function getCoachDashboard(days = DASHBOARD_DAYS) {
  const { data, error } = await requireSupabase().rpc('get_coach_dashboard', { p_days: days });
  if (error) throw error;
  return data;
}
