-- Launch system: accountability tasks with XP, Jack conversation history, and shareable progress reports.

-- ---------------------------------------------------------------------------
-- XP: completed tasks earn points like workouts and meals do
-- ---------------------------------------------------------------------------
alter table public.point_events drop constraint if exists point_events_source_check;
alter table public.point_events
  add constraint point_events_source_check check (source in ('workout', 'food', 'habit', 'metric', 'task'));

-- ---------------------------------------------------------------------------
-- Who may manage a client's tasks and reports
-- ---------------------------------------------------------------------------
-- Returns the head coach the work belongs to: the caller for a coach with that active client, the team's head coach for an
-- assistant trainer who has the "manage programs" permission and is assigned that client. Otherwise null.
create or replace function public.task_coach_for(p_client_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_client_id is null or auth.uid() is null then null
    when public.is_active_coach() and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = auth.uid() and cc.client_id = p_client_id and cc.status = 'active'
    ) then auth.uid()
    when public.team_permission('manage_programs') and public.trainer_has_client(p_client_id) then public.my_team_head()
    else null
  end;
$$;

revoke all on function public.task_coach_for(uuid) from public, anon;
grant execute on function public.task_coach_for(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
-- source: 'coach' = assigned by the coach, 'jack' = assigned by Jack for the coach, 'self' = added by the client.
-- Completion rates only count tasks the coach side assigned; self-added tasks earn little XP and are capped per day.
create table if not exists public.client_tasks (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid references public.profiles (id) on delete set null,
  client_id uuid not null references public.profiles (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  source text not null default 'coach' check (source in ('coach', 'jack', 'self')),
  kind text not null check (kind in ('workout', 'habit', 'check_in')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  due_date date not null,
  xp integer not null default 20 check (xp between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'done')),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists client_tasks_client_due_idx on public.client_tasks (client_id, due_date);
create index if not exists client_tasks_coach_due_idx on public.client_tasks (coach_id, due_date);

alter table public.client_tasks enable row level security;

drop policy if exists "Clients read their tasks" on public.client_tasks;
create policy "Clients read their tasks"
  on public.client_tasks for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches read their clients tasks" on public.client_tasks;
create policy "Coaches read their clients tasks"
  on public.client_tasks for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Trainers read assigned clients tasks" on public.client_tasks;
create policy "Trainers read assigned clients tasks"
  on public.client_tasks for select
  to authenticated
  using (
    coach_id = public.my_team_head()
    and public.team_permission('manage_programs')
    and public.trainer_has_client(client_id)
  );

revoke all on public.client_tasks from public, anon, authenticated;
grant select on public.client_tasks to authenticated;
grant all on public.client_tasks to service_role;

create or replace function public.client_task_json(p_task public.client_tasks)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_task.id,
    'client_id', p_task.client_id,
    'coach_id', p_task.coach_id,
    'source', p_task.source,
    'kind', p_task.kind,
    'title', p_task.title,
    'description', p_task.description,
    'due_date', p_task.due_date,
    'xp', p_task.xp,
    'status', p_task.status,
    'completed_at', p_task.completed_at,
    'is_overdue', p_task.status = 'pending' and p_task.due_date < current_date
  );
$$;

revoke all on function public.client_task_json(public.client_tasks) from public, anon, authenticated;

-- A coach (or an allowed assistant trainer) gives a client a task.
create or replace function public.assign_client_task(
  p_client_id uuid,
  p_kind text,
  p_title text,
  p_description text default '',
  p_due_date date default null,
  p_xp integer default 20,
  p_source text default 'coach'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := public.task_coach_for(p_client_id);
  v_due date := coalesce(p_due_date, current_date);
  v_task public.client_tasks;
begin
  if v_coach is null then
    raise exception 'You can only assign tasks to your own active clients.' using errcode = '42501';
  end if;
  if p_kind not in ('workout', 'habit', 'check_in') then
    raise exception 'Choose a task type: workout, habit or check_in.' using errcode = '22023';
  end if;
  if p_source not in ('coach', 'jack') then
    raise exception 'Invalid task source.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 120 then
    raise exception 'The task title must be 1 to 120 characters.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_description, '')) > 500 then
    raise exception 'The task description is too long.' using errcode = '22023';
  end if;
  if coalesce(p_xp, 20) not between 1 and 100 then
    raise exception 'XP must be between 1 and 100.' using errcode = '22023';
  end if;
  if v_due < current_date - 1 or v_due > current_date + 90 then
    raise exception 'The due date must be within the next 90 days.' using errcode = '22023';
  end if;
  if (select count(*) from public.client_tasks where client_id = p_client_id and status = 'pending') >= 60 then
    raise exception 'This client already has 60 open tasks. Wait for some to be completed first.' using errcode = '54000';
  end if;

  insert into public.client_tasks (coach_id, client_id, created_by, source, kind, title, description, due_date, xp)
  values (v_coach, p_client_id, auth.uid(), p_source, p_kind, btrim(p_title), btrim(coalesce(p_description, '')), v_due, coalesce(p_xp, 20))
  returning * into v_task;

  return public.client_task_json(v_task);
end;
$$;

-- A client adds a small task for themselves (Jack does this on request). Worth little XP and capped per day.
create or replace function public.add_my_task(
  p_kind text,
  p_title text,
  p_description text default '',
  p_due_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_due date := coalesce(p_due_date, current_date);
  v_task public.client_tasks;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'Only clients can add tasks for themselves.' using errcode = '42501';
  end if;
  if p_kind not in ('workout', 'habit', 'check_in') then
    raise exception 'Choose a task type: workout, habit or check_in.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 120 then
    raise exception 'The task title must be 1 to 120 characters.' using errcode = '22023';
  end if;
  if char_length(coalesce(p_description, '')) > 500 then
    raise exception 'The task description is too long.' using errcode = '22023';
  end if;
  if v_due < current_date - 1 or v_due > current_date + 7 then
    raise exception 'Your own tasks can be due within the next 7 days.' using errcode = '22023';
  end if;
  if (select count(*) from public.client_tasks where client_id = auth.uid() and source = 'self' and status = 'pending') >= 20 then
    raise exception 'You already have 20 open tasks of your own.' using errcode = '54000';
  end if;

  insert into public.client_tasks (coach_id, client_id, created_by, source, kind, title, description, due_date, xp)
  values (
    (select cc.coach_id from public.coach_clients cc where cc.client_id = auth.uid() and cc.status = 'active' order by cc.created_at limit 1),
    auth.uid(), auth.uid(), 'self', p_kind, btrim(p_title), btrim(coalesce(p_description, '')), v_due, 5
  )
  returning * into v_task;

  return public.client_task_json(v_task);
end;
$$;

-- A client ticks a task off (or back). Completing it earns XP once; unticking takes the XP back.
create or replace function public.complete_my_task(p_task_id uuid, p_done boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.client_tasks;
  v_self_today integer;
  v_awarded integer := 0;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'Only clients can complete their tasks.' using errcode = '42501';
  end if;

  select * into v_task from public.client_tasks where id = p_task_id and client_id = auth.uid() for update;
  if not found then
    raise exception 'Task not found.' using errcode = 'P0002';
  end if;

  if coalesce(p_done, true) then
    if v_task.status <> 'done' then
      update public.client_tasks set status = 'done', completed_at = now() where id = v_task.id returning * into v_task;
    end if;
    -- Tasks a client adds for themselves earn at most 25 XP a day.
    select coalesce(sum(t.xp), 0) into v_self_today
    from public.client_tasks t
    where t.client_id = auth.uid() and t.source = 'self' and t.status = 'done' and t.id <> v_task.id
      and t.completed_at::date = current_date;
    if v_task.source <> 'self' or v_self_today + v_task.xp <= 25 then
      perform public.award_points(auth.uid(), 'task', v_task.id, current_date, v_task.xp, 150);
    end if;
  else
    update public.client_tasks set status = 'pending', completed_at = null where id = v_task.id returning * into v_task;
    delete from public.point_events where source = 'task' and source_id = v_task.id;
  end if;

  select coalesce(sum(points), 0) into v_awarded from public.point_events where source = 'task' and source_id = v_task.id;
  return public.client_task_json(v_task) || jsonb_build_object('xp_awarded', v_awarded);
end;
$$;

create or replace function public.delete_my_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.client_tasks
  where id = p_task_id and client_id = auth.uid() and source = 'self' and status = 'pending' and public.is_client_account();
  if not found then
    raise exception 'Only your own open tasks can be removed.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.delete_client_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid;
begin
  select client_id into v_client from public.client_tasks where id = p_task_id and status = 'pending' and source <> 'self';
  if v_client is null or public.task_coach_for(v_client) is null then
    raise exception 'Only open tasks assigned to your own clients can be removed.' using errcode = '42501';
  end if;
  delete from public.client_tasks where id = p_task_id;
end;
$$;

-- Completion numbers for one client over the last p_days days, counting tasks the coach side assigned.
create or replace function public.task_stats(p_client_id uuid, p_days integer)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with window_tasks as (
    select t.status
    from public.client_tasks t
    where t.client_id = p_client_id and t.source <> 'self'
      and t.due_date between current_date - (least(greatest(p_days, 1), 365) - 1) and current_date
  )
  select jsonb_build_object(
    'assigned', (select count(*) from window_tasks),
    'done', (select count(*) from window_tasks where status = 'done'),
    'rate', (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'done') / count(*))::integer end from window_tasks),
    'pending', (select count(*) from public.client_tasks t where t.client_id = p_client_id and t.status = 'pending'),
    'overdue', (select count(*) from public.client_tasks t where t.client_id = p_client_id and t.status = 'pending' and t.due_date < current_date),
    'xp_total', (select coalesce(sum(points), 0) from public.point_events where user_id = p_client_id),
    'xp_period', (select coalesce(sum(points), 0) from public.point_events
                  where user_id = p_client_id and event_date >= current_date - (least(greatest(p_days, 1), 365) - 1))
  );
$$;

revoke all on function public.task_stats(uuid, integer) from public, anon, authenticated;

create or replace function public.get_my_tasks()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'Only clients have tasks.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'tasks', coalesce((
      select jsonb_agg(public.client_task_json(t) order by (t.status = 'done'), t.due_date, t.created_at)
      from (
        select * from public.client_tasks
        where client_id = auth.uid() and (status = 'pending' or due_date >= current_date - 7)
        order by (status = 'done'), due_date, created_at
        limit 100
      ) t
    ), '[]'::jsonb),
    'stats', public.task_stats(auth.uid(), 30)
  );
end;
$$;

create or replace function public.get_client_tasks(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public.task_coach_for(p_client_id) is null then
    raise exception 'You can only see tasks of your own clients.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'tasks', coalesce((
      select jsonb_agg(public.client_task_json(t) order by (t.status = 'done'), t.due_date, t.created_at)
      from (
        select * from public.client_tasks
        where client_id = p_client_id and (status = 'pending' or due_date >= current_date - 30)
        order by (status = 'done'), due_date, created_at
        limit 100
      ) t
    ), '[]'::jsonb),
    'stats', public.task_stats(p_client_id, 30)
  );
end;
$$;

-- One row per client the caller looks after: how much of the assigned work got done.
create or replace function public.get_task_completion_rates(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_active_coach() or public.team_permission('manage_programs')) then
    raise exception 'Only coaches can see completion rates.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'client_id', cc.client_id,
        'client_name', coalesce(nullif(btrim(cc.client_name), ''), cc.client_email),
        'last_days', least(greatest(p_days, 1), 365)
      ) || public.task_stats(cc.client_id, p_days)
      order by cc.client_name
    )
    from public.coach_clients cc
    where cc.status = 'active' and (
      (public.is_active_coach() and cc.coach_id = auth.uid())
      or (public.team_permission('manage_programs') and cc.coach_id = public.my_team_head() and public.trainer_has_client(cc.client_id))
    )
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Progress reports
-- ---------------------------------------------------------------------------
-- The numbers are computed here from the client's own logs; Jack only writes the words around them.
create or replace function public.progress_stats_for(p_client_id uuid, p_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_from date := current_date - (least(greatest(coalesce(p_days, 30), 1), 365) - 1);
  v_first_weight numeric;
  v_last_weight numeric;
  v_first_fat numeric;
  v_last_fat numeric;
  v_name text;
begin
  select split_part(btrim(coalesce(nullif(p.full_name, ''), (select nullif(cc.client_name, '') from public.coach_clients cc where cc.client_id = p_client_id limit 1), '')), ' ', 1)
  into v_name from public.profiles p where p.id = p_client_id;

  select weight_kg into v_first_weight from public.client_body_metrics
    where client_id = p_client_id and measured_on >= v_from and weight_kg is not null order by measured_on asc limit 1;
  select weight_kg into v_last_weight from public.client_body_metrics
    where client_id = p_client_id and measured_on >= v_from and weight_kg is not null order by measured_on desc limit 1;
  select body_fat_percentage into v_first_fat from public.client_body_metrics
    where client_id = p_client_id and measured_on >= v_from and body_fat_percentage is not null order by measured_on asc limit 1;
  select body_fat_percentage into v_last_fat from public.client_body_metrics
    where client_id = p_client_id and measured_on >= v_from and body_fat_percentage is not null order by measured_on desc limit 1;

  return jsonb_build_object(
    'client_id', p_client_id,
    'first_name', coalesce(v_name, ''),
    'period_days', v_days,
    'period_start', v_from,
    'period_end', current_date,
    'workouts', (select count(*) from public.client_workout_sessions where client_id = p_client_id and workout_date >= v_from),
    'sets_logged', (
      select count(*) from public.client_workout_set_logs l
      join public.client_workout_sessions s on s.id = l.session_id
      where s.client_id = p_client_id and s.workout_date >= v_from
    ),
    'volume_kg', (
      select coalesce(round(sum(l.actual_reps * l.actual_weight_kg)), 0) from public.client_workout_set_logs l
      join public.client_workout_sessions s on s.id = l.session_id
      where s.client_id = p_client_id and s.workout_date >= v_from and l.actual_weight_kg is not null
    ),
    'heaviest_kg', (
      select max(l.actual_weight_kg) from public.client_workout_set_logs l
      join public.client_workout_sessions s on s.id = l.session_id
      where s.client_id = p_client_id and s.workout_date >= v_from
    ),
    'weight_start_kg', v_first_weight,
    'weight_end_kg', v_last_weight,
    'weight_change_kg', case when v_first_weight is null then null else round(v_last_weight - v_first_weight, 1) end,
    'body_fat_start', v_first_fat,
    'body_fat_end', v_last_fat,
    'body_fat_change', case when v_first_fat is null then null else round(v_last_fat - v_first_fat, 1) end,
    'food_days', (select count(distinct logged_on) from public.client_food_logs where client_id = p_client_id and logged_on >= v_from),
    'avg_calories', (
      select round(avg(day_total)) from (
        select sum(calories) as day_total from public.client_food_logs
        where client_id = p_client_id and logged_on >= v_from group by logged_on
      ) d
    ),
    'avg_sleep_hours', (select round(avg(sleep_hours), 1) from public.client_habit_logs where client_id = p_client_id and habit_date >= v_from and sleep_hours is not null),
    'avg_steps', (select round(avg(steps)) from public.client_habit_logs where client_id = p_client_id and habit_date >= v_from and steps is not null),
    'tasks', public.task_stats(p_client_id, v_days)
  );
end;
$$;

revoke all on function public.progress_stats_for(uuid, integer) from public, anon, authenticated;

create or replace function public.get_progress_stats(p_client_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (
    (p_client_id = auth.uid() and public.is_client_account())
    or public.task_coach_for(p_client_id) is not null
  ) then
    raise exception 'You can only build reports for yourself or your own clients.' using errcode = '42501';
  end if;
  return public.progress_stats_for(p_client_id, p_days);
end;
$$;

create table if not exists public.progress_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  coach_id uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  period_days integer not null check (period_days between 1 and 365),
  period_start date not null,
  period_end date not null,
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object'),
  body text not null check (char_length(btrim(body)) between 20 and 3000),
  shared boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists progress_reports_client_idx on public.progress_reports (client_id, created_at desc);

alter table public.progress_reports enable row level security;

drop policy if exists "Clients read reports shared with them" on public.progress_reports;
create policy "Clients read reports shared with them"
  on public.progress_reports for select
  to authenticated
  using (client_id = (select auth.uid()) and shared and public.is_client_account());

drop policy if exists "Coaches read their clients reports" on public.progress_reports;
create policy "Coaches read their clients reports"
  on public.progress_reports for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Trainers read assigned clients reports" on public.progress_reports;
create policy "Trainers read assigned clients reports"
  on public.progress_reports for select
  to authenticated
  using (
    coach_id = public.my_team_head()
    and public.team_permission('manage_programs')
    and public.trainer_has_client(client_id)
  );

revoke all on public.progress_reports from public, anon, authenticated;
grant select on public.progress_reports to authenticated;
grant all on public.progress_reports to service_role;

-- Stores a report. A coach saves one for a client (hidden from the client until shared); a client saves their own (shared).
create or replace function public.save_progress_report(p_client_id uuid, p_days integer, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_self boolean := p_client_id = auth.uid() and public.is_client_account();
  v_coach uuid;
  v_stats jsonb;
  v_report public.progress_reports;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if v_self then
    select cc.coach_id into v_coach from public.coach_clients cc where cc.client_id = auth.uid() and cc.status = 'active' order by cc.created_at limit 1;
  else
    v_coach := public.task_coach_for(p_client_id);
    if v_coach is null then
      raise exception 'You can only write reports for your own clients.' using errcode = '42501';
    end if;
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 20 and 3000 then
    raise exception 'The report must be 20 to 3000 characters.' using errcode = '22023';
  end if;
  if (select count(*) from public.progress_reports where client_id = p_client_id and created_at > now() - interval '1 day') >= 10 then
    raise exception 'Ten reports were already created for this client today.' using errcode = '54000';
  end if;

  v_stats := public.progress_stats_for(p_client_id, p_days);
  insert into public.progress_reports (client_id, coach_id, created_by, period_days, period_start, period_end, stats, body, shared)
  values (
    p_client_id, v_coach, auth.uid(), (v_stats ->> 'period_days')::integer,
    (v_stats ->> 'period_start')::date, (v_stats ->> 'period_end')::date, v_stats, btrim(p_body), v_self
  )
  returning * into v_report;

  return to_jsonb(v_report);
end;
$$;

create or replace function public.list_progress_reports(p_client_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := coalesce(p_client_id, auth.uid());
begin
  if v_client = auth.uid() and public.is_client_account() then
    return coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc)
      from (select * from public.progress_reports where client_id = auth.uid() and shared order by created_at desc limit 30) r
    ), '[]'::jsonb);
  end if;
  if public.task_coach_for(v_client) is null then
    raise exception 'You can only see reports of your own clients.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at desc)
    from (select * from public.progress_reports where client_id = v_client order by created_at desc limit 30) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.share_progress_report(p_report_id uuid, p_shared boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid;
  v_report public.progress_reports;
begin
  select client_id into v_client from public.progress_reports where id = p_report_id;
  if v_client is null or public.task_coach_for(v_client) is null then
    raise exception 'You can only share reports of your own clients.' using errcode = '42501';
  end if;
  update public.progress_reports set shared = coalesce(p_shared, true) where id = p_report_id returning * into v_report;
  return to_jsonb(v_report);
end;
$$;

create or replace function public.delete_progress_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid;
begin
  select client_id into v_client from public.progress_reports where id = p_report_id;
  if v_client is null or not (
    public.task_coach_for(v_client) is not null
    or (v_client = auth.uid() and public.is_client_account() and exists (
      select 1 from public.progress_reports where id = p_report_id and created_by = auth.uid()
    ))
  ) then
    raise exception 'You cannot remove this report.' using errcode = '42501';
  end if;
  delete from public.progress_reports where id = p_report_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Jack conversation history (private to each user)
-- ---------------------------------------------------------------------------
create table if not exists public.jack_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null default 'New chat' check (char_length(btrim(title)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jack_conversations_user_idx on public.jack_conversations (user_id, updated_at desc);

create table if not exists public.jack_messages (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  conversation_id uuid not null references public.jack_conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '' check (char_length(content) <= 4000),
  -- Photos are analysed and discarded; only the fact that one was sent is kept.
  has_image boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists jack_messages_conversation_idx on public.jack_messages (conversation_id, seq);

alter table public.jack_conversations enable row level security;
alter table public.jack_messages enable row level security;

drop policy if exists "Users read their Jack conversations" on public.jack_conversations;
create policy "Users read their Jack conversations"
  on public.jack_conversations for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users read their Jack messages" on public.jack_messages;
create policy "Users read their Jack messages"
  on public.jack_messages for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.jack_conversations, public.jack_messages from public, anon, authenticated;
grant select on public.jack_conversations, public.jack_messages to authenticated;
grant all on public.jack_conversations, public.jack_messages to service_role;

-- Appends messages to a conversation, starting a new one when no id is given. Returns the conversation id.
create or replace function public.save_jack_messages(p_conversation_id uuid, p_title text, p_messages jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid := p_conversation_id;
  v_message jsonb;
  v_content text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) not between 1 and 20 then
    raise exception 'Send between 1 and 20 messages.' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.jack_conversations (user_id, title)
    values (auth.uid(), left(coalesce(nullif(btrim(p_title), ''), 'New chat'), 80))
    returning id into v_id;
    -- Keep the newest 100 conversations.
    delete from public.jack_conversations
    where user_id = auth.uid() and id in (
      select id from public.jack_conversations where user_id = auth.uid() order by updated_at desc offset 100
    );
  elsif not exists (select 1 from public.jack_conversations where id = v_id and user_id = auth.uid()) then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;

  if (select count(*) from public.jack_messages where conversation_id = v_id) + jsonb_array_length(p_messages) > 400 then
    raise exception 'This conversation is full. Start a new chat.' using errcode = '54000';
  end if;

  for v_message in select * from jsonb_array_elements(p_messages) loop
    if v_message ->> 'role' not in ('user', 'assistant') then
      raise exception 'Invalid message role.' using errcode = '22023';
    end if;
    v_content := left(coalesce(v_message ->> 'content', ''), 4000);
    insert into public.jack_messages (conversation_id, user_id, role, content, has_image)
    values (v_id, auth.uid(), v_message ->> 'role', v_content, coalesce((v_message ->> 'has_image')::boolean, false));
  end loop;

  update public.jack_conversations set updated_at = now() where id = v_id;
  return v_id;
end;
$$;

create or replace function public.list_jack_conversations(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'title', c.title, 'created_at', c.created_at, 'updated_at', c.updated_at,
    'message_count', (select count(*) from public.jack_messages m where m.conversation_id = c.id)
  ) order by c.updated_at desc), '[]'::jsonb)
  from (
    select * from public.jack_conversations where user_id = auth.uid()
    order by updated_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) c;
$$;

create or replace function public.get_jack_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation public.jack_conversations;
begin
  select * into v_conversation from public.jack_conversations where id = p_conversation_id and user_id = auth.uid();
  if not found then
    raise exception 'Conversation not found.' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'id', v_conversation.id,
    'title', v_conversation.title,
    'updated_at', v_conversation.updated_at,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content, 'has_image', m.has_image, 'created_at', m.created_at) order by m.seq)
      from public.jack_messages m where m.conversation_id = v_conversation.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.delete_jack_conversation(p_conversation_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.jack_conversations where id = p_conversation_id and user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Permissions on the new functions
-- ---------------------------------------------------------------------------
revoke all on function public.assign_client_task(uuid, text, text, text, date, integer, text) from public, anon;
revoke all on function public.add_my_task(text, text, text, date) from public, anon;
revoke all on function public.complete_my_task(uuid, boolean) from public, anon;
revoke all on function public.delete_my_task(uuid) from public, anon;
revoke all on function public.delete_client_task(uuid) from public, anon;
revoke all on function public.get_my_tasks() from public, anon;
revoke all on function public.get_client_tasks(uuid) from public, anon;
revoke all on function public.get_task_completion_rates(integer) from public, anon;
revoke all on function public.get_progress_stats(uuid, integer) from public, anon;
revoke all on function public.save_progress_report(uuid, integer, text) from public, anon;
revoke all on function public.list_progress_reports(uuid) from public, anon;
revoke all on function public.share_progress_report(uuid, boolean) from public, anon;
revoke all on function public.delete_progress_report(uuid) from public, anon;
revoke all on function public.save_jack_messages(uuid, text, jsonb) from public, anon;
revoke all on function public.list_jack_conversations(integer) from public, anon;
revoke all on function public.get_jack_conversation(uuid) from public, anon;
revoke all on function public.delete_jack_conversation(uuid) from public, anon;

grant execute on function public.assign_client_task(uuid, text, text, text, date, integer, text) to authenticated;
grant execute on function public.add_my_task(text, text, text, date) to authenticated;
grant execute on function public.complete_my_task(uuid, boolean) to authenticated;
grant execute on function public.delete_my_task(uuid) to authenticated;
grant execute on function public.delete_client_task(uuid) to authenticated;
grant execute on function public.get_my_tasks() to authenticated;
grant execute on function public.get_client_tasks(uuid) to authenticated;
grant execute on function public.get_task_completion_rates(integer) to authenticated;
grant execute on function public.get_progress_stats(uuid, integer) to authenticated;
grant execute on function public.save_progress_report(uuid, integer, text) to authenticated;
grant execute on function public.list_progress_reports(uuid) to authenticated;
grant execute on function public.share_progress_report(uuid, boolean) to authenticated;
grant execute on function public.delete_progress_report(uuid) to authenticated;
grant execute on function public.save_jack_messages(uuid, text, jsonb) to authenticated;
grant execute on function public.list_jack_conversations(integer) to authenticated;
grant execute on function public.get_jack_conversation(uuid) to authenticated;
grant execute on function public.delete_jack_conversation(uuid) to authenticated;
