import { adminClient, authenticate } from './_lib/auth.js';
import { createAiStore, handleAiRequest } from './_lib/aiSettings.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { createRateLimiter } from './_lib/jackAgent.js';

const allowRequest = createRateLimiter({ limit: 30, windowMs: 60_000 });

// AI provider settings for Jack (view, save, test, remove). Only the account owner gets through: the role comes
// from the database for the verified session, clients and assistant trainers are refused here, and the database
// functions refuse them again.
export default handler(['POST'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  const { data: access, error } = await userClient.rpc('get_my_access_status');
  if (error || !access) throw new HttpError(403, 'Account details are not available.');
  if (!allowRequest(user.id)) throw new HttpError(429, 'Too many requests. Wait a moment.');

  const body = await readJson(req);
  const result = await handleAiRequest({
    body,
    access: { ...access, id: user.id },
    store: createAiStore({ userClient, admin: adminClient() }),
  });
  res.status(result.status).json(result.body);
});
