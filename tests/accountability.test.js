import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Tasks with XP, completion rates, progress reports and Jack conversation history in the real schema (RLS enforced).

const MIGRATION = new URL('../supabase/migrations/20261115002000_accountability_reports_jack_history.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000a2',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  lina: '00000000-0000-4000-8000-0000000000c3',
};
const PERMISSIONS = { manage_programs: true, view_assessments: false, messages: false, manage_groups: false };

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);

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

const visible = async (userId, table) => ok(as(userId).from(table).select('id'));
const assign = (userId, client, o = {}) => as(userId).rpc('assign_client_task', {
  p_client_id: client, p_kind: 'workout', p_title: 'Leg day', p_description: '', p_due_date: null, p_xp: 20, p_source: 'coach', ...o,
});

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'nour@example.com', role: 'coach', fullName: 'Coach Nour' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina Trainer' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara Ali' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client', fullName: 'Omar Ali' });
  await addUser(db, { id: ids.lina, email: 'lina@example.com', role: 'client', fullName: 'Lina Ali' });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_email, client_name) values ($1, $2, 'sara@example.com', 'Sara Ali'), ($1, $3, 'omar@example.com', 'Omar Ali')", [ids.coach, ids.sara, ids.omar]);
  await db.query("insert into public.coach_clients (coach_id, client_id, client_email, client_name) values ($1, $2, 'lina@example.com', 'Lina Ali')", [ids.other, ids.lina]);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(migration);
});

// ------------------------------------------------------------------ tasks

test('a coach assigns tasks only to their own active clients, with validation', async () => {
  const task = await ok(assign(ids.coach, ids.sara, { p_title: '  Leg day  ', p_description: 'Squats and lunges' }));
  assert.deepEqual([task.title, task.kind, task.status, task.xp, task.source, task.coach_id], ['Leg day', 'workout', 'pending', 20, 'coach', ids.coach]);

  await fails(assign(ids.coach, ids.lina), /own active clients/);
  await fails(assign(ids.sara, ids.sara), /own active clients/);
  await fails(assign(ids.coach, ids.sara, { p_kind: 'cardio' }), /task type/);
  await fails(assign(ids.coach, ids.sara, { p_title: '   ' }), /title/);
  await fails(assign(ids.coach, ids.sara, { p_xp: 500 }), /XP/);
  await fails(assign(ids.coach, ids.sara, { p_source: 'self' }), /source/);
  await fails(assign(ids.coach, ids.sara, { p_due_date: '2020-01-01' }), /due date/);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.omar]);
  await fails(assign(ids.coach, ids.omar), /own active clients/);
});

test('Jack can mark a task as assigned by Jack', async () => {
  const task = await ok(assign(ids.coach, ids.sara, { p_source: 'jack', p_kind: 'habit', p_title: 'Drink 3 litres of water' }));
  assert.equal(task.source, 'jack');
});

test('assistant trainers need the permission and the assigned client', async () => {
  const member = await ok(as(ids.coach).rpc('invite_trainer', { p_email: 'tina@example.com', p_role_title: 'Assistant', p_permissions: PERMISSIONS }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: member }));

  await fails(assign(ids.trainer, ids.sara), /own active clients/);
  await ok(as(ids.coach).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: member }));
  const task = await ok(assign(ids.trainer, ids.sara, { p_title: 'Mobility' }));
  assert.equal(task.coach_id, ids.coach);
  await fails(assign(ids.trainer, ids.omar), /own active clients/);

  const mine = await ok(as(ids.trainer).rpc('get_task_completion_rates', { p_days: 30 }));
  assert.deepEqual(mine.map((row) => row.client_id), [ids.sara]);

  await db.query("update public.coach_team_members set permissions = '{\"manage_programs\": false}'::jsonb where id = $1", [member]);
  await fails(assign(ids.trainer, ids.sara), /own active clients/);
});

test('tasks are only visible to their client and the coach side', async () => {
  await ok(assign(ids.coach, ids.sara));
  const countAs = async (userId) => (await visible(userId, 'client_tasks')).length;
  assert.equal(await countAs(ids.sara), 1);
  assert.equal(await countAs(ids.coach), 1);
  assert.equal(await countAs(ids.omar), 0);
  assert.equal(await countAs(ids.other), 0);
  assert.equal(await countAs(ids.lina), 0);

  const direct = await as(ids.sara).sql("update public.client_tasks set status = 'done'");
  assert.ok(direct.error, 'clients cannot write the table directly');
  await fails(as(ids.sara).rpc('get_client_tasks', { p_client_id: ids.sara }), /own clients/);
  await fails(as(ids.other).rpc('get_client_tasks', { p_client_id: ids.sara }), /own clients/);
  assert.equal((await ok(as(ids.coach).rpc('get_client_tasks', { p_client_id: ids.sara }))).tasks.length, 1);
});

test('completing a task earns XP once and unticking takes it back', async () => {
  const task = await ok(assign(ids.coach, ids.sara, { p_xp: 30 }));
  const done = await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: task.id, p_done: true }));
  assert.deepEqual([done.status, done.xp_awarded], ['done', 30]);

  const again = await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: task.id, p_done: true }));
  assert.equal(again.xp_awarded, 30);
  assert.equal(await count("select coalesce(sum(points), 0) as n from public.point_events where user_id = $1 and source = 'task'", [ids.sara]), 30);

  const summary = await ok(as(ids.sara).rpc('get_my_gamification'));
  assert.equal(Number(summary.total_points), 30);

  const undone = await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: task.id, p_done: false }));
  assert.deepEqual([undone.status, undone.xp_awarded], ['pending', 0]);
  assert.equal(await count("select count(*) as n from public.point_events where source = 'task'"), 0);

  await fails(as(ids.omar).rpc('complete_my_task', { p_task_id: task.id }), /not found/);
  await fails(as(ids.coach).rpc('complete_my_task', { p_task_id: task.id }), /Only clients/);
});

test('task XP counts on the coach leaderboard', async () => {
  await ok(as(ids.coach).rpc('join_community', { p_display_name: 'Coach Amal', p_leaderboard_opt_in: true }));
  await ok(as(ids.sara).rpc('join_community', { p_display_name: 'Sara', p_leaderboard_opt_in: true }));
  const task = await ok(assign(ids.coach, ids.sara, { p_xp: 40 }));
  await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: task.id }));
  const board = (await as(ids.sara).sql("select * from public.get_leaderboard($1, 'week')", [ids.coach])).rows;
  assert.equal(Number(board.find((row) => row.lb_user_id === ids.sara)?.lb_points), 40);
});

test('tasks a client adds for themselves are small and capped per day', async () => {
  const mine = await ok(as(ids.sara).rpc('add_my_task', { p_kind: 'habit', p_title: 'Stretch', p_description: '', p_due_date: null }));
  assert.deepEqual([mine.source, mine.xp, mine.coach_id], ['self', 5, ids.coach]);
  await fails(as(ids.coach).rpc('add_my_task', { p_kind: 'habit', p_title: 'x', p_description: '', p_due_date: null }), /Only clients/);
  await fails(as(ids.sara).rpc('add_my_task', { p_kind: 'habit', p_title: 'x', p_description: '', p_due_date: '2099-01-01' }), /next 7 days/);

  let earned = 0;
  for (let index = 0; index < 7; index += 1) {
    const task = await ok(as(ids.sara).rpc('add_my_task', { p_kind: 'check_in', p_title: `Check ${index}`, p_description: '', p_due_date: null }));
    const done = await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: task.id }));
    earned += done.xp_awarded;
  }
  assert.equal(earned, 25);

  await ok(as(ids.sara).rpc('delete_my_task', { p_task_id: mine.id }));
  const assigned = await ok(assign(ids.coach, ids.sara));
  await fails(as(ids.sara).rpc('delete_my_task', { p_task_id: assigned.id }), /own open tasks/);
});

test('coaches see completion rates for their own clients only', async () => {
  const first = await ok(assign(ids.coach, ids.sara));
  await ok(assign(ids.coach, ids.sara, { p_title: 'Second' }));
  await ok(assign(ids.coach, ids.sara, { p_title: 'Third' }));
  await ok(assign(ids.coach, ids.sara, { p_title: 'Fourth' }));
  await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: first.id }));
  const own = await ok(as(ids.sara).rpc('add_my_task', { p_kind: 'habit', p_title: 'Mine', p_description: '', p_due_date: null }));
  await ok(as(ids.sara).rpc('complete_my_task', { p_task_id: own.id }));

  const rates = await ok(as(ids.coach).rpc('get_task_completion_rates', { p_days: 30 }));
  assert.equal(rates.length, 2);
  const sara = rates.find((row) => row.client_id === ids.sara);
  const omar = rates.find((row) => row.client_id === ids.omar);
  assert.deepEqual([sara.assigned, sara.done, sara.rate, sara.pending], [4, 1, 25, 3]);
  assert.deepEqual([omar.assigned, omar.done, omar.rate], [0, 0, null]);
  assert.equal(sara.client_name, 'Sara Ali');
  assert.equal(Number(sara.xp_total), 25);

  assert.deepEqual((await ok(as(ids.other).rpc('get_task_completion_rates', { p_days: 30 }))).map((row) => row.client_id), [ids.lina]);
  await fails(as(ids.sara).rpc('get_task_completion_rates', { p_days: 30 }), /Only coaches/);
});

test('overdue tasks lower the rate and the coach can remove open tasks', async () => {
  const task = await ok(assign(ids.coach, ids.sara));
  await db.query("update public.client_tasks set due_date = current_date - 3 where id = $1", [task.id]);
  const [row] = (await ok(as(ids.coach).rpc('get_task_completion_rates', { p_days: 30 }))).filter((entry) => entry.client_id === ids.sara);
  assert.deepEqual([row.assigned, row.done, row.rate, row.overdue], [1, 0, 0, 1]);

  const mine = await ok(as(ids.sara).rpc('get_my_tasks'));
  assert.equal(mine.tasks[0].is_overdue, true);

  await fails(as(ids.other).rpc('delete_client_task', { p_task_id: task.id }), /own clients/);
  await ok(as(ids.coach).rpc('delete_client_task', { p_task_id: task.id }));
  assert.equal(await count('select count(*) as n from public.client_tasks'), 0);
});

// ------------------------------------------------------------------ reports

async function seedActivity() {
  await db.query("insert into public.client_body_metrics (client_id, measured_on, weight_kg) values ($1, current_date - 20, 70.0), ($1, current_date - 1, 67.7)", [ids.sara]);
  await db.query("insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, current_date - 2, 'Push'), ($1, current_date - 4, 'Pull')", [ids.sara]);
  await db.query("insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, calories) values ($1, current_date - 1, 'lunch', 'Rice', 600), ($1, current_date - 1, 'dinner', 'Chicken', 400)", [ids.sara]);
}

test('progress stats are computed from the logs and limited to the right people', async () => {
  await seedActivity();
  const stats = await ok(as(ids.coach).rpc('get_progress_stats', { p_client_id: ids.sara, p_days: 30 }));
  assert.equal(stats.first_name, 'Sara');
  assert.deepEqual([stats.workouts, Number(stats.weight_change_kg), stats.food_days, Number(stats.avg_calories)], [2, -2.3, 1, 1000]);
  assert.equal(stats.period_days, 30);

  const own = await ok(as(ids.sara).rpc('get_progress_stats', { p_client_id: ids.sara, p_days: 7 }));
  assert.equal(own.workouts, 2);
  await fails(as(ids.other).rpc('get_progress_stats', { p_client_id: ids.sara, p_days: 30 }), /yourself or your own clients/);
  await fails(as(ids.omar).rpc('get_progress_stats', { p_client_id: ids.sara, p_days: 30 }), /yourself or your own clients/);
});

const REPORT = 'Sara lost 2.3 kg and trained twice this month. Keep going, you are doing great!';

test('a coach writes a report that stays hidden until shared with the client', async () => {
  await seedActivity();
  const report = await ok(as(ids.coach).rpc('save_progress_report', { p_client_id: ids.sara, p_days: 30, p_body: REPORT }));
  assert.equal(report.shared, false);
  assert.equal(Number(report.stats.weight_change_kg), -2.3);

  assert.equal((await ok(as(ids.sara).rpc('list_progress_reports', { p_client_id: null }))).length, 0);
  assert.equal((await visible(ids.sara, 'progress_reports')).length, 0);

  await fails(as(ids.sara).rpc('share_progress_report', { p_report_id: report.id, p_shared: true }), /own clients/);
  await ok(as(ids.coach).rpc('share_progress_report', { p_report_id: report.id, p_shared: true }));
  assert.equal((await ok(as(ids.sara).rpc('list_progress_reports', { p_client_id: null }))).length, 1);
  assert.equal((await visible(ids.sara, 'progress_reports')).length, 1);

  assert.equal((await visible(ids.omar, 'progress_reports')).length, 0);
  assert.equal((await visible(ids.other, 'progress_reports')).length, 0);
  await fails(as(ids.other).rpc('list_progress_reports', { p_client_id: ids.sara }), /own clients/);
  await fails(as(ids.other).rpc('save_progress_report', { p_client_id: ids.sara, p_days: 30, p_body: REPORT }), /own clients/);
  await fails(as(ids.coach).rpc('save_progress_report', { p_client_id: ids.sara, p_days: 30, p_body: 'too short' }), /20 to 3000/);
});

test('a client can create, share and delete their own report', async () => {
  await seedActivity();
  const report = await ok(as(ids.sara).rpc('save_progress_report', { p_client_id: ids.sara, p_days: 30, p_body: REPORT }));
  assert.equal(report.shared, true);
  assert.equal(report.coach_id, ids.coach);
  assert.equal((await ok(as(ids.coach).rpc('list_progress_reports', { p_client_id: ids.sara }))).length, 1);

  await fails(as(ids.omar).rpc('delete_progress_report', { p_report_id: report.id }), /cannot remove/);
  await ok(as(ids.sara).rpc('delete_progress_report', { p_report_id: report.id }));
  assert.equal(await count('select count(*) as n from public.progress_reports'), 0);
});

// ------------------------------------------------------------------ Jack history

test('Jack conversations are saved per user and never readable by anyone else', async () => {
  const id = await ok(as(ids.sara).rpc('save_jack_messages', {
    p_conversation_id: null, p_title: 'Dinner ideas', p_messages: [{ role: 'user', content: 'What should I eat?', has_image: true }, { role: 'assistant', content: 'Try grilled chicken.' }],
  }));
  await ok(as(ids.sara).rpc('save_jack_messages', { p_conversation_id: id, p_title: null, p_messages: [{ role: 'user', content: 'Thanks' }] }));

  const list = await ok(as(ids.sara).rpc('list_jack_conversations', { p_limit: 20 }));
  assert.deepEqual([list.length, list[0].title, Number(list[0].message_count)], [1, 'Dinner ideas', 3]);
  const conversation = await ok(as(ids.sara).rpc('get_jack_conversation', { p_conversation_id: id }));
  assert.deepEqual(conversation.messages.map((message) => message.content), ['What should I eat?', 'Try grilled chicken.', 'Thanks']);
  assert.equal(conversation.messages[0].has_image, true);

  assert.deepEqual(await ok(as(ids.omar).rpc('list_jack_conversations', { p_limit: 20 })), []);
  assert.equal((await visible(ids.coach, 'jack_messages')).length, 0);
  assert.equal((await visible(ids.sara, 'jack_messages')).length, 3);
  await fails(as(ids.omar).rpc('get_jack_conversation', { p_conversation_id: id }), /not found/);
  await fails(as(ids.omar).rpc('save_jack_messages', { p_conversation_id: id, p_title: null, p_messages: [{ role: 'user', content: 'hi' }] }), /not found/);
  assert.ok((await as(ids.sara).sql("delete from public.jack_messages")).error, 'no direct writes');

  await ok(as(ids.omar).rpc('delete_jack_conversation', { p_conversation_id: id }));
  assert.equal(await count('select count(*) as n from public.jack_conversations'), 1);
  await ok(as(ids.sara).rpc('delete_jack_conversation', { p_conversation_id: id }));
  assert.equal(await count('select count(*) as n from public.jack_messages'), 0);
});

test('saving history validates its input and keeps only the newest conversations', async () => {
  await fails(as(ids.sara).rpc('save_jack_messages', { p_conversation_id: null, p_title: 'x', p_messages: [] }), /between 1 and 20/);
  await fails(as(ids.sara).rpc('save_jack_messages', { p_conversation_id: null, p_title: 'x', p_messages: [{ role: 'system', content: 'x' }] }), /role/);
  for (let index = 0; index < 102; index += 1) {
    await ok(as(ids.sara).rpc('save_jack_messages', { p_conversation_id: null, p_title: `Chat ${index}`, p_messages: [{ role: 'user', content: 'hi' }] }));
  }
  assert.equal(await count('select count(*) as n from public.jack_conversations where user_id = $1', [ids.sara]), 100);
});
