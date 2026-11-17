import { adminClient, authenticate } from './_lib/auth.js';
import { resolveJackModel } from './_lib/aiSettings.js';
import { ConfigError } from './_lib/config.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { buildContextSummary, createRateLimiter, pageIdForRoute, parseJackRequest, runJack } from './_lib/jackAgent.js';
import { buildSystemPrompt } from './_lib/jackKnowledge.js';
import { ModelError } from './_lib/jackModels.js';

const allowRequest = createRateLimiter({ limit: 20, windowMs: 60_000 });

// The caller's role comes from the database for the verified JWT. Nothing the browser sends about its
// role or user id is trusted: tools only run for that role, with that user's own Supabase client.
async function loadAccess(userClient) {
  const { data, error } = await userClient.rpc('get_my_access_status');
  if (error || !data) throw new HttpError(403, 'Account details are not available.');
  if (!['coach', 'client'].includes(data.role)) throw new HttpError(403, 'Jack is available to coach and client accounts.');
  if (data.role === 'coach' && !['trialing', 'active', 'trainer'].includes(data.access_state)) {
    throw new HttpError(402, 'An active coach plan is required.');
  }
  return data;
}

// The provider's own message (rejected credentials, busy…) is for the account owner. Clients and assistant
// trainers cannot fix it, so they get a neutral one and never see which provider is in use.
function friendlyError(error, role) {
  if (error instanceof ModelError) return role === 'coach' ? error.message : error.status === 429 ? error.message : 'Jack is unavailable right now. Please try again later.';
  console.error('Jack failed', error);
  return 'Jack ran into a problem. Please try again.';
}

export default handler(['POST'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  const access = await loadAccess(userClient);
  if (!allowRequest(user.id)) throw new HttpError(429, 'You are sending messages too quickly. Wait a moment.');

  const request = parseJackRequest(await readJson(req), { fallbackLocale: access.locale });
  if (request.error) throw new HttpError(400, request.error);

  // The model is the one the coach chose in Settings (for a client or an assistant trainer: their coach's choice),
  // else the server's environment. Fails with a 503 before any streaming starts when nothing is configured.
  let admin = null;
  try {
    admin = adminClient();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  // Assistant trainers are coach accounts working under a head coach; they get a much smaller toolbox.
  const role = access.access_state === 'trainer' ? 'trainer' : access.role;

  let model;
  try {
    ({ model } = await resolveJackModel({ admin, userId: user.id }));
  } catch (error) {
    // How the AI is set up is the account owner's business: everyone else just hears that Jack is not ready.
    if (error instanceof ConfigError && role !== 'coach') throw new HttpError(503, 'Jack is not available yet. Please ask your coach.');
    throw error;
  }

  const system = buildSystemPrompt({
    role,
    locale: request.locale,
    route: request.route,
    pageTitle: pageIdForRoute(request.route),
    name: access.brand_name || access.full_name || '',
    summary: await buildContextSummary(role, userClient),
    today: request.today,
    utcOffsetMinutes: request.utcOffsetMinutes,
  });
  const ctx = { user, userClient, access, role, today: request.today, utcOffsetMinutes: request.utcOffsetMinutes };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event) => res.write(`${JSON.stringify(event)}\n`);

  try {
    await runJack({ model, system, history: request.messages, ctx, emit });
  } catch (error) {
    emit({ type: 'error', message: friendlyError(error, role) });
  } finally {
    emit({ type: 'done' });
    res.end();
  }
});
