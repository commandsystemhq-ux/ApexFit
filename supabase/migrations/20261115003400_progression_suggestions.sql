-- Smart progression suggestions. The system looks at what a client really lifted and, when they completed the top of
-- the target repetitions on every set in two sessions in a row, it suggests a heavier weight (or, for exercises done
-- without weight, more repetitions). A suggestion is only a suggestion: nothing changes until the coach (or an
-- assistant trainer who may manage programs) applies it. Applying writes the client's own target for that exercise,
-- so the shared program of other clients is never touched; dismissing keeps the plan as it was.
--
-- Security: clients read their own targets; the coach side reads and decides on the suggestions of the clients they
-- look after (public.task_coach_for). Nothing is written directly: refresh and decide are functions that check who asks.

create table if not exists public.client_exercise_targets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  coach_id uuid references public.profiles (id) on delete set null,
  target_weight_kg numeric(7, 2) check (target_weight_kg is null or target_weight_kg between 0 and 1000),
  target_reps integer check (target_reps is null or target_reps between 1 and 200),
  source_suggestion_id uuid,
  updated_at timestamptz not null default now(),
  unique (client_id, exercise_id),
  check (num_nonnulls(target_weight_kg, target_reps) > 0)
);

create table if not exists public.progression_suggestions (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  program_id uuid references public.training_programs (id) on delete set null,
  kind text not null check (kind in ('weight', 'reps')),
  current_weight_kg numeric(7, 2),
  current_reps integer,
  suggested_weight_kg numeric(7, 2) check (suggested_weight_kg is null or suggested_weight_kg between 0 and 1000),
  suggested_reps integer check (suggested_reps is null or suggested_reps between 1 and 200),
  reason jsonb not null default '{}'::jsonb check (jsonb_typeof(reason) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id) on delete set null,
  check ((kind = 'weight' and suggested_weight_kg is not null) or (kind = 'reps' and suggested_reps is not null)),
  check (status = 'pending' or decided_at is not null)
);

-- A client has at most one open suggestion per exercise.
create unique index if not exists progression_suggestions_one_pending
  on public.progression_suggestions (client_id, exercise_id) where status = 'pending';
create index if not exists progression_suggestions_coach_idx on public.progression_suggestions (coach_id, status, created_at desc);
create index if not exists progression_suggestions_client_idx on public.progression_suggestions (client_id, exercise_id, decided_at);

alter table public.client_exercise_targets enable row level security;
alter table public.progression_suggestions enable row level security;

drop policy if exists "Clients can read their own targets" on public.client_exercise_targets;
create policy "Clients can read their own targets"
  on public.client_exercise_targets for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their clients targets" on public.client_exercise_targets;
create policy "Coaches can read their clients targets"
  on public.client_exercise_targets for select
  to authenticated
  using (public.task_coach_for(client_id) is not null);

drop policy if exists "Coaches can read their clients suggestions" on public.progression_suggestions;
create policy "Coaches can read their clients suggestions"
  on public.progression_suggestions for select
  to authenticated
  using (public.task_coach_for(client_id) is not null);

revoke all on public.client_exercise_targets, public.progression_suggestions from anon, authenticated;
grant select on public.client_exercise_targets, public.progression_suggestions to authenticated;

-- The rule for one client. Returns how many new suggestions were written.
-- For each exercise of the programs the coach gave the client: the last two sessions in which it was logged must each
-- have at least the target number of working sets (the sets at the heaviest weight of the session, so lighter warm-up sets do not count), every one with at least the top of the target repetitions ("8-12" means 12).
-- Weighted exercises then get the weight raised by 5% (rounded to 2.5 kg, at least 2.5 kg) from the lightest weight
-- used in those sessions; exercises without weight get 2 more repetitions. Only sessions after the coach's last
-- decision on that exercise count, and nothing is suggested while a target the client has not reached yet is open.
create or replace function public.progression_for_client(p_client_id uuid, p_coach_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_top integer;
  v_since date;
  v_sessions integer;
  v_min_sets integer;
  v_min_reps integer;
  v_min_weight numeric;
  v_dates date[];
  v_target_weight numeric;
  v_inc numeric;
  v_new integer := 0;
  v_inserted integer;
begin
  for r in
    select distinct on (pe.exercise_id) pe.exercise_id, pe.sets, pe.reps, p.id as program_id
    from public.program_assignments pa
    join public.training_programs p on p.id = pa.program_id
    join public.training_program_days d on d.program_id = p.id
    join public.training_program_exercises pe on pe.day_id = d.id
    where pa.client_id = p_client_id and pa.coach_id = p_coach_id
    order by pe.exercise_id, pa.assigned_at desc
  loop
    v_top := nullif(substring(r.reps from '(\d+)\D*$'), '')::integer;
    if v_top is null or v_top < 1 or v_top > 200 then
      continue;
    end if;
    select max(decided_at)::date into v_since
    from public.progression_suggestions
    where client_id = p_client_id and exercise_id = r.exercise_id and status <> 'pending';
    select target_weight_kg into v_target_weight
    from public.client_exercise_targets where client_id = p_client_id and exercise_id = r.exercise_id;

    select count(*)::integer, min(x.set_count), min(x.min_reps), min(x.work_weight), array_agg(x.workout_date order by x.workout_date desc)
    into v_sessions, v_min_sets, v_min_reps, v_min_weight, v_dates
    from (
      select z.workout_date, count(*)::integer as set_count, min(z.actual_reps) as min_reps, max(z.w) as work_weight
      from (
        select s.id, s.workout_date, s.created_at, l.actual_reps, coalesce(l.actual_weight_kg, 0) as w,
               max(coalesce(l.actual_weight_kg, 0)) over (partition by s.id) as top_w
        from public.client_workout_set_logs l
        join public.client_workout_sessions s on s.id = l.session_id
        where s.client_id = p_client_id and l.exercise_id = r.exercise_id
          and s.workout_date >= current_date - 60
          and (v_since is null or s.workout_date > v_since)
      ) z
      where z.w = z.top_w
      group by z.id, z.workout_date, z.created_at
      order by z.workout_date desc, z.created_at desc
      limit 2
    ) x;

    if v_sessions < 2 or v_min_sets < r.sets or v_min_reps < v_top then
      continue;
    end if;
    if v_target_weight is not null and v_min_weight < v_target_weight then
      continue;
    end if;

    if v_min_weight > 0 then
      v_inc := greatest(2.5, round(v_min_weight * 0.05 / 2.5) * 2.5);
      insert into public.progression_suggestions (coach_id, client_id, exercise_id, program_id, kind, current_weight_kg, current_reps, suggested_weight_kg, reason)
      values (
        p_coach_id, p_client_id, r.exercise_id, r.program_id, 'weight', v_min_weight, v_top, least(v_min_weight + v_inc, 1000),
        jsonb_build_object('rule', 'top_reps_two_sessions', 'target_reps', r.reps, 'top_reps', v_top, 'sets', r.sets, 'sessions', to_jsonb(v_dates), 'increase_kg', v_inc)
      )
      on conflict do nothing;
    else
      insert into public.progression_suggestions (coach_id, client_id, exercise_id, program_id, kind, current_reps, suggested_reps, reason)
      values (
        p_coach_id, p_client_id, r.exercise_id, r.program_id, 'reps', v_top, least(v_top + 2, 200),
        jsonb_build_object('rule', 'top_reps_two_sessions', 'target_reps', r.reps, 'top_reps', v_top, 'sets', r.sets, 'sessions', to_jsonb(v_dates), 'increase_reps', 2)
      )
      on conflict do nothing;
    end if;
    get diagnostics v_inserted = row_count;
    v_new := v_new + v_inserted;
  end loop;
  return v_new;
end;
$$;

-- Looks at one client (p_client_id) or at every client the caller looks after. Returns the number of new suggestions.
create or replace function public.refresh_progression_suggestions(p_client_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid;
  v_coach uuid;
  v_total integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_client_id is not null and public.task_coach_for(p_client_id) is null then
    raise exception 'You can only look at your own clients' using errcode = '42501';
  end if;
  for v_client in
    select cc.client_id
    from public.coach_clients cc
    where cc.status = 'active' and (p_client_id is null or cc.client_id = p_client_id) and public.task_coach_for(cc.client_id) is not null
    group by cc.client_id
  loop
    v_coach := public.task_coach_for(v_client);
    v_total := v_total + public.progression_for_client(v_client, v_coach);
  end loop;
  return v_total;
end;
$$;

-- The suggestions the caller may decide on, with names for the screen.
create or replace function public.list_progression_suggestions(p_client_id uuid default null, p_status text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or p_status not in ('pending', 'applied', 'dismissed') then
    raise exception 'Choose pending, applied or dismissed' using errcode = '22023';
  end if;
  if p_client_id is not null and public.task_coach_for(p_client_id) is null then
    raise exception 'You can only look at your own clients' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
    from (
      select s.id, s.client_id, s.exercise_id, s.kind, s.current_weight_kg, s.current_reps, s.suggested_weight_kg, s.suggested_reps,
             s.reason, s.status, s.created_at, s.decided_at,
             e.name as exercise_name, e.name_i18n as exercise_name_i18n,
             coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client') as client_name
      from public.progression_suggestions s
      join public.exercises e on e.id = s.exercise_id
      left join lateral (
        select x.client_name, x.client_email from public.coach_clients x
        where x.client_id = s.client_id order by (x.coach_id = auth.uid()) desc, x.created_at limit 1
      ) cc on true
      where s.status = p_status and public.task_coach_for(s.client_id) is not null
        and (p_client_id is null or s.client_id = p_client_id)
      order by s.created_at desc
      limit 100
    ) x
  ), '[]'::jsonb);
end;
$$;

-- Applies (p_apply true) or dismisses one suggestion. Applying sets the client's target for the exercise.
create or replace function public.decide_progression_suggestion(p_suggestion_id uuid, p_apply boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.progression_suggestions%rowtype;
  v_coach uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  select * into v_row from public.progression_suggestions where id = p_suggestion_id for update;
  v_coach := case when found then public.task_coach_for(v_row.client_id) end;
  if v_coach is null then
    raise exception 'Suggestion was not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This suggestion was already decided' using errcode = '22023';
  end if;

  if coalesce(p_apply, false) then
    insert into public.client_exercise_targets (client_id, exercise_id, coach_id, target_weight_kg, target_reps, source_suggestion_id)
    values (
      v_row.client_id, v_row.exercise_id, v_coach,
      case when v_row.kind = 'weight' then v_row.suggested_weight_kg end,
      case when v_row.kind = 'reps' then v_row.suggested_reps end,
      v_row.id
    )
    on conflict (client_id, exercise_id) do update
    set target_weight_kg = excluded.target_weight_kg,
        target_reps = excluded.target_reps,
        coach_id = excluded.coach_id,
        source_suggestion_id = excluded.source_suggestion_id,
        updated_at = now();
  end if;

  update public.progression_suggestions
  set status = case when coalesce(p_apply, false) then 'applied' else 'dismissed' end, decided_at = now(), decided_by = auth.uid()
  where id = v_row.id
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.progression_for_client(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refresh_progression_suggestions(uuid) from public, anon;
revoke all on function public.list_progression_suggestions(uuid, text) from public, anon;
revoke all on function public.decide_progression_suggestion(uuid, boolean) from public, anon;
grant execute on function public.refresh_progression_suggestions(uuid) to authenticated;
grant execute on function public.list_progression_suggestions(uuid, text) to authenticated;
grant execute on function public.decide_progression_suggestion(uuid, boolean) to authenticated;
