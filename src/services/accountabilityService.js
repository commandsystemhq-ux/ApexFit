import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// Tasks and completion rates
export const getMyTasks = () => rpc('get_my_tasks');
export const getClientTasks = (clientId) => rpc('get_client_tasks', { p_client_id: clientId });
export const getTaskCompletionRates = (days = 30) => rpc('get_task_completion_rates', { p_days: days });

export const assignClientTask = (clientId, { kind, title, description, dueDate, xp }) => rpc('assign_client_task', {
  p_client_id: clientId, p_kind: kind, p_title: title, p_description: description || '', p_due_date: dueDate || null, p_xp: xp, p_source: 'coach',
});
export const addMyTask = ({ kind, title, description, dueDate }) => rpc('add_my_task', {
  p_kind: kind, p_title: title, p_description: description || '', p_due_date: dueDate || null,
});
export const completeMyTask = (taskId, done = true) => rpc('complete_my_task', { p_task_id: taskId, p_done: done });
export const deleteMyTask = (taskId) => rpc('delete_my_task', { p_task_id: taskId });
export const deleteClientTask = (taskId) => rpc('delete_client_task', { p_task_id: taskId });

// Progress reports
export const getProgressStats = (clientId, days = 30) => rpc('get_progress_stats', { p_client_id: clientId, p_days: days });
export const saveProgressReport = (clientId, days, body) => rpc('save_progress_report', { p_client_id: clientId, p_days: days, p_body: body });
export const listProgressReports = (clientId = null) => rpc('list_progress_reports', { p_client_id: clientId });
export const shareProgressReport = (reportId, shared) => rpc('share_progress_report', { p_report_id: reportId, p_shared: shared });
export const deleteProgressReport = (reportId) => rpc('delete_progress_report', { p_report_id: reportId });