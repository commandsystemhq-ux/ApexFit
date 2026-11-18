import { authenticate } from './_lib/auth.js';
import { describeJackFailure, isPlatformAdmin, resolveJackModel } from './_lib/aiSettings.js';
import { ConfigError } from './_lib/config.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { buildContextSummary, createRateLimiter, pageIdForRoute, parseJackRequest, runJack } from './_lib/jackAgent.js';
import { buildSystemPrompt } from './_lib/jackKnowledge.js';
import { ModelError } from './_lib/jackModels.js';
import { safeAdminClient } from './_lib/platformIntegrations.js';

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

// Which AI provider runs Jack is the platform owner's business. Coaches, assistant trainers and clients are only
// told that Jack is unavailable; the platform owner (PLATFORM_ADMIN_EMAILS) is shown the provider's real status
// and message so the setup can be fixed. Everything is also written to the server log.
function friendlyError(error, admin) {
  if (error instanceof ModelError) {
    console.error('Jack model error', error.providerStatus, error.detail, error.requestUrl);
    return describeJackFailure(error, { admin });
  }
  console.error('Jack failed', error);
  return describeJackFailure(error, { admin });
}

export default handler(['POST'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  const access = await loadAccess(userClient);
  if (!allowRequest(user.id)) throw new HttpError(429, 'You are sending messages too quickly. Wait a moment.');

  // Only the platform owner is told why the AI failed. This comes from the verified session, never from the request.
  const admin = isPlatformAdmin(user);
  const request = parseJackRequest(await readJson(req), { fallbackLocale: access.locale });
  if (request.error) throw new HttpError(400, request.error);

  // One model for the whole platform: the platform owner's setting, else the server's environment variables.
  // Fails with a 503 before any streaming starts when nothing is configured.
  const serviceClient = safeAdminClient();
  // Assistant trainers are coach accounts working under a head coach; they get a much smaller toolbox.
  const role = access.access_state === 'trainer' ? 'trainer' : access.role;

  let model;
  try {
    ({ model } = await resolveJackModel({ admin: serviceClient }));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error('Jack is not configured:', error.message);
    throw new HttpError(503, describeJackFailure(error, { admin }));
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
    emit({ type: 'error', message: friendlyError(error, admin) });
  } finally {
    emit({ type: 'done' });
    res.end();
  }
});
