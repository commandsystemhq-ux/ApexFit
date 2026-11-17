import { ConfigError } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { HttpError } from './http.js';
import { ModelError, createModelFromConfig, createModelFromEnv, envProviderConfigs } from './jackModels.js';
import { AI_PROVIDERS, PROVIDER_FIELDS, secretFieldNames, validateAiSettings } from '../../src/services/aiProviders.js';

// The platform-wide AI provider for Jack. One model serves every coach, assistant trainer and client. Only the
// platform owner can change it: either with the server's environment variables, or through the admin screen,
// which is open only to the people listed in PLATFORM_ADMIN_EMAILS. Credentials set on the admin screen are
// encrypted with TOKEN_ENCRYPTION_KEY. Everything that touches the database goes through `store`, so the rules
// here can be tested without Supabase.

// ---------------------------------------------------------------- who is the platform owner

export function platformAdminEmails(environment = process.env) {
  return (environment.PLATFORM_ADMIN_EMAILS || '')
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes('@'));
}

// The signed-in person (verified by Supabase, never taken from the request body) must have a confirmed email
// address that is listed in PLATFORM_ADMIN_EMAILS. With the list empty, nobody is a platform admin.
export function isPlatformAdmin(user, environment = process.env) {
  const email = String(user?.email || '').trim().toLowerCase();
  const confirmed = Boolean(user?.email_confirmed_at || user?.confirmed_at);
  return Boolean(email) && confirmed && platformAdminEmails(environment).includes(email);
}

export function assertPlatformAdmin(user, environment = process.env) {
  if (!isPlatformAdmin(user, environment)) throw new HttpError(403, 'Platform settings are available to the platform owner only.');
}

// ------------------------------------------------------------------- credentials at rest

function encryptionKey(environment) {
  const key = (environment.TOKEN_ENCRYPTION_KEY || '').trim();
  if (!key) throw new ConfigError('TOKEN_ENCRYPTION_KEY must be set on the server before AI credentials can be stored.');
  return key;
}

export function encryptCredentials(credentials, environment = process.env) {
  return encryptSecret(JSON.stringify(credentials), encryptionKey(environment));
}

export function decryptCredentials(payload, environment = process.env) {
  try {
    const value = JSON.parse(decryptSecret(payload, encryptionKey(environment)));
    if (value && typeof value === 'object') return value;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
  }
  throw new ConfigError('The saved AI credentials could not be read. Save them again on the AI admin screen.');
}

// A model configuration (the provider's fields plus decrypted credentials) from the stored row.
export function configFromRow(row, environment = process.env) {
  return {
    provider: row.provider,
    model: row.model || '',
    region: row.region || '',
    endpoint: row.endpoint || '',
    ...decryptCredentials(row.credentials_encrypted, environment),
  };
}

export function environmentSummary(environment = process.env) {
  const configs = envProviderConfigs(environment);
  const available = Object.fromEntries(AI_PROVIDERS.map((provider) => [provider, Boolean(configs[provider])]));
  const preferred = (environment.JACK_PROVIDER || '').trim().toLowerCase();
  const effective = preferred ? (available[preferred] ? preferred : null) : AI_PROVIDERS.find((provider) => available[provider]) || null;
  return { available, effective, canStoreCredentials: Boolean((environment.TOKEN_ENCRYPTION_KEY || '').trim()) };
}

// ---------------------------------------------------------------- the database side

// `admin` is the service-role Supabase client: the only way into platform_ai_settings.
export function createAiStore({ admin }) {
  const fail = (error) => {
    if (error) throw new Error(error.message || 'The platform AI settings could not be reached.');
  };
  return {
    async get() {
      const { data, error } = await admin.from('platform_ai_settings').select('*').eq('id', true).maybeSingle();
      fail(error);
      return data;
    },
    async save(row, userId) {
      const { error } = await admin.from('platform_ai_settings').upsert({
        id: true,
        provider: row.provider,
        model: row.model,
        region: row.region,
        endpoint: row.endpoint,
        credentials_encrypted: row.credentialsEncrypted,
        updated_at: new Date().toISOString(),
        updated_by: userId,
        last_tested_at: null,
        last_test_ok: null,
      }, { onConflict: 'id' });
      fail(error);
    },
    async clear() {
      const { error } = await admin.from('platform_ai_settings').delete().eq('id', true);
      fail(error);
    },
    async recordTest(ok) {
      const { error } = await admin.from('platform_ai_settings').update({ last_tested_at: new Date().toISOString(), last_test_ok: ok }).eq('id', true);
      fail(error);
    },
  };
}

// ------------------------------------------------------------------ the actions

// Names of the credentials already stored for this provider, without reading any value out.
function savedCredentials(row, provider, environment) {
  if (!row || row.provider !== provider) return { names: [], values: {}, unreadable: false };
  try {
    const values = decryptCredentials(row.credentials_encrypted, environment);
    return { names: Object.keys(values).filter((name) => values[name]), values, unreadable: false };
  } catch {
    return { names: [], values: {}, unreadable: true };
  }
}

async function loadView(store, environment) {
  const row = await store.get();
  const saved = row ? savedCredentials(row, row.provider, environment) : { names: [], unreadable: false };
  return {
    configured: Boolean(row),
    provider: row?.provider || null,
    model: row?.model || '',
    region: row?.region || '',
    endpoint: row?.endpoint || '',
    // Only which credentials exist; their values never leave the server.
    secrets: Object.fromEntries(saved.names.map((name) => [name, true])),
    unreadable: saved.unreadable,
    updatedAt: row?.updated_at || null,
    lastTest: row?.last_tested_at ? { at: row.last_tested_at, ok: Boolean(row.last_test_ok) } : null,
    environment: environmentSummary(environment),
  };
}

// Checks the typed fields against what is already saved. Returns either errors or the complete configuration.
function buildConfig({ provider, settings, removeSecrets = [], row, environment }) {
  if (!AI_PROVIDERS.includes(provider)) return { errors: { provider: 'aiErrProvider' } };
  const saved = savedCredentials(row, provider, environment);
  const checked = validateAiSettings(provider, settings || {}, { savedSecrets: saved.names });
  if (!checked.valid) return { errors: checked.errors };

  const secrets = secretFieldNames(provider);
  // Only optional credentials (the AWS session token) may be removed; required ones can only be replaced.
  const removable = PROVIDER_FIELDS[provider].filter((field) => field.secret && !field.required).map((field) => field.name);
  const dropped = removeSecrets.filter((name) => removable.includes(name));
  const credentials = {};
  for (const name of secrets) {
    if (checked.values[name]) credentials[name] = checked.values[name];
    else if (saved.values[name] && !dropped.includes(name)) credentials[name] = saved.values[name];
  }
  const plain = Object.fromEntries(Object.entries(checked.values).filter(([name]) => !secrets.includes(name)));
  return { config: { provider, model: '', region: '', endpoint: '', ...plain, ...credentials }, credentials, plain };
}

const TEST_TOOL = {
  name: 'ping',
  description: 'Reports that the connection works.',
  parameters: { type: 'object', properties: { value: { type: 'string', description: 'Always "pong".' } }, required: ['value'] },
};

// One plain request, then one with a tool: Jack needs tool calling, so a model that cannot do it is flagged.
export async function testModel(model) {
  const started = Date.now();
  const reply = await model.complete({
    system: 'You are a connection test. Answer with the single word OK.',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    tools: [],
  });
  const result = { ok: true, provider: model.provider, latencyMs: Date.now() - started, reply: (reply.text || '').trim().slice(0, 60), toolsOk: false, toolsNote: '' };
  try {
    const withTool = await model.complete({
      system: 'You are a connection test. Call the ping tool with value "pong". Do not answer in text.',
      messages: [{ role: 'user', content: 'Use the ping tool now.' }],
      tools: [TEST_TOOL],
    });
    result.toolsOk = (withTool.toolCalls || []).some((call) => call.name === 'ping');
    if (!result.toolsOk) result.toolsNote = 'The model answered without using the tool.';
  } catch (error) {
    result.toolsNote = error instanceof ModelError ? error.detail || error.message : 'The tool check failed.';
  }
  return result;
}

function describeFailure(error) {
  if (error instanceof ModelError) return { ok: false, status: error.status, error: error.message, detail: error.detail || '' };
  if (error instanceof ConfigError) return { ok: false, status: 400, error: error.message, detail: '' };
  throw error;
}

const removalsOf = (body) => (Array.isArray(body.removeSecrets) ? body.removeSecrets : []);

// body: { action: 'status' | 'get' | 'save' | 'test' | 'clear', provider?, settings?, removeSecrets? }
// Returns { status, body } for the route to send. Apart from 'status' (which only tells a person whether they are
// the platform owner), every action is refused for anyone else before the database is touched.
// `store` may be a function so that the database client is only created for the owner.
export async function handleAiRequest({ body = {}, user, store: storeOrFactory, environment = process.env, fetchImpl = fetch }) {
  if (body.action === 'status') return { status: 200, body: { admin: isPlatformAdmin(user, environment) } };
  assertPlatformAdmin(user, environment);
  const store = typeof storeOrFactory === 'function' ? storeOrFactory() : storeOrFactory;

  if (body.action === 'get') return { status: 200, body: await loadView(store, environment) };

  if (body.action === 'clear') {
    await store.clear();
    return { status: 200, body: await loadView(store, environment) };
  }

  if (body.action === 'save') {
    const row = await store.get();
    const built = buildConfig({ provider: body.provider, settings: body.settings, removeSecrets: removalsOf(body), row, environment });
    if (built.errors) return { status: 422, body: { error: 'Check the highlighted fields.', errors: built.errors } };
    try {
      createModelFromConfig(built.config, fetchImpl); // refuses a configuration the adapters cannot use
    } catch (error) {
      if (error instanceof ConfigError) return { status: 422, body: { error: error.message, errors: {} } };
      throw error;
    }
    await store.save({
      provider: built.config.provider,
      model: built.plain.model || null,
      region: built.plain.region || null,
      endpoint: built.plain.endpoint || null,
      credentialsEncrypted: encryptCredentials(built.credentials, environment),
    }, user.id);
    return { status: 200, body: await loadView(store, environment) };
  }

  if (body.action === 'test') {
    const row = await store.get();
    let config;
    let source = 'environment';
    if (body.provider) {
      const built = buildConfig({ provider: body.provider, settings: body.settings, removeSecrets: removalsOf(body), row, environment });
      if (built.errors) return { status: 422, body: { error: 'Check the highlighted fields.', errors: built.errors } };
      config = built.config;
      source = 'draft';
    } else if (row) {
      config = configFromRow(row, environment);
      source = 'saved';
    }

    let outcome;
    try {
      const model = config ? createModelFromConfig(config, fetchImpl) : createModelFromEnv(environment, fetchImpl);
      outcome = { ...(await testModel(model)), source };
    } catch (error) {
      outcome = { ...describeFailure(error), source, provider: config?.provider || null };
    }
    if (source === 'saved') await store.recordTest(outcome.ok).catch(() => {});
    return { status: 200, body: outcome };
  }

  throw new HttpError(400, 'Unknown action.');
}

// ------------------------------------------------------ the model Jack uses for everyone

// The platform setting (when the owner has saved one) wins; otherwise the server's environment variables are
// used. The same model serves every account. When the database cannot be read the environment is the fallback.
export async function resolveJackModel({ admin, environment = process.env, fetchImpl = fetch }) {
  let row = null;
  if (admin) {
    try {
      row = await createAiStore({ admin }).get();
    } catch (error) {
      console.error('Could not read the platform AI settings', error?.message);
    }
  }
  if (row) return { model: createModelFromConfig(configFromRow(row, environment), fetchImpl), source: 'database' };
  return { model: createModelFromEnv(environment, fetchImpl), source: 'environment' };
}
