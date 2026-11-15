import { callApi } from './apiClient.js';
import { normalizeSessionForm } from './coachingUtils.js';
import { notifyClients } from './pushService.js';
import { requireSupabase } from './supabaseClient.js';

const SESSION_FIELDS = 'id,client_id,title,starts_at,ends_at,location,notes,status,google_event_id,google_synced_at';

export async function listSessions(limit = 200) {
  const { data, error } = await requireSupabase()
    .from('coach_sessions')
    .select(SESSION_FIELDS)
    .order('starts_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export const syncSessionToGoogle = (sessionId) => callApi('google', { body: { action: 'sync', sessionId } });

async function syncIfConnected(sessionId, googleConnected) {
  if (!googleConnected) return false;
  try {
    await syncSessionToGoogle(sessionId);
    return true;
  } catch {
    return false;
  }
}

export async function scheduleSession(form, { googleConnected = false } = {}) {
  const session = normalizeSessionForm(form);
  const { data, error } = await requireSupabase().rpc('schedule_coach_session', {
    p_client_id: session.clientId,
    p_title: session.title,
    p_starts_at: session.startsAt,
    p_ends_at: session.endsAt,
    p_location: session.location,
    p_notes: session.notes,
  });
  if (error) throw error;
  notifyClients('session', data);
  return { id: data, synced: await syncIfConnected(data, googleConnected) };
}

export async function setSessionStatus(sessionId, status, { googleConnected = false } = {}) {
  const { data, error } = await requireSupabase().rpc('set_coach_session_status', {
    p_session_id: sessionId,
    p_status: status,
  });
  if (error) throw error;
  if (status === 'canceled') notifyClients('session', sessionId);
  return { ...data, synced: await syncIfConnected(sessionId, googleConnected) };
}

export async function getGoogleCalendarStatus() {
  const { data, error } = await requireSupabase().rpc('get_my_google_calendar_status');
  if (error) throw error;
  return data;
}

export const startGoogleConnect = () => callApi('google', { body: { action: 'auth-url' } });
export const disconnectGoogle = () => callApi('google', { body: { action: 'disconnect' } });
