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
  // `priceId` is one id or a list: the main price plus the per-country prices (see configuredPriceIds).
  const knownPrices = [priceId].flat().filter(Boolean);
  if (!event || typeof event !== 'object' || typeof event.event_id !== 'string' || typeof event.event_type !== 'string') return null;
  const data = event.data;
  if (!data || typeof data !== 'object') return null;
  const occurredAt = validDate(event.occurred_at);
  if (!occurredAt) return null;

  // custom_data.user_id is written by our server when it creates the checkout, never taken from the browser.
  const userId = typeof data.custom_data?.user_id === 'string' && UUID.test(data.custom_data.user_id) ? data.custom_data.user_id.toLowerCase() : null;
  const base = { provider: PROVIDER, eventId: event.event_id, eventType: event.event_type, occurredAt, userId };
  const itemPrice = data.items?.[0]?.price?.id || data.items?.[0]?.price_id || null;
  const plan = itemPrice && knownPrices.length && !knownPrices.includes(itemPrice) ? 'other' : DEFAULT_PLAN;

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
// `priceId` is the price chosen for the visitor's country; without it the main price of the coach plan is used.
export async function createCheckoutTransaction({ userId, customerId, config, fetchImpl, priceId }) {
  const body = {
    items: [{ price_id: priceId || config.priceId, quantity: 1 }],
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

// ------------------------------------------------------------------ price by country (IP / VPN)
//
// Vercel adds the visitor's country to every request (x-vercel-ip-country), so a VPN exit country changes the price too.
// Each priced country has a USD price that Paddle really charges (Paddle cannot charge in EGP, SAR or AED here) and an
// approximate local amount that is only shown. Everything can be changed in the server settings:
//   PRICING_GLOBAL_USD         price for every other country (default 39)
//   PRICING_<CC>_USD           what Paddle charges in USD for EG, SA or AE (defaults 15, 25, 25)
//   PRICING_<CC>_LOCAL         the approximate amount shown in the local currency (defaults 750 EGP, 94 SAR, 92 AED)
//   PADDLE_PRICE_ID_<CC>       a Paddle price made for that country. Without it PADDLE_PRICE_ID is used, so put the
//                              country's "unit price override" on that price in the Paddle dashboard instead.
// ?country=EG|SA|AE|US is honoured only outside production (local and preview deployments), to test every price.

export const GLOBAL_USD = 39;
export const TRIAL_DAYS = 14;

export const PRICED_COUNTRIES = {
  EG: { currency: 'EGP', usd: 15, local: 750 },
  SA: { currency: 'SAR', usd: 25, local: 94 },
  AE: { currency: 'AED', usd: 25, local: 92 },
};

const countryCode = (value) => {
  const code = String(Array.isArray(value) ? value[0] : value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

const positiveNumber = (value, fallback) => {
  const number = Number(String(value ?? '').trim());
  return Number.isFinite(number) && number > 0 ? number : fallback;
};

// Where the visitor is. Anything unknown (no header, "XX", Tor's "T1") counts as no country and gets the world price.
export function resolveCountry(req, environment = process.env) {
  const allowTestParameter = environment.VERCEL_ENV !== 'production';
  if (allowTestParameter) {
    let requested = null;
    try {
      requested = new URL(req?.url || '', 'http://localhost').searchParams.get('country');
    } catch {
      requested = null;
    }
    const code = countryCode(requested ?? req?.query?.country);
    if (code) return { country: code, source: 'query' };
  }
  const code = countryCode(req?.headers?.['x-vercel-ip-country']);
  if (code && !['XX', 'T1'].includes(code)) return { country: code, source: 'ip' };
  return { country: null, source: 'fallback' };
}

// What the page shows for a country. `usd` is what is charged; `local` (when there is one) is only an estimate.
export function pricingForCountry(country, environment = process.env) {
  const code = countryCode(country);
  const globalUsd = positiveNumber(environment.PRICING_GLOBAL_USD, GLOBAL_USD);
  const base = { trialDays: TRIAL_DAYS, globalUsd };
  const preset = code ? PRICED_COUNTRIES[code] : null;
  if (!preset) return { ...base, country: code, region: 'GLOBAL', localized: false, usd: globalUsd, local: null };
  return {
    ...base,
    country: code,
    region: code,
    localized: true,
    usd: positiveNumber(environment[`PRICING_${code}_USD`], preset.usd),
    local: { currency: preset.currency, amount: positiveNumber(environment[`PRICING_${code}_LOCAL`], preset.local), approximate: true },
  };
}

export function pricingFromRequest(req, environment = process.env) {
  const { country, source } = resolveCountry(req, environment);
  return { ...pricingForCountry(country, environment), source };
}

// The Paddle price to check out with. A country price when one is set, otherwise the main one (which can carry the
// country's override inside Paddle).
export function priceIdForCountry(country, environment = process.env) {
  const code = countryCode(country);
  const specific = code && PRICED_COUNTRIES[code] ? String(environment[`PADDLE_PRICE_ID_${code}`] || '').trim() : '';
  return specific || String(environment.PADDLE_PRICE_ID || '').trim();
}

// Every price the coach plan can be bought with, so a subscription bought at a country price is still the coach plan.
export function configuredPriceIds(environment = process.env) {
  const ids = [environment.PADDLE_PRICE_ID, ...Object.keys(PRICED_COUNTRIES).map((code) => environment[`PADDLE_PRICE_ID_${code}`])];
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}
