import { ConfigError, appUrl, env } from './_lib/config.js';
import { adminClient, authenticate, requireRole } from './_lib/auth.js';
import { buildTaskEvent, isIsoDay, isValidTimeZone, addDays, taskEventId } from './_lib/checklistCalendar.js';
import { decryptSecret, encryptSecret, verifyState } from './_lib/crypto.js';
import { buildCalendarEvent, eventIdForSession, parseIdTokenEmail } from './_lib/googleCalendar.js';
import { RETURN_PAGES, googleCredentials as loadGoogleCredentials, googleRedirectUri, startGoogleAuthorization } from './_lib/googleAuth.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';
import { withOwnerDiagnostics } from './_lib/ownerDiagnostics.js';
import { safeAdminClient } from './_lib/platformIntegrations.js';

const redirectUri = () => googleRedirectUri();
const MAX_TASKS_PER_SYNC = 60;

// The keys saved by the platform owner, else the server's GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
const googleCredentials = () => loadGoogleCredentials({ admin: safeAdminClient() });

// The stored refresh token, or a clear "connect again" when it can no longer be read (for example after the
// encryption key was changed).
function readRefreshToken(connection) {
  try {
    return decryptSecret(connection.refresh_token_encrypted, env('TOKEN_ENCRYPTION_KEY'));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new HttpError(409, 'The saved Google Calendar connection can no longer be read. Connect it again.');
  }
}

async function tokenRequest(params, credentials) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      ...params,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, payload };
}

async function accessTokenFor(admin, connection, credentials) {
  const refreshToken = readRefreshToken(connection);
  const { ok, payload } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, credentials);
  if (!ok) {
    if (payload.error === 'invalid_grant') {
      await admin.from('google_calendar_connections').delete().eq('coach_id', connection.coach_id);
      throw new HttpError(409, 'Google Calendar access was revoked. Connect it again.');
    }
    throw new HttpError(502, 'Google rejected the calendar authorization.');
  }
  return payload.access_token;
}

async function handleCallback(req, res) {
  const { code, state, error } = req.query;
  const payload = verifyState(state, env('TOKEN_ENCRYPTION_KEY'));
  const owner = payload?.userId || payload?.coachId;
  const page = RETURN_PAGES[payload?.returnTo] || RETURN_PAGES.schedule;
  const redirect = (result) => {
    res.setHeader('Location', `${appUrl()}${page}?google=${result}`);
    res.status(302).end();
  };
  if (!owner) throw new HttpError(400, 'The authorization request has expired. Try connecting again.');
  if (error || !code) return redirect('denied');

  // Whatever goes wrong while finishing the connection, the person lands back on their page with a clear
  // "could not connect" notice instead of a raw error page. The cause is in the server log.
  try {
    const credentials = await googleCredentials();
    const { ok, payload: tokens } = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }, credentials);
    if (!ok || !tokens.refresh_token) {
      console.error('Google did not accept the authorization:', tokens?.error, tokens?.error_description);
      return redirect('failed');
    }

    const { error: saveError } = await adminClient().from('google_calendar_connections').upsert({
      coach_id: owner,
      google_email: parseIdTokenEmail(tokens.id_token),
      refresh_token_encrypted: encryptSecret(tokens.refresh_token, env('TOKEN_ENCRYPTION_KEY')),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'coach_id' });
    if (saveError) throw saveError;
  } catch (failure) {
    console.error('Could not finish the Google Calendar connection:', failure?.message || failure);
    return redirect('failed');
  }
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

async function connectionFor(admin, userId) {
  const { data: connection, error } = await admin
    .from('google_calendar_connections')
    .select('coach_id,refresh_token_encrypted,calendar_id')
    .eq('coach_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!connection) throw new HttpError(409, 'Google Calendar is not connected.');
  return connection;
}

const eventsUrl = (connection) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendar_id)}/events`;

async function syncSession({ user, userClient }, sessionId) {
  const admin = adminClient();
  const { data: session, error } = await userClient
    .from('coach_sessions')
    .select('id,client_id,title,starts_at,ends_at,location,notes,status,google_event_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw error;
  if (!session) throw new HttpError(404, 'Session not found.');

  const connection = await connectionFor(admin, user.id);

  const { data: link } = await userClient
    .from('coach_clients')
    .select('client_name,client_email')
    .eq('client_id', session.client_id)
    .maybeSingle();

  const accessToken = await accessTokenFor(admin, connection, await googleCredentials());
  const baseUrl = eventsUrl(connection);
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

// Adds the client's checklist tasks that are marked "add to my calendar" to their Google Calendar, with a reminder.
async function syncChecklist({ user, userClient }, body) {
  if (!isValidTimeZone(body.timeZone)) throw new HttpError(400, 'A valid time zone is required.');
  if (!isIsoDay(body.today)) throw new HttpError(400, 'Today\'s date is required.');
  const only = (list, label) => (Array.isArray(list) ? list.slice(0, MAX_TASKS_PER_SYNC).map((id) => requireUuid(id, label)) : null);
  const templateIds = only(body.templateIds, 'Task');
  const entryIds = only(body.entryIds, 'Task');

  // Row-level security limits both reads to this client's own tasks.
  let templates = userClient.from('checklist_templates')
    .select('id,title,category,target_amount,unit,days_of_week,remind_time').eq('is_active', true).eq('calendar_sync', true).not('remind_time', 'is', null);
  if (templateIds) templates = templates.in('id', templateIds);
  let entries = userClient.from('checklist_entries')
    .select('id,title,category,target_amount,unit,task_date,remind_time').eq('calendar_sync', true).is('template_id', null)
    .not('remind_time', 'is', null).gte('task_date', addDays(body.today, -1));
  if (entryIds) entries = entries.in('id', entryIds);
  const [templateResult, entryResult] = await Promise.all([templates.limit(MAX_TASKS_PER_SYNC), entries.limit(MAX_TASKS_PER_SYNC)]);
  if (templateResult.error) throw templateResult.error;
  if (entryResult.error) throw entryResult.error;

  const tasks = [
    ...(templateResult.data || []).map((row) => ({ ...row, kind: 'template' })),
    ...(entryResult.data || []).map((row) => ({ ...row, kind: 'entry' })),
  ].slice(0, MAX_TASKS_PER_SYNC);
  if (tasks.length === 0) return { synced: 0, failed: 0 };

  const admin = adminClient();
  const connection = await connectionFor(admin, user.id);
  const accessToken = await accessTokenFor(admin, connection, await googleCredentials());
  const baseUrl = eventsUrl(connection);

  let synced = 0;
  let failed = 0;
  for (let index = 0; index < tasks.length; index += 5) {
    await Promise.all(tasks.slice(index, index + 5).map(async (task) => {
      try {
        const event = buildTaskEvent(task, { timeZone: body.timeZone, today: body.today });
        let response = await calendarRequest(`${baseUrl}/${event.id}`, accessToken, 'PUT', event);
        if (response.status === 404) response = await calendarRequest(baseUrl, accessToken, 'POST', event);
        if (response.ok) synced += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }));
  }
  if (synced === 0 && failed > 0) throw new HttpError(502, 'Google Calendar could not save the events.');
  return { synced, failed };
}

// Removes the calendar event of a task. The event id comes from the task id and the event is in the caller's own
// calendar, so there is nothing to check besides the sign-in.
async function removeTaskEvent({ user }, taskId) {
  const admin = adminClient();
  const connection = await connectionFor(admin, user.id);
  const accessToken = await accessTokenFor(admin, connection, await googleCredentials());
  const response = await calendarRequest(`${eventsUrl(connection)}/${taskEventId(taskId)}`, accessToken, 'DELETE');
  if (!response.ok && ![404, 410].includes(response.status)) throw new HttpError(502, 'Google Calendar could not remove the event.');
  return { removed: true };
}

async function disconnect({ user }) {
  const admin = adminClient();
  const { data } = await admin.from('google_calendar_connections').select('refresh_token_encrypted').eq('coach_id', user.id).maybeSingle();
  if (data) {
    try {
      const token = readRefreshToken(data);
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

// Coaches and clients can both connect their calendar; each action checks the role it is for.
async function roleOf(userClient) {
  const { data, error } = await userClient.rpc('get_my_access_status');
  if (error || !data) throw new HttpError(403, 'Account details are not available.');
  if (!['coach', 'client'].includes(data.role)) throw new HttpError(403, 'Google Calendar is available to coach and client accounts.');
  return data.role;
}

export default handler(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    if (req.query.action !== 'callback') throw new HttpError(400, 'Unknown action.');
    return handleCallback(req, res);
  }

  const context = await authenticate(req);
  const body = await readJson(req);

  // Unexpected failures are shown in full to the platform owner and as the generic message to everyone else.
  const result = await withOwnerDiagnostics(context.user, async () => {
    const role = await roleOf(context.userClient);

    if (body.action === 'auth-url') {
      if (role === 'coach') await requireRole(context.userClient, 'coach');
      const returnTo = role === 'client' ? 'checklist' : body.returnTo;
      const { url } = await startGoogleAuthorization({ userId: context.user.id, returnTo, admin: safeAdminClient() });
      return { url };
    }
    if (body.action === 'disconnect') return disconnect(context);
    if (body.action === 'sync') {
      await requireRole(context.userClient, 'coach');
      return syncSession(context, requireUuid(body.sessionId, 'Session'));
    }
    if (body.action === 'sync-checklist' || body.action === 'remove-event') {
      if (role !== 'client') throw new HttpError(403, 'A client account is required.');
      return body.action === 'sync-checklist' ? syncChecklist(context, body) : removeTaskEvent(context, requireUuid(body.taskId, 'Task'));
    }
    throw new HttpError(400, 'Unknown action.');
  });
  res.status(200).json(result);
});
