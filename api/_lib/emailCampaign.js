import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigError, appUrl } from './config.js';
import { renderCampaignEmail } from '../../src/services/campaignTemplate.js';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
export const CAMPAIGN_BATCH_SIZE = 10;

// Everything the server needs to send. Missing settings raise a ConfigError (503) before any recipient is claimed.
export function emailConfig(environment = process.env) {
  const need = (name, fallbacks = []) => {
    for (const key of [name, ...fallbacks]) if (environment[key]) return environment[key];
    throw new ConfigError(`${name} is not configured on the server.`);
  };
  return {
    apiKey: need('RESEND_API_KEY'),
    from: need('EMAIL_FROM'),
    secret: need('EMAIL_UNSUBSCRIBE_SECRET', ['TOKEN_ENCRYPTION_KEY']),
    baseUrl: appUrl(environment),
  };
}

export function isEmailConfigured(environment = process.env) {
  return Boolean(environment.RESEND_API_KEY && environment.EMAIL_FROM);
}

// ----------------------------------------------------------------------------------------- unsubscribe links

export function signUnsubscribe(clientId, secret) {
  return createHmac('sha256', secret).update(`unsubscribe:${clientId}`).digest('base64url');
}

export function verifyUnsubscribe(clientId, token, secret) {
  if (typeof clientId !== 'string' || typeof token !== 'string' || !clientId || !token) return false;
  const expected = Buffer.from(signUnsubscribe(clientId, secret));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function buildUnsubscribeUrl(baseUrl, clientId, language, secret) {
  const params = new URLSearchParams({ u: clientId, t: signUnsubscribe(clientId, secret), l: language });
  return `${baseUrl}/api/unsubscribe?${params}`;
}

// ---------------------------------------------------------------------------------------------- the provider

export function senderAddress(from, coachName) {
  const address = /<([^>]+)>/.exec(from)?.[1] || from;
  const name = String(coachName || 'ApexFit').replace(/[<>"\r\n]/g, '').trim().slice(0, 60) || 'ApexFit';
  return `${name} <${address.trim()}>`;
}

// One email through Resend. Throws an Error with `retryable` set for rate limits and server errors.
export async function sendEmailViaResend({ apiKey, from, to, replyTo, subject, html, text, headers }, { fetchImpl = fetch, timeoutMs = SEND_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text, headers, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(payload?.message || `The email service answered ${response.status}.`);
      failure.retryable = response.status === 429 || response.status >= 500;
      throw failure;
    }
    return { id: payload?.id || null };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const failure = new Error('The email service took too long to answer.');
      failure.retryable = true;
      throw failure;
    }
    if (error.retryable === undefined) error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(task, { retries = 1, delayMs = 800 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!error.retryable || attempt >= retries) throw error;
      await wait(delayMs * (attempt + 1));
    }
  }
}

// ------------------------------------------------------------------------------------------------ one batch

// Sends the claimed recipients with a small number at a time and records each result, so one bad address never
// stops the others. `send(message)` and `record(id, ok, error)` are passed in, which keeps this testable.
export async function sendCampaignBatch({ claimed, config, replyTo, send, record, concurrency = 2, retryDelayMs = 800 }) {
  const { campaign, recipients, remaining } = claimed;
  const queue = [...recipients];
  let sent = 0;
  let failed = 0;

  async function worker() {
    while (queue.length) {
      const recipient = queue.shift();
      try {
        const unsubscribeUrl = buildUnsubscribeUrl(config.baseUrl, recipient.client_id, campaign.language, config.secret);
        const email = renderCampaignEmail({
          subject: campaign.subject, body: campaign.body, language: campaign.language,
          clientName: recipient.name, coachName: campaign.coach_name, unsubscribeUrl,
        });
        await withRetry(() => send({
          apiKey: config.apiKey,
          from: senderAddress(config.from, campaign.coach_name),
          to: recipient.email,
          replyTo,
          subject: email.subject,
          html: email.html,
          text: email.text,
          headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        }), { delayMs: retryDelayMs });
        sent += 1;
        // The email is out; if saving the result fails, try again rather than calling a delivered email failed.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await record(recipient.id, true, null);
            break;
          } catch {
            await wait(200);
          }
        }
      } catch (error) {
        failed += 1;
        await record(recipient.id, false, String(error?.message || 'The email could not be sent').slice(0, 300)).catch(() => null);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));
  return { sent, failed, remaining: Number(remaining) || 0 };
}
