import { createHash, createHmac } from 'node:crypto';
import { decryptSecret, encryptSecret } from './crypto.js';
import { addDays } from '../../src/services/healthImport.js';

// OAuth and data sync for Fitbit, Oura and Garmin. The browser never sees a token: the server exchanges the code,
// keeps the tokens encrypted with TOKEN_ENCRYPTION_KEY, refreshes them when they expire, and saves normalized
// daily numbers. Every network call goes through an injected fetch so the whole flow can be tested offline.
//
// These integrations follow each provider's public developer documentation. They have to be registered with the
// provider (client id, secret and the redirect address) and Garmin only gives access to approved partners.

export const WEARABLE_PROVIDERS = ['fitbit', 'garmin', 'oura'];
export const SYNC_DAYS = 7;
export const MIN_SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_MARGIN_MS = 60_000;

export class ProviderError extends Error {
  constructor(kind, message, status = 502) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind; // 'auth' | 'busy' | 'failed'
    this.status = status;
  }
}

const PROVIDERS = {
  fitbit: {
    label: 'Fitbit',
    idEnv: 'FITBIT_CLIENT_ID',
    secretEnv: 'FITBIT_CLIENT_SECRET',
    authorizeUrl: 'https://www.fitbit.com/oauth2/authorize',
    tokenUrl: 'https://api.fitbit.com/oauth2/token',
    revokeUrl: 'https://api.fitbit.com/oauth2/revoke',
    scope: 'activity heartrate sleep profile',
    basicAuth: true,
  },
  oura: {
    label: 'Oura',
    idEnv: 'OURA_CLIENT_ID',
    secretEnv: 'OURA_CLIENT_SECRET',
    authorizeUrl: 'https://cloud.ouraring.com/oauth/authorize',
    tokenUrl: 'https://api.ouraring.com/oauth/token',
    scope: 'personal daily heartrate',
    basicAuth: false,
  },
  garmin: {
    label: 'Garmin',
    idEnv: 'GARMIN_CLIENT_KEY',
    secretEnv: 'GARMIN_CLIENT_SECRET',
    authorizeUrl: 'https://connect.garmin.com/oauth2Confirm',
    tokenUrl: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
    scope: '',
    basicAuth: false,
    pkce: true,
  },
};

export function providerConfig(provider) {
  return PROVIDERS[provider] || null;
}

export function credentialsFor(provider, environment = process.env) {
  const config = PROVIDERS[provider];
  if (!config) return null;
  const clientId = (environment[config.idEnv] || '').trim();
  const clientSecret = (environment[config.secretEnv] || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// Which providers the server is set up for. Only true/false, never the keys themselves.
export function configuredProviders(environment = process.env) {
  return Object.fromEntries(WEARABLE_PROVIDERS.map((provider) => [provider, credentialsFor(provider, environment) !== null]));
}

// ---------------------------------------------------------------- PKCE

// The code verifier is derived from the signed state's random value, so nothing has to be stored between the
// redirect to the provider and the return.
export function pkceVerifier(nonce, base64Key) {
  return createHmac('sha256', Buffer.from(base64Key, 'base64')).update(`pkce:${nonce}`).digest('base64url');
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthorizeUrl(provider, { clientId, redirectUri, state, verifier }) {
  const config = PROVIDERS[provider];
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state });
  if (config.scope) params.set('scope', config.scope);
  if (config.pkce) {
    params.set('code_challenge', pkceChallenge(verifier));
    params.set('code_challenge_method', 'S256');
  }
  if (provider === 'fitbit') params.set('prompt', 'consent');
  return `${config.authorizeUrl}?${params.toString()}`;
}

// ------------------------------------------------------------ HTTP

async function request(fetchImpl, url, init = {}) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new ProviderError('failed', 'The provider did not respond in time.', 504);
  }
}

function failFor(response, fallback) {
  if (response.status === 401 || response.status === 403) return new ProviderError('auth', 'The provider rejected the connection. Reconnect the device.', 409);
  if (response.status === 429) return new ProviderError('busy', 'The provider is limiting requests. Try again in a few minutes.', 429);
  return new ProviderError('failed', fallback, 502);
}

async function getJson(fetchImpl, url, accessToken) {
  const response = await request(fetchImpl, url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!response.ok) {
    // Fitbit has no data for a feature the user's device does not support: treat that as "no rows".
    if (response.status === 404) return null;
    throw failFor(response, 'The provider could not return the data.');
  }
  return response.json().catch(() => null);
}

async function tokenRequest(provider, credentials, params, fetchImpl) {
  const config = PROVIDERS[provider];
  const body = new URLSearchParams({ ...params, client_id: credentials.clientId });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (config.basicAuth) headers.Authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`;
  else body.set('client_secret', credentials.clientSecret);

  const response = await request(fetchImpl, config.tokenUrl, { method: 'POST', headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const invalid = payload?.error === 'invalid_grant' || payload?.errors?.some?.((item) => item.errorType === 'invalid_grant');
    if (invalid || response.status === 400 || response.status === 401) throw new ProviderError('auth', 'The provider no longer accepts this connection. Reconnect the device.', 409);
    throw failFor(response, 'The provider could not complete the authorization.');
  }
  if (typeof payload.access_token !== 'string') throw new ProviderError('failed', 'The provider did not return an access token.');
  return {
    accessToken: payload.access_token,
    // A refresh token may be replaced on every refresh (Fitbit and Oura invalidate the old one).
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresAt: new Date(Date.now() + (Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 3600) * 1000).toISOString(),
    externalUserId: payload.user_id ? String(payload.user_id).slice(0, 100) : null,
  };
}

export function exchangeCode(provider, { code, redirectUri, verifier, credentials }, fetchImpl = fetch) {
  const params = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
  if (PROVIDERS[provider].pkce) params.code_verifier = verifier;
  return tokenRequest(provider, credentials, params, fetchImpl);
}

export function refreshTokens(provider, { refreshToken, credentials }, fetchImpl = fetch) {
  return tokenRequest(provider, credentials, { grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl);
}

// The provider's own id for the person, used only to recognise the account. Failure is not important.
export async function fetchExternalUserId(provider, accessToken, fetchImpl = fetch) {
  try {
    if (provider === 'oura') {
      const data = await getJson(fetchImpl, 'https://api.ouraring.com/v2/usercollection/personal_info', accessToken);
      return data?.id ? String(data.id).slice(0, 100) : null;
    }
    if (provider === 'garmin') {
      const data = await getJson(fetchImpl, 'https://apis.garmin.com/wellness-api/rest/user/id', accessToken);
      return data?.userId ? String(data.userId).slice(0, 100) : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function revokeAccess(provider, token, credentials, fetchImpl = fetch) {
  const config = PROVIDERS[provider];
  if (!config?.revokeUrl || !token) return;
  try {
    await request(fetchImpl, config.revokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Revoking is best effort; the stored tokens are deleted either way.
  }
}

// ----------------------------------------------------- normalizers

const number = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const whole = (value, min, max) => {
  const n = number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
};
const decimal = (value, min, max) => {
  const n = number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
};
const day = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value ?? '')) ? String(value).slice(0, 10) : null);

// Puts the per-day values of different endpoints into one row per day, dropping empty days and fields.
function assemble(partials, rawByDay = {}) {
  const days = new Map();
  for (const [date, values] of partials) {
    if (!date) continue;
    days.set(date, { ...(days.get(date) || { date }), ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined)) });
  }
  return [...days.values()]
    .filter((row) => Object.keys(row).length > 1)
    .map((row) => (rawByDay[row.date] ? { ...row, raw: rawByDay[row.date] } : row))
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function normalizeFitbit({ steps, calories, heart, sleep, hrv }) {
  const partials = [];
  for (const item of steps?.['activities-steps'] || []) partials.push([day(item.dateTime), { steps: whole(item.value, 0, 200000) }]);
  for (const item of calories?.['activities-activityCalories'] || []) partials.push([day(item.dateTime), { active_calories: whole(item.value, 0, 20000) }]);
  for (const item of heart?.['activities-heart'] || []) partials.push([day(item.dateTime), { resting_heart_rate: whole(item.value?.restingHeartRate, 20, 250) }]);
  for (const item of hrv?.hrv || []) partials.push([day(item.dateTime), { hrv_ms: decimal(item.value?.dailyRmssd, 0, 500) }]);

  const sleepByDay = new Map();
  for (const item of sleep?.sleep || []) {
    const date = day(item.dateOfSleep);
    if (!date) continue;
    sleepByDay.set(date, (sleepByDay.get(date) || 0) + (number(item.minutesAsleep) || 0));
  }
  for (const [date, minutes] of sleepByDay) partials.push([date, { sleep_minutes: whole(minutes, 1, 1440) }]);
  return assemble(partials);
}

export function normalizeOura({ activity, sleep, readiness }) {
  const partials = [];
  for (const item of activity?.data || []) partials.push([day(item.day), { steps: whole(item.steps, 0, 200000), active_calories: whole(item.active_calories, 0, 20000) }]);

  // Oura lists several sleep periods per night; the longest one is the night's sleep.
  const nights = new Map();
  for (const item of sleep?.data || []) {
    const date = day(item.day);
    if (!date || item.type === 'deleted' || item.type === 'rest') continue;
    const current = nights.get(date);
    if (!current || (number(item.total_sleep_duration) || 0) > (number(current.total_sleep_duration) || 0)) nights.set(date, item);
  }
  for (const [date, item] of nights) {
    partials.push([date, {
      sleep_minutes: whole((number(item.total_sleep_duration) || 0) / 60, 1, 1440),
      resting_heart_rate: whole(item.lowest_heart_rate, 20, 250),
      hrv_ms: decimal(item.average_hrv, 0, 500),
    }]);
  }
  for (const item of readiness?.data || []) partials.push([day(item.day), { recovery_score: whole(item.score, 0, 100) }]);
  return assemble(partials);
}

export function normalizeGarmin({ dailies, sleeps }) {
  const partials = [];
  for (const item of dailies || []) {
    partials.push([day(item.calendarDate), {
      steps: whole(item.steps, 0, 200000),
      active_calories: whole(item.activeKilocalories, 0, 20000),
      resting_heart_rate: whole(item.restingHeartRateInBeatsPerMinute, 20, 250),
    }]);
  }
  for (const item of sleeps || []) {
    const asleep = (number(item.deepSleepDurationInSeconds) || 0) + (number(item.lightSleepDurationInSeconds) || 0) + (number(item.remSleepInSeconds) || 0);
    const seconds = asleep > 0 ? asleep : number(item.durationInSeconds) || 0;
    partials.push([day(item.calendarDate), { sleep_minutes: whole(seconds / 60, 1, 1440) }]);
  }
  return assemble(partials);
}

// --------------------------------------------------------- fetching

export async function fetchProviderMetrics(provider, accessToken, { today, days = SYNC_DAYS }, fetchImpl = fetch) {
  const start = addDays(today, -(days - 1));
  const get = (url) => getJson(fetchImpl, url, accessToken);

  if (provider === 'fitbit') {
    const range = `date/${start}/${today}`;
    const [steps, calories, heart, sleep, hrv] = await Promise.all([
      get(`https://api.fitbit.com/1/user/-/activities/steps/${range}.json`),
      get(`https://api.fitbit.com/1/user/-/activities/activityCalories/${range}.json`),
      get(`https://api.fitbit.com/1/user/-/activities/heart/${range}.json`),
      get(`https://api.fitbit.com/1.2/user/-/sleep/${range}.json`),
      get(`https://api.fitbit.com/1/user/-/hrv/${range}.json`),
    ]);
    return normalizeFitbit({ steps, calories, heart, sleep, hrv });
  }

  if (provider === 'oura') {
    // Sleep periods are dated by the day they end on; ask for one extra day at the end.
    const query = `start_date=${start}&end_date=${addDays(today, 1)}`;
    const [activity, sleep, readiness] = await Promise.all([
      get(`https://api.ouraring.com/v2/usercollection/daily_activity?${query}`),
      get(`https://api.ouraring.com/v2/usercollection/sleep?${query}`),
      get(`https://api.ouraring.com/v2/usercollection/daily_readiness?${query}`),
    ]);
    return normalizeOura({ activity, sleep, readiness });
  }

  if (provider === 'garmin') {
    // The Garmin Health API returns a day's worth of uploads per request.
    const windows = Array.from({ length: days }, (_, index) => {
      const from = Date.parse(`${addDays(start, index)}T00:00:00Z`) / 1000;
      return `uploadStartTimeInSeconds=${from}&uploadEndTimeInSeconds=${from + 86_399}`;
    });
    const base = 'https://apis.garmin.com/wellness-api/rest';
    const [dailyParts, sleepParts] = await Promise.all([
      Promise.all(windows.map((window) => get(`${base}/dailies?${window}`))),
      Promise.all(windows.map((window) => get(`${base}/sleeps?${window}`))),
    ]);
    return normalizeGarmin({ dailies: dailyParts.flat().filter(Boolean), sleeps: sleepParts.flat().filter(Boolean) });
  }
  throw new ProviderError('failed', 'Unsupported provider.', 400);
}

// --------------------------------------------------------- the sync

// Refreshes the access token when it is about to expire, downloads the last days, and saves them.
// `store` is the only thing that touches the database, which keeps this function easy to test.
export async function syncWearable({ provider, connection, store, key, credentials, fetchImpl = fetch, today, force = false, now = Date.now() }) {
  if (!force && connection.last_synced_at && now - new Date(connection.last_synced_at).getTime() < MIN_SYNC_INTERVAL_MS) {
    return { throttled: true, saved: 0 };
  }

  try {
    let accessToken = connection.access_token_encrypted ? decryptSecret(connection.access_token_encrypted, key) : null;
    const expires = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0;
    if (!accessToken || expires - now < REFRESH_MARGIN_MS) {
      if (!connection.refresh_token_encrypted) throw new ProviderError('auth', 'The connection has expired. Reconnect the device.', 409);
      const tokens = await refreshTokens(provider, { refreshToken: decryptSecret(connection.refresh_token_encrypted, key), credentials }, fetchImpl);
      accessToken = tokens.accessToken;
      await store.saveTokens(connection.client_id, provider, {
        access_token_encrypted: encryptSecret(tokens.accessToken, key),
        refresh_token_encrypted: tokens.refreshToken ? encryptSecret(tokens.refreshToken, key) : connection.refresh_token_encrypted,
        token_expires_at: tokens.expiresAt,
      });
    }

    const rows = await fetchProviderMetrics(provider, accessToken, { today, days: SYNC_DAYS }, fetchImpl);
    if (rows.length > 0) await store.saveMetrics(connection.client_id, provider, rows);
    await store.markSynced(connection.client_id, provider);
    return { throttled: false, saved: rows.length };
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'auth') await store.markError(connection.client_id, provider, error.message);
    throw error;
  }
}

// The database side of the sync, using the service-role client.
export function createAdminStore(admin) {
  const fail = (error) => {
    if (error) throw error;
  };
  return {
    async saveTokens(clientId, provider, tokens) {
      const { error } = await admin.from('wearable_connections').update({ ...tokens, status: 'connected', last_error: null }).eq('client_id', clientId).eq('provider', provider);
      fail(error);
    },
    async saveMetrics(clientId, provider, rows) {
      const { error } = await admin.rpc('service_save_wearable_metrics', { p_client_id: clientId, p_provider: provider, p_metrics: rows });
      fail(error);
    },
    async markSynced(clientId, provider) {
      const { error } = await admin.from('wearable_connections').update({ status: 'connected', last_error: null, last_synced_at: new Date().toISOString() }).eq('client_id', clientId).eq('provider', provider);
      fail(error);
    },
    async markError(clientId, provider, message) {
      const { error } = await admin.from('wearable_connections').update({ status: 'error', last_error: String(message).slice(0, 300) }).eq('client_id', clientId).eq('provider', provider);
      fail(error);
    },
    async saveConnection(clientId, provider, tokens, externalUserId) {
      const { error } = await admin.from('wearable_connections').upsert({
        client_id: clientId,
        provider,
        status: 'connected',
        access_token_encrypted: tokens.access_token_encrypted,
        refresh_token_encrypted: tokens.refresh_token_encrypted,
        token_expires_at: tokens.token_expires_at,
        external_user_id: externalUserId,
        last_error: null,
      }, { onConflict: 'client_id,provider' });
      fail(error);
    },
    async getConnection(clientId, provider) {
      const { data, error } = await admin.from('wearable_connections')
        .select('client_id,provider,status,access_token_encrypted,refresh_token_encrypted,token_expires_at,last_synced_at')
        .eq('client_id', clientId).eq('provider', provider).maybeSingle();
      fail(error);
      return data;
    },
    async deleteConnection(clientId, provider) {
      const { error } = await admin.from('wearable_connections').delete().eq('client_id', clientId).eq('provider', provider);
      fail(error);
    },
  };
}

// What to tell the browser when something goes wrong.
export function describeProviderError(error) {
  if (error instanceof ProviderError) return { status: error.status, message: error.message };
  return null;
}
