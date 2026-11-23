import { requireSupabase } from './supabaseClient.js';

// The coach's own videos for these exercises (a client gets the ones of their coach). Nothing here may stop the library
// from showing, so a failure (for example the database was not updated yet) is an empty answer.
export async function listVideoOverrides(exerciseIds) {
  if (!exerciseIds.length) return [];
  try {
    const { data, error } = await requireSupabase().from('coach_exercise_videos').select('exercise_id,video_url').in('exercise_id', exerciseIds);
    return error ? [] : data || [];
  } catch {
    return [];
  }
}

// Sets the signed-in coach's video for an exercise; an empty link removes it.
export async function setExerciseVideo(exerciseId, url) {
  const { data, error } = await requireSupabase().rpc('set_exercise_video', { p_exercise_id: exerciseId, p_url: url || '' });
  if (error) throw error;
  return data;
}