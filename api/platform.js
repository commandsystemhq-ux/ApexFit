import { adminClient, authenticate } from './_lib/auth.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { createRateLimiter } from './_lib/jackAgent.js';
import { createIntegrationStore, handleIntegrationsRequest } from './_lib/platformIntegrations.js';

const allowRequest = createRateLimiter({ limit: 30, windowMs: 60_000 });

// The keys of Fitbit, Garmin, Oura and Google (get, save, clear). Only the platform owner gets through: the session
// is verified with Supabase and the email must be confirmed and listed in PLATFORM_ADMIN_EMAILS.
export default handler(['POST'], async (req, res) => {
  const { user } = await authenticate(req);
  if (!allowRequest(user.id)) throw new HttpError(429, 'Too many requests. Wait a moment.');

  const result = await handleIntegrationsRequest({
    body: await readJson(req),
    user,
    // The service-role client is created only after the owner check has passed.
    store: () => createIntegrationStore({ admin: adminClient() }),
  });
  res.status(result.status).json(result.body);
});
