import { requireSupabase } from './supabaseClient.js';
import { CHAT_IMAGE_BUCKET, CHAT_IMAGE_URL_SECONDS, baseImageMime, buildImagePath, validateChatImage } from './chatImageUtils.js';

export class ChatImageError extends Error {
  constructor(key, message) {
    super(message || key);
    this.key = key;
  }
}

// Uploads the photo to the private bucket, then saves the chat message. If saving fails the file is removed again so
// no orphan stays behind. `clientRef` makes a retry safe: the same reference stores the message once.
export async function sendImageMessage({ senderId, receiverId, file, caption = '', clientRef }) {
  const problem = validateChatImage({ size: file?.size, type: file?.type });
  if (problem) throw new ChatImageError(problem);

  const client = requireSupabase();
  const type = baseImageMime(file.type);
  const path = buildImagePath(senderId, clientRef, type);
  const { error: uploadError } = await client.storage.from(CHAT_IMAGE_BUCKET).upload(path, file, { contentType: type });
  // A retry finds the file from the first attempt already there, which is fine.
  if (uploadError && !/already exists|duplicate/i.test(uploadError.message || '')) throw new ChatImageError('chatImgErrUpload', uploadError.message);

  const { data, error } = await client.rpc('send_chat_image_message', {
    p_receiver_id: receiverId,
    p_image_path: path,
    p_mime: type,
    p_caption: caption,
    p_client_ref: clientRef,
  });
  if (error) {
    // The database answered with a refusal (it has a code): remove the file. With no answer at all (network) the
    // message may exist, so the file stays for the retry.
    if (error.code) await client.storage.from(CHAT_IMAGE_BUCKET).remove([path]).catch(() => null);
    throw error;
  }
  return data;
}

// A short-lived link to show one photo. Asked for when the photo is about to be shown, never stored.
export async function getChatImageUrl(imagePath) {
  const { data, error } = await requireSupabase().storage.from(CHAT_IMAGE_BUCKET).createSignedUrl(imagePath, CHAT_IMAGE_URL_SECONDS);
  if (error) throw error;
  return data.signedUrl;
}
