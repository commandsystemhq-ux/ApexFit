import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnthropicModel } from '../api/_lib/anthropicModel.js';
import { runJackAssistant, resolveAssistantModel, numbersAreGrounded, validateAiPlan } from '../api/_lib/jackAssistant.js';
import {
  analyzeClientRules, buildProgressReport, buildRulePlan, limitationFilter, normalizeRequest, usableExercises,
} from '../api/_lib/jackAssistantRules.js';
import { ModelError } from '../api/_lib/jackModels.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { jackAssistantTranslations } from '../src/i18n/jackAssistantTranslations.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003500_client_report_data.sql', import.meta.url);
const library = JSON.parse(read('data/free-exercise-db-apexfit.json'));
const catalog = library.map((exercise, index) => ({ ...exercise, id: `00000000-0000-4000-9000-${String(index).padStart(12, '0')}` }));

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

const sql = (list) => `array[${list.map((item) => `'${item}'`).join(',')}]::text[]`;
async function loadLibrary(limit = 400) {
  const chosen = library.filter((exercise) => exercise.category === 'strength').slice(0, limit);
  for (const exercise of chosen) {
    await db.query(
      `insert into public.exercises (slug, name, category, primary_muscles, equipment, difficulty, is_published) values ($1, $2, $3, ${sql(exercise.primary_muscles)}, ${sql(exercise.equipment)}, $4, true)`,
      [exercise.slug, exercise.name, exercise.category, exercise.difficulty],
    );
  }
  return chosen.length;
}

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; truncate public.exercises cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara Ali' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara Ali', 'sara@example.com'), ($3, $4, 'Omar Hassan', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
});

// ------------------------------------------------------------------------------------ the plan from rules

test('the request is cleaned: unknown values fall back to safe ones', () => {
  assert.deepEqual(normalizeRequest({ days: 9, goal: 'x', level: 'y', environment: 'z' }), { days: 3, goal: 'general_fitness', level: 'beginner', environment: 'gym', limitations: '', notes: '', language: 'en' });
  assert.equal(normalizeRequest({ days: '5', goal: 'strength', language: 'ar' }).days, 5);
  assert.equal(normalizeRequest({ locale: 'ar' }).language, 'ar');
  assert.equal(normalizeRequest({ limitations: 'x'.repeat(900) }).limitations.length, 500);
});

test('every training split from 1 to 7 days is built from real library exercises, without repeating a movement in a day', () => {
  for (let days = 1; days <= 7; days += 1) {
    const plan = buildRulePlan(catalog, { days, goal: 'muscle_gain', level: 'intermediate', environment: 'gym' });
    assert.equal(plan.days.length, days, `${days} days`);
    for (const day of plan.days) {
      assert.ok(day.exercises.length >= 3, `${days} days: ${day.name}`);
      const used = day.exercises.map((item) => item.exercise_id);
      assert.equal(new Set(used).size, used.length);
      for (const item of day.exercises) {
        assert.ok(catalog.some((exercise) => exercise.id === item.exercise_id));
        assert.ok(item.sets >= 1 && item.sets <= 8 && item.rest_seconds >= 0 && item.reps.length <= 20);
      }
    }
  }
});

test('the same request gives the same plan, and a different goal changes the sets and repetitions', () => {
  const request = { days: 4, goal: 'strength', level: 'intermediate', environment: 'gym' };
  assert.deepEqual(buildRulePlan(catalog, request), buildRulePlan(catalog, request));
  const strength = buildRulePlan(catalog, request).days[0].exercises;
  const fat = buildRulePlan(catalog, { ...request, goal: 'fat_loss' }).days[0].exercises;
  assert.deepEqual([strength[0].sets, strength[0].reps, strength[0].rest_seconds], [5, '5', 150]);
  assert.deepEqual([fat[0].sets, fat[0].reps, fat[0].rest_seconds], [3, '12-15', 45]);
  const beginner = buildRulePlan(catalog, { ...request, level: 'beginner' }).days[0].exercises;
  assert.ok(beginner.length <= 5 && beginner[0].sets <= 3);
});

test('the environment and level decide which equipment and difficulty may be used', () => {
  const byId = new Map(catalog.map((exercise) => [exercise.id, exercise]));
  const used = (request) => buildRulePlan(catalog, request).days.flatMap((day) => day.exercises.map((item) => byId.get(item.exercise_id)));
  const bodyweight = used({ days: 3, environment: 'bodyweight', level: 'intermediate' });
  assert.ok(bodyweight.length > 6);
  assert.ok(bodyweight.every((exercise) => exercise.equipment.includes('bodyweight') || exercise.equipment.length === 0));
  const home = used({ days: 3, environment: 'home', level: 'intermediate' });
  assert.ok(home.every((exercise) => exercise.equipment.some((item) => ['bodyweight', 'dumbbell', 'resistance_band', 'kettlebell', 'exercise_ball', 'medicine_ball', 'other'].includes(item))));
  const beginner = used({ days: 4, environment: 'gym', level: 'beginner' });
  assert.ok(beginner.every((exercise) => exercise.difficulty === 'beginner'));
  assert.ok(used({ days: 4, environment: 'gym', level: 'intermediate' }).every((exercise) => exercise.difficulty !== 'advanced'));
});

test('injuries written by the coach remove the movements that would hurt, in English or Arabic', () => {
  const byId = new Map(catalog.map((exercise) => [exercise.id, exercise]));
  const names = (request) => buildRulePlan(catalog, request).days.flatMap((day) => day.exercises.map((item) => byId.get(item.exercise_id).name));
  const knee = names({ days: 5, environment: 'gym', level: 'advanced', limitations: 'bad knee' });
  assert.ok(knee.every((name) => !/jump|lunge|plyo|box|burpee/i.test(name)), knee.join(', '));
  const shoulder = names({ days: 5, environment: 'gym', level: 'advanced', limitations: 'ألم في الكتف' });
  assert.ok(shoulder.every((name) => !/overhead|military|snatch|clean|behind|dip|upright/i.test(name)), shoulder.join(', '));
  const plan = buildRulePlan(catalog, { days: 3, limitations: 'ألم في الركبة والظهر', language: 'ar' });
  assert.equal(plan.warnings.length, 2);
  assert.ok(plan.warnings.every((warning) => /[\u0600-\u06FF]/.test(warning)));
  assert.equal(limitationFilter('healthy').avoid.length, 0);
  assert.ok(usableExercises(catalog, normalizeRequest({ limitations: 'knee' })).length < usableExercises(catalog, normalizeRequest({})).length);
});

test('a plan written in Arabic has Arabic names and day titles', () => {
  const plan = buildRulePlan(catalog, { days: 3, goal: 'fat_loss', level: 'beginner', language: 'ar' });
  assert.match(plan.title, /حرق الدهون/);
  assert.ok(plan.days.every((day) => /اليوم \d/.test(day.name) && /[\u0600-\u06FF]/.test(day.name)));
  assert.match(plan.description, /3 أيام/);
});

// -------------------------------------------------------------------------------------------- the AI side

test('an AI plan is accepted only when it uses numbers from the list and has the right number of days', () => {
  const picked = catalog.slice(0, 30);
  const day = (name) => ({ name, exercises: [1, 2, 3, 4].map((n) => ({ n, sets: 3, reps: '8-12', rest_seconds: 90, notes: 'ok' })) });
  const good = validateAiPlan({ title: 'Plan', description: 'd', days: [day('A'), day('B')] }, picked, { days: 2 });
  assert.equal(good.days.length, 2);
  assert.equal(good.days[0].exercises[0].exercise_id, picked[0].id);
  assert.equal(validateAiPlan({ title: 'Plan', days: [day('A')] }, picked, { days: 2 }), null, 'wrong number of days');
  assert.equal(validateAiPlan({ title: '', days: [day('A')] }, picked, { days: 1 }), null, 'no title');
  assert.equal(validateAiPlan({ title: 'P', days: [{ name: 'A', exercises: [{ n: 99 }, { n: 0 }, { n: 1 }] }] }, picked, { days: 1 }), null, 'invented exercises');
  const clamped = validateAiPlan({ title: 'P', days: [{ name: 'A', exercises: [1, 2, 3].map((n) => ({ n, sets: 99, reps: '', rest_seconds: -5 })) }] }, picked, { days: 1 });
  assert.deepEqual([clamped.days[0].exercises[0].sets, clamped.days[0].exercises[0].reps, clamped.days[0].exercises[0].rest_seconds], [3, '8-12', 90]);
  assert.equal(validateAiPlan(null, picked, { days: 1 }), null);
});

test('a report from the AI may only use numbers that exist in the data', () => {
  const data = JSON.stringify({ workouts: 12, weight: 82.4 });
  assert.equal(numbersAreGrounded('You trained 12 times and weigh 82.4 kg, 3 sessions a week.', [data]), true);
  assert.equal(numbersAreGrounded('You trained 15 times.', [data]), false);
  assert.equal(numbersAreGrounded('You lost 7.5 kg.', [data]), false);
  assert.equal(numbersAreGrounded('No numbers at all here.', [data]), true);
});

test('the AI adapters: Claude answers in plain text and its failures become safe errors', async () => {
  const calls = [];
  const model = createAnthropicModel({
    apiKey: 'key-123456',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ content: [{ type: 'text', text: ' Hello ' }] }) }; },
  });
  assert.deepEqual(await model.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'x' }] }), { text: 'Hello', toolCalls: [] });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], 'key-123456');
  assert.equal(JSON.parse(calls[0].init.body).messages.length, 1);
  const failing = (status) => createAnthropicModel({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
  await assert.rejects(failing(401).complete({ system: 's', messages: [] }), (error) => error instanceof ModelError && error.status === 503);
  await assert.rejects(failing(429).complete({ system: 's', messages: [] }), (error) => error instanceof ModelError && error.status === 429);
  await assert.rejects(failing(500).complete({ system: 's', messages: [] }), (error) => error instanceof ModelError && error.status === 502);
  const empty = createAnthropicModel({ apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ content: [] }) }) });
  await assert.rejects(empty.complete({ system: 's', messages: [] }), ModelError);
});

test('the model is the platform one, else Claude from ANTHROPIC_API_KEY, else none', async () => {
  assert.equal(await resolveAssistantModel({ admin: null, environment: {} }), null);
  assert.equal((await resolveAssistantModel({ admin: null, environment: { ANTHROPIC_API_KEY: 'sk-ant' } })).provider, 'anthropic');
  assert.equal((await resolveAssistantModel({ admin: null, environment: { OPENAI_API_KEY: 'sk-openai', ANTHROPIC_API_KEY: 'sk-ant' } })).provider, 'openai');
});

// ------------------------------------------------------------------------------ end to end with the database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('without any AI key the generator still builds a plan and saves it as a real program that counts as a created plan', async () => {
  assert.ok(await loadLibrary() > 100);
  const result = await runJackAssistant({ action: 'generate_plan', body: { goal: 'muscle_gain', level: 'intermediate', days: 4, environment: 'gym', language: 'ar' }, userClient: as(ids.coach), model: null });
  assert.equal(result.source, 'rules');
  assert.equal(result.days.length, 4);
  assert.ok(result.days.every((day) => day.exercises.every((item) => item.name && item.slug)));
  const [program] = await rows('select id, coach_id, title from public.training_programs');
  assert.deepEqual([program.id, program.coach_id], [result.program_id, ids.coach]);
  assert.match(program.title, /بناء العضلات/);
  const days = await rows('select count(*)::int as n from public.training_program_days where program_id = $1', [program.id]);
  assert.equal(days[0].n, 4);
  const dashboard = await as(ids.coach).rpc('get_coach_dashboard', { p_days: 30 });
  assert.equal(dashboard.data.plans_created, 1);
});

test('what the client wrote in the onboarding form fills in the request', async () => {
  await loadLibrary();
  await db.query("insert into public.client_intake_forms (client_id, primary_goal, experience_level, training_days_per_week, equipment_access, injuries) values ($1, 'strength', 'advanced', 5, 'home_gym', 'knee pain')", [ids.sara]);
  const result = await runJackAssistant({ action: 'generate_plan', body: { client_id: ids.sara }, userClient: as(ids.coach), model: null });
  assert.deepEqual(result.request, { goal: 'strength', level: 'advanced', days: 5, environment: 'home' });
  assert.equal(result.days.length, 5);
  assert.ok(result.warnings.length >= 1);
});

test('a good AI plan is saved as written, and a broken or failing AI falls back to the rules', async () => {
  await loadLibrary();
  const aiModel = {
    async complete({ messages }) {
      const lines = messages[0].content.split('\n').filter((line) => /^\d+\|/.test(line));
      assert.ok(lines.length >= 20 && lines.length <= 240);
      const day = (name) => ({ name, exercises: [1, 2, 3, 4, 5].map((n) => ({ n, sets: 4, reps: '6-8', rest_seconds: 120, notes: 'AI note' })) });
      return { text: `Here you go:\n${JSON.stringify({ title: 'AI plan', description: 'Written by AI', days: [day('Day A'), day('Day B')] })}`, toolCalls: [] };
    },
  };
  const ai = await runJackAssistant({ action: 'generate_plan', body: { days: 2, goal: 'strength' }, userClient: as(ids.coach), model: aiModel });
  assert.deepEqual([ai.source, ai.title, ai.days.length], ['ai', 'AI plan', 2]);
  assert.equal((await rows("select notes from public.training_program_exercises where notes = 'AI note'")).length, 10);

  const garbage = await runJackAssistant({ action: 'generate_plan', body: { days: 2 }, userClient: as(ids.coach), model: { complete: async () => ({ text: 'sorry, no JSON', toolCalls: [] }) } });
  assert.equal(garbage.source, 'rules');
  const broken = await runJackAssistant({ action: 'generate_plan', body: { days: 2 }, userClient: as(ids.coach), model: { complete: async () => { throw new ModelError(502, 'down'); } } });
  assert.equal(broken.source, 'rules');
  assert.equal((await rows('select count(*)::int as n from public.training_programs'))[0].n, 3);
});

test('generation refuses when the library is empty and never saves half a plan', async () => {
  await assert.rejects(runJackAssistant({ action: 'generate_plan', body: { days: 3 }, userClient: as(ids.coach), model: null }), /too few exercises/);
  assert.equal((await rows('select count(*)::int as n from public.training_programs'))[0].n, 0);
  await assert.rejects(runJackAssistant({ action: 'dance', body: {}, userClient: as(ids.coach) }), /Choose generate_plan/);
});

async function seedClientHistory() {
  await loadLibrary(60);
  const [{ id: squat }] = await rows("select id from public.exercises where primary_muscles && array['quadriceps'] limit 1");
  await db.query("insert into public.client_intake_forms (client_id, primary_goal, experience_level, training_days_per_week, equipment_access) values ($1, 'fat_loss', 'beginner', 3, 'full_gym')", [ids.sara]);
  const session = async (daysAgo, weight) => {
    const [{ id }] = await rows("insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, current_date - $2::int, 'Workout') returning id", [ids.sara, daysAgo]);
    await db.query('insert into public.client_workout_set_logs (session_id, exercise_id, exercise_order, set_number, actual_reps, actual_weight_kg) values ($1, $2, 0, 1, 8, $3)', [id, squat, weight]);
  };
  for (const [daysAgo, weight] of [[50, 60], [40, 60], [20, 70], [10, 75], [3, 80]]) await session(daysAgo, weight);
  await db.query("insert into public.client_body_metrics (client_id, measured_on, weight_kg) values ($1, current_date - 25, 85), ($1, current_date - 1, 82.4)", [ids.sara]);
  await db.query("insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, calories) values ($1, current_date - 2, 'lunch', 'Rice', 600), ($1, current_date - 1, 'lunch', 'Rice', 800)", [ids.sara]);
  await db.query('insert into public.client_habit_logs (client_id, habit_date, sleep_hours, water_liters, steps) values ($1, current_date - 1, 6, 2.5, 9000), ($1, current_date - 2, 6.5, 3, 11000)', [ids.sara]);
  await db.query('insert into public.nutrition_targets (client_id, calories) values ($1, 2000)', [ids.sara]);
  return squat;
}

test('the coach sees the client\'s real numbers in one call, and nobody else may', async () => {
  await seedClientHistory();
  const { data, error } = await as(ids.coach).rpc('get_client_report_data', { p_client_id: ids.sara, p_days: 30 });
  assert.equal(error, null, error?.message);
  assert.deepEqual([data.days, data.stats.workouts, Number(data.stats.weight_change_kg), data.stats.food_days], [30, 3, -2.6, 2]);
  assert.equal(data.intake.primary_goal, 'fat_loss');
  assert.ok(Number(data.strength[0].best_now) > Number(data.strength[0].best_before));
  assert.equal(Number(data.habits.avg_water_liters), 2.8);
  assert.equal(data.nutrition_target.calories, 2000);
  for (const user of [ids.other, ids.sara]) assert.match((await as(user).rpc('get_client_report_data', { p_client_id: ids.sara, p_days: 30 })).error.message, /your own clients/);
});

test('the analysis lists what the numbers say, worst first, with changes to the plan', async () => {
  await seedClientHistory();
  const result = await runJackAssistant({ action: 'analyze_client', body: { client_id: ids.sara, days: 30, language: 'en' }, userClient: as(ids.coach), model: null });
  assert.equal(result.source, 'rules');
  const keys = result.findings.map((finding) => finding.key);
  assert.ok(keys.includes('weight') && keys.includes('strength') && keys.includes('sleep') && keys.includes('food'));
  assert.equal(result.findings[0].severity, 'warning');
  assert.ok(result.findings.find((finding) => finding.key === 'strength').text.includes('→'));
  assert.ok(result.recommendations.length >= 2);
  const arabic = await runJackAssistant({ action: 'analyze_client', body: { client_id: ids.sara, language: 'ar' }, userClient: as(ids.coach), model: null });
  assert.ok(arabic.findings.every((finding) => /[\u0600-\u06FF]/.test(finding.text)));
  await assert.rejects(runJackAssistant({ action: 'analyze_client', body: { client_id: ids.sara }, userClient: as(ids.other), model: null }), /own clients/);
  await assert.rejects(runJackAssistant({ action: 'analyze_client', body: { client_id: 'nope' }, userClient: as(ids.coach), model: null }), /Choose a client/);
});

test('the Arabic progress report is a real draft from real numbers, ready to edit and send', async () => {
  await seedClientHistory();
  const result = await runJackAssistant({ action: 'progress_report', body: { client_id: ids.sara, days: 30, language: 'ar' }, userClient: as(ids.coach), model: null });
  assert.deepEqual([result.source, result.language], ['rules', 'ar']);
  assert.match(result.text, /^مرحبًا Sara/);
  assert.match(result.text, /أنجزت 3 تمرينًا/);
  assert.match(result.text, /85 ← 82\.4 كجم/);
  assert.match(result.text, /القوة:/);
  assert.match(result.text, /60 → 80 kg|→/);
  assert.ok(result.text.length >= 20 && result.text.length <= 3000);
  const english = await runJackAssistant({ action: 'progress_report', body: { client_id: ids.sara, language: 'en' }, userClient: as(ids.coach), model: null });
  assert.match(english.text, /^Hi Sara,/);
  assert.match(english.text, /85 → 82\.4 kg/);
  // It can be stored as a progress report: the existing function accepts it.
  const saved = await as(ids.coach).rpc('save_progress_report', { p_client_id: ids.sara, p_days: 30, p_body: result.text });
  assert.equal(saved.error, null, saved.error?.message);
});

test('an AI report is used when its numbers are real, and replaced by the rule-based draft when it invents one', async () => {
  await seedClientHistory();
  const writer = (text) => ({ complete: async () => ({ text, toolCalls: [] }) });
  const honest = `مرحبًا Sara، أنجزتِ 3 تمرينات خلال 30 يومًا وانخفض وزنك من 85 إلى 82.4 كجم. استمري على هذا النهج وركّزي على النوم أكثر فهو عنصر مهم لنتائجك. ${'ممتاز. '.repeat(20)}`;
  const used = await runJackAssistant({ action: 'progress_report', body: { client_id: ids.sara, language: 'ar' }, userClient: as(ids.coach), model: writer(honest) });
  assert.deepEqual([used.source, used.text], ['ai', honest.trim()]);
  const invented = await runJackAssistant({ action: 'progress_report', body: { client_id: ids.sara, language: 'ar' }, userClient: as(ids.coach), model: writer(honest.replace('82.4', '71.9')) });
  assert.equal(invented.source, 'rules');
  assert.match(invented.text, /^مرحبًا Sara/);
  const failing = await runJackAssistant({ action: 'progress_report', body: { client_id: ids.sara }, userClient: as(ids.coach), model: { complete: async () => { throw new ModelError(504, 'slow'); } } });
  assert.equal(failing.source, 'rules');
});

test('a client with nothing logged gets an honest short report instead of invented praise', () => {
  const empty = { days: 30, stats: { first_name: 'Omar', workouts: 0, food_days: 0, tasks: { assigned: 0 } }, intake: null, strength: [], checkins: [], habits: { custom: [] } };
  const text = buildProgressReport(empty, { language: 'ar' });
  assert.match(text, /لا توجد بيانات كافية/);
  assert.doesNotMatch(text, /أنجزت/);
  assert.equal(analyzeClientRules(empty, { language: 'en' }).findings[0].key, 'workouts');
});

// ---------------------------------------------------------------------------------------- the screens

test('the endpoint is for active coaches, rate limited and keeps AI keys on the server', () => {
  const endpoint = read('api/jack-assistant.js');
  for (const piece of ["requireRole(userClient, 'coach')", 'createRateLimiter', 'resolveAssistantModel', 'runJackAssistant', 'ACTIONS']) assert.ok(endpoint.includes(piece), piece);
  for (const file of ['api/jack-assistant.js', 'api/_lib/jackAssistant.js', 'api/_lib/anthropicModel.js']) assert.doesNotMatch(read(file), /VITE_/, file);
  assert.match(read('vercel.json'), /"api\/jack-assistant\.js": \{ "maxDuration": 60 \}/);
  const env = read('.env.example');
  assert.match(env, /^ANTHROPIC_API_KEY=$/m);
  assert.doesNotMatch(env, /VITE_ANTHROPIC|VITE_OPENAI/);
});

test('the generator page, the client tab and Jack\'s button are connected to the assistant', () => {
  const service = read('src/services/aiService.js');
  for (const piece of ["'jack-assistant'", 'generate_plan', 'analyze_client', 'progress_report']) assert.ok(service.includes(piece), piece);
  const generator = read('src/pages/GeneratorPage.jsx');
  assert.match(generator, /generateTrainingPlan\(/);
  assert.doesNotMatch(generator, /AI_NOT_CONFIGURED/);
  assert.match(read('src/pages/ClientsPage.jsx'), /<ClientJackAssistant clientId=/);
  const assistant = read('src/components/ClientJackAssistant.jsx');
  for (const piece of ['draftProgressReport', 'analyzeClient', 'sendChatMessage', 'saveProgressReport', 'shareProgressReport']) assert.ok(assistant.includes(piece), piece);
  assert.match(read('src/components/JackDrawer.jsx'), /onOpenPage\('\/generator'\)/);
  assert.match(read('src/components/JackFloatingWidget.jsx'), /jaUnavailableCoach/);
});

test('every text of the assistant screens exists in every language, with the same placeholders', () => {
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  const used = new Set();
  for (const file of ['src/pages/GeneratorPage.jsx', 'src/components/ClientJackAssistant.jsx', 'src/components/JackDrawer.jsx', 'src/components/JackFloatingWidget.jsx', 'src/pages/ClientsPage.jsx']) {
    for (const match of read(file).matchAll(/['"`](ja[A-Z][A-Za-z]*|clientTabJack)['"`]/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 30, `${used.size} keys`);
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(jackAssistantTranslations[locale]).sort(), Object.keys(jackAssistantTranslations.en).sort(), locale);
    for (const key of used) assert.ok(translations[locale][key], `${locale}.${key}`);
    for (const key of Object.keys(jackAssistantTranslations.en)) assert.equal(placeholders(jackAssistantTranslations[locale][key]), placeholders(jackAssistantTranslations.en[key]), `${locale}.${key}`);
  }
  assert.match(translations.ar.jaCreateReport, /[\u0600-\u06FF]/);
  assert.match(translations.ar.generatorDescription, /Jack/);
});
