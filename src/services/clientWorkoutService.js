import { requireSupabase } from './supabaseClient.js';

const WORKOUT_FIELDS = `
  id,workout_date,title,created_at,
  sets:client_workout_set_logs(
    id,exercise_id,exercise_order,set_number,actual_reps,actual_weight_kg,notes,
    exercise:exercises(id,name,name_i18n,category,primary_muscles,equipment,difficulty,demo_video_url,thumbnail_url)
  )
`;

export async function listClientWorkoutSessions(limit = 8) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Workout history limit is invalid.');
  const { data, error } = await requireSupabase()
    .from('client_workout_sessions')
    .select(WORKOUT_FIELDS)
    .order('workout_date', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data || []).map((session) => ({
    ...session,
    sets: (session.sets || []).sort((left, right) => (
      left.exercise_order - right.exercise_order || left.set_number - right.set_number
    )),
  }));
}

export async function saveClientWorkout({ workoutDate, title, exercises }) {
  const { data, error } = await requireSupabase().rpc('save_client_workout', {
    p_workout_date: workoutDate,
    p_title: title,
    p_exercises: exercises,
  });
  if (error) throw error;
  return data;
}
