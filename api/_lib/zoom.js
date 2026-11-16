import { optionalEnv } from './config.js';

const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_URL = 'https://api.zoom.us/v2';
const TIMEOUT_MS = 20_000;

export class ZoomError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Server-to-Server OAuth app credentials; all three must be present for automatic links.
export function zoomCredentials(environment = process.env) {
  const read = (name) => (environment[name] || '').trim();
  const accountId = read('ZOOM_ACCOUNT_ID');
  const clientId = read('ZOOM_CLIENT_ID');
  const clientSecret = read('ZOOM_CLIENT_SECRET');
  return accountId && clientId && clientSecret ? { accountId, clientId, clientSecret } : null;
}

export function isZoomConfigured(environment = process.env) {
  return zoomCredentials(environment) !== null;
}

// Zoom passcodes: up to 10 characters from letters, numbers and @ - _ * .
export function sanitizePasscode(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9@\-_*.]/g, '').slice(0, 10);
}

export function buildMeetingBody({ title, startsAt, durationMinutes, passcode, description }) {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) throw new ZoomError('The session start time is not valid.', 400);
  const body = {
    topic: String(title).slice(0, 200),
    type: 2,
    start_time: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration: Math.min(Math.max(Math.round(Number(durationMinutes) || 60), 1), 1440),
    timezone: 'UTC',
    agenda: String(description || '').slice(0, 2000),
    settings: { join_before_host: false, waiting_room: true, mute_upon_entry: true },
  };
  const code = sanitizePasscode(passcode);
  if (code) body.password = code;
  return body;
}

async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ZoomError('Zoom did not respond in time.', 504);
  }
}

export async function getAccessToken(credentials, fetchImpl = fetch) {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
  const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(credentials.accountId)}`;
  const response = await request(fetchImpl, url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  if (!response.ok) throw new ZoomError('Zoom rejected the configured credentials.', 503);
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) throw new ZoomError('Zoom did not return an access token.', 502);
  return data.access_token;
}

// Creates a scheduled meeting and returns the join link and passcode.
export async function createMeeting(details, { credentials = zoomCredentials(), fetchImpl = fetch } = {}) {
  if (!credentials) throw new ZoomError('Zoom is not configured on the server.', 503);
  const token = await getAccessToken(credentials, fetchImpl);
  const response = await request(fetchImpl, `${API_URL}/users/me/meetings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMeetingBody(details)),
  });
  if (response.status === 429) throw new ZoomError('Zoom is busy. Try again in a moment.', 429);
  if (!response.ok) throw new ZoomError('Zoom could not create the meeting.', 502);
  const meeting = await response.json().catch(() => ({}));
  if (typeof meeting.join_url !== 'string' || !meeting.join_url.startsWith('https://')) {
    throw new ZoomError('Zoom did not return a meeting link.', 502);
  }
  return { id: String(meeting.id), url: meeting.join_url, passcode: String(meeting.password || '') };
}

// Best effort: used to avoid leaving an unused meeting behind when saving the session fails.
export async function deleteMeeting(meetingId, { credentials = zoomCredentials(), fetchImpl = fetch } = {}) {
  if (!credentials || !meetingId) return;
  try {
    const token = await getAccessToken(credentials, fetchImpl);
    await request(fetchImpl, `${API_URL}/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // Nothing else to do; the meeting simply goes unused.
  }
}

export { optionalEnv };