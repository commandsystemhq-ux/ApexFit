import { requireSupabase } from './supabaseClient.js';
import { getCurrentUserId } from './clientIdentity.js';
import { normalizeIntakeForm } from './clientPriority2Utils.js';

const INTAKE_FIELDS = 'primary_goal,experience_level,training_days_per_week,equipment_access,height_cm,injuries,medical_conditions,dietary_preferences,additional_notes,updated_at';

export async function getMyIntakeForm() {
  const { data, error } = await requireSupabase()
    .from('client_intake_forms')
    .select(INTAKE_FIELDS)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveMyIntakeForm(form) {
  const client = requireSupabase();
  const normalized = normalizeIntakeForm(form);
  const { error } = await client
    .from('client_intake_forms')
    .upsert({ client_id: await getCurrentUserId(client), ...normalized }, { onConflict: 'client_id' });
  if (error) throw error;
}
