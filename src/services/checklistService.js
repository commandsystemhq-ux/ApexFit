import { callApi } from './apiClient.js';
import { browserTimeZone } from './checklistUtils.js';
import { getLocalDateString } from './clientTrackingUtils.js';
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
  p_calendar_sync: task.calendarSync,
});

// Check / uncheck, or add an amount (for example 250 ml of water).
export const setChecklistItem = (id, { done = null, progress = null, add = null } = {}) =>
  rpc('set_checklist_item', { p_entry_id: id, p_done: done, p_progress: progress, p_add: add });

export const updateChecklistCalendar = (id, remindTime, sync) =>
  rpc('update_checklist_calendar', { p_entry_id: id, p_remind_time: remindTime, p_sync: sync });

export const deleteChecklistTask = (id) => rpc('delete_checklist_task', { p_entry_id: id });

// ------------------------------------------------------------- Google Calendar

export const getCalendarConnection = () => rpc('get_my_calendar_connection');
export const startCalendarConnect = () => callApi('google', { body: { action: 'auth-url', returnTo: 'checklist' } });
export const disconnectCalendar = () => callApi('google', { body: { action: 'disconnect' } });

// Puts the tasks marked "add to my calendar" into the calendar (all of them, or only the given ones).
export const syncChecklistToCalendar = ({ templateIds, entryIds } = {}) => callApi('google', {
  body: { action: 'sync-checklist', timeZone: browserTimeZone(), today: getLocalDateString(), templateIds, entryIds },
});

export const removeCalendarEvent = (taskId) => callApi('google', { body: { action: 'remove-event', taskId } });
