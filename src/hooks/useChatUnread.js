import { useCallback, useEffect, useState } from 'react';
import { CHAT_CHANGED_EVENT, getUnreadChatCount, subscribeToMyChat } from '../services/chatService.js';
import { supabase } from '../services/supabaseClient.js';

// The number of unread chat messages, kept current through Realtime and refreshed when the chat marks messages as read.
export function useChatUnread(userId, enabled) {
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    if (!enabled || !userId) return;
    getUnreadChatCount().then((value) => setCount(Number(value) || 0)).catch(() => {});
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled || !userId || !supabase) {
      setCount(0);
      return undefined;
    }
    refresh();
    const stop = subscribeToMyChat(userId, { onMessage: refresh });
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener(CHAT_CHANGED_EVENT, refresh);
    return () => {
      stop();
      window.clearInterval(timer);
      window.removeEventListener(CHAT_CHANGED_EVENT, refresh);
    };
  }, [enabled, userId, refresh]);

  return count;
}
