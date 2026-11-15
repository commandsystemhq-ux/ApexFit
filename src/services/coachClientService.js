import { requireSupabase } from './supabaseClient.js';

export async function listMyClients() {
  const { data, error } = await requireSupabase()
    .from('coach_clients')
    .select('client_id,client_name,client_email,status,created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createClientInvite() {
  const { data, error } = await requireSupabase().rpc('create_client_invite');
  if (error) throw error;
  return data;
}

export async function listOpenInvites() {
  const { data, error } = await requireSupabase()
    .from('client_invites')
    .select('code,expires_at,created_at')
    .is('redeemed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function setClientStatus(clientId, status) {
  const { error } = await requireSupabase().rpc('set_client_status', { p_client_id: clientId, p_status: status });
  if (error) throw error;
}

export async function getClientIntake(clientId) {
  const { data, error } = await requireSupabase()
    .from('client_intake_forms')
    .select('primary_goal,experience_level,training_days_per_week,equipment_access,height_cm,injuries,medical_conditions,dietary_preferences,additional_notes,updated_at')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function redeemClientInvite(code) {
  const { data, error } = await requireSupabase().rpc('redeem_client_invite', { p_code: code });
  if (error) throw error;
  return data;
}

export async function listMyCoaches() {
  const { data, error } = await requireSupabase()
    .from('coach_clients')
    .select('coach_id,coach_name,coach_email,status,created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
