export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.events openid email';

// Google accepts custom event IDs made of a-v and 0-9, so the session UUID (hex) makes syncing idempotent.
export function eventIdForSession(sessionId) {
  return String(sessionId).replace(/-/g, '').toLowerCase();
}

export function buildCalendarEvent(session, clientLabel) {
  const summary = clientLabel ? `${session.title} — ${clientLabel}` : session.title;
  const notes = [session.notes, session.status === 'completed' ? 'Completed in ApexFit' : ''].filter(Boolean).join('\n\n');
  return {
    id: eventIdForSession(session.id),
    summary,
    description: notes,
    location: session.location || undefined,
    start: { dateTime: new Date(session.starts_at).toISOString() },
    end: { dateTime: new Date(session.ends_at).toISOString() },
    reminders: { useDefault: true },
    extendedProperties: { private: { apexfitSessionId: session.id } },
  };
}

export function parseIdTokenEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
