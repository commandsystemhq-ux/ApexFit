import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NOTIFICATIONS_CHANGED_EVENT, getNotifications, markAllNotificationsRead, markNotificationRead, subscribeToNotifications,
} from '../services/notificationService.js';
import { markAllReadLocally, markReadLocally, mergeNotifications } from '../services/notificationUtils.js';
import { CHAT_CHANGED_EVENT } from '../services/chatService.js';
import { supabase } from '../services/supabaseClient.js';

const POLL_MS = 45_000;

// The bell's data: the latest notifications and the unread count, kept current through Realtime, a timer, the window
// regaining focus, and the chat telling us it marked messages as read.
export function useNotifications(userId, enabled) {
  const [state, setState] = useState({ items: [], unread: 0, status: 'idle', error: '' });
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || !userId || busy.current) return;
    busy.current = true;
    try {
      const { items, unread } = await getNotifications();
      setState({ items, unread, status: 'ready', error: '' });
    } catch (error) {
      setState((current) => ({ ...current, status: current.status === 'ready' ? 'ready' : 'error', error: error.message }));
    } finally {
      busy.current = false;
    }
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled || !userId || !supabase) {
      setState({ items: [], unread: 0, status: 'idle', error: '' });
      return undefined;
    }
    refresh();
    const stop = subscribeToNotifications(userId, refresh);
    const timer = window.setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    window.addEventListener(CHAT_CHANGED_EVENT, refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      window.clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
      window.removeEventListener(CHAT_CHANGED_EVENT, refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, userId, refresh]);

  const markRead = useCallback(async (id) => {
    setState((current) => {
      const wasUnread = current.items.some((item) => item.id === id && !item.read_at);
      return { ...current, items: markReadLocally(current.items, id), unread: Math.max(0, current.unread - (wasUnread ? 1 : 0)) };
    });
    try {
      await markNotificationRead(id);
    } catch {
      refresh();
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    setState((current) => ({ ...current, items: markAllReadLocally(current.items), unread: 0 }));
    try {
      await markAllNotificationsRead();
    } catch {
      refresh();
    }
  }, [refresh]);

  const loadMore = useCallback(async () => {
    const oldest = state.items[state.items.length - 1];
    if (!oldest) return false;
    const { items } = await getNotifications({ before: oldest.created_at });
    setState((current) => ({ ...current, items: mergeNotifications(current.items, items) }));
    return items.length > 0;
  }, [state.items]);

  return { ...state, refresh, markRead, markAllRead, loadMore };
}
