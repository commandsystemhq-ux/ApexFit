// Pure helpers for photos in the chat: allowed types, size limit, storage path and the file name rules the database
// checks again. Nothing here needs the network or a browser.

export const CHAT_IMAGE_BUCKET = 'apexfit-chat-images';
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGE_URL_SECONDS = 300;
export const CHAT_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function baseImageMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

export function extensionForImageMime(mime) {
  return EXTENSIONS[baseImageMime(mime)] || null;
}

export function isSupportedImageMime(mime) {
  return Boolean(extensionForImageMime(mime));
}

// Returns an i18n key for the problem, or null when the file can be sent.
export function validateChatImage({ size, type }) {
  if (!isSupportedImageMime(type)) return 'chatImgErrType';
  if (!size) return 'chatImgErrEmpty';
  if (size > CHAT_IMAGE_MAX_BYTES) return 'chatImgErrTooBig';
  return null;
}

// The folder is the sender's id, which is what the storage policy checks.
export function buildImagePath(userId, fileId, mime) {
  const extension = extensionForImageMime(mime);
  if (!userId || !fileId || !extension) throw new TypeError('A user, a file id and a supported image type are required.');
  return `${userId}/${fileId}.${extension}`;
}

export function isImageMessage(message) {
  return message?.message_type === 'image' && Boolean(message.image_path || message.localUrl);
}

export function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
