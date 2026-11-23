import { getCurrentUserId } from './clientIdentity.js';
import { SIGNED_URL_SECONDS, checkinPhotoPath, validateCheckinPhoto } from './checkinUtils.js';
import { requireSupabase } from './supabaseClient.js';

const BUCKET = 'apexfit-checkin-photos';
const CHECKIN_FIELDS = 'id,client_id,coach_id,week_start_date,weight_kg,sleep_hours,sleep_quality_1_5,workout_adherence_1_10,diet_adherence_1_10,energy_level_1_5,client_notes,photo_paths,status,coach_feedback,reviewed_at,created_at';

async function call(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const getMyCheckinStatus = (today = null) => call('get_my_checkin_status', { p_today: today });

export async function listMyCheckins(limit = 60) {
  const { data, error } = await requireSupabase()
    .from('weekly_checkins')
    .select(CHECKIN_FIELDS)
    .order('week_start_date', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export const submitCheckin = (weekStart, payload, photoPaths) => call('submit_weekly_checkin', {
  p_week_start: weekStart,
  p_weight_kg: payload.weightKg,
  p_sleep_hours: payload.sleepHours,
  p_sleep_quality: payload.sleepQuality,
  p_workout_adherence: payload.workoutAdherence,
  p_diet_adherence: payload.dietAdherence,
  p_energy: payload.energy,
  p_notes: payload.notes,
  p_photo_paths: photoPaths,
});

// Uploads one photo to the client's own folder of the private bucket and returns its path.
export async function uploadCheckinPhoto(weekStart, slot, file) {
  const problem = validateCheckinPhoto(file);
  if (problem) throw new TypeError(problem);
  const client = requireSupabase();
  const path = checkinPhotoPath(await getCurrentUserId(client), weekStart, slot, file, crypto.randomUUID());
  const { error } = await client.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: '3600', upsert: false });
  if (error) throw error;
  return path;
}

export async function deleteCheckinPhotos(paths) {
  if (!paths.length) return;
  const { error } = await requireSupabase().storage.from(BUCKET).remove(paths);
  if (error) throw error;
}

// Short-lived links, requested only when a photo is about to be shown.
export async function signCheckinPhotos(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await requireSupabase().storage.from(BUCKET).createSignedUrls(unique, SIGNED_URL_SECONDS);
  if (error) throw error;
  return Object.fromEntries((data || []).filter((item) => item.signedUrl).map((item) => [item.path, item.signedUrl]));
}

export const getCheckinsForCoach = ({ status = null, clientId = null, limit = 100 } = {}) => call('get_checkins_for_coach', {
  p_status: status, p_client_id: clientId, p_limit: limit,
});

export const reviewCheckin = (checkinId, feedback) => call('review_weekly_checkin', { p_checkin_id: checkinId, p_feedback: feedback });
