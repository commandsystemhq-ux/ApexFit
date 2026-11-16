// The built-in "ApexFit Live" room: an embedded Jitsi Meet call (WebRTC, no API key). Every session gets its
// own room named after its random id, and only people who can read the session in ApexFit are shown the room.

export const DEFAULT_JITSI_DOMAIN = 'meet.jit.si';
export const ROOM_IFRAME_ALLOW = 'camera; microphone; fullscreen; display-capture; autoplay; clipboard-write';
export const JOIN_GRACE_MINUTES = 60;
export const JOIN_OPENS_MINUTES = 10;

const ROOM_NAME = /^apexfit-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const LIVE_PROVIDER = 'apexfit_live';

export function roomNameFor(sessionId) {
  return `apexfit-session-${String(sessionId).toLowerCase()}`;
}

export function isValidRoomName(name) {
  return typeof name === 'string' && ROOM_NAME.test(name);
}

export function roomPath(sessionId) {
  return `/sessions/${sessionId}/room`;
}

// A self-hosted Jitsi can be used by setting VITE_JITSI_DOMAIN; anything that is not a plain host name is ignored.
export function resolveJitsiDomain(value) {
  const host = String(value ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  return DOMAIN.test(host) ? host : DEFAULT_JITSI_DOMAIN;
}

// Names are shown to everyone in the room, so keep them short and free of control characters.
export function sanitizeDisplayName(name, fallback = 'ApexFit') {
  // eslint-disable-next-line no-control-regex
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || fallback;
}

// The embed address. The name, title and options travel in the URL fragment (never sent to the server).
export function buildRoomUrl({ domain = DEFAULT_JITSI_DOMAIN, roomName, displayName, subject }) {
  if (!isValidRoomName(roomName)) return null;
  const host = resolveJitsiDomain(domain);
  const options = [
    ['userInfo.displayName', sanitizeDisplayName(displayName)],
    ['config.subject', sanitizeDisplayName(subject, 'ApexFit').slice(0, 120)],
    // On phones this keeps the call in the browser instead of pushing the Jitsi app download.
    ['config.disableDeepLinking', true],
    ['config.startWithAudioMuted', false],
    ['config.startWithVideoMuted', false],
    ['interfaceConfig.MOBILE_APP_PROMO', false],
  ];
  const fragment = options.map(([key, value]) => `${key}=${encodeURIComponent(JSON.stringify(value))}`).join('&');
  return `https://${host}/${roomName}#${fragment}`;
}

function sessionEndTime(session) {
  return new Date(session.scheduled_at).getTime() + Number(session.duration_minutes) * 60_000;
}

// Why the room can or cannot be entered right now: 'open', 'early', 'closed' (ended, cancelled or completed) or 'unavailable'.
export function roomAccess(session, role, now = Date.now()) {
  if (!session || session.provider !== LIVE_PROVIDER || !isValidRoomName(session.room_name)) return 'unavailable';
  if (session.status !== 'scheduled') return 'closed';
  if (now >= sessionEndTime(session) + JOIN_GRACE_MINUTES * 60_000) return 'closed';
  // The coach may open the room ahead of time to get ready; clients wait for the start window.
  if (role !== 'coach' && now < new Date(session.scheduled_at).getTime() - JOIN_OPENS_MINUTES * 60_000) return 'early';
  return 'open';
}
