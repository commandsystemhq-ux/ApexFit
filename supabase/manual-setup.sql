-- ApexFit Supabase setup. Run this file once in the Supabase SQL Editor.
-- Migration files are concatenated in filename order. It is safe to re-run.

-- ===== 20261115000100_core_accounts.sql =====

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('coach', 'client')),
  locale text not null default 'en' check (locale in ('en', 'ar', 'de', 'fr', 'es')),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint coach_trial_window check (
    (role = 'coach' and trial_started_at is not null and trial_ends_at = trial_started_at + interval '72 hours')
    or (role = 'client' and trial_started_at is null and trial_ends_at is null)
  )
);

create table if not exists public.coach_subscriptions (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  status text not null check (status in ('active', 'past_due', 'canceled')),
  provider text not null,
  provider_customer_id text,
  provider_subscription_id text unique,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.coach_subscriptions enable row level security;

drop policy if exists "Users can read their profile" on public.profiles;
create policy "Users can read their profile"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "Coaches can read their subscription" on public.coach_subscriptions;
create policy "Coaches can read their subscription"
  on public.coach_subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.profiles from anon, authenticated;
revoke all on public.coach_subscriptions from anon, authenticated;
grant select on public.profiles, public.coach_subscriptions to authenticated;

create or replace function public.get_my_access_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_subscription_status text;
  v_access_state text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_profile
  from public.profiles
  where id = auth.uid();

  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  select status into v_subscription_status
  from public.coach_subscriptions
  where user_id = v_profile.id;

  if v_profile.role = 'client' then
    v_access_state := 'client';
  elsif v_subscription_status = 'active' then
    v_access_state := 'active';
  elsif v_profile.trial_ends_at > statement_timestamp() then
    v_access_state := 'trialing';
  else
    v_access_state := 'expired';
  end if;

  return jsonb_build_object(
    'id', v_profile.id,
    'role', v_profile.role,
    'locale', v_profile.locale,
    'trial_started_at', v_profile.trial_started_at,
    'trial_ends_at', v_profile.trial_ends_at,
    'subscription_status', coalesce(
      v_subscription_status,
      case when v_profile.role = 'coach' and v_profile.trial_ends_at > statement_timestamp() then 'trialing' else 'none' end
    ),
    'access_state', v_access_state
  );
end;
$$;

create or replace function public.provision_my_profile(p_role text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    if p_role is null or p_role not in ('coach', 'client') then
      raise exception 'Choose a coach or client account before signing in';
    end if;

    insert into public.profiles (id, role, trial_started_at, trial_ends_at)
    values (
      auth.uid(),
      p_role,
      case when p_role = 'coach' then statement_timestamp() else null end,
      case when p_role = 'coach' then statement_timestamp() + interval '72 hours' else null end
    )
    on conflict (id) do nothing;
  end if;

  return public.get_my_access_status();
end;
$$;

create or replace function public.update_my_locale(p_locale text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  if p_locale is null or p_locale not in ('en', 'ar', 'de', 'fr', 'es') then
    raise exception 'Unsupported locale';
  end if;

  update public.profiles
  set locale = p_locale, updated_at = statement_timestamp()
  where id = auth.uid();

  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;
end;
$$;

revoke all on function public.get_my_access_status() from public;
revoke all on function public.provision_my_profile(text) from public;
revoke all on function public.update_my_locale(text) from public;
grant execute on function public.get_my_access_status() to authenticated;
grant execute on function public.provision_my_profile(text) to authenticated;
grant execute on function public.update_my_locale(text) to authenticated;

-- ===== 20261115000200_exercises_and_workout_programs.sql =====

create table if not exists public.exercises (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null check (length(btrim(name)) between 1 and 160),
  category text not null check (category in ('strength', 'cardio', 'mobility', 'plyometrics', 'warmup')),
  primary_muscles text[] not null default '{}',
  equipment text[] not null default '{}',
  difficulty text not null check (difficulty in ('beginner', 'intermediate', 'advanced')),
  instructions text[] not null default '{}',
  demo_video_url text,
  thumbnail_url text,
  is_published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists exercises_published_name_idx
  on public.exercises (name)
  where is_published;
create index if not exists exercises_published_category_difficulty_idx
  on public.exercises (category, difficulty)
  where is_published;
create index if not exists exercises_primary_muscles_idx
  on public.exercises using gin (primary_muscles);
create index if not exists exercises_equipment_idx
  on public.exercises using gin (equipment);

create table if not exists public.training_programs (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  description text not null default '' check (length(description) <= 2000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_programs_coach_updated_idx
  on public.training_programs (coach_id, updated_at desc);

create table if not exists public.training_program_days (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.training_programs (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 100),
  order_index integer not null check (order_index >= 0),
  unique (program_id, order_index)
);

create index if not exists training_program_days_program_idx
  on public.training_program_days (program_id, order_index);

create table if not exists public.training_program_exercises (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.training_program_days (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete restrict,
  order_index integer not null check (order_index >= 0),
  sets integer not null default 3 check (sets between 1 and 30),
  reps text not null default '8-12' check (length(btrim(reps)) between 1 and 50),
  rest_seconds integer not null default 90 check (rest_seconds between 0 and 3600),
  notes text not null default '' check (length(notes) <= 500),
  unique (day_id, order_index)
);

create index if not exists training_program_exercises_day_idx
  on public.training_program_exercises (day_id, order_index);
create index if not exists training_program_exercises_exercise_idx
  on public.training_program_exercises (exercise_id);

alter table public.exercises enable row level security;
alter table public.training_programs enable row level security;
alter table public.training_program_days enable row level security;
alter table public.training_program_exercises enable row level security;

drop policy if exists "Anyone can read published exercises" on public.exercises;
create policy "Anyone can read published exercises"
  on public.exercises for select
  to anon, authenticated
  using (is_published);

drop policy if exists "Coaches can manage their own programs" on public.training_programs;
create policy "Coaches can manage their own programs"
  on public.training_programs for all
  to authenticated
  using (
    coach_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'coach'
    and public.get_my_access_status() ->> 'access_state' in ('trialing', 'active')
  )
  with check (
    coach_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'coach'
    and public.get_my_access_status() ->> 'access_state' in ('trialing', 'active')
  );

drop policy if exists "Coaches can manage days in their programs" on public.training_program_days;
create policy "Coaches can manage days in their programs"
  on public.training_program_days for all
  to authenticated
  using (
    exists (
      select 1
      from public.training_programs p
      where p.id = program_id
        and p.coach_id = (select auth.uid())
        and public.get_my_access_status() ->> 'role' = 'coach'
        and public.get_my_access_status() ->> 'access_state' in ('trialing', 'active')
    )
  )
  with check (
    exists (
      select 1
      from public.training_programs p
      where p.id = program_id
        and p.coach_id = (select auth.uid())
        and public.get_my_access_status() ->> 'role' = 'coach'
        and public.get_my_access_status() ->> 'access_state' in ('trialing', 'active')
    )
  );

drop policy if exists "Coaches can manage exercises in their programs" on public.training_program_exercises;
create policy "Coaches can manage exercises in their programs"
  on public.training_program_exercises for all
  to authenticated
  using (
    exists (
      select 1
      from public.training_program_days d
      join public.training_programs p on p.id = d.program_id
      where d.id = day_id
        and p.coach_id = (select auth.uid())
        and public.get_my_access_status() ->> 'role' = 'coach'
        and public.get_my_access_status() ->> 'access_state' in ('trialing', 'active')
    )
  )
  with check (
    exists (
      select 1
      from public.training_program_days d
      join public.training_programs p on p.id = d.program_id
      where d.id = day_id
        and p.coach_id = (select auth.uid())
        and public.get_my_access_status() ->> 'role' = 'coach'
        and public.get_my_access_status() ->> 'access_state' in ('trialing', 'active')
        and exists (
          select 1
          from public.exercises e
          where e.id = exercise_id
            and e.is_published
        )
    )
  );

revoke all on public.exercises from anon, authenticated;
grant select on public.exercises to anon, authenticated;
grant all on public.exercises to service_role;
revoke all on public.training_programs, public.training_program_days, public.training_program_exercises from anon, authenticated;
grant select on public.training_programs, public.training_program_days, public.training_program_exercises to authenticated;

create or replace function public.save_training_program(
  p_title text,
  p_description text,
  p_days jsonb,
  p_program_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
  v_program_id uuid;
  v_day jsonb;
  v_exercise jsonb;
  v_day_id uuid;
  v_exercise_id uuid;
  v_day_index bigint;
  v_exercise_index bigint;
  v_day_count integer;
  v_exercise_count integer;
  v_sets integer;
  v_rest_seconds integer;
  v_reps text;
  v_notes text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  v_access := public.get_my_access_status();
  if v_access ->> 'role' <> 'coach'
    or v_access ->> 'access_state' not in ('trialing', 'active') then
    raise exception 'An active coach account is required to save programs';
  end if;

  if p_title is null or length(btrim(p_title)) not between 1 and 160 then
    raise exception 'Program title must be between 1 and 160 characters';
  end if;
  if length(coalesce(p_description, '')) > 2000 then
    raise exception 'Program description cannot exceed 2000 characters';
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' then
    raise exception 'Program days must be provided as an array';
  end if;
  v_day_count := jsonb_array_length(p_days);
  if v_day_count < 1 or v_day_count > 14 then
    raise exception 'A program must contain between 1 and 14 days';
  end if;

  if p_program_id is null then
    insert into public.training_programs (coach_id, title, description)
    values (auth.uid(), btrim(p_title), coalesce(p_description, ''))
    returning id into v_program_id;
  else
    update public.training_programs
    set title = btrim(p_title),
        description = coalesce(p_description, ''),
        updated_at = statement_timestamp()
    where id = p_program_id
      and coach_id = auth.uid()
    returning id into v_program_id;

    if v_program_id is null then
      raise exception 'Program was not found or does not belong to this coach';
    end if;

    delete from public.training_program_days
    where program_id = v_program_id;
  end if;

  for v_day, v_day_index in
    select value, ordinality
    from jsonb_array_elements(p_days) with ordinality
  loop
    if jsonb_typeof(v_day) <> 'object'
      or v_day ->> 'name' is null
      or length(btrim(v_day ->> 'name')) not between 1 and 100 then
      raise exception 'Each training day must have a name between 1 and 100 characters';
    end if;
    if v_day -> 'exercises' is null or jsonb_typeof(v_day -> 'exercises') <> 'array' then
      raise exception 'Each training day must contain an exercises array';
    end if;
    v_exercise_count := jsonb_array_length(v_day -> 'exercises');
    if v_exercise_count > 60 then
      raise exception 'A training day cannot contain more than 60 exercises';
    end if;

    insert into public.training_program_days (program_id, name, order_index)
    values (v_program_id, btrim(v_day ->> 'name'), v_day_index::integer - 1)
    returning id into v_day_id;

    for v_exercise, v_exercise_index in
      select value, ordinality
      from jsonb_array_elements(v_day -> 'exercises') with ordinality
    loop
      begin
        v_exercise_id := (v_exercise ->> 'exercise_id')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'Each program exercise must reference a valid exercise ID';
      end;

      if not exists (
        select 1
        from public.exercises e
        where e.id = v_exercise_id
          and e.is_published
      ) then
        raise exception 'A program references an unavailable exercise';
      end if;

      v_sets := coalesce(nullif(v_exercise ->> 'sets', ''), '3')::integer;
      v_reps := coalesce(nullif(btrim(v_exercise ->> 'reps'), ''), '8-12');
      v_rest_seconds := coalesce(nullif(v_exercise ->> 'rest_seconds', ''), '90')::integer;
      v_notes := coalesce(v_exercise ->> 'notes', '');

      insert into public.training_program_exercises (
        day_id, exercise_id, order_index, sets, reps, rest_seconds, notes
      )
      values (
        v_day_id,
        v_exercise_id,
        v_exercise_index::integer - 1,
        v_sets,
        v_reps,
        v_rest_seconds,
        v_notes
      );
    end loop;
  end loop;

  return v_program_id;
end;
$$;

revoke all on function public.save_training_program(text, text, jsonb, uuid) from public;
grant execute on function public.save_training_program(text, text, jsonb, uuid) to authenticated;

-- ===== 20261115000300_client_tracking.sql =====

create table if not exists public.client_workout_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  workout_date date not null default current_date check (workout_date <= current_date + 1),
  title text not null check (length(btrim(title)) between 1 and 160),
  created_at timestamptz not null default now()
);

create index if not exists client_workout_sessions_client_date_idx
  on public.client_workout_sessions (client_id, workout_date desc);

create table if not exists public.client_workout_set_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.client_workout_sessions (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete restrict,
  exercise_order integer not null check (exercise_order >= 0),
  set_number integer not null check (set_number between 1 and 30),
  actual_reps integer not null check (actual_reps between 1 and 200),
  actual_weight_kg numeric(7, 2) check (actual_weight_kg between 0 and 1000),
  notes text not null default '' check (length(notes) <= 500),
  unique (session_id, exercise_order, set_number)
);

create index if not exists client_workout_set_logs_session_idx
  on public.client_workout_set_logs (session_id, exercise_order, set_number);

create table if not exists public.client_body_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  measured_on date not null default current_date check (measured_on <= current_date + 1),
  weight_kg numeric(6, 2) check (weight_kg between 0.1 and 500),
  body_fat_percentage numeric(5, 2) check (body_fat_percentage between 0 and 100),
  notes text not null default '' check (length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, measured_on),
  check (num_nonnulls(weight_kg, body_fat_percentage) > 0)
);

create index if not exists client_body_metrics_client_date_idx
  on public.client_body_metrics (client_id, measured_on desc);

create table if not exists public.client_habit_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  habit_date date not null default current_date check (habit_date <= current_date + 1),
  sleep_hours numeric(4, 2) check (sleep_hours between 0 and 24),
  water_liters numeric(5, 2) check (water_liters between 0 and 50),
  steps integer check (steps between 0 and 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, habit_date),
  check (num_nonnulls(sleep_hours, water_liters, steps) > 0)
);

create index if not exists client_habit_logs_client_date_idx
  on public.client_habit_logs (client_id, habit_date desc);

alter table public.client_workout_sessions enable row level security;
alter table public.client_workout_set_logs enable row level security;
alter table public.client_body_metrics enable row level security;
alter table public.client_habit_logs enable row level security;

drop policy if exists "Clients can read their own workout sessions" on public.client_workout_sessions;
create policy "Clients can read their own workout sessions"
  on public.client_workout_sessions for select
  to authenticated
  using (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  );

drop policy if exists "Clients can read sets from their own workouts" on public.client_workout_set_logs;
create policy "Clients can read sets from their own workouts"
  on public.client_workout_set_logs for select
  to authenticated
  using (
    exists (
      select 1
      from public.client_workout_sessions s
      where s.id = session_id
        and s.client_id = (select auth.uid())
        and public.get_my_access_status() ->> 'role' = 'client'
    )
  );

drop policy if exists "Clients can manage their own body metrics" on public.client_body_metrics;
create policy "Clients can manage their own body metrics"
  on public.client_body_metrics for all
  to authenticated
  using (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  )
  with check (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  );

drop policy if exists "Clients can manage their own habit logs" on public.client_habit_logs;
create policy "Clients can manage their own habit logs"
  on public.client_habit_logs for all
  to authenticated
  using (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  )
  with check (
    client_id = (select auth.uid())
    and public.get_my_access_status() ->> 'role' = 'client'
  );

revoke all on public.client_workout_sessions, public.client_workout_set_logs,
  public.client_body_metrics, public.client_habit_logs from anon, authenticated;
grant select on public.client_workout_sessions, public.client_workout_set_logs to authenticated;
grant select, insert, update, delete on public.client_body_metrics, public.client_habit_logs to authenticated;

create or replace function public.save_client_workout(
  p_workout_date date,
  p_title text,
  p_exercises jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
  v_session_id uuid;
  v_exercise jsonb;
  v_set jsonb;
  v_exercise_id uuid;
  v_exercise_index bigint;
  v_set_index bigint;
  v_exercise_count integer;
  v_set_count integer;
  v_reps integer;
  v_weight numeric;
  v_notes text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  v_access := public.get_my_access_status();
  if v_access ->> 'role' <> 'client' then
    raise exception 'A client account is required to save workout logs';
  end if;
  if p_workout_date is null or p_workout_date > current_date + 1 then
    raise exception 'Workout date cannot be in the future';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 160 then
    raise exception 'Workout title must be between 1 and 160 characters';
  end if;
  if p_exercises is null or jsonb_typeof(p_exercises) <> 'array' then
    raise exception 'Workout exercises must be provided as an array';
  end if;
  v_exercise_count := jsonb_array_length(p_exercises);
  if v_exercise_count < 1 or v_exercise_count > 40 then
    raise exception 'A workout must contain between 1 and 40 exercises';
  end if;

  insert into public.client_workout_sessions (client_id, workout_date, title)
  values (auth.uid(), p_workout_date, btrim(p_title))
  returning id into v_session_id;

  for v_exercise, v_exercise_index in
    select value, ordinality
    from jsonb_array_elements(p_exercises) with ordinality
  loop
    if jsonb_typeof(v_exercise) <> 'object' then
      raise exception 'Each workout exercise must be an object';
    end if;

    begin
      v_exercise_id := (v_exercise ->> 'exercise_id')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'Each workout exercise must reference a valid exercise ID';
    end;

    if not exists (
      select 1
      from public.exercises e
      where e.id = v_exercise_id
        and e.is_published
    ) then
      raise exception 'A workout references an unavailable exercise';
    end if;
    if v_exercise -> 'sets' is null or jsonb_typeof(v_exercise -> 'sets') <> 'array' then
      raise exception 'Each workout exercise must include a sets array';
    end if;
    v_set_count := jsonb_array_length(v_exercise -> 'sets');
    if v_set_count < 1 or v_set_count > 30 then
      raise exception 'Each exercise must contain between 1 and 30 sets';
    end if;

    for v_set, v_set_index in
      select value, ordinality
      from jsonb_array_elements(v_exercise -> 'sets') with ordinality
    loop
      if jsonb_typeof(v_set) <> 'object' then
        raise exception 'Each workout set must be an object';
      end if;
      v_reps := nullif(v_set ->> 'reps', '')::integer;
      v_weight := nullif(v_set ->> 'weight_kg', '')::numeric;
      v_notes := coalesce(v_set ->> 'notes', '');

      if v_reps is null or v_reps not between 1 and 200 then
        raise exception 'Actual repetitions must be between 1 and 200';
      end if;
      if v_weight is not null and v_weight not between 0 and 1000 then
        raise exception 'Actual weight must be between 0 and 1000 kg';
      end if;
      if length(v_notes) > 500 then
        raise exception 'Set notes cannot exceed 500 characters';
      end if;

      insert into public.client_workout_set_logs (
        session_id, exercise_id, exercise_order, set_number, actual_reps, actual_weight_kg, notes
      )
      values (
        v_session_id, v_exercise_id, v_exercise_index::integer - 1, v_set_index::integer,
        v_reps, v_weight, v_notes
      );
    end loop;
  end loop;

  return v_session_id;
end;
$$;

revoke all on function public.save_client_workout(date, text, jsonb) from public;
grant execute on function public.save_client_workout(date, text, jsonb) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-progress-photos',
  'apexfit-progress-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Clients can read their own progress photos" on storage.objects;
create policy "Clients can read their own progress photos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-progress-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.get_my_access_status() ->> 'role' = 'client'
  );

drop policy if exists "Clients can upload their own progress photos" on storage.objects;
create policy "Clients can upload their own progress photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-progress-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.get_my_access_status() ->> 'role' = 'client'
  );

drop policy if exists "Clients can delete their own progress photos" on storage.objects;
create policy "Clients can delete their own progress photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-progress-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.get_my_access_status() ->> 'role' = 'client'
  );

-- ===== 20261115000400_priority2_templates_intake_strength_food.sql =====

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

-- ===== 20261115000500_coaching_business.sql =====

-- Coaching business layer: coach-client links, messaging, packages and invoices, sessions, push, Google Calendar.

-- Helpers used by row-level security policies
create or replace function public.is_active_coach()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
begin
  if auth.uid() is null
    or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    return false;
  end if;
  v_access := public.get_my_access_status();
  return v_access ->> 'access_state' in ('trialing', 'active');
end;
$$;

create or replace function public.is_client_account()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'client');
$$;

revoke all on function public.is_active_coach() from public, anon;
revoke all on function public.is_client_account() from public, anon;
grant execute on function public.is_active_coach() to authenticated;
grant execute on function public.is_client_account() to authenticated;

-- Coach <-> client relationship, created when a client redeems an invite code
create table if not exists public.coach_clients (
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  client_email text,
  client_name text,
  coach_email text,
  coach_name text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  primary key (coach_id, client_id),
  check (coach_id <> client_id)
);

create index if not exists coach_clients_client_idx on public.coach_clients (client_id);

create table if not exists public.client_invites (
  code text primary key check (code ~ '^[A-Z0-9]{12}$'),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  coach_email text,
  coach_name text,
  expires_at timestamptz not null,
  redeemed_by uuid references public.profiles (id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists client_invites_coach_idx on public.client_invites (coach_id, created_at desc);

alter table public.coach_clients enable row level security;
alter table public.client_invites enable row level security;

drop policy if exists "Coaches can read their clients" on public.coach_clients;
create policy "Coaches can read their clients"
  on public.coach_clients for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their coach links" on public.coach_clients;
create policy "Clients can read their coach links"
  on public.coach_clients for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their invites" on public.client_invites;
create policy "Coaches can read their invites"
  on public.client_invites for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.coach_clients, public.client_invites from anon, authenticated;
grant select on public.coach_clients, public.client_invites to authenticated;
grant all on public.coach_clients, public.client_invites to service_role;

create or replace function public.create_client_invite()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to invite clients';
  end if;
  if (
    select count(*) from public.client_invites
    where coach_id = auth.uid() and redeemed_at is null and expires_at > statement_timestamp()
  ) >= 25 then
    raise exception 'Too many open invites. Wait for them to be used or to expire';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.client_invites (code, coach_id, coach_email, coach_name, expires_at)
  values (
    v_code,
    auth.uid(),
    nullif(auth.jwt() ->> 'email', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    statement_timestamp() + interval '7 days'
  );
  return v_code;
end;
$$;

create or replace function public.redeem_client_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.client_invites%rowtype;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to join a coach';
  end if;

  select * into v_invite
  from public.client_invites
  where code = upper(btrim(coalesce(p_code, '')))
  for update;

  if not found or v_invite.redeemed_at is not null or v_invite.expires_at <= statement_timestamp() then
    raise exception 'This invite code is invalid or has expired';
  end if;

  insert into public.coach_clients (coach_id, client_id, client_email, client_name, coach_email, coach_name)
  values (
    v_invite.coach_id,
    auth.uid(),
    nullif(auth.jwt() ->> 'email', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    v_invite.coach_email,
    v_invite.coach_name
  )
  on conflict (coach_id, client_id) do update set status = 'active';

  update public.client_invites
  set redeemed_by = auth.uid(), redeemed_at = statement_timestamp()
  where code = v_invite.code;

  return jsonb_build_object('coach_id', v_invite.coach_id, 'coach_name', v_invite.coach_name, 'coach_email', v_invite.coach_email);
end;
$$;

create or replace function public.set_client_status(p_client_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'Unsupported client status';
  end if;
  update public.coach_clients set status = p_status
  where coach_id = auth.uid() and client_id = p_client_id;
  if not found then
    raise exception 'Client was not found';
  end if;
end;
$$;

revoke all on function public.create_client_invite() from public, anon;
revoke all on function public.redeem_client_invite(text) from public, anon;
revoke all on function public.set_client_status(uuid, text) from public, anon;
grant execute on function public.create_client_invite() to authenticated;
grant execute on function public.redeem_client_invite(text) to authenticated;
grant execute on function public.set_client_status(uuid, text) to authenticated;

-- Coaches may read the onboarding form of their active clients
drop policy if exists "Coaches can read intake forms of their clients" on public.client_intake_forms;
create policy "Coaches can read intake forms of their clients"
  on public.client_intake_forms for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_intake_forms.client_id
        and cc.status = 'active'
    )
  );

-- Coach messages (notes and videos). Writes happen only through send_coach_message.
create table if not exists public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  coach_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind in ('note', 'video')),
  body text not null default '' check (length(body) <= 2000),
  video_path text check (video_path is null or length(video_path) <= 300),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  check (
    (kind = 'note' and length(btrim(body)) > 0 and video_path is null)
    or (kind = 'video' and video_path is not null)
  )
);

create index if not exists coach_messages_client_idx on public.coach_messages (client_id, created_at desc);
create index if not exists coach_messages_coach_idx on public.coach_messages (coach_id, created_at desc);
create index if not exists coach_messages_batch_idx on public.coach_messages (batch_id);

alter table public.coach_messages enable row level security;

drop policy if exists "Coaches can read messages they sent" on public.coach_messages;
create policy "Coaches can read messages they sent"
  on public.coach_messages for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their messages" on public.coach_messages;
create policy "Clients can read their messages"
  on public.coach_messages for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Clients can mark their messages read" on public.coach_messages;
create policy "Clients can mark their messages read"
  on public.coach_messages for update
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account())
  with check (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.coach_messages from anon, authenticated;
grant select on public.coach_messages to authenticated;
grant update (read_at) on public.coach_messages to authenticated;
grant all on public.coach_messages to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-coach-videos',
  'apexfit-coach-videos',
  false,
  52428800,
  array['video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Coaches can upload their message videos" on storage.objects;
create policy "Coaches can upload their message videos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-coach-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Coaches can read their message videos" on storage.objects;
create policy "Coaches can read their message videos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-coach-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Coaches can delete their message videos" on storage.objects;
create policy "Coaches can delete their message videos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-coach-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Clients can read videos sent to them" on storage.objects;
create policy "Clients can read videos sent to them"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-coach-videos'
    and public.is_client_account()
    and exists (
      select 1 from public.coach_messages m
      where m.video_path = storage.objects.name
        and m.client_id = (select auth.uid())
    )
  );

create or replace function public.send_coach_message(
  p_client_ids uuid[],
  p_send_to_all boolean,
  p_body text,
  p_video_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipients uuid[];
  v_batch uuid := gen_random_uuid();
  v_body text := btrim(coalesce(p_body, ''));
  v_kind text;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to send messages';
  end if;
  if length(v_body) > 2000 then
    raise exception 'Messages cannot exceed 2000 characters';
  end if;

  if p_video_path is not null then
    v_kind := 'video';
    if length(p_video_path) > 300
      or p_video_path not like (auth.uid()::text || '/%')
      or not exists (
        select 1 from storage.objects o
        where o.bucket_id = 'apexfit-coach-videos' and o.name = p_video_path
      ) then
      raise exception 'The video upload could not be verified';
    end if;
  else
    v_kind := 'note';
    if v_body = '' then
      raise exception 'Write a message or attach a video';
    end if;
  end if;

  select coalesce(array_agg(cc.client_id), '{}') into v_recipients
  from public.coach_clients cc
  where cc.coach_id = auth.uid()
    and cc.status = 'active'
    and (coalesce(p_send_to_all, false) or cc.client_id = any(coalesce(p_client_ids, '{}')));

  if coalesce(array_length(v_recipients, 1), 0) = 0 then
    raise exception 'Choose at least one active client';
  end if;
  if array_length(v_recipients, 1) > 500 then
    raise exception 'A message can be sent to at most 500 clients at once';
  end if;

  insert into public.coach_messages (batch_id, coach_id, client_id, kind, body, video_path)
  select v_batch, auth.uid(), recipient, v_kind, v_body, p_video_path
  from unnest(v_recipients) as recipient;

  return jsonb_build_object('batch_id', v_batch, 'recipient_count', array_length(v_recipients, 1));
end;
$$;

revoke all on function public.send_coach_message(uuid[], boolean, text, text) from public, anon;
grant execute on function public.send_coach_message(uuid[], boolean, text, text) to authenticated;

-- Web push subscriptions
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 2000 and endpoint like 'https://%'),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Users can read their push subscriptions" on public.push_subscriptions;
create policy "Users can read their push subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
  set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end;
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- Packages, invoices, and session credits
create sequence if not exists public.invoice_number_seq;

create table if not exists public.coach_packages (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 500),
  session_count integer not null check (session_count between 1 and 500),
  price_cents integer not null check (price_cents between 50 and 100000000),
  currency text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists coach_packages_coach_idx on public.coach_packages (coach_id, created_at desc);

create table if not exists public.coach_payment_accounts (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_account_id text not null unique,
  charges_enabled boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  coach_id uuid not null,
  client_id uuid not null,
  package_id uuid references public.coach_packages (id) on delete set null,
  description text not null check (length(btrim(description)) between 1 and 300),
  sessions_included integer check (sessions_included between 1 and 500),
  amount_cents integer not null check (amount_cents between 50 and 100000000),
  currency text not null check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  status text not null default 'open' check (status in ('open', 'paid', 'void')),
  due_date date,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists invoices_coach_idx on public.invoices (coach_id, created_at desc);
create index if not exists invoices_client_idx on public.invoices (client_id, created_at desc);

create table if not exists public.client_package_credits (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references public.invoices (id) on delete cascade,
  coach_id uuid not null,
  client_id uuid not null,
  package_name text not null,
  sessions_total integer not null check (sessions_total >= 1),
  sessions_remaining integer not null check (sessions_remaining >= 0),
  created_at timestamptz not null default now(),
  check (sessions_remaining <= sessions_total),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists client_package_credits_pair_idx on public.client_package_credits (coach_id, client_id, created_at);

alter table public.coach_packages enable row level security;
alter table public.coach_payment_accounts enable row level security;
alter table public.invoices enable row level security;
alter table public.client_package_credits enable row level security;

drop policy if exists "Coaches can manage their packages" on public.coach_packages;
create policy "Coaches can manage their packages"
  on public.coach_packages for all
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach())
  with check (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read active packages of their coach" on public.coach_packages;
create policy "Clients can read active packages of their coach"
  on public.coach_packages for select
  to authenticated
  using (
    is_active
    and public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = coach_packages.coach_id
        and cc.client_id = (select auth.uid())
        and cc.status = 'active'
    )
  );

drop policy if exists "Coaches can read their payment account" on public.coach_payment_accounts;
create policy "Coaches can read their payment account"
  on public.coach_payment_accounts for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Coaches can read their invoices" on public.invoices;
create policy "Coaches can read their invoices"
  on public.invoices for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their invoices" on public.invoices;
create policy "Clients can read their invoices"
  on public.invoices for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read credits they sold" on public.client_package_credits;
create policy "Coaches can read credits they sold"
  on public.client_package_credits for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their credits" on public.client_package_credits;
create policy "Clients can read their credits"
  on public.client_package_credits for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.coach_packages, public.coach_payment_accounts, public.invoices, public.client_package_credits
  from anon, authenticated;
grant select, insert, update, delete on public.coach_packages to authenticated;
grant select on public.coach_payment_accounts, public.invoices, public.client_package_credits to authenticated;
grant all on public.coach_packages, public.coach_payment_accounts, public.invoices, public.client_package_credits
  to service_role;

create or replace function public.create_invoice(
  p_client_id uuid,
  p_description text,
  p_amount_cents integer,
  p_currency text default 'usd',
  p_due_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to create invoices';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client is not linked to this coach';
  end if;
  if p_description is null or length(btrim(p_description)) not between 1 and 300 then
    raise exception 'Invoice description must be between 1 and 300 characters';
  end if;
  if p_amount_cents is null or p_amount_cents not between 50 and 100000000 then
    raise exception 'Invoice amount is out of range';
  end if;
  if p_currency not in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed') then
    raise exception 'Unsupported currency';
  end if;
  if p_due_date is not null and p_due_date < current_date - 1 then
    raise exception 'Due date cannot be in the past';
  end if;

  insert into public.invoices (invoice_number, coach_id, client_id, description, amount_cents, currency, due_date)
  values (
    'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'),
    auth.uid(), p_client_id, btrim(p_description), p_amount_cents, p_currency, p_due_date
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Coaches can sell a package to a linked client, and clients can buy an active package of their coach.
create or replace function public.create_package_invoice(p_client_id uuid, p_package_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_package public.coach_packages%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_package from public.coach_packages where id = p_package_id and is_active;
  if not found then
    raise exception 'This package is not available';
  end if;

  if auth.uid() = v_package.coach_id then
    if not public.is_active_coach() then
      raise exception 'An active coach account is required to sell packages';
    end if;
  elsif auth.uid() = p_client_id then
    if not public.is_client_account() then
      raise exception 'A client account is required to buy packages';
    end if;
  else
    raise exception 'You cannot create an invoice for this package';
  end if;

  if not exists (
    select 1 from public.coach_clients
    where coach_id = v_package.coach_id and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client is not linked to this coach';
  end if;

  select id into v_id
  from public.invoices
  where coach_id = v_package.coach_id and client_id = p_client_id
    and package_id = p_package_id and status = 'open'
  order by created_at desc
  limit 1;
  if found then
    return v_id;
  end if;

  insert into public.invoices (
    invoice_number, coach_id, client_id, package_id, description, sessions_included, amount_cents, currency
  )
  values (
    'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'),
    v_package.coach_id, p_client_id, v_package.id, v_package.name,
    v_package.session_count, v_package.price_cents, v_package.currency
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.void_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  update public.invoices set status = 'void'
  where id = p_invoice_id and coach_id = auth.uid() and status = 'open';
  if not found then
    raise exception 'Only open invoices can be voided';
  end if;
end;
$$;

-- Called only by the Stripe webhook (service role). Idempotent.
create or replace function public.mark_invoice_paid(
  p_invoice_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status = 'paid' then
    return false;
  end if;
  if v_invoice.amount_cents <> p_amount_cents or lower(v_invoice.currency) <> lower(p_currency) then
    raise exception 'Payment amount does not match the invoice';
  end if;

  update public.invoices
  set status = 'paid',
      paid_at = statement_timestamp(),
      stripe_checkout_session_id = p_checkout_session_id,
      stripe_payment_intent_id = p_payment_intent_id
  where id = v_invoice.id;

  if v_invoice.sessions_included is not null then
    insert into public.client_package_credits (
      invoice_id, coach_id, client_id, package_name, sessions_total, sessions_remaining
    )
    values (
      v_invoice.id, v_invoice.coach_id, v_invoice.client_id, v_invoice.description,
      v_invoice.sessions_included, v_invoice.sessions_included
    );
  end if;
  return true;
end;
$$;

revoke all on function public.create_invoice(uuid, text, integer, text, date) from public, anon;
revoke all on function public.create_package_invoice(uuid, uuid) from public, anon;
revoke all on function public.void_invoice(uuid) from public, anon;
revoke all on function public.mark_invoice_paid(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.create_invoice(uuid, text, integer, text, date) to authenticated;
grant execute on function public.create_package_invoice(uuid, uuid) to authenticated;
grant execute on function public.void_invoice(uuid) to authenticated;
grant execute on function public.mark_invoice_paid(uuid, text, text, integer, text) to service_role;

-- Training sessions (calendar)
create table if not exists public.coach_sessions (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  client_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text not null default '' check (length(location) <= 200),
  notes text not null default '' check (length(notes) <= 1000),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'canceled')),
  credit_id uuid references public.client_package_credits (id) on delete set null,
  google_event_id text,
  google_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '12 hours'),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists coach_sessions_coach_idx on public.coach_sessions (coach_id, starts_at);
create index if not exists coach_sessions_client_idx on public.coach_sessions (client_id, starts_at);

drop trigger if exists coach_sessions_set_updated_at on public.coach_sessions;
create trigger coach_sessions_set_updated_at
  before update on public.coach_sessions
  for each row execute function public.set_updated_at();

create table if not exists public.google_calendar_connections (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  google_email text,
  refresh_token_encrypted text not null,
  calendar_id text not null default 'primary',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.coach_sessions enable row level security;
alter table public.google_calendar_connections enable row level security;

drop policy if exists "Coaches can read their sessions" on public.coach_sessions;
create policy "Coaches can read their sessions"
  on public.coach_sessions for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their sessions" on public.coach_sessions;
create policy "Clients can read their sessions"
  on public.coach_sessions for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.coach_sessions, public.google_calendar_connections from anon, authenticated;
grant select on public.coach_sessions to authenticated;
grant all on public.coach_sessions, public.google_calendar_connections to service_role;

create or replace function public.schedule_coach_session(
  p_client_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_location text default '',
  p_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client is not linked to this coach';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 160 then
    raise exception 'Session title must be between 1 and 160 characters';
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at
    or p_ends_at > p_starts_at + interval '12 hours' then
    raise exception 'Session end must be after its start and within 12 hours';
  end if;

  insert into public.coach_sessions (coach_id, client_id, title, starts_at, ends_at, location, notes)
  values (auth.uid(), p_client_id, btrim(p_title), p_starts_at, p_ends_at,
          coalesce(p_location, ''), coalesce(p_notes, ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.set_coach_session_status(p_session_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.coach_sessions%rowtype;
  v_credit_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  if p_status not in ('scheduled', 'completed', 'canceled') then
    raise exception 'Unsupported session status';
  end if;

  select * into v_session
  from public.coach_sessions
  where id = p_session_id and coach_id = auth.uid()
  for update;
  if not found then
    raise exception 'Session was not found';
  end if;
  if v_session.status = p_status then
    return jsonb_build_object('status', v_session.status, 'credit_used', v_session.credit_id is not null);
  end if;

  v_credit_id := v_session.credit_id;
  if v_session.status = 'completed' and v_credit_id is not null then
    update public.client_package_credits
    set sessions_remaining = least(sessions_total, sessions_remaining + 1)
    where id = v_credit_id;
    v_credit_id := null;
  end if;

  if p_status = 'completed' then
    select id into v_credit_id
    from public.client_package_credits
    where coach_id = v_session.coach_id and client_id = v_session.client_id and sessions_remaining > 0
    order by created_at
    limit 1
    for update;
    if found then
      update public.client_package_credits
      set sessions_remaining = sessions_remaining - 1
      where id = v_credit_id;
    else
      v_credit_id := null;
    end if;
  end if;

  update public.coach_sessions set status = p_status, credit_id = v_credit_id where id = v_session.id;
  return jsonb_build_object('status', p_status, 'credit_used', v_credit_id is not null);
end;
$$;

create or replace function public.get_my_google_calendar_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.google_calendar_connections%rowtype;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  select * into v_connection from public.google_calendar_connections where coach_id = auth.uid();
  return jsonb_build_object(
    'connected', found,
    'google_email', case when found then v_connection.google_email else null end
  );
end;
$$;

revoke all on function public.schedule_coach_session(uuid, text, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.set_coach_session_status(uuid, text) from public, anon;
revoke all on function public.get_my_google_calendar_status() from public, anon;
grant execute on function public.schedule_coach_session(uuid, text, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.set_coach_session_status(uuid, text) to authenticated;
grant execute on function public.get_my_google_calendar_status() to authenticated;

-- ===== 20261115000600_community_gamification.sql =====

-- Community feed and gamification. A community belongs to one coach: the coach and that coach's active clients.

create table if not exists public.community_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 2 and 40),
  leaderboard_opt_in boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  source text not null check (source in ('workout', 'food', 'habit', 'metric')),
  source_id uuid not null,
  event_date date not null,
  points integer not null check (points between 1 and 100),
  created_at timestamptz not null default now(),
  unique (source, source_id)
);

create index if not exists point_events_user_date_idx on public.point_events (user_id, event_date);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('update', 'achievement', 'announcement')),
  body text not null default '' check (length(body) <= 1000),
  achievement_code text,
  created_at timestamptz not null default now(),
  check (
    (kind = 'achievement' and achievement_code is not null)
    or (kind <> 'achievement' and achievement_code is null and length(btrim(body)) > 0)
  )
);

create index if not exists community_posts_feed_idx on public.community_posts (coach_id, created_at desc);
create index if not exists community_posts_author_idx on public.community_posts (author_id, created_at desc);

create table if not exists public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists community_comments_post_idx on public.community_comments (post_id, created_at);
create index if not exists community_comments_author_idx on public.community_comments (author_id, created_at desc);

create table if not exists public.community_reactions (
  post_id uuid not null references public.community_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  reaction text not null check (reaction in ('like', 'fire', 'clap')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.community_profiles enable row level security;
alter table public.point_events enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_reactions enable row level security;

drop policy if exists "Users can read their community profile" on public.community_profiles;
create policy "Users can read their community profile"
  on public.community_profiles for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Clients can read their point events" on public.point_events;
create policy "Clients can read their point events"
  on public.point_events for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_client_account());

-- Posts, comments, and reactions are only reachable through the security definer functions below.
revoke all on public.community_profiles, public.point_events, public.community_posts,
  public.community_comments, public.community_reactions from anon, authenticated;
grant select on public.community_profiles, public.point_events to authenticated;
grant all on public.community_profiles, public.point_events, public.community_posts,
  public.community_comments, public.community_reactions to service_role;

create or replace function public.can_access_community(p_coach_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or p_coach_id is null then
    return false;
  end if;
  if auth.uid() = p_coach_id then
    return public.is_active_coach();
  end if;
  return public.is_client_account()
    and exists (
      select 1 from public.coach_clients
      where coach_id = p_coach_id and client_id = auth.uid() and status = 'active'
    );
end;
$$;

-- Points: awarded by triggers, capped per day and source, and only for entries dated today or yesterday.
create or replace function public.award_points(
  p_user_id uuid,
  p_source text,
  p_source_id uuid,
  p_event_date date,
  p_points integer,
  p_daily_cap integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_awarded_today integer;
begin
  if p_event_date < current_date - 1 or p_event_date > current_date + 1 then
    return;
  end if;

  select coalesce(sum(points), 0) into v_awarded_today
  from public.point_events
  where user_id = p_user_id and source = p_source and event_date = p_event_date;

  if v_awarded_today + p_points > p_daily_cap then
    return;
  end if;

  insert into public.point_events (user_id, source, source_id, event_date, points)
  values (p_user_id, p_source, p_source_id, p_event_date, p_points)
  on conflict (source, source_id) do nothing;
end;
$$;

create or replace function public.award_workout_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'workout', new.id, new.workout_date, 50, 100);
  return new;
end;
$$;

create or replace function public.award_food_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'food', new.id, new.logged_on, 5, 20);
  return new;
end;
$$;

create or replace function public.award_habit_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'habit', new.id, new.habit_date, 10, 10);
  return new;
end;
$$;

create or replace function public.award_metric_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'metric', new.id, new.measured_on, 10, 10);
  return new;
end;
$$;

drop trigger if exists client_workout_sessions_award_points on public.client_workout_sessions;
create trigger client_workout_sessions_award_points
  after insert on public.client_workout_sessions
  for each row execute function public.award_workout_points();

drop trigger if exists client_food_logs_award_points on public.client_food_logs;
create trigger client_food_logs_award_points
  after insert on public.client_food_logs
  for each row execute function public.award_food_points();

drop trigger if exists client_habit_logs_award_points on public.client_habit_logs;
create trigger client_habit_logs_award_points
  after insert on public.client_habit_logs
  for each row execute function public.award_habit_points();

drop trigger if exists client_body_metrics_award_points on public.client_body_metrics;
create trigger client_body_metrics_award_points
  after insert on public.client_body_metrics
  for each row execute function public.award_metric_points();

-- Summary used for the progress screen and to verify shared achievements.
create or replace function public.gamification_summary(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer;
  v_week integer;
  v_current_streak integer := 0;
  v_longest_streak integer := 0;
  v_workouts integer;
  v_food_days integer;
  v_level integer;
  v_badges jsonb := '[]'::jsonb;
begin
  select coalesce(sum(points), 0)::integer,
         coalesce(sum(points) filter (where event_date >= current_date - 6), 0)::integer
  into v_total, v_week
  from public.point_events
  where user_id = p_user_id;

  select coalesce(max(island_length), 0),
         coalesce(max(island_length) filter (where last_day >= current_date - 1), 0)
  into v_longest_streak, v_current_streak
  from (
    select count(*)::integer as island_length, max(event_date) as last_day
    from (
      select event_date, event_date - (row_number() over (order by event_date))::integer as island
      from (select distinct event_date from public.point_events where user_id = p_user_id) days
    ) numbered
    group by island
  ) islands;

  select count(*)::integer into v_workouts from public.client_workout_sessions where client_id = p_user_id;
  select count(distinct logged_on)::integer into v_food_days from public.client_food_logs where client_id = p_user_id;

  if v_workouts >= 1 then v_badges := v_badges || '"first_workout"'::jsonb; end if;
  if v_workouts >= 10 then v_badges := v_badges || '"workouts_10"'::jsonb; end if;
  if v_workouts >= 50 then v_badges := v_badges || '"workouts_50"'::jsonb; end if;
  if v_longest_streak >= 7 then v_badges := v_badges || '"streak_7"'::jsonb; end if;
  if v_longest_streak >= 30 then v_badges := v_badges || '"streak_30"'::jsonb; end if;
  if v_food_days >= 7 then v_badges := v_badges || '"food_7"'::jsonb; end if;
  if v_total >= 500 then v_badges := v_badges || '"points_500"'::jsonb; end if;
  if v_total >= 2000 then v_badges := v_badges || '"points_2000"'::jsonb; end if;

  v_level := 1 + v_total / 250;
  return jsonb_build_object(
    'total_points', v_total,
    'week_points', v_week,
    'level', v_level,
    'points_into_level', v_total - (v_level - 1) * 250,
    'points_per_level', 250,
    'current_streak', v_current_streak,
    'longest_streak', v_longest_streak,
    'workouts', v_workouts,
    'food_days', v_food_days,
    'badges', v_badges
  );
end;
$$;

create or replace function public.get_my_gamification()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return public.gamification_summary(auth.uid());
end;
$$;

create or replace function public.join_community(p_display_name text, p_leaderboard_opt_in boolean default true)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if auth.uid() is null or not (public.is_client_account() or public.is_active_coach()) then
    raise exception 'An active ApexFit account is required to join the community';
  end if;
  if length(v_name) not between 2 and 40 then
    raise exception 'Display name must be between 2 and 40 characters';
  end if;

  insert into public.community_profiles (user_id, display_name, leaderboard_opt_in)
  values (auth.uid(), v_name, coalesce(p_leaderboard_opt_in, true))
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      leaderboard_opt_in = excluded.leaderboard_opt_in,
      updated_at = statement_timestamp();
end;
$$;

create or replace function public.list_community_feed(
  p_coach_id uuid,
  p_limit integer default 20,
  p_before timestamptz default null
)
returns table (
  post_id uuid,
  author_id uuid,
  author_name text,
  author_is_coach boolean,
  kind text,
  body text,
  achievement_code text,
  created_at timestamptz,
  comment_count integer,
  reactions jsonb,
  my_reaction text,
  can_delete boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.can_access_community(p_coach_id) then
    raise exception 'You do not have access to this community';
  end if;

  return query
  select
    p.id,
    p.author_id,
    coalesce(cp.display_name, 'Member'),
    p.author_id = p.coach_id,
    p.kind,
    p.body,
    p.achievement_code,
    p.created_at,
    (select count(*)::integer from public.community_comments c where c.post_id = p.id),
    coalesce(
      (select jsonb_object_agg(r.reaction, r.reaction_count)
       from (select cr.reaction, count(*) as reaction_count
             from public.community_reactions cr where cr.post_id = p.id group by cr.reaction) r),
      '{}'::jsonb
    ),
    (select cr.reaction from public.community_reactions cr where cr.post_id = p.id and cr.user_id = auth.uid()),
    p.author_id = auth.uid() or p.coach_id = auth.uid()
  from public.community_posts p
  left join public.community_profiles cp on cp.user_id = p.author_id
  where p.coach_id = p_coach_id
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

create or replace function public.create_community_post(
  p_coach_id uuid,
  p_kind text,
  p_body text,
  p_achievement_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not public.can_access_community(p_coach_id) then
    raise exception 'You do not have access to this community';
  end if;
  if not exists (select 1 from public.community_profiles where user_id = auth.uid()) then
    raise exception 'Choose a display name before posting';
  end if;
  if p_kind not in ('update', 'achievement', 'announcement') then
    raise exception 'Unsupported post type';
  end if;
  if length(v_body) > 1000 then
    raise exception 'Posts cannot exceed 1000 characters';
  end if;
  if p_kind = 'announcement' and auth.uid() <> p_coach_id then
    raise exception 'Only the coach can post announcements';
  end if;
  if p_kind = 'achievement' then
    if not exists (
      select 1 from jsonb_array_elements_text(public.gamification_summary(auth.uid()) -> 'badges') badge
      where badge = coalesce(p_achievement_code, '')
    ) then
      raise exception 'You have not earned this achievement yet';
    end if;
  elsif p_achievement_code is not null then
    raise exception 'Only achievement posts can reference an achievement';
  elsif v_body = '' then
    raise exception 'Write something to share';
  end if;
  if (select count(*) from public.community_posts
      where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour') >= 10 then
    raise exception 'You are posting too quickly. Try again later';
  end if;

  insert into public.community_posts (coach_id, author_id, kind, body, achievement_code)
  values (p_coach_id, auth.uid(), p_kind, v_body, p_achievement_code)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_community_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts%rowtype;
begin
  select * into v_post from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_post.coach_id)
    or (v_post.author_id <> auth.uid() and v_post.coach_id <> auth.uid()) then
    raise exception 'Post not found';
  end if;
  delete from public.community_posts where id = p_post_id;
end;
$$;

create or replace function public.list_post_comments(p_post_id uuid)
returns table (
  comment_id uuid,
  author_id uuid,
  author_name text,
  author_is_coach boolean,
  body text,
  created_at timestamptz,
  can_delete boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_coach_id uuid;
begin
  select coach_id into v_coach_id from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_coach_id) then
    raise exception 'Post not found';
  end if;

  return query
  select c.id, c.author_id, coalesce(cp.display_name, 'Member'), c.author_id = v_coach_id,
         c.body, c.created_at, c.author_id = auth.uid() or v_coach_id = auth.uid()
  from public.community_comments c
  left join public.community_profiles cp on cp.user_id = c.author_id
  where c.post_id = p_post_id
  order by c.created_at
  limit 200;
end;
$$;

create or replace function public.add_post_comment(p_post_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach_id uuid;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  select coach_id into v_coach_id from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_coach_id) then
    raise exception 'Post not found';
  end if;
  if not exists (select 1 from public.community_profiles where user_id = auth.uid()) then
    raise exception 'Choose a display name before commenting';
  end if;
  if length(v_body) not between 1 and 500 then
    raise exception 'Comments must be between 1 and 500 characters';
  end if;
  if (select count(*) from public.community_comments
      where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour') >= 30 then
    raise exception 'You are commenting too quickly. Try again later';
  end if;

  insert into public.community_comments (post_id, author_id, body)
  values (p_post_id, auth.uid(), v_body)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_post_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment public.community_comments%rowtype;
  v_coach_id uuid;
begin
  select * into v_comment from public.community_comments where id = p_comment_id;
  if not found then
    raise exception 'Comment not found';
  end if;
  select coach_id into v_coach_id from public.community_posts where id = v_comment.post_id;
  if not public.can_access_community(v_coach_id) or (v_comment.author_id <> auth.uid() and v_coach_id <> auth.uid()) then
    raise exception 'Comment not found';
  end if;
  delete from public.community_comments where id = p_comment_id;
end;
$$;

create or replace function public.set_post_reaction(p_post_id uuid, p_reaction text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach_id uuid;
begin
  select coach_id into v_coach_id from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_coach_id) then
    raise exception 'Post not found';
  end if;

  if p_reaction is null then
    delete from public.community_reactions where post_id = p_post_id and user_id = auth.uid();
  else
    if p_reaction not in ('like', 'fire', 'clap') then
      raise exception 'Unsupported reaction';
    end if;
    insert into public.community_reactions (post_id, user_id, reaction)
    values (p_post_id, auth.uid(), p_reaction)
    on conflict (post_id, user_id) do update set reaction = excluded.reaction;
  end if;
end;
$$;

create or replace function public.get_leaderboard(p_coach_id uuid, p_period text default 'week')
returns table (
  lb_rank bigint,
  lb_user_id uuid,
  lb_display_name text,
  lb_points bigint,
  lb_level integer,
  lb_is_me boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
begin
  if not public.can_access_community(p_coach_id) then
    raise exception 'You do not have access to this community';
  end if;
  if p_period not in ('week', 'month', 'all') then
    raise exception 'Unsupported leaderboard period';
  end if;
  v_start := case p_period
    when 'week' then current_date - 6
    when 'month' then current_date - 29
    else date '1970-01-01'
  end;

  return query
  with scores as (
    select cc.client_id as score_user_id,
           cp.display_name as score_name,
           coalesce(sum(pe.points) filter (where pe.event_date >= v_start), 0)::bigint as period_points,
           coalesce(sum(pe.points), 0)::bigint as total_points
    from public.coach_clients cc
    join public.community_profiles cp on cp.user_id = cc.client_id
    left join public.point_events pe on pe.user_id = cc.client_id
    where cc.coach_id = p_coach_id
      and cc.status = 'active'
      and (cp.leaderboard_opt_in or cc.client_id = auth.uid())
    group by cc.client_id, cp.display_name
  )
  select rank() over (order by s.period_points desc),
         s.score_user_id,
         s.score_name,
         s.period_points,
         (1 + s.total_points / 250)::integer,
         s.score_user_id = auth.uid()
  from scores s
  order by 1, 3
  limit 50;
end;
$$;

revoke all on function public.can_access_community(uuid) from public, anon;
revoke all on function public.award_points(uuid, text, uuid, date, integer, integer) from public, anon, authenticated;
revoke all on function public.award_workout_points() from public, anon, authenticated;
revoke all on function public.award_food_points() from public, anon, authenticated;
revoke all on function public.award_habit_points() from public, anon, authenticated;
revoke all on function public.award_metric_points() from public, anon, authenticated;
revoke all on function public.gamification_summary(uuid) from public, anon, authenticated;
revoke all on function public.get_my_gamification() from public, anon;
revoke all on function public.join_community(text, boolean) from public, anon;
revoke all on function public.list_community_feed(uuid, integer, timestamptz) from public, anon;
revoke all on function public.create_community_post(uuid, text, text, text) from public, anon;
revoke all on function public.delete_community_post(uuid) from public, anon;
revoke all on function public.list_post_comments(uuid) from public, anon;
revoke all on function public.add_post_comment(uuid, text) from public, anon;
revoke all on function public.delete_post_comment(uuid) from public, anon;
revoke all on function public.set_post_reaction(uuid, text) from public, anon;
revoke all on function public.get_leaderboard(uuid, text) from public, anon;
grant execute on function public.can_access_community(uuid) to authenticated;
grant execute on function public.get_my_gamification() to authenticated;
grant execute on function public.join_community(text, boolean) to authenticated;
grant execute on function public.list_community_feed(uuid, integer, timestamptz) to authenticated;
grant execute on function public.create_community_post(uuid, text, text, text) to authenticated;
grant execute on function public.delete_community_post(uuid) to authenticated;
grant execute on function public.list_post_comments(uuid) to authenticated;
grant execute on function public.add_post_comment(uuid, text) to authenticated;
grant execute on function public.delete_post_comment(uuid) to authenticated;
grant execute on function public.set_post_reaction(uuid, text) to authenticated;
grant execute on function public.get_leaderboard(uuid, text) to authenticated;
