import { authenticate } from './_lib/auth.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { buildContextSummary, createRateLimiter, pageIdForRoute, parseJackRequest, runJack } from './_lib/jackAgent.js';
import { buildSystemPrompt } from './_lib/jackKnowledge.js';
import { ModelError, createModelFromEnv } from './_lib/jackModels.js';

const allowRequest = createRateLimiter({ limit: 20, windowMs: 60_000 });

// The caller's role comes from the database for the verified JWT. Nothing the browser sends about its
// role or user id is trusted: tools only run for that role, with that user's own Supabase client.
async function loadAccess(userClient) {
  const { data, error } = await userClient.rpc('get_my_access_status');
  if (error || !data) throw new HttpError(403, 'Account details are not available.');
  if (!['coach', 'client'].includes(data.role)) throw new HttpError(403, 'Jack is available to coach and client accounts.');
  if (data.role === 'coach' && !['trialing', 'active'].includes(data.access_state)) {
    throw new HttpError(402, 'An active coach plan is required.');
  }
  return data;
}

function friendlyError(error) {
  if (error instanceof ModelError) return error.message;
  console.error('Jack failed', error);
  return 'Jack ran into a problem. Please try again.';
}

export default handler(['POST'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  const access = await loadAccess(userClient);
  if (!allowRequest(user.id)) throw new HttpError(429, 'You are sending messages too quickly. Wait a moment.');

  const request = parseJackRequest(await readJson(req), { fallbackLocale: access.locale });
  if (request.error) throw new HttpError(400, request.error);

  // Fails with a 503 before any streaming starts when no AI key is configured.
  const model = createModelFromEnv();

  const system = buildSystemPrompt({
    role: access.role,
    locale: request.locale,
    route: request.route,
    pageTitle: pageIdForRoute(request.route),
    name: access.brand_name || access.full_name || '',
    summary: await buildContextSummary(access.role, userClient),
    today: request.today,
  });
  const ctx = { user, userClient, access, role: access.role, today: request.today };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event) => res.write(`${JSON.stringify(event)}\n`);

  try {
    await runJack({ model, system, history: request.messages, ctx, emit });
  } catch (error) {
    emit({ type: 'error', message: friendlyError(error) });
  } finally {
    emit({ type: 'done' });
    res.end();
  }
});
