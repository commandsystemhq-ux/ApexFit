import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PLAN, SIGNATURE_TOLERANCE_SECONDS, createCheckoutTransaction, createPortalLinks, mapPaddleEvent, paddleConfig,
  paddleEnvironment, processPaddleWebhook, verifyPaddleSignature,
} from '../api/_lib/paddle.js';
import { ConfigError } from '../api/_lib/config.js';
import { HttpError } from '../api/_lib/http.js';
import {
  checkoutOptions, describeBilling, interpretPaddleEvent, paddleLocale, waitForActive,
} from '../src/services/billingUtils.js';
import { translations } from '../src/i18n/translations.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Coach subscriptions with Paddle: the signature check, what each notification changes in the database, who may do what,
// and how the billing page describes the result.

const MIGRATION = new URL('../supabase/migrations/20261115002300_paddle_subscriptions.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000a2',
  client: '00000000-0000-4000-8000-0000000000c1',
};
const SECRET = 'pdl_ntfset_test_secret_value';
const PRICE = 'pri_01coachmonthly';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const iso = (offsetDays, from = NOW) => new Date(from + offsetDays * 86_400_000).toISOString();

// ------------------------------------------------------------------ signatures

const sign = (body, { secret = SECRET, ts = Math.floor(NOW / 1000) } = {}) => `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex')}`;

test('only a notification signed by Paddle, and recent, is accepted', () => {
  const body = '{"event_id":"evt_1"}';
  const header = sign(body);
  assert.equal(verifyPaddleSignature({ rawBody: body, header, secret: SECRET, now: NOW }), true);
  assert.equal(verifyPaddleSignature({ rawBody: Buffer.from(body), header, secret: SECRET, now: NOW }), true);

  assert.equal(verifyPaddleSignature({ rawBody: `${body} `, header, secret: SECRET, now: NOW }), false, 'changed body');
  assert.equal(verifyPaddleSignature({ rawBody: body, header: sign(body, { secret: 'other' }), secret: SECRET, now: NOW }), false, 'wrong secret');
  assert.equal(verifyPaddleSignature({ rawBody: body, header, secret: '', now: NOW }), false, 'no secret configured');
  assert.equal(verifyPaddleSignature({ rawBody: body, header: undefined, secret: SECRET, now: NOW }), false);
  assert.equal(verifyPaddleSignature({ rawBody: body, header: 'garbage', secret: SECRET, now: NOW }), false);
  assert.equal(verifyPaddleSignature({ rawBody: body, header: `ts=${Math.floor(NOW / 1000)};h1=abc`, secret: SECRET, now: NOW }), false, 'not a sha256');
  assert.equal(verifyPaddleSignature({ rawBody: body, header: `h1=${header.split('h1=')[1]}`, secret: SECRET, now: NOW }), false, 'no timestamp');

  // A recorded valid message cannot be replayed later.
  const old = sign(body, { ts: Math.floor(NOW / 1000) - SIGNATURE_TOLERANCE_SECONDS - 5 });
  assert.equal(verifyPaddleSignature({ rawBody: body, header: old, secret: SECRET, now: NOW }), false, 'replayed');
  assert.equal(verifyPaddleSignature({ rawBody: body, header: sign(body, { ts: Math.floor(NOW / 1000) - 60 }), secret: SECRET, now: NOW }), true);
  assert.equal(verifyPaddleSignature({ rawBody: body, header: sign(body, { ts: Math.floor(NOW / 1000) + 3600 }), secret: SECRET, now: NOW }), false, 'from the future');

  // While Paddle rotates a secret it sends two signatures; either one is enough.
  const rotated = `${header};h1=${'0'.repeat(64)}`;
  assert.equal(verifyPaddleSignature({ rawBody: body, header: rotated, secret: SECRET, now: NOW }), true);
});

// ------------------------------------------------------------------ mapping

const subscriptionEvent = (type, data = {}, extra = {}) => ({
  event_id: `evt_${type}_${Math.random().toString(16).slice(2)}`,
  event_type: type,
  occurred_at: iso(0),
  data: {
    id: 'sub_01',
    status: 'active',
    customer_id: 'ctm_01',
    custom_data: { user_id: ids.coach },
    items: [{ price: { id: PRICE } }],
    current_billing_period: { starts_at: iso(0), ends_at: iso(30) },
    scheduled_change: null,
    started_at: iso(0),
    canceled_at: null,
    ...data,
  },
  ...extra,
});

test('subscription notifications become the matching subscription state', () => {
  const created = mapPaddleEvent(subscriptionEvent('subscription.created'), { priceId: PRICE });
  assert.deepEqual(
    [created.status, created.subscriptionId, created.customerId, created.userId, created.plan, created.priceId, created.cancelAtPeriodEnd],
    ['active', 'sub_01', 'ctm_01', ids.coach, DEFAULT_PLAN, PRICE, false],
  );
  assert.equal(created.periodEnd, iso(30));
  assert.equal(created.startedAt, iso(0));

  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.trialing', { status: 'trialing' })).status, 'active');
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.past_due', { status: 'past_due' })).status, 'past_due');
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.paused', { status: 'paused' })).status, 'paused');
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.resumed')).status, 'active');

  const ending = mapPaddleEvent(subscriptionEvent('subscription.updated', { scheduled_change: { action: 'cancel', effective_at: iso(30) } }));
  assert.deepEqual([ending.status, ending.cancelAtPeriodEnd], ['active', true]);
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.updated', { scheduled_change: { action: 'pause', effective_at: iso(30) } })).cancelAtPeriodEnd, false);

  const canceled = mapPaddleEvent(subscriptionEvent('subscription.canceled', { status: 'canceled', canceled_at: iso(1) }));
  assert.deepEqual([canceled.status, canceled.canceledAt], ['canceled', iso(1)]);

  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.created', { items: [{ price: { id: 'pri_other' } }] }), { priceId: PRICE }).plan, 'other');
});

test('a completed payment of a subscription extends the paid period', () => {
  const renewal = mapPaddleEvent({
    event_id: 'evt_txn', event_type: 'transaction.completed', occurred_at: iso(30),
    data: { id: 'txn_01', subscription_id: 'sub_01', customer_id: 'ctm_01', custom_data: { user_id: ids.coach }, billing_period: { starts_at: iso(30), ends_at: iso(60) }, items: [{ price: { id: PRICE } }] },
  }, { priceId: PRICE });
  assert.deepEqual([renewal.status, renewal.subscriptionId, renewal.periodEnd], ['active', 'sub_01', iso(60)]);
  // A one-off payment that belongs to no subscription is not ours to act on.
  assert.equal(mapPaddleEvent({ event_id: 'e', event_type: 'transaction.completed', occurred_at: iso(0), data: { id: 'txn_02', subscription_id: null } }), null);
});

test('events we do not act on, and malformed ones, are ignored safely', () => {
  for (const type of ['customer.created', 'transaction.created', 'product.updated', 'adjustment.created']) {
    assert.equal(mapPaddleEvent(subscriptionEvent(type)), null, type);
  }
  assert.equal(mapPaddleEvent(null), null);
  assert.equal(mapPaddleEvent({}), null);
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.created', { status: 'weird' })), null);
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.created', { id: 5 })), null);
  assert.equal(mapPaddleEvent({ ...subscriptionEvent('subscription.created'), occurred_at: 'yesterday' }), null);
  // Only a well-formed id is ever passed on as the coach.
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.created', { custom_data: { user_id: "x'; drop table profiles" } })).userId, null);
  assert.equal(mapPaddleEvent(subscriptionEvent('subscription.created', { custom_data: null })).userId, null);
});

test('the webhook answers 400 to strangers, 200 to harmless messages and 500 when the database fails', async () => {
  const calls = [];
  const admin = { rpc: async (name, args) => { calls.push([name, args]); return { data: { outcome: 'applied' }, error: null }; } };
  const body = JSON.stringify(subscriptionEvent('subscription.created'));
  const good = { rawBody: Buffer.from(body), signatureHeader: sign(body), secret: SECRET, admin, priceId: PRICE, now: NOW };

  const ok = await processPaddleWebhook(good);
  assert.deepEqual([ok.status, ok.body.outcome], [200, 'applied']);
  assert.equal(calls[0][0], 'apply_subscription_event');
  assert.deepEqual([calls[0][1].p_provider, calls[0][1].p_user_id, calls[0][1].p_status, calls[0][1].p_period_end], ['paddle', ids.coach, 'active', iso(30)]);

  calls.length = 0;
  assert.equal((await processPaddleWebhook({ ...good, signatureHeader: sign(body, { secret: 'wrong' }) })).status, 400);
  assert.equal((await processPaddleWebhook({ ...good, rawBody: Buffer.from(`${body} `) })).status, 400);
  assert.equal((await processPaddleWebhook({ ...good, signatureHeader: undefined })).status, 400);
  const notJson = 'not json';
  assert.equal((await processPaddleWebhook({ ...good, rawBody: Buffer.from(notJson), signatureHeader: sign(notJson) })).status, 400);
  assert.deepEqual(calls, [], 'nothing reached the database');

  const other = JSON.stringify({ ...subscriptionEvent('customer.created') });
  const ignored = await processPaddleWebhook({ ...good, rawBody: Buffer.from(other), signatureHeader: sign(other) });
  assert.deepEqual([ignored.status, ignored.body.outcome], [200, 'ignored']);
  assert.deepEqual(calls, []);

  const broken = { rpc: async () => ({ data: null, error: new Error('db down') }) };
  assert.equal((await processPaddleWebhook({ ...good, admin: broken })).status, 500);
});

// ------------------------------------------------------------------ Paddle API

const CONFIG = { environment: 'sandbox', apiKey: 'pdl_sdbx_apikey_secret', clientToken: 'test_client_token', priceId: PRICE };

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  const requests = [];
  const impl = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return { ok, status, json: async () => payload };
  };
  impl.requests = requests;
  return impl;
}

test('the checkout is created on the server with the coach and the price fixed there', async () => {
  const fetchImpl = fakeFetch({ data: { id: 'txn_01abc' } });
  assert.equal(await createCheckoutTransaction({ userId: ids.coach, customerId: null, config: CONFIG, fetchImpl }), 'txn_01abc');
  const [request] = fetchImpl.requests;
  assert.equal(request.url, 'https://sandbox-api.paddle.com/transactions');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, `Bearer ${CONFIG.apiKey}`);
  assert.deepEqual(request.body.items, [{ price_id: PRICE, quantity: 1 }]);
  assert.deepEqual(request.body.custom_data, { user_id: ids.coach });
  assert.equal('customer_id' in request.body, false);

  const again = fakeFetch({ data: { id: 'txn_02' } });
  await createCheckoutTransaction({ userId: ids.coach, customerId: 'ctm_01', config: { ...CONFIG, environment: 'production' }, fetchImpl: again });
  assert.equal(again.requests[0].url, 'https://api.paddle.com/transactions');
  assert.equal(again.requests[0].body.customer_id, 'ctm_01');
});

test('Paddle failures become a short message that never contains the key', async () => {
  const refused = fakeFetch({ error: { code: 'forbidden', detail: `bad key ${CONFIG.apiKey}` } }, { ok: false, status: 403 });
  await assert.rejects(createCheckoutTransaction({ userId: ids.coach, config: CONFIG, fetchImpl: refused }), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 502);
    assert.ok(!error.message.includes(CONFIG.apiKey));
    return true;
  });
  await assert.rejects(createCheckoutTransaction({ userId: ids.coach, config: CONFIG, fetchImpl: async () => { throw new Error('offline'); } }), /could not be reached/);
  await assert.rejects(createCheckoutTransaction({ userId: ids.coach, config: CONFIG, fetchImpl: fakeFetch({ data: { id: 'wrong' } }) }), /unexpected answer/);
});

test('portal links are returned for the subscription', async () => {
  const fetchImpl = fakeFetch({ data: { urls: { general: { overview: 'https://portal.paddle.com/o' }, subscriptions: [{ cancel_subscription: 'https://portal.paddle.com/c', update_subscription_payment_method: 'https://portal.paddle.com/u' }] } } });
  const links = await createPortalLinks({ customerId: 'ctm_01', subscriptionId: 'sub_01', config: CONFIG, fetchImpl });
  assert.deepEqual(links, { overview: 'https://portal.paddle.com/o', cancel: 'https://portal.paddle.com/c', updatePayment: 'https://portal.paddle.com/u' });
  assert.equal(fetchImpl.requests[0].url, 'https://sandbox-api.paddle.com/customers/ctm_01/portal-sessions');
  assert.deepEqual(fetchImpl.requests[0].body, { subscription_ids: ['sub_01'] });
  await assert.rejects(createPortalLinks({ customerId: 'ctm_01', config: CONFIG, fetchImpl: fakeFetch({ data: {} }) }), /unexpected answer/);
});

test('missing Paddle settings are named, and production must be chosen on purpose', () => {
  assert.throws(() => paddleConfig({}), (error) => error instanceof ConfigError && /PADDLE_API_KEY, PADDLE_CLIENT_TOKEN, PADDLE_PRICE_ID/.test(error.message));
  const ready = { PADDLE_API_KEY: 'k', PADDLE_CLIENT_TOKEN: 't', PADDLE_PRICE_ID: PRICE };
  assert.equal(paddleConfig(ready).environment, 'sandbox');
  assert.throws(() => paddleConfig({ PADDLE_API_KEY: 'k', PADDLE_PRICE_ID: PRICE }), /missing PADDLE_CLIENT_TOKEN\)/);
  // The client token may be stored under the name Vercel and Next.js projects usually give it.
  const { PADDLE_CLIENT_TOKEN: _omit, ...withoutToken } = ready;
  assert.equal(paddleConfig({ ...withoutToken, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'live_abc' }).clientToken, 'live_abc');
  assert.equal(paddleConfig({ ...withoutToken, VITE_PADDLE_CLIENT_TOKEN: 'live_def' }).clientToken, 'live_def');
  assert.equal(paddleConfig({ ...ready, NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: 'other' }).clientToken, 't');
  assert.equal(paddleConfig({ ...ready, PADDLE_ENVIRONMENT: 'Production' }).environment, 'production');
  assert.throws(() => paddleEnvironment({ PADDLE_ENVIRONMENT: 'live' }), /sandbox or production/);
});

// ------------------------------------------------------------------ database

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; truncate public.billing_events; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'nour@example.com', role: 'coach', fullName: 'Coach Nour' });
  await addUser(db, { id: ids.client, email: 'sara@example.com', role: 'client', fullName: 'Sara' });
});

// Applies a gateway event the way the server does (as the service role).
async function apply(o = {}) {
  const args = {
    event: o.event ?? `evt_${Math.random().toString(16).slice(2)}`,
    type: o.type ?? 'subscription.updated',
    at: o.at ?? iso(0),
    user: 'user' in o ? o.user : ids.coach,
    sub: o.sub ?? 'sub_01',
    customer: o.customer ?? 'ctm_01',
    status: o.status ?? 'active',
    plan: o.plan ?? 'coach_monthly',
    price: o.price ?? PRICE,
    end: 'end' in o ? o.end : iso(30),
    cancel: o.cancel ?? false,
    started: o.started ?? iso(0),
    canceled: o.canceled ?? null,
  };
  const result = await db.query(
    'select public.apply_subscription_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) as result',
    ['paddle', args.event, args.type, args.at, args.user, args.sub, args.customer, args.status, args.plan, args.price, args.end, args.cancel, args.started, args.canceled],
  );
  return result.rows[0].result;
}
const access = async (userId = ids.coach) => (await as(userId).rpc('get_my_access_status')).data;
const subscription = async (userId = ids.coach) => (await as(userId).rpc('get_my_subscription')).data;
const endTrial = () => db.query("update public.profiles set trial_started_at = now() - interval '10 days', trial_ends_at = now() - interval '10 days' + interval '72 hours' where role = 'coach'");

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(migration);
});

test('a new subscription activates the coach, and the plan, status and end date are kept', async () => {
  await endTrial();
  assert.equal((await access()).access_state, 'expired');
  assert.equal(await subscription(), null);

  assert.equal((await apply({ type: 'subscription.created' })).outcome, 'applied');
  assert.equal((await access()).access_state, 'active');
  assert.equal((await access()).subscription_status, 'active');

  const mine = await subscription();
  assert.deepEqual(
    [mine.provider, mine.plan, mine.status, mine.cancel_at_period_end, mine.grants_access, mine.can_manage],
    ['paddle', 'coach_monthly', 'active', false, true, true],
  );
  assert.equal(new Date(mine.current_period_end).toISOString(), iso(30));
  const [row] = await rows('select * from public.coach_subscriptions');
  assert.deepEqual([row.user_id, row.provider_customer_id, row.provider_subscription_id, row.price_id], [ids.coach, 'ctm_01', 'sub_01', PRICE]);
});

test('renewals extend the period, a scheduled cancellation keeps access, and the final cancellation ends it', async () => {
  await endTrial();
  await apply({ type: 'subscription.created', at: iso(0) });

  await apply({ type: 'transaction.completed', at: iso(30), end: iso(60) });
  assert.equal(new Date((await subscription()).current_period_end).toISOString(), iso(60));

  await apply({ type: 'subscription.updated', at: iso(31), end: iso(60), cancel: true });
  const ending = await subscription();
  assert.deepEqual([ending.status, ending.cancel_at_period_end, ending.grants_access], ['active', true, true]);
  assert.equal((await access()).access_state, 'active');

  await apply({ type: 'subscription.updated', at: iso(32), end: iso(60), cancel: false });
  assert.equal((await subscription()).cancel_at_period_end, false);

  await apply({ type: 'subscription.canceled', at: iso(33), status: 'canceled', end: null, canceled: iso(33) });
  const gone = await subscription();
  assert.deepEqual([gone.status, gone.grants_access], ['canceled', false]);
  assert.equal(new Date(gone.canceled_at).toISOString(), iso(33));
  assert.equal(new Date(gone.current_period_end).toISOString(), iso(60), 'the paid-until date is kept');
  assert.equal((await access()).access_state, 'expired');
});

test('the same message twice, or an older message after a newer one, changes nothing', async () => {
  await apply({ event: 'evt_a', at: iso(0), end: iso(30) });
  assert.equal((await apply({ event: 'evt_a', at: iso(5), end: iso(99) })).outcome, 'duplicate');

  await apply({ event: 'evt_b', at: iso(10), end: iso(40) });
  assert.equal((await apply({ event: 'evt_c', at: iso(5), end: iso(35), status: 'canceled' })).outcome, 'stale');
  const mine = await subscription();
  assert.deepEqual([mine.status, new Date(mine.current_period_end).toISOString()], ['active', iso(40)]);
  assert.equal((await rows('select count(*)::int as n from public.billing_events'))[0].n, 3);
  assert.deepEqual((await rows('select outcome from public.billing_events order by event_id')).map((row) => row.outcome), ['applied', 'applied', 'stale']);
});

test('later messages find the coach by the subscription, so they need no user id', async () => {
  await apply({ type: 'subscription.created' });
  assert.equal((await apply({ user: null, at: iso(2), end: iso(60) })).outcome, 'applied');
  assert.equal(new Date((await subscription()).current_period_end).toISOString(), iso(60));
});

test('a subscription we cannot tie to a coach creates nothing', async () => {
  assert.equal((await apply({ user: null })).outcome, 'unknown_user');
  assert.equal((await apply({ user: ids.client, sub: 'sub_c', event: 'evt_client' })).outcome, 'unknown_user');
  assert.equal((await apply({ user: '00000000-0000-4000-8000-00000000ffff', sub: 'sub_x', event: 'evt_ghost' })).outcome, 'unknown_user');
  assert.equal((await rows('select count(*)::int as n from public.coach_subscriptions'))[0].n, 0);
  assert.equal((await access(ids.client)).access_state, 'client');
});

test('a second live subscription cannot replace the first, but can once the first has ended', async () => {
  await apply({ type: 'subscription.created', sub: 'sub_A', customer: 'ctm_A' });
  assert.equal((await apply({ type: 'subscription.created', sub: 'sub_B', customer: 'ctm_B' })).outcome, 'conflict');
  assert.equal((await rows('select provider_subscription_id from public.coach_subscriptions'))[0].provider_subscription_id, 'sub_A');

  await apply({ type: 'subscription.canceled', sub: 'sub_A', status: 'canceled', at: iso(1), end: iso(-1) });
  assert.equal((await apply({ type: 'subscription.created', sub: 'sub_B', customer: 'ctm_B', at: iso(2) })).outcome, 'applied');
  const mine = await subscription();
  assert.deepEqual([mine.status, mine.grants_access], ['active', true]);
  assert.equal((await rows('select provider_subscription_id from public.coach_subscriptions'))[0].provider_subscription_id, 'sub_B');
});

test('another coach cannot be given, or take over, a subscription', async () => {
  await apply({ type: 'subscription.created' });
  await apply({ type: 'subscription.created', sub: 'sub_N', user: ids.other, event: 'evt_n' });
  assert.deepEqual((await rows('select user_id, provider_subscription_id from public.coach_subscriptions order by provider_subscription_id')).map((row) => [row.user_id, row.provider_subscription_id]),
    [[ids.coach, 'sub_01'], [ids.other, 'sub_N']]);
  // Messages about sub_01 keep going to its own coach whatever user id they carry.
  await apply({ user: ids.other, sub: 'sub_01', at: iso(3), end: iso(90) });
  assert.equal(new Date((await subscription(ids.coach)).current_period_end).toISOString(), iso(90));
  assert.equal(new Date((await subscription(ids.other)).current_period_end).toISOString(), iso(30));
});

test('access follows the paid period with a 3 day allowance for a late renewal message', async () => {
  await endTrial();
  await apply({ end: iso(-2) });
  assert.equal((await access()).access_state, 'active', '2 days past the end');
  await apply({ end: iso(-4), at: iso(1) });
  assert.equal((await access()).access_state, 'expired', '4 days past the end');

  await apply({ status: 'past_due', end: iso(-1), at: iso(2) });
  assert.equal((await access()).access_state, 'active', 'payment failed yesterday: still working');
  assert.equal((await subscription()).status, 'past_due');
  await apply({ status: 'past_due', end: iso(-5), at: iso(3) });
  assert.equal((await access()).access_state, 'expired', 'payment failed days ago');

  await apply({ status: 'paused', end: iso(10), at: iso(4) });
  assert.equal((await access()).access_state, 'expired');
  assert.equal((await subscription()).grants_access, false);
});

test('the free trial still works until a subscription replaces it', async () => {
  assert.equal((await access()).access_state, 'trialing');
  await apply({ status: 'canceled', end: iso(-20) });
  assert.equal((await access()).access_state, 'trialing');
  assert.equal((await access()).subscription_status, 'canceled');
  const [{ active }] = await rows('select public.workflow_coach_is_active($1) as active', [ids.coach]);
  assert.equal(active, true);
  await endTrial();
  assert.equal((await rows('select public.workflow_coach_is_active($1) as active', [ids.coach]))[0].active, false);
  await apply({ sub: 'sub_new', event: 'evt_new', status: 'active', end: iso(30), at: iso(1) });
  assert.equal((await rows('select public.workflow_coach_is_active($1) as active', [ids.coach]))[0].active, true);
});

test('unsupported input is refused', async () => {
  await assert.rejects(apply({ status: 'refunded' }), /Unsupported subscription status/);
  await assert.rejects(db.query("update public.coach_subscriptions set provider = 'Bad Provider'"), () => true).catch(() => {});
  await apply({});
  await assert.rejects(db.query("update public.coach_subscriptions set status = 'trialing'"), /status_check/);
  await assert.rejects(db.query("update public.coach_subscriptions set provider = 'Bad Provider'"), /provider_check/);
});

test('coaches and clients cannot write billing data or call the gateway function', async () => {
  await apply({});
  const args = ['paddle', 'evt_x', 'subscription.created', iso(0), ids.other, 'sub_x', 'ctm_x', 'active', 'coach_monthly', PRICE, iso(30), false, iso(0), null];
  const call = 'select public.apply_subscription_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)';
  for (const userId of [ids.coach, ids.other, ids.client]) {
    assert.match((await as(userId).sql(call, args)).error.message, /permission denied/, userId);
  }
  const mine = as(ids.coach);
  assert.ok((await mine.sql("update public.coach_subscriptions set status = 'active', current_period_end = '2099-01-01'")).error);
  assert.ok((await mine.sql("insert into public.coach_subscriptions (user_id, status, provider) values ($1, 'active', 'paddle')", [ids.other])).error);
  assert.ok((await mine.sql('delete from public.coach_subscriptions')).error);
  assert.ok((await mine.sql('select * from public.billing_events')).error, 'event log is not readable');
  assert.ok((await mine.sql("insert into public.billing_events (provider, event_id, event_type, occurred_at) values ('p', 'e', 't', now())")).error);
});

test('the server role can read and write every table, so billing lookups are never refused', async () => {
  const tables = (await rows("select tablename from pg_tables where schemaname = 'public'")).map((row) => row.tablename);
  assert.ok(tables.includes('coach_subscriptions') && tables.includes('profiles') && tables.includes('billing_events'));
  const refused = [];
  for (const table of tables) {
    const [{ ok }] = await rows("select has_table_privilege('service_role', format('public.%I', $1::text), 'SELECT,INSERT,UPDATE,DELETE') as ok", [table]);
    if (!ok) refused.push(table);
  }
  assert.deepEqual(refused, []);
  // And a table created by a later migration is covered without another grant.
  await db.exec('create table public.zz_future_table (id int)');
  assert.equal((await rows("select has_table_privilege('service_role', 'public.zz_future_table', 'SELECT,INSERT') as ok"))[0].ok, true);
  await db.exec('drop table public.zz_future_table');
});

test('each coach sees only their own subscription, and clients none', async () => {
  await apply({});
  assert.equal((await as(ids.coach).sql('select user_id from public.coach_subscriptions')).rows.length, 1);
  assert.equal((await as(ids.other).sql('select user_id from public.coach_subscriptions')).rows.length, 0);
  assert.equal(await subscription(ids.other), null);
  assert.match((await as(ids.client).rpc('get_my_subscription')).error.message, /coach account/);
  const mine = await subscription();
  assert.deepEqual(Object.keys(mine).sort(), ['canceled_at', 'can_manage', 'cancel_at_period_end', 'current_period_end', 'grants_access', 'plan', 'provider', 'started_at', 'status'].sort());
});

// ------------------------------------------------------------------ billing page

const coach = (extra = {}) => ({ role: 'coach', access_state: 'expired', trial_ends_at: iso(-3), ...extra });

test('the billing page describes each situation and offers the right buttons', () => {
  const trial = describeBilling({ profile: coach({ access_state: 'trialing', trial_ends_at: iso(2) }), subscription: null });
  assert.deepEqual([trial.statusKey, trial.dateKey, trial.canSubscribe, trial.canManage], ['billingStatusTrial', 'billingTrialEnds', true, false]);

  const expired = describeBilling({ profile: coach(), subscription: null });
  assert.deepEqual([expired.statusKey, expired.canSubscribe, expired.canManage], ['billingStatusExpired', true, false]);

  const active = describeBilling({ profile: coach({ access_state: 'active' }), subscription: { status: 'active', cancel_at_period_end: false, current_period_end: iso(30), can_manage: true } });
  assert.deepEqual([active.statusKey, active.tone, active.dateKey, active.date, active.canSubscribe, active.canManage], ['billingStatusActive', 'good', 'billingRenewsOn', iso(30), false, true]);

  const ending = describeBilling({ profile: coach({ access_state: 'active' }), subscription: { status: 'active', cancel_at_period_end: true, current_period_end: iso(10), can_manage: true } });
  assert.deepEqual([ending.statusKey, ending.dateKey, ending.notes, ending.canSubscribe], ['billingStatusEnding', 'billingEndsOn', ['billingEndingHelp'], false]);

  const pastDue = describeBilling({ profile: coach({ access_state: 'active' }), subscription: { status: 'past_due', current_period_end: iso(-1), can_manage: true } });
  assert.deepEqual([pastDue.statusKey, pastDue.tone, pastDue.notes, pastDue.canManage, pastDue.canSubscribe], ['billingStatusPastDue', 'bad', ['billingPastDueHelp'], true, false]);

  const paused = describeBilling({ profile: coach(), subscription: { status: 'paused', current_period_end: iso(5), can_manage: true } });
  assert.deepEqual([paused.statusKey, paused.canManage, paused.canSubscribe], ['billingStatusPaused', true, false]);

  const canceled = describeBilling({ profile: coach(), subscription: { status: 'canceled', current_period_end: iso(-9), can_manage: true } });
  assert.deepEqual([canceled.statusKey, canceled.dateKey, canceled.canSubscribe], ['billingStatusCanceled', 'billingEndedOn', true]);

  const team = describeBilling({ profile: coach({ access_state: 'trainer' }), subscription: null });
  assert.deepEqual([team.statusKey, team.canSubscribe, team.canManage, team.notes], ['billingStatusTeam', false, false, ['billingTeamCovered']]);

  const client = describeBilling({ profile: { role: 'client', access_state: 'client' }, subscription: null });
  assert.deepEqual([client.canSubscribe, client.canManage], [false, false]);
  assert.equal(describeBilling({ profile: null, subscription: null }).canSubscribe, false);
});

test('checkout opens as an overlay in the user\'s language, and Paddle events are understood', () => {
  const options = checkoutOptions({ transactionId: 'txn_01', locale: 'ar-EG', email: 'amal@example.com' });
  assert.deepEqual(options.customer, { email: 'amal@example.com' });
  assert.equal(options.transactionId, 'txn_01');
  assert.deepEqual([options.settings.displayMode, options.settings.locale, options.settings.theme], ['overlay', 'ar', 'dark']);
  assert.equal('customer' in checkoutOptions({ transactionId: 'txn_01', locale: 'en' }), false);
  assert.deepEqual(['en', 'ar', 'de', 'fr', 'es', 'xx', undefined].map(paddleLocale), ['en', 'ar', 'de', 'fr', 'es', 'en', 'en']);

  assert.equal(interpretPaddleEvent({ name: 'checkout.completed' }), 'completed');
  assert.equal(interpretPaddleEvent({ name: 'checkout.closed' }), 'closed');
  assert.equal(interpretPaddleEvent({ name: 'checkout.payment.failed' }), 'error');
  assert.equal(interpretPaddleEvent({ name: 'checkout.loaded' }), null);
  assert.equal(interpretPaddleEvent(undefined), null);
});

test('after paying, the page asks again until the webhook has activated the plan', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const answers = [{ access_state: 'expired' }, new Error('network'), { access_state: 'expired' }, { access_state: 'active' }];
  let calls = 0;
  const status = await waitForActive(async () => { const next = answers[calls]; calls += 1; if (next instanceof Error) throw next; return next; }, { sleep, delayMs: 5 });
  assert.equal(status.access_state, 'active');
  assert.deepEqual([calls, sleeps.length], [4, 3]);

  calls = 0;
  assert.equal(await waitForActive(async () => { calls += 1; return { access_state: 'expired' }; }, { attempts: 3, sleep, delayMs: 1 }), null);
  assert.equal(calls, 3);
});

test('billing texts exist in every language with the same placeholders', () => {
  const keys = Object.keys(translations.en).filter((key) => /^billing(Status|Renews|Ends|Ended|Paid|Trial|Team|Ending|PastDue|Paused|Paddle|Opening|Manage|Cancel|Activat|StillActivating|CheckoutError|PortalError)/.test(key));
  assert.ok(keys.length >= 25, `${keys.length} keys`);
  for (const key of keys) for (const locale of ['ar', 'de', 'fr', 'es']) assert.ok(translations[locale][key], `${locale}.${key}`);
  assert.equal('billingProviderNotice' in translations.en, false);
  assert.match(translations.en.billingPaddleNotice, /Merchant of Record/);
});
