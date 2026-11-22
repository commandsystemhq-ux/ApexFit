import { authenticate, requireRole } from './_lib/auth.js';
import { CAMPAIGN_BATCH_SIZE, emailConfig, isEmailConfigured, sendCampaignBatch, sendEmailViaResend } from './_lib/emailCampaign.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';
import { createRateLimiter } from './_lib/jackAgent.js';

const allowRequest = createRateLimiter({ limit: 30, windowMs: 60_000 });

// Sends a coach's email campaign a few recipients at a time (the browser keeps calling `send` until nothing is left,
// which keeps every request short). The coach's own session is used for every database call, so the database decides
// which campaign and which clients are theirs; the email provider key stays on the server.
export default handler(['POST'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  if (!allowRequest(user.id)) throw new HttpError(429, 'Too many requests. Wait a moment.');
  await requireRole(userClient, 'coach');
  const body = await readJson(req);

  if (body.action === 'status') return res.status(200).json({ configured: isEmailConfigured() });
  if (body.action !== 'send') throw new HttpError(400, 'Unknown action.');

  const campaignId = requireUuid(body.campaignId, 'Campaign');
  // Read the settings before claiming anyone, so a missing key never leaves recipients half-claimed.
  const config = emailConfig();

  const { data: claimed, error } = await userClient.rpc('claim_email_campaign_batch', { p_campaign_id: campaignId, p_limit: CAMPAIGN_BATCH_SIZE });
  if (error) throw new HttpError(400, error.message);

  const result = await sendCampaignBatch({
    claimed,
    config,
    replyTo: user.email,
    send: sendEmailViaResend,
    record: async (recipientId, ok, failure) => {
      const { error: recordError } = await userClient.rpc('record_email_campaign_result', { p_recipient_id: recipientId, p_ok: ok, p_error: failure });
      if (recordError) throw recordError;
    },
  });
  res.status(200).json(result);
});
