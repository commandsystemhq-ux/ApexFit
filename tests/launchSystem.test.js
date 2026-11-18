import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../api/_lib/jackTools.js';
import { MAX_IMAGE_BASE64_CHARS, parseJackRequest } from '../api/_lib/jackAgent.js';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { createBedrockModel, createGeminiModel, createOpenAiModel, toConverseMessages } from '../api/_lib/jackModels.js';
import { translations } from '../src/i18n/translations.js';
import { PAGES, navigationFor } from '../src/routes.js';
import {
  averageRate, buildReportText, fillText, groupTasks, rateTone, reportShareText, sortByRate, validateTaskForm, whatsappUrl,
} from '../src/services/accountabilityUtils.js';
import { MAX_PHOTO_BYTES, fitWithin, photoProblem } from '../src/services/jackImage.js';
import {
  WRITE_TOOLS, conversationTitle, historyPayload, mealFromStep, messagesFromConversation, quickPromptKeys,
} from '../src/services/jackUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Jack's accountability, report and meal-photo tools, photo requests to every model, and the pure helpers behind the new pages.

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000a2',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
const TODAY = new Date().toISOString().slice(0, 10);
const PHOTO = { mime: 'image/jpeg', data: 'A'.repeat(400) };

let db;
const contextFor = (userId, role) => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today: TODAY, access: { role } });
const coach = () => contextFor(ids.coach, 'coach');
const client = (userId = ids.sara) => contextFor(userId, 'client');
const count = async (sql, params = []) => Number((await db.query(sql, params)).rows[0].n);

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'nour@example.com', role: 'coach', fullName: 'Coach Nour' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara Ali' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client', fullName: 'Omar Ali' });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_email, client_name) values ($1, $2, 'sara@example.com', 'Sara Ali')", [ids.coach, ids.sara]);
  await db.query("insert into public.coach_clients (coach_id, client_id, client_email, client_name) values ($1, $2, 'omar@example.com', 'Omar Ali')", [ids.other, ids.omar]);
});

// ------------------------------------------------------------------ Jack tools

test('Jack assigns a task for the coach, labelled as coming from Jack, and only to their own clients', async () => {
  const assigned = await executeTool('assign_task_to_client', { client: 'sara', title: 'Walk 8,000 steps', type: 'habit', xp: 30 }, coach());
  assert.equal(assigned.ok, true, assigned.error);
  assert.deepEqual([assigned.result.client, assigned.result.by, assigned.result.xp, assigned.result.type], ['Sara Ali', 'jack', 30, 'habit']);

  const stranger = await executeTool('assign_task_to_client', { client: 'omar', title: 'x', type: 'habit' }, coach());
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /No client matches/);

  for (const bad of [{ type: 'cardio' }, { xp: 500 }, { xp: 1.5 }, { due_date: 'tomorrow' }]) {
    const result = await executeTool('assign_task_to_client', { client: 'sara', title: 'Stretch', type: 'habit', ...bad }, coach());
    assert.equal(result.ok, false, JSON.stringify(bad));
  }
  assert.equal(await count('select count(*) as n from public.client_tasks'), 1);
});

test('the coach sees completion rates and one client\'s performance to suggest tasks', async () => {
  await executeTool('assign_task_to_client', { client: 'sara', title: 'Leg day', type: 'workout' }, coach());
  const open = await executeTool('assign_task_to_client', { client: 'sara', title: 'Log meals', type: 'habit' }, coach());
  const done = await executeTool('get_my_tasks', {}, client());
  const leg = done.result.open.find((task) => task.title === 'Leg day');
  await executeTool('complete_task', { task: 'leg day' }, client());
  assert.ok(leg && open.ok);

  const roster = await executeTool('get_client_accountability', {}, coach());
  assert.equal(roster.ok, true, roster.error);
  assert.deepEqual(roster.result.clients.map((row) => [row.client, row.completion_percent, row.done, row.assigned]), [['Sara Ali', 50, 1, 2]]);

  const detail = await executeTool('get_client_accountability', { client: 'Sara' }, coach());
  assert.equal(detail.ok, true, detail.error);
  assert.equal(detail.result.tasks.length, 2);
  assert.equal(detail.result.completion.rate, 50);
  assert.equal(detail.result.last_14_days.period_days, 14);

  assert.equal((await executeTool('get_client_accountability', { client: 'Omar' }, coach())).ok, false);
});

test('a client reads, completes and adds tasks through Jack and earns XP', async () => {
  await executeTool('assign_task_to_client', { client: 'sara', title: 'Drink 3 litres of water', type: 'habit', xp: 25 }, coach());
  const mine = await executeTool('get_my_tasks', {}, client());
  assert.equal(mine.ok, true, mine.error);
  assert.deepEqual([mine.result.open.length, mine.result.total_xp], [1, 0]);

  const completed = await executeTool('complete_task', { task: 'water' }, client());
  assert.equal(completed.ok, true, completed.error);
  assert.deepEqual([completed.result.status, completed.result.xp_earned], ['done', 25]);
  assert.equal((await executeTool('get_my_tasks', {}, client())).result.total_xp, 25);

  const reopened = await executeTool('complete_task', { task: 'water', done: false }, client());
  assert.deepEqual([reopened.result.status, reopened.result.xp_earned], ['pending', 0]);

  const own = await executeTool('add_my_task', { title: 'Stretch for 10 minutes', type: 'habit' }, client());
  assert.equal(own.ok, true, own.error);
  assert.deepEqual([own.result.by, own.result.xp], ['self', 5]);
  assert.equal((await executeTool('add_my_task', { title: 'x', type: 'dance' }, client())).ok, false);
  assert.equal((await executeTool('complete_task', { task: 'nothing like this' }, client())).ok, false);
});

test('tasks and reports of other clients stay out of reach', async () => {
  await executeTool('assign_task_to_client', { client: 'sara', title: 'Leg day', type: 'workout' }, coach());
  assert.deepEqual((await executeTool('get_my_tasks', {}, client(ids.omar))).result.open, []);
  assert.equal((await executeTool('complete_task', { task: 'leg' }, client(ids.omar))).ok, false);
  assert.equal((await executeTool('get_client_accountability', { client: 'Sara' }, contextFor(ids.other, 'coach'))).ok, false);
  assert.equal((await executeTool('generate_client_progress_report', { client: 'Sara' }, contextFor(ids.other, 'coach'))).ok, false);
});

test('Jack writes a progress report in two steps: numbers first, then the saved text', async () => {
  await db.query("insert into public.client_body_metrics (client_id, measured_on, weight_kg) values ($1, current_date - 20, 70), ($1, current_date - 1, 67.7)", [ids.sara]);
  await db.query("insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, current_date - 2, 'Push')", [ids.sara]);

  const first = await executeTool('generate_client_progress_report', { client: 'Sara', days: 30 }, coach());
  assert.equal(first.ok, true, first.error);
  assert.equal(first.result.stage, 'write_report');
  assert.deepEqual([first.result.stats.client, first.result.stats.workouts, first.result.stats.weight_change_kg], ['Sara', 1, -2.3]);
  assert.ok(!JSON.stringify(first.result).includes('@'), 'no email address in what the model sees');
  assert.equal(await count('select count(*) as n from public.progress_reports'), 0);

  const body = 'Sara lost 2.3 kg this month and trained consistently. Keep going!';
  const saved = await executeTool('generate_client_progress_report', { client: 'Sara', days: 30, body }, coach());
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.result.saved, true);
  assert.equal(await count('select count(*) as n from public.progress_reports where shared = false'), 1);

  assert.equal((await executeTool('generate_client_progress_report', { client: 'Sara', days: 3 }, coach())).ok, false);
  assert.equal((await executeTool('generate_client_progress_report', { client: 'Sara', body: 'too short' }, coach())).ok, false);
});

test('a client gets their own shareable report', async () => {
  const first = await executeTool('generate_my_progress_report', {}, client());
  assert.equal(first.result.stage, 'write_report');
  const saved = await executeTool('generate_my_progress_report', { body: 'I stayed consistent this month and I am proud of it.' }, client());
  assert.equal(saved.ok, true, saved.error);
  assert.equal(await count('select count(*) as n from public.progress_reports where shared = true and client_id = $1', [ids.sara]), 1);
});

test('Jack shows a meal estimate for the client to edit and never saves it by itself', async () => {
  const meal = { food_name: 'Grilled chicken with rice', meal_type: 'lunch', calories: 650, protein_g: 48, carbs_g: 70, fat_g: 18, ingredients: '150 g chicken, 1 cup rice' };
  const proposed = await executeTool('propose_meal_log', meal, client());
  assert.equal(proposed.ok, true, proposed.error);
  assert.equal(proposed.meta.meal.calories, 650);
  assert.equal(proposed.meta.meal.meal_type, 'lunch');
  assert.match(proposed.result.note, /Do not say it is already saved/);
  assert.equal(await count('select count(*) as n from public.client_food_logs'), 0);

  assert.equal((await executeTool('propose_meal_log', { ...meal, meal_type: 'brunch' }, client())).ok, false);
  assert.equal((await executeTool('propose_meal_log', { ...meal, calories: 99999 }, client())).ok, false);
  assert.equal((await executeTool('propose_meal_log', { meal_type: 'lunch', calories: 100 }, client())).ok, false);
});

test('log_meal saves exactly what the client gave, and earns food points', async () => {
  const saved = await executeTool('log_meal', { food_name: 'Oats with milk', meal_type: 'breakfast', calories: 320, protein_g: 14 }, client());
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual((await db.query('select food_name, calories::int as calories, logged_on::text as day from public.client_food_logs')).rows, [{ food_name: 'Oats with milk', calories: 320, day: TODAY }]);
  assert.equal(await count("select count(*) as n from public.point_events where source = 'food'"), 1);
  assert.equal((await executeTool('log_meal', { food_name: 'x', meal_type: 'lunch', calories: 100 }, client(ids.omar))).ok, true);
  assert.equal(await count('select count(*) as n from public.client_food_logs where client_id = $1', [ids.omar]), 1);
});

test('data-changing tools refresh the page and meal estimates do not', () => {
  for (const name of ['assign_task_to_client', 'generate_client_progress_report', 'complete_task', 'add_my_task', 'generate_my_progress_report', 'log_meal']) {
    assert.ok(WRITE_TOOLS.includes(name), name);
  }
  assert.equal(WRITE_TOOLS.includes('propose_meal_log'), false);
});

// ------------------------------------------------------------------ photos

const request = (extra = {}) => ({ messages: [{ role: 'user', content: 'What is this?' }], ...extra });

test('a photo is accepted only as a small JPEG, PNG or WebP and only on the newest message', () => {
  const ok = parseJackRequest(request({ image: PHOTO }));
  assert.equal(ok.hasImage, true);
  assert.deepEqual(ok.messages[0].image, PHOTO);
  assert.equal(parseJackRequest(request()).hasImage, false);
  assert.equal(parseJackRequest(request()).messages[0].image, undefined);

  const older = parseJackRequest({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], image: PHOTO });
  assert.deepEqual(older.messages.map((message) => Boolean(message.image)), [false, false, true]);

  for (const image of [
    { mime: 'image/gif', data: PHOTO.data },
    { mime: 'text/html', data: PHOTO.data },
    { mime: 'image/png', data: 'not base64 !!!'.repeat(20) },
    { mime: 'image/png', data: 'A'.repeat(10) },
    { mime: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1) },
    { mime: 'image/png' },
    'photo',
  ]) {
    assert.match(parseJackRequest(request({ image })).error, /JPEG, PNG or WebP/);
  }
});

function fakeFetch(body) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => body };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
}

const history = [{ role: 'user', content: 'Estimate this meal', image: { mime: 'image/jpeg', data: 'QUJD' } }];

test('OpenAI and Azure Foundry get the photo as an image_url part', async () => {
  const fetchImpl = fakeFetch({ choices: [{ message: { content: 'A chicken plate.' } }] });
  const model = createOpenAiModel({ apiKey: 'sk-test-key', fetchImpl });
  assert.equal((await model.complete({ system: 's', messages: history, tools: [] })).text, 'A chicken plate.');
  const user = fetchImpl.requests[0].body.messages[1];
  assert.deepEqual(user.content, [
    { type: 'text', text: 'Estimate this meal' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
  ]);

  await model.complete({ system: 's', messages: [{ role: 'user', content: 'plain' }], tools: [] });
  assert.equal(fetchImpl.requests[1].body.messages[1].content, 'plain');
});

test('Gemini gets the photo as inline data', async () => {
  const fetchImpl = fakeFetch({ candidates: [{ content: { parts: [{ text: 'Rice and chicken.' }] } }] });
  const model = createGeminiModel({ apiKey: 'gemini-test-key', fetchImpl });
  await model.complete({ system: 's', messages: history, tools: [] });
  assert.deepEqual(fetchImpl.requests[0].body.contents[0].parts, [
    { text: 'Estimate this meal' },
    { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } },
  ]);
});

test('Amazon Bedrock gets the photo as a Converse image block before the text', async () => {
  const turns = toConverseMessages(history, true);
  assert.deepEqual(turns[0].content, [
    { image: { format: 'jpeg', source: { bytes: 'QUJD' } } },
    { text: 'Estimate this meal' },
  ]);
  const png = toConverseMessages([{ role: 'user', content: 'x', image: { mime: 'image/png', data: 'QUJD' } }], false);
  assert.equal(png[0].content[0].image.format, 'png');

  const fetchImpl = fakeFetch({ output: { message: { content: [{ text: 'ok' }] } } });
  const model = createBedrockModel({ region: 'us-east-1', model: 'amazon.nova-pro-v1:0', accessKeyId: 'AKIDEXAMPLE1234', secretAccessKey: 'secretsecretsecret', fetchImpl });
  await model.complete({ system: 's', messages: history, tools: [] });
  assert.equal(fetchImpl.requests[0].body.messages[0].content[0].image.format, 'jpeg');
});

test('the client is told how to handle meal photos, the coach is not', () => {
  const asClient = buildSystemPrompt({ role: 'client', locale: 'en', route: PAGES.food.path, today: TODAY });
  assert.match(asClient, /propose_meal_log/);
  assert.match(asClient, /never say the meal is saved/);
  const asCoach = buildSystemPrompt({ role: 'coach', locale: 'en', route: PAGES.dashboard.path, today: TODAY });
  assert.doesNotMatch(asCoach, /propose_meal_log|Meal photos/);
  assert.match(asCoach, new RegExp(PAGES.tasks.path));
  assert.doesNotMatch(asClient, new RegExp(`\\(${PAGES.tasks.path}\\)`));
  assert.match(asClient, new RegExp(PAGES.myTasks.path));
  assert.doesNotMatch(asCoach, new RegExp(`\\(${PAGES.myTasks.path}\\)`));
});

// ------------------------------------------------------------------ browser helpers

test('photo files are checked and shrunk without distortion', () => {
  assert.equal(photoProblem({ type: 'image/png', size: 1000 }), '');
  assert.equal(photoProblem({ type: 'image/gif', size: 1000 }), 'jackPhotoType');
  assert.equal(photoProblem(null), 'jackPhotoType');
  assert.equal(photoProblem({ type: 'image/jpeg', size: MAX_PHOTO_BYTES + 1 }), 'jackPhotoSize');
  assert.deepEqual(fitWithin(4000, 3000), { width: 1024, height: 768 });
  assert.deepEqual(fitWithin(600, 800), { width: 600, height: 800 });
  assert.deepEqual(fitWithin(2000, 4000, 1000), { width: 500, height: 1000 });
  assert.deepEqual(fitWithin(0, 100), { width: 0, height: 0 });
});

test('chat history helpers keep titles short, photos out and the meal card in the live chat', () => {
  assert.equal(conversationTitle('  Hello   world\nsecond line'), 'Hello world');
  assert.equal(conversationTitle('x'.repeat(100)).length, 60);
  assert.equal(conversationTitle(''), '');
  assert.deepEqual(historyPayload({ text: 'Is this ok?', hasImage: true, previewUrl: 'data:image/jpeg;base64,AAAA' }, { text: 'Yes' }), [
    { role: 'user', content: 'Is this ok?', has_image: true },
    { role: 'assistant', content: 'Yes', has_image: false },
  ]);
  const restored = messagesFromConversation({ id: 'c1', messages: [{ role: 'user', content: 'Hi', has_image: true }, { role: 'system', content: 'x' }, { role: 'assistant', content: 'Hello' }] });
  assert.deepEqual(restored.map((message) => [message.role, message.text, message.hasImage, message.pending]), [['user', 'Hi', true, false], ['assistant', 'Hello', false, false]]);
  assert.deepEqual(messagesFromConversation(null), []);

  const meal = { food_name: 'Salad', calories: 200 };
  assert.deepEqual(mealFromStep({ tool: 'propose_meal_log', status: 'done', detail: { meal } }), meal);
  assert.equal(mealFromStep({ tool: 'propose_meal_log', status: 'running', detail: null }), null);
  assert.equal(mealFromStep({ tool: 'log_meal', status: 'done', detail: { meal } }), null);
});

test('suggested questions match the page and role', () => {
  assert.ok(quickPromptKeys('coach', PAGES.tasks.path).includes('jackQ_coachSuggestTasks'));
  assert.ok(quickPromptKeys('client', PAGES.myTasks.path).includes('jackQ_clientTasks'));
  assert.ok(quickPromptKeys('client', PAGES.food.path).includes('jackQ_clientMealPhoto'));
  for (const [role, path] of [['coach', PAGES.tasks.path], ['coach', PAGES.dashboard.path], ['client', PAGES.myTasks.path], ['client', PAGES.food.path], ['client', PAGES.progress.path]]) {
    for (const key of quickPromptKeys(role, path)) assert.ok(translations.en[key], key);
  }
});

test('the new pages are in the right navigation', () => {
  const ids = (role) => navigationFor(role).flatMap((group) => group.items);
  assert.ok(ids('coach').includes('tasks'));
  assert.equal(ids('coach').includes('myTasks'), false);
  assert.ok(ids('client').includes('myTasks'));
  assert.equal(ids('client').includes('tasks'), false);
  assert.equal(ids('trainer').includes('tasks'), false);
  assert.equal(PAGES.tasks.access, 'coach');
  assert.equal(PAGES.myTasks.access, 'client');
});

// ------------------------------------------------------------------ pure helpers

test('the task form is validated for coaches and, more strictly, for clients', () => {
  const form = { kind: 'workout', title: '  Leg day ', description: '', dueDate: TODAY, xp: '30' };
  const ok = validateTaskForm(form, TODAY);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.payload, { kind: 'workout', title: 'Leg day', description: '', dueDate: TODAY, xp: 30 });

  assert.equal(validateTaskForm({ ...form, title: ' ' }, TODAY).errors.title, 'taskErrorTitle');
  assert.equal(validateTaskForm({ ...form, kind: 'dance' }, TODAY).errors.kind, 'taskErrorKind');
  assert.equal(validateTaskForm({ ...form, xp: '101' }, TODAY).errors.xp, 'taskErrorXp');
  assert.equal(validateTaskForm({ ...form, xp: '2.5' }, TODAY).errors.xp, 'taskErrorXp');
  assert.equal(validateTaskForm({ ...form, dueDate: '2099-01-01' }, TODAY).errors.dueDate, 'taskErrorDue');
  assert.equal(validateTaskForm({ ...form, description: 'x'.repeat(501) }, TODAY).errors.description, 'taskErrorDescription');

  const soon = new Date(Date.parse(`${TODAY}T12:00:00Z`) + 20 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(validateTaskForm({ ...form, dueDate: soon }, TODAY).valid, true);
  assert.equal(validateTaskForm({ ...form, dueDate: soon }, TODAY, { self: true }).errors.dueDate, 'taskErrorDueSelf');
  assert.equal(validateTaskForm({ ...form, xp: '9999' }, TODAY, { self: true }).valid, true);
});

test('tasks are grouped and completion rates summarised', () => {
  const tasks = [
    { id: 1, status: 'pending', is_overdue: true },
    { id: 2, status: 'pending', is_overdue: false },
    { id: 3, status: 'done', is_overdue: false },
  ];
  const grouped = groupTasks(tasks);
  assert.deepEqual([grouped.overdue.length, grouped.open.length, grouped.done.length], [1, 1, 1]);

  assert.deepEqual(['good', 'warn', 'low', 'none'].map((tone, index) => rateTone([90, 50, 10, null][index]) === tone), [true, true, true, true]);
  assert.equal(averageRate([{ rate: 100 }, { rate: 50 }, { rate: null }]), 75);
  assert.equal(averageRate([{ rate: null }]), null);
  assert.deepEqual(sortByRate([{ client_name: 'B', rate: 80 }, { client_name: 'A', rate: null }, { client_name: 'C', rate: 20 }]).map((row) => row.client_name), ['C', 'B', 'A']);
  assert.equal(fillText('{done} of {n} done, {missing}', { done: 2, n: 5 }), '2 of 5 done, {missing}');
});

const STATS = {
  first_name: 'Sara', period_days: 30, workouts: 12, volume_kg: 18400, weight_change_kg: '-2.3', weight_end_kg: '67.7', body_fat_change: '-1.2',
  food_days: 20, avg_calories: '1850', avg_sleep_hours: '7.4', avg_steps: '9100',
  tasks: { assigned: 10, done: 8, rate: 80, xp_period: 240 },
};

test('the quick report is written from the numbers in every language', () => {
  const english = buildReportText(STATS, (key) => translations.en[key]);
  assert.match(english, /^Sara: progress over the last 30 days/);
  for (const part of ['12 workouts completed', '18,400 kg lifted', 'Down 2.3 kg', 'Body fat down 1.2 points', '20 days (about 1850 kcal a day)', 'Average sleep: 7.4 hours', '9,100 steps a day', '8 of 10 tasks completed (80%)', '240 XP earned']) {
    assert.ok(english.includes(part), part);
  }
  assert.ok(english.endsWith('Keep going, every day counts!'));
  assert.doesNotMatch(english, /\{\w+\}/);

  for (const locale of ['ar', 'de', 'fr', 'es']) {
    const text = buildReportText(STATS, (key) => translations[locale][key]);
    assert.ok(text.includes('Sara'), locale);
    assert.doesNotMatch(text, /\{\w+\}/, locale);
    assert.ok(text.split('\n').filter((line) => line.startsWith('\u2022')).length >= 8, locale);
  }

  const gained = buildReportText({ ...STATS, weight_change_kg: '1.4' }, (key) => translations.en[key]);
  assert.match(gained, /Up 1\.4 kg/);
  const steady = buildReportText({ ...STATS, weight_change_kg: '0.0', weight_end_kg: '70' }, (key) => translations.en[key]);
  assert.match(steady, /Weight steady at 70 kg/);
});

test('a report with no activity says so kindly instead of listing zeros', () => {
  const empty = buildReportText({ first_name: '', period_days: 7, workouts: 0, tasks: { assigned: 0 } }, (key) => translations.en[key]);
  assert.match(empty, /^My progress, last 7 days/);
  assert.match(empty, /Not much was logged/);
  assert.doesNotMatch(empty, /\u2022/);
});

test('shared text carries the report, the hashtag and the app link, and nothing private', () => {
  const text = reportShareText('  Sara lost 2.3 kg!  ', 'https://apexfit.example');
  assert.equal(text, 'Sara lost 2.3 kg!\n\n#ApexFit\nhttps://apexfit.example');
  assert.equal(reportShareText('Hi'), 'Hi\n\n#ApexFit');
  assert.ok(whatsappUrl(text).startsWith('https://wa.me/?text=Sara%20lost'));
});

test('every new text has the same placeholders in all five languages', () => {
  const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  const keys = Object.keys(translations.en).filter((key) => /^(rpt|task|jackMeal|jackHistory|jackPhoto)/.test(key));
  assert.ok(keys.length > 80);
  for (const key of keys) {
    for (const locale of ['ar', 'de', 'fr', 'es']) {
      assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale}.${key}`);
    }
  }
  for (const tool of ['get_client_accountability', 'assign_task_to_client', 'generate_client_progress_report', 'get_my_tasks', 'complete_task', 'add_my_task', 'generate_my_progress_report', 'propose_meal_log', 'log_meal']) {
    for (const locale of ['en', 'ar', 'de', 'fr', 'es']) {
      assert.ok(translations[locale][`jackTool_${tool}_running`] && translations[locale][`jackTool_${tool}_done`], `${locale} ${tool}`);
    }
  }
});
