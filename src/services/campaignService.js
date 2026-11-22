import { callApi } from './apiClient.js';
import { requireSupabase } from './supabaseClient.js';

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

export const createCampaign = ({ subject, body, language, clientIds, sendToAll }) => rpc('create_email_campaign', {
  p_subject: subject,
  p_body: body,
  p_language: language,
  p_client_ids: sendToAll ? null : clientIds,
  p_send_to_all: Boolean(sendToAll),
});

export async function listCampaigns() {
  const { data, error } = await requireSupabase()
    .from('email_campaigns')
    .select('id,subject,body,language,audience,status,total_count,sent_count,failed_count,skipped_count,created_at,completed_at')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return data || [];
}

export async function listCampaignRecipients(campaignId) {
  const { data, error } = await requireSupabase()
    .from('email_campaign_recipients')
    .select('id,client_name,email,status,error,sent_at')
    .eq('campaign_id', campaignId)
    .order('status', { ascending: true })
    .limit(500);
  if (error) throw error;
  return data || [];
}

export const retryFailedRecipients = (campaignId) => rpc('retry_failed_email_recipients', { p_campaign_id: campaignId });

// Is the email provider set up on the server? (Never returns the key itself.)
export async function getEmailStatus() {
  const result = await callApi('send-campaign', { body: { action: 'status' } });
  return Boolean(result.configured);
}

// Sends the next few recipients. Call again while `remaining` is above zero.
export const sendCampaignBatch = (campaignId) => callApi('send-campaign', { body: { action: 'send', campaignId } });

export const getMyEmailPreferences = () => rpc('get_my_email_preferences', {});
export const setMyEmailMarketingOptOut = (optOut) => rpc('set_my_email_marketing_opt_out', { p_opt_out: optOut });
