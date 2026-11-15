import { adminClient, authenticate, requireRole } from './_lib/auth.js';
import { appUrl, env } from './_lib/config.js';
import { decryptSecret, encryptSecret, signState, verifyState } from './_lib/crypto.js';
import { buildAuthUrl, buildCalendarEvent, eventIdForSession, parseIdTokenEmail } from './_lib/googleCalendar.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';

const redirectUri = () => `${appUrl()}/api/google?action=callback`;

async function tokenRequest(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      ...params,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, payload };
}

async function accessTokenFor(admin, connection) {
  const refreshToken = decryptSecret(connection.refresh_token_encrypted, env('TOKEN_ENCRYPTION_KEY'));
  const { ok, payload } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!ok) {
    if (payload.error === 'invalid_grant') {
      await admin.from('google_calendar_connections').delete().eq('coach_id', connection.coach_id);
      throw new HttpError(409, 'Google Calendar access was revoked. Reconnect it from the schedule page.');
    }
    throw new HttpError(502, 'Google rejected the calendar authorization.');
  }
  return payload.access_token;
}

async function handleCallback(req, res) {
  const { code, state, error } = req.query;
  const target = (result) => `${appUrl()}/?google=${result}#schedule`;
  const redirect = (result) => {
    res.setHeader('Location', target(result));
    res.status(302).end();
  };

  const payload = verifyState(state, env('TOKEN_ENCRYPTION_KEY'));
  if (!payload?.coachId) throw new HttpError(400, 'The authorization request has expired. Try connecting again.');
  if (error || !code) return redirect('denied');

  const { ok, payload: tokens } = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  });
  if (!ok || !tokens.refresh_token) return redirect('failed');

  const { error: saveError } = await adminClient().from('google_calendar_connections').upsert({
    coach_id: payload.coachId,
    google_email: parseIdTokenEmail(tokens.id_token),
    refresh_token_encrypted: encryptSecret(tokens.refresh_token, env('TOKEN_ENCRYPTION_KEY')),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'coach_id' });
  if (saveError) throw saveError;
  return redirect('connected');
}

async function calendarRequest(url, accessToken, method, body) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

async function syncSession({ user, userClient }, sessionId) {
  const admin = adminClient();
  const { data: session, error } = await userClient
    .from('coach_sessions')
    .select('id,client_id,title,starts_at,ends_at,location,notes,status,google_event_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!session) throw new HttpError(404, 'Session not found.');

  const { data: connection, error: connectionError } = await admin
    .from('google_calendar_connections')
    .select('coach_id,refresh_token_encrypted,calendar_id')
    .eq('coach_id', user.id)
    .maybeSingle();
  if (connectionError) throw connectionError;
  if (!connection) throw new HttpError(409, 'Google Calendar is not connected.');

  const { data: link } = await userClient
    .from('coach_clients')
    .select('client_name,client_email')
    .eq('client_id', session.client_id)
    .maybeSingle();

  const accessToken = await accessTokenFor(admin, connection);
  const baseUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendar_id)}/events`;
  const eventId = eventIdForSession(session.id);

  if (session.status === 'canceled') {
    const response = await calendarRequest(`${baseUrl}/${eventId}`, accessToken, 'DELETE');
    if (!response.ok && ![404, 410].includes(response.status)) throw new HttpError(502, 'Google Calendar could not remove the event.');
    await admin.from('coach_sessions').update({ google_event_id: null, google_synced_at: new Date().toISOString() }).eq('id', session.id);
    return { synced: true, removed: true };
  }

  const event = { ...buildCalendarEvent(session, link?.client_name || link?.client_email || ''), status: 'confirmed' };
  let response = await calendarRequest(`${baseUrl}/${eventId}`, accessToken, 'PUT', event);
  if (response.status === 404) response = await calendarRequest(baseUrl, accessToken, 'POST', event);
  if (!response.ok) throw new HttpError(502, 'Google Calendar could not save the event.');

  await admin.from('coach_sessions').update({ google_event_id: eventId, google_synced_at: new Date().toISOString() }).eq('id', session.id);
  return { synced: true, removed: false };
}

async function disconnect({ user }) {
  const admin = adminClient();
  const { data } = await admin.from('google_calendar_connections').select('refresh_token_encrypted').eq('coach_id', user.id).maybeSingle();
  if (data) {
    try {
      const token = decryptSecret(data.refresh_token_encrypted, env('TOKEN_ENCRYPTION_KEY'));
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // Revocation is best effort; the stored credential is deleted either way.
    }
  }
  const { error } = await admin.from('google_calendar_connections').delete().eq('coach_id', user.id);
  if (error) throw error;
  return { disconnected: true };
}

export default handler(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    if (req.query.action !== 'callback') throw new HttpError(400, 'Unknown action.');
    return handleCallback(req, res);
  }

  const context = await authenticate(req);
  const body = await readJson(req);
  await requireRole(context.userClient, 'coach');

  if (body.action === 'auth-url') {
    const state = signState({ coachId: context.user.id }, env('TOKEN_ENCRYPTION_KEY'));
    return res.status(200).json({ url: buildAuthUrl({ clientId: env('GOOGLE_CLIENT_ID'), redirectUri: redirectUri(), state }) });
  }
  if (body.action === 'sync') {
    return res.status(200).json(await syncSession(context, requireUuid(body.sessionId, 'Session')));
  }
  if (body.action === 'disconnect') {
    return res.status(200).json(await disconnect(context));
  }
  throw new HttpError(400, 'Unknown action.');
});
