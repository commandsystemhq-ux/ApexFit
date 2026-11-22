// Voice message rules, the same as the web app and the database enforce.

export const VOICE_MAX_SECONDS = 120;
export const VOICE_MIN_SECONDS = 1;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_BUCKET = 'apexfit-chat-audio';
export const VOICE_URL_SECONDS = 300;
// expo-audio's HIGH_QUALITY preset records AAC in an MPEG-4 container on iPhone and Android.
export const VOICE_MIME = 'audio/mp4';

export function formatVoiceDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Returns a translation key for the problem, or null when the recording can be sent.
export function validateRecording({ bytes, seconds }) {
  if (!bytes || seconds < VOICE_MIN_SECONDS) return 'voiceErrTooShort';
  if (seconds > VOICE_MAX_SECONDS) return 'voiceErrTooLong';
  if (bytes > VOICE_MAX_BYTES) return 'voiceErrTooBig';
  return null;
}

// The folder is the sender's id, which is what the storage policy checks.
export function buildAudioPath(userId, fileId) {
  if (!userId || !fileId) throw new TypeError('A user and a file id are required.');
  return `${userId}/${fileId}.mp4`;
}

export function uuid() {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}