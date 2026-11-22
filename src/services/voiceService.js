import { requireSupabase } from './supabaseClient.js';
import { VOICE_BUCKET, VOICE_URL_SECONDS, baseMime, buildAudioPath, validateRecording } from './voiceUtils.js';

export class VoiceMessageError extends Error {
  constructor(key, message) {
    super(message || key);
    this.key = key;
  }
}

// Uploads the recording to the private bucket, then saves the chat message. If saving fails the file is removed
// again so no orphan stays behind. `clientRef` makes a retry safe: the same reference stores the message once.
export async function sendVoiceMessage({ senderId, receiverId, blob, seconds, mime, clientRef }) {
  const problem = validateRecording({ bytes: blob?.size, seconds, mime });
  if (problem) throw new VoiceMessageError(problem);

  const client = requireSupabase();
  const type = baseMime(mime);
  const path = buildAudioPath(senderId, clientRef, type);
  const { error: uploadError } = await client.storage.from(VOICE_BUCKET).upload(path, blob,   { contentType: type });
    // A retry finds the file from the first attempt already there, which is fine.
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message || '')) throw new VoiceMessageError('voiceErrUpload', uploadError.message);

  const { data, error } = await client.rpc('send_chat_voice_message', {
    p_receiver_id: receiverId,
    p_audio_path: path,
    p_duration: Math.round(seconds),
    p_mime: type,
    p_client_ref: clientRef,
  });
  if (error) {
    // The database answered with a refusal (it has a code): remove the file. With no answer at all (network) the
    // message may exist, so the file stays for the retry.
    if (error.code) await client.storage.from(VOICE_BUCKET).remove([path]).catch(() => null);
    throw error;
  }
  return data;
}

// A short-lived link to play one recording. Asked for when the person presses play, never stored.
export async function getVoiceUrl(audioPath) {
  const { data, error } = await requireSupabase().storage.from(VOICE_BUCKET).createSignedUrl(audioPath, VOICE_URL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}
