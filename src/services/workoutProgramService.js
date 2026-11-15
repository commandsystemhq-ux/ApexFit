import { requireSupabase } from './supabaseClient.js';
import { countProgramContents } from './clientPriority2Utils.js';

export const BUILDER_HANDOFF_KEY = 'apexfit.builder-program';

const PROGRAM_DETAIL_FIELDS = `
  id,title,description,status,is_template,updated_at,
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
    .select('id,title,description,status,is_template,updated_at,created_at,days:training_program_days(id,exercises:training_program_exercises(id))')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(({ days, ...program }) => ({ ...program, ...countProgramContents({ days }) }));
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

export async function saveWorkoutProgram({ id = null, title, description, days, isTemplate = null }) {
  const { data, error } = await requireSupabase().rpc('save_training_program', {
    p_program_id: id,
    p_title: title,
    p_description: description,
    p_days: days,
  });
  if (error) throw error;
  if (typeof isTemplate === 'boolean') await setProgramTemplate(data, isTemplate);
  return data;
}

export async function setProgramTemplate(programId, isTemplate) {
  const { error } = await requireSupabase().rpc('set_training_program_template', {
    p_program_id: programId,
    p_is_template: isTemplate,
  });
  if (error) throw error;
}

export async function duplicateWorkoutProgram(programId, title, asTemplate = false) {
  const { data, error } = await requireSupabase().rpc('duplicate_training_program', {
    p_program_id: programId,
    p_title: title,
    p_as_template: asTemplate,
  });
  if (error) throw error;
  return data;
}
