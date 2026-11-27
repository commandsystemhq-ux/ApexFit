import { requireSupabase } from './supabaseClient.js';
import { NOTIFICATION_PAGE_SIZE } from './notificationUtils.js';

async function rpc(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// { items, unread_count }. Asking also turns this person's due reminders into notifications.
export async function getNotifications({ limit = NOTIFICATION_PAGE_SIZE, before = null } = {}) {
  const data = await rpc('get_my_notifications', { p_limit: limit, p_before: before });
  return { items: data?.items || [], unread: Number(data?.unread_count) || 0 };
}

export const getUnreadNotificationCount = async () => Number(await rpc('get_my_unread_notification_count')) || 0;
export const markNotificationRead = (id) => rpc('mark_notification_read', { p_id: id });
export const markAllNotificationsRead = () => rpc('mark_all_notifications_read');

// Live updates through Supabase Realtime. Row-level security decides which rows reach this person.
// onChange() is called whenever a notification of mine is added or changed; returns a function that stops listening.
let channelCounter = 0;
export function subscribeToNotifications(userId, onChange) {
  const client = requireSupabase();
  channelCounter += 1;
  const channel = client
    .channel(`notifications-${userId}-${channelCounter}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe();
  return () => {
    client.removeChannel(channel);
  };
}

export const NOTIFICATIONS_CHANGED_EVENT = 'apexfit:notifications-changed';

// Tells the bell that notifications may have changed (for example the chat marked a conversation as read).
export function announceNotificationsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}
