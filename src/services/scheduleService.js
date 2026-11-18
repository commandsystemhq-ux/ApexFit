import { normalizeSessionForm } from './coachingUtils.js';
import { notifyClients } from './pushService.js';
import { requireSupabase } from './supabaseClient.js';

const SESSION_FIELDS = 'id,client_id,title,starts_at,ends_at,location,notes,status';

export async function listSessions(limit = 200) {
  const { data, error } = await requireSupabase()
    .from('coach_sessions')
    .select(SESSION_FIELDS)
    .order('starts_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function scheduleSession(form) {
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
  return { id: data };
}

export async function setSessionStatus(sessionId, status) {
  const { data, error } = await requireSupabase().rpc('set_coach_session_status', {
    p_session_id: sessionId,
    p_status: status,
  });
  if (error) throw error;
  if (status === 'canceled') notifyClients('session', sessionId);
  return data;
}
