import { ConfigError } from './config.js';
import { HttpError } from './http.js';
import { createAnthropicModel } from './anthropicModel.js';
import { resolveJackModel } from './aiSettings.js';
import {
  GOALS, analyzeClientRules, buildProgressReport, buildRulePlan, limitationFilter, normalizeRequest, usableExercises,
} from './jackAssistantRules.js';

export const ACTIONS = ['generate_plan', 'analyze_client', 'progress_report'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EQUIPMENT_FROM_INTAKE = { full_gym: 'gym', home_gym: 'home', bodyweight_only: 'bodyweight' };
const MAX_CATALOG_FOR_AI = 240;
const MAX_REPORT_CHARS = 3000;

// The model for the assistant: the platform's AI settings (or the server environment) first, then ANTHROPIC_API_KEY.
// null when there is no AI at all: every action then runs on the built-in rules.
export async function resolveAssistantModel({ admin, environment = process.env, fetchImpl = fetch } = {}) {
  try {
    return (await resolveJackModel({ admin, environment, fetchImpl })).model;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
  }
  const apiKey = String(environment.ANTHROPIC_API_KEY || '').trim();
  if (apiKey) return createAnthropicModel({ apiKey, model: String(environment.ANTHROPIC_MODEL || '').trim() || undefined, fetchImpl });
  return null;
}

function requireClientId(body) {
  if (typeof body.client_id !== 'string' || !UUID.test(body.client_id)) throw new HttpError(400, 'Choose a client.');
  return body.client_id;
}

async function loadCatalog(userClient) {
  const { data, error } = await userClient
    .from('exercises')
    .select('id,slug,name,category,primary_muscles,equipment,difficulty')
    .eq('is_published', true)
    .limit(2000);
  if (error) throw error;
  return data || [];
}

async function loadIntake(userClient, clientId) {
  const { data, error } = await userClient
    .from('client_intake_forms')
    .select('primary_goal,experience_level,training_days_per_week,equipment_access,injuries')
    .eq('client_id', clientId)
    .limit(1);
  if (error) return null;
  return data?.[0] || null;
}

async function loadReportData(userClient, clientId, days) {
  const { data, error } = await userClient.rpc('get_client_report_data', { p_client_id: clientId, p_days: days });
  if (error) {
    if (error.code === '42501' || /own clients/i.test(error.message || '')) throw new HttpError(403, 'You can only build reports for your own clients.');
    throw new Error(error.message || 'The client data could not be read.');
  }
  return data;
}

// -------------------------------------------------------------------------------------------- plan with AI

function pickJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// A compact, varied slice of the library for the prompt: a few exercises per muscle, numbered, so the model answers with
// numbers from the list and cannot invent an exercise.
function catalogForPrompt(pool) {
  const perMuscle = new Map();
  const picked = [];
  for (const exercise of pool) {
    const muscle = (exercise.primary_muscles || [])[0] || 'other';
    const count = perMuscle.get(muscle) || 0;
    if (count >= 16 || picked.length >= MAX_CATALOG_FOR_AI) continue;
    perMuscle.set(muscle, count + 1);
    picked.push(exercise);
  }
  return picked;
}

export function validateAiPlan(raw, picked, request) {
  if (!raw || !Array.isArray(raw.days)) return null;
  const days = raw.days.slice(0, request.days).map((day, index) => {
    const exercises = (Array.isArray(day.exercises) ? day.exercises : []).slice(0, 12).map((item) => {
      const exercise = picked[Number(item.n) - 1];
      if (!exercise) return null;
      const sets = Math.round(Number(item.sets));
      const rest = Math.round(Number(item.rest_seconds));
      const reps = String(item.reps ?? '').trim();
      return {
        exercise_id: exercise.id,
        sets: Number.isInteger(sets) && sets >= 1 && sets <= 8 ? sets : 3,
        reps: reps && reps.length <= 20 ? reps : '8-12',
        rest_seconds: Number.isInteger(rest) && rest >= 0 && rest <= 600 ? rest : 90,
        notes: String(item.notes ?? '').trim().slice(0, 300),
      };
    }).filter(Boolean);
    return { name: String(day.name || `Day ${index + 1}`).trim().slice(0, 100) || `Day ${index + 1}`, exercises };
  });
  if (days.length !== request.days || days.some((day) => day.exercises.length < 3)) return null;
  const title = String(raw.title || '').trim().slice(0, 160);
  if (!title) return null;
  return { title, description: String(raw.description || '').trim().slice(0, 2000), days };
}

async function aiPlan(model, pool, request, clientContext) {
  const picked = catalogForPrompt(pool);
  const list = picked.map((exercise, index) => `${index + 1}|${exercise.name}|${(exercise.primary_muscles || []).join('/')}|${(exercise.equipment || []).join('/')}`).join('\n');
  const language = request.language === 'ar' ? 'Arabic' : 'English';
  const system = [
    'You are Jack, a strength and conditioning assistant for a professional coach. You design safe, sensible training programs.',
    `Write the title, description, day names and notes in ${language}.`,
    'Use ONLY exercises from the numbered list the user gives you, referring to them by their number n. Never invent an exercise.',
    `Answer with one JSON object and nothing else: {"title": string, "description": string, "days": [{"name": string, "exercises": [{"n": number, "sets": number, "reps": string, "rest_seconds": number, "notes": string}]}]}.`,
    `Exactly ${request.days} training days, 4 to 7 exercises per day, balanced across muscle groups, the main compound lifts first.`,
  ].join('\n');
  const user = [
    `Goal: ${request.goal}. Level: ${request.level}. Training days per week: ${request.days}. Environment: ${request.environment}.`,
    request.limitations ? `Injuries or limitations to respect: ${request.limitations}` : '',
    request.notes ? `Coach notes: ${request.notes}` : '',
    clientContext ? `Client context: ${clientContext}` : '',
    'Exercise list (n|name|muscles|equipment):',
    list,
  ].filter(Boolean).join('\n');
  const response = await model.complete({ system, messages: [{ role: 'user', content: user }], tools: [] });
  return validateAiPlan(pickJson(response.text || ''), picked, request);
}

export async function describePlan(userClient, plan, catalog) {
  const byId = new Map(catalog.map((exercise) => [exercise.id, exercise]));
  return plan.days.map((day) => ({
    name: day.name,
    exercises: day.exercises.map((item) => ({ exercise_id: item.exercise_id, name: byId.get(item.exercise_id)?.name || '', slug: byId.get(item.exercise_id)?.slug || '', sets: item.sets, reps: item.reps, rest_seconds: item.rest_seconds })),
  }));
}

// ---------------------------------------------------------------------------------------------- the actions

async function generatePlan({ body, userClient, model }) {
  const request = normalizeRequest(body);
  let clientContext = '';
  if (typeof body.client_id === 'string' && UUID.test(body.client_id)) {
    const intake = await loadIntake(userClient, body.client_id);
    if (intake) {
      // What the client wrote in onboarding fills what the coach left empty.
      if (!GOALS.includes(body.goal)) request.goal = intake.primary_goal;
      if (!body.level) request.level = intake.experience_level;
      if (!body.days) request.days = intake.training_days_per_week;
      if (!body.environment) request.environment = EQUIPMENT_FROM_INTAKE[intake.equipment_access] || request.environment;
      if (intake.injuries) request.limitations = `${request.limitations} ${intake.injuries}`.trim().slice(0, 500);
      clientContext = `${intake.primary_goal}, ${intake.experience_level}, ${intake.training_days_per_week} days a week.`;
    }
  }

  const catalog = await loadCatalog(userClient);
  const pool = usableExercises(catalog, request);
  if (pool.length < 8) throw new HttpError(422, 'The exercise library has too few exercises for this request. Import the exercise catalog first.');

  let plan = null;
  let source = 'rules';
  if (model) {
    try {
      plan = await aiPlan(model, pool, request, clientContext);
      if (plan) source = 'ai';
    } catch (error) {
      console.error('Jack assistant: the AI plan failed, using rules.', error?.status, error?.message);
    }
  }
  if (!plan) plan = buildRulePlan(catalog, request);
  if (plan.days.length === 0) throw new HttpError(422, 'No exercises match this request. Change the environment or the limitations.');
  const warnings = limitationFilter(request.limitations).notes.map((note) => note[request.language] || note.en);

  const { data, error } = await userClient.rpc('save_training_program', { p_title: plan.title, p_description: plan.description || '', p_days: plan.days });
  if (error) throw error;
  return {
    action: 'generate_plan', source, program_id: data, title: plan.title, description: plan.description || '', warnings,
    request: { goal: request.goal, level: request.level, days: request.days, environment: request.environment },
    days: await describePlan(userClient, plan, catalog),
  };
}

const REPORT_SYSTEM = {
  ar: 'أنت Jack، مساعد مدرب لياقة محترف. اكتب بالعربية الفصحى المبسطة بنبرة مشجعة ومهنية وقصيرة.',
  en: 'You are Jack, a professional fitness coach assistant. Write in clear, warm, professional English.',
};

function numbersIn(text) {
  return (String(text).match(/\d+(?:[.,]\d+)?/g) || []).map((token) => Number(token.replace(',', '.')));
}

// A report from the model may only use numbers that exist in the client's data or in the rule-based draft.
export function numbersAreGrounded(output, allowedSources) {
  const allowed = new Set(numbersIn(allowedSources.join(' ')).map(String));
  return numbersIn(output).every((value) => (Number.isInteger(value) && value <= 10) || allowed.has(String(value)));
}

async function aiText({ model, language, instruction, data, draft, extra = '' }) {
  const system = `${REPORT_SYSTEM[language]} Use ONLY the facts and numbers in the data; never invent a number, never give medical advice. ${extra}`.trim();
  const user = `${instruction}\n\nDATA (JSON):\n${JSON.stringify(data)}\n\nDRAFT FROM RULES (keep its facts):\n${draft}`;
  const response = await model.complete({ system, messages: [{ role: 'user', content: user }], tools: [] });
  return (response.text || '').trim();
}

async function analyzeClient({ body, userClient, model }) {
  const clientId = requireClientId(body);
  const days = [14, 30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 30;
  const language = body.language === 'ar' || body.locale === 'ar' ? 'ar' : 'en';
  const data = await loadReportData(userClient, clientId, days);
  const rules = analyzeClientRules(data, { language });
  let narrative = null;
  let source = 'rules';
  if (model) {
    try {
      const draft = [...rules.findings.map((finding) => `- ${finding.text}`), ...rules.recommendations.map((item) => `* ${item}`)].join('\n');
      const text = await aiText({
        model, language, data, draft,
        instruction: language === 'ar'
          ? 'اكتب تحليلًا موجزًا للمدرب (5 إلى 8 أسطر) عن أداء هذا العميل واقترح تعديلات محددة على الخطة.'
          : 'Write a short analysis for the coach (5 to 8 lines) of this client\'s performance and suggest specific changes to the plan.',
      });
      if (text.length >= 40 && numbersAreGrounded(text, [JSON.stringify(data), draft])) {
        narrative = text.slice(0, 2500);
        source = 'ai';
      }
    } catch (error) {
      console.error('Jack assistant: the AI analysis failed, using rules.', error?.status, error?.message);
    }
  }
  return { action: 'analyze_client', source, days, summary: rules.summary, findings: rules.findings, recommendations: rules.recommendations, narrative };
}

async function progressReport({ body, userClient, model }) {
  const clientId = requireClientId(body);
  const days = [7, 14, 30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 30;
  const language = body.language === 'en' ? 'en' : 'ar';
  const data = await loadReportData(userClient, clientId, days);
  const draft = buildProgressReport(data, { language, maxLength: MAX_REPORT_CHARS });
  let text = draft;
  let source = 'rules';
  if (model) {
    try {
      const written = await aiText({
        model, language, data, draft,
        extra: `Keep it under ${MAX_REPORT_CHARS - 600} characters. Plain text with short paragraphs or bullets, no markdown headings.`,
        instruction: language === 'ar'
          ? 'اكتب تقرير تقدم احترافيًا للعميل بالعربية من هذه الأرقام الحقيقية: ابدأ بتحية باسمه الأول، لخّص الإنجازات، أشِر لنقطة يحتاج تحسينها، وأنهِ بتشجيع وخطوة قادمة. سيراجعه المدرب قبل إرساله.'
          : 'Write a professional progress report for the client from these real numbers: greet them by first name, summarise achievements, point to one thing to improve, and finish with encouragement and a next step. The coach will review it before sending.',
      });
      if (written.length >= 120 && written.length <= MAX_REPORT_CHARS && numbersAreGrounded(written, [JSON.stringify(data), draft])) {
        text = written;
        source = 'ai';
      }
    } catch (error) {
      console.error('Jack assistant: the AI report failed, using the rule-based draft.', error?.status, error?.message);
    }
  }
  return { action: 'progress_report', source, language, days, text };
}

// One entry point for the endpoint and for the tests. `model` may be null (rules only).
export async function runJackAssistant({ action, body = {}, userClient, model = null }) {
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'Choose generate_plan, analyze_client or progress_report.');
  if (action === 'generate_plan') return generatePlan({ body, userClient, model });
  if (action === 'analyze_client') return analyzeClient({ body, userClient, model });
  return progressReport({ body, userClient, model });
}
