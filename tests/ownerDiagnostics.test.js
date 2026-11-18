import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ConfigError, appUrl, normalizeAppUrl } from '../api/_lib/config.js';
import { encryptSecret } from '../api/_lib/crypto.js';
import { HttpError, handler } from '../api/_lib/http.js';
import { describeUnexpected, explainForOwner, redactSecrets, withOwnerDiagnostics } from '../api/_lib/ownerDiagnostics.js';

// When something unexpected breaks on the server the platform owner is told the real reason and everyone else gets
// the generic message. Setup mistakes (a bad site address or encryption key) are clear messages for everybody.

const KEY = randomBytes(32).toString('base64');
const OWNER = { id: 'owner-1', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const COACH = { id: 'coach-1', email: 'coach@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const ENVIRONMENT = { APP_URL: 'https://app.example.com', TOKEN_ENCRYPTION_KEY: KEY, PLATFORM_ADMIN_EMAILS: 'owner@example.com' };

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

test('APP_URL is cleaned of spaces, quotes and trailing slashes, and a bad one is explained', () => {
  for (const [input, expected] of [
    ['https://app.example.com', 'https://app.example.com'],
    ['https://app.example.com///', 'https://app.example.com'],
    ['  https://app.example.com/  ', 'https://app.example.com'],
    ['"https://app.example.com/"', 'https://app.example.com'],
    ["'https://app.example.com'", 'https://app.example.com'],
    ['http://localhost:5173/', 'http://localhost:5173'],
  ]) assert.equal(normalizeAppUrl(input), expected, JSON.stringify(input));
  assert.equal(normalizeAppUrl(''), '');
  for (const bad of ['app.example.com', 'ftp://app.example.com', 'not a url', 'https://app.example.com?x=1']) assert.equal(normalizeAppUrl(bad), null, bad);

  assert.equal(appUrl({ APP_URL: 'https://app.example.com//' }), 'https://app.example.com');
  assert.throws(() => appUrl({}), (error) => error instanceof ConfigError && /APP_URL is not configured/.test(error.message));
  assert.throws(() => appUrl({ APP_URL: 'app.example.com' }), (error) => error instanceof ConfigError && /not a valid web address/.test(error.message));
});

test('a malformed encryption key is a clear setup message for everybody, not a crash', () => {
  assert.equal(typeof encryptSecret('x', KEY), 'string');
  for (const bad of ['', 'short', randomBytes(16).toString('base64'), randomBytes(48).toString('base64')]) {
    assert.throws(() => encryptSecret('x', bad), (error) => error instanceof ConfigError && /TOKEN_ENCRYPTION_KEY must be 32 bytes/.test(error.message), bad);
  }
});

async function respond(error) {
  const captured = { status: 0, body: null };
  const res = {
    headersSent: false,
    setHeader: () => {},
    status(code) { captured.status = code; return res; },
    json(body) { captured.body = body; return res; },
  };
  await handler(['POST'], async () => { throw error; })({ method: 'POST' }, res);
  return captured;
}

test('an unexpected failure shows the owner the real reason and everyone else the generic message', silenced(async () => {
  const failure = new TypeError('Cannot read properties of undefined (reading \'data\')');

  const forOwner = await respond(explainForOwner(failure, OWNER, ENVIRONMENT));
  assert.deepEqual([forOwner.status, forOwner.body.error], [500, 'Server error. TypeError: Cannot read properties of undefined (reading \'data\')']);

  for (const person of [COACH, { id: 'x', email: 'owner@example.com', email_confirmed_at: null }, null, undefined]) {
    const forOthers = await respond(explainForOwner(failure, person, ENVIRONMENT));
    assert.deepEqual([forOthers.status, forOthers.body.error], [500, 'Unexpected server error.'], JSON.stringify(person));
  }
  assert.deepEqual((await respond(failure)).body, { error: 'Unexpected server error.' }, 'a route that does not use the helper still hides it');
}));

test('the owner\'s message names the cause and what to do, and never contains a secret', () => {
  const env = { ...ENVIRONMENT, SUPABASE_SERVICE_ROLE_KEY: 'sb-service-role-key-abcdef123456' };
  const leaky = new Error(`failed with key sb-service-role-key-abcdef123456 and Bearer abcdefghijklmnop12345 client_secret=hunter22222 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456 ${KEY}`);
  const text = describeUnexpected(leaky, env);
  for (const secret of ['sb-service-role-key-abcdef123456', 'abcdefghijklmnop12345', 'hunter22222', 'eyJhbGciOiJIUzI1NiJ9', KEY]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /\[SUPABASE_SERVICE_ROLE_KEY\]/);
  assert.equal(redactSecrets('abc', { TOKEN_ENCRYPTION_KEY: 'abc' }), 'abc', 'very short values are not treated as secrets');

  assert.match(describeUnexpected(new Error('relation "public.x" does not exist')), /Run the latest supabase\/manual-setup\.sql/);
  assert.match(describeUnexpected(new Error('permission denied for table x')), /service_role key/);
  assert.match(describeUnexpected(new TypeError('fetch failed')), /could not reach another service/);
  assert.ok(describeUnexpected(new Error('x'.repeat(2000))).length <= 400);
  assert.equal(describeUnexpected({ message: 'plain object error' }), 'plain object error', 'database errors are plain objects');
  assert.equal(describeUnexpected(null), 'unknown error');
});

test('expected problems keep their own message, and the owner gets the extra detail', async () => {
  const setup = new HttpError(503, 'The service is not configured.', 'SOME_KEY is missing from the server variables.');
  assert.deepEqual([(await respond(explainForOwner(setup, OWNER, ENVIRONMENT))).body.error], ['SOME_KEY is missing from the server variables.']);
  assert.deepEqual([(await respond(explainForOwner(setup, COACH, ENVIRONMENT))).body.error], ['The service is not configured.']);

  const plain = new HttpError(403, 'Not allowed.');
  assert.equal(explainForOwner(plain, OWNER, ENVIRONMENT), plain);
  const config = new ConfigError('APP_URL is not configured on the server.');
  assert.equal(explainForOwner(config, COACH, ENVIRONMENT), config);
  assert.equal((await respond(config)).status, 503);
});

test('work wrapped for the owner passes its result through and rethrows what goes wrong', silenced(async () => {
  assert.deepEqual(await withOwnerDiagnostics(OWNER, async () => ({ ok: true }), ENVIRONMENT), { ok: true });
  await assert.rejects(withOwnerDiagnostics(OWNER, async () => { throw new RangeError('bad range'); }, ENVIRONMENT), (error) => error.status === 500 && error.expose && /RangeError: bad range/.test(error.message));
  await assert.rejects(withOwnerDiagnostics(COACH, async () => { throw new RangeError('bad range'); }, ENVIRONMENT), (error) => error instanceof RangeError);
}));
