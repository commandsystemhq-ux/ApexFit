import { requireSupabase } from './supabaseClient.js';

const ASSESSMENT_FIELDS = 'id,coach_id,client_id,parq_answers,fitness_goals,injuries_notes,medical_clearance_required,submitted_at';

export async function submitAssessment({ coachId = null, answers, goals, injuries }) {
  const { data, error } = await requireSupabase().rpc('submit_my_assessment', {
    p_coach_id: coachId,
    p_parq: answers,
    p_goals: goals,
    p_injuries: injuries,
  });
  if (error) throw error;
  return data;
}

// The signed-in client's own assessments (one per coach).
export async function listMyAssessments() {
  const { data, error } = await requireSupabase().from('client_assessments').select(ASSESSMENT_FIELDS);
  if (error) throw error;
  return data || [];
}

export async function getMyOnboardingStatus() {
  const { data, error } = await requireSupabase().rpc('get_my_onboarding_status');
  if (error) throw error;
  return data;
}

// Coach side: readable through RLS only for the coach's own clients.
export async function getClientAssessment(clientId) {
  const { data, error } = await requireSupabase()
    .from('client_assessments')
    .select(ASSESSMENT_FIELDS)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listClearanceFlags() {
  const { data, error } = await requireSupabase()
    .from('client_assessments')
    .select('client_id,medical_clearance_required,submitted_at');
  if (error) throw error;
  return data || [];
}
