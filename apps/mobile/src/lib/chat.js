import { requireSupabase } from './supabase.js';
import { API_URL } from './config.js';
import { VOICE_BUCKET, VOICE_MIME, VOICE_URL_SECONDS, buildAudioPath, validateRecording } from './voice.js';

async function rpc(name, args = {}) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const listConversations = () => rpc('get_chat_conversations');

export async function getMessages(partnerId, before = null) {
  const data = await rpc('get_chat_messages', { p_partner_id: partnerId, p_before: before, p_limit: 50 });
  return { messages: data?.messages || [], hasMore: Boolean(data?.has_more) };
}

export const sendText = (receiverId, text, clientRef) => rpc('send_chat_message', { p_receiver_id: receiverId, p_text: text, p_client_ref: clientRef });
export const markRead = (partnerId) => rpc('mark_chat_read', { p_partner_id: partnerId });

export class VoiceError extends Error {
  constructor(key, message) {
    super(message || key);
    this.key = key;
  }
}

// Uploads a recording from the phone's cache to the private bucket, then saves the message. The server checks that the
// two people are linked and that the file is the sender's own.
export async function sendVoice({ senderId, receiverId, uri, seconds, clientRef }) {
  const client = requireSupabase();
  const body = await (await fetch(uri)).arrayBuffer();
  const problem = validateRecording({ bytes: body.byteLength, seconds });
  if (problem) throw new VoiceError(problem);

  const path = buildAudioPath(senderId, clientRef);
  const { error: uploadError } = await client.storage.from(VOICE_BUCKET).upload(path, body, { contentType: VOICE_MIME });
  if (uploadError && !/already exists|duplicate/i.test(uploadError.message || '')) throw new VoiceError('voiceErrUpload', uploadError.message);

  const { data, error } = await client.rpc('send_chat_voice_message', {
    p_receiver_id: receiverId, p_audio_path: path, p_duration: Math.round(seconds), p_mime: VOICE_MIME, p_client_ref: clientRef,
  });
  if (error) {
    if (error.code) await client.storage.from(VOICE_BUCKET).remove([path]).catch(() => null);
    throw error;
  }
  return data;
}

export async function getVoiceUrl(audioPath) {
  const { data, error } = await requireSupabase().storage.from(VOICE_BUCKET).createSignedUrl(audioPath, VOICE_URL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}

// Tells the other person a message arrived (web push). Best effort: it never blocks or fails the send.
export async function notifyReceiver(messageId) {
  try {
    if (!API_URL) return;
    const { data } = await requireSupabase().auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    await fetch(`${API_URL}/api/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify', type: 'chat', id: messageId }),
    });
  } catch {
    // Notifications are optional.
  }
}

let channelCounter = 0;

// Live updates for new messages. Row-level security decides which rows reach this person.
export function subscribeToChat(userId, onMessage, onStatus) {
  const client = requireSupabase();
  channelCounter += 1;
  const table = { schema: 'public', table: 'chat_messages' };
  const channel = client
    .channel(`mobile-chat-${userId}-${channelCounter}`)
    .on('postgres_changes', { event: 'INSERT', ...table, filter: `receiver_id=eq.${userId}` }, (payload) => onMessage(payload.new))
    .on('postgres_changes', { event: 'INSERT', ...table, filter: `sender_id=eq.${userId}` }, (payload) => onMessage(payload.new))
    .subscribe((status) => onStatus?.(status === 'SUBSCRIBED'));
  return () => { client.removeChannel(channel); };
}
