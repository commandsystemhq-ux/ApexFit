import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeTool, toolSpecsForRole } from '../api/_lib/jackTools.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// The daily checklist in the real schema, with row-level security and function permissions enforced.

const MIGRATION = new URL('../supabase/migrations/20261115001800_daily_checklist.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

let db;
let today;
let dow;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);
const day = async (offset) => (await rows('select (current_date + $1::integer)::text as d', [offset]))[0].d;

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

const add = (userId, overrides = {}) => as(userId).rpc('add_checklist_task', {
  p_date: today, p_category: 'custom', p_title: 'Stretch', p_target: null, p_unit: null, p_remind_time: null, p_repeat_days: null, ...overrides,
});
const list = async (userId, date = today) => (await ok(as(userId).rpc('get_my_checklist', { p_date: date }))).items;
const setItem = (userId, id, args = {}) => as(userId).rpc('set_checklist_item', { p_entry_id: id, p_done: null, p_progress: null, p_add: null, ...args });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  today = await day(0);
  dow = Number((await rows('select extract(dow from current_date)::int as d'))[0].d);
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client' });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, coach_name) values ($1, $2, 'Sara Ali', 'Amal Strength')", [ids.coach, ids.sara]);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

// ------------------------------------------------------------------ adding tasks

test('a one-off task appears only on its day', async () => {
  const created = await ok(add(ids.sara, { p_title: 'Foam roll', p_category: 'habit' }));
  assert.equal(created.template_id, null);
  assert.deepEqual([created.entry.title, created.entry.category, created.entry.is_done, created.entry.task_date], ['Foam roll', 'habit', false, today]);
  assert.deepEqual((await list(ids.sara)).map((item) => item.title), ['Foam roll']);
  assert.deepEqual(await list(ids.sara, await day(1)), []);
  assert.equal(await count('select count(*) as n from public.checklist_templates'), 0);
});

test('a repeating task is created once per day, however often the day is opened', async () => {
  const created = await ok(add(ids.sara, { p_title: 'Drink water', p_category: 'water', p_target: 2500, p_unit: 'ml', p_repeat_days: ALL_DAYS }));
  assert.ok(created.template_id);
  assert.equal(created.entry.template_id, created.template_id);

  for (let index = 0; index < 3; index += 1) assert.equal((await list(ids.sara)).length, 1);
  assert.equal(await count('select count(*) as n from public.checklist_entries where client_id = $1 and task_date = $2', [ids.sara, today]), 1);

  const tomorrow = await list(ids.sara, await day(1));
  assert.deepEqual(tomorrow.map((item) => [item.title, item.target_amount, item.unit, item.progress_amount, item.is_done]), [['Drink water', 2500, 'ml', 0, false]]);
  await list(ids.sara, await day(1));
  assert.equal(await count('select count(*) as n from public.checklist_entries'), 2);
});

test('a task repeating on chosen weekdays only appears on those weekdays', async () => {
  const tomorrowDow = (dow + 1) % 7;
  const created = await ok(add(ids.sara, { p_title: 'Long run', p_category: 'workout', p_repeat_days: [tomorrowDow, tomorrowDow] }));
  assert.equal(created.entry, null, 'not today');
  assert.deepEqual(await list(ids.sara), []);
  assert.deepEqual((await list(ids.sara, await day(1))).map((item) => item.title), ['Long run']);
  const [template] = await rows('select days_of_week from public.checklist_templates');
  assert.deepEqual(template.days_of_week, [tomorrowDow], 'duplicates are folded');
});

test('new tasks are validated', async () => {
  await fails(add(ids.sara, { p_title: '   ' }), /title/);
  await fails(add(ids.sara, { p_title: 'x'.repeat(121) }), /title/);
  await fails(add(ids.sara, { p_category: 'sleep' }), /task type/);
  await fails(add(ids.sara, { p_category: null }), /task type/);
  await fails(add(ids.sara, { p_target: 0 }), /target/);
  await fails(add(ids.sara, { p_target: 100001 }), /target/);
  await fails(add(ids.sara, { p_unit: 'u'.repeat(21) }), /unit/);
  await fails(add(ids.sara, { p_repeat_days: [] }), /days/);
  await fails(add(ids.sara, { p_repeat_days: [7] }), /days/);
  await fails(add(ids.sara, { p_repeat_days: [-1] }), /days/);
  await fails(add(ids.sara, { p_repeat_days: ['mon'] }), /days/);
  await fails(add(ids.sara, { p_repeat_days: { a: 1 } }), /days/);
  await fails(add(ids.sara, { p_date: await day(-5) }), /yesterday, today or tomorrow/);
  await fails(add(ids.sara, { p_date: await day(3) }), /yesterday, today or tomorrow/);
  assert.equal(await count('select count(*) as n from public.checklist_entries'), 0);
  assert.equal(await count('select count(*) as n from public.checklist_templates'), 0);

  const trimmed = await ok(add(ids.sara, { p_title: '  Walk the dog  ', p_unit: '  km ' }));
  assert.deepEqual([trimmed.entry.title, trimmed.entry.unit], ['Walk the dog', 'km']);
});

test('there are limits on repeating tasks and tasks per day', async () => {
  for (let index = 0; index < 50; index += 1) await ok(add(ids.sara, { p_title: `Habit ${index}`, p_repeat_days: [(dow + 3) % 7] }));
  await fails(add(ids.sara, { p_title: 'One too many', p_repeat_days: ALL_DAYS }), /50 repeating/);
  for (let index = 0; index < 100; index += 1) await db.query("insert into public.checklist_entries (client_id, task_date, category, title) values ($1, $2, 'custom', $3)", [ids.sara, today, `Task ${index}`]);
  await fails(add(ids.sara, { p_title: 'Too many today' }), /100 tasks/);
});

// ------------------------------------------------------------- checking things off

test('a task can be checked and unchecked, and the time it was done is kept', async () => {
  const { entry } = await ok(add(ids.sara));
  const done = await ok(setItem(ids.sara, entry.id, { p_done: true }));
  assert.equal(done.is_done, true);
  assert.ok(done.done_at);
  const again = await ok(setItem(ids.sara, entry.id, { p_done: true }));
  assert.equal(again.done_at, done.done_at, 'checking it again does not move the time');
  const undone = await ok(setItem(ids.sara, entry.id, { p_done: false }));
  assert.deepEqual([undone.is_done, undone.done_at], [false, null]);
  assert.equal((await ok(setItem(ids.sara, entry.id))).is_done, false, 'no change asked for, no change made');
});

test('water progress adds up, completes at the target and cannot go below zero', async () => {
  const { entry } = await ok(add(ids.sara, { p_title: 'Water', p_category: 'water', p_target: 2000, p_unit: 'ml' }));
  assert.equal((await ok(setItem(ids.sara, entry.id, { p_add: 500 }))).progress_amount, 500);
  assert.equal((await ok(setItem(ids.sara, entry.id, { p_add: 250 }))).progress_amount, 750);
  const almost = await ok(setItem(ids.sara, entry.id, { p_add: 1000 }));
  assert.deepEqual([almost.progress_amount, almost.is_done], [1750, false]);
  const complete = await ok(setItem(ids.sara, entry.id, { p_add: 250 }));
  assert.deepEqual([complete.progress_amount, complete.is_done], [2000, true]);
  assert.ok(complete.done_at);

  const dropped = await ok(setItem(ids.sara, entry.id, { p_add: -300 }));
  assert.deepEqual([dropped.progress_amount, dropped.is_done, dropped.done_at], [1700, false, null], 'falling below the target reopens it');
  assert.equal((await ok(setItem(ids.sara, entry.id, { p_add: -99999 }))).progress_amount, 0);
  assert.equal((await ok(setItem(ids.sara, entry.id, { p_progress: 1200 }))).progress_amount, 1200);
});

test('checking a task with a target fills it, and unchecking empties a full one', async () => {
  const { entry } = await ok(add(ids.sara, { p_title: 'Water', p_category: 'water', p_target: 2500, p_unit: 'ml' }));
  const full = await ok(setItem(ids.sara, entry.id, { p_done: true }));
  assert.deepEqual([full.progress_amount, full.is_done], [2500, true]);
  const empty = await ok(setItem(ids.sara, entry.id, { p_done: false }));
  assert.deepEqual([empty.progress_amount, empty.is_done], [0, false]);
  await ok(setItem(ids.sara, entry.id, { p_add: 600 }));
  assert.equal((await ok(setItem(ids.sara, entry.id, { p_done: false }))).progress_amount, 600, 'partial progress is kept');
});

test('amounts are validated and only your own, recent tasks can change', async () => {
  const { entry } = await ok(add(ids.sara, { p_target: 10, p_unit: 'km' }));
  await fails(setItem(ids.sara, entry.id, { p_progress: -1 }), /between 0 and/);
  await fails(setItem(ids.sara, entry.id, { p_progress: 100001 }), /between 0 and/);
  await fails(setItem(ids.sara, entry.id, { p_add: 100001 }), /between -100000/);
  await fails(setItem(ids.omar, entry.id, { p_done: true }), /not found/);
  await fails(setItem(ids.sara, '00000000-0000-4000-8000-00000000ffff', { p_done: true }), /not found/);
  await fails(setItem(ids.coach, entry.id, { p_done: true }), /client account/);

  await db.query("insert into public.checklist_entries (id, client_id, task_date, category, title) values ('00000000-0000-4000-8000-0000000000e1', $1, $2, 'custom', 'Old')", [ids.sara, await day(-4)]);
  await fails(setItem(ids.sara, '00000000-0000-4000-8000-0000000000e1', { p_done: true }), /last few days/);
  assert.equal((await rows('select is_done from public.checklist_entries where id = $1', [entry.id]))[0].is_done, false);
});

// ------------------------------------------------------------- dates and history

test('opening other dates: history is read-only and nothing is created for it', async () => {
  const yesterday = await day(-1);
  await db.query("insert into public.checklist_entries (client_id, task_date, category, title, is_done) values ($1, $2, 'habit', 'Stretch', true)", [ids.sara, await day(-10)]);
  await ok(add(ids.sara, { p_title: 'Daily', p_repeat_days: ALL_DAYS }));

  const old = await ok(as(ids.sara).rpc('get_my_checklist', { p_date: await day(-10) }));
  assert.deepEqual([old.items.map((item) => item.title), old.editable], [['Stretch'], false]);
  const week = await ok(as(ids.sara).rpc('get_my_checklist', { p_date: await day(-6) }));
  assert.deepEqual([week.items, week.editable], [[], false], 'a repeating task is not invented for past days');

  const recent = await ok(as(ids.sara).rpc('get_my_checklist', { p_date: yesterday }));
  assert.deepEqual([recent.items.map((item) => item.title), recent.editable], [['Daily'], true], 'yesterday is created because time zones differ');

  await fails(as(ids.sara).rpc('get_my_checklist', { p_date: await day(-400) }), /last year/);
  await fails(as(ids.sara).rpc('get_my_checklist', { p_date: await day(2) }), /tomorrow/);
  await fails(as(ids.sara).rpc('get_my_checklist', { p_date: null }), /last year/);
});

test('the summary counts done and total for each day, with empty days included', async () => {
  const { entry } = await ok(add(ids.sara, { p_title: 'A' }));
  await ok(add(ids.sara, { p_title: 'B' }));
  await ok(setItem(ids.sara, entry.id, { p_done: true }));
  await db.query("insert into public.checklist_entries (client_id, task_date, category, title, is_done) values ($1, $2, 'habit', 'Old', true)", [ids.sara, await day(-2)]);

  const summary = await ok(as(ids.sara).rpc('get_checklist_summary', { p_to: today, p_days: 4 }));
  assert.deepEqual(summary.map((item) => [item.date, item.done, item.total]), [[await day(-3), 0, 0], [await day(-2), 1, 1], [await day(-1), 0, 0], [today, 1, 2]]);
  assert.equal((await ok(as(ids.sara).rpc('get_checklist_summary', { p_to: today, p_days: 999 }))).length, 60);
  assert.equal((await ok(as(ids.omar).rpc('get_checklist_summary', { p_to: today, p_days: 2 }))).every((item) => item.total === 0), true);
  await fails(as(ids.sara).rpc('get_checklist_summary', { p_to: await day(5), p_days: 7 }), /tomorrow/);
});

// ------------------------------------------------------------------- removing

test('removing a one-off task removes only that task', async () => {
  const first = await ok(add(ids.sara, { p_title: 'One' }));
  await ok(add(ids.sara, { p_title: 'Two' }));
  const removed = await ok(as(ids.sara).rpc('delete_checklist_task', { p_entry_id: first.entry.id }));
  assert.deepEqual(removed, { entry_id: first.entry.id, template_id: null });
  assert.deepEqual((await list(ids.sara)).map((item) => item.title), ['Two']);
  await fails(as(ids.omar).rpc('delete_checklist_task', { p_entry_id: first.entry.id }), /not found/);
  await fails(as(ids.sara).rpc('delete_checklist_task', { p_entry_id: first.entry.id }), /not found/);
});

test('removing a repeating task stops it from this day on and keeps the past as history', async () => {
  const created = await ok(add(ids.sara, { p_title: 'Daily', p_remind_time: '08:00', p_repeat_days: ALL_DAYS }));
  const templateId = created.template_id;
  // A past day that was already done, and tomorrow's copy.
  await db.query("insert into public.checklist_entries (client_id, task_date, template_id, category, title, is_done, remind_time) values ($1, $2, $3, 'custom', 'Daily', true, '08:00')", [ids.sara, await day(-3), templateId]);
  await list(ids.sara, await day(1));

  const removed = await ok(as(ids.sara).rpc('delete_checklist_task', { p_entry_id: created.entry.id }));
  assert.deepEqual(removed, { entry_id: created.entry.id, template_id: templateId });
  assert.equal(await count('select count(*) as n from public.checklist_templates'), 0);
  assert.deepEqual(await list(ids.sara), []);
  assert.deepEqual(await list(ids.sara, await day(1)), []);

  const [history] = await rows('select title, is_done, template_id from public.checklist_entries');
  assert.deepEqual(history, { title: 'Daily', is_done: true, template_id: null }, 'the past stays as history');
});

// ------------------------------------------------------------------------- times

test('a task\'s time is saved on the task and its repeats, and can be cleared', async () => {
  const created = await ok(add(ids.sara, { p_title: 'Lift', p_category: 'workout', p_repeat_days: ALL_DAYS }));
  await list(ids.sara, await day(1));

  const updated = await ok(as(ids.sara).rpc('update_checklist_time', { p_entry_id: created.entry.id, p_remind_time: '17:30' }));
  assert.equal(updated.remind_time, '17:30');
  assert.deepEqual(Object.keys(updated).sort(), ['category', 'done_at', 'id', 'is_done', 'progress_amount', 'remind_time', 'target_amount', 'task_date', 'template_id', 'title', 'unit']);

  const [template] = await rows('select remind_time::text as t from public.checklist_templates');
  assert.deepEqual(template, { t: '17:30:00' });
  assert.equal((await list(ids.sara, await day(1)))[0].remind_time, '17:30', 'later days follow');

  const cleared = await ok(as(ids.sara).rpc('update_checklist_time', { p_entry_id: created.entry.id, p_remind_time: null }));
  assert.equal(cleared.remind_time, null);

  const oneOff = await ok(add(ids.sara, { p_title: 'Call' }));
  assert.equal((await ok(as(ids.sara).rpc('update_checklist_time', { p_entry_id: oneOff.entry.id, p_remind_time: '09:15' }))).remind_time, '09:15');
  await fails(as(ids.omar).rpc('update_checklist_time', { p_entry_id: created.entry.id, p_remind_time: '10:00' }), /not found/);
  await fails(as(ids.coach).rpc('update_checklist_time', { p_entry_id: created.entry.id, p_remind_time: '10:00' }), /client account/);
});

// ----------------------------------------------------------------------- security

test('each client sees only their own checklist, and nobody writes the tables directly', async () => {
  await ok(add(ids.sara, { p_title: 'Sara only', p_repeat_days: ALL_DAYS }));
  await list(ids.sara);

  assert.deepEqual((await ok(as(ids.sara).from('checklist_entries').select('title'))).map((row) => row.title), ['Sara only']);
  assert.deepEqual((await ok(as(ids.sara).from('checklist_templates').select('title'))).map((row) => row.title), ['Sara only']);
  for (const other of [ids.omar, ids.coach]) {
    assert.equal((await ok(as(other).from('checklist_entries').select('title'))).length, 0);
    assert.equal((await ok(as(other).from('checklist_templates').select('title'))).length, 0);
  }
  assert.deepEqual(await list(ids.omar), []);
  await fails(as(ids.coach).rpc('get_my_checklist', { p_date: today }), /client account/);
  await fails(add(ids.coach), /client account/);
  await fails(as(ids.coach).rpc('get_checklist_summary', { p_to: today, p_days: 3 }), /client account/);

  const refused = [
    `insert into public.checklist_entries (client_id, task_date, category, title) values ('${ids.sara}', current_date, 'custom', 'forged')`,
    `insert into public.checklist_templates (client_id, category, title) values ('${ids.sara}', 'custom', 'forged')`,
    "update public.checklist_entries set is_done = true",
    "update public.checklist_templates set title = 'edited'",
    'delete from public.checklist_entries',
    'delete from public.checklist_templates',
  ];
  for (const statement of refused) assert.ok((await as(ids.sara).sql(statement)).error, statement);
  assert.equal(await count('select count(*) as n from public.checklist_entries'), 1);
  for (const name of ['checklist_materialize', 'checklist_require_client']) {
    assert.ok((await as(ids.sara).rpc(name, name === 'checklist_materialize' ? { p_client: ids.omar, p_date: today } : {})).error, `${name} is not callable`);
  }
});

// ---------------------------------------------------------------------- Jack

const ctx = (userId, role = 'client') => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today, access: { role } });

test('Jack\'s checklist tools exist for clients only', async () => {
  const names = (role) => toolSpecsForRole(role).map((tool) => tool.name);
  assert.ok(names('client').includes('get_my_checklist') && names('client').includes('update_checklist_item'));
  for (const role of ['coach', 'trainer']) assert.ok(!names(role).some((name) => /checklist/.test(name)), role);
  assert.equal((await executeTool('get_my_checklist', {}, ctx(ids.coach, 'coach'))).forbidden, true);
  assert.equal((await executeTool('update_checklist_item', { task: 'x', done: true }, ctx(ids.coach, 'coach'))).forbidden, true);
});

test('Jack reads the checklist and reports what is left', async () => {
  await ok(add(ids.sara, { p_title: 'Morning workout', p_category: 'workout', p_remind_time: '07:00' }));
  const water = await ok(add(ids.sara, { p_title: 'Drink water', p_category: 'water', p_target: 2500, p_unit: 'ml', p_repeat_days: ALL_DAYS }));
  await ok(setItem(ids.sara, water.entry.id, { p_add: 750 }));

  const result = await executeTool('get_my_checklist', {}, ctx(ids.sara));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.result.total, result.result.done, result.result.left, result.result.date], [2, 0, 2, today]);
  const byTask = Object.fromEntries(result.result.tasks.map((task) => [task.task, task]));
  assert.deepEqual(byTask['Drink water'], { task: 'Drink water', type: 'water', done: false, progress: 750, target: 2500, unit: 'ml', repeats: true });
  assert.deepEqual(byTask['Morning workout'], { task: 'Morning workout', type: 'workout', done: false, time: '07:00', repeats: false });

  assert.equal((await executeTool('get_my_checklist', { date: 'tomorrow' }, ctx(ids.sara))).ok, false);
  const empty = await executeTool('get_my_checklist', {}, ctx(ids.omar));
  assert.deepEqual([empty.ok, empty.result.total, empty.result.tasks], [true, 0, []]);
});

test('Jack ticks a task and adds water, and the database shows it', async () => {
  await ok(add(ids.sara, { p_title: 'Morning workout', p_category: 'workout' }));
  await ok(add(ids.sara, { p_title: 'Drink water', p_category: 'water', p_target: 2000, p_unit: 'ml' }));

  const ticked = await executeTool('update_checklist_item', { task: 'workout', done: true }, ctx(ids.sara));
  assert.equal(ticked.ok, true, ticked.error);
  assert.deepEqual([ticked.result.task, ticked.result.done, ticked.result.left_today, ticked.result.total_today], ['Morning workout', true, 1, 2]);
  assert.equal((await rows("select is_done from public.checklist_entries where title = 'Morning workout'"))[0].is_done, true);

  const first = await executeTool('update_checklist_item', { task: 'water', add_amount: 500 }, ctx(ids.sara));
  assert.deepEqual([first.result.progress, first.result.target, first.result.done], [500, 2000, false]);
  const finished = await executeTool('update_checklist_item', { task: 'water', add_amount: 1500 }, ctx(ids.sara));
  assert.deepEqual([finished.result.progress, finished.result.done, finished.result.left_today], [2000, true, 0]);
  const reset = await executeTool('update_checklist_item', { task: 'water', set_amount: 250 }, ctx(ids.sara));
  assert.deepEqual([reset.result.progress, reset.result.done], [250, false]);
  const undone = await executeTool('update_checklist_item', { task: 'workout', done: false }, ctx(ids.sara));
  assert.equal(undone.result.done, false);
});

test('Jack refuses unclear, impossible or foreign changes without touching anything', async () => {
  await ok(add(ids.sara, { p_title: 'Drink water', p_category: 'water', p_target: 2000, p_unit: 'ml' }));
  await ok(add(ids.sara, { p_title: 'Drink green tea', p_category: 'habit' }));
  const run = (args, user = ids.sara) => executeTool('update_checklist_item', args, ctx(user));

  assert.match((await run({ task: 'water' })).error, /Say what to change/);
  assert.match((await run({ task: 'water', done: true, add_amount: 1 })).error, /only one/);
  assert.match((await run({ task: 'water', done: 'yes' })).error, /true or false/);
  assert.match((await run({ task: 'water', add_amount: 'lots' })).error, /must be a number/);
  assert.match((await run({ task: 'drink', done: true })).error, /Ask which one|Several/);
  assert.match((await run({ task: 'yoga', done: true })).error, /No task matches/);
  assert.match((await run({ task: 'green tea', add_amount: 5 })).error, /no target/);
  assert.match((await run({ task: 'water', done: true, date: 'soon' })).error, /YYYY-MM-DD/);
  assert.equal((await run({ task: 'water', done: true }, ids.omar)).ok, false, 'another client has no such task');
  assert.deepEqual(await rows('select title, is_done, progress_amount::float as progress from public.checklist_entries order by title'), [
    { title: 'Drink green tea', is_done: false, progress: 0 },
    { title: 'Drink water', is_done: false, progress: 0 },
  ]);
});
