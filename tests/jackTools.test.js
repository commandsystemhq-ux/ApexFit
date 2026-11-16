import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runJack } from '../api/_lib/jackAgent.js';
import { executeTool, navigablePages, toolSpecsForRole, toolsForRole } from '../api/_lib/jackTools.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// These tests run the Jack tools against the real database schema (manual-setup.sql) in an in-process
// Postgres. Every call goes through the "authenticated" role as one user, so RLS and the role checks
// inside the SQL functions are genuinely in force.

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  saraK: '00000000-0000-4000-8000-0000000000c2',
  omar: '00000000-0000-4000-8000-0000000000c3',
  stranger: '00000000-0000-4000-8000-0000000000c4',
};
const TODAY = new Date().toISOString().slice(0, 10);

let db;

function contextFor(userId, role, access = {}) {
  return { user: { id: userId }, userClient: createUserClient(db, userId), role, today: TODAY, access: { role, ...access } };
}

const coach = () => contextFor(ids.coachA, 'coach', { full_name: 'Coach Amal', brand_name: 'Amal Strength' });
const client = (userId = ids.sara) => contextFor(userId, 'client');
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec(`
    truncate public.workflows, public.coach_messages, public.coach_clients, public.client_workout_sessions,
      public.client_body_metrics, public.community_posts, public.community_profiles, public.training_programs,
      public.exercises, public.point_events, public.program_assignments, public.profiles cascade;
    delete from auth.users;
  `);
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.saraK, 'sarak@example.com'], [ids.omar, 'omar@example.com'], [ids.stranger, 'x@example.com']]) {
    await addUser(db, { id, email, role: 'client' });
  }
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email) values
       ($1, $2, 'Sara Ali', 'sara@example.com'), ($1, $3, 'Sara Khan', 'sarak@example.com'), ($1, $4, 'Omar Hassan', 'omar@example.com')`,
    [ids.coachA, ids.sara, ids.saraK, ids.omar],
  );
  await db.query(
    `insert into public.exercises (slug, name, category, difficulty, is_published) values
       ('bench-press', 'Barbell Bench Press', 'strength', 'intermediate', true),
       ('incline-bench', 'Incline Bench Press', 'strength', 'intermediate', true),
       ('back-squat', 'Back Squat', 'strength', 'intermediate', true),
       ('hidden-move', 'Hidden Move', 'strength', 'intermediate', false)`,
  );
  await db.query(
    `insert into public.training_programs (coach_id, title, status) values
       ($1, 'Strength Basics', 'published'), ($1, 'Hypertrophy Plan', 'published'), ($2, 'Secret Plan', 'published')`,
    [ids.coachA, ids.coachB],
  );
});

test('each role is only offered its own tools, plus navigation', () => {
  const names = (role) => toolSpecsForRole(role).map((tool) => tool.name).sort();
  assert.deepEqual(names('coach'), ['assign_program_to_client', 'assign_program_to_group', 'create_community_post', 'create_contract', 'create_group', 'create_store_product', 'create_workflow', 'get_client_assessment', 'get_coach_summary', 'get_store_sales', 'invite_trainer', 'navigate_to', 'schedule_video_session']);
  assert.deepEqual(names('client'), ['get_my_contracts', 'get_my_groups', 'get_my_schedule', 'get_my_sessions', 'get_my_store', 'log_body_metrics', 'log_workout_completion', 'navigate_to']);
  assert.deepEqual(names('trainer'), ['navigate_to']);
  assert.deepEqual(names('stranger'), []);
  assert.equal(toolsForRole('coach').some((tool) => tool.roles.includes('client') && tool.name !== 'navigate_to'), false);
});

test('a client cannot run coach tools and a coach cannot run client tools, even if the model asks', async () => {
  const forbiddenForClient = await executeTool('create_workflow', { name: 'x', trigger_type: 'client_joined', steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'hi' }] }, client());
  assert.equal(forbiddenForClient.ok, false);
  assert.equal(forbiddenForClient.forbidden, true);
  assert.equal((await rows('select count(*)::int as n from public.workflows'))[0].n, 0);

  for (const name of ['assign_program_to_client', 'create_community_post', 'get_coach_summary', 'create_group', 'assign_program_to_group', 'get_client_assessment', 'create_contract', 'create_store_product', 'get_store_sales', 'schedule_video_session', 'invite_trainer']) {
    assert.equal((await executeTool(name, {}, client())).forbidden, true, name);
  }
  for (const name of ['log_workout_completion', 'log_body_metrics', 'get_my_schedule', 'get_my_groups', 'get_my_contracts', 'get_my_sessions', 'get_my_store']) {
    assert.equal((await executeTool(name, { title: 'x', weight_kg: 80 }, coach())).forbidden, true, name);
  }
  assert.equal((await executeTool('delete_everything', {}, coach())).ok, false);
});

test('the database itself rejects cross-role calls made with a user session', async () => {
  const asClient = createUserClient(db, ids.sara);
  const asCoach = createUserClient(db, ids.coachA);
  assert.match((await asClient.rpc('save_workflow', { p_workflow_id: null, p_name: 'x', p_description: '', p_trigger_type: 'client_joined', p_is_active: true, p_steps: [] })).error.message, /active coach/);
  assert.match((await asClient.rpc('get_coach_client_overview')).error.message, /active coach/);
  assert.match((await asCoach.rpc('log_workout_completion', { p_title: 'Run' })).error.message, /client account/);
  assert.match((await asCoach.rpc('get_my_schedule')).error.message, /client account/);
  const other = await asClient.from('client_body_metrics').upsert({ client_id: ids.omar, measured_on: TODAY, weight_kg: 70 }, { onConflict: 'client_id,measured_on' });
  assert.ok(other.error, 'a client cannot write another client\'s metrics');
});

test('create_workflow saves and activates a workflow that really fires', async () => {
  const result = await executeTool('create_workflow', {
    name: 'New client welcome',
    trigger_type: 'client_joined',
    steps: [
      { delay_days: 0, action_type: 'send_message', message_template: 'Welcome {client_name} to {brand_name}!' },
      { delay_days: 7, action_type: 'assign_task', task_title: 'Upload measurements', message_template: '' },
    ],
  }, coach());
  assert.equal(result.ok, true, result.error);
  assert.equal(result.result.active, true);

  const [workflow] = await rows('select id, coach_id, is_active, trigger_type from public.workflows');
  assert.equal(workflow.coach_id, ids.coachA);
  assert.equal(workflow.is_active, true);
  assert.equal((await rows('select count(*)::int as n from public.workflow_steps'))[0].n, 2);

  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Zed', 'z@example.com')", [ids.coachA, ids.stranger]);
  const messages = await rows('select body from public.coach_messages where client_id = $1', [ids.stranger]);
  assert.deepEqual(messages.map((message) => message.body), ['Welcome Zed to Amal Strength!']);

  const otherCoach = createUserClient(db, ids.coachB);
  assert.equal((await otherCoach.from('workflows').select('id')).data.length, 0, 'another coach cannot see it');
});

test('create_workflow rejects invalid definitions without writing anything', async () => {
  const bad = await executeTool('create_workflow', {
    name: '', trigger_type: 'sometimes',
    steps: [{ delay_days: -3, action_type: 'send_message', message_template: '' }],
  }, coach());
  assert.equal(bad.ok, false);
  assert.match(bad.error, /name/);
  assert.match(bad.error, /trigger_type/);
  assert.match(bad.error, /step 1/);
  assert.equal((await rows('select count(*)::int as n from public.workflows'))[0].n, 0);
  assert.equal((await executeTool('create_workflow', '{not json', coach())).ok, false);
});

test('assign_program_to_client finds clients by name or email and starts plan workflows', async () => {
  await executeTool('create_workflow', {
    name: 'Plan ready', trigger_type: 'plan_assigned',
    steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Your plan is ready, {client_name}.' }],
  }, coach());

  const byEmail = await executeTool('assign_program_to_client', { client: 'omar@example.com', program: 'strength basics' }, coach());
  assert.equal(byEmail.ok, true, byEmail.error);
  assert.equal(byEmail.result.client, 'Omar Hassan');
  assert.equal(byEmail.result.workflow_steps_queued, 1);
  assert.equal((await rows('select count(*)::int as n from public.program_assignments where client_id = $1', [ids.omar]))[0].n, 1);
  assert.deepEqual((await rows('select body from public.coach_messages where client_id = $1', [ids.omar])).map((row) => row.body), ['Your plan is ready, Omar Hassan.']);

  const byName = await executeTool('assign_program_to_client', { client: 'Sara Ali', program: 'Hypertrophy' }, coach());
  assert.equal(byName.ok, true, byName.error);
});

test('assign_program_to_client asks instead of guessing and never reaches other coaches\' data', async () => {
  const ambiguous = await executeTool('assign_program_to_client', { client: 'sara', program: 'Strength Basics' }, coach());
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /Several clients match/);

  const foreignProgram = await executeTool('assign_program_to_client', { client: 'Omar', program: 'Secret Plan' }, coach());
  assert.equal(foreignProgram.ok, false);
  assert.match(foreignProgram.error, /No program matches/);

  const foreignClient = await executeTool('assign_program_to_client', { client: 'x@example.com', program: 'Strength Basics' }, coach());
  assert.match(foreignClient.error, /No client matches/);
  assert.equal((await rows('select count(*)::int as n from public.program_assignments'))[0].n, 0);
});

test('create_community_post joins the coach to the community on first use and publishes', async () => {
  const first = await executeTool('create_community_post', { body: 'Great week, team!' }, coach());
  assert.equal(first.ok, true, first.error);
  const [profile] = await rows('select display_name from public.community_profiles where user_id = $1', [ids.coachA]);
  assert.equal(profile.display_name, 'Amal Strength');
  const [post] = await rows('select kind, body, coach_id, author_id from public.community_posts');
  assert.deepEqual([post.kind, post.body, post.coach_id, post.author_id], ['announcement', 'Great week, team!', ids.coachA, ids.coachA]);

  assert.equal((await executeTool('create_community_post', { body: 'One more', kind: 'update' }, coach())).ok, true);
  assert.equal((await rows('select count(*)::int as n from public.community_profiles'))[0].n, 1);
  assert.equal((await executeTool('create_community_post', { body: '   ' }, coach())).ok, false);
  assert.equal((await executeTool('create_community_post', { body: 'x'.repeat(1001) }, coach())).ok, false);
});

test('get_coach_summary reports engaged and absent clients without exposing emails', async () => {
  await db.query(
    `insert into public.client_workout_sessions (client_id, workout_date, title) values
       ($1, current_date, 'A'), ($1, current_date - 1, 'B'), ($1, current_date - 2, 'C'),
       ($2, current_date - 5, 'D')`,
    [ids.sara, ids.saraK],
  );
  const result = await executeTool('get_coach_summary', {}, coach());
  assert.equal(result.ok, true, result.error);
  const summary = result.result;
  assert.equal(summary.active_clients, 3);
  assert.deepEqual(summary.engaged_3plus_workouts_this_week.names, ['Sara Ali']);
  assert.deepEqual(summary.trained_in_last_2_days.names, ['Sara Ali']);
  assert.deepEqual(summary.absent_2plus_days.clients.map((item) => item.name).sort(), ['Omar Hassan', 'Sara Khan']);
  assert.equal(summary.absent_2plus_days.clients.find((item) => item.name === 'Omar Hassan').days_since_workout, null);
  assert.equal(JSON.stringify(summary).includes('@'), false);

  const otherCoach = await executeTool('get_coach_summary', {}, contextFor(ids.coachB, 'coach'));
  assert.equal(otherCoach.result.active_clients, 0);
});

test('navigate_to only opens pages the role may use', async () => {
  const coachNav = await executeTool('navigate_to', { page: 'workflows' }, coach());
  assert.equal(coachNav.ok, true);
  assert.equal(coachNav.navigate, '/workflows');
  assert.equal((await executeTool('navigate_to', { page: 'settings' }, coach())).navigate, '/settings');
  assert.equal((await executeTool('navigate_to', { page: 'workouts' }, coach())).ok, false);

  const clientNav = await executeTool('navigate_to', { page: 'coachHub' }, client());
  assert.equal(clientNav.navigate, '/coach-hub');
  assert.equal((await executeTool('navigate_to', { page: 'leaderboard' }, client())).navigate, '/leaderboard');
  assert.equal((await executeTool('navigate_to', { page: 'workflows' }, client())).ok, false);
  assert.equal((await executeTool('navigate_to', { page: '../../admin' }, client())).ok, false);

  assert.ok(navigablePages('coach').includes('workflows'));
  assert.ok(!navigablePages('client').includes('workflows'));
  assert.ok(!navigablePages('coach').includes('workouts'));
});

test('log_workout_completion records a workout once and awards points', async () => {
  const first = await executeTool('log_workout_completion', { title: 'Leg day' }, client());
  assert.equal(first.ok, true, first.error);
  assert.equal(first.result.already_logged, false);
  const repeat = await executeTool('log_workout_completion', { title: 'leg DAY' }, client());
  assert.equal(repeat.result.already_logged, true);
  assert.equal((await rows('select count(*)::int as n from public.client_workout_sessions where client_id = $1', [ids.sara]))[0].n, 1);
  assert.equal((await rows("select coalesce(sum(points), 0)::int as n from public.point_events where user_id = $1 and source = 'workout'", [ids.sara]))[0].n, 50);

  assert.equal((await executeTool('log_workout_completion', { title: '' }, client())).ok, false);
  assert.match((await executeTool('log_workout_completion', { title: 'Old', date: '2020-01-01' }, client())).error, /last 30 days/);
  assert.match((await executeTool('log_workout_completion', { title: 'Future', date: '2999-01-01' }, client())).error, /future/);
});

test('log_workout_completion saves lifted weights against real catalog exercises', async () => {
  const saved = await executeTool('log_workout_completion', {
    title: 'Push day',
    exercises: [
      { name: 'barbell bench', sets: [{ reps: 8, weight_kg: 80 }, { reps: 6, weight_kg: 85 }] },
      { name: 'back squat', sets: [{ reps: 5, weight_kg: 120 }] },
    ],
  }, client());
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(saved.result.exercises, ['Barbell Bench Press', 'Back Squat']);
  const sets = await rows('select actual_reps, actual_weight_kg::float as kg from public.client_workout_set_logs order by exercise_order, set_number');
  assert.deepEqual(sets.map((set) => [set.actual_reps, set.kg]), [[8, 80], [6, 85], [5, 120]]);

  const ambiguous = await executeTool('log_workout_completion', { title: 'x', exercises: [{ name: 'bench press', sets: [{ reps: 5 }] }] }, client());
  assert.match(ambiguous.error, /Several exercises match/);
  const unpublished = await executeTool('log_workout_completion', { title: 'x', exercises: [{ name: 'Hidden Move', sets: [{ reps: 5 }] }] }, client());
  assert.match(unpublished.error, /No exercise matches/);
  const badSet = await executeTool('log_workout_completion', { title: 'x', exercises: [{ name: 'Back Squat', sets: [{ reps: 0 }] }] }, client());
  assert.match(badSet.error, /reps between 1 and 200/);
  assert.equal((await rows('select count(*)::int as n from public.client_workout_sessions'))[0].n, 1, 'failed attempts write nothing');
});

test('log_body_metrics validates, merges values for the same day, and only touches the caller', async () => {
  assert.equal((await executeTool('log_body_metrics', { weight_kg: 82.5 }, client())).ok, true);
  assert.equal((await executeTool('log_body_metrics', { body_fat_percentage: 18 }, client())).ok, true);
  const [metric] = await rows('select weight_kg::float as weight, body_fat_percentage::float as fat, client_id from public.client_body_metrics');
  assert.deepEqual([metric.weight, metric.fat, metric.client_id], [82.5, 18, ids.sara]);

  assert.equal((await executeTool('log_body_metrics', { weight_kg: 900 }, client())).ok, false);
  assert.equal((await executeTool('log_body_metrics', {}, client())).ok, false);
  assert.match((await executeTool('log_body_metrics', { weight_kg: 80, date: 'yesterday' }, client())).error, /YYYY-MM-DD/);

  await executeTool('log_body_metrics', { weight_kg: 70 }, client(ids.omar));
  const all = await rows('select client_id, weight_kg::float as weight from public.client_body_metrics order by weight desc');
  assert.deepEqual(all.map((row) => [row.client_id, row.weight]), [[ids.sara, 82.5], [ids.omar, 70]]);
});

test('get_my_schedule shows the assigned program, sessions and workflow tasks to that client only', async () => {
  await db.query("insert into public.training_program_days (program_id, name, order_index) select id, 'Day 1 - Push', 0 from public.training_programs where title = 'Strength Basics'");
  await db.query("insert into public.training_program_exercises (day_id, exercise_id, order_index, sets, reps) select d.id, e.id, 0, 4, '8' from public.training_program_days d, public.exercises e where e.slug = 'bench-press'");
  await executeTool('create_workflow', {
    name: 'Tasks', trigger_type: 'plan_assigned',
    steps: [{ delay_days: 0, action_type: 'assign_task', task_title: 'Fill the PAR-Q', message_template: 'Takes 2 minutes.' }],
  }, coach());
  await executeTool('assign_program_to_client', { client: 'Sara Ali', program: 'Strength Basics' }, coach());
  await db.query(
    `insert into public.coach_sessions (coach_id, client_id, title, starts_at, ends_at)
     values ($1, $2, 'Form check', now() + interval '2 days', now() + interval '2 days 1 hour')`,
    [ids.coachA, ids.sara],
  );
  await executeTool('log_workout_completion', { title: 'Warm-up' }, client());

  const mine = await executeTool('get_my_schedule', {}, client());
  assert.equal(mine.ok, true, mine.error);
  assert.equal(mine.result.workout_logged_today, true);
  assert.equal(mine.result.coach_name, 'Amal Strength');
  assert.equal(mine.result.program.title, 'Strength Basics');
  assert.deepEqual(mine.result.program.days[0].exercises, [{ name: 'Barbell Bench Press', sets: 4, reps: '8' }]);
  assert.deepEqual(mine.result.upcoming_sessions.map((session) => session.title), ['Form check']);
  assert.deepEqual(mine.result.recent_tasks.map((task) => task.task), ['Fill the PAR-Q']);

  const theirs = await executeTool('get_my_schedule', {}, client(ids.omar));
  assert.equal(theirs.result.program, null);
  assert.deepEqual(theirs.result.upcoming_sessions, []);
  assert.deepEqual(theirs.result.recent_tasks, []);
});

test('the agent loop runs tools as the verified user, streams steps, and cannot be steered into other roles', async () => {
  const scripted = [
    { text: '', toolCalls: [{ id: 'c1', name: 'create_workflow', args: { name: 'Welcome', trigger_type: 'client_joined', steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Hi {client_name}' }] } }] },
    { text: '', toolCalls: [{ id: 'c2', name: 'log_body_metrics', args: { weight_kg: 80 } }, { id: 'c3', name: 'navigate_to', args: { page: 'workflows' } }] },
    { text: 'Done: workflow created and Workflows is open.', toolCalls: [] },
  ];
  const seenTools = [];
  const model = {
    async complete({ tools, messages }) {
      seenTools.push(tools.map((tool) => tool.name));
      const next = scripted.shift();
      assert.ok(next, `unexpected extra model call after ${messages.length} messages`);
      return next;
    },
  };
  const events = [];
  await runJack({ model, system: 'sys', history: [{ role: 'user', content: 'Set up a welcome workflow' }], ctx: coach(), emit: (event) => events.push(event) });

  assert.equal(seenTools.every((names) => !names.includes('log_body_metrics')), true, 'client tools are never offered to a coach');
  const steps = events.filter((event) => event.type === 'step').map((event) => [event.tool, event.status]);
  assert.deepEqual(steps, [
    ['create_workflow', 'running'], ['create_workflow', 'done'],
    ['log_body_metrics', 'running'], ['log_body_metrics', 'error'],
    ['navigate_to', 'running'], ['navigate_to', 'done'],
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'navigate'), [{ type: 'navigate', path: '/workflows' }]);
  assert.equal(events.at(-1).type, 'text');
  assert.equal((await rows('select count(*)::int as n from public.workflows'))[0].n, 1);
  assert.equal((await rows('select count(*)::int as n from public.client_body_metrics'))[0].n, 0);
});
