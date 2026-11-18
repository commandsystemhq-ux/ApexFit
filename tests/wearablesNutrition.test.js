import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeTool, toolSpecsForRole } from '../api/_lib/jackTools.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Migration 1400 in an in-process Postgres. Every call goes through the "authenticated" role as one user,
// so row-level security, column grants and function permissions are genuinely enforced.

const MIGRATION = new URL('../supabase/migrations/20261115001400_wearables_nutrition.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  bFan: '00000000-0000-4000-8000-0000000000c4',
};
const ALL = { manage_programs: true, view_assessments: true, messages: true, manage_groups: true };

let db;
let today;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);
const day = (offset) => rows('select (current_date + $1::integer)::text as d', [offset]).then((result) => result[0].d);

async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function fails(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

async function activeTrainer({ permissions = ALL, assign = [ids.sara] } = {}) {
  const memberId = await ok(as(ids.coachA).rpc('invite_trainer', { p_email: 'tina@example.com', p_role_title: 'Assistant', p_permissions: permissions }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
  for (const clientId of assign) await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: clientId, p_member_id: memberId }));
}

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  today = await day(0);
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina Trainer' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.bFan, 'b@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name) values
       ($1, $2, 'Sara Ali', 'sara@example.com', 'Amal Strength'), ($1, $3, 'Omar Hassan', 'omar@example.com', 'Amal Strength'),
       ($4, $5, 'Bea Fan', 'b@example.com', 'Coach Ben')`,
    [ids.coachA, ids.sara, ids.omar, ids.coachB, ids.bFan],
  );
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

// -------------------------------------------------------------- wearable data

const save = (userId, provider, metrics) => as(userId).rpc('save_wearable_metrics', { p_provider: provider, p_metrics: metrics });

test('a client saves Apple Health days; saving a day again updates it without duplicates', async () => {
  const yesterday = await day(-1);
  const result = await ok(save(ids.sara, 'apple_health', [
    { date: yesterday, steps: 8200.4, active_calories: 410, sleep_minutes: 430, resting_heart_rate: 58, hrv_ms: 61.234, recovery_score: 80 },
    { date: today, steps: 1000 },
  ]));
  assert.equal(result.saved, 2);
  const [saved] = await rows('select * from public.wearable_daily_metrics where client_id = $1 and recorded_date = $2', [ids.sara, yesterday]);
  assert.deepEqual([saved.steps, saved.active_calories, saved.sleep_minutes, saved.resting_heart_rate, Number(saved.hrv_ms), saved.recovery_score], [8200, 410, 430, 58, 61.23, 80]);

  // A later file with the same day replaces the numbers it has and keeps the ones it does not.
  await ok(save(ids.sara, 'apple_health', [{ date: yesterday, steps: 9000 }]));
  assert.equal(await count('select count(*) as n from public.wearable_daily_metrics where client_id = $1 and provider = $2', [ids.sara, 'apple_health']), 2);
  const [updated] = await rows('select steps, sleep_minutes from public.wearable_daily_metrics where client_id = $1 and recorded_date = $2', [ids.sara, yesterday]);
  assert.deepEqual(updated, { steps: 9000, sleep_minutes: 430 });

  const connection = await rows("select status from public.wearable_connections where client_id = $1 and provider = 'apple_health'", [ids.sara]);
  assert.deepEqual(connection, [{ status: 'connected' }]);
});

test('the same day can come from several providers, and only one row exists per provider and day', async () => {
  await ok(save(ids.sara, 'apple_health', [{ date: today, steps: 5000 }]));
  await ok(save(ids.sara, 'manual', [{ date: today, steps: 5200, sleep_minutes: 400 }]));
  assert.equal(await count('select count(*) as n from public.wearable_daily_metrics where client_id = $1 and recorded_date = $2', [ids.sara, today]), 2);
  await assert.rejects(db.query("insert into public.wearable_daily_metrics (client_id, recorded_date, provider, steps) values ($1, $2, 'apple_health', 1)", [ids.sara, today]), /duplicate key|unique/);
});

test('metrics are validated and only Apple Health or manual data can be written by the app', async () => {
  await fails(save(ids.sara, 'fitbit', [{ date: today, steps: 1 }]), /Only Apple Health/);
  await fails(save(ids.sara, 'oura', [{ date: today, steps: 1 }]), /Only Apple Health/);
  await fails(save(ids.sara, 'garmin', [{ date: today, steps: 1 }]), /Only Apple Health/);
  await fails(save(ids.sara, 'apple_health', []), /between 1 and 400/);
  await fails(save(ids.sara, 'apple_health', Array.from({ length: 401 }, () => ({ date: today, steps: 1 }))), /between 1 and 400/);
  await fails(save(ids.sara, 'apple_health', [{ date: today }]), /at least one value/);
  await fails(save(ids.sara, 'apple_health', [{ date: today, steps: -1 }]), /steps must be between/);
  await fails(save(ids.sara, 'apple_health', [{ date: today, resting_heart_rate: 5 }]), /resting_heart_rate must be between/);
  await fails(save(ids.sara, 'apple_health', [{ date: today, steps: 'many' }]), /steps must be a number/);
  await fails(save(ids.sara, 'apple_health', [{ date: '2026-02-31', steps: 1 }]), /real date/);
  await fails(save(ids.sara, 'apple_health', [{ date: await day(30), steps: 1 }]), /outside the allowed range/);
  await fails(save(ids.sara, 'apple_health', [{ steps: 1 }]), /date/);
  await fails(save(ids.coachA, 'manual', [{ date: today, steps: 1 }]), /client account/);
  assert.equal(await count('select count(*) as n from public.wearable_daily_metrics'), 0);
});

test('the client cannot write the tables directly', async () => {
  await ok(save(ids.sara, 'apple_health', [{ date: today, steps: 100 }]));
  const refused = [
    "insert into public.wearable_connections (client_id, provider, status) values ('" + ids.omar + "', 'apple_health', 'connected')",
    "insert into public.wearable_daily_metrics (client_id, recorded_date, provider, steps) values ('" + ids.sara + "', current_date, 'manual', 1)",
    "insert into public.nutrition_daily_logs (client_id, log_date, source, calories_consumed) values ('" + ids.sara + "', current_date, 'manual', 1)",
    "insert into public.nutrition_targets (client_id, calories) values ('" + ids.sara + "', 2000)",
    "update public.wearable_connections set status = 'disconnected'",
    "delete from public.wearable_connections",
    "delete from public.wearable_daily_metrics",
  ];
  for (const statement of refused) assert.ok((await as(ids.sara).sql(statement)).error, statement);
  assert.equal(await count('select count(*) as n from public.wearable_connections'), 1);
  assert.equal((await rows('select status from public.wearable_connections'))[0].status, 'connected');
});

test('only Apple Health and manual numbers exist: no outside accounts, no tokens, no server-side sync', async () => {
  assert.deepEqual(await rows("select column_name from information_schema.columns where table_name in ('wearable_connections', 'wearable_daily_metrics') and column_name ~ 'token|external|raw_'"), []);
  assert.equal(await count("select count(*) as n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('service_save_wearable_metrics')"), 0);
  assert.equal(await count("select count(*) as n from pg_proc where proname = 'wearable_metrics_upsert' and pronargs = 4"), 0);
  // Even the database owner cannot store a number from a service that is gone.
  for (const provider of ['fitbit', 'garmin', 'oura']) {
    await assert.rejects(db.query("insert into public.wearable_daily_metrics (client_id, recorded_date, provider, steps) values ($1, current_date, $2, 1)", [ids.sara, provider]), /check/, provider);
    await assert.rejects(db.query("insert into public.wearable_connections (client_id, provider, status) values ($1, $2, 'connected')", [ids.sara, provider]), /check/, provider);
  }
  await fails(as(ids.sara).rpc('service_save_wearable_metrics', { p_client_id: ids.sara, p_provider: 'fitbit', p_metrics: [{ date: today, steps: 1 }] }), /does not exist|Could not find|function/i);
});

test('deleting Apple Health data removes the days and the connection', async () => {
  await ok(save(ids.sara, 'apple_health', [{ date: today, steps: 100 }]));
  await ok(save(ids.sara, 'manual', [{ date: today, sleep_minutes: 400 }]));
  const result = await ok(as(ids.sara).rpc('delete_my_wearable_data', { p_provider: 'apple_health' }));
  assert.equal(result.deleted, 1);
  assert.equal(await count("select count(*) as n from public.wearable_connections where provider = 'apple_health'"), 0);
  assert.equal(await count("select count(*) as n from public.wearable_daily_metrics where provider = 'manual'"), 1, 'other sources stay');
  await fails(as(ids.sara).rpc('delete_my_wearable_data', { p_provider: 'whoop' }), /Unsupported/);
});

// ------------------------------------------------------------------ nutrition

const log = (userId, o = {}) => {
  const pick = (key, fallback) => (key in o ? o[key] : fallback);
  return as(userId).rpc('save_nutrition_log', {
    p_date: pick('date', today), p_calories: pick('calories', 2100), p_protein: pick('protein', 150), p_carbs: pick('carbs', 230),
    p_fats: pick('fats', 70), p_water_ml: pick('water', 2500), p_notes: pick('notes', null),
  });
};

test('typing the day replaces the typed entry instead of adding another', async () => {
  await ok(log(ids.sara, { notes: '  rest day  ' }));
  await ok(log(ids.sara, { calories: 1900, protein: null, carbs: null, fats: null, water: null }));
  const stored = await rows("select calories_consumed, protein_g, water_ml, notes, source from public.nutrition_daily_logs where client_id = $1 and log_date = $2", [ids.sara, today]);
  assert.deepEqual(stored, [{ calories_consumed: 1900, protein_g: null, water_ml: null, notes: null, source: 'manual' }]);

  await ok(log(ids.sara, { notes: '  rest day  ' }));
  assert.equal((await rows('select notes from public.nutrition_daily_logs where client_id = $1', [ids.sara]))[0].notes, 'rest day');
});

test('nutrition input is validated', async () => {
  await fails(log(ids.sara, { date: await day(5) }), /not in the future/);
  await fails(log(ids.sara, { calories: null, protein: null, carbs: null, fats: null, water: null }), /at least one value/);
  await fails(log(ids.sara, { calories: 20001 }), /Calories/);
  await fails(log(ids.sara, { protein: -1 }), /Protein/);
  await fails(log(ids.sara, { carbs: 3001 }), /Carbs/);
  await fails(log(ids.sara, { fats: 2001 }), /Fats/);
  await fails(log(ids.sara, { water: 20001 }), /Water/);
  await fails(log(ids.sara, { notes: 'x'.repeat(501) }), /500/);
  await fails(log(ids.coachA), /client account/);
  assert.equal(await count('select count(*) as n from public.nutrition_daily_logs'), 0);
});

test('MyFitnessPal days import once per day and the typed entry lives next to them', async () => {
  const days = [
    { log_date: await day(-2), calories_consumed: 2000, protein_g: 140.5, carbs_g: 210, fats_g: 65 },
    { log_date: await day(-1), calories_consumed: 2300, protein_g: 160, carbs_g: 250, fats_g: 80, water_ml: 2000 },
  ];
  assert.equal((await ok(as(ids.sara).rpc('import_nutrition_logs', { p_logs: days }))).imported, 2);
  // Importing the same file again corrects the days; it does not duplicate them.
  await ok(as(ids.sara).rpc('import_nutrition_logs', { p_logs: [{ ...days[0], calories_consumed: 2050 }] }));
  assert.equal(await count("select count(*) as n from public.nutrition_daily_logs where source = 'myfitnesspal_csv'"), 2);
  assert.equal((await rows("select calories_consumed from public.nutrition_daily_logs where log_date = $1", [days[0].log_date]))[0].calories_consumed, 2050);

  await ok(log(ids.sara, { date: days[0].log_date, calories: 1800 }));
  const sources = await rows('select source from public.nutrition_daily_logs where log_date = $1 order by source', [days[0].log_date]);
  assert.deepEqual(sources.map((row) => row.source), ['manual', 'myfitnesspal_csv']);

  await fails(as(ids.sara).rpc('import_nutrition_logs', { p_logs: [] }), /between 1 and 400/);
  await fails(as(ids.sara).rpc('import_nutrition_logs', { p_logs: [{ log_date: today }] }), /at least one value/);
  await fails(as(ids.sara).rpc('import_nutrition_logs', { p_logs: [{ log_date: today, calories_consumed: 99999 }] }), /calories/i);
  await fails(as(ids.coachA).rpc('import_nutrition_logs', { p_logs: days }), /client account/);
});

test('an imported day keeps the calorie goal that was set when it was imported', async () => {
  await ok(as(ids.sara).rpc('set_my_nutrition_targets', { p_calories: 2200, p_protein: 150, p_carbs: 240, p_fats: 70 }));
  await ok(as(ids.sara).rpc('import_nutrition_logs', { p_logs: [{ log_date: await day(-1), calories_consumed: 2000 }] }));
  await ok(as(ids.sara).rpc('set_my_nutrition_targets', { p_calories: 1800, p_protein: null, p_carbs: null, p_fats: null }));
  assert.equal((await rows('select target_calories from public.nutrition_daily_logs where client_id = $1', [ids.sara]))[0].target_calories, 2200);
});

test('a typed entry can be deleted, but only your own and only if it exists', async () => {
  await ok(log(ids.sara));
  await fails(as(ids.omar).rpc('delete_nutrition_log', { p_date: today, p_source: 'manual' }), /not found/);
  assert.equal(await count('select count(*) as n from public.nutrition_daily_logs'), 1);
  await ok(as(ids.sara).rpc('delete_nutrition_log', { p_date: today, p_source: 'manual' }));
  assert.equal(await count('select count(*) as n from public.nutrition_daily_logs'), 0);
});

test('nutrition goals can be set by the client and the coach, validated, and cleared', async () => {
  await ok(as(ids.sara).rpc('set_my_nutrition_targets', { p_calories: 2200, p_protein: 150, p_carbs: 240, p_fats: 70 }));
  await ok(as(ids.coachA).rpc('set_client_nutrition_targets', { p_client_id: ids.sara, p_calories: 2400, p_protein: 170, p_carbs: null, p_fats: null }));
  const [targets] = await rows('select calories, protein_g, carbs_g, set_by from public.nutrition_targets where client_id = $1', [ids.sara]);
  assert.deepEqual([targets.calories, Number(targets.protein_g), targets.carbs_g, targets.set_by], [2400, 170, null, ids.coachA]);

  await fails(as(ids.sara).rpc('set_my_nutrition_targets', { p_calories: 100, p_protein: null, p_carbs: null, p_fats: null }), /between 500 and 10000/);
  await fails(as(ids.coachB).rpc('set_client_nutrition_targets', { p_client_id: ids.sara, p_calories: 2000, p_protein: null, p_carbs: null, p_fats: null }), /not found/);
  await fails(as(ids.sara).rpc('set_client_nutrition_targets', { p_client_id: ids.sara, p_calories: 2000, p_protein: null, p_carbs: null, p_fats: null }), /not found/);
  assert.equal((await rows('select calories from public.nutrition_targets where client_id = $1', [ids.sara]))[0].calories, 2400);

  await ok(as(ids.sara).rpc('set_my_nutrition_targets', { p_calories: null, p_protein: null, p_carbs: null, p_fats: null }));
  assert.equal(await count('select count(*) as n from public.nutrition_targets'), 0);
});

// ----------------------------------------------------------------------- RLS

async function seedBoth(clientId) {
  await ok(save(clientId, 'apple_health', [{ date: today, steps: 4000, sleep_minutes: 420 }]));
  await ok(log(clientId));
  await ok(as(clientId).rpc('set_my_nutrition_targets', { p_calories: 2200, p_protein: null, p_carbs: null, p_fats: null }));
}

test('clients read their own data; their coach reads it; other coaches and clients cannot', async () => {
  await seedBoth(ids.sara);
  await seedBoth(ids.bFan);

  const own = await ok(as(ids.sara).rpc('get_health_overview', { p_client_id: null, p_days: 7 }));
  assert.equal(own.client_id, ids.sara);
  assert.equal(own.metrics.length, 1);
  assert.equal(own.nutrition.logs.length, 1);
  assert.equal(own.nutrition.targets.calories, 2200);
  assert.deepEqual(own.connections.map((item) => item.provider), ['apple_health']);
  assert.ok(!JSON.stringify(own).includes('token'));

  const asCoach = await ok(as(ids.coachA).rpc('get_health_overview', { p_client_id: ids.sara, p_days: 7 }));
  assert.equal(asCoach.metrics[0].steps, 4000);

  await fails(as(ids.coachA).rpc('get_health_overview', { p_client_id: ids.bFan, p_days: 7 }), /not found/);
  await fails(as(ids.coachB).rpc('get_health_overview', { p_client_id: ids.sara, p_days: 7 }), /not found/);
  await fails(as(ids.omar).rpc('get_health_overview', { p_client_id: ids.sara, p_days: 7 }), /not found/);

  assert.deepEqual((await ok(as(ids.sara).from('wearable_daily_metrics').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  assert.deepEqual((await ok(as(ids.coachA).from('wearable_daily_metrics').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  assert.deepEqual((await ok(as(ids.coachA).from('nutrition_daily_logs').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  assert.deepEqual((await ok(as(ids.coachB).from('nutrition_targets').select('client_id'))).map((row) => row.client_id), [ids.bFan]);
  assert.equal((await ok(as(ids.omar).from('nutrition_daily_logs').select('client_id'))).length, 0);
});

test('a coach cannot read a client who was archived', async () => {
  await seedBoth(ids.sara);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  await fails(as(ids.coachA).rpc('get_health_overview', { p_client_id: ids.sara, p_days: 7 }), /not found/);
  assert.equal((await ok(as(ids.coachA).from('wearable_daily_metrics').select('client_id'))).length, 0);
});

test('an assistant trainer sees only assigned clients, and only with the assessment permission', async () => {
  await seedBoth(ids.sara);
  await seedBoth(ids.omar);
  await activeTrainer({ assign: [ids.sara] });

  const seen = await ok(as(ids.trainer).rpc('get_health_overview', { p_client_id: ids.sara, p_days: 7 }));
  assert.equal(seen.metrics.length, 1);
  await fails(as(ids.trainer).rpc('get_health_overview', { p_client_id: ids.omar, p_days: 7 }), /not found/);
  assert.deepEqual((await ok(as(ids.trainer).from('nutrition_daily_logs').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  await fails(as(ids.trainer).rpc('set_client_nutrition_targets', { p_client_id: ids.sara, p_calories: 2000, p_protein: null, p_carbs: null, p_fats: null }), /not found/);

  await db.query("update public.coach_team_members set permissions = jsonb_set(permissions, '{view_assessments}', 'false') where trainer_user_id = $1", [ids.trainer]);
  await fails(as(ids.trainer).rpc('get_health_overview', { p_client_id: ids.sara, p_days: 7 }), /not found/);
  assert.equal((await ok(as(ids.trainer).from('wearable_daily_metrics').select('client_id'))).length, 0);
});

test('the overview only returns the requested window', async () => {
  await ok(save(ids.sara, 'manual', [{ date: today, steps: 1 }, { date: await day(-20), steps: 2 }]));
  const week = await ok(as(ids.sara).rpc('get_health_overview', { p_client_id: null, p_days: 7 }));
  assert.equal(week.metrics.length, 1);
  const month = await ok(as(ids.sara).rpc('get_health_overview', { p_client_id: null, p_days: 30 }));
  assert.equal(month.metrics.length, 2);
});

// ------------------------------------------------------------------ Jack tools

const TODAY = () => today;
const ctx = (userId, role) => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today: TODAY(), access: { role } });

test('Jack\'s health tools are limited by role and use the same permissions as the app', async () => {
  const names = (role) => toolSpecsForRole(role).map((tool) => tool.name);
  assert.ok(names('client').includes('get_my_health_metrics') && names('client').includes('log_nutrition_summary'));
  assert.ok(!names('client').includes('get_client_wearables_and_nutrition'));
  assert.ok(names('coach').includes('get_client_wearables_and_nutrition'));
  assert.ok(!names('coach').includes('log_nutrition_summary') && !names('coach').includes('get_my_health_metrics'));
  assert.ok(!names('trainer').includes('get_client_wearables_and_nutrition'));

  const asCoachCallingClientTool = await executeTool('log_nutrition_summary', { calories: 2000 }, ctx(ids.coachA, 'coach'));
  assert.equal(asCoachCallingClientTool.ok, false);
  const asClientCallingCoachTool = await executeTool('get_client_wearables_and_nutrition', { client: 'Sara' }, ctx(ids.sara, 'client'));
  assert.equal(asClientCallingCoachTool.ok, false);
});

test('log_nutrition_summary saves the day and get_my_health_metrics reads it back', async () => {
  const saved = await executeTool('log_nutrition_summary', { calories: 2100, protein_g: 150, carbs_g: 230, fats_g: 70, water_ml: 2500 }, ctx(ids.sara, 'client'));
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.result.saved, true);
  const [row] = await rows('select calories_consumed, protein_g, source from public.nutrition_daily_logs where client_id = $1', [ids.sara]);
  assert.deepEqual([row.calories_consumed, Number(row.protein_g), row.source], [2100, 150, 'manual']);

  await ok(as(ids.sara).rpc('set_my_nutrition_targets', { p_calories: 2200, p_protein: null, p_carbs: null, p_fats: null }));
  await ok(save(ids.sara, 'apple_health', [{ date: today, steps: 9000, sleep_minutes: 450 }]));
  const read = await executeTool('get_my_health_metrics', {}, ctx(ids.sara, 'client'));
  assert.equal(read.ok, true, read.error);
  assert.equal(read.result.daily_average.steps, 9000);
  assert.equal(read.result.daily_average.sleep, '7h 30m');
  assert.equal(read.result.nutrition.average_calories, 2100);
  assert.equal(read.result.nutrition.days_on_goal, '1/1');
  assert.deepEqual(read.result.connected_devices, ['apple_health']);
});

test('log_nutrition_summary rejects empty or impossible input without writing', async () => {
  const empty = await executeTool('log_nutrition_summary', {}, ctx(ids.sara, 'client'));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /at least one value/);
  const huge = await executeTool('log_nutrition_summary', { calories: 90000 }, ctx(ids.sara, 'client'));
  assert.equal(huge.ok, false);
  const future = await executeTool('log_nutrition_summary', { calories: 2000, date: '2999-01-01' }, ctx(ids.sara, 'client'));
  assert.equal(future.ok, false);
  assert.equal(await count('select count(*) as n from public.nutrition_daily_logs'), 0);
});

test('get_client_wearables_and_nutrition finds the coach\'s own client and nobody else', async () => {
  await seedBoth(ids.sara);
  await seedBoth(ids.bFan);
  const found = await executeTool('get_client_wearables_and_nutrition', { client: 'sara@example.com' }, ctx(ids.coachA, 'coach'));
  assert.equal(found.ok, true, found.error);
  assert.equal(found.result.client, 'Sara Ali');
  assert.equal(found.result.daily_average.steps, 4000);
  assert.ok(!JSON.stringify(found.result).includes('@'), 'no email in the result');

  const other = await executeTool('get_client_wearables_and_nutrition', { client: 'Bea Fan' }, ctx(ids.coachA, 'coach'));
  assert.equal(other.ok, false);
  assert.match(other.error, /No client matches/);
});
