import { PAGES, pageForPath } from '../../src/routes.js';
import { executeTool, summarizeCoachOverview, toolSpecsForRole } from './jackTools.js';

export const LOCALES = ['en', 'ar', 'de', 'fr', 'es'];
export const MAX_HISTORY_MESSAGES = 16;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_ITERATIONS = 5;
export const MAX_TOOL_CALLS_PER_TURN = 4;
const MAX_TOOL_RESULT_CHARS = 6000;

// Only plain user/assistant text is accepted from the browser. System, tool, or function messages are
// dropped, so a caller cannot smuggle instructions or fake tool results into the conversation.
export function parseJackRequest(body, { fallbackLocale = 'en', serverDate = new Date() } = {}) {
  const source = Array.isArray(body?.messages) ? body.messages : [];
  const messages = source
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    .map((message) => ({ role: message.role, content: message.content.trim().slice(0, MAX_MESSAGE_CHARS) }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
  while (messages.length && messages[0].role !== 'user') messages.shift();

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return { error: 'Send a message for Jack to answer.' };
  }

  const context = body?.context && typeof body.context === 'object' ? body.context : {};
  const locale = LOCALES.includes(context.locale) ? context.locale : fallbackLocale;
  const route = typeof context.route === 'string' && pageForPath(context.route) ? context.route : '';

  // The client's local date, accepted only when it is within a day of the server date.
  const serverDay = serverDate.toISOString().slice(0, 10);
  let today = serverDay;
  if (typeof context.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(context.today)) {
    const offset = Math.abs(Date.parse(`${context.today}T00:00:00Z`) - Date.parse(`${serverDay}T00:00:00Z`));
    if (offset <= 86_400_000) today = context.today;
  }
  return { messages, locale, route, today };
}

export function createRateLimiter({ limit = 20, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function allow(key) {
    const current = now();
    const recent = (hits.get(key) || []).filter((time) => current - time < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(current);
    hits.set(key, recent);
    return true;
  };
}

function truncateResult(value) {
  const text = JSON.stringify(value);
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…` : text;
}

// The agent loop: ask the model, run the tools it requests as the verified user, feed results back,
// and stream progress (steps, navigation, final text) through emit().
export async function runJack({ model, system, history, ctx, emit, execute = executeTool }) {
  const tools = toolSpecsForRole(ctx.role);
  const messages = history.map((message) => ({ ...message }));
  let stepNumber = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const response = await model.complete({ system, messages, tools });
    const calls = (response.toolCalls || []).slice(0, MAX_TOOL_CALLS_PER_TURN);

    if (calls.length === 0) {
      emit({ type: 'text', text: response.text || '' });
      return;
    }

    messages.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
    for (const call of calls) {
      stepNumber += 1;
      const id = `step-${stepNumber}`;
      emit({ type: 'step', id, tool: call.name, status: 'running' });

      const outcome = await execute(call.name, call.args, ctx);
      emit({
        type: 'step',
        id,
        tool: call.name,
        status: outcome.ok ? 'done' : 'error',
        detail: outcome.ok ? outcome.meta : { error: outcome.error },
      });
      if (outcome.ok && outcome.navigate) emit({ type: 'navigate', path: outcome.navigate });

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: truncateResult(outcome.ok ? { ok: true, ...outcome.result } : { ok: false, error: outcome.error }),
      });
    }
  }

  // Tool budget used up: ask for a plain wrap-up without offering more tools.
  const wrapUp = await model.complete({ system, messages, tools: [] });
  emit({ type: 'text', text: wrapUp.text || '' });
}

// A short, factual snapshot of the user's account for the system prompt. Failures simply omit it.
export async function buildContextSummary(role, userClient) {
  try {
    if (role === 'coach') {
      const { data, error } = await userClient.rpc('get_coach_client_overview');
      if (error) return '';
      const summary = summarizeCoachOverview(data);
      return [
        `Active clients: ${summary.active_clients}. Clients absent 2+ days: ${summary.absent_2plus_days.count}.`,
        `Workflows: ${summary.workflows.active} active of ${summary.workflows.total}. Programs: ${summary.programs}.`,
      ].join('\n');
    }
    const { data, error } = await userClient.rpc('get_my_schedule');
    if (error) return '';
    return [
      `Coach: ${data.coach_name || 'not linked yet'}. Workout logged today: ${data.workout_logged_today ? 'yes' : 'no'}. Workouts in the last 7 days: ${data.workouts_this_week}.`,
      `Assigned program: ${data.program?.title || 'none'}.`,
    ].join('\n');
  } catch {
    return '';
  }
}

export function pageIdForRoute(route) {
  const entry = Object.entries(PAGES).find(([, page]) => page.path === route);
  return entry ? entry[0] : '';
}
