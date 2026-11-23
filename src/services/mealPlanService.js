import { requireSupabase } from './supabaseClient.js';

async function call(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// The coach's plans (templates and the ones given to clients), newest first. Row-level security keeps it to their own.
export async function listMealPlans() {
  const { data, error } = await requireSupabase()
    .from('meal_plans')
    .select('id,title,is_template,client_id,updated_at')
    .order('updated_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return data || [];
}

export const getMealPlan = (planId) => call('get_meal_plan', { p_plan_id: planId });
export const getMyMealPlan = () => call('get_my_meal_plan');
export const assignMealPlan = (planId, clientId) => call('assign_meal_plan', { p_plan_id: planId, p_client_id: clientId });
export const deleteMealPlan = (planId) => call('delete_meal_plan', { p_plan_id: planId });

export const saveMealPlan = ({ id = null, title, notes, isTemplate, clientId = null, items }) => call('save_meal_plan', {
  p_plan_id: id, p_title: title, p_notes: notes, p_is_template: isTemplate, p_client_id: isTemplate ? null : clientId, p_items: items,
});

export const logMealPlanItems = (planId, date, choices) => call('log_meal_plan_items', { p_plan_id: planId, p_date: date, p_choices: choices });