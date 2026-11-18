import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigError, appUrl, normalizeAppUrl } from '../api/_lib/config.js';
import { encryptSecret, signState, verifyState } from '../api/_lib/crypto.js';
import { HttpError, handler } from '../api/_lib/http.js';
import { googleCredentials, googleRedirectUri, startGoogleAuthorization } from '../api/_lib/googleAuth.js';
import { describeUnexpected, explainForOwner, redactSecrets, withOwnerDiagnostics } from '../api/_lib/ownerDiagnostics.js';
import { envCredentials, missingEnvNames, resolveCredentials, safeAdminClient } from '../api/_lib/platformIntegrations.js';

// Starting the Google Calendar connection must never end in a bare "Unexpected server error": every setup problem
// is a clear message, the platform owner sees the real reason, and unreadable saved keys fall back to the environment.

const KEY = randomBytes(32).toString('base64');
const OWNER = { id: 'owner-1', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const COACH = { id: 'coach-1', email: 'coach@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const ENVIRONMENT = {
  APP_URL: 'https://app.example.com',
  TOKEN_ENCRYPTION_KEY: KEY,
  GOOGLE_CLIENT_ID: 'env-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'GOCSPX-env-secret-value',
  PLATFORM_ADMIN_EMAILS: 'owner@example.com',
};

// A service-role client whose query answers however the test says.
function adminReturning(result) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (typeof result === 'function' ? result() : result) }) }) }) };
}
const savedRow = (secret = 'saved-secret-value-1', key = KEY) => ({ provider: 'google', client_id: 'saved-client-id', client_secret_encrypted: encryptSecret(secret, key) });

// Quiet the expected log lines of the failures under test.
function silenced(work) {
  return async () => {
    const original = console.error;
    console.error = () => {};
    try {
      await work();
    } finally {
      console.error = original;
    }
  };
}

// ----------------------------------------------------------------- the site address

test('APP_URL is cleaned of spaces, quotes and trailing slashes, and a bad one is explained', () => {
  for (const [input, expected] of [
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com/', 'https://app.example.com'],
    ['https://app.example.com///', 'https://app.example.com'],
    ['  https://app.example.com/  ', 'https://app.example.com'],
    ['"https://app.example.com/"', 'https://app.example.com'],
    ["'https://app.example.com'", 'https://app.example.com'],
    ['https://APP.example.com/', 'https://app.example.com'],
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['https://example.com/apexfit/', 'https://example.com/apexfit'],
  ]) assert.equal(normalizeAppUrl(input), expected, JSON.stringify(input));
  assert.equal(normalizeAppUrl(''), '');
  assert.equal(normalizeAppUrl(undefined), '');
  for (const bad of ['app.example.com', 'ftp://app.example.com', 'https://', 'not a url', 'https://app.example.com?x=1', 'https://app.example.com/#top']) assert.equal(normalizeAppUrl(bad), null, bad);

  assert.equal(appUrl({ APP_URL: 'https://app.example.com//' }), 'https://app.example.com');
  assert.throws(() => appUrl({}), (error) => error instanceof ConfigError && /APP_URL is not configured/.test(error.message) && /https:\/\/your-app/.test(error.message));
  assert.throws(() => appUrl({ APP_URL: '   ' }), /APP_URL is not configured/);
  assert.throws(() => appUrl({ APP_URL: 'app.example.com' }), (error) => error instanceof ConfigError && /not a valid web address/.test(error.message));
  assert.equal(googleRedirectUri({ APP_URL: 'https://app.example.com/' }), 'https://app.example.com/api/google?action=callback');
});

// -------------------------------------------------------- reading the saved keys safely

test('the saved keys win when they are readable', async () => {
  const result = await resolveCredentials('google', { admin: adminReturning({ data: savedRow(), error: null }), environment: ENVIRONMENT });
  assert.deepEqual(result, { clientId: 'saved-client-id', clientSecret: 'saved-secret-value-1', source: 'database' });
});

test('every way reading the saved keys can fail falls back to GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET', silenced(async () => {
  const expected = { clientId: 'env-client-id.apps.googleusercontent.com', clientSecret: 'GOCSPX-env-secret-value', source: 'environment' };
  const failures = {
    'the table does not exist yet': adminReturning({ data: null, error: { message: 'relation "public.platform_integration_settings" does not exist', code: '42P01' } }),
    'the table is not in the API schema cache': adminReturning({ data: null, error: { message: 'Could not find the table \'public.platform_integration_settings\' in the schema cache' } }),
    'permission is denied': adminReturning({ data: null, error: { message: 'permission denied for table platform_integration_settings' } }),
    'the query throws': adminReturning(() => { throw new Error('socket hang up'); }),
    'the query rejects': adminReturning(() => Promise.reject(new TypeError('fetch failed'))),
    'the client itself throws': { from: () => { throw new Error('client is broken'); } },
    'no client can be created': null,
    'there is no row': adminReturning({ data: null, error: null }),
    'the secret is garbage': adminReturning({ data: { provider: 'google', client_id: 'x', client_secret_encrypted: 'garbage' }, error: null }),
    'the secret needs another encryption key': adminReturning({ data: savedRow('s', randomBytes(32).toString('base64')), error: null }),
    'the row is empty': adminReturning({ data: {}, error: null }),
  };
  for (const [reason, admin] of Object.entries(failures)) {
    assert.deepEqual(await resolveCredentials('google', { admin, environment: ENVIRONMENT }), expected, reason);
  }
  // Without the encryption key a saved secret cannot be read either.
  const noKey = { ...ENVIRONMENT, TOKEN_ENCRYPTION_KEY: '' };
  assert.equal((await resolveCredentials('google', { admin: adminReturning({ data: savedRow(), error: null }), environment: noKey })).source, 'environment');
}));

test('with nothing saved and nothing in the environment there are no keys, and the owner is told exactly what is missing', silenced(async () => {
  const failing = adminReturning({ data: null, error: { message: 'relation does not exist' } });
  assert.equal(await resolveCredentials('google', { admin: failing, environment: {} }), null);

  const missingBoth = await googleCredentials({ admin: failing, environment: { APP_URL: 'https://a.example.com' } }).catch((error) => error);
  assert.ok(missingBoth instanceof HttpError);
  assert.equal(missingBoth.status, 503);
  assert.equal(missingBoth.message, 'Google Calendar is not configured on the server.', 'everyone else gets the short message');
  assert.match(missingBoth.ownerDetail, /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing/);
  assert.match(missingBoth.ownerDetail, /\/admin\/integrations/);

  const onlyId = await googleCredentials({ admin: null, environment: { GOOGLE_CLIENT_ID: 'id-only-12345' } }).catch((error) => error);
  assert.match(onlyId.ownerDetail, /GOOGLE_CLIENT_SECRET is missing/);
  assert.doesNotMatch(onlyId.ownerDetail, /GOOGLE_CLIENT_ID/);
  assert.deepEqual(missingEnvNames('google', { GOOGLE_CLIENT_ID: 'a' }), ['GOOGLE_CLIENT_SECRET']);
  assert.deepEqual(missingEnvNames('google', {}), ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
}));

test('values pasted with quotes or spaces still work, and a half-set pair is not used', () => {
  assert.deepEqual(envCredentials('google', { GOOGLE_CLIENT_ID: ' "abc-123" ', GOOGLE_CLIENT_SECRET: "'GOCSPX-xyz' " }), { clientId: 'abc-123', clientSecret: 'GOCSPX-xyz' });
  assert.equal(envCredentials('google', { GOOGLE_CLIENT_ID: 'abc', GOOGLE_CLIENT_SECRET: '""' }), null);
  assert.equal(envCredentials('mystery', ENVIRONMENT), null);
});

test('a database client that cannot be created is not fatal', silenced(async () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, vite: process.env.VITE_SUPABASE_URL };
  try {
    process.env.SUPABASE_URL = 'this is not a url';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-value';
    assert.equal(safeAdminClient(), null, 'a malformed URL');
    delete process.env.SUPABASE_URL;
    delete process.env.VITE_SUPABASE_URL;
    assert.equal(safeAdminClient(), null, 'missing settings');
  } finally {
    for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_SERVICE_ROLE_KEY', saved.key], ['VITE_SUPABASE_URL', saved.vite]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}));

// ------------------------------------------------------ starting the connection

test('the connection starts with the environment variables when the saved keys cannot be read', silenced(async () => {
  const broken = adminReturning({ data: null, error: { message: 'relation "public.platform_integration_settings" does not exist' } });
  const { url, redirectUri, source } = await startGoogleAuthorization({ userId: 'coach-1', returnTo: 'schedule', admin: broken, environment: { ...ENVIRONMENT, APP_URL: ' "https://app.example.com//" ' } });
  const target = new URL(url);
  assert.equal(`${target.origin}${target.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(target.searchParams.get('client_id'), 'env-client-id.apps.googleusercontent.com');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://app.example.com/api/google?action=callback', 'no doubled slash, no quotes');
  assert.equal(redirectUri, 'https://app.example.com/api/google?action=callback');
  assert.equal(source, 'environment');
  assert.equal(target.searchParams.get('access_type'), 'offline');
  assert.ok(!url.includes(ENVIRONMENT.GOOGLE_CLIENT_SECRET), 'the secret never goes into the address');

  const state = verifyState(target.searchParams.get('state'), KEY);
  assert.deepEqual([state.userId, state.returnTo], ['coach-1', 'schedule']);
}));

test('the saved keys are used for the connection when they are readable, and the return page is limited to known pages', async () => {
  const admin = adminReturning({ data: savedRow(), error: null });
  const started = await startGoogleAuthorization({ userId: 'sara', returnTo: 'checklist', admin, environment: ENVIRONMENT });
  assert.equal(new URL(started.url).searchParams.get('client_id'), 'saved-client-id');
  assert.equal(started.source, 'database');
  assert.equal(verifyState(new URL(started.url).searchParams.get('state'), KEY).returnTo, 'checklist');
  for (const returnTo of ['https://evil.example.com', '/etc/passwd', undefined, 'admin']) {
    const other = await startGoogleAuthorization({ userId: 'sara', returnTo, admin, environment: ENVIRONMENT });
    assert.equal(verifyState(new URL(other.url).searchParams.get('state'), KEY).returnTo, 'schedule', String(returnTo));
  }
});

test('each missing setting is reported on its own, in plain words', silenced(async () => {
  const run = (environment) => startGoogleAuthorization({ userId: 'u', admin: null, environment }).catch((error) => error);

  const noUrl = await run({ ...ENVIRONMENT, APP_URL: '' });
  assert.ok(noUrl instanceof ConfigError);
  assert.match(noUrl.message, /APP_URL is not configured/);
  assert.match((await run({ ...ENVIRONMENT, APP_URL: 'my site' })).message, /APP_URL is not a valid web address/);

  const noId = await run({ ...ENVIRONMENT, GOOGLE_CLIENT_ID: '' });
  assert.ok(noId instanceof HttpError && noId.status === 503);
  assert.match(noId.ownerDetail, /GOOGLE_CLIENT_ID is missing/);

  const noSecret = await run({ ...ENVIRONMENT, GOOGLE_CLIENT_SECRET: '' });
  assert.match(noSecret.ownerDetail, /GOOGLE_CLIENT_SECRET is missing/);

  const noKey = await run({ ...ENVIRONMENT, TOKEN_ENCRYPTION_KEY: '' });
  assert.ok(noKey instanceof ConfigError);
  assert.match(noKey.message, /TOKEN_ENCRYPTION_KEY is not configured/);

  for (const bad of ['short', 'not-base64-at-all!!', randomBytes(16).toString('base64'), randomBytes(48).toString('base64')]) {
    const wrongKey = await run({ ...ENVIRONMENT, TOKEN_ENCRYPTION_KEY: bad });
    assert.ok(wrongKey instanceof ConfigError, `${bad}: a setup message, not a crash`);
    assert.match(wrongKey.message, /TOKEN_ENCRYPTION_KEY must be 32 bytes/);
  }
}));

test('a malformed encryption key is a clear 503 for everybody, not a 500', () => {
  assert.throws(() => signState({ a: 1 }, 'short'), (error) => error instanceof ConfigError && /32 bytes/.test(error.message));
  assert.throws(() => encryptSecret('x', ''), ConfigError);
  assert.throws(() => verifyState('a.b', 'short'), ConfigError);
});

// ----------------------------------------------------- what the platform owner is shown

async function respond(route, error) {
  const captured = { status: 0, body: null, headers: {} };
  const res = {
    headersSent: false,
    setHeader: () => {},
    status(code) { captured.status = code; return res; },
    json(body) { captured.body = body; return res; },
  };
  await handler(['POST'], async () => { throw error; })({ method: 'POST', ...route }, res);
  return captured;
}

test('an unexpected failure shows the owner the real reason and everyone else the generic message', silenced(async () => {
  const failure = new Error('Cannot read properties of undefined (reading \'data\')');
  failure.name = 'TypeError';

  const forOwner = await respond({}, explainForOwner(failure, OWNER, ENVIRONMENT));
  assert.equal(forOwner.status, 500);
  assert.equal(forOwner.body.error, 'Server error. TypeError: Cannot read properties of undefined (reading \'data\')');

  for (const person of [COACH, { id: 'x', email: 'owner@example.com', email_confirmed_at: null }, null, undefined]) {
    const forOthers = await respond({}, explainForOwner(failure, person, ENVIRONMENT));
    assert.deepEqual([forOthers.status, forOthers.body.error], [500, 'Unexpected server error.'], JSON.stringify(person));
  }
  assert.deepEqual((await respond({}, failure)).body, { error: 'Unexpected server error.' }, 'a route that does not use the helper still hides it');
}));

test('the owner\'s message names the cause and what to do, and never contains a secret', silenced(async () => {
  const env = { ...ENVIRONMENT, SUPABASE_SERVICE_ROLE_KEY: 'sb-service-role-key-abcdef123456' };
  const leaky = new Error(`request failed with key sb-service-role-key-abcdef123456 and secret ${ENVIRONMENT.GOOGLE_CLIENT_SECRET} and Bearer abcdefghijklmnop12345 client_secret=hunter22222 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456`);
  const text = describeUnexpected(leaky, env);
  for (const secret of ['sb-service-role-key-abcdef123456', ENVIRONMENT.GOOGLE_CLIENT_SECRET, 'abcdefghijklmnop12345', 'hunter22222', 'eyJhbGciOiJIUzI1NiJ9', KEY]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /\[SUPABASE_SERVICE_ROLE_KEY\]/);
  assert.match(redactSecrets(`key=${KEY}`, env), /\[TOKEN_ENCRYPTION_KEY\]/);
  assert.equal(redactSecrets('abc', { TOKEN_ENCRYPTION_KEY: 'abc' }), 'abc', 'very short values are not treated as secrets');

  assert.match(describeUnexpected(new Error('relation "public.google_calendar_connections" does not exist')), /Run the latest supabase\/manual-setup\.sql/);
  assert.match(describeUnexpected(new Error('permission denied for table x')), /service_role key/);
  assert.match(describeUnexpected(new TypeError('fetch failed')), /could not reach another service/);
  assert.ok(describeUnexpected(new Error('x'.repeat(2000))).length <= 400);
  assert.equal(describeUnexpected({ message: 'plain object error' }), 'plain object error', 'database errors are plain objects');
  assert.equal(describeUnexpected(null), 'unknown error');
}));

test('expected problems keep their own message, and the owner gets the extra detail', async () => {
  const setup = new HttpError(503, 'Google Calendar is not configured on the server.', 'GOOGLE_CLIENT_ID is missing from the server variables.');
  const owner = await respond({}, explainForOwner(setup, OWNER, ENVIRONMENT));
  assert.deepEqual([owner.status, owner.body.error], [503, 'GOOGLE_CLIENT_ID is missing from the server variables.']);
  const other = await respond({}, explainForOwner(setup, COACH, ENVIRONMENT));
  assert.deepEqual([other.status, other.body.error], [503, 'Google Calendar is not configured on the server.']);

  const plain = new HttpError(403, 'A client account is required.');
  assert.equal(explainForOwner(plain, OWNER, ENVIRONMENT), plain);
  const config = new ConfigError('APP_URL is not configured on the server.');
  assert.equal(explainForOwner(config, COACH, ENVIRONMENT), config);
  assert.equal((await respond({}, config)).status, 503);
});

test('work wrapped for the owner passes its result through and rethrows what goes wrong', silenced(async () => {
  assert.deepEqual(await withOwnerDiagnostics(OWNER, async () => ({ ok: true }), ENVIRONMENT), { ok: true });
  await assert.rejects(withOwnerDiagnostics(OWNER, async () => { throw new RangeError('bad range'); }, ENVIRONMENT), (error) => error.status === 500 && error.expose && /RangeError: bad range/.test(error.message));
  await assert.rejects(withOwnerDiagnostics(COACH, async () => { throw new RangeError('bad range'); }, ENVIRONMENT), (error) => error instanceof RangeError);
}));

// ----------------------------------------------------------------------- the routes

test('every route the platform owner may use is wrapped, and Google starts through the safe path', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const google = read('api/google.js');
  assert.match(google, /withOwnerDiagnostics\(context\.user/);
  assert.match(google, /startGoogleAuthorization\(/);
  assert.match(google, /safeAdminClient\(\)/);
  assert.doesNotMatch(google, /env\('GOOGLE_CLIENT_ID'\)|env\('GOOGLE_CLIENT_SECRET'\)|buildAuthUrl\(/, 'the keys and the address are built in one place');
  assert.match(google, /redirect\('failed'\)/, 'the return from Google never ends on a raw error page');
  for (const path of ['api/platform.js', 'api/ai.js', 'api/wearables/[provider].js']) assert.match(read(path), /withOwnerDiagnostics\(/, path);
  assert.match(read('api/_lib/http.js'), /status === 500 && !error\.expose/);
  assert.doesNotMatch(read('api/jack.js'), /adminClient\(\)/, 'Jack reads the keys through the safe client too');
});
