import { callApi } from './apiClient.js';
import { requireSupabase } from './supabaseClient.js';

const SESSION_FIELDS = 'id,client_id,group_id,title,description,scheduled_at,duration_minutes,provider,meeting_url,meeting_passcode,status,created_at';

export async function listVideoSessions() {
  const { data, error } = await requireSupabase().from('video_sessions').select(SESSION_FIELDS).order('scheduled_at', { ascending: false }).limit(200);
  if (error) throw error;
  return data || [];
}

export async function getMyVideoSessions() {
  const { data, error } = await requireSupabase().rpc('get_my_video_sessions');
  if (error) throw error;
  return data || [];
}

export async function getVideoConfig() {
  return callApi('video-sessions', { body: { action: 'config' } });
}

// The server creates the Zoom meeting (when asked and configured), saves the session, and notifies the audience.
export function scheduleVideoSession(payload, { autoLink }) {
  return callApi('video-sessions', { body: { action: 'schedule', ...payload, autoLink } });
}

export async function updateVideoSession({ id, title, description, scheduledAt, durationMinutes, provider, meetingUrl, passcode }) {
  const { error } = await requireSupabase().rpc('update_video_session', {
    p_session_id: id, p_title: title, p_description: description, p_scheduled_at: scheduledAt,
    p_duration_minutes: durationMinutes, p_provider: provider, p_meeting_url: meetingUrl, p_meeting_passcode: passcode,
  });
  if (error) throw error;
}

export async function setVideoSessionStatus(sessionId, status) {
  const { error } = await requireSupabase().rpc('set_video_session_status', { p_session_id: sessionId, p_status: status });
  if (error) throw error;
}

export async function deleteVideoSession(sessionId) {
  const { error } = await requireSupabase().rpc('delete_video_session', { p_session_id: sessionId });
  if (error) throw error;
}