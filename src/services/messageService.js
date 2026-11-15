import { requireSupabase } from './supabaseClient.js';
import { getCurrentUserId } from './clientIdentity.js';
import { VIDEO_TYPES, normalizeMessageDraft } from './coachingUtils.js';
import { notifyClients } from './pushService.js';

const VIDEO_BUCKET = 'apexfit-coach-videos';
const MESSAGE_FIELDS = 'id,batch_id,client_id,kind,body,video_path,created_at,read_at';

export async function sendCoachMessage({ clientIds, sendToAll, body, videoFile }) {
  const draft = normalizeMessageDraft({ body, videoFile, sendToAll, clientIds });
  const client = requireSupabase();
  let videoPath = null;

  if (videoFile) {
    videoPath = `${await getCurrentUserId(client)}/${crypto.randomUUID()}.${VIDEO_TYPES[videoFile.type]}`;
    const { error: uploadError } = await client.storage.from(VIDEO_BUCKET).upload(videoPath, videoFile, {
      contentType: videoFile.type,
      cacheControl: '3600',
      upsert: false,
    });
    if (uploadError) throw uploadError;
  }

  const { data, error } = await client.rpc('send_coach_message', {
    p_client_ids: draft.clientIds,
    p_send_to_all: draft.sendToAll,
    p_body: draft.body,
    p_video_path: videoPath,
  });
  if (error) {
    if (videoPath) await client.storage.from(VIDEO_BUCKET).remove([videoPath]);
    throw error;
  }

  notifyClients('message', data.batch_id);
  return data;
}

export async function listSentMessages(limit = 300) {
  const { data, error } = await requireSupabase()
    .from('coach_messages')
    .select(MESSAGE_FIELDS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function listInboxMessages(limit = 50) {
  return listSentMessages(limit);
}

export async function getMessageVideoUrl(videoPath) {
  const { data, error } = await requireSupabase().storage.from(VIDEO_BUCKET).createSignedUrl(videoPath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export async function markMessagesRead(ids) {
  if (ids.length === 0) return;
  const { error } = await requireSupabase()
    .from('coach_messages')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)
    .is('read_at', null);
  if (error) throw error;
}
