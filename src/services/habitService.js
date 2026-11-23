import { requireSupabase } from './supabaseClient.js';

const HABIT_FIELDS = 'id,client_id,builtin_key,name,kind,unit,daily_goal,quick_add,color,sort_order,status';

async function call(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// Gives the signed-in client sleep, water and steps the first time; later calls change nothing.
export const ensureDefaultHabits = () => call('ensure_my_default_habits');

// A client reads their own habits; a coach reads those of their active clients (pass the client's id).
export async function listHabits(clientId = null) {
  let query = requireSupabase().from('client_custom_habits').select(HABIT_FIELDS);
  if (clientId) query = query.eq('client_id', clientId);
  const { data, error } = await query.order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function listHabitValues(startDate, endDate, clientId = null) {
  const client = requireSupabase();
  let daily = client.from('client_habit_logs').select('id,habit_date,sleep_hours,water_liters,steps').gte('habit_date', startDate).lte('habit_date', endDate);
  let custom = client.from('client_custom_habit_logs').select('id,habit_id,log_date,value').gte('log_date', startDate).lte('log_date', endDate);
  if (clientId) {
    daily = daily.eq('client_id', clientId);
    custom = custom.eq('client_id', clientId);
  }
  const [dailyResult, customResult] = await Promise.all([daily.order('habit_date', { ascending: false }), custom.order('log_date', { ascending: false })]);
  if (dailyResult.error) throw dailyResult.error;
  if (customResult.error) throw customResult.error;
  return { dailyLogs: dailyResult.data || [], customLogs: customResult.data || [] };
}

export const saveHabit = ({ id = null, name, kind, unit, dailyGoal, quickAdd, color }) => call('save_my_habit', {
  p_habit_id: id, p_name: name, p_kind: kind, p_unit: unit, p_daily_goal: dailyGoal, p_quick_add: quickAdd, p_color: color,
});

export const setHabitStatus = (habitId, status) => call('set_my_habit_status', { p_habit_id: habitId, p_status: status });
export const deleteHabit = (habitId) => call('delete_my_habit', { p_habit_id: habitId });

// value: a number for numeric habits, 1 or 0 for yes/no habits, null to clear the day.
export const logHabit = (habitId, date, value) => call('log_my_habit', { p_habit_id: habitId, p_date: date, p_value: value });
