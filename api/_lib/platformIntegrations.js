import { adminClient } from './auth.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { HttpError } from './http.js';
import { assertPlatformAdmin, isPlatformAdmin } from './aiSettings.js';

// The keys of the connected services: Fitbit, Garmin, Oura (smart devices) and Google (Calendar). They belong to
// the platform, not to any coach or client, and only the platform owner manages them. A value saved on the admin
// screen (secret encrypted with TOKEN_ENCRYPTION_KEY) wins; the server's environment variables are the fallback.
// Everything that touches the database goes through `store`, so the rules can be tested without Supabase.

export const INTEGRATION_PROVIDERS = ['fitbit', 'garmin', 'oura', 'google'];

const ENV_NAMES = {
  fitbit: ['FITBIT_CLIENT_ID', 'FITBIT_CLIENT_SECRET'],
  garmin: ['GARMIN_CLIENT_KEY', 'GARMIN_CLIENT_SECRET'],
  oura: ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET'],
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
};

const CLIENT_ID = /^[\x21-\x7e]{4,300}$/;
const CLIENT_SECRET = /^[\x21-\x7e]{8,500}$/;

// ------------------------------------------------------------------ where the keys come from

// Values pasted into a hosting dashboard often carry spaces or quotes.
const cleanValue = (value) => String(value ?? '').trim().replace(/^["']+|["']+$/g, '').trim();

export function envCredentials(provider, environment = process.env) {
  const names = ENV_NAMES[provider];
  if (!names) return null;
  const clientId = cleanValue(environment[names[0]]);
  const clientSecret = cleanValue(environment[names[1]]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// Which of a service's variables are empty, for the platform owner's error message.
export function missingEnvNames(provider, environment = process.env) {
  return (ENV_NAMES[provider] || []).filter((name) => !cleanValue(environment[name]));
}

// The service-role database client, or null when it cannot be created (missing or malformed settings). The keys
// then come from the environment variables alone.
export function safeAdminClient() {
  try {
    return adminClient();
  } catch (error) {
    console.error('The database client is not available, using the environment variables only:', error?.message);
    return null;
  }
}

function encryptionKey(environment) {
  return (environment.TOKEN_ENCRYPTION_KEY || '').trim();
}

function fromRow(row, environment) {
  const key = encryptionKey(environment);
  if (!row || !key) return null;
  try {
    return { clientId: row.client_id, clientSecret: decryptSecret(row.client_secret_encrypted, key) };
  } catch {
    return null;
  }
}

// `admin` is the service-role Supabase client (or null when the server has none). Returns the keys and where they
// came from, or null when the service is not set up.
export async function resolveCredentials(provider, { admin, environment = process.env } = {}) {
  if (!INTEGRATION_PROVIDERS.includes(provider)) return null;
  if (admin) {
    // Anything that goes wrong here (the table does not exist yet, the query fails, the secret cannot be decrypted)
    // is logged and the environment variables are used instead. It never turns the request into a 500.
    try {
      const { data, error } = await admin.from('platform_integration_settings').select('*').eq('provider', provider).maybeSingle();
      if (error) console.error('Could not read the integration keys, using the environment variables:', error.message);
      const stored = error ? null : fromRow(data, environment);
      if (stored) return { ...stored, source: 'database' };
    } catch (error) {
      console.error('Could not read the integration keys, using the environment variables:', error?.message);
    }
  }
  const fromEnvironment = envCredentials(provider, environment);
  return fromEnvironment ? { ...fromEnvironment, source: 'environment' } : null;
}

export async function configuredProviders({ admin, environment = process.env } = {}) {
  const entries = await Promise.all(INTEGRATION_PROVIDERS.map(async (provider) => [provider, Boolean(await resolveCredentials(provider, { admin, environment }))]));
  return Object.fromEntries(entries);
}

// The address each provider must be told to send people back to.
export function redirectUriFor(provider, base) {
  return provider === 'google' ? `${base}/api/google?action=callback` : `${base}/api/wearables/${provider}?action=callback`;
}

// ------------------------------------------------------------------------ the database side

export function createIntegrationStore({ admin }) {
  const fail = (error) => {
    if (error) throw new Error(error.message || 'The integration keys could not be reached.');
  };
  return {
    async list() {
      const { data, error } = await admin.from('platform_integration_settings').select('*');
      fail(error);
      return data || [];
    },
    async save({ provider, clientId, clientSecretEncrypted }, userId) {
      const { error } = await admin.from('platform_integration_settings').upsert({
        provider,
        client_id: clientId,
        client_secret_encrypted: clientSecretEncrypted,
        updated_at: new Date().toISOString(),
        updated_by: userId,
      }, { onConflict: 'provider' });
      fail(error);
    },
    async clear(provider) {
      const { error } = await admin.from('platform_integration_settings').delete().eq('provider', provider);
      fail(error);
    },
  };
}

// ------------------------------------------------------------------------------ the actions

const baseUrl = (environment) => (environment.APP_URL || '').trim().replace(/\/+$/, '');

async function loadView(store, environment) {
  const rows = await store.list();
  const providers = INTEGRATION_PROVIDERS.map((provider) => {
    const row = rows.find((item) => item.provider === provider);
    const stored = row ? fromRow(row, environment) : null;
    const source = stored ? 'database' : envCredentials(provider, environment) ? 'environment' : 'none';
    const base = baseUrl(environment);
    return {
      provider,
      source,
      // The client ID is not a secret; the secret is never sent back.
      clientId: stored?.clientId || (source === 'environment' ? envCredentials(provider, environment).clientId : ''),
      hasSecret: source !== 'none',
      unreadable: Boolean(row) && !stored,
      updatedAt: row?.updated_at || null,
      redirectUri: base ? redirectUriFor(provider, base) : '',
    };
  });
  return { providers, canStoreCredentials: Boolean(encryptionKey(environment)), appUrlSet: Boolean(baseUrl(environment)) };
}

// body: { action: 'get' | 'save' | 'clear', provider?, clientId?, clientSecret? }
export async function handleIntegrationsRequest({ body = {}, user, store: storeOrFactory, environment = process.env }) {
  assertPlatformAdmin(user, environment);
  const store = typeof storeOrFactory === 'function' ? storeOrFactory() : storeOrFactory;

  if (body.action === 'get') return { status: 200, body: await loadView(store, environment) };

  if (body.action === 'clear') {
    if (!INTEGRATION_PROVIDERS.includes(body.provider)) return { status: 422, body: { error: 'Choose a service.', errors: { provider: 'adminIntErrProvider' } } };
    await store.clear(body.provider);
    return { status: 200, body: await loadView(store, environment) };
  }

  if (body.action === 'save') {
    if (!INTEGRATION_PROVIDERS.includes(body.provider)) return { status: 422, body: { error: 'Choose a service.', errors: { provider: 'adminIntErrProvider' } } };
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret.trim() : '';
    const rows = await store.list();
    const saved = rows.find((row) => row.provider === body.provider);
    const errors = {};
    if (!CLIENT_ID.test(clientId)) errors.clientId = clientId ? 'adminIntErrClientId' : 'aiErrRequired';
    // Leaving the secret empty keeps the stored one (only possible when one is stored).
    if (clientSecret ? !CLIENT_SECRET.test(clientSecret) : !saved) errors.clientSecret = clientSecret ? 'adminIntErrSecret' : 'aiErrRequired';
    if (Object.keys(errors).length) return { status: 422, body: { error: 'Check the highlighted fields.', errors } };

    const key = encryptionKey(environment);
    if (!key) return { status: 422, body: { error: 'TOKEN_ENCRYPTION_KEY must be set on the server before keys can be stored.', errors: {} } };
    let encrypted;
    try {
      encrypted = encryptSecret(clientSecret || decryptSecret(saved.client_secret_encrypted, key), key);
    } catch {
      return { status: 422, body: { error: 'The saved secret could not be read with the current encryption key. Enter the secret again.', errors: { clientSecret: 'adminIntErrSecret' } } };
    }
    await store.save({ provider: body.provider, clientId, clientSecretEncrypted: encrypted }, user.id);
    return { status: 200, body: await loadView(store, environment) };
  }

  throw new HttpError(400, 'Unknown action.');
}

export { isPlatformAdmin };
