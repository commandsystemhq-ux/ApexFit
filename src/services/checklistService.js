import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const getChecklist = (date) => rpc('get_my_checklist', { p_date: date });
export const getChecklistSummary = (to, days = 7) => rpc('get_checklist_summary', { p_to: to, p_days: days });

export const addChecklistTask = (date, task) => rpc('add_checklist_task', {
  p_date: date,
  p_category: task.category,
  p_title: task.title,
  p_target: task.target,
  p_unit: task.unit,
  p_remind_time: task.remindTime,
  p_repeat_days: task.repeatDays,
});

// Check / uncheck, or add an amount (for example 250 ml of water).
export const setChecklistItem = (id, { done = null, progress = null, add = null } = {}) =>
  rpc('set_checklist_item', { p_entry_id: id, p_done: done, p_progress: progress, p_add: add });

// Sets or clears the time of a task (a repeating task keeps it from this day on).
export const updateChecklistTime = (id, time) => rpc('update_checklist_time', { p_entry_id: id, p_remind_time: time });

export const deleteChecklistTask = (id) => rpc('delete_checklist_task', { p_entry_id: id });
