-- Compatibility fix: clients send their local calendar date, which can be one day ahead of UTC.
alter table public.client_workout_sessions drop constraint if exists client_workout_sessions_workout_date_check;
alter table public.client_workout_sessions
  add constraint client_workout_sessions_workout_date_check check (workout_date <= current_date + 1);
alter table public.client_body_metrics drop constraint if exists client_body_metrics_measured_on_check;
alter table public.client_body_metrics
  add constraint client_body_metrics_measured_on_check check (measured_on <= current_date + 1);
alter table public.client_habit_logs drop constraint if exists client_habit_logs_habit_date_check;
alter table public.client_habit_logs
  add constraint client_habit_logs_habit_date_check check (habit_date <= current_date + 1);

do $$
declare
  v_definition text;
begin
  v_definition := pg_get_functiondef('public.save_client_workout(date, text, jsonb)'::regprocedure);
  v_definition := replace(
    v_definition,
    'p_workout_date > current_date then',
    'p_workout_date > current_date + 1 then'
  );
  execute v_definition;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

-- Program templates
alter table public.training_programs
  add column if not exists is_template boolean not null default false;

create index if not exists training_programs_coach_template_idx
  on public.training_programs (coach_id, is_template, updated_at desc);

create or replace function public.set_training_program_template(
  p_program_id uuid,
  p_is_template boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  v_access := public.get_my_access_status();
  if v_access ->> 'role' <> 'coach'
    or v_access ->> 'access_state' not in ('trialing', 'active') then
    raise exception 'An active coach account is required to manage templates';
  end if;
  if p_is_template is null then
    raise exception 'Template state is required';
  end if;

  update public.training_programs
  set is_template = p_is_template,
      updated_at = statement_timestamp()
  where id = p_program_id
    and coach_id = auth.uid();

  if not found then
    raise exception 'Program was not found or does not belong to this coach';
  end if;
end;
$$;

create or replace function public.duplicate_training_program(
  p_program_id uuid,
  p_title text default null,
  p_as_template boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
  v_source public.training_programs%rowtype;
  v_day public.training_program_days%rowtype;
  v_new_program_id uuid;
  v_new_day_id uuid;
  v_title text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  v_access := public.get_my_access_status();
  if v_access ->> 'role' <> 'coach'
    or v_access ->> 'access_state' not in ('trialing', 'active') then
    raise exception 'An active coach account is required to duplicate programs';
  end if;

  select * into v_source
  from public.training_programs
  where id = p_program_id
    and coach_id = auth.uid();

  if not found then
    raise exception 'Program was not found or does not belong to this coach';
  end if;

  v_title := coalesce(nullif(btrim(p_title), ''), left(v_source.title, 150) || ' (copy)');
  if length(v_title) > 160 then
    raise exception 'Program title cannot exceed 160 characters';
  end if;

  insert into public.training_programs (coach_id, title, description, is_template)
  values (auth.uid(), v_title, v_source.description, coalesce(p_as_template, false))
  returning id into v_new_program_id;

  for v_day in
    select *
    from public.training_program_days
    where program_id = p_program_id
    order by order_index
  loop
    insert into public.training_program_days (program_id, name, order_index)
    values (v_new_program_id, v_day.name, v_day.order_index)
    returning id into v_new_day_id;

    insert into public.training_program_exercises (
      day_id, exercise_id, order_index, sets, reps, rest_seconds, notes
    )
    select v_new_day_id, e.exercise_id, e.order_index, e.sets, e.reps, e.rest_seconds, e.notes
    from public.training_program_exercises e
    where e.day_id = v_day.id;
  end loop;

  return v_new_program_id;
end;
$$;

revoke all on function public.set_training_program_template(uuid, boolean) from public;
revoke all on function public.duplicate_training_program(uuid, text, boolean) from public;
grant execute on function public.set_training_program_template(uuid, boolean) to authenticated;
grant execute on function public.duplicate_training_program(uuid, text, boolean) to authenticated;

-- Client onboarding / intake form
create table if not exists public.client_intake_forms (
  client_id uuid primary key references public.profiles (id) on delete cascade,
  primary_goal text not null check (primary_goal in ('fat_loss', 'muscle_gain', 'strength', 'endurance', 'general_fitness')),
  experience_level text not null check (experience_level in ('beginner', 'intermediate', 'advanced')),
  training_days_per_week integer not null check (training_days_per_week between 1 and 7),
  equipment_access text not null check (equipment_access in ('full_gym', 'home_gym', 'bodyweight_only')),
  height_cm numeric(5, 1) check (height_cm between 50 and 275),
  injuries text not null default '' check (length(injuries) <= 1000),
  medical_conditions text not null default '' check (length(medical_conditions) <= 1000),
  dietary_preferences text not null default '' check (length(dietary_preferences) <= 500),
  additional_notes text not null default '' check (length(additional_notes) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists client_intake_forms_set_updated_at on public.client_intake_forms;
create trigger client_intake_forms_set_updated_at
  before update on public.client_intake_forms
  for each row execute function public.set_updated_at();

-- Client food log
create table if not exists public.client_food_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  logged_on date not null default current_date check (logged_on <= current_date + 1),
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  food_name text not null check (length(btrim(food_name)) between 1 and 160),
  ingredients text not null default '' check (length(ingredients) <= 1000),
  calories numeric(7, 1) not null check (calories between 0 and 10000),
  protein_g numeric(6, 1) check (protein_g between 0 and 1000),
  carbs_g numeric(6, 1) check (carbs_g between 0 and 1000),
  fat_g numeric(6, 1) check (fat_g between 0 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_food_logs_client_date_idx
  on public.client_food_logs (client_id, logged_on desc, created_at);

drop trigger if exists client_food_logs_set_updated_at on public.client_food_logs;
create trigger client_food_logs_set_updated_at
  before update on public.client_food_logs
  for each row execute function public.set_updated_at();

alter table public.client_intake_forms enable row level security;
alter table public.client_food_logs enable row level security;

drop policy if exists "Clients can manage their own intake form" on public.client_intake_forms;
create policy "Clients can manage their own intake form"
  on public.client_intake_forms for all
  to authenticated
  using (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  )
  with check (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  );

drop policy if exists "Clients can manage their own food logs" on public.client_food_logs;
create policy "Clients can manage their own food logs"
  on public.client_food_logs for all
  to authenticated
  using (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  )
  with check (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  );

revoke all on public.client_intake_forms, public.client_food_logs from anon, authenticated;
grant select, insert, update on public.client_intake_forms to authenticated;
grant select, insert, update, delete on public.client_food_logs to authenticated;

-- One-rep-max history: best Epley estimate per exercise and day, from the caller's own logged sets.
-- Runs with the caller's permissions, so the client RLS policies apply.
create or replace function public.get_my_one_rep_max_history()
returns table (
  exercise_id uuid,
  exercise_name text,
  workout_date date,
  estimated_one_rep_max numeric,
  top_weight_kg numeric,
  top_reps integer
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select history.exercise_id, history.exercise_name, history.workout_date,
         history.estimated_one_rep_max, history.top_weight_kg, history.top_reps
  from (
    select distinct on (l.exercise_id, s.workout_date)
      l.exercise_id as exercise_id,
      e.name as exercise_name,
      s.workout_date as workout_date,
      round(
        case when l.actual_reps = 1 then l.actual_weight_kg
             else l.actual_weight_kg * (1 + l.actual_reps / 30.0) end,
        1
      ) as estimated_one_rep_max,
      l.actual_weight_kg as top_weight_kg,
      l.actual_reps as top_reps
    from public.client_workout_set_logs l
    join public.client_workout_sessions s on s.id = l.session_id
    join public.exercises e on e.id = l.exercise_id
    where s.client_id = auth.uid()
      and l.actual_weight_kg > 0
      and l.actual_reps between 1 and 12
    order by l.exercise_id, s.workout_date,
      case when l.actual_reps = 1 then l.actual_weight_kg
           else l.actual_weight_kg * (1 + l.actual_reps / 30.0) end desc
  ) history
  order by history.workout_date desc, history.exercise_name
  limit 2000;
$$;

revoke all on function public.get_my_one_rep_max_history() from public;
grant execute on function public.get_my_one_rep_max_history() to authenticated;
