import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfigError, env, optionalEnv } from './config.js';
import { HttpError } from './http.js';

// Paddle Billing (Merchant of Record) for coach subscriptions. Paddle sells, collects tax and invoices the coach;
// ApexFit only keeps the result in coach_subscriptions through apply_subscription_event().
//
// Settings (server only, except the client token which Paddle designed to be public):
//   PADDLE_ENVIRONMENT    sandbox (default) or production
//   PADDLE_API_KEY        server API key
//   PADDLE_CLIENT_TOKEN   client-side token for Paddle.js (NEXT_PUBLIC_PADDLE_CLIENT_TOKEN and VITE_PADDLE_CLIENT_TOKEN are accepted too)
//   PADDLE_PRICE_ID       the recurring price (pri_...) of the coach plan
//   PADDLE_WEBHOOK_SECRET the notification destination's secret key (pdl_ntfset_...)

export const PROVIDER = 'paddle';
export const DEFAULT_PLAN = 'coach_monthly';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const API_HOSTS = { sandbox: 'https://sandbox-api.paddle.com', production: 'https://api.paddle.com' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function paddleEnvironment(environment = process.env) {
  const value = String(environment.PADDLE_ENVIRONMENT || 'sandbox').trim().toLowerCase();
  if (!['sandbox', 'production'].includes(value)) throw new ConfigError('PADDLE_ENVIRONMENT must be sandbox or production.');
  return value;
}

export function paddleConfig(environment = process.env) {
  const read = (name) => String(environment[name] || '').trim();
  const clientToken = read('PADDLE_CLIENT_TOKEN') || read('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN') || read('VITE_PADDLE_CLIENT_TOKEN');
  const missing = [['PADDLE_API_KEY', read('PADDLE_API_KEY')], ['PADDLE_CLIENT_TOKEN', clientToken], ['PADDLE_PRICE_ID', read('PADDLE_PRICE_ID')]]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new ConfigError(`Subscription checkout is not set up on the server (missing ${missing.join(', ')}).`);
  return {
    environment: paddleEnvironment(environment),
    apiKey: read('PADDLE_API_KEY'),
    clientToken,
    priceId: read('PADDLE_PRICE_ID'),
  };
}

// ------------------------------------------------------------------ webhook signature

// Paddle-Signature: ts=1671552777;h1=<hex>   (several h1 values while a secret is being rotated)
// h1 = HMAC-SHA256 of "<ts>:<raw body>" with the notification secret key.
export function verifyPaddleSignature({ rawBody, header, secret, now = Date.now(), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS }) {
  if (!secret || !header || typeof header !== 'string') return false;
  const parts = header.split(';').map((part) => part.trim().split('='));
  const ts = parts.find(([key]) => key === 'ts')?.[1];
  const signatures = parts.filter(([key]) => key === 'h1').map(([, value]) => value).filter(Boolean);
  if (!/^\d{9,12}$/.test(ts || '') || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSeconds) return false;

  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''));
  const expected = createHmac('sha256', secret).update(`${ts}:`).update(payload).digest();
  return signatures.some((signature) => {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  });
}

// ------------------------------------------------------------------ events

const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created', 'subscription.activated', 'subscription.trialing', 'subscription.updated',
  'subscription.past_due', 'subscription.paused', 'subscription.resumed', 'subscription.canceled',
]);

// Paddle statuses -> ours. A paid trial counts as active.
const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', paused: 'paused', canceled: 'canceled' };

const validDate = (value) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};

// Turns a Paddle notification into the arguments of apply_subscription_event, or null for events we do not act on.
export function mapPaddleEvent(event, { priceId = '' } = {}) {
  if (!event || typeof event !== 'object' || typeof event.event_id !== 'string' || typeof event.event_type !== 'string') return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  const occurredAt = validDate(event.occurred_at);
  if (!occurredAt) return null;

  // custom_data.user_id is written by our server when it creates the checkout, never taken from the browser.
  const userId = typeof data.custom_data?.user_id === 'string' && UUID.test(data.custom_data.user_id) ? data.custom_data.user_id.toLowerCase() : null;
  const base = { provider: PROVIDER, eventId: event.event_id, eventType: event.event_type, occurredAt, userId };
  const itemPrice = data.items?.[0]?.price?.id || data.items?.[0]?.price_id || null;
  const plan = itemPrice && priceId && itemPrice !== priceId ? 'other' : DEFAULT_PLAN;

  if (SUBSCRIPTION_EVENTS.has(event.event_type)) {
    const status = STATUS[data.status];
    if (!status || typeof data.id !== 'string') return null;
    return {
      ...base,
      subscriptionId: data.id,
      customerId: typeof data.customer_id === 'string' ? data.customer_id : null,
      status,
      plan,
      priceId: itemPrice,
      periodEnd: validDate(data.current_billing_period?.ends_at),
      cancelAtPeriodEnd: data.scheduled_change?.action === 'cancel',
      startedAt: validDate(data.started_at) || validDate(data.first_billed_at),
      canceledAt: status === 'canceled' ? validDate(data.canceled_at) || occurredAt : null,
    };
  }

  // A completed payment of a subscription (first payment or renewal) extends the paid period.
  if (event.event_type === 'transaction.completed' && typeof data.subscription_id === 'string') {
    return {
      ...base,
      subscriptionId: data.subscription_id,
      customerId: typeof data.customer_id === 'string' ? data.customer_id : null,
      status: 'active',
      plan,
      priceId: itemPrice,
      periodEnd: validDate(data.billing_period?.ends_at),
      cancelAtPeriodEnd: false,
      startedAt: null,
      canceledAt: null,
    };
  }
  return null;
}

export async function recordSubscriptionEvent(admin, mapped) {
  const { data, error } = await admin.rpc('apply_subscription_event', {
    p_provider: mapped.provider,
    p_event_id: mapped.eventId,
    p_event_type: mapped.eventType,
    p_occurred_at: mapped.occurredAt,
    p_user_id: mapped.userId,
    p_subscription_id: mapped.subscriptionId,
    p_customer_id: mapped.customerId,
    p_status: mapped.status,
    p_plan: mapped.plan,
    p_price_id: mapped.priceId,
    p_period_end: mapped.periodEnd,
    p_cancel_at_period_end: mapped.cancelAtPeriodEnd,
    p_started_at: mapped.startedAt,
    p_canceled_at: mapped.canceledAt,
  });
  if (error) throw error;
  return data;
}

// The whole webhook, apart from reading the request. Returns the HTTP status and body to answer with.
// 400 = not from Paddle (never retried); 500 = our database failed (Paddle retries, and the event id makes that safe).
export async function processPaddleWebhook({ rawBody, signatureHeader, secret, admin, priceId = '', now = Date.now() }) {
  if (!verifyPaddleSignature({ rawBody, header: signatureHeader, secret, now })) {
    return { status: 400, body: { error: 'Invalid Paddle signature.' } };
  }
  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    return { status: 400, body: { error: 'The notification is not valid JSON.' } };
  }
  const mapped = mapPaddleEvent(event, { priceId });
  if (!mapped) return { status: 200, body: { received: true, outcome: 'ignored' } };
  try {
    const result = await recordSubscriptionEvent(admin, mapped);
    return { status: 200, body: { received: true, outcome: result?.outcome || 'applied' } };
  } catch (error) {
    console.error('Paddle event could not be saved', mapped.eventType, error?.message);
    return { status: 500, body: { error: 'The event could not be saved.' } };
  }
}

// ------------------------------------------------------------------ Paddle API

export async function paddleRequest(path, { method = 'GET', body, config, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${API_HOSTS[config.environment]}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    console.error('Paddle could not be reached', error?.message);
    throw new HttpError(502, 'The payment service could not be reached. Try again in a moment.');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    // Only the status and Paddle's error code are logged; the free-text detail could echo a credential.
    console.error('Paddle API error', response.status, payload?.error?.code);
    throw new HttpError(502, 'The payment service refused the request. Contact support if this continues.');
  }
  return payload?.data;
}

// Creates the checkout on our server so the price and the coach it belongs to cannot be changed in the browser.
export async function createCheckoutTransaction({ userId, customerId, config, fetchImpl }) {
  const body = {
    items: [{ price_id: config.priceId, quantity: 1 }],
    custom_data: { user_id: userId },
    collection_mode: 'automatic',
    ...(customerId ? { customer_id: customerId } : {}),
  };
  const data = await paddleRequest('/transactions', { method: 'POST', body, config, fetchImpl });
  if (!data?.id || !/^txn_/.test(data.id)) throw new HttpError(502, 'The payment service returned an unexpected answer.');
  return data.id;
}

// Links to Paddle's customer portal: update the card, see invoices, cancel.
export async function createPortalLinks({ customerId, subscriptionId, config, fetchImpl }) {
  const data = await paddleRequest(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
    method: 'POST',
    body: subscriptionId ? { subscription_ids: [subscriptionId] } : {},
    config,
    fetchImpl,
  });
  const subscription = data?.urls?.subscriptions?.[0];
  const links = {
    overview: data?.urls?.general?.overview || null,
    cancel: subscription?.cancel_subscription || null,
    updatePayment: subscription?.update_subscription_payment_method || null,
  };
  if (!links.overview) throw new HttpError(502, 'The payment service returned an unexpected answer.');
  return links;
}

export function webhookSecret() {
  return env('PADDLE_WEBHOOK_SECRET');
}

export function configuredPriceId() {
  return optionalEnv('PADDLE_PRICE_ID', '').trim();
}
