import { requireSupabase } from './supabaseClient.js';

const CONTRACT_FIELDS = 'id,title,content_text,is_required_on_onboarding,is_archived,created_at';

// Coach: every contract with who signed it (signature images are loaded one at a time).
export async function listContracts() {
  const { data, error } = await requireSupabase()
    .from('contracts')
    .select(`${CONTRACT_FIELDS},signatures:contract_signatures(client_id,signer_full_name,signed_at)`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Client: the contracts of their coach, each with the client's own signature record if any.
export async function listMyContracts() {
  const { data, error } = await requireSupabase()
    .from('contracts')
    .select(`${CONTRACT_FIELDS},signatures:contract_signatures(id,signer_full_name,signed_at)`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getSignature(contractId, clientId) {
  const { data, error } = await requireSupabase()
    .from('contract_signatures')
    .select('id,contract_id,client_id,signer_full_name,signature_data_url,contract_title,content_snapshot,ip_or_user_agent,signed_at')
    .eq('contract_id', contractId)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listSignaturesForClient(clientId) {
  const { data, error } = await requireSupabase()
    .from('contract_signatures')
    .select('contract_id,signed_at')
    .eq('client_id', clientId);
  if (error) throw error;
  return data || [];
}

export async function saveContract({ id = null, title, content, required }) {
  const { data, error } = await requireSupabase().rpc('save_contract', {
    p_contract_id: id,
    p_title: title,
    p_content: content,
    p_required: required,
  });
  if (error) throw error;
  return data;
}

export async function setContractArchived(contractId, archived) {
  const { error } = await requireSupabase().rpc('set_contract_archived', { p_contract_id: contractId, p_archived: archived });
  if (error) throw error;
}

export async function deleteContract(contractId) {
  const { error } = await requireSupabase().rpc('delete_contract', { p_contract_id: contractId });
  if (error) throw error;
}

export async function signContract({ contractId, name, signatureDataUrl }) {
  const { data, error } = await requireSupabase().rpc('sign_contract', {
    p_contract_id: contractId,
    p_signer_name: name,
    p_signature_data_url: signatureDataUrl,
  });
  if (error) throw error;
  return data;
}
