import { randomBytes } from 'node:crypto';
import { adminClient, authenticate, requireRole } from '../_lib/auth.js';
import { ConfigError, appUrl, env } from '../_lib/config.js';
import { decryptSecret, encryptSecret, signState, verifyState } from '../_lib/crypto.js';
import { HttpError, handler, readJson } from '../_lib/http.js';
import { configuredProviders, resolveCredentials } from '../_lib/platformIntegrations.js';
import { getLocalToday } from '../_lib/today.js';
import {
  ProviderError, WEARABLE_PROVIDERS, buildAuthorizeUrl, createAdminStore, exchangeCode,
  fetchExternalUserId, pkceVerifier, revokeAccess, syncWearable,
} from '../_lib/wearables.js';

const redirectUri = (provider) => `${appUrl()}/api/wearables/${provider}?action=callback`;

// The keys the platform owner saved on the admin screen, else the server's environment variables.
function serviceClient() {
  try {
    return adminClient();
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

async function requireCredentials(provider) {
  const credentials = await resolveCredentials(provider, { admin: serviceClient() });
  if (!credentials) throw new HttpError(503, `${provider} is not configured on the server.`);
  return credentials;
}

function asHttpError(error) {
  if (error instanceof ProviderError) return new HttpError(error.status, error.message);
  return error;
}

async function handleCallback(req, res, provider) {
  const { code, state, error } = req.query;
  const redirect = (result) => {
    res.setHeader('Location', `${appUrl()}/integrations?wearable=${provider}&result=${result}`);
    res.status(302).end();
  };

  const payload = verifyState(state, env('TOKEN_ENCRYPTION_KEY'));
  if (!payload?.clientId || payload.provider !== provider) throw new HttpError(400, 'The authorization request has expired. Try connecting again.');
  if (error || !code) return redirect('denied');

  const key = env('TOKEN_ENCRYPTION_KEY');
  const credentials = await requireCredentials(provider);
  let tokens;
  try {
    tokens = await exchangeCode(provider, { code, redirectUri: redirectUri(provider), verifier: pkceVerifier(payload.nonce, key), credentials });
  } catch {
    return redirect('failed');
  }

  const store = createAdminStore(adminClient());
  const externalUserId = tokens.externalUserId || await fetchExternalUserId(provider, tokens.accessToken);
  await store.saveConnection(payload.clientId, provider, {
    access_token_encrypted: encryptSecret(tokens.accessToken, key),
    refresh_token_encrypted: tokens.refreshToken ? encryptSecret(tokens.refreshToken, key) : null,
    token_expires_at: tokens.expiresAt,
  }, externalUserId);

  // First download right away; if it fails the person can press "Sync now".
  try {
    const connection = await store.getConnection(payload.clientId, provider);
    await syncWearable({ provider, connection, store, key, credentials, today: getLocalToday(), force: true });
  } catch {
    return redirect('connected_nodata');
  }
  return redirect('connected');
}

async function sync({ user }, provider, body) {
  const key = env('TOKEN_ENCRYPTION_KEY');
  const credentials = await requireCredentials(provider);
  const store = createAdminStore(adminClient());
  const connection = await store.getConnection(user.id, provider);
  if (!connection) throw new HttpError(409, 'This device is not connected.');
  try {
    const result = await syncWearable({ provider, connection, store, key, credentials, today: getLocalToday(body?.today), force: false });
    return { synced: !result.throttled, throttled: result.throttled, days: result.saved };
  } catch (error) {
    throw asHttpError(error);
  }
}

async function disconnect({ user }, provider) {
  const key = env('TOKEN_ENCRYPTION_KEY');
  const store = createAdminStore(adminClient());
  const connection = await store.getConnection(user.id, provider);
  const credentials = await resolveCredentials(provider, { admin: serviceClient() });
  if (connection && credentials) {
    try {
      const token = connection.refresh_token_encrypted || connection.access_token_encrypted;
      if (token) await revokeAccess(provider, decryptSecret(token, key), credentials);
    } catch {
      // The tokens are removed below even if they could not be revoked.
    }
  }
  await store.deleteConnection(user.id, provider);
  return { disconnected: true };
}

export default handler(['GET', 'POST'], async (req, res) => {
  const provider = String(req.query.provider || '').toLowerCase();

  if (req.method === 'GET') {
    if (req.query.action !== 'callback' || !WEARABLE_PROVIDERS.includes(provider)) throw new HttpError(400, 'Unknown action.');
    return handleCallback(req, res, provider);
  }

  const context = await authenticate(req);
  await requireRole(context.userClient, 'client');
  const body = await readJson(req);

  if (provider === 'status') return res.status(200).json({ providers: await configuredProviders({ admin: serviceClient() }) });
  if (!WEARABLE_PROVIDERS.includes(provider)) throw new HttpError(404, 'Unknown device provider.');

  if (body.action === 'auth-url') {
    const credentials = await requireCredentials(provider);
    const key = env('TOKEN_ENCRYPTION_KEY');
    const nonce = randomBytes(16).toString('hex');
    const state = signState({ clientId: context.user.id, provider, nonce }, key);
    return res.status(200).json({ url: buildAuthorizeUrl(provider, { clientId: credentials.clientId, redirectUri: redirectUri(provider), state, verifier: pkceVerifier(nonce, key) }) });
  }
  if (body.action === 'sync') return res.status(200).json(await sync(context, provider, body));
  if (body.action === 'disconnect') return res.status(200).json(await disconnect(context, provider));
  throw new HttpError(400, 'Unknown action.');
});