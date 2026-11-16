// The built-in "ApexFit Live" room. Every session has its own room named after its random id, and only people
// who can read the session in ApexFit (and pass the signaling channel's access rules) can enter it.
// The call itself is native WebRTC; see webrtcRoom.js.

export const JOIN_GRACE_MINUTES = 60;
export const JOIN_OPENS_MINUTES = 10;
export const LIVE_PROVIDER = 'apexfit_live';

const ROOM_NAME = /^apexfit-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function roomNameFor(sessionId) {
  return `apexfit-session-${String(sessionId).toLowerCase()}`;
}

export function isValidRoomName(name) {
  return typeof name === 'string' && ROOM_NAME.test(name);
}

export function roomPath(sessionId) {
  return `/sessions/${sessionId}/room`;
}

// Names are shown to everyone in the room, so keep them short and free of control characters.
export function sanitizeDisplayName(name, fallback = 'ApexFit') {
  // eslint-disable-next-line no-control-regex
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || fallback;
}

function sessionEndTime(session) {
  return new Date(session.scheduled_at).getTime() + Number(session.duration_minutes) * 60_000;
}

// Why the room can or cannot be entered right now: 'open', 'early', 'closed' (ended, cancelled or completed) or 'unavailable'.
// The database applies the same rules to the signaling channel (can_join_video_room).
export function roomAccess(session, role, now = Date.now()) {
  if (!session || session.provider !== LIVE_PROVIDER || !isValidRoomName(session.room_name)) return 'unavailable';
  if (session.status !== 'scheduled') return 'closed';
  if (now >= sessionEndTime(session) + JOIN_GRACE_MINUTES * 60_000) return 'closed';
  // The coach may open the room ahead of time to get ready; clients wait for the start window.
  if (role !== 'coach' && now < new Date(session.scheduled_at).getTime() - JOIN_OPENS_MINUTES * 60_000) return 'early';
  return 'open';
}
