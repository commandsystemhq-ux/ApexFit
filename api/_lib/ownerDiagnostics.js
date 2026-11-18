import { isPlatformAdmin } from './aiSettings.js';
import { ConfigError } from './config.js';
import { HttpError } from './http.js';

// What to tell the person when something unexpected breaks on the server. Everyone gets the usual generic message.
// The platform owner (a confirmed email listed in PLATFORM_ADMIN_EMAILS) gets the real reason, so a setup problem
// can be fixed without digging through the hosting logs. The decision always comes from the verified session, never
// from the request. Anything that looks like a secret is removed from the text first.

const SENSITIVE_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE)/i;
const MIN_SECRET_LENGTH = 8;
const MAX_LENGTH = 400;

const HINTS = [
  [/relation .* does not exist|could not find the (table|function)|schema cache|function .* does not exist/i, 'The database is missing something. Run the latest supabase/manual-setup.sql in the Supabase SQL Editor.'],
  [/permission denied/i, 'The database refused access. Check that SUPABASE_SERVICE_ROLE_KEY is the service_role key and that the latest supabase/manual-setup.sql was run.'],
  [/invalid api key|jwt|invalid.*(supabase|url)/i, 'Check SUPABASE_URL and the Supabase keys on the server.'],
  [/fetch failed|enotfound|econnrefused|timed? out/i, 'The server could not reach another service. Check the network and the addresses in the server settings.'],
];

export function redactSecrets(text, environment = process.env) {
  let result = String(text ?? '');
  for (const [name, value] of Object.entries(environment)) {
    const secret = typeof value === 'string' ? value.trim() : '';
    if (secret.length >= MIN_SECRET_LENGTH && SENSITIVE_NAME.test(name)) result = result.split(secret).join(`[${name}]`);
  }
  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[token]')
    .replace(/(client_secret|refresh_token|access_token|api[-_]?key)=([^&\s]+)/gi, '$1=***');
}

export function describeUnexpected(error, environment = process.env) {
  const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : '';
  const message = redactSecrets(error?.message || (typeof error === 'string' ? error : 'unknown error'), environment).replace(/\s+/g, ' ').trim();
  const hint = HINTS.find(([pattern]) => pattern.test(message))?.[1];
  const text = `${name}${message}`.slice(0, MAX_LENGTH);
  return hint ? `${text} (${hint})` : text;
}

// Returns the error the route should throw. Expected problems (HttpError, ConfigError) keep their own message; for
// anything else the owner sees the real reason and everyone else the generic 500.
export function explainForOwner(error, user, environment = process.env) {
  const owner = isPlatformAdmin(user, environment);
  if (error instanceof HttpError) {
    if (owner && error.ownerDetail) {
      const detailed = new HttpError(error.status, error.ownerDetail);
      detailed.expose = true;
      return detailed;
    }
    return error;
  }
  if (error instanceof ConfigError) return error;

  console.error('Unexpected server error:', error);
  if (!owner) return error;
  const detailed = new HttpError(500, `Server error. ${describeUnexpected(error, environment)}`);
  detailed.expose = true;
  return detailed;
}

// Runs a route's work and passes any failure through explainForOwner.
export async function withOwnerDiagnostics(user, work, environment = process.env) {
  try {
    return await work();
  } catch (error) {
    throw explainForOwner(error, user, environment);
  }
}
