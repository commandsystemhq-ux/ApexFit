import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { habitsTranslations } from '../src/i18n/habitsTranslations.js';
import {
  BUILTIN_HABITS, HABIT_COLORS, HABIT_SUGGESTIONS, MAX_HABITS, activeHabits, addQuickAmount, archivedHabits, buildHabitValues, calculateStreak,
  emptyHabitForm, formFromHabit, formFromSuggestion, habitMet, habitName, habitPercent, summarizeGoals, validateHabitForm, weekDays,
} from '../src/services/habitUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003000_custom_habits.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  otherCoach: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};

let db;
let today;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const rpc = (userId, name, args) => as(userId).rpc(name, args);

before(async () => {
  db = await createTestDatabase();
  today = (await rows('select current_date::text as d'))[0].d;
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.otherCoach, email: 'ben@example.com', role: 'coach' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.otherCoach, ids.omar],
  );
});

const habitsOf = async (userId, extra = '') => rows(`select id, builtin_key, name, kind, unit, daily_goal::float as daily_goal, quick_add::float as quick_add, color, status, sort_order from public.client_custom_habits where client_id = $1 ${extra} order by sort_order`, [userId]);
const seed = async (userId) => { assert.equal((await rpc(userId, 'ensure_my_default_habits')).error, null); };
const create = async (userId, overrides = {}) => {
  const result = await rpc(userId, 'save_my_habit', { p_habit_id: null, p_name: 'Reading', p_kind: 'numeric', p_unit: 'pages', p_daily_goal: 20, p_quick_add: 5, p_color: 'teal', ...overrides });
  assert.equal(result.error, null, result.error?.message);
  return result.data;
};
const builtin = async (userId, key) => (await habitsOf(userId)).find((habit) => habit.builtin_key === key);

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('every client starts with sleep, water and steps, once, and what they delete never comes back', async () => {
  await seed(ids.sara);
  const start = await habitsOf(ids.sara);
  assert.deepEqual(start.map((habit) => [habit.builtin_key, habit.kind, habit.daily_goal, habit.quick_add, habit.color, habit.status]), [
    ['sleep', 'numeric', 8, 0.5, 'blue', 'active'],
    ['water', 'numeric', 2.5, 0.25, 'green', 'active'],
    ['steps', 'numeric', 10000, 1000, 'amber', 'active'],
  ]);
  await seed(ids.sara);
  assert.equal((await habitsOf(ids.sara)).length, 3);

  assert.equal((await rpc(ids.sara, 'delete_my_habit', { p_habit_id: (await builtin(ids.sara, 'water')).id })).error, null);
  await seed(ids.sara);
  assert.deepEqual((await habitsOf(ids.sara)).map((habit) => habit.builtin_key), ['sleep', 'steps']);
  assert.match((await rpc(ids.coach, 'ensure_my_default_habits')).error.message, /client account/);
});

test('running the migration again gives existing clients the three habits and never re-adds a deleted one', async () => {
  assert.equal((await habitsOf(ids.omar)).length, 0);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assert.equal((await habitsOf(ids.omar)).length, 3);
  assert.equal((await habitsOf(ids.coach)).length, 0);
  await rpc(ids.omar, 'delete_my_habit', { p_habit_id: (await builtin(ids.omar, 'steps')).id });
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assert.equal((await habitsOf(ids.omar)).length, 2);
});

test('a client adds numeric and yes/no habits, each with its own name, color and order', async () => {
  await seed(ids.sara);
  await create(ids.sara);
  await create(ids.sara, { p_name: 'Creatine', p_kind: 'boolean', p_unit: '', p_daily_goal: null, p_quick_add: null, p_color: 'purple' });
  const list = await habitsOf(ids.sara);
  assert.deepEqual(list.slice(3).map((habit) => [habit.name, habit.kind, habit.unit, habit.daily_goal, habit.quick_add, habit.color, habit.sort_order]), [
    ['Reading', 'numeric', 'pages', 20, 5, 'teal', 4],
    ['Creatine', 'boolean', '', null, null, 'purple', 5],
  ]);
});

test('a habit needs a name, a real goal and a known color, and names cannot repeat', async () => {
  await seed(ids.sara);
  const attempt = (overrides) => rpc(ids.sara, 'save_my_habit', { p_habit_id: null, p_name: 'Reading', p_kind: 'numeric', p_unit: 'pages', p_daily_goal: 20, p_quick_add: 5, p_color: 'teal', ...overrides });
  assert.match((await attempt({ p_name: '   ' })).error.message, /name/);
  assert.match((await attempt({ p_name: 'x'.repeat(61) })).error.message, /name/);
  assert.match((await attempt({ p_unit: 'u'.repeat(21) })).error.message, /unit/);
  assert.match((await attempt({ p_kind: 'text' })).error.message, /type/);
  assert.match((await attempt({ p_kind: null })).error.message, /type/);
  assert.match((await attempt({ p_daily_goal: 0 })).error.message, /daily goal/);
  assert.match((await attempt({ p_daily_goal: null })).error.message, /daily goal/);
  assert.match((await attempt({ p_daily_goal: 1000001 })).error.message, /daily goal/);
  assert.match((await attempt({ p_quick_add: -1 })).error.message, /quick-add/);
  assert.match((await attempt({ p_color: 'red' })).error.message, /color/);
  assert.equal((await habitsOf(ids.sara)).length, 3);

  assert.equal((await attempt({})).error, null);
  assert.match((await attempt({ p_name: ' reading ' })).error.message, /already have a habit/);
});

test('a client can keep up to 30 habits', async () => {
  await seed(ids.sara);
  for (let index = 0; index < MAX_HABITS - 3; index += 1) await create(ids.sara, { p_name: `Habit ${index}` });
  assert.equal((await habitsOf(ids.sara)).length, MAX_HABITS);
  const over = await rpc(ids.sara, 'save_my_habit', { p_habit_id: null, p_name: 'One too many', p_kind: 'boolean', p_unit: '', p_daily_goal: null, p_quick_add: null, p_color: 'blue' });
  assert.match(over.error.message, /up to 30/);
});

test('the goals of sleep, water and steps can be changed, their names and types cannot', async () => {
  await seed(ids.sara);
  const water = await builtin(ids.sara, 'water');
  const edit = await rpc(ids.sara, 'save_my_habit', { p_habit_id: water.id, p_name: 'Hacked', p_kind: 'numeric', p_unit: 'gallons', p_daily_goal: 3.5, p_quick_add: 0.5, p_color: 'teal' });
  assert.equal(edit.error, null, edit.error?.message);
  const after = await builtin(ids.sara, 'water');
  assert.deepEqual([after.name, after.unit, after.daily_goal, after.quick_add, after.color, after.kind], ['', '', 3.5, 0.5, 'teal', 'numeric']);

  assert.match((await rpc(ids.sara, 'save_my_habit', { p_habit_id: water.id, p_name: '', p_kind: 'boolean', p_unit: '', p_daily_goal: null, p_quick_add: null, p_color: 'blue' })).error.message, /cannot be changed/);
  assert.match((await rpc(ids.sara, 'save_my_habit', { p_habit_id: water.id, p_name: '', p_kind: 'numeric', p_unit: '', p_daily_goal: 51, p_quick_add: 1, p_color: 'blue' })).error.message, /daily goal/);
  const sleep = await builtin(ids.sara, 'sleep');
  assert.match((await rpc(ids.sara, 'save_my_habit', { p_habit_id: sleep.id, p_name: '', p_kind: 'numeric', p_unit: '', p_daily_goal: 25, p_quick_add: 1, p_color: 'blue' })).error.message, /daily goal/);
});

test('a client edits their own habit: name, unit, goal and color', async () => {
  await seed(ids.sara);
  const id = await create(ids.sara);
  const edit = await rpc(ids.sara, 'save_my_habit', { p_habit_id: id, p_name: 'Read a book', p_kind: null, p_unit: 'min', p_daily_goal: 30, p_quick_add: 10, p_color: 'pink' });
  assert.equal(edit.error, null, edit.error?.message);
  const habit = (await habitsOf(ids.sara)).find((row) => row.id === id);
  assert.deepEqual([habit.name, habit.unit, habit.daily_goal, habit.quick_add, habit.color], ['Read a book', 'min', 30, 10, 'pink']);
  await create(ids.sara, { p_name: 'Meditate' });
  assert.match((await rpc(ids.sara, 'save_my_habit', { p_habit_id: id, p_name: 'meditate', p_kind: null, p_unit: '', p_daily_goal: 1, p_quick_add: 1, p_color: 'blue' })).error.message, /already have a habit/);
});

test('numeric and yes/no values are logged per day and can be changed or cleared', async () => {
  await seed(ids.sara);
  const reading = await create(ids.sara);
  const creatine = await create(ids.sara, { p_name: 'Creatine', p_kind: 'boolean', p_unit: '', p_daily_goal: null, p_quick_add: null });
  const log = (habit, value, date = today) => rpc(ids.sara, 'log_my_habit', { p_habit_id: habit, p_date: date, p_value: value });
  const stored = async () => rows('select habit_id, log_date::text as day, value::float as value from public.client_custom_habit_logs');

  assert.equal((await log(reading, 12)).error, null);
  assert.equal((await log(reading, 25)).error, null);
  assert.equal((await log(creatine, 1)).error, null);
  const saved = await stored();
  assert.equal(saved.length, 2);
  assert.equal(saved.find((row) => row.habit_id === reading).value, 25);
  assert.equal(saved.find((row) => row.habit_id === creatine).value, 1);
  assert.equal((await log(creatine, 0)).error, null);
  assert.equal((await log(reading, null)).error, null);
  assert.deepEqual(await stored(), []);

  assert.match((await log(creatine, 2)).error.message, /done \(1\) or not done/);
  assert.match((await log(reading, -1)).error.message, /out of range/);
  assert.match((await log(reading, 1000001)).error.message, /out of range/);
  assert.match((await log(reading, 5, '2999-01-01')).error.message, /Choose a date/);
  assert.match((await log(reading, 5, '2020-01-01')).error.message, /Choose a date/);
});

test('sleep, water and steps keep writing to the old daily row and never wipe each other', async () => {
  await seed(ids.sara);
  const [sleep, water, steps] = [await builtin(ids.sara, 'sleep'), await builtin(ids.sara, 'water'), await builtin(ids.sara, 'steps')];
  const log = (habit, value) => rpc(ids.sara, 'log_my_habit', { p_habit_id: habit.id, p_date: today, p_value: value });
  const daily = async () => rows('select sleep_hours::float as sleep, water_liters::float as water, steps from public.client_habit_logs where client_id = $1', [ids.sara]);

  assert.equal((await log(sleep, 7.5)).error, null);
  assert.equal((await log(water, 2)).error, null);
  assert.equal((await log(steps, 8000)).error, null);
  assert.deepEqual(await daily(), [{ sleep: 7.5, water: 2, steps: 8000 }]);
  assert.equal((await log(water, 3)).error, null);
  assert.deepEqual(await daily(), [{ sleep: 7.5, water: 3, steps: 8000 }]);
  assert.equal((await log(water, null)).error, null);
  assert.deepEqual(await daily(), [{ sleep: 7.5, water: null, steps: 8000 }]);
  assert.equal((await log(sleep, null)).error, null);
  assert.equal((await log(steps, null)).error, null);
  assert.deepEqual(await daily(), [], 'a day with nothing left is removed');

  assert.match((await log(steps, 1000.5)).error.message, /whole number/);
  assert.match((await log(sleep, 25)).error.message, /out of range/);
  assert.match((await log(water, 51)).error.message, /out of range/);
});

test('archiving hides a habit but keeps its history, restoring brings it back, and an archived habit cannot be logged', async () => {
  await seed(ids.sara);
  const id = await create(ids.sara);
  await rpc(ids.sara, 'log_my_habit', { p_habit_id: id, p_date: today, p_value: 10 });
  assert.equal((await rpc(ids.sara, 'set_my_habit_status', { p_habit_id: id, p_status: 'archived' })).error, null);
  assert.equal((await habitsOf(ids.sara, "and status = 'archived'")).length, 1);
  assert.equal((await rows('select count(*)::int as n from public.client_custom_habit_logs'))[0].n, 1);
  assert.match((await rpc(ids.sara, 'log_my_habit', { p_habit_id: id, p_date: today, p_value: 12 })).error.message, /Restore this habit/);
  assert.equal((await rpc(ids.sara, 'set_my_habit_status', { p_habit_id: id, p_status: 'active' })).error, null);
  assert.equal((await rpc(ids.sara, 'log_my_habit', { p_habit_id: id, p_date: today, p_value: 12 })).error, null);
  assert.match((await rpc(ids.sara, 'set_my_habit_status', { p_habit_id: id, p_status: 'gone' })).error.message, /active or archived/);
});

test('deleting a habit removes its values; deleting a built-in one clears only its own column', async () => {
  await seed(ids.sara);
  const id = await create(ids.sara);
  await rpc(ids.sara, 'log_my_habit', { p_habit_id: id, p_date: today, p_value: 10 });
  assert.equal((await rpc(ids.sara, 'delete_my_habit', { p_habit_id: id })).error, null);
  assert.deepEqual(await rows('select id from public.client_custom_habit_logs'), []);

  await db.query(
    `insert into public.client_habit_logs (client_id, habit_date, sleep_hours, water_liters) values ($1, current_date, 7, 2), ($1, current_date - 1, null, 1.5), ($1, current_date - 2, 6, null)`,
    [ids.sara],
  );
  assert.equal((await rpc(ids.sara, 'delete_my_habit', { p_habit_id: (await builtin(ids.sara, 'water')).id })).error, null);
  assert.deepEqual(await rows('select habit_date::text as day, sleep_hours::float as sleep, water_liters from public.client_habit_logs where client_id = $1 order by habit_date desc', [ids.sara]), [
    { day: today, sleep: 7, water_liters: null },
    { day: (await rows("select (current_date - 2)::text as d"))[0].d, sleep: 6, water_liters: null },
  ]);
  assert.match((await rpc(ids.sara, 'delete_my_habit', { p_habit_id: id })).error.message, /not found/);
});

// ---------------------------------------------------------------------------------- who can do what

test('nobody can read or change another person\'s habits', async () => {
  await seed(ids.sara);
  await seed(ids.omar);
  const mine = await create(ids.sara);
  await rpc(ids.sara, 'log_my_habit', { p_habit_id: mine, p_date: today, p_value: 10 });

  const omarSees = await as(ids.omar).from('client_custom_habits').select('id,client_id');
  assert.ok(omarSees.data.length === 3 && omarSees.data.every((row) => row.client_id === ids.omar));
  assert.deepEqual((await as(ids.omar).from('client_custom_habit_logs').select('id')).data, []);

  for (const [name, args] of [
    ['save_my_habit', { p_habit_id: mine, p_name: 'Stolen', p_kind: null, p_unit: '', p_daily_goal: 1, p_quick_add: 1, p_color: 'blue' }],
    ['set_my_habit_status', { p_habit_id: mine, p_status: 'archived' }],
    ['delete_my_habit', { p_habit_id: mine }],
    ['log_my_habit', { p_habit_id: mine, p_date: today, p_value: 99 }],
  ]) {
    assert.match((await rpc(ids.omar, name, args)).error.message, /not found/, name);
  }
  assert.equal((await habitsOf(ids.sara)).find((habit) => habit.id === mine).name, 'Reading');
  assert.equal((await rows('select value::float as value from public.client_custom_habit_logs'))[0].value, 10);
});

test('clients cannot write the habit tables directly, only through the checked functions', async () => {
  await seed(ids.sara);
  const sara = as(ids.sara);
  const id = await create(ids.sara);
  assert.ok((await sara.sql("insert into public.client_custom_habits (client_id, name, kind, daily_goal, quick_add) values ($1, 'Direct', 'numeric', 1, 1)", [ids.sara])).error);
  assert.ok((await sara.sql("insert into public.client_custom_habit_logs (client_id, habit_id, log_date, value) values ($1, $2, current_date, 5)", [ids.sara, id])).error);
  assert.ok((await sara.sql("insert into public.client_habit_settings (client_id) values ($1)", [ids.sara])).error);
  await sara.sql("update public.client_custom_habits set daily_goal = 999 where client_id = $1", [ids.sara]);
  await sara.sql('delete from public.client_custom_habits where client_id = $1', [ids.sara]);
  const list = await habitsOf(ids.sara);
  assert.equal(list.length, 4);
  assert.ok(list.every((habit) => habit.daily_goal !== 999));
});

test('a coach and anyone without a client account cannot use the client functions', async () => {
  await seed(ids.sara);
  const id = await create(ids.sara);
  for (const [name, args] of [
    ['save_my_habit', { p_habit_id: null, p_name: 'Coach habit', p_kind: 'boolean', p_unit: '', p_daily_goal: null, p_quick_add: null, p_color: 'blue' }],
    ['set_my_habit_status', { p_habit_id: id, p_status: 'archived' }],
    ['delete_my_habit', { p_habit_id: id }],
    ['log_my_habit', { p_habit_id: id, p_date: today, p_value: 1 }],
  ]) {
    assert.match((await rpc(ids.coach, name, args)).error.message, /client account/, name);
  }
  assert.equal((await habitsOf(ids.coach)).length, 0);
});

test('a coach reads, and never changes, the habits of their own active clients', async () => {
  await seed(ids.sara);
  await seed(ids.omar);
  const reading = await create(ids.sara);
  await rpc(ids.sara, 'log_my_habit', { p_habit_id: reading, p_date: today, p_value: 10 });
  await rpc(ids.sara, 'log_my_habit', { p_habit_id: (await builtin(ids.sara, 'steps')).id, p_date: today, p_value: 9000 });

  const coach = as(ids.coach);
  const habits = await coach.from('client_custom_habits').select('client_id,name,builtin_key');
  assert.equal(habits.data.length, 4);
  assert.ok(habits.data.every((row) => row.client_id === ids.sara));
  assert.equal((await coach.from('client_custom_habit_logs').select('value')).data.length, 1);
  assert.equal((await coach.from('client_habit_logs').select('steps').eq('client_id', ids.sara)).data[0].steps, 9000);
  assert.deepEqual((await coach.from('client_habit_logs').select('steps').eq('client_id', ids.omar)).data, []);
  assert.ok((await as(ids.otherCoach).from('client_custom_habits').select('client_id')).data.every((row) => row.client_id === ids.omar));

  assert.ok((await coach.sql("insert into public.client_custom_habits (client_id, name, kind) values ($1, 'x', 'boolean')", [ids.sara])).error);
  await coach.sql("update public.client_custom_habits set name = 'Hacked' where client_id = $1", [ids.sara]);
  await coach.sql('delete from public.client_custom_habit_logs');
  await coach.sql("update public.client_habit_logs set steps = 1 where client_id = $1", [ids.sara]);
  assert.equal((await habitsOf(ids.sara)).some((habit) => habit.name === 'Hacked'), false);
  assert.equal((await rows('select count(*)::int as n from public.client_custom_habit_logs'))[0].n, 1);
  assert.equal((await rows('select steps from public.client_habit_logs where client_id = $1', [ids.sara]))[0].steps, 9000);
});

test('an archived client, or a coach whose plan ended, shows nothing to the coach', async () => {
  await seed(ids.sara);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual((await as(ids.coach).from('client_custom_habits').select('id')).data, []);
  await db.query("update public.coach_clients set status = 'active' where client_id = $1", [ids.sara]);
  assert.equal((await as(ids.coach).from('client_custom_habits').select('id')).data.length, 3);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coach]);
  assert.deepEqual((await as(ids.coach).from('client_custom_habits').select('id')).data, []);
});

// ------------------------------------------------------------------------------------- the numbers

const goalHabit = (overrides = {}) => ({ id: 'h1', kind: 'numeric', builtin_key: null, name: 'Reading', daily_goal: 20, quick_add: 5, color: 'teal', status: 'active', unit: 'pages', ...overrides });
const yesNo = (overrides = {}) => goalHabit({ id: 'b1', kind: 'boolean', name: 'Creatine', daily_goal: null, quick_add: null, unit: '', ...overrides });
const T = '2026-11-20';
const day = (offset) => weekDays(T, 30)[29 + offset];

test('progress is a share of the goal, and a yes/no habit is all or nothing', () => {
  assert.equal(habitPercent(goalHabit(), 10), 50);
  assert.equal(habitPercent(goalHabit(), '40'), 100);
  assert.equal(habitPercent(goalHabit(), ''), 0);
  assert.equal(habitPercent(goalHabit(), 'abc'), 0);
  assert.equal(habitPercent(yesNo(), 1), 100);
  assert.equal(habitPercent(yesNo(), undefined), 0);
  assert.equal(habitMet(goalHabit(), 19.9), false);
  assert.equal(habitMet(goalHabit(), 20), true);
  assert.equal(habitMet(yesNo(), 1), true);
  assert.equal(habitMet(yesNo(), 0), false);
});

test('values come from the old daily row for sleep, water and steps and from the new rows for everything else', () => {
  const habits = [goalHabit({ id: 'sleep', builtin_key: 'sleep', daily_goal: 8 }), goalHabit({ id: 'steps', builtin_key: 'steps', daily_goal: 10000 }), goalHabit(), yesNo()];
  const values = buildHabitValues(
    habits,
    [{ habit_date: T, sleep_hours: '7.5', water_liters: '2', steps: null }, { habit_date: day(-1), sleep_hours: null, water_liters: null, steps: 9000 }],
    [{ habit_id: 'h1', log_date: T, value: '12' }, { habit_id: 'b1', log_date: T, value: '1' }, { habit_id: 'gone', log_date: T, value: '1' }],
  );
  assert.deepEqual(values.sleep, { [T]: 7.5 });
  assert.deepEqual(values.steps, { [day(-1)]: 9000 });
  assert.deepEqual(values.h1, { [T]: 12 });
  assert.deepEqual(values.b1, { [T]: 1 });
  assert.equal(values.gone, undefined);
});

test('a streak counts days in a row on which the goal was met, and today not being done yet does not break it', () => {
  const habit = goalHabit();
  const run = (entries) => Object.fromEntries(entries.map(([offset, value]) => [day(offset), value]));
  assert.equal(calculateStreak(habit, {}, T), 0);
  assert.equal(calculateStreak(habit, run([[0, 20], [-1, 25], [-2, 20]]), T), 3);
  assert.equal(calculateStreak(habit, run([[-1, 20], [-2, 20]]), T), 2, 'today is still open');
  assert.equal(calculateStreak(habit, run([[0, 5], [-1, 20]]), T), 1, 'a small value today does not erase yesterday');
  assert.equal(calculateStreak(habit, run([[0, 20], [-1, 19], [-2, 20]]), T), 1, 'a missed goal ends the streak');
  assert.equal(calculateStreak(habit, run([[-2, 20], [-3, 20]]), T), 0, 'a gap of a whole day ends it');
  assert.equal(calculateStreak(yesNo(), run([[0, 1], [-1, 1], [-2, 1], [-4, 1]]), T), 3);
});

test('the goals badge counts every active habit, numeric or yes/no, including what is typed but not saved', () => {
  const habits = [goalHabit(), yesNo(), goalHabit({ id: 'h2', name: 'Water', daily_goal: 3 }), goalHabit({ id: 'h3', status: 'archived' })];
  const values = { h1: { [T]: 20 }, b1: { [T]: 1 }, h2: { [T]: 1 }, h3: { [T]: 99 } };
  assert.deepEqual(summarizeGoals(habits, values, {}, T), { reached: 2, total: 3 });
  assert.deepEqual(summarizeGoals(habits, values, { h2: '3' }, T), { reached: 3, total: 3 });
  assert.deepEqual(summarizeGoals(habits, values, { h1: '' }, T), { reached: 1, total: 3 });
  assert.deepEqual(summarizeGoals([], {}, {}, T), { reached: 0, total: 0 });
  assert.deepEqual([activeHabits(habits).length, archivedHabits(habits).length], [3, 1]);
});

test('the week always has seven days ending today', () => {
  const week = weekDays(T);
  assert.equal(week.length, 7);
  assert.equal(week[6], T);
  assert.equal(week[0], '2026-11-14');
});

test('the add / edit form is checked before it is sent', () => {
  const ok = validateHabitForm({ ...emptyHabitForm(), name: '  Reading ', unit: 'pages', dailyGoal: '20', quickAdd: '5', color: 'teal' });
  assert.deepEqual([ok.valid, ok.payload], [true, { id: null, name: 'Reading', kind: 'numeric', unit: 'pages', dailyGoal: 20, quickAdd: 5, color: 'teal' }]);
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'Reading', dailyGoal: '20' }).payload.quickAdd, 1);
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: '', dailyGoal: '20' }).errors.name, 'hbErr_name');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'x'.repeat(61), dailyGoal: '20' }).errors.name, 'hbErr_name');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'A', dailyGoal: '0' }).errors.dailyGoal, 'hbErr_goal');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'A', dailyGoal: '' }).errors.dailyGoal, 'hbErr_goal');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'A', dailyGoal: '2000000' }).errors.dailyGoal, 'hbErr_goal');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'A', dailyGoal: '1', quickAdd: '-2' }).errors.quickAdd, 'hbErr_quick');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'A', dailyGoal: '1', unit: 'u'.repeat(21) }).errors.unit, 'hbErr_unit');
  assert.equal(validateHabitForm({ ...emptyHabitForm(), name: 'A', dailyGoal: '1', color: 'red' }).errors.color, 'hbErr_color');

  const check = validateHabitForm({ ...emptyHabitForm(), name: 'Creatine', kind: 'boolean', unit: 'ignored', dailyGoal: '5' });
  assert.deepEqual([check.valid, check.payload.dailyGoal, check.payload.quickAdd, check.payload.unit], [true, null, null, '']);

  const water = formFromHabit({ ...goalHabit({ builtin_key: 'water', name: '', unit: '', daily_goal: '2.50', quick_add: '0.25' }) });
  assert.equal(validateHabitForm({ ...water, dailyGoal: '3.5' }).payload.dailyGoal, 3.5);
  assert.equal(validateHabitForm({ ...water, dailyGoal: '51' }).errors.dailyGoal, 'hbErr_goal');
  assert.equal(validateHabitForm({ ...water, dailyGoal: '3' }).payload.name, '');
});

test('quick-add steps up by the habit\'s own amount and stops at the limit', () => {
  assert.equal(addQuickAmount(goalHabit(), ''), '5');
  assert.equal(addQuickAmount(goalHabit(), '12'), '17');
  assert.equal(addQuickAmount(goalHabit({ builtin_key: 'water', quick_add: 0.25 }), '0.1'), '0.35');
  assert.equal(addQuickAmount(goalHabit({ builtin_key: 'sleep', quick_add: 0.5 }), '23.8'), '24');
});

test('built-in habits are named in the person\'s language and the quick picks are ready to save', () => {
  const t = (key) => translations.ar[key];
  assert.equal(habitName({ builtin_key: 'sleep', name: '' }, t), translations.ar.sleepHours);
  assert.equal(habitName({ builtin_key: null, name: 'Mine' }, t), 'Mine');
  assert.equal(HABIT_SUGGESTIONS.length, 5);
  for (const suggestion of HABIT_SUGGESTIONS) {
    const form = formFromSuggestion(suggestion, t);
    const result = validateHabitForm(form);
    assert.ok(result.valid, suggestion.id);
    assert.equal(form.name, translations.ar[suggestion.nameKey]);
    assert.ok(HABIT_COLORS.includes(form.color));
  }
  assert.deepEqual(Object.keys(BUILTIN_HABITS), ['sleep', 'water', 'steps']);
});

// ---------------------------------------------------------------------------------------- the screens

test('the tracker adds, edits, archives and deletes habits through the database functions', () => {
  const tracker = read('src/components/ClientHabitTracker.jsx');
  for (const piece of ['hbAddHabit', 'HabitEditorModal', 'HabitRemoveModal', 'hbEdit', 'hbRemove', 'summarizeGoals', 'calculateStreak', 'ensureDefaultHabits', 'habit-check']) assert.ok(tracker.includes(piece), piece);
  const service = read('src/services/habitService.js');
  for (const rpcName of ['ensure_my_default_habits', 'save_my_habit', 'set_my_habit_status', 'delete_my_habit', 'log_my_habit']) assert.ok(service.includes(`'${rpcName}'`), rpcName);
  assert.doesNotMatch(read('src/services/clientProgressService.js'), /client_habit_logs/);
  const modals = read('src/components/HabitModals.jsx');
  for (const piece of ['role="dialog"', 'aria-modal', "'Escape'", 'HABIT_SUGGESTIONS', 'HABIT_COLORS']) assert.ok(modals.includes(piece), piece);
});

test('a coach sees the client\'s habits in a read-only tab', () => {
  const page = read('src/pages/ClientsPage.jsx');
  assert.match(page, /detailTab === 'habits'/);
  assert.match(page, /<ClientHabitReview clientId=/);
  const review = read('src/components/ClientHabitReview.jsx');
  assert.match(review, /listHabits\(clientId\)/);
  assert.doesNotMatch(review, /saveHabit|logHabit|deleteHabit|setHabitStatus/);
});

test('every language has the habit texts, with the same placeholders, and Arabic is Arabic', () => {
  const keys = Object.keys(habitsTranslations.en);
  assert.ok(keys.length >= 60, `${keys.length} keys`);
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(habitsTranslations[locale]).sort(), [...keys].sort(), locale);
    for (const key of keys) {
      assert.ok(translations[locale][key], `${locale}.${key}`);
      assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale}.${key} placeholders`);
    }
  }
  for (const key of ['hbAddHabit', 'hbModalAddTitle', 'hbSug_creatine', 'hbSug_noSugar', 'hbStreak', 'hbArchive', 'hbDelete', 'hbColor_teal']) assert.match(translations.ar[key], /[\u0600-\u06FF]/, key);
  assert.match(translations.ar.hbRemoveTitle, /\{name\}/);
  assert.match(translations.en.hbAddHabit, /Add new habit/);
});
