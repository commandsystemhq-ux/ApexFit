import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../api/_lib/crypto.js';
import {
  MIN_SYNC_INTERVAL_MS, ProviderError, buildAuthorizeUrl, configuredProviders, credentialsFor, exchangeCode, fetchExternalUserId,
  fetchProviderMetrics, normalizeFitbit, normalizeGarmin, normalizeOura, pkceChallenge, pkceVerifier, refreshTokens, revokeAccess, syncWearable,
} from '../api/_lib/wearables.js';

const KEY = randomBytes(32).toString('base64');
const TODAY = '2026-11-15';
const CREDENTIALS = { clientId: 'client-id', clientSecret: 'client-secret' };

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// A fetch that answers from a list of [matcher, response] pairs and remembers every call.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find(([matcher]) => (typeof matcher === 'string' ? String(url).includes(matcher) : matcher(String(url), init)));
    if (!route) return reply({}, 404);
    const response = route[1];
    return typeof response === 'function' ? response(String(url), init) : response;
  };
  impl.calls = calls;
  return impl;
}

test('providers are only offered when the server has both the id and the secret', () => {
  assert.deepEqual(configuredProviders({}), { fitbit: false, garmin: false, oura: false });
  const environment = { FITBIT_CLIENT_ID: 'a', FITBIT_CLIENT_SECRET: 'b', OURA_CLIENT_ID: 'c', GARMIN_CLIENT_KEY: 'd', GARMIN_CLIENT_SECRET: '  ' };
  assert.deepEqual(configuredProviders(environment), { fitbit: true, garmin: false, oura: false });
  assert.deepEqual(credentialsFor('fitbit', environment), { clientId: 'a', clientSecret: 'b' });
  assert.equal(credentialsFor('apple_health', environment), null);
  assert.ok(!JSON.stringify(configuredProviders(environment)).includes('"b"'), 'only booleans leave the server');
});

test('authorization links carry the state, the redirect address and PKCE where the provider needs it', () => {
  const verifier = pkceVerifier('nonce-1', KEY);
  assert.equal(verifier, pkceVerifier('nonce-1', KEY));
  assert.notEqual(verifier, pkceVerifier('nonce-2', KEY));

  const options = { clientId: 'cid', redirectUri: 'https://app.example.com/api/wearables/fitbit?action=callback', state: 'signed.state', verifier };
  const fitbit = new URL(buildAuthorizeUrl('fitbit', options));
  assert.equal(fitbit.origin + fitbit.pathname, 'https://www.fitbit.com/oauth2/authorize');
  assert.equal(fitbit.searchParams.get('client_id'), 'cid');
  assert.equal(fitbit.searchParams.get('state'), 'signed.state');
  assert.equal(fitbit.searchParams.get('redirect_uri'), options.redirectUri);
  assert.equal(fitbit.searchParams.get('code_challenge'), null);

  const garmin = new URL(buildAuthorizeUrl('garmin', options));
  assert.equal(garmin.searchParams.get('code_challenge'), pkceChallenge(verifier));
  assert.equal(garmin.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!garmin.toString().includes(verifier), 'the verifier itself is never in the link');

  assert.equal(new URL(buildAuthorizeUrl('oura', options)).searchParams.get('scope'), 'personal daily heartrate');
});

test('the code is exchanged with the right credentials and the token response is read', async () => {
  const fetchImpl = fakeFetch([['oauth2/token', reply({ access_token: 'AT', refresh_token: 'RT', expires_in: 28800, user_id: 'FB1' })]]);
  const tokens = await exchangeCode('fitbit', { code: 'abc', redirectUri: 'https://x/cb', verifier: 'v', credentials: CREDENTIALS }, fetchImpl);
  assert.deepEqual([tokens.accessToken, tokens.refreshToken, tokens.externalUserId], ['AT', 'RT', 'FB1']);
  assert.ok(Date.parse(tokens.expiresAt) > Date.now() + 28000 * 1000 - 5000);

  const [{ init }] = fetchImpl.calls;
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  const body = new URLSearchParams(init.body);
  assert.deepEqual([body.get('grant_type'), body.get('code'), body.get('client_secret')], ['authorization_code', 'abc', null]);
  assert.equal(body.get('code_verifier'), null);

  const garminFetch = fakeFetch([['diauth', reply({ access_token: 'G' })]]);
  await exchangeCode('garmin', { code: 'c', redirectUri: 'https://x/cb', verifier: 'ver', credentials: CREDENTIALS }, garminFetch);
  const garminBody = new URLSearchParams(garminFetch.calls[0].init.body);
  assert.deepEqual([garminBody.get('code_verifier'), garminBody.get('client_secret')], ['ver', 'client-secret']);
  assert.equal(garminFetch.calls[0].init.headers.Authorization, undefined);
});

test('token failures become safe errors that never contain the secrets', async () => {
  await assert.rejects(
    exchangeCode('oura', { code: 'x', redirectUri: 'u', verifier: 'v', credentials: CREDENTIALS }, fakeFetch([['oauth/token', reply({ error: 'invalid_grant' }, 400)]])),
    (error) => error instanceof ProviderError && error.kind === 'auth' && error.status === 409 && !error.message.includes('client-secret'),
  );
  await assert.rejects(refreshTokens('oura', { refreshToken: 'r', credentials: CREDENTIALS }, fakeFetch([['oauth/token', reply({}, 500)]])), (error) => error.kind === 'failed');
  await assert.rejects(refreshTokens('oura', { refreshToken: 'r', credentials: CREDENTIALS }, fakeFetch([['oauth/token', reply({ nothing: true })]])), /access token/);
  await assert.rejects(exchangeCode('oura', { code: 'x', redirectUri: 'u', verifier: 'v', credentials: CREDENTIALS }, async () => { throw new Error('socket hang up with secret client-secret'); }),
    (error) => error.kind === 'failed' && !error.message.includes('client-secret'));
});

test('the provider account id and revocation never throw', async () => {
  assert.equal(await fetchExternalUserId('oura', 'AT', fakeFetch([['personal_info', reply({ id: 'oura-user' })]])), 'oura-user');
  assert.equal(await fetchExternalUserId('oura', 'AT', fakeFetch([['personal_info', reply({}, 500)]])), null);
  assert.equal(await fetchExternalUserId('fitbit', 'AT', fakeFetch([])), null);
  const revoke = fakeFetch([['revoke', reply({}, 200)]]);
  await revokeAccess('fitbit', 'RT', CREDENTIALS, revoke);
  assert.equal(revoke.calls.length, 1);
  await revokeAccess('fitbit', 'RT', CREDENTIALS, async () => { throw new Error('offline'); });
  await revokeAccess('oura', 'RT', CREDENTIALS, fakeFetch([]));
});

test('Fitbit data is normalized per day with sleep summed and bad values dropped', () => {
  const rows = normalizeFitbit({
    steps: { 'activities-steps': [{ dateTime: '2026-11-14', value: '8000' }, { dateTime: '2026-11-15', value: '300000' }] },
    calories: { 'activities-activityCalories': [{ dateTime: '2026-11-14', value: '450' }] },
    heart: { 'activities-heart': [{ dateTime: '2026-11-14', value: { restingHeartRate: 57 } }, { dateTime: '2026-11-15', value: {} }] },
    sleep: { sleep: [{ dateOfSleep: '2026-11-14', minutesAsleep: 300 }, { dateOfSleep: '2026-11-14', minutesAsleep: 120 }] },
    hrv: { hrv: [{ dateTime: '2026-11-14', value: { dailyRmssd: 42.456 } }] },
  });
  assert.deepEqual(rows, [{ date: '2026-11-14', steps: 8000, active_calories: 450, resting_heart_rate: 57, hrv_ms: 42.46, sleep_minutes: 420 }]);
  assert.deepEqual(normalizeFitbit({}), []);
});

test('Oura data keeps the longest sleep of a night and ignores deleted or rest periods', () => {
  const rows = normalizeOura({
    activity: { data: [{ day: '2026-11-14', steps: 7000, active_calories: 350 }] },
    sleep: {
      data: [
        { day: '2026-11-14', type: 'long_sleep', total_sleep_duration: 27000, lowest_heart_rate: 50, average_hrv: 61.5 },
        { day: '2026-11-14', type: 'late_nap', total_sleep_duration: 1800, lowest_heart_rate: 70, average_hrv: 20 },
        { day: '2026-11-14', type: 'deleted', total_sleep_duration: 99999, lowest_heart_rate: 40 },
        { day: '2026-11-13', type: 'rest', total_sleep_duration: 3000 },
      ],
    },
    readiness: { data: [{ day: '2026-11-14', score: 84 }, { day: '2026-11-13', score: 120 }] },
  });
  assert.deepEqual(rows, [{ date: '2026-11-14', steps: 7000, active_calories: 350, sleep_minutes: 450, resting_heart_rate: 50, hrv_ms: 61.5, recovery_score: 84 }]);
});

test('Garmin data uses the sleep stages, or the whole duration when stages are missing', () => {
  const rows = normalizeGarmin({
    dailies: [{ calendarDate: '2026-11-14', steps: 9100, activeKilocalories: 520, restingHeartRateInBeatsPerMinute: 54 }],
    sleeps: [
      { calendarDate: '2026-11-14', deepSleepDurationInSeconds: 3600, lightSleepDurationInSeconds: 14400, remSleepInSeconds: 3600, durationInSeconds: 30000 },
      { calendarDate: '2026-11-13', durationInSeconds: 21600 },
    ],
  });
  assert.deepEqual(rows, [{ date: '2026-11-13', sleep_minutes: 360 }, { date: '2026-11-14', steps: 9100, active_calories: 520, resting_heart_rate: 54, sleep_minutes: 360 }]);
});

test('fetching Oura data asks for the right dates and sends the access token', async () => {
  const fetchImpl = fakeFetch([
    ['daily_activity', reply({ data: [{ day: '2026-11-14', steps: 5000, active_calories: 200 }] })],
    ['usercollection/sleep', reply({ data: [] })],
    ['daily_readiness', reply({ data: [{ day: '2026-11-14', score: 70 }] })],
  ]);
  const rows = await fetchProviderMetrics('oura', 'AT', { today: TODAY }, fetchImpl);
  assert.deepEqual(rows, [{ date: '2026-11-14', steps: 5000, active_calories: 200, recovery_score: 70 }]);
  assert.equal(fetchImpl.calls.length, 3);
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer AT');
    assert.match(call.url, /start_date=2026-11-09&end_date=2026-11-16/);
  }
});

test('Fitbit treats a feature the device lacks as no data, and other errors as failures', async () => {
  const lacking = fakeFetch([['activities/steps', reply({ 'activities-steps': [{ dateTime: '2026-11-14', value: '100' }] })]]);
  assert.deepEqual(await fetchProviderMetrics('fitbit', 'AT', { today: TODAY }, lacking), [{ date: '2026-11-14', steps: 100 }]);
  await assert.rejects(fetchProviderMetrics('fitbit', 'AT', { today: TODAY }, fakeFetch([['', reply({}, 401)]])), (error) => error.kind === 'auth');
  await assert.rejects(fetchProviderMetrics('fitbit', 'AT', { today: TODAY }, fakeFetch([['', reply({}, 429)]])), (error) => error.kind === 'busy' && error.status === 429);
  await assert.rejects(fetchProviderMetrics('whoop', 'AT', { today: TODAY }, fakeFetch([])), /Unsupported/);
});

// ---------------------------------------------------------------------- the sync

function memoryStore() {
  const calls = [];
  return {
    calls,
    saveTokens: async (...args) => calls.push(['saveTokens', ...args]),
    saveMetrics: async (...args) => calls.push(['saveMetrics', ...args]),
    markSynced: async (...args) => calls.push(['markSynced', ...args]),
    markError: async (...args) => calls.push(['markError', ...args]),
  };
}

const connection = (overrides = {}) => ({
  client_id: 'client-1',
  provider: 'oura',
  access_token_encrypted: encryptSecret('AT-old', KEY),
  refresh_token_encrypted: encryptSecret('RT-old', KEY),
  token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  last_synced_at: null,
  ...overrides,
});

const ouraRoutes = [
  ['daily_activity', reply({ data: [{ day: '2026-11-14', steps: 5000, active_calories: 200 }] })],
  ['usercollection/sleep', reply({ data: [] })],
  ['daily_readiness', reply({ data: [] })],
];

test('a sync downloads the last days, saves them for the right client and marks the connection', async () => {
  const store = memoryStore();
  const fetchImpl = fakeFetch(ouraRoutes);
  const result = await syncWearable({ provider: 'oura', connection: connection(), store, key: KEY, credentials: CREDENTIALS, fetchImpl, today: TODAY });
  assert.deepEqual(result, { throttled: false, saved: 1 });
  assert.deepEqual(store.calls.map((call) => call[0]), ['saveMetrics', 'markSynced']);
  assert.deepEqual(store.calls[0].slice(1), ['client-1', 'oura', [{ date: '2026-11-14', steps: 5000, active_calories: 200 }]]);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer AT-old');
});

test('syncing again within a minute does nothing; forcing it does not wait', async () => {
  const store = memoryStore();
  const fetchImpl = fakeFetch(ouraRoutes);
  const now = Date.now();
  const recent = connection({ last_synced_at: new Date(now - MIN_SYNC_INTERVAL_MS + 5000).toISOString() });
  assert.deepEqual(await syncWearable({ provider: 'oura', connection: recent, store, key: KEY, credentials: CREDENTIALS, fetchImpl, today: TODAY, now }), { throttled: true, saved: 0 });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(store.calls.length, 0);
  const forced = await syncWearable({ provider: 'oura', connection: recent, store, key: KEY, credentials: CREDENTIALS, fetchImpl, today: TODAY, now, force: true });
  assert.equal(forced.throttled, false);
  const older = connection({ last_synced_at: new Date(now - MIN_SYNC_INTERVAL_MS - 1000).toISOString() });
  assert.equal((await syncWearable({ provider: 'oura', connection: older, store, key: KEY, credentials: CREDENTIALS, fetchImpl, today: TODAY, now })).throttled, false);
});

test('an expired token is refreshed first and the new tokens are stored encrypted', async () => {
  const store = memoryStore();
  const fetchImpl = fakeFetch([['oauth/token', reply({ access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600 })], ...ouraRoutes]);
  const expired = connection({ token_expires_at: new Date(Date.now() - 1000).toISOString() });
  await syncWearable({ provider: 'oura', connection: expired, store, key: KEY, credentials: CREDENTIALS, fetchImpl, today: TODAY });

  const [kind, clientId, provider, tokens] = store.calls[0];
  assert.deepEqual([kind, clientId, provider], ['saveTokens', 'client-1', 'oura']);
  assert.equal(decryptSecret(tokens.access_token_encrypted, KEY), 'AT-new');
  assert.equal(decryptSecret(tokens.refresh_token_encrypted, KEY), 'RT-new');
  assert.ok(!JSON.stringify(tokens).includes('AT-new'));
  const dataCall = fetchImpl.calls.find((call) => call.url.includes('daily_activity'));
  assert.equal(dataCall.init.headers.Authorization, 'Bearer AT-new');
  const refreshBody = new URLSearchParams(fetchImpl.calls[0].init.body);
  assert.deepEqual([refreshBody.get('grant_type'), refreshBody.get('refresh_token')], ['refresh_token', 'RT-old']);
});

test('when a refresh keeps the old refresh token it is not lost', async () => {
  const store = memoryStore();
  const fetchImpl = fakeFetch([['oauth/token', reply({ access_token: 'AT-new', expires_in: 3600 })], ...ouraRoutes]);
  const old = connection({ token_expires_at: new Date(Date.now() - 1000).toISOString() });
  await syncWearable({ provider: 'oura', connection: old, store, key: KEY, credentials: CREDENTIALS, fetchImpl, today: TODAY });
  assert.equal(store.calls[0][3].refresh_token_encrypted, old.refresh_token_encrypted);
});

test('a rejected connection is marked as needing attention, other failures are not', async () => {
  const store = memoryStore();
  const expired = connection({ token_expires_at: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(
    syncWearable({ provider: 'oura', connection: expired, store, key: KEY, credentials: CREDENTIALS, fetchImpl: fakeFetch([['oauth/token', reply({ error: 'invalid_grant' }, 400)]]), today: TODAY }),
    (error) => error.kind === 'auth',
  );
  assert.deepEqual(store.calls.map((call) => call[0]), ['markError']);
  assert.match(store.calls[0][3], /Reconnect/);

  const noRefresh = connection({ token_expires_at: new Date(Date.now() - 1000).toISOString(), refresh_token_encrypted: null });
  const second = memoryStore();
  await assert.rejects(syncWearable({ provider: 'oura', connection: noRefresh, store: second, key: KEY, credentials: CREDENTIALS, fetchImpl: fakeFetch([]), today: TODAY }), /Reconnect/);
  assert.equal(second.calls[0][0], 'markError');

  const busy = memoryStore();
  await assert.rejects(syncWearable({ provider: 'oura', connection: connection(), store: busy, key: KEY, credentials: CREDENTIALS, fetchImpl: fakeFetch([['', reply({}, 500)]]), today: TODAY }), (error) => error.kind === 'failed');
  assert.equal(busy.calls.length, 0, 'a provider outage does not break the connection');
});

test('a sync with no new rows still marks the connection as synced', async () => {
  const store = memoryStore();
  const empty = fakeFetch([['daily_activity', reply({ data: [] })], ['usercollection/sleep', reply({ data: [] })], ['daily_readiness', reply({ data: [] })]]);
  assert.deepEqual(await syncWearable({ provider: 'oura', connection: connection(), store, key: KEY, credentials: CREDENTIALS, fetchImpl: empty, today: TODAY }), { throttled: false, saved: 0 });
  assert.deepEqual(store.calls.map((call) => call[0]), ['markSynced']);
});
