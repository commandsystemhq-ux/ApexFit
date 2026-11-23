import { authenticate, requireRole, safeAdminClient } from './_lib/auth.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { ModelError } from './_lib/jackModels.js';
import { ACTIONS, resolveAssistantModel, runJackAssistant } from './_lib/jackAssistant.js';
import { createRateLimiter } from './_lib/jackAgent.js';

const allowRequest = createRateLimiter({ limit: 10, windowMs: 60_000 });

// Jack for the coach's work screens: generate a training plan (saved as a real program), analyse a client, and draft a
// progress report. The caller must be an active coach (the session is verified with Supabase and the plan is read from
// the database, not from the request). Every database read and write runs as that coach, so row-level security decides
// what they can reach. AI keys live on the server only; without one, built-in rules do the same work.
export default handler(['POST'], async (req, res) => {
  const { user, userClient } = await authenticate(req);
  const access = await requireRole(userClient, 'coach');
  if (!allowRequest(user.id)) throw new HttpError(429, 'You are sending requests too quickly. Wait a moment.');

  const body = await readJson(req);
  const action = typeof body.action === 'string' ? body.action : '';
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Choose generate_plan, analyze_client or progress_report.');

  let model = null;
  try {
    model = await resolveAssistantModel({ admin: safeAdminClient() });
  } catch (error) {
    console.error('Jack assistant: the AI model could not be prepared, using rules.', error?.message);
  }

  try {
    const result = await runJackAssistant({ action, body: { ...body, locale: body.locale || access.locale }, userClient, model });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ModelError) throw new HttpError(502, 'The AI service is not available right now.');
    throw error;
  }
});
