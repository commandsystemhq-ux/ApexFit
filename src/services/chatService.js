import { requireSupabase } from './supabaseClient.js';
import { subscribeToChat } from './chatRealtime.js';
import { CHAT_PAGE_SIZE } from './chatUtils.js';

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const listConversations = () => rpc('get_chat_conversations', {});

export async function getChatMessages(partnerId, { before = null, limit = CHAT_PAGE_SIZE } = {}) {
  const data = await rpc('get_chat_messages', { p_partner_id: partnerId, p_before: before, p_limit: limit });
  return { messages: data?.messages || [], hasMore: Boolean(data?.has_more) };
}

// `clientRef` makes a retry safe: sending the same reference twice stores the message once.
export const sendChatMessage = (receiverId, text, clientRef) =>
  rpc('send_chat_message', { p_receiver_id: receiverId, p_text: text, p_client_ref: clientRef });

export const markChatRead = (partnerId) => rpc('mark_chat_read', { p_partner_id: partnerId });
export const getUnreadChatCount = () => rpc('get_chat_unread_count', {});

export const CHAT_CHANGED_EVENT = 'apexfit:chat-changed';

// Tells other parts of the page (the sidebar badge) that unread counts may have changed.
export function announceChatChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHAT_CHANGED_EVENT));
}

export const subscribeToMyChat = (userId, handlers) => subscribeToChat(requireSupabase(), userId, handlers);
