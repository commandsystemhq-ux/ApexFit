import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const listJackConversations = (limit = 50) => rpc('list_jack_conversations', { p_limit: limit });
export const getJackConversation = (id) => rpc('get_jack_conversation', { p_conversation_id: id });
export const deleteJackConversation = (id) => rpc('delete_jack_conversation', { p_conversation_id: id });

// Appends messages ({ role, content, has_image }) to a conversation and returns its id (a new one when id is null).
export const saveJackMessages = (conversationId, title, messages) => rpc('save_jack_messages', {
  p_conversation_id: conversationId, p_title: title, p_messages: messages,
});