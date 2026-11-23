import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { progressionTranslations } from '../src/i18n/progressionTranslations.js';
import { sessionDates, startingWeight, suggestionNumbers, suggestionTextKey, targetFor, targetText } from '../src/services/progressionUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003400_progression_suggestions.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};

let db;
let squat;
let pushup;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function refused(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

// One logged session: `sets` is a list of [reps, weight].
async function session(client, daysAgo, exercise, sets) {
  const [{ id }] = await rows("insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, current_date - $2::int, 'Session') returning id", [client, daysAgo]);
  for (const [index, [reps, weight]] of sets.entries()) {
    await db.query('insert into public.client_workout_set_logs (session_id, exercise_id, exercise_order, set_number, actual_reps, actual_weight_kg) values ($1, $2, 0, $3, $4, $5)', [id, exercise, index + 1, reps, weight]);
  }
}
const threeSets = (reps, weight) => [[reps, weight], [reps, weight], [reps, weight]];
const refresh = (userId, clientId = null) => as(userId).rpc('refresh_progression_suggestions', { p_client_id: clientId });
const pending = (userId, clientId = null) => as(userId).rpc('list_progression_suggestions', { p_client_id: clientId, p_status: 'pending' });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; truncate public.exercises cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara Ali', 'sara@example.com'), ($3, $4, 'Omar Hassan', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
  [{ id: squat }] = await rows("insert into public.exercises (slug, name, category, difficulty, is_published, name_i18n) values ('squat', 'Squat', 'strength', 'beginner', true, '{\"ar\":\"سكوات\"}') returning id");
  [{ id: pushup }] = await rows("insert into public.exercises (slug, name, category, difficulty, is_published) values ('push-up', 'Push-up', 'strength', 'beginner', true) returning id");
  const [{ id: program }] = await rows("insert into public.training_programs (coach_id, title, status) values ($1, 'Strength', 'published') returning id", [ids.coach]);
  const [{ id: day }] = await rows("insert into public.training_program_days (program_id, name, order_index) values ($1, 'Day 1', 0) returning id", [program]);
  await db.query("insert into public.training_program_exercises (day_id, exercise_id, order_index, sets, reps) values ($1, $2, 0, 3, '8-12'), ($1, $3, 1, 3, '15')", [day, squat, pushup]);
  await db.query('insert into public.program_assignments (coach_id, client_id, program_id) values ($1, $2, $3)', [ids.coach, ids.sara, program]);
});

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('two sessions at the top of the repetitions give a weight suggestion: +5% rounded to 2.5 kg, never less than 2.5 kg', async () => {
  await session(ids.sara, 5, squat, threeSets(12, 60));
  await session(ids.sara, 2, squat, threeSets(12, 60));
  assert.equal(await ok(refresh(ids.coach)), 1);
  const [item] = await ok(pending(ids.coach));
  assert.deepEqual([item.client_name, item.exercise_name, item.kind, Number(item.current_weight_kg), Number(item.suggested_weight_kg), item.status], ['Sara Ali', 'Squat', 'weight', 60, 62.5, 'pending']);
  assert.deepEqual([item.reason.top_reps, item.reason.sets, item.reason.sessions.length, Number(item.reason.increase_kg)], [12, 3, 2, 2.5]);
  assert.equal(item.exercise_name_i18n.ar, 'سكوات');

  await db.exec('truncate public.progression_suggestions');
  await db.exec('truncate public.client_workout_sessions cascade');
  await session(ids.sara, 5, squat, threeSets(12, 100));
  await session(ids.sara, 2, squat, threeSets(12, 100));
  await ok(refresh(ids.coach));
  assert.equal(Number((await ok(pending(ids.coach)))[0].suggested_weight_kg), 105);
});

test('an exercise without weight gets two more repetitions instead', async () => {
  await session(ids.sara, 6, pushup, threeSets(15, null));
  await session(ids.sara, 3, pushup, threeSets(16, null));
  assert.equal(await ok(refresh(ids.coach, ids.sara)), 1);
  const [item] = await ok(pending(ids.coach, ids.sara));
  assert.deepEqual([item.exercise_name, item.kind, item.current_reps, item.suggested_reps, item.suggested_weight_kg], ['Push-up', 'reps', 15, 17, null]);
});

test('nothing is suggested without two good sessions: one session, a missed rep, too few sets or old sessions', async () => {
  await session(ids.sara, 2, squat, threeSets(12, 60));
  assert.equal(await ok(refresh(ids.coach)), 0, 'one session is not enough');
  await session(ids.sara, 4, squat, [[12, 60], [12, 60], [11, 60]]);
  assert.equal(await ok(refresh(ids.coach)), 0, 'a set below the top of the range');
  await db.exec('truncate public.client_workout_sessions cascade');
  await session(ids.sara, 4, squat, [[12, 60], [12, 60]]);
  await session(ids.sara, 2, squat, [[12, 60], [12, 60]]);
  assert.equal(await ok(refresh(ids.coach)), 0, 'two sets when three are planned');
  await db.exec('truncate public.client_workout_sessions cascade');
  await session(ids.sara, 80, squat, threeSets(12, 60));
  await session(ids.sara, 70, squat, threeSets(12, 60));
  assert.equal(await ok(refresh(ids.coach)), 0, 'sessions older than 60 days');
  assert.deepEqual(await ok(pending(ids.coach)), []);
});

test('lighter warm-up sets do not count; the working weight decides', async () => {
  await session(ids.sara, 5, squat, [[20, 20], [12, 80], [12, 80], [12, 80]]);
  await session(ids.sara, 2, squat, [[20, 20], [12, 82.5], [12, 82.5], [12, 82.5]]);
  await ok(refresh(ids.coach));
  const [item] = await ok(pending(ids.coach));
  assert.deepEqual([Number(item.current_weight_kg), Number(item.suggested_weight_kg)], [80, 85]);
});

test('running the check again does not repeat a suggestion that is still open', async () => {
  await session(ids.sara, 5, squat, threeSets(12, 60));
  await session(ids.sara, 2, squat, threeSets(12, 60));
  assert.equal(await ok(refresh(ids.coach)), 1);
  assert.equal(await ok(refresh(ids.coach)), 0);
  assert.equal((await ok(pending(ids.coach))).length, 1);
});

test('applying a suggestion sets the client\'s own target and leaves the shared program as it was', async () => {
  await session(ids.sara, 5, squat, threeSets(12, 60));
  await session(ids.sara, 2, squat, threeSets(12, 60));
  await ok(refresh(ids.coach));
  const [item] = await ok(pending(ids.coach));
  const decided = await ok(as(ids.coach).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: true }));
  assert.deepEqual([decided.status, decided.decided_by], ['applied', ids.coach]);
  assert.deepEqual(await ok(pending(ids.coach)), []);

  const targets = await ok(as(ids.sara).from('client_exercise_targets').select('exercise_id,target_weight_kg,target_reps'));
  assert.deepEqual(targets.map((row) => [row.exercise_id, Number(row.target_weight_kg), row.target_reps]), [[squat, 62.5, null]]);
  assert.equal((await rows("select reps from public.training_program_exercises where exercise_id = $1", [squat]))[0].reps, '8-12');
  await refused(as(ids.coach).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: false }), /already decided/);
});

test('dismissing keeps the plan, and a new suggestion needs two new sessions after the decision', async () => {
  await session(ids.sara, 5, squat, threeSets(12, 60));
  await session(ids.sara, 2, squat, threeSets(12, 60));
  await ok(refresh(ids.coach));
  const [item] = await ok(pending(ids.coach));
  const decided = await ok(as(ids.coach).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: false }));
  assert.equal(decided.status, 'dismissed');
  assert.deepEqual(await ok(as(ids.sara).from('client_exercise_targets').select('id')), []);
  assert.equal(await ok(refresh(ids.coach)), 0, 'the same two sessions do not count again');

  await db.query("update public.progression_suggestions set decided_at = now() - interval '4 days'");
  assert.equal(await ok(refresh(ids.coach)), 0, 'only one session came after the decision');
  await session(ids.sara, 1, squat, threeSets(12, 60));
  assert.equal(await ok(refresh(ids.coach)), 1, 'two sessions after the decision');
});

test('after an applied target, the next suggestion waits until the client lifts the new weight twice', async () => {
  await session(ids.sara, 9, squat, threeSets(12, 60));
  await session(ids.sara, 8, squat, threeSets(12, 60));
  await ok(refresh(ids.coach));
  const [first] = await ok(pending(ids.coach));
  await ok(as(ids.coach).rpc('decide_progression_suggestion', { p_suggestion_id: first.id, p_apply: true }));
  await db.query("update public.progression_suggestions set decided_at = now() - interval '7 days'");
  await session(ids.sara, 4, squat, threeSets(12, 60));
  await session(ids.sara, 3, squat, threeSets(12, 60));
  assert.equal(await ok(refresh(ids.coach)), 0, 'still lifting the old weight');
  await session(ids.sara, 2, squat, threeSets(12, 62.5));
  await session(ids.sara, 1, squat, threeSets(12, 62.5));
  assert.equal(await ok(refresh(ids.coach)), 1);
  assert.equal(Number((await ok(pending(ids.coach)))[0].suggested_weight_kg), 65);
});

test('only the coach side sees and decides, and nobody writes the tables directly', async () => {
  await session(ids.sara, 5, squat, threeSets(12, 60));
  await session(ids.sara, 2, squat, threeSets(12, 60));
  await ok(refresh(ids.coach));
  const [item] = await ok(pending(ids.coach));

  assert.deepEqual(await ok(pending(ids.other)), []);
  await refused(pending(ids.other, ids.sara), /own clients/);
  await refused(refresh(ids.other, ids.sara), /own clients/);
  await refused(as(ids.other).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: true }), /not found/);
  await refused(as(ids.sara).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: true }), /not found/);
  assert.equal(await ok(refresh(ids.sara)), 0, 'a client has nobody to look after');
  assert.deepEqual(await ok(as(ids.sara).from('progression_suggestions').select('id')), []);
  assert.equal((await ok(as(ids.coach).from('progression_suggestions').select('id'))).length, 1);
  assert.deepEqual(await ok(as(ids.other).from('progression_suggestions').select('id')), []);

  assert.ok((await as(ids.coach).sql("update public.progression_suggestions set status = 'applied'")).error);
  assert.ok((await as(ids.coach).sql("insert into public.client_exercise_targets (client_id, exercise_id, target_weight_kg) values ($1, $2, 100)", [ids.sara, squat])).error);
  assert.ok((await as(ids.sara).sql("insert into public.client_exercise_targets (client_id, exercise_id, target_weight_kg) values ($1, $2, 300)", [ids.sara, squat])).error);
  await ok(as(ids.coach).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: true }));
  assert.deepEqual(await ok(as(ids.omar).from('client_exercise_targets').select('id')), []);
  assert.equal((await ok(as(ids.coach).from('client_exercise_targets').select('id'))).length, 1);
});

test('an assistant trainer who may manage programs decides for their assigned clients only', async () => {
  await session(ids.sara, 5, squat, threeSets(12, 60));
  await session(ids.sara, 2, squat, threeSets(12, 60));
  const memberId = await ok(as(ids.coach).rpc('invite_trainer', {
    p_email: 'tina@example.com', p_role_title: 'Assistant', p_permissions: { manage_programs: true, view_assessments: false, messages: false, manage_groups: false },
  }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
  assert.equal(await ok(refresh(ids.trainer)), 0, 'no client is assigned yet');
  await ok(as(ids.coach).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: memberId }));
  assert.equal(await ok(refresh(ids.trainer)), 1);
  const [item] = await ok(pending(ids.trainer));
  const decided = await ok(as(ids.trainer).rpc('decide_progression_suggestion', { p_suggestion_id: item.id, p_apply: true }));
  assert.equal(decided.status, 'applied');
  const [target] = await rows('select coach_id from public.client_exercise_targets');
  assert.equal(target.coach_id, ids.coach);
});

// ------------------------------------------------------------------------------------- the numbers

test('a suggestion is read as "from, to, step" for the sentence', () => {
  assert.deepEqual(suggestionNumbers({ kind: 'weight', current_weight_kg: '60.00', suggested_weight_kg: '62.50' }), { kind: 'weight', from: '60', to: '62.5', step: '2.5' });
  assert.deepEqual(suggestionNumbers({ kind: 'reps', current_reps: 12, suggested_reps: 14 }), { kind: 'reps', from: '12', to: '14', step: '2' });
  assert.equal(suggestionTextKey({ kind: 'weight' }), 'pgWeightText');
  assert.equal(suggestionTextKey({ kind: 'reps' }), 'pgRepsText');
  assert.match(sessionDates({ reason: { sessions: ['2026-11-20', '2026-11-17'] } }, 'en'), /Nov 20, Nov 17/);
  assert.equal(sessionDates({ reason: {} }), '');
});

test('the client sees the target for an exercise and starts with that weight', () => {
  const targets = [{ exercise_id: 'e1', target_weight_kg: '62.50', target_reps: null }, { exercise_id: 'e2', target_weight_kg: null, target_reps: 14 }];
  const t = (key) => translations.en[key];
  assert.equal(targetText(targetFor(targets, 'e1'), t), 'Target: 62.5 kg');
  assert.equal(targetText(targetFor(targets, 'e2'), t), 'Target: 14 reps');
  assert.equal(targetFor(targets, 'nope'), null);
  assert.equal(targetText(null, t), '');
  assert.equal(startingWeight(targetFor(targets, 'e1')), '62.5');
  assert.equal(startingWeight(targetFor(targets, 'e2')), '');
  assert.equal(startingWeight(null), '');
});

// ---------------------------------------------------------------------------------------- the screens

test('suggestions appear on the dashboard and in each client\'s Progression tab, and the logger shows the target', () => {
  assert.match(read('src/pages/DashboardPage.jsx'), /<ProgressionSuggestions limit=\{5\} \/>/);
  const clients = read('src/pages/ClientsPage.jsx');
  assert.match(clients, /detailTab === 'progression'/);
  assert.match(clients, /<ProgressionSuggestions clientId=/);
  const component = read('src/components/ProgressionSuggestions.jsx');
  assert.match(component, /decideSuggestion\(item\.id, apply\)/);
  assert.match(component, /pgApply/);
  assert.match(component, /pgDismiss/);
  const logger = read('src/components/ClientWorkoutLogger.jsx');
  for (const piece of ['listMyExerciseTargets', 'targetText(entry.target, t)', 'startingWeight(target)']) assert.ok(logger.includes(piece), piece);
});

test('every progression text exists in every language with the same placeholders', () => {
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  const used = new Set(['clientTabProgression']);
  for (const file of ['src/components/ProgressionSuggestions.jsx', 'src/services/progressionUtils.js']) for (const match of read(file).matchAll(/['"`](pg[A-Z][A-Za-z]*)['"`]/g)) used.add(match[1]);
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(progressionTranslations[locale]).sort(), Object.keys(progressionTranslations.en).sort(), locale);
    for (const key of used) assert.ok(translations[locale][key], `${locale}.${key}`);
    for (const key of Object.keys(progressionTranslations.en)) assert.equal(placeholders(progressionTranslations[locale][key]), placeholders(progressionTranslations.en[key]), `${locale}.${key}`);
  }
  assert.match(translations.ar.pgWeightText, /[\u0600-\u06FF]/);
});
