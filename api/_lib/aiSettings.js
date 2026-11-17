import { ConfigError } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { HttpError } from './http.js';
import { ModelError, createModelFromConfig, createModelFromEnv, envProviderConfigs } from './jackModels.js';
import { AI_PROVIDERS, PROVIDER_FIELDS, secretFieldNames, validateAiSettings } from '../../src/services/aiProviders.js';

// The coach's AI settings: who may manage them, how they are stored (credentials encrypted with
// TOKEN_ENCRYPTION_KEY), the "test connection" check, and how Jack picks the model for anyone who talks to it.
// Everything that touches the database goes through `store`, so the rules here can be tested without Supabase.

export const AI_MANAGER_STATES = ['trialing', 'active'];

// Only the account owner: a coach with a running trial or plan. Clients and assistant trainers (access state
// 'trainer') never pass. The database functions repeat this check.
export function assertCanManageAi(access) {
  if (!access || access.role !== 'coach' || !AI_MANAGER_STATES.includes(access.access_state)) {
    throw new HttpError(403, 'AI settings are available to the account owner only.');
  }
}

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
  throw new ConfigError('The saved AI credentials could not be read. The account owner must save them again in Settings.');
}

// A model configuration (the provider's fields plus decrypted credentials) from a stored row.
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

function rpcError(error) {
  if (/account owner only/i.test(error.message)) return new HttpError(403, 'AI settings are available to the account owner only.');
  return error;
}

export function createAiStore({ userClient, admin }) {
  async function call(client, name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw rpcError(error);
    return data;
  }
  return {
    view: () => call(userClient, 'get_my_ai_settings'),
    save: (row) => call(userClient, 'save_my_ai_settings', {
      p_provider: row.provider, p_model: row.model, p_region: row.region, p_endpoint: row.endpoint, p_credentials_encrypted: row.credentialsEncrypted,
    }),
    clear: () => call(userClient, 'clear_my_ai_settings'),
    recordTest: (ok) => call(userClient, 'record_my_ai_test', { p_ok: ok }),
    raw: (userId) => call(admin, 'service_get_ai_settings', { p_user: userId }),
  };
}

// ------------------------------------------------------------------ the three actions

// Names of the credentials already stored for this provider, without reading any value out.
function savedCredentials(raw, provider, environment) {
  if (!raw || raw.provider !== provider) return { names: [], values: {}, unreadable: false };
  try {
    const values = decryptCredentials(raw.credentials_encrypted, environment);
    return { names: Object.keys(values).filter((name) => values[name]), values, unreadable: false };
  } catch {
    return { names: [], values: {}, unreadable: true };
  }
}

async function loadView(store, access, environment) {
  const [view, raw] = await Promise.all([store.view(), store.raw(access.id)]);
  const saved = view.configured ? savedCredentials(raw, view.provider, environment) : { names: [], unreadable: false };
  return {
    configured: Boolean(view.configured),
    provider: view.provider || null,
    model: view.model || '',
    region: view.region || '',
    endpoint: view.endpoint || '',
    // Only which credentials exist; their values never leave the server.
    secrets: Object.fromEntries(saved.names.map((name) => [name, true])),
    unreadable: saved.unreadable,
    updatedAt: view.updated_at || null,
    lastTest: view.last_tested_at ? { at: view.last_tested_at, ok: Boolean(view.last_test_ok) } : null,
    environment: environmentSummary(environment),
  };
}

// Checks the typed fields against what is already saved. Returns either errors or the complete configuration.
async function buildConfig({ provider, settings, removeSecrets = [], raw, environment }) {
  if (!AI_PROVIDERS.includes(provider)) return { errors: { provider: 'aiErrProvider' } };
  const saved = savedCredentials(raw, provider, environment);
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

// body: { action: 'get' | 'save' | 'test' | 'clear', provider?, settings?, removeSecrets? }
// Returns { status, body } for the route to send.
export async function handleAiRequest({ body = {}, access, store, environment = process.env, fetchImpl = fetch }) {
  assertCanManageAi(access);

  if (body.action === 'get') return { status: 200, body: await loadView(store, access, environment) };

  if (body.action === 'clear') {
    await store.clear();
    return { status: 200, body: await loadView(store, access, environment) };
  }

  if (body.action === 'save') {
    const raw = await store.raw(access.id);
    const built = await buildConfig({ provider: body.provider, settings: body.settings, removeSecrets: Array.isArray(body.removeSecrets) ? body.removeSecrets : [], raw, environment });
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
    });
    return { status: 200, body: await loadView(store, access, environment) };
  }

  if (body.action === 'test') {
    const raw = await store.raw(access.id);
    let config;
    let recordResult = false;
    if (body.provider) {
      const built = await buildConfig({ provider: body.provider, settings: body.settings, removeSecrets: Array.isArray(body.removeSecrets) ? body.removeSecrets : [], raw, environment });
      if (built.errors) return { status: 422, body: { error: 'Check the highlighted fields.', errors: built.errors } };
      config = built.config;
    } else if (raw) {
      config = configFromRow(raw, environment);
      recordResult = true;
    }

    let outcome;
    try {
      const model = config ? createModelFromConfig(config, fetchImpl) : createModelFromEnv(environment, fetchImpl);
      outcome = { ...(await testModel(model)), source: config ? (recordResult ? 'saved' : 'draft') : 'environment' };
    } catch (error) {
      outcome = { ...describeFailure(error), source: config ? (recordResult ? 'saved' : 'draft') : 'environment', provider: config?.provider || null };
    }
    if (recordResult) await store.recordTest(outcome.ok).catch(() => {});
    return { status: 200, body: outcome };
  }

  throw new HttpError(400, 'Unknown action.');
}

// ------------------------------------------------------- the model Jack uses for a person

// The coach's saved provider applies to the coach, to their assistant trainers and to their clients; without
// saved settings (or when the database cannot be reached) the server's environment variables are used.
export async function resolveJackModel({ admin, userId, environment = process.env, fetchImpl = fetch }) {
  let row = null;
  if (admin) {
    const { data, error } = await admin.rpc('service_get_ai_settings', { p_user: userId });
    if (error) console.error('Could not read the AI settings', error.message);
    else row = data;
  }
  if (row) return { model: createModelFromConfig(configFromRow(row, environment), fetchImpl), source: 'database', ownerId: row.owner_id };
  return { model: createModelFromEnv(environment, fetchImpl), source: 'environment', ownerId: null };
}
