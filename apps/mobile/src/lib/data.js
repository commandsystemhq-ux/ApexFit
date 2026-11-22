import { requireSupabase } from './supabase.js';
import { localDateString } from './format.js';

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ---- coach ----
export const listClients = async () => (await run(requireSupabase()
  .from('coach_clients')
  .select('client_id,client_name,client_email,status,created_at')
  .order('created_at', { ascending: false }))) || [];

export const listPrograms = async () => (await run(requireSupabase()
  .from('training_programs')
  .select('id,title,description,status,is_template,updated_at')
  .order('updated_at', { ascending: false }))) || [];

// ---- client ----
export const listAssignedPrograms = async () => (await run(requireSupabase()
  .from('program_assignments')
  .select('id,assigned_at,program:training_programs(id,title,description)')
  .order('assigned_at', { ascending: false }))) || [];

export async function getProgram(programId) {
  const data = await run(requireSupabase()
    .from('training_programs')
    .select(`id,title,description,
      days:training_program_days(id,name,order_index,
        exercises:training_program_exercises(id,order_index,sets,reps,rest_seconds,notes,exercise:exercises(id,name,name_i18n)))`)
    .eq('id', programId)
    .single());
  return {
    ...data,
    days: (data.days || []).sort((a, b) => a.order_index - b.order_index).map((day) => ({
      ...day,
      exercises: (day.exercises || []).sort((a, b) => a.order_index - b.order_index),
    })),
  };
}

export const listBodyMetrics = async (limit = 30) => (await run(requireSupabase()
  .from('client_body_metrics')
  .select('id,measured_on,weight_kg')
  .order('measured_on', { ascending: false })
  .limit(limit))) || [];

export async function saveBodyWeight(clientId, weightKg, measuredOn = localDateString()) {
  await run(requireSupabase()
    .from('client_body_metrics')
    .upsert({ client_id: clientId, measured_on: measuredOn, weight_kg: weightKg }, { onConflict: 'client_id,measured_on' }));
}
