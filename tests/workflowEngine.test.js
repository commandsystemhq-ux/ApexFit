import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Runs the real workflow migration inside an in-process Postgres. Only the tables and helpers
// it depends on are stubbed (auth, profiles, coach links, messages, programs, workout log, gamification).
const MIGRATION = new URL('../supabase/migrations/20261115000800_automated_workflows.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  grant usage on schema public to anon, authenticated, service_role;
  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant execute on function auth.uid() to anon, authenticated, service_role;

  create table public.profiles (
    id uuid primary key,
    role text not null,
    locale text not null default 'en',
    full_name text,
    brand_name text,
    trial_ends_at timestamptz
  );
  create table public.coach_subscriptions (user_id uuid primary key, status text not null);
  create table public.coach_clients (
    coach_id uuid not null references public.profiles (id) on delete cascade,
    client_id uuid not null references public.profiles (id) on delete cascade,
    client_email text, client_name text, coach_email text, coach_name text,
    status text not null default 'active' check (status in ('active', 'archived')),
    created_at timestamptz not null default now(),
    primary key (coach_id, client_id)
  );
  create table public.coach_messages (
    id uuid primary key default gen_random_uuid(),
    batch_id uuid not null,
    coach_id uuid not null,
    client_id uuid not null,
    kind text not null check (kind in ('note', 'video')),
    body text not null default '' check (length(body) <= 2000),
    video_path text,
    created_at timestamptz not null default now(),
    read_at timestamptz,
    foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
  );
  create table public.training_programs (id uuid primary key default gen_random_uuid(), coach_id uuid not null, title text not null);
  create table public.client_workout_sessions (
    id uuid primary key default gen_random_uuid(),
    client_id uuid not null,
    workout_date date not null default current_date
  );
  create table public.test_summaries (client_id uuid primary key, summary jsonb not null);

  create function public.is_active_coach() returns boolean language sql stable security definer as $$
    select exists (
      select 1 from public.profiles p
      left join public.coach_subscriptions s on s.user_id = p.id
      where p.id = auth.uid() and p.role = 'coach' and (s.status = 'active' or p.trial_ends_at > now())
    )
  $$;
  create function public.is_client_account() returns boolean language sql stable security definer as $$
    select exists (select 1 from public.profiles where id = auth.uid() and role = 'client')
  $$;
  create function public.gamification_summary(p_user_id uuid) returns jsonb language sql stable as $$
    select coalesce(
      (select summary from public.test_summaries where client_id = p_user_id),
      '{"level": 1, "badges": []}'::jsonb
    )
  $$;
`;

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};

const ONBOARDING = [
  { delay_days: 0, action_type: 'send_message', message_template: 'Hi {client_name}, welcome to {brand_name}! - {coach_name}', task_title: '' },
  { delay_days: 3, action_type: 'send_message', message_template: 'How is your first week going, {client_name}?', task_title: '' },
  { delay_days: 7, action_type: 'assign_task', message_template: 'Upload your measurements.', task_title: 'Body measurements for {client_name}' },
];

let db;

async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows;
}

async function as(userId, run) {
  await db.query("select set_config('test.uid', $1, false)", [userId]);
  await db.exec('set role authenticated');
  try {
    return await run();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('test.uid', '', false)");
  }
}

async function saveWorkflow(userId, { id = null, name = 'Onboarding', description = '', trigger = 'client_joined', active = true, steps = ONBOARDING } = {}) {
  return as(userId, async () => {
    const result = await rows('select public.save_workflow($1, $2, $3, $4, $5, $6::jsonb) as id', [id, name, description, trigger, active, JSON.stringify(steps)]);
    return result[0].id;
  });
}

async function join(clientId, coachId = ids.coachA, fields = {}) {
  await db.query(
    'insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name, coach_email) values ($1, $2, $3, $4, $5, $6)',
    [coachId, clientId, fields.name ?? null, fields.email ?? 'client@example.com', fields.coachName ?? 'Legacy Name', 'coach@example.com'],
  );
}

const messagesFor = (clientId) => rows('select body, kind from public.coach_messages where client_id = $1 order by created_at, body', [clientId]);
const logsFor = (clientId) => rows('select step_order, trigger_key, status, note from public.workflow_logs where client_id = $1 order by trigger_key, step_order', [clientId]);
const fastForward = (days) => db.query("update public.workflow_logs set scheduled_for = scheduled_for - make_interval(days => $1) where status = 'pending'", [days]);
const runEngine = () => as(ids.coachA, async () => (await rows('select public.run_my_workflow_engine() as result'))[0].result);

before(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await db.exec(`
    truncate public.workflows, public.coach_messages, public.coach_clients, public.profiles,
      public.coach_subscriptions, public.training_programs, public.client_workout_sessions, public.test_summaries cascade;
  `);
  await db.query(
    `insert into public.profiles (id, role, locale, full_name, brand_name, trial_ends_at) values
       ($1, 'coach', 'en', 'Coach Amal', 'Amal Strength', now() + interval '3 days'),
       ($2, 'coach', 'en', 'Coach Ben', null, now() + interval '3 days'),
       ($3, 'client', 'en', 'Sara', null, null),
       ($4, 'client', 'ar', 'Omar', null, null)`,
    [ids.coachA, ids.coachB, ids.sara, ids.omar],
  );
});

test('manual-setup.sql contains the workflow migration', () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  const manual = readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(manual.includes(migration));
});

test('the migration can be applied again without errors', async () => {
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('a coach creates a workflow with ordered steps and edits it in place', async () => {
  const id = await saveWorkflow(ids.coachA, { description: 'Welcome sequence' });
  const created = await rows('select step_order, delay_days, action_type, id from public.workflow_steps where workflow_id = $1 order by step_order', [id]);
  assert.deepEqual(created.map((step) => [step.step_order, step.delay_days, step.action_type]), [[1, 0, 'send_message'], [2, 3, 'send_message'], [3, 7, 'assign_task']]);

  await saveWorkflow(ids.coachA, { id, name: 'Renamed', steps: ONBOARDING.slice(0, 2) });
  const edited = await rows('select step_order, id from public.workflow_steps where workflow_id = $1 order by step_order', [id]);
  assert.equal(edited.length, 2);
  assert.equal(edited[0].id, created[0].id, 'existing steps keep their identity');
  assert.equal((await rows('select name from public.workflows where id = $1', [id]))[0].name, 'Renamed');
});

test('invalid workflow definitions are rejected', async () => {
  await assert.rejects(saveWorkflow(ids.coachA, { name: '  ' }), /name/i);
  await assert.rejects(saveWorkflow(ids.coachA, { trigger: 'whenever' }), /trigger/i);
  await assert.rejects(saveWorkflow(ids.coachA, { steps: [] }), /between 1 and 10/);
  await assert.rejects(saveWorkflow(ids.coachA, { steps: [{ delay_days: 0, action_type: 'send_message', message_template: '  ' }] }), /needs a message/);
  await assert.rejects(saveWorkflow(ids.coachA, { steps: [{ delay_days: 0, action_type: 'assign_task', task_title: '' }] }), /needs a task title/);
  await assert.rejects(saveWorkflow(ids.coachA, { steps: [{ delay_days: 999, action_type: 'send_message', message_template: 'x' }] }), /invalid delay/);
  await assert.rejects(saveWorkflow(ids.coachA, { steps: [{ delay_days: 0, action_type: 'call_client', message_template: 'x' }] }), /unsupported action/);
  await assert.rejects(saveWorkflow(ids.sara), /active coach/);
});

test('joining a coach sends the day-0 step immediately and schedules the rest', async () => {
  const id = await saveWorkflow(ids.coachA);
  await join(ids.sara, ids.coachA, { name: 'Sara Ali' });

  const messages = await messagesFor(ids.sara);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, 'Hi Sara Ali, welcome to Amal Strength! - Coach Amal');
  assert.equal(messages[0].kind, 'note');

  const logs = await rows('select step_order, status, scheduled_for > now() + interval \'2 days\' as later from public.workflow_logs where workflow_id = $1 order by step_order', [id]);
  assert.deepEqual(logs.map((log) => [log.step_order, log.status]), [[1, 'sent'], [2, 'pending'], [3, 'pending']]);
  assert.equal(logs[1].later, true);
});

test('delayed steps are delivered once, on their day, and never repeated', async () => {
  await saveWorkflow(ids.coachA);
  await join(ids.sara, ids.coachA, { name: 'Sara' });

  await runEngine();
  assert.equal((await messagesFor(ids.sara)).length, 1, 'nothing is due yet');

  await fastForward(3);
  assert.equal((await runEngine()).sent, 1);
  assert.equal((await runEngine()).sent, 0, 'a second pass sends nothing new');
  assert.equal((await messagesFor(ids.sara)).length, 2);

  await fastForward(4);
  assert.equal((await runEngine()).sent, 1);
  const bodies = (await messagesFor(ids.sara)).map((message) => message.body);
  assert.equal(bodies.length, 3);
  assert.ok(bodies.includes('Task: Body measurements for Sara\n\nUpload your measurements.'));
  assert.deepEqual((await logsFor(ids.sara)).map((log) => log.status), ['sent', 'sent', 'sent']);
});

test('re-running a trigger does not queue or send a step twice', async () => {
  await saveWorkflow(ids.coachA);
  await join(ids.sara);
  await db.exec("select public.workflow_schedule('" + ids.coachA + "', '" + ids.sara + "', 'client_joined', 'joined')");
  await db.exec("select public.workflow_run_due('" + ids.coachA + "', '" + ids.sara + "')");
  await db.exec(`insert into public.coach_clients (coach_id, client_id) values ('${ids.coachA}', '${ids.sara}') on conflict (coach_id, client_id) do update set status = 'active'`);

  assert.equal((await logsFor(ids.sara)).length, 3);
  assert.equal((await messagesFor(ids.sara)).length, 1);
  assert.equal((await rows('select public.workflow_execute(id) as status from public.workflow_logs where step_order = 1'))[0].status, 'sent', 'a sent step is reported, not resent');
  assert.equal((await messagesFor(ids.sara)).length, 1);
});

test('variables fall back gracefully and special characters survive', async () => {
  await saveWorkflow(ids.coachB, {
    steps: [{ delay_days: 0, action_type: 'send_message', message_template: '{ CLIENT_NAME } / {coach_name} / {brand_name} / {unknown}' }],
  });
  await join(ids.omar, ids.coachB, { name: 'Omar & Sons \\ Co', email: 'omar@example.com' });
  assert.equal((await messagesFor(ids.omar))[0].body, 'Omar & Sons \\ Co / Coach Ben / Coach Ben / {unknown}');

  await db.exec(`update public.coach_clients set client_name = null`);
  await db.exec(`delete from public.coach_messages`);
  await db.exec(`update public.workflow_logs set status = 'pending'`);
  await db.exec(`select public.workflow_run_due()`);
  assert.equal((await messagesFor(ids.omar))[0].body, 'omar / Coach Ben / Coach Ben / {unknown}');
});

test('assign_task messages use the client language', async () => {
  await saveWorkflow(ids.coachA, {
    steps: [{ delay_days: 0, action_type: 'assign_task', message_template: '', task_title: 'Fill the PAR-Q' }],
  });
  await join(ids.omar, ids.coachA, { name: 'Omar' });
  assert.equal((await messagesFor(ids.omar))[0].body, 'مهمة: Fill the PAR-Q');
});

test('inactive workflows neither start nor deliver', async () => {
  const id = await saveWorkflow(ids.coachA, { active: false });
  await join(ids.sara);
  assert.equal((await logsFor(ids.sara)).length, 0);

  await as(ids.coachA, () => db.query('select public.set_workflow_active($1, true)', [id]));
  await join(ids.omar);
  assert.equal((await messagesFor(ids.omar)).length, 1);

  await as(ids.coachA, () => db.query('select public.set_workflow_active($1, false)', [id]));
  await fastForward(3);
  assert.equal((await runEngine()).sent, 0);
  assert.ok((await logsFor(ids.omar)).some((log) => log.status === 'skipped' && log.note === 'workflow_inactive'));
});

test('archived clients and clients of lapsed coaches are skipped', async () => {
  await saveWorkflow(ids.coachA);
  await join(ids.sara);
  await join(ids.omar);
  await db.exec(`update public.coach_clients set status = 'archived' where client_id = '${ids.sara}'`);
  await db.exec(`update public.profiles set trial_ends_at = now() - interval '1 day' where id = '${ids.coachA}'`);
  await fastForward(8);
  await db.exec('select public.workflow_run_due()');

  assert.deepEqual((await logsFor(ids.sara)).filter((log) => log.step_order > 1).map((log) => log.note), ['client_inactive', 'client_inactive']);
  assert.deepEqual((await logsFor(ids.omar)).filter((log) => log.step_order > 1).map((log) => log.note), ['coach_inactive', 'coach_inactive']);
});

test('assigning a program starts plan_assigned workflows once per assignment', async () => {
  await saveWorkflow(ids.coachA, {
    name: 'New plan', trigger: 'plan_assigned',
    steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Your new plan is ready, {client_name}!' }],
  });
  await join(ids.sara, ids.coachA, { name: 'Sara' });
  const [{ id: programId }] = await rows("insert into public.training_programs (coach_id, title) values ($1, 'Strength') returning id", [ids.coachA]);

  const first = await as(ids.coachA, async () => (await rows('select public.assign_program_to_client($1, $2) as result', [ids.sara, programId]))[0].result);
  assert.equal(first.steps_queued, 1);
  await as(ids.coachA, () => db.query('select public.assign_program_to_client($1, $2)', [ids.sara, programId]));
  assert.equal((await messagesFor(ids.sara)).length, 2, 'each assignment is its own event');

  await assert.rejects(as(ids.coachB, () => db.query('select public.assign_program_to_client($1, $2)', [ids.sara, programId])), /Program was not found/);
});

test('workout_missed starts after two days without a workout, once per absence', async () => {
  await saveWorkflow(ids.coachA, {
    name: 'Missed', trigger: 'workout_missed',
    steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'We missed you, {client_name}.' }],
  });
  await join(ids.sara, ids.coachA, { name: 'Sara' });
  await join(ids.omar, ids.coachA, { name: 'Omar' });
  await db.exec(`update public.coach_clients set created_at = now() - interval '10 days'`);
  await db.exec(`insert into public.client_workout_sessions (client_id, workout_date) values
    ('${ids.sara}', current_date - 3), ('${ids.omar}', current_date - 1)`);

  assert.equal((await runEngine()).sent, 1);
  assert.equal((await runEngine()).sent, 0, 'the same absence is not announced twice');
  assert.equal((await messagesFor(ids.sara)).length, 1);
  assert.equal((await messagesFor(ids.omar)).length, 0);

  await db.exec(`insert into public.client_workout_sessions (client_id, workout_date) values ('${ids.sara}', current_date - 2)`);
  assert.equal((await runEngine()).sent, 1, 'training again and then missing two days is a new absence');
  assert.equal((await runEngine()).sent, 0);
  assert.equal((await messagesFor(ids.sara)).length, 2);
});

test('milestone_reached ignores milestones held before the workflow existed and announces new ones once', async () => {
  await join(ids.sara, ids.coachA, { name: 'Sara' });
  await db.query("insert into public.test_summaries values ($1, '{\"level\": 2, \"badges\": [\"first_workout\"]}')", [ids.sara]);
  await db.exec(`update public.coach_clients set created_at = now() - interval '5 days'`);

  await saveWorkflow(ids.coachA, {
    name: 'Milestones', trigger: 'milestone_reached',
    steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Congrats {client_name}, milestone unlocked!' }],
  });
  assert.equal((await runEngine()).sent, 0, 'existing level and badge are the baseline');

  await db.query("update public.test_summaries set summary = '{\"level\": 3, \"badges\": [\"first_workout\", \"streak_7\"]}' where client_id = $1", [ids.sara]);
  assert.equal((await runEngine()).sent, 2, 'level 3 and the streak_7 badge');
  assert.equal((await runEngine()).sent, 0);
  assert.equal((await messagesFor(ids.sara)).length, 2);
  assert.deepEqual(
    (await logsFor(ids.sara)).filter((log) => log.status === 'sent').map((log) => log.trigger_key).sort(),
    ['badge:streak_7', 'level:3'],
  );
});

test('milestones reached while a workflow is paused are not announced late', async () => {
  const id = await saveWorkflow(ids.coachA, {
    name: 'Milestones', trigger: 'milestone_reached',
    steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Congrats!' }],
  });
  await join(ids.sara);
  await as(ids.coachA, () => db.query('select public.set_workflow_active($1, false)', [id]));
  await db.query("insert into public.test_summaries values ($1, '{\"level\": 2, \"badges\": [\"workouts_10\"]}')", [ids.sara]);
  await as(ids.coachA, () => db.query('select public.set_workflow_active($1, true)', [id]));
  assert.equal((await runEngine()).sent, 0);
});

test('each coach only sees and manages their own workflows', async () => {
  const id = await saveWorkflow(ids.coachA);
  await join(ids.sara);

  assert.equal((await as(ids.coachB, () => rows('select id from public.workflows'))).length, 0);
  assert.equal((await as(ids.coachB, () => rows('select id from public.workflow_steps'))).length, 0);
  assert.equal((await as(ids.coachB, () => rows('select id from public.workflow_logs'))).length, 0);
  assert.equal((await as(ids.coachA, () => rows('select id from public.workflows'))).length, 1);
  assert.equal((await as(ids.sara, () => rows('select id from public.workflows'))).length, 0);

  await assert.rejects(saveWorkflow(ids.coachB, { id }), /not found/);
  await assert.rejects(as(ids.coachB, () => db.query('select public.set_workflow_active($1, false)', [id])), /not found/);
  await assert.rejects(as(ids.coachB, () => db.query('select public.delete_workflow($1)', [id])), /not found/);
  await assert.rejects(as(ids.coachB, () => db.query('insert into public.workflows (coach_id, name, trigger_type) values ($1, $2, $3)', [ids.coachB, 'x', 'client_joined'])), /permission denied/);
  await assert.rejects(as(ids.coachA, () => db.query('select public.workflow_execute(id) from public.workflow_logs')), /permission denied/);
  await assert.rejects(as(ids.coachA, () => db.query('select public.run_workflow_engine()')), /permission denied/);

  await as(ids.coachA, () => db.query('select public.delete_workflow($1)', [id]));
  assert.equal((await rows('select count(*)::int as n from public.workflow_logs'))[0].n, 0);
});
