-- Read/write helpers used by the Jack assistant. Each function checks the caller's role itself,
-- so the assistant can only ever act through the signed-in user's own permissions.

-- A client marks a workout as done without entering every set.
create or replace function public.log_workout_completion(p_title text, p_date date default current_date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_id uuid;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to log workouts';
  end if;
  if char_length(v_title) not between 1 and 160 then
    raise exception 'Workout title must be between 1 and 160 characters';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 30 then
    raise exception 'Workout date must be within the last 30 days';
  end if;

  -- Retrying the same request must not create a second workout.
  select id into v_id
  from public.client_workout_sessions
  where client_id = auth.uid() and workout_date = p_date and lower(title) = lower(v_title)
  limit 1;
  if found then
    return jsonb_build_object('session_id', v_id, 'already_logged', true);
  end if;

  insert into public.client_workout_sessions (client_id, workout_date, title)
  values (auth.uid(), p_date, v_title)
  returning id into v_id;
  return jsonb_build_object('session_id', v_id, 'already_logged', false);
end;
$$;

-- Coach dashboard numbers: who trained recently and who has gone quiet.
-- Only workout dates and counts of the coach's own active clients are returned, never workout contents.
create or replace function public.get_coach_client_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clients jsonb;
  v_active integer;
  v_archived integer;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;

  select count(*) filter (where status = 'active')::integer, count(*) filter (where status = 'archived')::integer
  into v_active, v_archived
  from public.coach_clients where coach_id = auth.uid();

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'client_id', c.client_id,
      'name', coalesce(nullif(btrim(c.client_name), ''), nullif(split_part(coalesce(c.client_email, ''), '@', 1), ''), 'Client'),
      'joined_on', c.created_at::date,
      'last_workout_date', a.last_workout,
      'workouts_7d', a.workouts_7d,
      'week_points', a.week_points
    )
    order by a.last_workout nulls first, c.created_at
  ), '[]'::jsonb)
  into v_clients
  from (
    select * from public.coach_clients
    where coach_id = auth.uid() and status = 'active'
    order by created_at
    limit 200
  ) c
  cross join lateral (
    select
      (select max(s.workout_date) from public.client_workout_sessions s where s.client_id = c.client_id) as last_workout,
      (select count(*) from public.client_workout_sessions s
        where s.client_id = c.client_id and s.workout_date >= current_date - 6)::integer as workouts_7d,
      (select coalesce(sum(p.points), 0) from public.point_events p
        where p.user_id = c.client_id and p.event_date >= current_date - 6)::integer as week_points
  ) a;

  return jsonb_build_object(
    'today', current_date,
    'active_clients', v_active,
    'archived_clients', v_archived,
    'clients', v_clients,
    'workflows_total', (select count(*) from public.workflows where coach_id = auth.uid()),
    'workflows_active', (select count(*) from public.workflows where coach_id = auth.uid() and is_active),
    'programs', (select count(*) from public.training_programs where coach_id = auth.uid())
  );
end;
$$;

-- What a client has to do: coach sessions, the latest assigned program, and recent coach tasks.
create or replace function public.get_my_schedule()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_program jsonb;
  v_sessions jsonb;
  v_tasks jsonb;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;

  select jsonb_build_object(
    'title', p.title,
    'assigned_on', pa.assigned_at::date,
    'days', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', d.name,
          'exercises', coalesce((
            select jsonb_agg(jsonb_build_object('name', e.name, 'sets', pe.sets, 'reps', pe.reps) order by pe.order_index)
            from (
              select * from public.training_program_exercises x
              where x.day_id = d.id order by x.order_index limit 12
            ) pe
            join public.exercises e on e.id = pe.exercise_id
          ), '[]'::jsonb)
        )
        order by d.order_index
      )
      from (
        select * from public.training_program_days y
        where y.program_id = p.id order by y.order_index limit 7
      ) d
    ), '[]'::jsonb)
  )
  into v_program
  from public.program_assignments pa
  join public.training_programs p on p.id = pa.program_id
  where pa.client_id = auth.uid()
  order by pa.assigned_at desc
  limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object('title', s.title, 'starts_at', s.starts_at, 'ends_at', s.ends_at, 'location', s.location)
    order by s.starts_at
  ), '[]'::jsonb)
  into v_sessions
  from (
    select * from public.coach_sessions
    where client_id = auth.uid() and status = 'scheduled'
      and starts_at >= statement_timestamp() and starts_at < statement_timestamp() + interval '14 days'
    order by starts_at
    limit 10
  ) s;

  -- Workflow tasks arrive as coach notes that start with a localized "Task:" prefix.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'task', left(split_part(regexp_replace(m.body, '^[^:]+:\s*', ''), E'\n', 1), 160),
      'received_at', m.created_at,
      'seen', m.read_at is not null
    )
    order by m.created_at desc
  ), '[]'::jsonb)
  into v_tasks
  from (
    select * from public.coach_messages
    where client_id = auth.uid()
      and kind = 'note'
      and body ~ '^(Task|مهمة|Aufgabe|Tâche|Tarea): '
      and created_at > statement_timestamp() - interval '14 days'
    order by created_at desc
    limit 10
  ) m;

  return jsonb_build_object(
    'today', current_date,
    'workout_logged_today', exists (
      select 1 from public.client_workout_sessions where client_id = auth.uid() and workout_date = current_date
    ),
    'workouts_this_week', (
      select count(*) from public.client_workout_sessions
      where client_id = auth.uid() and workout_date >= current_date - 6
    ),
    'coach_name', (
      select coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), ''))
      from public.coach_clients cc
      left join public.profiles pr on pr.id = cc.coach_id
      where cc.client_id = auth.uid() and cc.status = 'active'
      order by cc.created_at desc
      limit 1
    ),
    'program', v_program,
    'upcoming_sessions', v_sessions,
    'recent_tasks', v_tasks
  );
end;
$$;

revoke all on function public.log_workout_completion(text, date) from public, anon;
revoke all on function public.get_coach_client_overview() from public, anon;
revoke all on function public.get_my_schedule() from public, anon;
grant execute on function public.log_workout_completion(text, date) to authenticated;
grant execute on function public.get_coach_client_overview() to authenticated;
grant execute on function public.get_my_schedule() to authenticated;
