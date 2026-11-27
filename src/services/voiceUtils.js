// Pure helpers for voice messages: format choice, limits, file names and error mapping.
// Nothing here needs a microphone or the network, so it is easy to test.

export const VOICE_MAX_SECONDS = 120;
export const VOICE_MIN_SECONDS = 1;
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_BUCKET = 'apexfit-chat-audio';
export const VOICE_URL_SECONDS = 300;

// Chrome, Edge and Firefox record webm or ogg; Safari on iPhone and Mac records mp4. Best choice first.
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
const EXTENSIONS = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg' };

export function baseMime(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

export function extensionForMime(mime) {
  return EXTENSIONS[baseMime(mime)] || null;
}

export function isSupportedVoiceMime(mime) {
  return Boolean(extensionForMime(mime));
}

// `isTypeSupported` is MediaRecorder.isTypeSupported. Returns '' when the browser can use its own default.
export function pickRecorderMime(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return '';
  return PREFERRED_TYPES.find((type) => isTypeSupported(type)) || '';
}

export function formatVoiceDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Returns an i18n key for the problem, or null when the recording can be sent.
export function validateRecording({ bytes, seconds, mime }) {
  if (!isSupportedVoiceMime(mime)) return 'voiceErrFormat';
  if (!bytes || seconds < VOICE_MIN_SECONDS) return 'voiceErrTooShort';
  if (seconds > VOICE_MAX_SECONDS) return 'voiceErrTooLong';
  if (bytes > VOICE_MAX_BYTES) return 'voiceErrTooBig';
  return null;
}

// The folder is the sender's id, which is what the storage policy checks.
export function buildAudioPath(userId, fileId, mime) {
  const extension = extensionForMime(mime);
  if (!userId || !fileId || !extension) throw new TypeError('A user, a file id and a supported audio format are required.');
  return `${userId}/${fileId}.${extension}`;
}

// getUserMedia / MediaRecorder failures, as an i18n key.
export function microphoneErrorKey(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'voiceErrDenied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'voiceErrNoMic';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'voiceErrBusy';
    default:
      return 'voiceErrUnsupported';
  }
}

export function canRecordVoice(env = globalThis) {
  return Boolean(env.navigator?.mediaDevices?.getUserMedia && env.MediaRecorder);
}

export function describeLastMessage(item) {
  if (item.last_type === 'voice') return { voice: true, image: false, text: '' };
  if (item.last_type === 'image') return { voice: false, image: true, text: item.last_text || '' };
  return { voice: false, image: false, text: item.last_text || '' };
}
