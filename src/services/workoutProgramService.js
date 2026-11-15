import { requireSupabase } from './supabaseClient.js';

const PROGRAM_DETAIL_FIELDS = `
  id,title,description,status,updated_at,
  days:training_program_days(
    id,name,order_index,
    exercises:training_program_exercises(
      id,exercise_id,order_index,sets,reps,rest_seconds,notes,
      exercise:exercises(id,slug,name,category,primary_muscles,equipment,difficulty,demo_video_url,thumbnail_url)
    )
  )
`;

export async function listMyWorkoutPrograms() {
  const { data, error } = await requireSupabase()
    .from('training_programs')
    .select('id,title,description,status,updated_at,created_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getWorkoutProgram(programId) {
  const { data, error } = await requireSupabase()
    .from('training_programs')
    .select(PROGRAM_DETAIL_FIELDS)
    .eq('id', programId)
    .single();
  if (error) throw error;

  return {
    ...data,
    days: (data.days || [])
      .sort((left, right) => left.order_index - right.order_index)
      .map((day) => ({
        ...day,
        exercises: (day.exercises || []).sort((left, right) => left.order_index - right.order_index),
      })),
  };
}

export async function saveWorkoutProgram({ id = null, title, description, days }) {
  const { data, error } = await requireSupabase().rpc('save_training_program', {
    p_program_id: id,
    p_title: title,
    p_description: description,
    p_days: days,
  });
  if (error) throw error;
  return data;
}
