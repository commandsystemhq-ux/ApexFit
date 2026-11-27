import { requireSupabase } from './supabaseClient.js';

async function call(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// The reminders I created and the ones created for me (row-level security decides), newest first.
export async function listReminders() {
  const { data, error } = await requireSupabase()
    .from('custom_reminders')
    .select('id,owner_id,target_id,kind,title,message,time_of_day,days_of_week,timezone,is_active,created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

export const saveReminder = ({ id = null, kind, title, message, time, days, timezone, active = true, target = null }) => call('save_reminder', {
  p_id: id, p_kind: kind, p_title: title, p_message: message, p_time: time, p_days: days, p_timezone: timezone, p_active: active, p_target: target,
});

export const deleteReminder = (id) => call('delete_reminder', { p_id: id });
