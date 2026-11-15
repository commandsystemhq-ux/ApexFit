-- Automated coaching workflows: onboarding and follow-up sequences that run per client.
-- workflows / workflow_steps are the coach's definitions, workflow_logs records every scheduled
-- step per client (and is what prevents the same step from being sent twice).

create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 500),
  trigger_type text not null check (trigger_type in ('client_joined', 'plan_assigned', 'workout_missed', 'milestone_reached')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists workflows_coach_idx on public.workflows (coach_id, created_at desc);
create index if not exists workflows_active_trigger_idx on public.workflows (coach_id, trigger_type) where is_active;

create table if not exists public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  step_order integer not null check (step_order between 1 and 10),
  delay_days integer not null default 0 check (delay_days between 0 and 365),
  action_type text not null check (action_type in ('send_message', 'assign_task')),
  message_template text not null default '' check (length(message_template) <= 1500),
  task_title text not null default '' check (length(task_title) <= 120),
  unique (workflow_id, step_order),
  check (action_type <> 'send_message' or length(btrim(message_template)) > 0),
  check (action_type <> 'assign_task' or length(btrim(task_title)) > 0)
);

create table if not exists public.workflow_logs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  step_id uuid references public.workflow_steps (id) on delete set null,
  step_order integer not null check (step_order >= 1),
  coach_id uuid not null,
  client_id uuid not null,
  trigger_key text not null check (length(trigger_key) between 1 and 120),
  scheduled_for timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  executed_at timestamptz,
  message_batch_id uuid,
  note text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  -- One row per step, client and triggering event: re-running a trigger can never queue a step twice.
  unique (workflow_id, client_id, trigger_key, step_order)
);

create index if not exists workflow_logs_due_idx on public.workflow_logs (scheduled_for) where status = 'pending';
create index if not exists workflow_logs_coach_idx on public.workflow_logs (coach_id, created_at desc);
create index if not exists workflow_logs_client_idx on public.workflow_logs (client_id);

-- Training programs a coach has assigned to a client (the "plan_assigned" event).
create table if not exists public.program_assignments (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  client_id uuid not null,
  program_id uuid not null references public.training_programs (id) on delete cascade,
  assigned_at timestamptz not null default now(),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists program_assignments_coach_idx on public.program_assignments (coach_id, assigned_at desc);
create index if not exists program_assignments_client_idx on public.program_assignments (client_id, assigned_at desc);

alter table public.workflows enable row level security;
alter table public.workflow_steps enable row level security;
alter table public.workflow_logs enable row level security;
alter table public.program_assignments enable row level security;

drop policy if exists "Coaches can read their workflows" on public.workflows;
create policy "Coaches can read their workflows"
  on public.workflows for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Coaches can read their workflow steps" on public.workflow_steps;
create policy "Coaches can read their workflow steps"
  on public.workflow_steps for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.workflows w
      where w.id = workflow_steps.workflow_id and w.coach_id = (select auth.uid())
    )
  );

drop policy if exists "Coaches can read their workflow logs" on public.workflow_logs;
create policy "Coaches can read their workflow logs"
  on public.workflow_logs for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Coaches can read their program assignments" on public.program_assignments;
create policy "Coaches can read their program assignments"
  on public.program_assignments for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their program assignments" on public.program_assignments;
create policy "Clients can read their program assignments"
  on public.program_assignments for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

-- All writes go through the security definer functions below.
revoke all on public.workflows, public.workflow_steps, public.workflow_logs, public.program_assignments
  from anon, authenticated;
grant select on public.workflows, public.workflow_steps, public.workflow_logs, public.program_assignments
  to authenticated;
grant all on public.workflows, public.workflow_steps, public.workflow_logs, public.program_assignments
  to service_role;

-- ---------------------------------------------------------------------------
-- Engine internals (not callable from the browser)
-- ---------------------------------------------------------------------------

-- Replaces {client_name}, {coach_name} and {brand_name}. Matching is case-insensitive and ignores inner spaces.
create or replace function public.workflow_render_template(
  p_template text,
  p_client_name text,
  p_coach_name text,
  p_brand_name text
)
returns text
language plpgsql
immutable
as $$
declare
  v_text text := coalesce(p_template, '');
begin
  -- A backslash is special in a regexp replacement string (\1, \&), so double it in the values first.
  v_text := regexp_replace(v_text, '\{\s*client_name\s*\}',
    replace(coalesce(p_client_name, ''), '\', '\\'), 'gi');
  v_text := regexp_replace(v_text, '\{\s*coach_name\s*\}',
    replace(coalesce(p_coach_name, ''), '\', '\\'), 'gi');
  v_text := regexp_replace(v_text, '\{\s*brand_name\s*\}',
    replace(coalesce(p_brand_name, ''), '\', '\\'), 'gi');
  return v_text;
end;
$$;

create or replace function public.workflow_coach_is_active(p_coach_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.coach_subscriptions s on s.user_id = p.id
    where p.id = p_coach_id
      and p.role = 'coach'
      and (s.status = 'active' or p.trial_ends_at > statement_timestamp())
  );
$$;

-- Queues every step of one workflow for one client. Returns how many new rows were queued.
create or replace function public.workflow_schedule_one(
  p_workflow_id uuid,
  p_client_id uuid,
  p_trigger_key text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  insert into public.workflow_logs (workflow_id, step_id, step_order, coach_id, client_id, trigger_key, scheduled_for)
  select w.id, s.id, s.step_order, w.coach_id, p_client_id, p_trigger_key,
         statement_timestamp() + make_interval(days => s.delay_days)
  from public.workflows w
  join public.workflow_steps s on s.workflow_id = w.id
  join public.coach_clients cc on cc.coach_id = w.coach_id and cc.client_id = p_client_id and cc.status = 'active'
  where w.id = p_workflow_id
    and w.is_active
    and public.workflow_coach_is_active(w.coach_id)
  on conflict (workflow_id, client_id, trigger_key, step_order) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Queues every active workflow of the coach that listens to the given trigger.
create or replace function public.workflow_schedule(
  p_coach_id uuid,
  p_client_id uuid,
  p_trigger_type text,
  p_trigger_key text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workflow_id uuid;
  v_count integer := 0;
begin
  for v_workflow_id in
    select id from public.workflows
    where coach_id = p_coach_id and trigger_type = p_trigger_type and is_active
  loop
    v_count := v_count + public.workflow_schedule_one(v_workflow_id, p_client_id, p_trigger_key);
  end loop;
  return v_count;
end;
$$;

-- Executes one queued step. The row is locked and only a pending row can be sent, so a step is delivered at most once.
create or replace function public.workflow_execute(p_log_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_log public.workflow_logs%rowtype;
  v_workflow public.workflows%rowtype;
  v_step public.workflow_steps%rowtype;
  v_link public.coach_clients%rowtype;
  v_coach public.profiles%rowtype;
  v_locale text;
  v_client_name text;
  v_coach_name text;
  v_brand_name text;
  v_title text;
  v_body text;
  v_prefix text;
  v_batch uuid := gen_random_uuid();
  v_status text := 'sent';
  v_note text;
begin
  select * into v_log from public.workflow_logs where id = p_log_id for update;
  if not found then
    return 'missing';
  end if;
  if v_log.status <> 'pending' then
    return v_log.status;
  end if;

  select * into v_workflow from public.workflows where id = v_log.workflow_id;
  select * into v_step from public.workflow_steps
  where workflow_id = v_log.workflow_id and step_order = v_log.step_order;
  select * into v_link from public.coach_clients
  where coach_id = v_log.coach_id and client_id = v_log.client_id;
  select * into v_coach from public.profiles where id = v_log.coach_id;
  select locale into v_locale from public.profiles where id = v_log.client_id;

  if not v_workflow.is_active then
    v_status := 'skipped'; v_note := 'workflow_inactive';
  elsif v_step.id is null then
    v_status := 'skipped'; v_note := 'step_removed';
  elsif v_link.status is distinct from 'active' then
    v_status := 'skipped'; v_note := 'client_inactive';
  elsif not public.workflow_coach_is_active(v_log.coach_id) then
    v_status := 'skipped'; v_note := 'coach_inactive';
  else
    v_client_name := coalesce(
      nullif(btrim(v_link.client_name), ''),
      nullif(split_part(coalesce(v_link.client_email, ''), '@', 1), ''),
      'there'
    );
    v_coach_name := coalesce(
      nullif(btrim(v_coach.full_name), ''),
      nullif(btrim(v_link.coach_name), ''),
      nullif(split_part(coalesce(v_link.coach_email, ''), '@', 1), ''),
      'your coach'
    );
    v_brand_name := coalesce(nullif(btrim(v_coach.brand_name), ''), v_coach_name);

    if v_step.action_type = 'assign_task' then
      v_prefix := case coalesce(v_locale, 'en')
        when 'ar' then 'مهمة'
        when 'de' then 'Aufgabe'
        when 'fr' then 'Tâche'
        when 'es' then 'Tarea'
        else 'Task'
      end;
      v_title := public.workflow_render_template(v_step.task_title, v_client_name, v_coach_name, v_brand_name);
      v_body := v_prefix || ': ' || v_title;
      if btrim(v_step.message_template) <> '' then
        v_body := v_body || E'\n\n'
          || public.workflow_render_template(v_step.message_template, v_client_name, v_coach_name, v_brand_name);
      end if;
    else
      v_body := public.workflow_render_template(v_step.message_template, v_client_name, v_coach_name, v_brand_name);
    end if;
    v_body := left(btrim(v_body), 2000);

    if v_body = '' then
      v_status := 'skipped'; v_note := 'empty_message';
    else
      begin
        insert into public.coach_messages (batch_id, coach_id, client_id, kind, body)
        values (v_batch, v_log.coach_id, v_log.client_id, 'note', v_body);
      exception when others then
        v_status := 'failed'; v_note := left(sqlerrm, 300);
      end;
    end if;
  end if;

  update public.workflow_logs
  set status = v_status,
      executed_at = statement_timestamp(),
      message_batch_id = case when v_status = 'sent' then v_batch else null end,
      note = v_note
  where id = p_log_id;
  return v_status;
end;
$$;

-- Sends everything that is due. Optionally limited to one coach and/or client.
create or replace function public.workflow_run_due(
  p_coach_id uuid default null,
  p_client_id uuid default null,
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_sent integer := 0;
begin
  for v_id in
    select id from public.workflow_logs
    where status = 'pending'
      and scheduled_for <= statement_timestamp()
      and (p_coach_id is null or coach_id = p_coach_id)
      and (p_client_id is null or client_id = p_client_id)
    order by scheduled_for
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
    for update skip locked
  loop
    if public.workflow_execute(v_id) = 'sent' then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end;
$$;

-- "workout_missed": no workout for two days. The trigger key carries the last workout date, so
-- one stretch of absence starts the sequence once and a later absence starts it again.
create or replace function public.workflow_scan_missed_workouts(p_coach_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select cc.coach_id, cc.client_id,
           coalesce(max(s.workout_date), cc.created_at::date) as reference_date
    from public.coach_clients cc
    left join public.client_workout_sessions s on s.client_id = cc.client_id
    where cc.status = 'active'
      and (p_coach_id is null or cc.coach_id = p_coach_id)
      and exists (
        select 1 from public.workflows w
        where w.coach_id = cc.coach_id and w.trigger_type = 'workout_missed' and w.is_active
      )
    group by cc.coach_id, cc.client_id, cc.created_at
    having current_date - coalesce(max(s.workout_date), cc.created_at::date) >= 2
  loop
    v_count := v_count + public.workflow_schedule(r.coach_id, r.client_id, 'workout_missed', 'missed:' || r.reference_date);
  end loop;
  return v_count;
end;
$$;

-- "milestone_reached": a new level or badge. Milestones a client already held when the workflow was
-- created (or while it was paused) are recorded as skipped so they are not announced retroactively.
create or replace function public.workflow_scan_milestones(p_coach_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_summary jsonb;
  v_keys text[];
  v_key text;
  v_first_step uuid;
  v_baselined boolean;
  v_count integer := 0;
begin
  for r in
    select w.id as workflow_id, w.coach_id, w.is_active, w.created_at as workflow_created_at,
           cc.client_id, cc.created_at as joined_at
    from public.workflows w
    join public.coach_clients cc on cc.coach_id = w.coach_id and cc.status = 'active'
    where w.trigger_type = 'milestone_reached'
      and (p_coach_id is null or w.coach_id = p_coach_id)
      and exists (select 1 from public.workflow_steps s where s.workflow_id = w.id and s.step_order = 1)
  loop
    select id into v_first_step from public.workflow_steps where workflow_id = r.workflow_id and step_order = 1;
    v_summary := public.gamification_summary(r.client_id);
    v_keys := array(select 'badge:' || badge from jsonb_array_elements_text(coalesce(v_summary -> 'badges', '[]'::jsonb)) badge)
      || array(select 'level:' || n from generate_series(2, greatest(coalesce((v_summary ->> 'level')::integer, 1), 1)) n);

    select exists (
      select 1 from public.workflow_logs
      where workflow_id = r.workflow_id and client_id = r.client_id and trigger_key = 'baseline'
    ) into v_baselined;

    if not v_baselined then
      insert into public.workflow_logs (workflow_id, step_id, step_order, coach_id, client_id, trigger_key, scheduled_for, status, executed_at, note)
      values (r.workflow_id, v_first_step, 1, r.coach_id, r.client_id, 'baseline', statement_timestamp(), 'skipped', statement_timestamp(), 'baseline')
      on conflict do nothing;
    end if;

    foreach v_key in array v_keys loop
      continue when exists (
        select 1 from public.workflow_logs
        where workflow_id = r.workflow_id and client_id = r.client_id and trigger_key = v_key
      );

      if not r.is_active or (not v_baselined and r.joined_at < r.workflow_created_at) then
        insert into public.workflow_logs (workflow_id, step_id, step_order, coach_id, client_id, trigger_key, scheduled_for, status, executed_at, note)
        values (r.workflow_id, v_first_step, 1, r.coach_id, r.client_id, v_key, statement_timestamp(), 'skipped', statement_timestamp(),
                case when r.is_active then 'baseline' else 'workflow_inactive' end)
        on conflict do nothing;
      else
        v_count := v_count + public.workflow_schedule_one(r.workflow_id, r.client_id, v_key);
      end if;
    end loop;
  end loop;
  return v_count;
end;
$$;

-- Trigger: a client joined a coach (invite redeemed).
create or replace function public.workflow_on_client_joined()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Automation problems must never block a client from joining.
  begin
    perform public.workflow_schedule(new.coach_id, new.client_id, 'client_joined', 'joined');
    perform public.workflow_run_due(new.coach_id, new.client_id);
  exception when others then
    raise warning 'workflow client_joined failed: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists coach_clients_run_workflows on public.coach_clients;
create trigger coach_clients_run_workflows
  after insert on public.coach_clients
  for each row execute function public.workflow_on_client_joined();

-- Full engine pass for every coach; scheduled with pg_cron or the /api/workflows cron endpoint.
create or replace function public.run_workflow_engine()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_queued integer;
  v_sent integer;
begin
  v_queued := public.workflow_scan_missed_workouts(null) + public.workflow_scan_milestones(null);
  v_sent := public.workflow_run_due(null, null, 2000);
  return jsonb_build_object('queued', v_queued, 'sent', v_sent);
end;
$$;

revoke all on function public.workflow_render_template(text, text, text, text) from public, anon, authenticated;
revoke all on function public.workflow_coach_is_active(uuid) from public, anon, authenticated;
revoke all on function public.workflow_schedule_one(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.workflow_schedule(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.workflow_execute(uuid) from public, anon, authenticated;
revoke all on function public.workflow_run_due(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.workflow_scan_missed_workouts(uuid) from public, anon, authenticated;
revoke all on function public.workflow_scan_milestones(uuid) from public, anon, authenticated;
revoke all on function public.workflow_on_client_joined() from public, anon, authenticated;
revoke all on function public.run_workflow_engine() from public, anon, authenticated;
grant execute on function public.run_workflow_engine() to service_role;

-- ---------------------------------------------------------------------------
-- Coach-facing functions
-- ---------------------------------------------------------------------------

create or replace function public.save_workflow(
  p_workflow_id uuid,
  p_name text,
  p_description text,
  p_trigger_type text,
  p_is_active boolean,
  p_steps jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_old_trigger text;
  v_step jsonb;
  v_order integer := 0;
  v_action text;
  v_delay integer;
  v_message text;
  v_task text;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage workflows';
  end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Give the workflow a name of up to 120 characters';
  end if;
  if char_length(v_description) > 500 then
    raise exception 'The description cannot exceed 500 characters';
  end if;
  if p_trigger_type is null or p_trigger_type not in ('client_joined', 'plan_assigned', 'workout_missed', 'milestone_reached') then
    raise exception 'Choose a supported trigger';
  end if;
  if jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) not between 1 and 10 then
    raise exception 'A workflow needs between 1 and 10 steps';
  end if;

  if p_workflow_id is null then
    if (select count(*) from public.workflows where coach_id = auth.uid()) >= 25 then
      raise exception 'You can have at most 25 workflows';
    end if;
    insert into public.workflows (coach_id, name, description, trigger_type, is_active)
    values (auth.uid(), v_name, v_description, p_trigger_type, coalesce(p_is_active, true))
    returning id into v_id;
  else
    select trigger_type into v_old_trigger
    from public.workflows
    where id = p_workflow_id and coach_id = auth.uid()
    for update;
    if not found then
      raise exception 'Workflow was not found';
    end if;
    v_id := p_workflow_id;
    update public.workflows
    set name = v_name, description = v_description, trigger_type = p_trigger_type,
        is_active = coalesce(p_is_active, is_active)
    where id = v_id;
    if v_old_trigger <> p_trigger_type then
      update public.workflow_logs
      set status = 'skipped', executed_at = statement_timestamp(), note = 'trigger_changed'
      where workflow_id = v_id and status = 'pending';
    end if;
  end if;

  -- Steps keep their position as identity so queued log rows stay attached when a workflow is edited.
  for v_step in select value from jsonb_array_elements(p_steps)
  loop
    v_order := v_order + 1;
    v_action := v_step ->> 'action_type';
    v_message := btrim(coalesce(v_step ->> 'message_template', ''));
    v_task := btrim(coalesce(v_step ->> 'task_title', ''));

    if coalesce(v_step ->> 'delay_days', '0') !~ '^[0-9]{1,3}$' then
      raise exception 'Step % has an invalid delay', v_order;
    end if;
    v_delay := coalesce(v_step ->> 'delay_days', '0')::integer;
    if v_delay > 365 then
      raise exception 'Step % has an invalid delay', v_order;
    end if;
    if v_action is null or v_action not in ('send_message', 'assign_task') then
      raise exception 'Step % has an unsupported action', v_order;
    end if;
    if char_length(v_message) > 1500 or char_length(v_task) > 120 then
      raise exception 'Step % is too long', v_order;
    end if;
    if v_action = 'send_message' and v_message = '' then
      raise exception 'Step % needs a message', v_order;
    end if;
    if v_action = 'assign_task' and v_task = '' then
      raise exception 'Step % needs a task title', v_order;
    end if;

    insert into public.workflow_steps (workflow_id, step_order, delay_days, action_type, message_template, task_title)
    values (v_id, v_order, v_delay, v_action, v_message, v_task)
    on conflict (workflow_id, step_order) do update
    set delay_days = excluded.delay_days,
        action_type = excluded.action_type,
        message_template = excluded.message_template,
        task_title = excluded.task_title;
  end loop;
  delete from public.workflow_steps where workflow_id = v_id and step_order > v_order;

  -- Take the milestone baseline now so clients' existing badges are not announced.
  if p_trigger_type = 'milestone_reached' then
    perform public.workflow_scan_milestones(auth.uid());
  end if;
  return v_id;
end;
$$;

create or replace function public.set_workflow_active(p_workflow_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trigger text;
  v_current boolean;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage workflows';
  end if;
  select trigger_type, is_active into v_trigger, v_current
  from public.workflows where id = p_workflow_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Workflow was not found';
  end if;

  -- While paused, new milestones are marked as seen so switching back on does not announce them late.
  if coalesce(p_is_active, false) and not v_current and v_trigger = 'milestone_reached' then
    perform public.workflow_scan_milestones(auth.uid());
  end if;
  update public.workflows set is_active = coalesce(p_is_active, false) where id = p_workflow_id;
end;
$$;

create or replace function public.delete_workflow(p_workflow_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage workflows';
  end if;
  delete from public.workflows where id = p_workflow_id and coach_id = auth.uid();
  if not found then
    raise exception 'Workflow was not found';
  end if;
end;
$$;

-- Lets a coach process their own clients immediately instead of waiting for the scheduled run.
create or replace function public.run_my_workflow_engine()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_queued integer;
  v_sent integer;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage workflows';
  end if;
  v_queued := public.workflow_scan_missed_workouts(auth.uid()) + public.workflow_scan_milestones(auth.uid());
  v_sent := public.workflow_run_due(auth.uid(), null, 500);
  return jsonb_build_object('queued', v_queued, 'sent', v_sent);
end;
$$;

-- Assigning a program records the assignment and starts every active "plan_assigned" workflow.
create or replace function public.assign_program_to_client(p_client_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment uuid;
  v_queued integer;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to assign programs';
  end if;
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = auth.uid()) then
    raise exception 'Program was not found';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;

  insert into public.program_assignments (coach_id, client_id, program_id)
  values (auth.uid(), p_client_id, p_program_id)
  returning id into v_assignment;

  v_queued := public.workflow_schedule(auth.uid(), p_client_id, 'plan_assigned', 'program:' || v_assignment);
  perform public.workflow_run_due(auth.uid(), p_client_id);
  return jsonb_build_object('assignment_id', v_assignment, 'steps_queued', v_queued);
end;
$$;

revoke all on function public.save_workflow(uuid, text, text, text, boolean, jsonb) from public, anon;
revoke all on function public.set_workflow_active(uuid, boolean) from public, anon;
revoke all on function public.delete_workflow(uuid) from public, anon;
revoke all on function public.run_my_workflow_engine() from public, anon;
revoke all on function public.assign_program_to_client(uuid, uuid) from public, anon;
grant execute on function public.save_workflow(uuid, text, text, text, boolean, jsonb) to authenticated;
grant execute on function public.set_workflow_active(uuid, boolean) to authenticated;
grant execute on function public.delete_workflow(uuid) to authenticated;
grant execute on function public.run_my_workflow_engine() to authenticated;
grant execute on function public.assign_program_to_client(uuid, uuid) to authenticated;

-- Hourly engine pass when pg_cron is available; otherwise use the /api/workflows endpoint (vercel.json cron).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'apexfit-workflow-engine';
    perform cron.schedule('apexfit-workflow-engine', '15 * * * *', 'select public.run_workflow_engine()');
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end;
$$;
