import { adminClient, authenticate } from './_lib/auth.js';
import { createAiStore, handleAiRequest } from './_lib/aiSettings.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { createRateLimiter } from './_lib/jackAgent.js';

const allowRequest = createRateLimiter({ limit: 30, windowMs: 60_000 });

// The platform-wide AI provider (view, save, test, remove). Only the platform owner gets through: the session is
// verified with Supabase and the email must be confirmed and listed in PLATFORM_ADMIN_EMAILS. The one action open
// to every signed-in person is `status`, which only answers "are you the platform owner?" and touches no data.
export default handler(['POST'], async (req, res) => {
  const { user } = await authenticate(req);
  if (!allowRequest(user.id)) throw new HttpError(429, 'Too many requests. Wait a moment.');

  const body = await readJson(req);
  // The service-role client is created only after the owner check has passed.
  const result = await handleAiRequest({ body, user, store: () => createAiStore({ admin: adminClient() }) });
  res.status(result.status).json(result.body);
});
