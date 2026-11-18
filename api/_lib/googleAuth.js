import { appUrl, ConfigError } from './config.js';
import { signState } from './crypto.js';
import { buildAuthUrl } from './googleCalendar.js';
import { HttpError } from './http.js';
import { missingEnvNames, resolveCredentials } from './platformIntegrations.js';

// Starting the Google Calendar connection: the address Google sends people back to, the keys, and the signed state.
// Each missing piece is reported on its own, so the cause is never a vague "unexpected error".

export const RETURN_PAGES = { schedule: '/schedule', checklist: '/checklist' };

export function googleRedirectUri(environment = process.env) {
  return `${appUrl(environment)}/api/google?action=callback`;
}

// The keys saved by the platform owner, else GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the environment. Reading
// the saved keys can fail in any way (the table is not there yet, the query errors, the secret cannot be decrypted)
// and the environment variables are then used.
export async function googleCredentials({ admin, environment = process.env } = {}) {
  const credentials = await resolveCredentials('google', { admin, environment });
  if (credentials) return credentials;
  const missing = missingEnvNames('google', environment);
  throw new HttpError(
    503,
    'Google Calendar is not configured on the server.',
    `Google Calendar is not configured: ${missing.join(' and ') || 'the Google keys'} ${missing.length === 1 ? 'is' : 'are'} missing from the server variables, `
      + 'and no keys are saved at /admin/integrations. Add them in either place.',
  );
}

function stateKey(environment) {
  const key = String(environment.TOKEN_ENCRYPTION_KEY ?? '').trim();
  if (!key) throw new ConfigError('TOKEN_ENCRYPTION_KEY is not configured on the server.');
  return key;
}

// The address to open at Google, for a signed-in person who has just pressed "Connect".
export async function startGoogleAuthorization({ userId, returnTo = 'schedule', admin, environment = process.env }) {
  // The site address first: without it Google cannot send anyone back.
  const redirectUri = googleRedirectUri(environment);
  const credentials = await googleCredentials({ admin, environment });
  const page = RETURN_PAGES[returnTo] ? returnTo : 'schedule';
  const state = signState({ userId, returnTo: page }, stateKey(environment));
  return { url: buildAuthUrl({ clientId: credentials.clientId, redirectUri, state }), redirectUri, source: credentials.source };
}
