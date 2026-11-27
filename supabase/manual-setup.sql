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

-- Coaching business layer: coach-client links, messaging, packages and invoices, sessions, push.

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

alter table public.coach_sessions enable row level security;

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

revoke all on public.coach_sessions from anon, authenticated;
grant select on public.coach_sessions to authenticated;
grant all on public.coach_sessions to service_role;

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

revoke all on function public.schedule_coach_session(uuid, text, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.set_coach_session_status(uuid, text) from public, anon;
grant execute on function public.schedule_coach_session(uuid, text, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.set_coach_session_status(uuid, text) to authenticated;

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

-- ===== 20261115000700_profile_settings_avatars.sql =====

-- Editable account profile (name, brand, avatar) and the public avatars bucket.

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists brand_name text,
  add column if not exists avatar_path text;

alter table public.profiles drop constraint if exists profiles_full_name_length;
alter table public.profiles add constraint profiles_full_name_length
  check (full_name is null or char_length(full_name) between 1 and 80);

alter table public.profiles drop constraint if exists profiles_brand_name_length;
alter table public.profiles add constraint profiles_brand_name_length
  check (brand_name is null or char_length(brand_name) between 1 and 80);

alter table public.profiles drop constraint if exists profiles_avatar_path_length;
alter table public.profiles add constraint profiles_avatar_path_length
  check (avatar_path is null or char_length(avatar_path) between 1 and 300);

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
    'full_name', v_profile.full_name,
    'brand_name', v_profile.brand_name,
    'avatar_path', v_profile.avatar_path,
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

-- The role may come from the browser (OAuth) or from the sign-up metadata (email confirmation in another browser).
create or replace function public.provision_my_profile(p_role text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(p_role, auth.jwt() -> 'user_metadata' ->> 'signup_role');
  v_name text := left(nullif(btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', '')), ''), 80);
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    if v_role is null or v_role not in ('coach', 'client') then
      raise exception 'Choose a coach or client account before signing in';
    end if;

    insert into public.profiles (id, role, full_name, trial_started_at, trial_ends_at)
    values (
      auth.uid(),
      v_role,
      v_name,
      case when v_role = 'coach' then statement_timestamp() else null end,
      case when v_role = 'coach' then statement_timestamp() + interval '72 hours' else null end
    )
    on conflict (id) do nothing;
  end if;

  return public.get_my_access_status();
end;
$$;

create or replace function public.update_my_profile(
  p_full_name text,
  p_brand_name text,
  p_avatar_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_name text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_brand text := nullif(btrim(coalesce(p_brand_name, '')), '');
  v_avatar text := nullif(btrim(coalesce(p_avatar_path, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select role into v_role from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'Name is too long';
  end if;
  if v_brand is not null and char_length(v_brand) > 80 then
    raise exception 'Brand name is too long';
  end if;
  if v_role <> 'coach' then
    v_brand := null;
  end if;
  if v_avatar is not null and v_avatar not like auth.uid()::text || '/%' then
    raise exception 'Invalid avatar path';
  end if;

  update public.profiles
  set full_name = v_name, brand_name = v_brand, avatar_path = v_avatar, updated_at = statement_timestamp()
  where id = auth.uid();

  -- Keep the names that clients see on coach links and invites in sync.
  if v_role = 'coach' and coalesce(v_brand, v_name) is not null then
    update public.coach_clients set coach_name = coalesce(v_brand, v_name) where coach_id = auth.uid();
    update public.client_invites set coach_name = coalesce(v_brand, v_name) where coach_id = auth.uid();
  end if;

  return public.get_my_access_status();
end;
$$;

revoke all on function public.get_my_access_status() from public;
revoke all on function public.provision_my_profile(text) from public;
revoke all on function public.update_my_profile(text, text, text) from public;
grant execute on function public.get_my_access_status() to authenticated;
grant execute on function public.provision_my_profile(text) to authenticated;
grant execute on function public.update_my_profile(text, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can read their own avatar files" on storage.objects;
create policy "Users can read their own avatar files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ===== 20261115000800_automated_workflows.sql =====

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

-- ===== 20261115000900_jack_assistant.sql =====

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

-- ===== 20261115001000_assessments_contracts_groups.sql =====

-- Health assessments (PAR-Q), e-signed contracts, and group coaching.
-- Every table is read through row-level security and written only through the security definer
-- functions below, which check the caller's role and ownership themselves.

-- ---------------------------------------------------------------------------
-- 1. Health & fitness assessments (PAR-Q)
-- ---------------------------------------------------------------------------

create table if not exists public.client_assessments (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  client_id uuid not null,
  parq_answers jsonb not null check (jsonb_typeof(parq_answers) = 'object'),
  fitness_goals text not null default '' check (length(fitness_goals) <= 1000),
  injuries_notes text not null default '' check (length(injuries_notes) <= 1000),
  medical_clearance_required boolean not null default false,
  submitted_at timestamptz not null default now(),
  -- A client keeps one current assessment per coach; filling it in again replaces it.
  unique (coach_id, client_id),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists client_assessments_client_idx on public.client_assessments (client_id);
create index if not exists client_assessments_clearance_idx
  on public.client_assessments (coach_id) where medical_clearance_required;

alter table public.client_assessments enable row level security;

drop policy if exists "Clients can read their assessments" on public.client_assessments;
create policy "Clients can read their assessments"
  on public.client_assessments for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their clients assessments" on public.client_assessments;
create policy "Coaches can read their clients assessments"
  on public.client_assessments for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.client_assessments from anon, authenticated;
grant select on public.client_assessments to authenticated;
grant all on public.client_assessments to service_role;

-- The client answers seven yes/no PAR-Q questions (q1..q7). Any "yes" requires medical clearance;
-- that flag is computed here, never taken from the browser.
create or replace function public.submit_my_assessment(
  p_coach_id uuid,
  p_parq jsonb,
  p_goals text,
  p_injuries text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := p_coach_id;
  v_links integer;
  v_goals text := btrim(coalesce(p_goals, ''));
  v_injuries text := btrim(coalesce(p_injuries, ''));
  v_answers jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_clearance boolean := false;
  v_submitted timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to submit an assessment';
  end if;

  if v_coach is null then
    select count(*) into v_links from public.coach_clients where client_id = auth.uid() and status = 'active';
    if v_links = 0 then
      raise exception 'Join a coach before submitting an assessment';
    elsif v_links > 1 then
      raise exception 'Choose which coach receives this assessment';
    end if;
    select coach_id into v_coach from public.coach_clients where client_id = auth.uid() and status = 'active';
  elsif not exists (
    select 1 from public.coach_clients where coach_id = v_coach and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'You are not linked to this coach';
  end if;

  if p_parq is null or jsonb_typeof(p_parq) <> 'object' then
    raise exception 'Answer all seven health questions';
  end if;
  for i in 1..7 loop
    v_key := 'q' || i;
    v_value := p_parq -> v_key;
    if v_value is null or jsonb_typeof(v_value) <> 'boolean' then
      raise exception 'Answer all seven health questions with yes or no';
    end if;
    v_answers := v_answers || jsonb_build_object(v_key, v_value);
    if v_value = 'true'::jsonb then
      v_clearance := true;
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(p_parq)) <> 7 then
    raise exception 'Unexpected health question answers';
  end if;

  if v_goals = '' then
    raise exception 'Describe your fitness goals';
  end if;
  if char_length(v_goals) > 1000 or char_length(v_injuries) > 1000 then
    raise exception 'Goals and injury notes can be at most 1000 characters';
  end if;

  insert into public.client_assessments (
    coach_id, client_id, parq_answers, fitness_goals, injuries_notes, medical_clearance_required, submitted_at
  )
  values (v_coach, auth.uid(), v_answers, v_goals, v_injuries, v_clearance, v_submitted)
  on conflict (coach_id, client_id) do update
  set parq_answers = excluded.parq_answers,
      fitness_goals = excluded.fitness_goals,
      injuries_notes = excluded.injuries_notes,
      medical_clearance_required = excluded.medical_clearance_required,
      submitted_at = excluded.submitted_at;

  return jsonb_build_object('coach_id', v_coach, 'medical_clearance_required', v_clearance, 'submitted_at', v_submitted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Contracts and e-signatures
-- ---------------------------------------------------------------------------

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  content_text text not null check (length(btrim(content_text)) between 1 and 20000),
  is_required_on_onboarding boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contracts_coach_idx on public.contracts (coach_id, created_at desc);

create table if not exists public.contract_signatures (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  signer_full_name text not null check (char_length(btrim(signer_full_name)) between 2 and 120),
  signature_data_url text not null check (
    char_length(signature_data_url) <= 300000
    and signature_data_url ~ '^data:image/png;base64,[A-Za-z0-9+/=]{100,}$'
  ),
  -- The signed wording is kept with the signature, so the record never changes afterwards.
  contract_title text not null,
  content_snapshot text not null,
  ip_or_user_agent text check (ip_or_user_agent is null or char_length(ip_or_user_agent) <= 400),
  signed_at timestamptz not null default now(),
  -- A client signs a contract only once.
  unique (contract_id, client_id)
);

create index if not exists contract_signatures_client_idx on public.contract_signatures (client_id, signed_at desc);

alter table public.contracts enable row level security;
alter table public.contract_signatures enable row level security;

-- Policy helpers are security definer so the contracts and signatures policies cannot recurse into each other.
create or replace function public.is_contract_owner(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.contracts where id = p_contract_id and coach_id = auth.uid());
$$;

create or replace function public.i_signed_contract(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.contract_signatures where contract_id = p_contract_id and client_id = auth.uid());
$$;

drop policy if exists "Coaches can read their contracts" on public.contracts;
create policy "Coaches can read their contracts"
  on public.contracts for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read contracts from their coach" on public.contracts;
create policy "Clients can read contracts from their coach"
  on public.contracts for select
  to authenticated
  using (
    public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = contracts.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
    and (not is_archived or public.i_signed_contract(id))
  );

drop policy if exists "Clients can read their signatures" on public.contract_signatures;
create policy "Clients can read their signatures"
  on public.contract_signatures for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read signatures on their contracts" on public.contract_signatures;
create policy "Coaches can read signatures on their contracts"
  on public.contract_signatures for select
  to authenticated
  using (public.is_active_coach() and public.is_contract_owner(contract_id));

revoke all on public.contracts, public.contract_signatures from anon, authenticated;
grant select on public.contracts, public.contract_signatures to authenticated;
grant all on public.contracts, public.contract_signatures to service_role;

-- Best-effort "ip | user agent" from the PostgREST request headers.
create or replace function public.request_client_hint()
returns text
language plpgsql
stable
as $$
declare
  v_headers json;
  v_ip text;
  v_agent text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  v_agent := nullif(btrim(coalesce(v_headers ->> 'user-agent', '')), '');
  return nullif(left(concat_ws(' | ', v_ip, v_agent), 400), '');
end;
$$;

create or replace function public.save_contract(
  p_contract_id uuid,
  p_title text,
  p_content text,
  p_required boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_content text := btrim(coalesce(p_content, ''));
  v_current public.contracts%rowtype;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage contracts';
  end if;
  if char_length(v_title) not between 1 and 160 then
    raise exception 'Give the contract a title of up to 160 characters';
  end if;
  if char_length(v_content) not between 1 and 20000 then
    raise exception 'The contract text must be between 1 and 20000 characters';
  end if;

  if p_contract_id is null then
    if (select count(*) from public.contracts where coach_id = auth.uid()) >= 50 then
      raise exception 'You can have at most 50 contracts. Archive or delete old ones first';
    end if;
    insert into public.contracts (coach_id, title, content_text, is_required_on_onboarding)
    values (auth.uid(), v_title, v_content, coalesce(p_required, false))
    returning id into v_id;
    return v_id;
  end if;

  select * into v_current from public.contracts where id = p_contract_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Contract was not found';
  end if;
  if (v_current.title <> v_title or v_current.content_text <> v_content)
    and exists (select 1 from public.contract_signatures where contract_id = p_contract_id) then
    raise exception 'This contract already has signatures. Archive it and create a new version instead';
  end if;

  update public.contracts
  set title = v_title, content_text = v_content, is_required_on_onboarding = coalesce(p_required, is_required_on_onboarding)
  where id = p_contract_id;
  return p_contract_id;
end;
$$;

create or replace function public.set_contract_archived(p_contract_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage contracts';
  end if;
  update public.contracts set is_archived = coalesce(p_archived, false)
  where id = p_contract_id and coach_id = auth.uid();
  if not found then
    raise exception 'Contract was not found';
  end if;
end;
$$;

create or replace function public.delete_contract(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage contracts';
  end if;
  if not exists (select 1 from public.contracts where id = p_contract_id and coach_id = auth.uid()) then
    raise exception 'Contract was not found';
  end if;
  if exists (select 1 from public.contract_signatures where contract_id = p_contract_id) then
    raise exception 'Signed contracts cannot be deleted. Archive it instead';
  end if;
  delete from public.contracts where id = p_contract_id and coach_id = auth.uid();
end;
$$;

create or replace function public.sign_contract(
  p_contract_id uuid,
  p_signer_name text,
  p_signature_data_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract public.contracts%rowtype;
  v_name text := btrim(coalesce(p_signer_name, ''));
  v_id uuid;
  v_signed timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to sign contracts';
  end if;

  select * into v_contract from public.contracts where id = p_contract_id;
  if not found or v_contract.is_archived or not exists (
    select 1 from public.coach_clients
    where coach_id = v_contract.coach_id and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'This contract is not available for signing';
  end if;

  if char_length(v_name) not between 2 and 120 then
    raise exception 'Type your full name to sign';
  end if;
  if p_signature_data_url is null
    or char_length(p_signature_data_url) > 300000
    or p_signature_data_url !~ '^data:image/png;base64,[A-Za-z0-9+/=]{100,}$' then
    raise exception 'Draw your signature before signing';
  end if;
  if exists (select 1 from public.contract_signatures where contract_id = p_contract_id and client_id = auth.uid()) then
    raise exception 'You have already signed this contract';
  end if;

  insert into public.contract_signatures (
    contract_id, client_id, signer_full_name, signature_data_url, contract_title, content_snapshot, ip_or_user_agent, signed_at
  )
  values (
    p_contract_id, auth.uid(), v_name, p_signature_data_url, v_contract.title, v_contract.content_text,
    public.request_client_hint(), v_signed
  )
  returning id into v_id;

  return jsonb_build_object('signature_id', v_id, 'signed_at', v_signed);
exception
  when unique_violation then
    raise exception 'You have already signed this contract';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Group coaching
-- ---------------------------------------------------------------------------

create table if not exists public.coaching_groups (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  program_template_id uuid references public.training_programs (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists coaching_groups_coach_idx on public.coaching_groups (coach_id, created_at desc);

create table if not exists public.coaching_group_members (
  group_id uuid not null references public.coaching_groups (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, client_id)
);

create index if not exists coaching_group_members_client_idx on public.coaching_group_members (client_id);

create table if not exists public.group_announcements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.coaching_groups (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists group_announcements_group_idx on public.group_announcements (group_id, created_at desc);

alter table public.coaching_groups enable row level security;
alter table public.coaching_group_members enable row level security;
alter table public.group_announcements enable row level security;

create or replace function public.is_group_owner(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.coaching_groups where id = p_group_id and coach_id = auth.uid());
$$;

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.coaching_group_members m
    join public.coaching_groups g on g.id = m.group_id
    join public.coach_clients cc on cc.coach_id = g.coach_id and cc.client_id = m.client_id and cc.status = 'active'
    where m.group_id = p_group_id and m.client_id = auth.uid()
  );
$$;

drop policy if exists "Coaches can read their groups" on public.coaching_groups;
create policy "Coaches can read their groups"
  on public.coaching_groups for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Members can read their groups" on public.coaching_groups;
create policy "Members can read their groups"
  on public.coaching_groups for select
  to authenticated
  using (public.is_client_account() and public.is_group_member(id));

drop policy if exists "Coaches can read their group members" on public.coaching_group_members;
create policy "Coaches can read their group members"
  on public.coaching_group_members for select
  to authenticated
  using (public.is_active_coach() and public.is_group_owner(group_id));

drop policy if exists "Clients can read their own memberships" on public.coaching_group_members;
create policy "Clients can read their own memberships"
  on public.coaching_group_members for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their group announcements" on public.group_announcements;
create policy "Coaches can read their group announcements"
  on public.group_announcements for select
  to authenticated
  using (public.is_active_coach() and public.is_group_owner(group_id));

drop policy if exists "Members can read their group announcements" on public.group_announcements;
create policy "Members can read their group announcements"
  on public.group_announcements for select
  to authenticated
  using (public.is_client_account() and public.is_group_member(group_id));

revoke all on public.coaching_groups, public.coaching_group_members, public.group_announcements from anon, authenticated;
grant select on public.coaching_groups, public.coaching_group_members, public.group_announcements to authenticated;
grant all on public.coaching_groups, public.coaching_group_members, public.group_announcements to service_role;

create or replace function public.save_group(p_group_id uuid, p_name text, p_description text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Give the group a name of up to 80 characters';
  end if;
  if char_length(v_description) > 500 then
    raise exception 'The description cannot exceed 500 characters';
  end if;

  if p_group_id is null then
    if (select count(*) from public.coaching_groups where coach_id = auth.uid()) >= 25 then
      raise exception 'You can have at most 25 groups';
    end if;
    insert into public.coaching_groups (coach_id, name, description)
    values (auth.uid(), v_name, v_description)
    returning id into v_id;
    return v_id;
  end if;

  update public.coaching_groups set name = v_name, description = v_description
  where id = p_group_id and coach_id = auth.uid()
  returning id into v_id;
  if v_id is null then
    raise exception 'Group was not found';
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  delete from public.coaching_groups where id = p_group_id and coach_id = auth.uid();
  if not found then
    raise exception 'Group was not found';
  end if;
end;
$$;

-- Adds active clients of this coach. When the group already has a program, new members receive it too.
create or replace function public.add_group_members(p_group_id uuid, p_client_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program uuid;
  v_ids uuid[];
  v_client uuid;
  v_added integer := 0;
  v_assigned integer := 0;
  v_inserted integer;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  select program_template_id into v_program from public.coaching_groups where id = p_group_id and coach_id = auth.uid();
  if not found then
    raise exception 'Group was not found';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_client_ids, '{}')) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'Choose at least one client';
  end if;
  if (
    select count(*) from public.coach_clients
    where coach_id = auth.uid() and status = 'active' and client_id = any (v_ids)
  ) <> array_length(v_ids, 1) then
    raise exception 'Only your active clients can be added to a group';
  end if;
  if (select count(*) from public.coaching_group_members where group_id = p_group_id) + array_length(v_ids, 1) > 100 then
    raise exception 'A group can have at most 100 members';
  end if;

  foreach v_client in array v_ids loop
    insert into public.coaching_group_members (group_id, client_id) values (p_group_id, v_client)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted > 0 then
      v_added := v_added + 1;
      if v_program is not null then
        perform public.assign_program_to_client(v_client, v_program);
        v_assigned := v_assigned + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'program_assigned', v_assigned);
end;
$$;

create or replace function public.remove_group_member(p_group_id uuid, p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() or not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  delete from public.coaching_group_members where group_id = p_group_id and client_id = p_client_id;
  if not found then
    raise exception 'That client is not in this group';
  end if;
end;
$$;

-- One click: the program becomes the group's program and is assigned to every active member
-- (which also starts any "program assigned" workflow for each of them).
create or replace function public.assign_program_to_group(p_group_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member uuid;
  v_assigned integer := 0;
  v_skipped integer := 0;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  if not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = auth.uid()) then
    raise exception 'Program was not found';
  end if;

  update public.coaching_groups set program_template_id = p_program_id where id = p_group_id;

  for v_member in
    select m.client_id
    from public.coaching_group_members m
    left join public.coach_clients cc on cc.coach_id = auth.uid() and cc.client_id = m.client_id and cc.status = 'active'
    where m.group_id = p_group_id and cc.client_id is not null
    order by m.joined_at
  loop
    perform public.assign_program_to_client(v_member, p_program_id);
    v_assigned := v_assigned + 1;
  end loop;

  select count(*) into v_skipped
  from public.coaching_group_members m
  where m.group_id = p_group_id
    and not exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = auth.uid() and cc.client_id = m.client_id and cc.status = 'active'
    );

  return jsonb_build_object('assigned', v_assigned, 'skipped_inactive', v_skipped);
end;
$$;

create or replace function public.clear_group_program(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() or not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  update public.coaching_groups set program_template_id = null where id = p_group_id;
end;
$$;

create or replace function public.post_group_announcement(p_group_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not public.is_active_coach() or not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'Write an update of up to 1000 characters';
  end if;
  if (
    select count(*) from public.group_announcements
    where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour'
  ) >= 20 then
    raise exception 'You are posting too quickly. Try again later';
  end if;

  insert into public.group_announcements (group_id, author_id, body)
  values (p_group_id, auth.uid(), v_body)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_group_announcement(p_announcement_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  delete from public.group_announcements a
  where a.id = p_announcement_id and public.is_group_owner(a.group_id);
  if not found then
    raise exception 'Announcement was not found';
  end if;
end;
$$;

-- Days and exercises of a program in a compact form (used for what a member sees).
create or replace function public.program_summary(p_program_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'title', p.title,
    'days', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', d.name,
          'exercises', coalesce((
            select jsonb_agg(jsonb_build_object('name', e.name, 'sets', pe.sets, 'reps', pe.reps) order by pe.order_index)
            from (
              select * from public.training_program_exercises x where x.day_id = d.id order by x.order_index limit 12
            ) pe
            join public.exercises e on e.id = pe.exercise_id
          ), '[]'::jsonb)
        )
        order by d.order_index
      )
      from (
        select * from public.training_program_days y where y.program_id = p.id order by y.order_index limit 7
      ) d
    ), '[]'::jsonb)
  )
  from public.training_programs p
  where p.id = p_program_id;
$$;

-- What a client sees: their groups, the shared program, and the coach's updates. Other members are never listed.
create or replace function public.get_my_groups()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'description', g.description,
        'joined_at', m.joined_at,
        'coach_name', coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), '')),
        'member_count', (select count(*) from public.coaching_group_members x where x.group_id = g.id),
        'program', case when g.program_template_id is null then null else public.program_summary(g.program_template_id) end,
        'announcements', coalesce((
          select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'created_at', a.created_at) order by a.created_at desc)
          from (
            select * from public.group_announcements y where y.group_id = g.id order by y.created_at desc limit 10
          ) a
        ), '[]'::jsonb)
      )
      order by m.joined_at desc
    )
    from public.coaching_group_members m
    join public.coaching_groups g on g.id = m.group_id
    join public.coach_clients cc on cc.coach_id = g.coach_id and cc.client_id = m.client_id and cc.status = 'active'
    left join public.profiles pr on pr.id = g.coach_id
    where m.client_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Onboarding checklist for clients (assessment + contracts)
-- ---------------------------------------------------------------------------

create or replace function public.get_my_onboarding_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_coach boolean;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  select exists (select 1 from public.coach_clients where client_id = auth.uid() and status = 'active') into v_has_coach;

  return jsonb_build_object(
    'has_coach', v_has_coach,
    'assessment_submitted', exists (
      select 1 from public.client_assessments a
      join public.coach_clients cc on cc.coach_id = a.coach_id and cc.client_id = a.client_id and cc.status = 'active'
      where a.client_id = auth.uid()
    ),
    'medical_clearance_required', exists (
      select 1 from public.client_assessments a
      join public.coach_clients cc on cc.coach_id = a.coach_id and cc.client_id = a.client_id and cc.status = 'active'
      where a.client_id = auth.uid() and a.medical_clearance_required
    ),
    'pending_contracts', (
      select count(*)::integer
      from public.contracts c
      join public.coach_clients cc on cc.coach_id = c.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
      where c.is_required_on_onboarding and not c.is_archived
        and not exists (select 1 from public.contract_signatures s where s.contract_id = c.id and s.client_id = auth.uid())
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.request_client_hint() from public, anon, authenticated;
revoke all on function public.program_summary(uuid) from public, anon, authenticated;
revoke all on function public.is_contract_owner(uuid) from public, anon;
revoke all on function public.i_signed_contract(uuid) from public, anon;
revoke all on function public.is_group_owner(uuid) from public, anon;
revoke all on function public.is_group_member(uuid) from public, anon;
grant execute on function public.is_contract_owner(uuid) to authenticated;
grant execute on function public.i_signed_contract(uuid) to authenticated;
grant execute on function public.is_group_owner(uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;

revoke all on function public.submit_my_assessment(uuid, jsonb, text, text) from public, anon;
revoke all on function public.save_contract(uuid, text, text, boolean) from public, anon;
revoke all on function public.set_contract_archived(uuid, boolean) from public, anon;
revoke all on function public.delete_contract(uuid) from public, anon;
revoke all on function public.sign_contract(uuid, text, text) from public, anon;
revoke all on function public.save_group(uuid, text, text) from public, anon;
revoke all on function public.delete_group(uuid) from public, anon;
revoke all on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon;
revoke all on function public.assign_program_to_group(uuid, uuid) from public, anon;
revoke all on function public.clear_group_program(uuid) from public, anon;
revoke all on function public.post_group_announcement(uuid, text) from public, anon;
revoke all on function public.delete_group_announcement(uuid) from public, anon;
revoke all on function public.get_my_groups() from public, anon;
revoke all on function public.get_my_onboarding_status() from public, anon;

grant execute on function public.submit_my_assessment(uuid, jsonb, text, text) to authenticated;
grant execute on function public.save_contract(uuid, text, text, boolean) to authenticated;
grant execute on function public.set_contract_archived(uuid, boolean) to authenticated;
grant execute on function public.delete_contract(uuid) to authenticated;
grant execute on function public.sign_contract(uuid, text, text) to authenticated;
grant execute on function public.save_group(uuid, text, text) to authenticated;
grant execute on function public.delete_group(uuid) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.assign_program_to_group(uuid, uuid) to authenticated;
grant execute on function public.clear_group_program(uuid) to authenticated;
grant execute on function public.post_group_announcement(uuid, text) to authenticated;
grant execute on function public.delete_group_announcement(uuid) to authenticated;
grant execute on function public.get_my_groups() to authenticated;
grant execute on function public.get_my_onboarding_status() to authenticated;

-- ===== 20261115001100_store_team_video.sql =====

-- Program store, trainer teams, and live video sessions.
-- Tables are read through row-level security and written only through security definer functions that
-- check the caller's role and ownership themselves.

-- ===========================================================================
-- 0. Shared program assignment (used by coaches, assistant trainers, groups and the store)
-- ===========================================================================

-- Assigns a program on behalf of a coach and starts that coach's "program assigned" workflows.
-- Internal only: callers must already have decided that the acting user may do this.
create or replace function public.assign_program_core(p_coach_id uuid, p_client_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment uuid;
  v_queued integer;
begin
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = p_coach_id) then
    raise exception 'Program was not found';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = p_coach_id and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;

  insert into public.program_assignments (coach_id, client_id, program_id)
  values (p_coach_id, p_client_id, p_program_id)
  returning id into v_assignment;

  v_queued := public.workflow_schedule(p_coach_id, p_client_id, 'plan_assigned', 'program:' || v_assignment);
  perform public.workflow_run_due(p_coach_id, p_client_id);
  return jsonb_build_object('assignment_id', v_assignment, 'steps_queued', v_queued);
end;
$$;

revoke all on function public.assign_program_core(uuid, uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 1. Trainer teams
-- ===========================================================================

create table if not exists public.coach_team_members (
  id uuid primary key default gen_random_uuid(),
  head_coach_id uuid not null references public.profiles (id) on delete cascade,
  trainer_user_id uuid references public.profiles (id) on delete cascade,
  invite_email text not null check (
    char_length(invite_email) between 3 and 254
    and invite_email = lower(invite_email)
    and invite_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  role_title text not null default '' check (char_length(role_title) <= 80),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  status text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  check (status = 'invited' or trainer_user_id is not null),
  check (trainer_user_id is null or trainer_user_id <> head_coach_id),
  unique (head_coach_id, invite_email),
  unique (id, head_coach_id)
);

-- A person works for one head coach at a time.
create unique index if not exists coach_team_members_one_active_team
  on public.coach_team_members (trainer_user_id) where status = 'active';
create index if not exists coach_team_members_trainer_idx on public.coach_team_members (trainer_user_id);
create index if not exists coach_team_members_email_idx on public.coach_team_members (invite_email) where status = 'invited';

create table if not exists public.client_trainer_assignments (
  id uuid primary key default gen_random_uuid(),
  head_coach_id uuid not null,
  client_id uuid not null,
  team_member_id uuid not null,
  assigned_at timestamptz not null default now(),
  -- One assistant per client, and the assistant must belong to the same head coach as the client.
  unique (head_coach_id, client_id),
  foreign key (head_coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  foreign key (team_member_id, head_coach_id) references public.coach_team_members (id, head_coach_id) on delete cascade
);

create index if not exists client_trainer_assignments_member_idx on public.client_trainer_assignments (team_member_id);

alter table public.coach_team_members enable row level security;
alter table public.client_trainer_assignments enable row level security;

-- Policy helpers (security definer, so policies on different tables cannot recurse into each other).
create or replace function public.my_team_head()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.head_coach_id
  from public.coach_team_members m
  where m.trainer_user_id = auth.uid() and m.status = 'active' and public.workflow_coach_is_active(m.head_coach_id)
  limit 1;
$$;

create or replace function public.team_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.coach_team_members m
    where m.trainer_user_id = auth.uid() and m.status = 'active'
      and m.permissions ->> p_permission = 'true'
      and public.workflow_coach_is_active(m.head_coach_id)
  );
$$;

create or replace function public.trainer_has_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.client_trainer_assignments a
    join public.coach_team_members m on m.id = a.team_member_id
    join public.coach_clients cc on cc.coach_id = a.head_coach_id and cc.client_id = a.client_id and cc.status = 'active'
    where a.client_id = p_client_id
      and m.trainer_user_id = auth.uid() and m.status = 'active'
      and public.workflow_coach_is_active(a.head_coach_id)
  );
$$;

create or replace function public.trainer_can_see_group(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.team_permission('manage_groups')
    and exists (select 1 from public.coaching_groups where id = p_group_id and coach_id = public.my_team_head());
$$;

create or replace function public.i_own_team_member(p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.coach_team_members where id = p_member_id and trainer_user_id = auth.uid());
$$;

drop policy if exists "Head coaches can read their team" on public.coach_team_members;
create policy "Head coaches can read their team"
  on public.coach_team_members for select
  to authenticated
  using (head_coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Trainers can read their own membership" on public.coach_team_members;
create policy "Trainers can read their own membership"
  on public.coach_team_members for select
  to authenticated
  using (trainer_user_id = (select auth.uid()));

drop policy if exists "Head coaches can read assignments" on public.client_trainer_assignments;
create policy "Head coaches can read assignments"
  on public.client_trainer_assignments for select
  to authenticated
  using (head_coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Trainers can read their assignments" on public.client_trainer_assignments;
create policy "Trainers can read their assignments"
  on public.client_trainer_assignments for select
  to authenticated
  using (public.i_own_team_member(team_member_id));

-- Assistant trainers get read access to exactly what their permissions cover, for their assigned clients only.
drop policy if exists "Trainers can read assigned clients" on public.coach_clients;
create policy "Trainers can read assigned clients"
  on public.coach_clients for select
  to authenticated
  using (coach_id = public.my_team_head() and public.trainer_has_client(client_id));

drop policy if exists "Trainers can read assigned client assessments" on public.client_assessments;
create policy "Trainers can read assigned client assessments"
  on public.client_assessments for select
  to authenticated
  using (
    coach_id = public.my_team_head()
    and public.team_permission('view_assessments')
    and public.trainer_has_client(client_id)
  );

drop policy if exists "Trainers can read the head coach programs" on public.training_programs;
create policy "Trainers can read the head coach programs"
  on public.training_programs for select
  to authenticated
  using (coach_id = public.my_team_head() and public.team_permission('manage_programs'));

drop policy if exists "Trainers can read assigned client messages" on public.coach_messages;
create policy "Trainers can read assigned client messages"
  on public.coach_messages for select
  to authenticated
  using (
    coach_id = public.my_team_head()
    and public.team_permission('messages')
    and public.trainer_has_client(client_id)
  );

drop policy if exists "Trainers can read the team groups" on public.coaching_groups;
create policy "Trainers can read the team groups"
  on public.coaching_groups for select
  to authenticated
  using (public.trainer_can_see_group(id));

drop policy if exists "Trainers can read the team group members" on public.coaching_group_members;
create policy "Trainers can read the team group members"
  on public.coaching_group_members for select
  to authenticated
  using (public.trainer_can_see_group(group_id));

drop policy if exists "Trainers can read the team group announcements" on public.group_announcements;
create policy "Trainers can read the team group announcements"
  on public.group_announcements for select
  to authenticated
  using (public.trainer_can_see_group(group_id));

revoke all on public.coach_team_members, public.client_trainer_assignments from anon, authenticated;
grant select on public.coach_team_members, public.client_trainer_assignments to authenticated;
grant all on public.coach_team_members, public.client_trainer_assignments to service_role;

-- Reduces whatever the browser sends to the four known permissions.
create or replace function public.normalize_team_permissions(p_permissions jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'manage_programs', coalesce(p_permissions ->> 'manage_programs', 'false') = 'true',
    'view_assessments', coalesce(p_permissions ->> 'view_assessments', 'false') = 'true',
    'messages', coalesce(p_permissions ->> 'messages', 'false') = 'true',
    'manage_groups', coalesce(p_permissions ->> 'manage_groups', 'false') = 'true'
  );
$$;

-- The access status now also reports trainer membership. A person with an active membership works under
-- the head coach's plan ('trainer' access), so being invited never unlocks the coach features for free.
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
  v_team public.coach_team_members%rowtype;
  v_has_team boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  select status into v_subscription_status from public.coach_subscriptions where user_id = v_profile.id;

  if v_profile.role = 'coach' then
    select * into v_team from public.coach_team_members where trainer_user_id = v_profile.id and status = 'active' limit 1;
    v_has_team := found;
  end if;

  if v_profile.role = 'client' then
    v_access_state := 'client';
  elsif v_has_team then
    v_access_state := 'trainer';
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
    'full_name', v_profile.full_name,
    'brand_name', v_profile.brand_name,
    'avatar_path', v_profile.avatar_path,
    'trial_started_at', v_profile.trial_started_at,
    'trial_ends_at', v_profile.trial_ends_at,
    'subscription_status', coalesce(
      v_subscription_status,
      case when v_profile.role = 'coach' and v_profile.trial_ends_at > statement_timestamp() then 'trialing' else 'none' end
    ),
    'access_state', v_access_state,
    'team', case when v_has_team then jsonb_build_object(
      'member_id', v_team.id,
      'head_coach_id', v_team.head_coach_id,
      'role_title', v_team.role_title,
      'permissions', v_team.permissions,
      'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = v_team.head_coach_id),
      'head_active', public.workflow_coach_is_active(v_team.head_coach_id)
    ) else null end
  );
end;
$$;

-- Program assignment, now usable by an assistant trainer for their assigned clients.
create or replace function public.assign_program_to_client(p_client_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_active_coach() then
    return public.assign_program_core(auth.uid(), p_client_id, p_program_id);
  elsif public.team_permission('manage_programs') then
    if not public.trainer_has_client(p_client_id) then
      raise exception 'That client is not assigned to you';
    end if;
    return public.assign_program_core(public.my_team_head(), p_client_id, p_program_id);
  end if;
  raise exception 'An active coach account is required to assign programs';
end;
$$;

create or replace function public.get_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'invite_email', m.invite_email,
        'role_title', m.role_title,
        'permissions', m.permissions,
        'status', m.status,
        'trainer_name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = m.trainer_user_id),
        'client_count', (select count(*) from public.client_trainer_assignments a where a.team_member_id = m.id),
        'created_at', m.created_at
      )
      order by m.created_at
    )
    from public.coach_team_members m
    where m.head_coach_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

create or replace function public.invite_trainer(p_email text, p_role_title text, p_permissions jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_title text := btrim(coalesce(p_role_title, ''));
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 254 then
    raise exception 'Enter a valid email address';
  end if;
  if v_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'You cannot invite yourself';
  end if;
  if char_length(v_title) > 80 then
    raise exception 'The role title can be at most 80 characters';
  end if;
  if (select count(*) from public.coach_team_members where head_coach_id = auth.uid()) >= 10 then
    raise exception 'A team can have at most 10 trainers';
  end if;
  if exists (select 1 from public.coach_team_members where head_coach_id = auth.uid() and invite_email = v_email) then
    raise exception 'This email has already been invited';
  end if;

  insert into public.coach_team_members (head_coach_id, invite_email, role_title, permissions)
  values (auth.uid(), v_email, v_title, public.normalize_team_permissions(p_permissions))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_team_member(
  p_member_id uuid,
  p_role_title text,
  p_permissions jsonb,
  p_status text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.coach_team_members%rowtype;
  v_title text := btrim(coalesce(p_role_title, ''));
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  select * into v_member from public.coach_team_members where id = p_member_id and head_coach_id = auth.uid() for update;
  if not found then
    raise exception 'Team member was not found';
  end if;
  if char_length(v_title) > 80 then
    raise exception 'The role title can be at most 80 characters';
  end if;
  if p_status is not null and p_status not in ('active', 'disabled') then
    raise exception 'Unsupported status';
  end if;
  if p_status is not null and v_member.trainer_user_id is null then
    raise exception 'Wait until the trainer accepts the invitation';
  end if;

  update public.coach_team_members
  set role_title = v_title,
      permissions = public.normalize_team_permissions(p_permissions),
      status = coalesce(p_status, status)
  where id = p_member_id;
end;
$$;

create or replace function public.remove_team_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  delete from public.coach_team_members where id = p_member_id and head_coach_id = auth.uid();
  if not found then
    raise exception 'Team member was not found';
  end if;
end;
$$;

-- Gives a client to an assistant trainer (or takes them back when p_member_id is null).
create or replace function public.assign_client_trainer(p_client_id uuid, p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  if not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;

  if p_member_id is null then
    delete from public.client_trainer_assignments where head_coach_id = auth.uid() and client_id = p_client_id;
    return;
  end if;
  if not exists (
    select 1 from public.coach_team_members where id = p_member_id and head_coach_id = auth.uid() and status = 'active'
  ) then
    raise exception 'Choose an active trainer';
  end if;

  insert into public.client_trainer_assignments (head_coach_id, client_id, team_member_id)
  values (auth.uid(), p_client_id, p_member_id)
  on conflict (head_coach_id, client_id) do update set team_member_id = excluded.team_member_id, assigned_at = statement_timestamp();
end;
$$;

-- Invitations addressed to the signed-in coach's email.
create or replace function public.get_my_team_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'role_title', m.role_title,
        'permissions', m.permissions,
        'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = m.head_coach_id),
        'created_at', m.created_at
      )
      order by m.created_at
    )
    from public.coach_team_members m
    where m.status = 'invited' and m.invite_email = v_email and v_email <> ''
  ), '[]'::jsonb);
end;
$$;

create or replace function public.accept_team_invitation(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_member public.coach_team_members%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required to join a team';
  end if;
  select * into v_member from public.coach_team_members where id = p_member_id for update;
  if not found or v_member.status <> 'invited' or v_email = '' or v_member.invite_email <> v_email then
    raise exception 'This invitation is not available';
  end if;
  if exists (select 1 from public.coach_clients where coach_id = auth.uid())
    or exists (select 1 from public.coach_subscriptions where user_id = auth.uid() and status = 'active') then
    raise exception 'This account already runs its own coaching practice, so it cannot join a team';
  end if;
  if exists (select 1 from public.coach_team_members where trainer_user_id = auth.uid() and status = 'active') then
    raise exception 'You already belong to a team';
  end if;

  update public.coach_team_members set trainer_user_id = auth.uid(), status = 'active' where id = p_member_id;
  return public.get_my_access_status();
end;
$$;

create or replace function public.decline_team_invitation(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  delete from public.coach_team_members where id = p_member_id and status = 'invited' and invite_email = v_email and v_email <> '';
  if not found then
    raise exception 'This invitation is not available';
  end if;
end;
$$;

create or replace function public.leave_team()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  delete from public.coach_team_members where trainer_user_id = auth.uid();
  return public.get_my_access_status();
end;
$$;

-- The assistant trainer's dashboard: only their assigned clients.
create or replace function public.get_trainer_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_head uuid := public.my_team_head();
begin
  if v_head is null then
    raise exception 'You are not part of an active team';
  end if;
  return jsonb_build_object(
    'head_coach_id', v_head,
    'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = v_head),
    'permissions', (select m.permissions from public.coach_team_members m where m.trainer_user_id = auth.uid() and m.status = 'active' limit 1),
    'clients', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'client_id', cc.client_id,
          'name', coalesce(nullif(btrim(cc.client_name), ''), nullif(split_part(coalesce(cc.client_email, ''), '@', 1), ''), 'Client'),
          'email', cc.client_email,
          'last_workout_date', (select max(s.workout_date) from public.client_workout_sessions s where s.client_id = cc.client_id),
          'workouts_7d', (select count(*) from public.client_workout_sessions s where s.client_id = cc.client_id and s.workout_date >= current_date - 6),
          'assessment_submitted', exists (select 1 from public.client_assessments a where a.client_id = cc.client_id and a.coach_id = cc.coach_id),
          'medical_clearance_required', exists (select 1 from public.client_assessments a where a.client_id = cc.client_id and a.coach_id = cc.coach_id and a.medical_clearance_required),
          'program', (
            select p.title from public.program_assignments pa join public.training_programs p on p.id = pa.program_id
            where pa.client_id = cc.client_id and pa.coach_id = cc.coach_id order by pa.assigned_at desc limit 1
          )
        )
        order by cc.created_at
      )
      from public.coach_clients cc
      where cc.coach_id = v_head and cc.status = 'active' and public.trainer_has_client(cc.client_id)
    ), '[]'::jsonb),
    'groups', case when public.team_permission('manage_groups') then coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.created_at desc)
      from public.coaching_groups g where g.coach_id = v_head
    ), '[]'::jsonb) else '[]'::jsonb end,
    'programs', case when public.team_permission('manage_programs') then coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title) order by p.updated_at desc)
      from public.training_programs p where p.coach_id = v_head
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- An assistant trainer writes to an assigned client as the head coach's team (the client sees a coach note).
create or replace function public.send_team_message(p_client_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_batch uuid := gen_random_uuid();
  v_head uuid := public.my_team_head();
begin
  if v_head is null or not public.team_permission('messages') then
    raise exception 'You do not have permission to message clients';
  end if;
  if not public.trainer_has_client(p_client_id) then
    raise exception 'That client is not assigned to you';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'Write a message of up to 2000 characters';
  end if;
  insert into public.coach_messages (batch_id, coach_id, client_id, kind, body)
  values (v_batch, v_head, p_client_id, 'note', v_body);
  return jsonb_build_object('batch_id', v_batch);
end;
$$;

-- Group management, now also available to assistant trainers with the "manage groups" permission.
create or replace function public.add_group_members(p_group_id uuid, p_client_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid;
  v_trainer boolean := false;
  v_program uuid;
  v_ids uuid[];
  v_client uuid;
  v_added integer := 0;
  v_assigned integer := 0;
  v_inserted integer;
begin
  if public.is_active_coach() then
    v_coach := auth.uid();
  elsif public.team_permission('manage_groups') then
    v_coach := public.my_team_head();
    v_trainer := true;
  else
    raise exception 'An active coach account is required to manage groups';
  end if;

  select program_template_id into v_program from public.coaching_groups where id = p_group_id and coach_id = v_coach;
  if not found then
    raise exception 'Group was not found';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_client_ids, '{}')) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'Choose at least one client';
  end if;
  if (
    select count(*) from public.coach_clients
    where coach_id = v_coach and status = 'active' and client_id = any (v_ids)
  ) <> array_length(v_ids, 1) then
    raise exception 'Only your active clients can be added to a group';
  end if;
  if v_trainer then
    foreach v_client in array v_ids loop
      if not public.trainer_has_client(v_client) then
        raise exception 'You can only add clients assigned to you';
      end if;
    end loop;
  end if;
  if (select count(*) from public.coaching_group_members where group_id = p_group_id) + array_length(v_ids, 1) > 100 then
    raise exception 'A group can have at most 100 members';
  end if;

  foreach v_client in array v_ids loop
    insert into public.coaching_group_members (group_id, client_id) values (p_group_id, v_client)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted > 0 then
      v_added := v_added + 1;
      if v_program is not null then
        perform public.assign_program_core(v_coach, v_client, v_program);
        v_assigned := v_assigned + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'program_assigned', v_assigned);
end;
$$;

create or replace function public.remove_group_member(p_group_id uuid, p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_active_coach() and public.is_group_owner(p_group_id) then
    null;
  elsif public.trainer_can_see_group(p_group_id) then
    if not public.trainer_has_client(p_client_id) then
      raise exception 'You can only manage clients assigned to you';
    end if;
  else
    raise exception 'Group was not found';
  end if;
  delete from public.coaching_group_members where group_id = p_group_id and client_id = p_client_id;
  if not found then
    raise exception 'That client is not in this group';
  end if;
end;
$$;

create or replace function public.post_group_announcement(p_group_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not ((public.is_active_coach() and public.is_group_owner(p_group_id)) or public.trainer_can_see_group(p_group_id)) then
    raise exception 'Group was not found';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'Write an update of up to 1000 characters';
  end if;
  if (
    select count(*) from public.group_announcements
    where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour'
  ) >= 20 then
    raise exception 'You are posting too quickly. Try again later';
  end if;

  insert into public.group_announcements (group_id, author_id, body)
  values (p_group_id, auth.uid(), v_body)
  returning id into v_id;
  return v_id;
end;
$$;

-- ===========================================================================
-- 2. Program store
-- ===========================================================================

create table if not exists public.store_products (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  program_template_id uuid not null references public.training_programs (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  price_cents integer not null check (price_cents = 0 or price_cents between 50 and 100000000),
  currency text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  cover_image_url text check (cover_image_url is null or (char_length(cover_image_url) <= 500 and cover_image_url ~ '^https://[^[:space:]<>"]+$')),
  is_published boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists store_products_coach_idx on public.store_products (coach_id, created_at desc);
create index if not exists store_products_published_idx on public.store_products (coach_id) where is_published;

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.store_products (id) on delete set null,
  buyer_client_id uuid not null,
  coach_id uuid not null,
  -- The title and program are copied so the buyer keeps access if the product is later removed.
  product_title text not null,
  program_template_id uuid references public.training_programs (id) on delete set null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'canceled')),
  payment_mode text not null default 'stripe' check (payment_mode in ('stripe', 'free', 'demo')),
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  assignment_id uuid references public.program_assignments (id) on delete set null,
  note text check (note is null or char_length(note) <= 300),
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (coach_id, buyer_client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

-- A client can have only one open or paid order per product, so double clicks and retries never double-buy.
create unique index if not exists store_orders_one_per_product
  on public.store_orders (product_id, buyer_client_id) where status in ('pending', 'paid') and product_id is not null;
create index if not exists store_orders_coach_idx on public.store_orders (coach_id, created_at desc);
create index if not exists store_orders_buyer_idx on public.store_orders (buyer_client_id, created_at desc);

alter table public.store_products enable row level security;
alter table public.store_orders enable row level security;

drop policy if exists "Coaches can read their products" on public.store_products;
create policy "Coaches can read their products"
  on public.store_products for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read published products from their coach" on public.store_products;
create policy "Clients can read published products from their coach"
  on public.store_products for select
  to authenticated
  using (
    is_published
    and public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = store_products.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
  );

drop policy if exists "Coaches can read their orders" on public.store_orders;
create policy "Coaches can read their orders"
  on public.store_orders for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Buyers can read their orders" on public.store_orders;
create policy "Buyers can read their orders"
  on public.store_orders for select
  to authenticated
  using (buyer_client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.store_products, public.store_orders from anon, authenticated;
grant select on public.store_products, public.store_orders to authenticated;
grant all on public.store_products, public.store_orders to service_role;

create or replace function public.save_store_product(
  p_product_id uuid,
  p_program_id uuid,
  p_title text,
  p_description text,
  p_price_cents integer,
  p_currency text,
  p_cover_image_url text,
  p_publish boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_cover text := nullif(btrim(coalesce(p_cover_image_url, '')), '');
  v_current public.store_products%rowtype;
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the product a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_price_cents is null or not (p_price_cents = 0 or p_price_cents between 50 and 100000000) then
    raise exception 'The price must be free or at least 0.50';
  end if;
  if p_currency is null or p_currency not in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed') then
    raise exception 'Choose a supported currency';
  end if;
  if v_cover is not null and (char_length(v_cover) > 500 or v_cover !~ '^https://[^[:space:]<>"]+$') then
    raise exception 'The cover image must be a secure https link';
  end if;
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = auth.uid()) then
    raise exception 'Program was not found';
  end if;

  if p_product_id is null then
    if (select count(*) from public.store_products where coach_id = auth.uid()) >= 50 then
      raise exception 'You can have at most 50 products';
    end if;
    insert into public.store_products (coach_id, program_template_id, title, description, price_cents, currency, cover_image_url, is_published)
    values (auth.uid(), p_program_id, v_title, v_description, p_price_cents, p_currency, v_cover, coalesce(p_publish, false))
    returning id into v_id;
    return v_id;
  end if;

  select * into v_current from public.store_products where id = p_product_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Product was not found';
  end if;
  if v_current.program_template_id <> p_program_id
    and exists (select 1 from public.store_orders where product_id = p_product_id) then
    raise exception 'The program cannot change once the product has orders';
  end if;

  update public.store_products
  set program_template_id = p_program_id, title = v_title, description = v_description, price_cents = p_price_cents,
      currency = p_currency, cover_image_url = v_cover, is_published = coalesce(p_publish, is_published)
  where id = p_product_id;
  return p_product_id;
end;
$$;

create or replace function public.set_store_product_published(p_product_id uuid, p_published boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  update public.store_products set is_published = coalesce(p_published, false)
  where id = p_product_id and coach_id = auth.uid();
  if not found then
    raise exception 'Product was not found';
  end if;
end;
$$;

create or replace function public.delete_store_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  if not exists (select 1 from public.store_products where id = p_product_id and coach_id = auth.uid()) then
    raise exception 'Product was not found';
  end if;
  if exists (select 1 from public.store_orders where product_id = p_product_id and status in ('paid', 'refunded')) then
    raise exception 'Products with sales cannot be deleted. Unpublish it instead';
  end if;
  delete from public.store_orders where product_id = p_product_id and status in ('pending', 'canceled');
  delete from public.store_products where id = p_product_id and coach_id = auth.uid();
end;
$$;

-- Marks an order as paid and gives the buyer the program. Safe to call twice for the same order.
create or replace function public.finish_store_order(
  p_order_id uuid,
  p_mode text,
  p_session_id text,
  p_payment_intent text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_assignment jsonb;
  v_note text;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order was not found';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'status', 'paid', 'already_paid', true, 'assignment_id', v_order.assignment_id);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'This order can no longer be completed';
  end if;

  begin
    v_assignment := public.assign_program_core(v_order.coach_id, v_order.buyer_client_id, v_order.program_template_id);
  exception when others then
    v_assignment := null;
    v_note := left('Program was not delivered: ' || sqlerrm, 300);
  end;

  update public.store_orders
  set status = 'paid',
      payment_mode = p_mode,
      stripe_session_id = coalesce(p_session_id, stripe_session_id),
      stripe_payment_intent_id = coalesce(p_payment_intent, stripe_payment_intent_id),
      assignment_id = (v_assignment ->> 'assignment_id')::uuid,
      note = v_note,
      purchased_at = statement_timestamp()
  where id = p_order_id;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', 'paid', 'already_paid', false,
    'assignment_id', v_assignment ->> 'assignment_id', 'delivered', v_assignment is not null
  );
end;
$$;

-- Starts (or resumes) a purchase for the signed-in client. Free products are completed on the spot.
create or replace function public.begin_store_purchase(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.store_products%rowtype;
  v_order public.store_orders%rowtype;
  v_done jsonb;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to buy programs';
  end if;

  select * into v_product from public.store_products where id = p_product_id;
  if not found or not v_product.is_published or not exists (
    select 1 from public.coach_clients where coach_id = v_product.coach_id and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'This product is not available';
  end if;
  if not public.workflow_coach_is_active(v_product.coach_id) then
    raise exception 'This store is not accepting orders right now';
  end if;

  select * into v_order from public.store_orders
  where product_id = p_product_id and buyer_client_id = auth.uid() and status in ('pending', 'paid')
  for update;

  if found and v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'already_owned', true, 'completed', true);
  end if;

  if not found then
    insert into public.store_orders (product_id, buyer_client_id, coach_id, product_title, program_template_id, amount_cents, currency, payment_mode)
    values (p_product_id, auth.uid(), v_product.coach_id, v_product.title, v_product.program_template_id,
            v_product.price_cents, v_product.currency, case when v_product.price_cents = 0 then 'free' else 'stripe' end)
    returning * into v_order;
  else
    -- The coach may have changed the price since the checkout was started.
    update public.store_orders
    set product_title = v_product.title, program_template_id = v_product.program_template_id,
        amount_cents = v_product.price_cents, currency = v_product.currency,
        payment_mode = case when v_product.price_cents = 0 then 'free' else 'stripe' end,
        stripe_session_id = null
    where id = v_order.id
    returning * into v_order;
  end if;

  if v_order.amount_cents = 0 then
    v_done := public.finish_store_order(v_order.id, 'free', null, null);
    return jsonb_build_object('order_id', v_order.id, 'already_owned', false, 'completed', true, 'assignment_id', v_done ->> 'assignment_id');
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'already_owned', false, 'completed', false,
    'amount_cents', v_order.amount_cents, 'currency', v_order.currency,
    'title', v_order.product_title, 'coach_id', v_order.coach_id
  );
end;
$$;

-- Called by the payment webhook (or by demo mode) with the service role. Verifies the amount before delivering.
create or replace function public.complete_store_order(
  p_order_id uuid,
  p_session_id text,
  p_amount_cents integer,
  p_currency text,
  p_payment_intent text,
  p_mode text default 'stripe'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
begin
  if p_mode not in ('stripe', 'demo') then
    raise exception 'Unsupported payment mode';
  end if;
  select * into v_order from public.store_orders where id = p_order_id;
  if not found then
    raise exception 'Order was not found';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'status', 'paid', 'already_paid', true);
  end if;
  if p_mode = 'stripe' and (p_amount_cents is distinct from v_order.amount_cents or lower(coalesce(p_currency, '')) <> v_order.currency) then
    raise exception 'The payment does not match the order';
  end if;
  return public.finish_store_order(p_order_id, p_mode, p_session_id, p_payment_intent);
end;
$$;

create or replace function public.get_store_sales()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  return jsonb_build_object(
    'orders_paid', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'paid'),
    'orders_pending', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'pending'),
    'revenue', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'cents', total) order by currency)
      from (
        select currency, sum(amount_cents)::bigint as total
        from public.store_orders where coach_id = auth.uid() and status = 'paid' group by currency
      ) r
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', p.id, 'title', p.title, 'sales', s.sales, 'cents', s.cents, 'currency', p.currency) order by s.sales desc, p.title)
      from public.store_products p
      cross join lateral (
        select count(*) filter (where o.status = 'paid')::integer as sales,
               coalesce(sum(o.amount_cents) filter (where o.status = 'paid'), 0)::bigint as cents
        from public.store_orders o where o.product_id = p.id
      ) s
      where p.coach_id = auth.uid()
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'payment_mode', o.payment_mode, 'purchased_at', o.purchased_at, 'delivered', o.assignment_id is not null,
        'buyer', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client')
      ) order by o.purchased_at desc)
      from (
        select * from public.store_orders where coach_id = auth.uid() and status = 'paid' order by purchased_at desc limit 20
      ) o
      left join public.coach_clients cc on cc.coach_id = o.coach_id and cc.client_id = o.buyer_client_id
    ), '[]'::jsonb)
  );
end;
$$;

-- What the client sees in the store: their coach's published products, what they own, and the purchased programs.
create or replace function public.get_my_store()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'price_cents', p.price_cents, 'currency', p.currency,
        'cover_image_url', p.cover_image_url,
        'coach_name', coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), '')),
        'owned', exists (select 1 from public.store_orders o where o.product_id = p.id and o.buyer_client_id = auth.uid() and o.status = 'paid')
      ) order by p.created_at desc)
      from public.store_products p
      join public.coach_clients cc on cc.coach_id = p.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
      left join public.profiles pr on pr.id = p.coach_id
      where p.is_published and public.workflow_coach_is_active(p.coach_id)
    ), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'purchased_at', o.purchased_at,
        'program', case when o.program_template_id is null then null else public.program_summary(o.program_template_id) end
      ) order by o.purchased_at desc)
      from public.store_orders o
      where o.buyer_client_id = auth.uid() and o.status = 'paid'
    ), '[]'::jsonb)
  );
end;
$$;

-- The coach's public storefront: published products only, no sign-in needed.
create or replace function public.get_public_store(p_coach_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  select coalesce(nullif(btrim(brand_name), ''), nullif(btrim(full_name), '')) into v_name
  from public.profiles where id = p_coach_id and role = 'coach';
  if not found or not public.workflow_coach_is_active(p_coach_id) then
    return null;
  end if;
  return jsonb_build_object(
    'coach_name', v_name,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'price_cents', p.price_cents,
        'currency', p.currency, 'cover_image_url', p.cover_image_url
      ) order by p.created_at desc)
      from public.store_products p where p.coach_id = p_coach_id and p.is_published
    ), '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- 3. Live video sessions
-- ===========================================================================

create table if not exists public.video_sessions (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid,
  group_id uuid references public.coaching_groups (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 480),
  provider text not null check (provider in ('zoom', 'google_meet', 'custom')),
  meeting_url text not null check (char_length(meeting_url) <= 500 and meeting_url ~ '^https://[^[:space:]<>"]+$'),
  meeting_passcode text not null default '' check (char_length(meeting_passcode) <= 50),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  -- A session is either one-to-one or for a group.
  check (num_nonnulls(client_id, group_id) = 1),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists video_sessions_coach_idx on public.video_sessions (coach_id, scheduled_at desc);
create index if not exists video_sessions_client_idx on public.video_sessions (client_id, scheduled_at desc) where client_id is not null;
create index if not exists video_sessions_group_idx on public.video_sessions (group_id, scheduled_at desc) where group_id is not null;

alter table public.video_sessions enable row level security;

drop policy if exists "Coaches can read their video sessions" on public.video_sessions;
create policy "Coaches can read their video sessions"
  on public.video_sessions for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their video sessions" on public.video_sessions;
create policy "Clients can read their video sessions"
  on public.video_sessions for select
  to authenticated
  using (
    public.is_client_account()
    and (
      (
        client_id = (select auth.uid())
        and exists (
          select 1 from public.coach_clients cc
          where cc.coach_id = video_sessions.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
        )
      )
      or (group_id is not null and public.is_group_member(group_id))
    )
  );

revoke all on public.video_sessions from anon, authenticated;
grant select on public.video_sessions to authenticated;
grant all on public.video_sessions to service_role;

create or replace function public.video_link_matches_provider(p_provider text, p_url text)
returns boolean
language sql
immutable
as $$
  select case p_provider
    when 'zoom' then p_url ~* '^https://([a-z0-9-]+\.)*(zoom\.us|zoom\.com|zoomgov\.com)(/|\?|$)'
    when 'google_meet' then p_url ~* '^https://meet\.google\.com(/|\?|$)'
    when 'custom' then true
    else false
  end;
$$;

create or replace function public.schedule_video_session(
  p_client_id uuid,
  p_group_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_provider text,
  p_meeting_url text,
  p_meeting_passcode text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_url text := btrim(coalesce(p_meeting_url, ''));
  v_passcode text := btrim(coalesce(p_meeting_passcode, ''));
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if num_nonnulls(p_client_id, p_group_id) <> 1 then
    raise exception 'Choose one client or one group';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.coaching_groups where id = p_group_id and coach_id = auth.uid()
  ) then
    raise exception 'Group was not found';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the session a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_scheduled_at is null or p_scheduled_at < statement_timestamp() - interval '1 hour'
    or p_scheduled_at > statement_timestamp() + interval '2 years' then
    raise exception 'Choose a date and time in the future';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    raise exception 'The duration must be between 5 and 480 minutes';
  end if;
  if p_provider is null or p_provider not in ('zoom', 'google_meet', 'custom') then
    raise exception 'Choose a video provider';
  end if;
  if char_length(v_url) > 500 or v_url !~ '^https://[^[:space:]<>"]+$' then
    raise exception 'The meeting link must be a secure https link';
  end if;
  if not public.video_link_matches_provider(p_provider, v_url) then
    raise exception 'The meeting link does not match the selected provider';
  end if;
  if char_length(v_passcode) > 50 then
    raise exception 'The passcode can be at most 50 characters';
  end if;
  if (select count(*) from public.video_sessions where coach_id = auth.uid() and status = 'scheduled' and scheduled_at > statement_timestamp()) >= 200 then
    raise exception 'You have too many upcoming sessions';
  end if;

  insert into public.video_sessions (
    coach_id, client_id, group_id, title, description, scheduled_at, duration_minutes, provider, meeting_url, meeting_passcode
  )
  values (auth.uid(), p_client_id, p_group_id, v_title, v_description, p_scheduled_at, p_duration_minutes, p_provider, v_url, v_passcode)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_video_session(
  p_session_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_provider text,
  p_meeting_url text,
  p_meeting_passcode text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_url text := btrim(coalesce(p_meeting_url, ''));
  v_passcode text := btrim(coalesce(p_meeting_passcode, ''));
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if not exists (select 1 from public.video_sessions where id = p_session_id and coach_id = auth.uid()) then
    raise exception 'Session was not found';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the session a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_scheduled_at is null or p_scheduled_at > statement_timestamp() + interval '2 years' then
    raise exception 'Choose a date and time in the future';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    raise exception 'The duration must be between 5 and 480 minutes';
  end if;
  if p_provider is null or p_provider not in ('zoom', 'google_meet', 'custom') then
    raise exception 'Choose a video provider';
  end if;
  if char_length(v_url) > 500 or v_url !~ '^https://[^[:space:]<>"]+$' then
    raise exception 'The meeting link must be a secure https link';
  end if;
  if not public.video_link_matches_provider(p_provider, v_url) then
    raise exception 'The meeting link does not match the selected provider';
  end if;
  if char_length(v_passcode) > 50 then
    raise exception 'The passcode can be at most 50 characters';
  end if;

  update public.video_sessions
  set title = v_title, description = v_description, scheduled_at = p_scheduled_at, duration_minutes = p_duration_minutes,
      provider = p_provider, meeting_url = v_url, meeting_passcode = v_passcode
  where id = p_session_id and coach_id = auth.uid();
end;
$$;

create or replace function public.set_video_session_status(p_session_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if p_status is null or p_status not in ('scheduled', 'completed', 'cancelled') then
    raise exception 'Unsupported status';
  end if;
  update public.video_sessions set status = p_status where id = p_session_id and coach_id = auth.uid();
  if not found then
    raise exception 'Session was not found';
  end if;
end;
$$;

create or replace function public.delete_video_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  delete from public.video_sessions where id = p_session_id and coach_id = auth.uid();
  if not found then
    raise exception 'Session was not found';
  end if;
end;
$$;

-- The client's sessions with the coach and group names, for the recent past and the coming months.
create or replace function public.get_my_video_sessions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(s)::jsonb order by s.scheduled_at)
    from (
      select v.id, v.title, v.description, v.scheduled_at, v.duration_minutes, v.provider, v.meeting_url,
             v.meeting_passcode, v.status, v.group_id, g.name as group_name,
             coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), '')) as coach_name
      from public.video_sessions v
      left join public.coaching_groups g on g.id = v.group_id
      left join public.profiles pr on pr.id = v.coach_id
      where v.scheduled_at > statement_timestamp() - interval '30 days'
        and v.scheduled_at < statement_timestamp() + interval '180 days'
        and (
          (v.client_id = auth.uid() and exists (
            select 1 from public.coach_clients cc where cc.coach_id = v.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
          ))
          or (v.group_id is not null and public.is_group_member(v.group_id))
        )
      order by v.scheduled_at
      limit 100
    ) s
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke all on function public.normalize_team_permissions(jsonb) from public, anon, authenticated;
revoke all on function public.video_link_matches_provider(text, text) from public, anon, authenticated;
revoke all on function public.finish_store_order(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.my_team_head() from public, anon;
revoke all on function public.team_permission(text) from public, anon;
revoke all on function public.trainer_has_client(uuid) from public, anon;
revoke all on function public.trainer_can_see_group(uuid) from public, anon;
revoke all on function public.i_own_team_member(uuid) from public, anon;
grant execute on function public.my_team_head() to authenticated;
grant execute on function public.team_permission(text) to authenticated;
grant execute on function public.trainer_has_client(uuid) to authenticated;
grant execute on function public.trainer_can_see_group(uuid) to authenticated;
grant execute on function public.i_own_team_member(uuid) to authenticated;

revoke all on function public.get_my_access_status() from public;
grant execute on function public.get_my_access_status() to authenticated;
revoke all on function public.assign_program_to_client(uuid, uuid) from public, anon;
grant execute on function public.assign_program_to_client(uuid, uuid) to authenticated;
revoke all on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon;
revoke all on function public.post_group_announcement(uuid, text) from public, anon;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.post_group_announcement(uuid, text) to authenticated;

revoke all on function public.get_team() from public, anon;
revoke all on function public.invite_trainer(text, text, jsonb) from public, anon;
revoke all on function public.update_team_member(uuid, text, jsonb, text) from public, anon;
revoke all on function public.remove_team_member(uuid) from public, anon;
revoke all on function public.assign_client_trainer(uuid, uuid) from public, anon;
revoke all on function public.get_my_team_invitations() from public, anon;
revoke all on function public.accept_team_invitation(uuid) from public, anon;
revoke all on function public.decline_team_invitation(uuid) from public, anon;
revoke all on function public.leave_team() from public, anon;
revoke all on function public.get_trainer_overview() from public, anon;
revoke all on function public.send_team_message(uuid, text) from public, anon;
grant execute on function public.get_team() to authenticated;
grant execute on function public.invite_trainer(text, text, jsonb) to authenticated;
grant execute on function public.update_team_member(uuid, text, jsonb, text) to authenticated;
grant execute on function public.remove_team_member(uuid) to authenticated;
grant execute on function public.assign_client_trainer(uuid, uuid) to authenticated;
grant execute on function public.get_my_team_invitations() to authenticated;
grant execute on function public.accept_team_invitation(uuid) to authenticated;
grant execute on function public.decline_team_invitation(uuid) to authenticated;
grant execute on function public.leave_team() to authenticated;
grant execute on function public.get_trainer_overview() to authenticated;
grant execute on function public.send_team_message(uuid, text) to authenticated;

revoke all on function public.save_store_product(uuid, uuid, text, text, integer, text, text, boolean) from public, anon;
revoke all on function public.set_store_product_published(uuid, boolean) from public, anon;
revoke all on function public.delete_store_product(uuid) from public, anon;
revoke all on function public.begin_store_purchase(uuid) from public, anon;
revoke all on function public.get_store_sales() from public, anon;
revoke all on function public.get_my_store() from public, anon;
grant execute on function public.save_store_product(uuid, uuid, text, text, integer, text, text, boolean) to authenticated;
grant execute on function public.set_store_product_published(uuid, boolean) to authenticated;
grant execute on function public.delete_store_product(uuid) to authenticated;
grant execute on function public.begin_store_purchase(uuid) to authenticated;
grant execute on function public.get_store_sales() to authenticated;
grant execute on function public.get_my_store() to authenticated;

-- Only the server (service role) may confirm a payment.
revoke all on function public.complete_store_order(uuid, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_store_order(uuid, text, integer, text, text, text) to service_role;

revoke all on function public.get_public_store(uuid) from public;
grant execute on function public.get_public_store(uuid) to anon, authenticated;

revoke all on function public.schedule_video_session(uuid, uuid, text, text, timestamptz, integer, text, text, text) from public, anon;
revoke all on function public.update_video_session(uuid, text, text, timestamptz, integer, text, text, text) from public, anon;
revoke all on function public.set_video_session_status(uuid, text) from public, anon;
revoke all on function public.delete_video_session(uuid) from public, anon;
revoke all on function public.get_my_video_sessions() from public, anon;
grant execute on function public.schedule_video_session(uuid, uuid, text, text, timestamptz, integer, text, text, text) to authenticated;
grant execute on function public.update_video_session(uuid, text, text, timestamptz, integer, text, text, text) to authenticated;
grant execute on function public.set_video_session_status(uuid, text) to authenticated;
grant execute on function public.delete_video_session(uuid) to authenticated;
grant execute on function public.get_my_video_sessions() to authenticated;

-- ===== 20261115001200_live_video_room.sql =====

-- Built-in live video room ("apexfit_live"). A session in this mode needs no external link: it gets a
-- unique, unguessable room name, and the app opens the video room inside ApexFit.

alter table public.video_sessions add column if not exists room_name text;
alter table public.video_sessions alter column meeting_url drop not null;

-- Replace the old provider check (zoom / google_meet / custom) with one that also allows apexfit_live.
do $$
declare
  v_constraint record;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.video_sessions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%google_meet%'
      and conname not in ('video_sessions_provider_values')
  loop
    execute format('alter table public.video_sessions drop constraint %I', v_constraint.conname);
  end loop;
end;
$$;

alter table public.video_sessions drop constraint if exists video_sessions_provider_values;
alter table public.video_sessions add constraint video_sessions_provider_values
  check (provider in ('apexfit_live', 'zoom', 'google_meet', 'custom'));

-- External providers still need a link; the built-in room needs a room name instead.
alter table public.video_sessions drop constraint if exists video_sessions_link_required;
alter table public.video_sessions add constraint video_sessions_link_required
  check (provider = 'apexfit_live' or meeting_url is not null);

alter table public.video_sessions drop constraint if exists video_sessions_room_name_format;
alter table public.video_sessions add constraint video_sessions_room_name_format
  check (room_name is null or room_name ~ '^apexfit-session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

alter table public.video_sessions drop constraint if exists video_sessions_live_room_required;
alter table public.video_sessions add constraint video_sessions_live_room_required
  check (provider <> 'apexfit_live' or room_name is not null);

create or replace function public.schedule_video_session(
  p_client_id uuid,
  p_group_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_provider text,
  p_meeting_url text,
  p_meeting_passcode text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_live boolean := p_provider = 'apexfit_live';
  v_url text := case when p_provider = 'apexfit_live' then null else btrim(coalesce(p_meeting_url, '')) end;
  v_passcode text := case when p_provider = 'apexfit_live' then '' else btrim(coalesce(p_meeting_passcode, '')) end;
  v_id uuid := gen_random_uuid();
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if num_nonnulls(p_client_id, p_group_id) <> 1 then
    raise exception 'Choose one client or one group';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.coaching_groups where id = p_group_id and coach_id = auth.uid()
  ) then
    raise exception 'Group was not found';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the session a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_scheduled_at is null or p_scheduled_at < statement_timestamp() - interval '1 hour'
    or p_scheduled_at > statement_timestamp() + interval '2 years' then
    raise exception 'Choose a date and time in the future';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    raise exception 'The duration must be between 5 and 480 minutes';
  end if;
  if p_provider is null or p_provider not in ('apexfit_live', 'zoom', 'google_meet', 'custom') then
    raise exception 'Choose a video provider';
  end if;
  if not v_live then
    if char_length(v_url) > 500 or v_url !~ '^https://[^[:space:]<>"]+$' then
      raise exception 'The meeting link must be a secure https link';
    end if;
    if not public.video_link_matches_provider(p_provider, v_url) then
      raise exception 'The meeting link does not match the selected provider';
    end if;
    if char_length(v_passcode) > 50 then
      raise exception 'The passcode can be at most 50 characters';
    end if;
  end if;
  if (select count(*) from public.video_sessions where coach_id = auth.uid() and status = 'scheduled' and scheduled_at > statement_timestamp()) >= 200 then
    raise exception 'You have too many upcoming sessions';
  end if;

  insert into public.video_sessions (
    id, coach_id, client_id, group_id, title, description, scheduled_at, duration_minutes, provider,
    meeting_url, meeting_passcode, room_name
  )
  values (
    v_id, auth.uid(), p_client_id, p_group_id, v_title, v_description, p_scheduled_at, p_duration_minutes, p_provider,
    v_url, v_passcode, case when v_live then 'apexfit-session-' || v_id::text else null end
  );
  return v_id;
end;
$$;

create or replace function public.update_video_session(
  p_session_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_provider text,
  p_meeting_url text,
  p_meeting_passcode text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_live boolean := p_provider = 'apexfit_live';
  v_url text := case when p_provider = 'apexfit_live' then null else btrim(coalesce(p_meeting_url, '')) end;
  v_passcode text := case when p_provider = 'apexfit_live' then '' else btrim(coalesce(p_meeting_passcode, '')) end;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if not exists (select 1 from public.video_sessions where id = p_session_id and coach_id = auth.uid()) then
    raise exception 'Session was not found';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the session a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_scheduled_at is null or p_scheduled_at > statement_timestamp() + interval '2 years' then
    raise exception 'Choose a date and time in the future';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    raise exception 'The duration must be between 5 and 480 minutes';
  end if;
  if p_provider is null or p_provider not in ('apexfit_live', 'zoom', 'google_meet', 'custom') then
    raise exception 'Choose a video provider';
  end if;
  if not v_live then
    if char_length(v_url) > 500 or v_url !~ '^https://[^[:space:]<>"]+$' then
      raise exception 'The meeting link must be a secure https link';
    end if;
    if not public.video_link_matches_provider(p_provider, v_url) then
      raise exception 'The meeting link does not match the selected provider';
    end if;
    if char_length(v_passcode) > 50 then
      raise exception 'The passcode can be at most 50 characters';
    end if;
  end if;

  update public.video_sessions
  set title = v_title, description = v_description, scheduled_at = p_scheduled_at, duration_minutes = p_duration_minutes,
      provider = p_provider, meeting_url = v_url, meeting_passcode = v_passcode,
      -- The room keeps the same name for the life of the session, so a link someone already has keeps working.
      room_name = case when v_live then 'apexfit-session-' || p_session_id::text else null end
  where id = p_session_id and coach_id = auth.uid();
end;
$$;

create or replace function public.get_my_video_sessions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(s)::jsonb order by s.scheduled_at)
    from (
      select v.id, v.title, v.description, v.scheduled_at, v.duration_minutes, v.provider, v.meeting_url,
             v.meeting_passcode, v.room_name, v.status, v.group_id, g.name as group_name,
             coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), '')) as coach_name
      from public.video_sessions v
      left join public.coaching_groups g on g.id = v.group_id
      left join public.profiles pr on pr.id = v.coach_id
      where v.scheduled_at > statement_timestamp() - interval '30 days'
        and v.scheduled_at < statement_timestamp() + interval '180 days'
        and (
          (v.client_id = auth.uid() and exists (
            select 1 from public.coach_clients cc where cc.coach_id = v.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
          ))
          or (v.group_id is not null and public.is_group_member(v.group_id))
        )
      order by v.scheduled_at
      limit 100
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.schedule_video_session(uuid, uuid, text, text, timestamptz, integer, text, text, text) from public, anon;
revoke all on function public.update_video_session(uuid, text, text, timestamptz, integer, text, text, text) from public, anon;
revoke all on function public.get_my_video_sessions() from public, anon;
grant execute on function public.schedule_video_session(uuid, uuid, text, text, timestamptz, integer, text, text, text) to authenticated;
grant execute on function public.update_video_session(uuid, text, text, timestamptz, integer, text, text, text) to authenticated;
grant execute on function public.get_my_video_sessions() to authenticated;

-- ===== 20261115001300_video_room_signaling.sql =====

-- Signaling for the native ApexFit Live room. The browsers exchange WebRTC offers, answers and ICE candidates
-- through a private Supabase Realtime Broadcast channel named "video-room-<session id>". These policies decide
-- who may listen to and send on that channel, so only the people a session is for can join its room.

create or replace function public.can_join_video_room(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.video_sessions%rowtype;
begin
  if auth.uid() is null or p_topic is null
    or p_topic !~ '^video-room-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;

  select * into v_session from public.video_sessions where id = substr(p_topic, 12)::uuid;
  if not found or v_session.provider <> 'apexfit_live' or v_session.status <> 'scheduled' then
    return false;
  end if;
  -- The room closes an hour after the planned end.
  if statement_timestamp() >= v_session.scheduled_at + make_interval(mins => v_session.duration_minutes + 60) then
    return false;
  end if;

  -- The coach may open the room early to get ready.
  if v_session.coach_id = auth.uid() then
    return public.is_active_coach();
  end if;

  -- Clients join from 10 minutes before the start.
  if statement_timestamp() < v_session.scheduled_at - interval '10 minutes' or not public.is_client_account() then
    return false;
  end if;
  if v_session.client_id = auth.uid() then
    return exists (
      select 1 from public.coach_clients
      where coach_id = v_session.coach_id and client_id = auth.uid() and status = 'active'
    );
  end if;
  return v_session.group_id is not null and public.is_group_member(v_session.group_id);
end;
$$;

revoke all on function public.can_join_video_room(text) from public, anon;
grant execute on function public.can_join_video_room(text) to authenticated;

-- Row-level security on the Realtime messages table (it exists on Supabase projects; skipped elsewhere).
-- Supabase already enables RLS on realtime.messages and the table belongs to a system role, so enabling it is
-- only attempted and a refusal is ignored. The policies are created separately: one failure must never hide the other.
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise warning 'realtime.messages was not found; enable Realtime on the project and run this migration again.';
    return;
  end if;

  begin
    alter table realtime.messages enable row level security;
  exception when insufficient_privilege then
    null;
  end;

  begin
    drop policy if exists "Video room members can receive signals" on realtime.messages;
    create policy "Video room members can receive signals"
      on realtime.messages for select
      to authenticated
      using (realtime.messages.extension = 'broadcast' and public.can_join_video_room((select realtime.topic())));
  exception when others then
    raise warning 'Could not create the receive policy on realtime.messages: %', sqlerrm;
  end;

  begin
    drop policy if exists "Video room members can send signals" on realtime.messages;
    create policy "Video room members can send signals"
      on realtime.messages for insert
      to authenticated
      with check (realtime.messages.extension = 'broadcast' and public.can_join_video_room((select realtime.topic())));
  exception when others then
    raise warning 'Could not create the send policy on realtime.messages: %', sqlerrm;
  end;
end;
$$;

-- Check: this must list two rows (receive + send).
-- select policyname, cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname like 'Video room%';

-- ===== 20261115001400_wearables_nutrition.sql =====

-- Smart-device data (Apple Health exports and manual entries) and nutrition tracking (MyFitnessPal exports and
-- manual entries). Rows are read through row-level security. Clients write through security definer functions that
-- validate every value.

-- Who may read a client's health data: the client, their active coach, and an assistant trainer who has the
-- "view health data" (view_assessments) permission for that client.
create or replace function public.can_view_client_health(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_client_id is not null and (
    (p_client_id = auth.uid() and public.is_client_account())
    or (
      public.is_active_coach()
      and exists (
        select 1 from public.coach_clients cc
        where cc.coach_id = auth.uid() and cc.client_id = p_client_id and cc.status = 'active'
      )
    )
    or (public.team_permission('view_assessments') and public.trainer_has_client(p_client_id))
  );
$$;

revoke all on function public.can_view_client_health(uuid) from public, anon;
grant execute on function public.can_view_client_health(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.wearable_connections (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (provider = 'apple_health'),
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, provider)
);

create index if not exists wearable_connections_client_idx on public.wearable_connections (client_id);

create table if not exists public.wearable_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  recorded_date date not null,
  provider text not null check (provider in ('apple_health', 'manual')),
  steps integer check (steps between 0 and 200000),
  active_calories integer check (active_calories between 0 and 20000),
  sleep_minutes integer check (sleep_minutes between 0 and 1440),
  resting_heart_rate integer check (resting_heart_rate between 20 and 250),
  hrv_ms numeric(6, 2) check (hrv_ms between 0 and 500),
  recovery_score integer check (recovery_score between 0 and 100),
  synced_at timestamptz not null default now(),
  -- One row per client, day and source: syncing again updates the day instead of adding a copy.
  unique (client_id, recorded_date, provider),
  check (num_nonnulls(steps, active_calories, sleep_minutes, resting_heart_rate, hrv_ms, recovery_score) > 0)
);

create index if not exists wearable_daily_metrics_client_date_idx on public.wearable_daily_metrics (client_id, recorded_date desc);

create table if not exists public.nutrition_daily_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  log_date date not null check (log_date <= current_date + 1),
  source text not null check (source in ('myfitnesspal_csv', 'myfitnesspal_sync', 'manual')),
  calories_consumed integer check (calories_consumed between 0 and 20000),
  protein_g numeric(7, 2) check (protein_g between 0 and 2000),
  carbs_g numeric(7, 2) check (carbs_g between 0 and 3000),
  fats_g numeric(7, 2) check (fats_g between 0 and 2000),
  water_ml integer check (water_ml between 0 and 20000),
  target_calories integer check (target_calories is null or target_calories between 500 and 10000),
  notes text check (notes is null or char_length(notes) <= 500),
  synced_at timestamptz not null default now(),
  unique (client_id, log_date, source),
  check (num_nonnulls(calories_consumed, protein_g, carbs_g, fats_g, water_ml) > 0)
);

create index if not exists nutrition_daily_logs_client_date_idx on public.nutrition_daily_logs (client_id, log_date desc);

-- The daily goal the client (or their coach) is working towards; logs are compared with it.
create table if not exists public.nutrition_targets (
  client_id uuid primary key references public.profiles (id) on delete cascade,
  calories integer check (calories is null or calories between 500 and 10000),
  protein_g numeric(7, 2) check (protein_g is null or protein_g between 0 and 1000),
  carbs_g numeric(7, 2) check (carbs_g is null or carbs_g between 0 and 1500),
  fats_g numeric(7, 2) check (fats_g is null or fats_g between 0 and 1000),
  set_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  check (num_nonnulls(calories, protein_g, carbs_g, fats_g) > 0)
);

alter table public.wearable_connections enable row level security;
alter table public.wearable_daily_metrics enable row level security;
alter table public.nutrition_daily_logs enable row level security;
alter table public.nutrition_targets enable row level security;

drop policy if exists "Health data is readable by the client and their care team" on public.wearable_connections;
create policy "Health data is readable by the client and their care team"
  on public.wearable_connections for select
  to authenticated
  using (public.can_view_client_health(client_id));

drop policy if exists "Health data is readable by the client and their care team" on public.wearable_daily_metrics;
create policy "Health data is readable by the client and their care team"
  on public.wearable_daily_metrics for select
  to authenticated
  using (public.can_view_client_health(client_id));

drop policy if exists "Health data is readable by the client and their care team" on public.nutrition_daily_logs;
create policy "Health data is readable by the client and their care team"
  on public.nutrition_daily_logs for select
  to authenticated
  using (public.can_view_client_health(client_id));

drop policy if exists "Health data is readable by the client and their care team" on public.nutrition_targets;
create policy "Health data is readable by the client and their care team"
  on public.nutrition_targets for select
  to authenticated
  using (public.can_view_client_health(client_id));

revoke all on public.wearable_connections, public.wearable_daily_metrics, public.nutrition_daily_logs, public.nutrition_targets
  from anon, authenticated;
grant select (id, client_id, provider, status, last_error, last_synced_at, created_at)
  on public.wearable_connections to authenticated;
grant select (id, client_id, recorded_date, provider, steps, active_calories, sleep_minutes, resting_heart_rate, hrv_ms, recovery_score, synced_at)
  on public.wearable_daily_metrics to authenticated;
grant select on public.nutrition_daily_logs, public.nutrition_targets to authenticated;
grant all on public.wearable_connections, public.wearable_daily_metrics, public.nutrition_daily_logs, public.nutrition_targets to service_role;

-- ---------------------------------------------------------------------------
-- Validation helpers
-- ---------------------------------------------------------------------------

-- Reads one optional numeric field from a JSON object and checks its range. Missing or null gives null.
create or replace function public.health_number(p_row jsonb, p_key text, p_min numeric, p_max numeric)
returns numeric
language plpgsql
immutable
as $$
declare
  v_value jsonb := p_row -> p_key;
  v_number numeric;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'number' then
    raise exception '% must be a number', p_key;
  end if;
  v_number := (p_row ->> p_key)::numeric;
  if v_number < p_min or v_number > p_max then
    raise exception '% must be between % and %', p_key, p_min, p_max;
  end if;
  return v_number;
end;
$$;

create or replace function public.health_date(p_row jsonb, p_key text, p_oldest_days integer, p_newest_days integer)
returns date
language plpgsql
stable
as $$
declare
  v_date date;
begin
  if jsonb_typeof(p_row -> p_key) is distinct from 'string' or (p_row ->> p_key) !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '% must be a date in YYYY-MM-DD format', p_key;
  end if;
  begin
    v_date := (p_row ->> p_key)::date;
  exception when others then
    raise exception '% must be a real date', p_key;
  end;
  if v_date > current_date + p_newest_days or v_date < current_date - p_oldest_days then
    raise exception '% is outside the allowed range', p_key;
  end if;
  return v_date;
end;
$$;

-- Saves up to 400 days of device metrics for one client and source. A value that is missing in a new sync keeps
-- the value saved earlier for that day.
create or replace function public.wearable_metrics_upsert(p_client_id uuid, p_provider text, p_metrics jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_date date;
  v_steps integer;
  v_calories integer;
  v_sleep integer;
  v_rhr integer;
  v_hrv numeric;
  v_recovery integer;
  v_count integer := 0;
begin
  if jsonb_typeof(p_metrics) is distinct from 'array' or jsonb_array_length(p_metrics) not between 1 and 400 then
    raise exception 'Send between 1 and 400 days of data';
  end if;

  for v_row in select value from jsonb_array_elements(p_metrics)
  loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'Each day must be an object';
    end if;
    v_date := public.health_date(v_row, 'date', 3650, 1);
    v_steps := round(public.health_number(v_row, 'steps', 0, 200000));
    v_calories := round(public.health_number(v_row, 'active_calories', 0, 20000));
    v_sleep := round(public.health_number(v_row, 'sleep_minutes', 0, 1440));
    v_rhr := round(public.health_number(v_row, 'resting_heart_rate', 20, 250));
    v_hrv := round(public.health_number(v_row, 'hrv_ms', 0, 500), 2);
    v_recovery := round(public.health_number(v_row, 'recovery_score', 0, 100));
    if num_nonnulls(v_steps, v_calories, v_sleep, v_rhr, v_hrv, v_recovery) = 0 then
      raise exception 'Each day needs at least one value (%)', v_date;
    end if;

    insert into public.wearable_daily_metrics (
      client_id, recorded_date, provider, steps, active_calories, sleep_minutes, resting_heart_rate, hrv_ms, recovery_score
    )
    values (p_client_id, v_date, p_provider, v_steps, v_calories, v_sleep, v_rhr, v_hrv, v_recovery)
    on conflict (client_id, recorded_date, provider) do update
    set steps = coalesce(excluded.steps, wearable_daily_metrics.steps),
        active_calories = coalesce(excluded.active_calories, wearable_daily_metrics.active_calories),
        sleep_minutes = coalesce(excluded.sleep_minutes, wearable_daily_metrics.sleep_minutes),
        resting_heart_rate = coalesce(excluded.resting_heart_rate, wearable_daily_metrics.resting_heart_rate),
        hrv_ms = coalesce(excluded.hrv_ms, wearable_daily_metrics.hrv_ms),
        recovery_score = coalesce(excluded.recovery_score, wearable_daily_metrics.recovery_score),
        synced_at = statement_timestamp();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.health_number(jsonb, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.health_date(jsonb, text, integer, integer) from public, anon, authenticated;
revoke all on function public.wearable_metrics_upsert(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Functions for clients
-- ---------------------------------------------------------------------------

-- Apple Health files and manual entries are the only sources a client may write themselves.
create or replace function public.save_wearable_metrics(p_provider text, p_metrics jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_saved integer;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to save health data';
  end if;
  if p_provider is null or p_provider not in ('apple_health', 'manual') then
    raise exception 'Only Apple Health imports and manual entries can be saved from the app';
  end if;

  v_saved := public.wearable_metrics_upsert(auth.uid(), p_provider, p_metrics);

  if p_provider = 'apple_health' then
    insert into public.wearable_connections (client_id, provider, status, last_synced_at, last_error)
    values (auth.uid(), 'apple_health', 'connected', statement_timestamp(), null)
    on conflict (client_id, provider) do update
    set status = 'connected', last_synced_at = statement_timestamp(), last_error = null;
  end if;
  return jsonb_build_object('saved', v_saved);
end;
$$;

create or replace function public.delete_my_wearable_data(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  if p_provider is null or p_provider not in ('apple_health', 'manual') then
    raise exception 'Unsupported source';
  end if;
  delete from public.wearable_daily_metrics where client_id = auth.uid() and provider = p_provider;
  get diagnostics v_deleted = row_count;
  -- Apple Health has no account behind it, so removing its data removes the connection too.
  if p_provider = 'apple_health' then
    delete from public.wearable_connections where client_id = auth.uid() and provider = 'apple_health';
  end if;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

create or replace function public.save_nutrition_log(
  p_date date,
  p_calories integer,
  p_protein numeric,
  p_carbs numeric,
  p_fats numeric,
  p_water_ml integer,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to log nutrition';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 3650 then
    raise exception 'Choose a date within the last ten years and not in the future';
  end if;
  if num_nonnulls(p_calories, p_protein, p_carbs, p_fats, p_water_ml) = 0 then
    raise exception 'Enter at least one value';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'Notes can be at most 500 characters';
  end if;
  if p_calories is not null and p_calories not between 0 and 20000 then
    raise exception 'Calories must be between 0 and 20000';
  end if;
  if p_protein is not null and p_protein not between 0 and 2000 then
    raise exception 'Protein must be between 0 and 2000 g';
  end if;
  if p_carbs is not null and p_carbs not between 0 and 3000 then
    raise exception 'Carbs must be between 0 and 3000 g';
  end if;
  if p_fats is not null and p_fats not between 0 and 2000 then
    raise exception 'Fats must be between 0 and 2000 g';
  end if;
  if p_water_ml is not null and p_water_ml not between 0 and 20000 then
    raise exception 'Water must be between 0 and 20000 ml';
  end if;

  -- Editing a day replaces the whole entry, so a corrected value can be cleared.
  insert into public.nutrition_daily_logs (
    client_id, log_date, source, calories_consumed, protein_g, carbs_g, fats_g, water_ml, target_calories, notes
  )
  values (
    auth.uid(), p_date, 'manual', p_calories, p_protein, p_carbs, p_fats, p_water_ml,
    (select calories from public.nutrition_targets where client_id = auth.uid()), v_notes
  )
  on conflict (client_id, log_date, source) do update
  set calories_consumed = excluded.calories_consumed, protein_g = excluded.protein_g, carbs_g = excluded.carbs_g,
      fats_g = excluded.fats_g, water_ml = excluded.water_ml, target_calories = excluded.target_calories,
      notes = excluded.notes, synced_at = statement_timestamp();
end;
$$;

-- Days read from a MyFitnessPal export. Each day replaces the previously imported one for that date.
create or replace function public.import_nutrition_logs(p_logs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_date date;
  v_calories integer;
  v_protein numeric;
  v_carbs numeric;
  v_fats numeric;
  v_water integer;
  v_target integer := (select calories from public.nutrition_targets where client_id = auth.uid());
  v_count integer := 0;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to import nutrition';
  end if;
  if jsonb_typeof(p_logs) is distinct from 'array' or jsonb_array_length(p_logs) not between 1 and 400 then
    raise exception 'Send between 1 and 400 days of data';
  end if;

  for v_row in select value from jsonb_array_elements(p_logs)
  loop
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'Each day must be an object';
    end if;
    v_date := public.health_date(v_row, 'log_date', 3650, 1);
    v_calories := round(public.health_number(v_row, 'calories_consumed', 0, 20000));
    v_protein := round(public.health_number(v_row, 'protein_g', 0, 2000), 2);
    v_carbs := round(public.health_number(v_row, 'carbs_g', 0, 3000), 2);
    v_fats := round(public.health_number(v_row, 'fats_g', 0, 2000), 2);
    v_water := round(public.health_number(v_row, 'water_ml', 0, 20000));
    if num_nonnulls(v_calories, v_protein, v_carbs, v_fats, v_water) = 0 then
      raise exception 'Each day needs at least one value (%)', v_date;
    end if;

    insert into public.nutrition_daily_logs (client_id, log_date, source, calories_consumed, protein_g, carbs_g, fats_g, water_ml, target_calories)
    values (auth.uid(), v_date, 'myfitnesspal_csv', v_calories, v_protein, v_carbs, v_fats, v_water, v_target)
    on conflict (client_id, log_date, source) do update
    set calories_consumed = excluded.calories_consumed, protein_g = excluded.protein_g, carbs_g = excluded.carbs_g,
        fats_g = excluded.fats_g, water_ml = excluded.water_ml, target_calories = excluded.target_calories,
        synced_at = statement_timestamp();
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('imported', v_count);
end;
$$;

create or replace function public.delete_nutrition_log(p_date date, p_source text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  delete from public.nutrition_daily_logs where client_id = auth.uid() and log_date = p_date and source = p_source;
  if not found then
    raise exception 'That entry was not found';
  end if;
end;
$$;

-- Sets (or, with every value empty, clears) the daily nutrition goal.
create or replace function public.nutrition_targets_write(p_client_id uuid, p_calories integer, p_protein numeric, p_carbs numeric, p_fats numeric, p_set_by uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if num_nonnulls(p_calories, p_protein, p_carbs, p_fats) = 0 then
    delete from public.nutrition_targets where client_id = p_client_id;
    return;
  end if;
  if p_calories is not null and p_calories not between 500 and 10000 then
    raise exception 'The calorie goal must be between 500 and 10000';
  end if;
  if p_protein is not null and p_protein not between 0 and 1000 then
    raise exception 'The protein goal must be between 0 and 1000 g';
  end if;
  if p_carbs is not null and p_carbs not between 0 and 1500 then
    raise exception 'The carbs goal must be between 0 and 1500 g';
  end if;
  if p_fats is not null and p_fats not between 0 and 1000 then
    raise exception 'The fats goal must be between 0 and 1000 g';
  end if;
  insert into public.nutrition_targets (client_id, calories, protein_g, carbs_g, fats_g, set_by, updated_at)
  values (p_client_id, p_calories, p_protein, p_carbs, p_fats, p_set_by, statement_timestamp())
  on conflict (client_id) do update
  set calories = excluded.calories, protein_g = excluded.protein_g, carbs_g = excluded.carbs_g, fats_g = excluded.fats_g,
      set_by = excluded.set_by, updated_at = statement_timestamp();
end;
$$;

create or replace function public.set_my_nutrition_targets(p_calories integer, p_protein numeric, p_carbs numeric, p_fats numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  perform public.nutrition_targets_write(auth.uid(), p_calories, p_protein, p_carbs, p_fats, auth.uid());
end;
$$;

-- The coach sets the goal for one of their active clients.
create or replace function public.set_client_nutrition_targets(p_client_id uuid, p_calories integer, p_protein numeric, p_carbs numeric, p_fats numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() or not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client was not found';
  end if;
  perform public.nutrition_targets_write(p_client_id, p_calories, p_protein, p_carbs, p_fats, auth.uid());
end;
$$;

revoke all on function public.nutrition_targets_write(uuid, integer, numeric, numeric, numeric, uuid) from public, anon, authenticated;

-- Everything the screens need for the last few days: connections, device metrics, nutrition logs and the goal.
-- With no client id it returns the signed-in client's own data.
create or replace function public.get_health_overview(p_client_id uuid default null, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := coalesce(p_client_id, auth.uid());
  v_days integer := greatest(1, least(coalesce(p_days, 7), 90));
begin
  if not public.can_view_client_health(v_client) then
    raise exception 'Client was not found';
  end if;
  return jsonb_build_object(
    'client_id', v_client,
    'today', current_date,
    'days', v_days,
    'connections', coalesce((
      select jsonb_agg(
        jsonb_build_object('provider', c.provider, 'status', c.status, 'last_synced_at', c.last_synced_at, 'last_error', c.last_error)
        order by c.provider
      )
      from public.wearable_connections c where c.client_id = v_client
    ), '[]'::jsonb),
    'metrics', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'recorded_date', m.recorded_date, 'provider', m.provider, 'steps', m.steps, 'active_calories', m.active_calories,
          'sleep_minutes', m.sleep_minutes, 'resting_heart_rate', m.resting_heart_rate, 'hrv_ms', m.hrv_ms, 'recovery_score', m.recovery_score
        )
        order by m.recorded_date, m.provider
      )
      from public.wearable_daily_metrics m
      where m.client_id = v_client and m.recorded_date > current_date - v_days and m.recorded_date <= current_date + 1
    ), '[]'::jsonb),
    'nutrition', jsonb_build_object(
      'targets', (
        select jsonb_build_object('calories', t.calories, 'protein_g', t.protein_g, 'carbs_g', t.carbs_g, 'fats_g', t.fats_g, 'updated_at', t.updated_at)
        from public.nutrition_targets t where t.client_id = v_client
      ),
      'logs', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', n.id, 'log_date', n.log_date, 'source', n.source, 'calories_consumed', n.calories_consumed, 'protein_g', n.protein_g,
            'carbs_g', n.carbs_g, 'fats_g', n.fats_g, 'water_ml', n.water_ml, 'target_calories', n.target_calories, 'notes', n.notes
          )
          order by n.log_date, n.source
        )
        from public.nutrition_daily_logs n
        where n.client_id = v_client and n.log_date > current_date - v_days and n.log_date <= current_date + 1
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.save_wearable_metrics(text, jsonb) from public, anon;
revoke all on function public.delete_my_wearable_data(text) from public, anon;
revoke all on function public.save_nutrition_log(date, integer, numeric, numeric, numeric, integer, text) from public, anon;
revoke all on function public.import_nutrition_logs(jsonb) from public, anon;
revoke all on function public.delete_nutrition_log(date, text) from public, anon;
revoke all on function public.set_my_nutrition_targets(integer, numeric, numeric, numeric) from public, anon;
revoke all on function public.set_client_nutrition_targets(uuid, integer, numeric, numeric, numeric) from public, anon;
revoke all on function public.get_health_overview(uuid, integer) from public, anon;
grant execute on function public.save_wearable_metrics(text, jsonb) to authenticated;
grant execute on function public.delete_my_wearable_data(text) to authenticated;
grant execute on function public.save_nutrition_log(date, integer, numeric, numeric, numeric, integer, text) to authenticated;
grant execute on function public.import_nutrition_logs(jsonb) to authenticated;
grant execute on function public.delete_nutrition_log(date, text) to authenticated;
grant execute on function public.set_my_nutrition_targets(integer, numeric, numeric, numeric) to authenticated;
grant execute on function public.set_client_nutrition_targets(uuid, integer, numeric, numeric, numeric) to authenticated;
grant execute on function public.get_health_overview(uuid, integer) to authenticated;

-- ===== 20261115001500_realtime_chat.sql =====

-- Two-way chat between a coach and each of their clients.
-- Messages are written only through send_chat_message, which checks that the two people are linked.
-- Reads are limited by row-level security to the two people in the conversation, and the table is added to
-- the supabase_realtime publication so new messages and read receipts arrive without refreshing the page.

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  receiver_id uuid not null references public.profiles (id) on delete cascade,
  message_text text not null check (char_length(btrim(message_text)) between 1 and 2000),
  created_at timestamptz not null default now(),
  is_read boolean not null default false,
  -- Chosen by the app for each message, so sending it again after a lost answer does not create a copy.
  client_ref uuid,
  check (sender_id <> receiver_id)
);

create unique index if not exists chat_messages_client_ref_idx on public.chat_messages (sender_id, client_ref) where client_ref is not null;
create index if not exists chat_messages_pair_idx on public.chat_messages (sender_id, receiver_id, created_at desc);
create index if not exists chat_messages_receiver_idx on public.chat_messages (receiver_id, sender_id, created_at desc);
create index if not exists chat_messages_unread_idx on public.chat_messages (receiver_id) where not is_read;

alter table public.chat_messages enable row level security;

drop policy if exists "Participants can read their chat messages" on public.chat_messages;
create policy "Participants can read their chat messages"
  on public.chat_messages for select
  to authenticated
  using (
    (sender_id = (select auth.uid()) or receiver_id = (select auth.uid()))
    and (public.is_client_account() or public.is_active_coach())
  );

revoke all on public.chat_messages from anon, authenticated;
grant select on public.chat_messages to authenticated;
grant all on public.chat_messages to service_role;

-- Live updates. Row-level security still decides who receives which row.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
     ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
exception when others then
  raise warning 'Could not add chat_messages to the supabase_realtime publication: %. Enable Realtime for this table in the Supabase dashboard (Database > Replication).', sqlerrm;
end
$$;

-- A coach and a client may chat while the client is one of the coach's active clients.
create or replace function public.chat_can_message(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_other is not null and exists (
    select 1 from public.coach_clients cc
    where cc.status = 'active'
      and (
        (cc.coach_id = auth.uid() and cc.client_id = p_other and public.is_active_coach())
        or (cc.client_id = auth.uid() and cc.coach_id = p_other and public.is_client_account() and public.workflow_coach_is_active(cc.coach_id))
      )
  );
$$;

create or replace function public.send_chat_message(p_receiver_id uuid, p_text text, p_client_ref uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_row public.chat_messages;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send messages';
  end if;
  if not public.chat_can_message(p_receiver_id) then
    raise exception 'You can only message your own coach or your active clients';
  end if;
  if v_text = '' then
    raise exception 'Write a message first';
  end if;
  if char_length(v_text) > 2000 then
    raise exception 'Messages cannot exceed 2000 characters';
  end if;

  if p_client_ref is not null then
    select * into v_row from public.chat_messages where sender_id = auth.uid() and client_ref = p_client_ref;
    if found then
      return to_jsonb(v_row);
    end if;
  end if;

  if (select count(*) from public.chat_messages where sender_id = auth.uid() and created_at > statement_timestamp() - interval '1 minute') >= 40 then
    raise exception 'You are sending messages too fast. Wait a moment';
  end if;

  insert into public.chat_messages (sender_id, receiver_id, message_text, client_ref, created_at)
  values (auth.uid(), p_receiver_id, v_text, p_client_ref, clock_timestamp())
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- One page of the conversation with one person, oldest first. Pass the time of the oldest message you
-- already have to load earlier ones.
create or replace function public.get_chat_messages(p_partner_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (select greatest(1, least(coalesce(p_limit, 50), 200)) as lim),
  page as (
    select m.id, m.sender_id, m.receiver_id, m.message_text, m.created_at, m.is_read,
           row_number() over (order by m.created_at desc, m.id desc) as rn
    from public.chat_messages m
    where ((m.sender_id = auth.uid() and m.receiver_id = p_partner_id) or (m.sender_id = p_partner_id and m.receiver_id = auth.uid()))
      and (p_before is null or m.created_at < p_before)
    order by m.created_at desc, m.id desc
    limit (select lim + 1 from params)
  )
  select jsonb_build_object(
    'messages', coalesce(
      jsonb_agg(jsonb_build_object('id', id, 'sender_id', sender_id, 'receiver_id', receiver_id, 'message_text', message_text, 'created_at', created_at, 'is_read', is_read)
                order by created_at, id) filter (where rn <= (select lim from params)),
      '[]'::jsonb),
    'has_more', coalesce(bool_or(rn > (select lim from params)), false)
  )
  from page;
$$;

-- The person opened the conversation: everything the other person sent becomes read.
create or replace function public.mark_chat_read(p_partner_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  update public.chat_messages
  set is_read = true
  where receiver_id = auth.uid() and sender_id = p_partner_id and not is_read;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The list on the left: every person the caller can chat with (and anyone they already talked to),
-- with the last message and the number of unread ones.
create or replace function public.get_chat_conversations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_is_coach boolean;
begin
  if v_me is null then
    raise exception 'Sign in first';
  end if;
  v_is_coach := exists (select 1 from public.profiles where id = v_me and role = 'coach');

  return coalesce((
    select jsonb_agg(item order by (item ->> 'last_at') desc nulls last, (item ->> 'partner_name'))
    from (
      select jsonb_build_object(
        'partner_id', link.partner_id,
        'partner_name', link.partner_name,
        'partner_avatar_path', p.avatar_path,
        'status', link.status,
        'last_text', last.message_text,
        'last_at', last.created_at,
        'last_sender_id', last.sender_id,
        'unread_count', coalesce(unread.n, 0)
      ) as item
      from (
        select case when v_is_coach then cc.client_id else cc.coach_id end as partner_id,
               coalesce(nullif(btrim(case when v_is_coach then cc.client_name else cc.coach_name end), ''),
                        nullif(btrim(case when v_is_coach then cc.client_email else cc.coach_email end), ''), 'ApexFit') as partner_name,
               case when cc.status = 'active' and (v_is_coach or public.workflow_coach_is_active(cc.coach_id)) then 'active' else 'archived' end as status
        from public.coach_clients cc
        where (v_is_coach and cc.coach_id = v_me) or (not v_is_coach and cc.client_id = v_me)
      ) link
      left join public.profiles p on p.id = link.partner_id
      left join lateral (
        select m.message_text, m.created_at, m.sender_id
        from public.chat_messages m
        where (m.sender_id = v_me and m.receiver_id = link.partner_id) or (m.sender_id = link.partner_id and m.receiver_id = v_me)
        order by m.created_at desc, m.id desc
        limit 1
      ) last on true
      left join lateral (
        select count(*)::integer as n
        from public.chat_messages m
        where m.sender_id = link.partner_id and m.receiver_id = v_me and not m.is_read
      ) unread on true
      where link.status = 'active' or last.created_at is not null
    ) rows
  ), '[]'::jsonb);
end;
$$;

create or replace function public.get_chat_unread_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.chat_messages where receiver_id = auth.uid() and not is_read;
$$;

revoke all on function public.chat_can_message(uuid) from public, anon;
revoke all on function public.send_chat_message(uuid, text, uuid) from public, anon;
revoke all on function public.get_chat_messages(uuid, timestamptz, integer) from public, anon;
revoke all on function public.mark_chat_read(uuid) from public, anon;
revoke all on function public.get_chat_conversations() from public, anon;
revoke all on function public.get_chat_unread_count() from public, anon;
grant execute on function public.chat_can_message(uuid) to authenticated;
grant execute on function public.send_chat_message(uuid, text, uuid) to authenticated;
grant execute on function public.get_chat_messages(uuid, timestamptz, integer) to authenticated;
grant execute on function public.mark_chat_read(uuid) to authenticated;
grant execute on function public.get_chat_conversations() to authenticated;
grant execute on function public.get_chat_unread_count() to authenticated;

-- ===== 20261115001700_platform_ai_settings.sql =====

-- Which AI provider and model Jack uses is a decision for the platform owner, and it applies to everyone:
-- every coach, assistant trainer and client. There is one settings row for the whole platform.
-- Only the server can touch it (with the service role, after checking that the signed-in person is a platform
-- admin listed in PLATFORM_ADMIN_EMAILS). The app's roles (anon, authenticated) have no access at all and there
-- is no function they can call: coaches, trainers and clients cannot read, change or even detect the settings.
-- The credentials are encrypted by the server before they are stored.

-- Per-coach AI settings existed briefly; they are replaced by the platform setting.
drop function if exists public.service_get_ai_settings(uuid);
drop function if exists public.resolve_ai_owner(uuid);
drop function if exists public.record_my_ai_test(boolean);
drop function if exists public.clear_my_ai_settings();
drop function if exists public.save_my_ai_settings(text, text, text, text, text);
drop function if exists public.get_my_ai_settings();
drop function if exists public.ai_settings_guard();
drop table if exists public.coach_ai_settings;

create table if not exists public.platform_ai_settings (
  -- A single row: the primary key can only ever be true.
  id boolean primary key default true check (id),
  provider text not null check (provider in ('openai', 'gemini', 'bedrock', 'azure_foundry')),
  model text check (model is null or char_length(model) <= 200),
  region text check (region is null or char_length(region) <= 40),
  endpoint text check (endpoint is null or char_length(endpoint) <= 300),
  credentials_encrypted text not null check (char_length(credentials_encrypted) between 1 and 8000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  last_tested_at timestamptz,
  last_test_ok boolean
);

alter table public.platform_ai_settings enable row level security;

-- No policy for anon or authenticated: with row-level security on, that means no rows, ever.
drop policy if exists "Service role manages the platform AI settings" on public.platform_ai_settings;
create policy "Service role manages the platform AI settings"
  on public.platform_ai_settings for all
  to service_role
  using (true)
  with check (true);

revoke all on public.platform_ai_settings from public, anon, authenticated;
grant all on public.platform_ai_settings to service_role;

-- ===== 20261115001800_daily_checklist.sql =====

-- Daily checklist: workout, meals, water, habits and own tasks for each day, private to the client.

-- ---------------------------------------------------------------------------
-- Daily checklist
-- ---------------------------------------------------------------------------
-- A template is a task that repeats on chosen weekdays; an entry is one day's copy of it (or a one-off task).
-- Entries are created for a day the first time that day is opened. Everything is private to the client and is
-- written only through the functions below.

create table if not exists public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  category text not null check (category in ('workout', 'meal', 'water', 'habit', 'custom')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  target_amount numeric(10, 2) check (target_amount is null or (target_amount > 0 and target_amount <= 100000)),
  unit text check (unit is null or char_length(unit) <= 20),
  -- 0 = Sunday ... 6 = Saturday
  days_of_week smallint[] not null default '{0,1,2,3,4,5,6}'
    check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  remind_time time,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists checklist_templates_client_idx on public.checklist_templates (client_id) where is_active;

create table if not exists public.checklist_entries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  task_date date not null,
  template_id uuid references public.checklist_templates (id) on delete set null,
  category text not null check (category in ('workout', 'meal', 'water', 'habit', 'custom')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  target_amount numeric(10, 2) check (target_amount is null or (target_amount > 0 and target_amount <= 100000)),
  unit text check (unit is null or char_length(unit) <= 20),
  progress_amount numeric(10, 2) not null default 0 check (progress_amount >= 0 and progress_amount <= 100000),
  is_done boolean not null default false,
  done_at timestamptz,
  remind_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A repeating task has at most one entry per day, however many times the day is opened.
create unique index if not exists checklist_entries_template_day_idx
  on public.checklist_entries (client_id, task_date, template_id) where template_id is not null;
create index if not exists checklist_entries_day_idx on public.checklist_entries (client_id, task_date);

alter table public.checklist_templates enable row level security;
alter table public.checklist_entries enable row level security;

drop policy if exists "Clients read their checklist templates" on public.checklist_templates;
create policy "Clients read their checklist templates"
  on public.checklist_templates for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Clients read their checklist entries" on public.checklist_entries;
create policy "Clients read their checklist entries"
  on public.checklist_entries for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.checklist_templates, public.checklist_entries from public, anon, authenticated;
grant select on public.checklist_templates, public.checklist_entries to authenticated;
grant all on public.checklist_templates, public.checklist_entries to service_role;

-- One entry as the app sees it.
create or replace function public.checklist_entry_json(p_entry public.checklist_entries)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_entry.id,
    'task_date', p_entry.task_date,
    'template_id', p_entry.template_id,
    'category', p_entry.category,
    'title', p_entry.title,
    'target_amount', p_entry.target_amount,
    'unit', p_entry.unit,
    'progress_amount', p_entry.progress_amount,
    'is_done', p_entry.is_done,
    'done_at', p_entry.done_at,
    'remind_time', to_char(p_entry.remind_time, 'HH24:MI')
  );
$$;

-- Writes are allowed for yesterday, today and tomorrow, which covers every time zone.
create or replace function public.checklist_date_ok(p_date date, p_back integer default 1)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select p_date is not null and p_date between current_date - p_back and current_date + 1;
$$;

create or replace function public.checklist_require_client()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to use the checklist';
  end if;
end;
$$;

-- Creates the day's copies of the repeating tasks that apply to that weekday.
create or replace function public.checklist_materialize(p_client uuid, p_date date)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.checklist_entries (client_id, task_date, template_id, category, title, target_amount, unit, remind_time)
  select t.client_id, p_date, t.id, t.category, t.title, t.target_amount, t.unit, t.remind_time
  from public.checklist_templates t
  where t.client_id = p_client
    and t.is_active
    and extract(dow from p_date)::smallint = any (t.days_of_week)
  on conflict (client_id, task_date, template_id) where template_id is not null do nothing;
$$;

-- The checklist of one day. Opening today (or yesterday/tomorrow) creates that day's entries from the templates;
-- any other date only shows what was stored.
create or replace function public.get_my_checklist(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_items jsonb;
begin
  perform public.checklist_require_client();
  if p_date is null or p_date < current_date - 365 or p_date > current_date + 1 then
    raise exception 'Choose a date from the last year up to tomorrow';
  end if;
  if public.checklist_date_ok(p_date) then
    perform public.checklist_materialize(auth.uid(), p_date);
  end if;

  select coalesce(jsonb_agg(public.checklist_entry_json(e) order by
      case e.category when 'workout' then 1 when 'meal' then 2 when 'water' then 3 when 'habit' then 4 else 5 end,
      e.remind_time nulls last, e.created_at, e.id), '[]'::jsonb)
  into v_items
  from public.checklist_entries e
  where e.client_id = auth.uid() and e.task_date = p_date;

  return jsonb_build_object('date', p_date, 'server_today', current_date, 'editable', public.checklist_date_ok(p_date, 2), 'items', v_items);
end;
$$;

-- A new task: one-off for that day, or repeating on the chosen weekdays (a JSON array of 0-6, Sunday = 0).
create or replace function public.add_checklist_task(
  p_date date,
  p_category text,
  p_title text,
  p_target numeric default null,
  p_unit text default null,
  p_remind_time time default null,
  p_repeat_days jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_unit text := nullif(btrim(coalesce(p_unit, '')), '');
  v_days smallint[];
  v_template public.checklist_templates;
  v_entry public.checklist_entries;
begin
  perform public.checklist_require_client();
  if not public.checklist_date_ok(p_date) then
    raise exception 'Tasks can be added for yesterday, today or tomorrow';
  end if;
  if p_category is null or p_category not in ('workout', 'meal', 'water', 'habit', 'custom') then
    raise exception 'Choose a task type';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'The task needs a title of up to 120 characters';
  end if;
  if p_target is not null and (p_target <= 0 or p_target > 100000) then
    raise exception 'The target must be more than 0 and at most 100000';
  end if;
  if v_unit is not null and char_length(v_unit) > 20 then
    raise exception 'The unit can have up to 20 characters';
  end if;
  if p_repeat_days is not null then
    if jsonb_typeof(p_repeat_days) <> 'array' or jsonb_array_length(p_repeat_days) not between 1 and 7 then
      raise exception 'Choose the days the task repeats on';
    end if;
    begin
      select array_agg(distinct day::smallint order by day::smallint) into v_days
      from jsonb_array_elements_text(p_repeat_days) as day;
    exception when others then
      raise exception 'Choose the days the task repeats on';
    end;
    if exists (select 1 from unnest(v_days) as day where day not between 0 and 6) then
      raise exception 'Choose the days the task repeats on';
    end if;

    if (select count(*) from public.checklist_templates where client_id = auth.uid() and is_active) >= 50 then
      raise exception 'You can keep up to 50 repeating tasks';
    end if;
    insert into public.checklist_templates (client_id, category, title, target_amount, unit, days_of_week, remind_time)
    values (auth.uid(), p_category, v_title, p_target, v_unit, v_days, p_remind_time)
    returning * into v_template;

    perform public.checklist_materialize(auth.uid(), p_date);
    select * into v_entry from public.checklist_entries where client_id = auth.uid() and task_date = p_date and template_id = v_template.id;
    return jsonb_build_object('template_id', v_template.id, 'entry', case when v_entry.id is null then null else public.checklist_entry_json(v_entry) end);
  end if;

  if (select count(*) from public.checklist_entries where client_id = auth.uid() and task_date = p_date) >= 100 then
    raise exception 'A day can have up to 100 tasks';
  end if;
  insert into public.checklist_entries (client_id, task_date, category, title, target_amount, unit, remind_time)
  values (auth.uid(), p_date, p_category, v_title, p_target, v_unit, p_remind_time)
  returning * into v_entry;
  return jsonb_build_object('template_id', null, 'entry', public.checklist_entry_json(v_entry));
end;
$$;

-- Check or uncheck a task, or record progress (for example 250 ml of water). Reaching the target completes it.
create or replace function public.set_checklist_item(
  p_entry_id uuid,
  p_done boolean default null,
  p_progress numeric default null,
  p_add numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry public.checklist_entries;
  v_progress numeric;
  v_done boolean;
begin
  perform public.checklist_require_client();
  select * into v_entry from public.checklist_entries where id = p_entry_id and client_id = auth.uid() for update;
  if not found then
    raise exception 'That task was not found';
  end if;
  if not public.checklist_date_ok(v_entry.task_date, 2) then
    raise exception 'Only the last few days can still be changed';
  end if;
  if p_progress is not null and (p_progress < 0 or p_progress > 100000) then
    raise exception 'The amount must be between 0 and 100000';
  end if;
  if p_add is not null and (p_add < -100000 or p_add > 100000) then
    raise exception 'The amount must be between -100000 and 100000';
  end if;

  v_progress := v_entry.progress_amount;
  if p_progress is not null then
    v_progress := p_progress;
  elsif p_add is not null then
    v_progress := greatest(0, least(100000, v_progress + p_add));
  end if;

  if p_done is not null then
    v_done := p_done;
    if p_done and v_entry.target_amount is not null and v_progress < v_entry.target_amount then
      v_progress := v_entry.target_amount;
    elsif not p_done and v_entry.target_amount is not null and v_progress >= v_entry.target_amount then
      v_progress := 0;
    end if;
  elsif v_entry.target_amount is not null then
    v_done := v_progress >= v_entry.target_amount;
  else
    v_done := v_entry.is_done;
  end if;

  update public.checklist_entries
  set progress_amount = v_progress,
      is_done = v_done,
      done_at = case when v_done then coalesce(v_entry.done_at, statement_timestamp()) else null end,
      updated_at = statement_timestamp()
  where id = v_entry.id
  returning * into v_entry;
  return public.checklist_entry_json(v_entry);
end;
$$;

-- Sets (or clears) the time of a task. For a repeating task it applies from this day on and to the template.
create or replace function public.update_checklist_time(p_entry_id uuid, p_remind_time time)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry public.checklist_entries;
begin
  perform public.checklist_require_client();
  select * into v_entry from public.checklist_entries where id = p_entry_id and client_id = auth.uid() for update;
  if not found then
    raise exception 'That task was not found';
  end if;

  if v_entry.template_id is not null then
    update public.checklist_templates set remind_time = p_remind_time, updated_at = statement_timestamp()
    where id = v_entry.template_id and client_id = auth.uid();
    update public.checklist_entries set remind_time = p_remind_time, updated_at = statement_timestamp()
    where template_id = v_entry.template_id and client_id = auth.uid() and task_date >= v_entry.task_date;
  else
    update public.checklist_entries set remind_time = p_remind_time, updated_at = statement_timestamp()
    where id = v_entry.id;
  end if;
  select * into v_entry from public.checklist_entries where id = p_entry_id;
  return public.checklist_entry_json(v_entry);
end;
$$;

-- Removes a task. A repeating task is removed for good (its template and this day onward; earlier days stay as
-- history).
create or replace function public.delete_checklist_task(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry public.checklist_entries;
begin
  perform public.checklist_require_client();
  select * into v_entry from public.checklist_entries where id = p_entry_id and client_id = auth.uid() for update;
  if not found then
    raise exception 'That task was not found';
  end if;

  if v_entry.template_id is not null then
    delete from public.checklist_entries where template_id = v_entry.template_id and client_id = auth.uid() and task_date >= v_entry.task_date;
    delete from public.checklist_templates where id = v_entry.template_id and client_id = auth.uid();
  else
    delete from public.checklist_entries where id = v_entry.id;
  end if;
  return jsonb_build_object('entry_id', v_entry.id, 'template_id', v_entry.template_id);
end;
$$;

-- Done / total for each of the last days, ending on p_to.
create or replace function public.get_checklist_summary(p_to date, p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 7), 60));
begin
  perform public.checklist_require_client();
  if p_to is null or p_to < current_date - 365 or p_to > current_date + 1 then
    raise exception 'Choose a date from the last year up to tomorrow';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('date', d.day, 'total', coalesce(s.total, 0), 'done', coalesce(s.done, 0)) order by d.day)
    from (select generate_series(p_to - (v_days - 1), p_to, interval '1 day')::date as day) d
    left join (
      select task_date, count(*)::integer as total, count(*) filter (where is_done)::integer as done
      from public.checklist_entries
      where client_id = auth.uid() and task_date between p_to - (v_days - 1) and p_to
      group by task_date
    ) s on s.task_date = d.day
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.checklist_entry_json(public.checklist_entries) from public, anon;
revoke all on function public.checklist_date_ok(date, integer) from public, anon;
revoke all on function public.checklist_require_client() from public, anon, authenticated;
revoke all on function public.checklist_materialize(uuid, date) from public, anon, authenticated;
revoke all on function public.get_my_checklist(date) from public, anon;
revoke all on function public.add_checklist_task(date, text, text, numeric, text, time, jsonb) from public, anon;
revoke all on function public.set_checklist_item(uuid, boolean, numeric, numeric) from public, anon;
revoke all on function public.update_checklist_time(uuid, time) from public, anon;
revoke all on function public.delete_checklist_task(uuid) from public, anon;
revoke all on function public.get_checklist_summary(date, integer) from public, anon;
grant execute on function public.checklist_entry_json(public.checklist_entries) to authenticated;
grant execute on function public.checklist_date_ok(date, integer) to authenticated;
grant execute on function public.get_my_checklist(date) to authenticated;
grant execute on function public.add_checklist_task(date, text, text, numeric, text, time, jsonb) to authenticated;
grant execute on function public.set_checklist_item(uuid, boolean, numeric, numeric) to authenticated;
grant execute on function public.update_checklist_time(uuid, time) to authenticated;
grant execute on function public.delete_checklist_task(uuid) to authenticated;
grant execute on function public.get_checklist_summary(date, integer) to authenticated;

-- ===== 20261115001900_remove_external_integrations.sql =====

-- ApexFit no longer connects to outside accounts that need developer approval: Google Calendar and the Fitbit,
-- Garmin and Oura cloud APIs are gone. Smart-device data comes from Apple Health files and quick entries, and
-- tasks live in the in-app checklist.
--
-- The migrations that used to create those pieces no longer do, so a new project never has them. This one cleans
-- up a project that already had them. It is safe to run again, and on a new project it changes nothing.

-- ---------------------------------------------------------------------------
-- Google Calendar
-- ---------------------------------------------------------------------------
-- The stored calendar connections (including their encrypted tokens) are deleted with the table.

drop function if exists public.get_my_google_calendar_status();
drop function if exists public.get_my_calendar_connection();
drop table if exists public.google_calendar_connections;
drop table if exists public.platform_integration_settings;

alter table public.coach_sessions drop column if exists google_event_id;
alter table public.coach_sessions drop column if exists google_synced_at;

-- The checklist keeps its tasks and times, but has no calendar choice any more.
drop function if exists public.add_checklist_task(date, text, text, numeric, text, time, jsonb, boolean);
drop function if exists public.update_checklist_calendar(uuid, time, boolean);
alter table public.checklist_templates drop column if exists calendar_sync;
alter table public.checklist_entries drop column if exists calendar_sync;

-- ---------------------------------------------------------------------------
-- Fitbit, Garmin and Oura
-- ---------------------------------------------------------------------------
-- Their connections (which held encrypted tokens) and the numbers they delivered are removed. Apple Health and
-- manually entered numbers are untouched.

delete from public.wearable_daily_metrics where provider in ('fitbit', 'garmin', 'oura');
delete from public.wearable_connections where provider in ('fitbit', 'garmin', 'oura');

drop function if exists public.service_save_wearable_metrics(uuid, text, jsonb);
drop function if exists public.wearable_metrics_upsert(uuid, text, jsonb, boolean);

do $$
declare
  v_name text;
  v_changed boolean := false;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.wearable_daily_metrics'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%fitbit%'
  loop
    execute format('alter table public.wearable_daily_metrics drop constraint %I', v_name);
    v_changed := true;
  end loop;
  if v_changed then
    alter table public.wearable_daily_metrics add constraint wearable_daily_metrics_provider_check check (provider in ('apple_health', 'manual'));
  end if;

  v_changed := false;
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.wearable_connections'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%fitbit%'
  loop
    execute format('alter table public.wearable_connections drop constraint %I', v_name);
    v_changed := true;
  end loop;
  if v_changed then
    alter table public.wearable_connections add constraint wearable_connections_provider_check check (provider = 'apple_health');
  end if;
end
$$;

alter table public.wearable_connections drop column if exists access_token_encrypted;
alter table public.wearable_connections drop column if exists refresh_token_encrypted;
alter table public.wearable_connections drop column if exists token_expires_at;
alter table public.wearable_connections drop column if exists external_user_id;
alter table public.wearable_daily_metrics drop column if exists raw_payload;

-- ===== 20261115002000_accountability_reports_jack_history.sql =====

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

-- ===== 20261115002100_exercise_translations.sql =====

-- Exercise library in several languages: translated names and steps, and a search that understands them all.

alter table public.exercises add column if not exists name_i18n jsonb not null default '{}'::jsonb;
alter table public.exercises add column if not exists instructions_i18n jsonb not null default '{}'::jsonb;
alter table public.exercises add column if not exists search_text text not null default '';

alter table public.exercises drop constraint if exists exercises_name_i18n_check;
alter table public.exercises add constraint exercises_name_i18n_check
  check (jsonb_typeof(name_i18n) = 'object' and pg_column_size(name_i18n) <= 4000);
alter table public.exercises drop constraint if exists exercises_instructions_i18n_check;
alter table public.exercises add constraint exercises_instructions_i18n_check
  check (jsonb_typeof(instructions_i18n) = 'object' and pg_column_size(instructions_i18n) <= 200000);

-- Text for searching: lower case, no accents, Arabic letters unified (alef forms, ya, ta marbuta), Arabic
-- diacritics and the leading "al-" removed, and punctuation turned into spaces. The browser applies the same
-- rules to what the user types (normalizeSearchText in src/services/exerciseI18n.js), so "push up", "Push-Up",
-- "ضغط" and "الضغط" all find the same exercise.
create or replace function public.normalize_search_text(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          translate(
            lower(coalesce(p_text, '')),
            'àâäáãåçéèêëíìîïñóòôöõúùûüýÿßÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ' || U&'\0623\0625\0622\0671\0649\0629',
            'aaaaaaceeeeiiiinooooouuuuyysaaaaaaceeeeiiiinooooouuuuy' || U&'\0627\0627\0627\0627\064A\0647'
          ),
          U&'[\064B-\0652\0640\0670]', '', 'g'
        ),
        '[-/_,.()''"+&:;!?%\\*]+', ' ', 'g'
      ),
      U&'(^| )\0627\0644(?=[^ ]{2})', '\1', 'g'
    ),
    '\s+', ' ', 'g'
  ));
$$;

create or replace function public.exercises_set_search_text()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.search_text := public.normalize_search_text(
    new.name || ' ' || case when jsonb_typeof(new.name_i18n) = 'object' then coalesce((select string_agg(value, ' ') from jsonb_each_text(new.name_i18n)), '') else '' end
  );
  return new;
end;
$$;

drop trigger if exists exercises_search_text on public.exercises;
create trigger exercises_search_text
  before insert or update of name, name_i18n on public.exercises
  for each row execute function public.exercises_set_search_text();

-- Exercises that were imported before this migration get their search text now.
update public.exercises set name = name where search_text = '';

revoke all on function public.normalize_search_text(text) from public, anon, authenticated;
grant execute on function public.normalize_search_text(text) to authenticated, anon, service_role;

-- ===== 20261115002200_exercise_animations.sql =====

-- Short looping demos for exercises: an animation (GIF, MP4 or WebM) and the still frames of the movement.
-- thumbnail_url stays as the poster image shown while the animation loads, on slow connections and if it fails.

alter table public.exercises add column if not exists animation_url text;
alter table public.exercises add column if not exists image_frames text[] not null default '{}';

alter table public.exercises drop constraint if exists exercises_animation_url_check;
alter table public.exercises add constraint exercises_animation_url_check
  check (
    animation_url is null
    or (
      char_length(animation_url) <= 2000
      and animation_url ~* '^https://[^/@[:space:]]+/[^?#[:space:]]*\.(gif|mp4|webm|webp)(\?[^[:space:]]*)?$'
    )
  );

-- Check constraints cannot contain subqueries, so the frame list is checked by a small function.
create or replace function public.exercise_frames_valid(p_frames text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_frames is not null
    and cardinality(p_frames) <= 4
    and coalesce((select bool_and(frame ~* '^https://[^/@[:space:]]+/[^[:space:]]+$' and char_length(frame) <= 2000) from unnest(p_frames) as frame), true);
$$;

alter table public.exercises drop constraint if exists exercises_image_frames_check;
alter table public.exercises add constraint exercises_image_frames_check check (public.exercise_frames_valid(image_frames));

revoke all on function public.exercise_frames_valid(text[]) from public, anon, authenticated;
grant execute on function public.exercise_frames_valid(text[]) to service_role;

-- ===== 20261115002300_paddle_subscriptions.sql =====

-- Coach subscriptions that do not depend on a payment gateway.
--
-- public.coach_subscriptions (created in the first migration) holds one row per coach with the gateway named in
-- `provider` (Paddle today). Gateways report what happened through apply_subscription_event(), which only the server
-- (service role) can call; the app reads the result and never trusts anything the browser says about billing.

alter table public.coach_subscriptions add column if not exists plan text not null default 'coach_monthly';
alter table public.coach_subscriptions add column if not exists price_id text;
alter table public.coach_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.coach_subscriptions add column if not exists started_at timestamptz;
alter table public.coach_subscriptions add column if not exists canceled_at timestamptz;
alter table public.coach_subscriptions add column if not exists last_event_at timestamptz;
alter table public.coach_subscriptions add column if not exists created_at timestamptz not null default now();

alter table public.coach_subscriptions drop constraint if exists coach_subscriptions_status_check;
alter table public.coach_subscriptions add constraint coach_subscriptions_status_check
  check (status in ('active', 'past_due', 'paused', 'canceled'));
alter table public.coach_subscriptions drop constraint if exists coach_subscriptions_plan_check;
alter table public.coach_subscriptions add constraint coach_subscriptions_plan_check
  check (char_length(plan) between 1 and 60);
alter table public.coach_subscriptions drop constraint if exists coach_subscriptions_provider_check;
alter table public.coach_subscriptions add constraint coach_subscriptions_provider_check
  check (provider ~ '^[a-z][a-z0-9_]{1,29}$');

create index if not exists coach_subscriptions_customer_idx
  on public.coach_subscriptions (provider, provider_customer_id) where provider_customer_id is not null;

-- Every message a gateway sent us, once. The event id makes a retried or duplicated message harmless.
create table if not exists public.billing_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  user_id uuid references public.profiles (id) on delete set null,
  provider_subscription_id text,
  outcome text not null default 'received',
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create index if not exists billing_events_user_idx on public.billing_events (user_id, received_at desc);

alter table public.billing_events enable row level security;
revoke all on public.billing_events from public, anon, authenticated;
grant all on public.billing_events to service_role;

-- Does this subscription give access right now? A paid or past-due subscription keeps working for 3 days after its
-- period ends, so a renewal message that arrives late never locks a paying coach out.
create or replace function public.subscription_grants_access(p_status text, p_period_end timestamptz)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_status = 'active' then p_period_end is null or p_period_end + interval '3 days' > statement_timestamp()
    when p_status = 'past_due' then p_period_end is not null and p_period_end + interval '3 days' > statement_timestamp()
    else false
  end;
$$;

revoke all on function public.subscription_grants_access(text, timestamptz) from public, anon;
grant execute on function public.subscription_grants_access(text, timestamptz) to authenticated, service_role;

-- A coach's access: the subscription when it is in force, otherwise the 72-hour trial (same rules as before, with the
-- subscription's end date now respected).
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
      and (
        (s.user_id is not null and public.subscription_grants_access(s.status, s.current_period_end))
        or p.trial_ends_at > statement_timestamp()
      )
  );
$$;

create or replace function public.get_my_access_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_subscription public.coach_subscriptions%rowtype;
  v_has_subscription boolean := false;
  v_paid boolean := false;
  v_access_state text;
  v_team public.coach_team_members%rowtype;
  v_has_team boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  select * into v_subscription from public.coach_subscriptions where user_id = v_profile.id;
  v_has_subscription := found;
  v_paid := v_has_subscription and public.subscription_grants_access(v_subscription.status, v_subscription.current_period_end);

  if v_profile.role = 'coach' then
    select * into v_team from public.coach_team_members where trainer_user_id = v_profile.id and status = 'active' limit 1;
    v_has_team := found;
  end if;

  if v_profile.role = 'client' then
    v_access_state := 'client';
  elsif v_has_team then
    v_access_state := 'trainer';
  elsif v_paid then
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
    'full_name', v_profile.full_name,
    'brand_name', v_profile.brand_name,
    'avatar_path', v_profile.avatar_path,
    'trial_started_at', v_profile.trial_started_at,
    'trial_ends_at', v_profile.trial_ends_at,
    'subscription_status', coalesce(
      case when v_has_subscription then v_subscription.status end,
      case when v_profile.role = 'coach' and v_profile.trial_ends_at > statement_timestamp() then 'trialing' else 'none' end
    ),
    'access_state', v_access_state,
    'team', case when v_has_team then jsonb_build_object(
      'member_id', v_team.id,
      'head_coach_id', v_team.head_coach_id,
      'role_title', v_team.role_title,
      'permissions', v_team.permissions,
      'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = v_team.head_coach_id),
      'head_active', public.workflow_coach_is_active(v_team.head_coach_id)
    ) else null end
  );
end;
$$;

-- What the billing page shows: the coach's own subscription, without gateway identifiers.
create or replace function public.get_my_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_subscription public.coach_subscriptions%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required';
  end if;
  select * into v_subscription from public.coach_subscriptions where user_id = auth.uid();
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'provider', v_subscription.provider,
    'plan', v_subscription.plan,
    'status', v_subscription.status,
    'current_period_end', v_subscription.current_period_end,
    'cancel_at_period_end', v_subscription.cancel_at_period_end,
    'started_at', v_subscription.started_at,
    'canceled_at', v_subscription.canceled_at,
    'grants_access', public.subscription_grants_access(v_subscription.status, v_subscription.current_period_end),
    'can_manage', v_subscription.provider_customer_id is not null
  );
end;
$$;

-- Applies one gateway event to the coach it belongs to. Server only.
--   duplicate     this event id was already handled
--   unknown_user  a first message for a subscription we cannot tie to a coach (nothing is created)
--   conflict      the coach already has a different live subscription; the new one is left alone
--   stale         an older message arriving after a newer one
--   applied       the subscription row now reflects the event
create or replace function public.apply_subscription_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_user_id uuid,
  p_subscription_id text,
  p_customer_id text,
  p_status text,
  p_plan text,
  p_price_id text,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_started_at timestamptz,
  p_canceled_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_subscriptions%rowtype;
  v_found boolean;
  v_user uuid;
  v_outcome text;
  v_inserted integer;
begin
  if p_status not in ('active', 'past_due', 'paused', 'canceled') then
    raise exception 'Unsupported subscription status %', p_status using errcode = '22023';
  end if;
  if coalesce(p_provider, '') = '' or coalesce(p_event_id, '') = '' or coalesce(p_subscription_id, '') = '' then
    raise exception 'The event needs a provider, an event id and a subscription id' using errcode = '22023';
  end if;

  insert into public.billing_events (provider, event_id, event_type, occurred_at, provider_subscription_id)
  values (p_provider, p_event_id, p_event_type, p_occurred_at, p_subscription_id)
  on conflict (provider, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select * into v_row from public.coach_subscriptions
  where provider = p_provider and provider_subscription_id = p_subscription_id for update;
  v_found := found;

  if v_found then
    v_user := v_row.user_id;
  else
    -- First message about this subscription: the coach comes from the id the server attached when it created the
    -- checkout, and must be a real coach account.
    if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id and role = 'coach') then
      update public.billing_events set outcome = 'unknown_user' where provider = p_provider and event_id = p_event_id;
      return jsonb_build_object('outcome', 'unknown_user');
    end if;
    v_user := p_user_id;
    select * into v_row from public.coach_subscriptions where user_id = v_user for update;
    v_found := found;
    if v_found
      and v_row.provider_subscription_id is distinct from p_subscription_id
      and public.subscription_grants_access(v_row.status, v_row.current_period_end) then
      update public.billing_events set outcome = 'conflict', user_id = v_user where provider = p_provider and event_id = p_event_id;
      return jsonb_build_object('outcome', 'conflict');
    end if;
  end if;

  if v_found and v_row.provider_subscription_id = p_subscription_id and v_row.last_event_at is not null and p_occurred_at < v_row.last_event_at then
    update public.billing_events set outcome = 'stale', user_id = v_user where provider = p_provider and event_id = p_event_id;
    return jsonb_build_object('outcome', 'stale');
  end if;

  insert into public.coach_subscriptions (
    user_id, status, provider, provider_customer_id, provider_subscription_id, plan, price_id,
    current_period_end, cancel_at_period_end, started_at, canceled_at, last_event_at, updated_at
  )
  values (
    v_user, p_status, p_provider, p_customer_id, p_subscription_id, coalesce(nullif(p_plan, ''), 'coach_monthly'), p_price_id,
    p_period_end, coalesce(p_cancel_at_period_end, false), p_started_at, p_canceled_at, p_occurred_at, now()
  )
  on conflict (user_id) do update set
    status = excluded.status,
    provider = excluded.provider,
    provider_customer_id = coalesce(excluded.provider_customer_id, public.coach_subscriptions.provider_customer_id),
    provider_subscription_id = excluded.provider_subscription_id,
    plan = excluded.plan,
    price_id = coalesce(excluded.price_id, public.coach_subscriptions.price_id),
    current_period_end = coalesce(excluded.current_period_end, public.coach_subscriptions.current_period_end),
    cancel_at_period_end = excluded.cancel_at_period_end,
    started_at = coalesce(excluded.started_at, public.coach_subscriptions.started_at),
    canceled_at = case when excluded.status = 'canceled' then coalesce(excluded.canceled_at, public.coach_subscriptions.canceled_at, excluded.last_event_at) else null end,
    last_event_at = excluded.last_event_at,
    updated_at = now();

  v_outcome := 'applied';
  update public.billing_events set outcome = v_outcome, user_id = v_user where provider = p_provider and event_id = p_event_id;
  return jsonb_build_object('outcome', v_outcome, 'user_id', v_user);
end;
$$;

revoke all on function public.get_my_subscription() from public, anon;
grant execute on function public.get_my_subscription() to authenticated;
revoke all on function public.apply_subscription_event(text, text, text, timestamptz, uuid, text, text, text, text, text, timestamptz, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_subscription_event(text, text, text, timestamptz, uuid, text, text, text, text, text, timestamptz, boolean, timestamptz, timestamptz) to service_role;
revoke all on function public.get_my_access_status() from public, anon;
grant execute on function public.get_my_access_status() to authenticated;

-- The server (service role) must be able to read and write every table, as Supabase's own defaults used to grant.
-- Projects created recently do not grant it automatically, which showed up as "permission denied for table
-- coach_subscriptions" (code 42501) when the billing endpoint looked up a coach's subscription.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- ===== 20261115002400_manual_invoice_payments.sql =====

-- Clients pay their coach directly: by bank transfer (IBAN or a local account) or by a method the coach and the client
-- agree on (a wallet, a payment link, cash...). ApexFit does not hold this money and needs no payment provider for it.
-- The coach states how to pay, the client says "I paid", and the coach confirms; confirming a package invoice gives the
-- client their sessions, exactly as an online payment used to.

-- ---------------------------------------------------------------------------
-- IBAN check (ISO 13616): shape and the mod-97 checksum. Kept identical to src/services/paymentMethodsUtils.js.
-- ---------------------------------------------------------------------------
create or replace function public.normalize_iban(p_iban text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(upper(regexp_replace(coalesce(p_iban, ''), '[[:space:]-]', '', 'g')), '');
$$;

create or replace function public.iban_is_valid(p_iban text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_iban text := public.normalize_iban(p_iban);
  v_moved text;
  v_char text;
  v_rest integer := 0;
  v_index integer;
begin
  if v_iban is null or v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' then
    return false;
  end if;
  v_moved := substr(v_iban, 5) || substr(v_iban, 1, 4);
  for v_index in 1..char_length(v_moved) loop
    v_char := substr(v_moved, v_index, 1);
    if v_char ~ '[0-9]' then
      v_rest := (v_rest * 10 + v_char::integer) % 97;
    else
      v_rest := (v_rest * 100 + (ascii(v_char) - 55)) % 97;
    end if;
  end loop;
  return v_rest = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- How a coach gets paid
-- ---------------------------------------------------------------------------
create table if not exists public.coach_payment_methods (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  bank_enabled boolean not null default false,
  account_holder text check (account_holder is null or char_length(account_holder) between 2 and 120),
  bank_name text check (bank_name is null or char_length(bank_name) <= 120),
  iban text check (iban is null or public.iban_is_valid(iban)),
  swift_bic text check (swift_bic is null or swift_bic ~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  account_number text check (account_number is null or char_length(account_number) between 3 and 60),
  custom_enabled boolean not null default false,
  custom_label text check (custom_label is null or char_length(custom_label) between 2 and 60),
  custom_instructions text check (custom_instructions is null or char_length(custom_instructions) between 3 and 1000),
  payment_note text check (payment_note is null or char_length(payment_note) <= 500),
  updated_at timestamptz not null default now(),
  constraint bank_details_complete check (not bank_enabled or (account_holder is not null and (iban is not null or account_number is not null))),
  constraint custom_method_complete check (not custom_enabled or (custom_label is not null and custom_instructions is not null))
);

alter table public.coach_payment_methods enable row level security;

drop policy if exists "Coaches read their payment methods" on public.coach_payment_methods;
create policy "Coaches read their payment methods"
  on public.coach_payment_methods for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.coach_payment_methods from public, anon, authenticated;
grant select on public.coach_payment_methods to authenticated;
grant all on public.coach_payment_methods to service_role;

-- What the coach sees and what a client of that coach sees: the same object.
create or replace function public.payment_methods_json(p_row public.coach_payment_methods)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'bank', case when p_row.bank_enabled then jsonb_build_object(
      'account_holder', p_row.account_holder,
      'bank_name', p_row.bank_name,
      'iban', p_row.iban,
      'swift_bic', p_row.swift_bic,
      'account_number', p_row.account_number
    ) else null end,
    'custom', case when p_row.custom_enabled then jsonb_build_object(
      'label', p_row.custom_label,
      'instructions', p_row.custom_instructions
    ) else null end,
    'note', p_row.payment_note
  );
$$;

revoke all on function public.payment_methods_json(public.coach_payment_methods) from public, anon, authenticated;

create or replace function public.save_payment_methods(
  p_bank_enabled boolean,
  p_account_holder text,
  p_bank_name text,
  p_iban text,
  p_swift_bic text,
  p_account_number text,
  p_custom_enabled boolean,
  p_custom_label text,
  p_custom_instructions text,
  p_payment_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_iban text := public.normalize_iban(p_iban);
  v_swift text := nullif(upper(regexp_replace(coalesce(p_swift_bic, ''), '[[:space:]]', '', 'g')), '');
  v_row public.coach_payment_methods;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if v_iban is not null and not public.iban_is_valid(v_iban) then
    raise exception 'That IBAN is not valid. Check the digits and letters.' using errcode = '22023';
  end if;
  if v_swift is not null and v_swift !~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
    raise exception 'That SWIFT/BIC code is not valid.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_account_holder, ''))) > 120 or char_length(btrim(coalesce(p_bank_name, ''))) > 120
    or (nullif(btrim(p_account_holder), '') is not null and char_length(btrim(p_account_holder)) < 2) then
    raise exception 'The account holder and bank name must be 2 to 120 characters.' using errcode = '22023';
  end if;
  if nullif(btrim(p_account_number), '') is not null and char_length(btrim(p_account_number)) not between 3 and 60 then
    raise exception 'The account number must be 3 to 60 characters.' using errcode = '22023';
  end if;
  if nullif(btrim(p_custom_label), '') is not null and char_length(btrim(p_custom_label)) not between 2 and 60 then
    raise exception 'The method name must be 2 to 60 characters.' using errcode = '22023';
  end if;
  if nullif(btrim(p_custom_instructions), '') is not null and char_length(btrim(p_custom_instructions)) not between 3 and 1000 then
    raise exception 'The payment instructions must be 3 to 1000 characters.' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_payment_note, ''))) > 500 then
    raise exception 'The note can be up to 500 characters.' using errcode = '22023';
  end if;
  if coalesce(p_bank_enabled, false)
    and (nullif(btrim(p_account_holder), '') is null or (v_iban is null and nullif(btrim(p_account_number), '') is null)) then
    raise exception 'Bank transfer needs the account holder and an IBAN or an account number.' using errcode = '22023';
  end if;
  if coalesce(p_custom_enabled, false)
    and (nullif(btrim(p_custom_label), '') is null or nullif(btrim(p_custom_instructions), '') is null) then
    raise exception 'A custom payment method needs a name and instructions.' using errcode = '22023';
  end if;

  insert into public.coach_payment_methods (
    coach_id, bank_enabled, account_holder, bank_name, iban, swift_bic, account_number,
    custom_enabled, custom_label, custom_instructions, payment_note, updated_at
  )
  values (
    auth.uid(), coalesce(p_bank_enabled, false), nullif(btrim(p_account_holder), ''), nullif(btrim(p_bank_name), ''), v_iban, v_swift,
    nullif(btrim(p_account_number), ''), coalesce(p_custom_enabled, false), nullif(btrim(p_custom_label), ''),
    nullif(btrim(p_custom_instructions), ''), nullif(btrim(p_payment_note), ''), now()
  )
  on conflict (coach_id) do update set
    bank_enabled = excluded.bank_enabled,
    account_holder = excluded.account_holder,
    bank_name = excluded.bank_name,
    iban = excluded.iban,
    swift_bic = excluded.swift_bic,
    account_number = excluded.account_number,
    custom_enabled = excluded.custom_enabled,
    custom_label = excluded.custom_label,
    custom_instructions = excluded.custom_instructions,
    payment_note = excluded.payment_note,
    updated_at = now()
  returning * into v_row;

  return public.payment_methods_json(v_row);
end;
$$;

create or replace function public.get_my_payment_methods()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_payment_methods;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  select * into v_row from public.coach_payment_methods where coach_id = auth.uid();
  if not found then
    return null;
  end if;
  return public.payment_methods_json(v_row) || jsonb_build_object('form', jsonb_build_object(
    'bank_enabled', v_row.bank_enabled, 'custom_enabled', v_row.custom_enabled
  ));
end;
$$;

-- A client reads how to pay their own coach (nobody else's), and only while they are that coach's active client.
create or replace function public.get_coach_payment_info(p_coach_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_payment_methods;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.coach_clients cc
    where cc.coach_id = p_coach_id and cc.client_id = auth.uid() and cc.status = 'active'
  ) then
    raise exception 'This coach is not available' using errcode = '42501';
  end if;
  select * into v_row from public.coach_payment_methods where coach_id = p_coach_id;
  if not found or not (v_row.bank_enabled or v_row.custom_enabled) then
    return jsonb_build_object('bank', null, 'custom', null, 'note', null);
  end if;
  return public.payment_methods_json(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoices paid outside the app
-- ---------------------------------------------------------------------------
alter table public.invoices add column if not exists payment_reported_at timestamptz;
alter table public.invoices add column if not exists paid_method text;
alter table public.invoices add column if not exists payment_reference text;

alter table public.invoices drop constraint if exists invoices_paid_method_check;
alter table public.invoices add constraint invoices_paid_method_check
  check (paid_method is null or paid_method in ('bank_transfer', 'custom', 'cash', 'other', 'card'));
alter table public.invoices drop constraint if exists invoices_payment_reference_check;
alter table public.invoices add constraint invoices_payment_reference_check
  check (payment_reference is null or char_length(payment_reference) <= 120);

-- The client tells the coach they have paid. The invoice stays open until the coach confirms.
create or replace function public.report_invoice_payment(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  update public.invoices
  set payment_reported_at = coalesce(payment_reported_at, now())
  where id = p_invoice_id and client_id = auth.uid() and status = 'open';
  if not found then
    raise exception 'Only your own open invoices can be reported as paid' using errcode = '42501';
  end if;
end;
$$;

-- The coach confirms that the money arrived. A package invoice then gives the client their sessions.
create or replace function public.confirm_invoice_payment(p_invoice_id uuid, p_method text, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
  v_reference text := nullif(btrim(p_reference), '');
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if p_method not in ('bank_transfer', 'custom', 'cash', 'other') then
    raise exception 'Choose how the invoice was paid' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 120 then
    raise exception 'The payment reference is too long' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if v_invoice.status <> 'open' then
    raise exception 'Only open invoices can be confirmed as paid' using errcode = '22023';
  end if;

  update public.invoices
  set status = 'paid', paid_at = statement_timestamp(), paid_method = p_method, payment_reference = v_reference
  where id = v_invoice.id;

  if v_invoice.sessions_included is not null then
    insert into public.client_package_credits (invoice_id, coach_id, client_id, package_name, sessions_total, sessions_remaining)
    values (v_invoice.id, v_invoice.coach_id, v_invoice.client_id, v_invoice.description, v_invoice.sessions_included, v_invoice.sessions_included)
    on conflict (invoice_id) do nothing;
  end if;
  return jsonb_build_object('status', 'paid', 'credits_added', v_invoice.sessions_included);
end;
$$;

revoke all on function public.normalize_iban(text) from public, anon;
revoke all on function public.iban_is_valid(text) from public, anon;
grant execute on function public.normalize_iban(text) to authenticated, service_role;
grant execute on function public.iban_is_valid(text) to authenticated, service_role;
revoke all on function public.save_payment_methods(boolean, text, text, text, text, text, boolean, text, text, text) from public, anon;
revoke all on function public.get_my_payment_methods() from public, anon;
revoke all on function public.get_coach_payment_info(uuid) from public, anon;
revoke all on function public.report_invoice_payment(uuid) from public, anon;
revoke all on function public.confirm_invoice_payment(uuid, text, text) from public, anon;
grant execute on function public.save_payment_methods(boolean, text, text, text, text, text, boolean, text, text, text) to authenticated;
grant execute on function public.get_my_payment_methods() to authenticated;
grant execute on function public.get_coach_payment_info(uuid) to authenticated;
grant execute on function public.report_invoice_payment(uuid) to authenticated;
grant execute on function public.confirm_invoice_payment(uuid, text, text) to authenticated;

-- ===== 20261115002500_store_direct_payments.sql =====

-- Program store: clients pay the coach directly (bank transfer or a method they agree on), say "I have paid", and the
-- coach confirms; confirming delivers the program. Same flow as invoices (migration 2400) and no payment provider.
-- This migration also removes everything that was left of Stripe.

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
alter table public.store_orders add column if not exists payment_reported_at timestamptz;
alter table public.store_orders add column if not exists paid_method text;
alter table public.store_orders add column if not exists payment_reference text;

alter table public.store_orders drop constraint if exists store_orders_payment_mode_check;
alter table public.store_orders drop constraint if exists store_orders_paid_method_check;
alter table public.store_orders drop constraint if exists store_orders_payment_reference_check;

-- Orders that were paid online or in test mode stay paid and keep their access; they are now simply "manual" payments.
update public.store_orders
set paid_method = case when payment_mode = 'stripe' then 'card' else 'other' end,
    payment_mode = 'manual'
where payment_mode in ('stripe', 'demo');

alter table public.store_orders alter column payment_mode set default 'manual';
alter table public.store_orders add constraint store_orders_payment_mode_check check (payment_mode in ('manual', 'free'));
alter table public.store_orders add constraint store_orders_paid_method_check
  check (paid_method is null or paid_method in ('bank_transfer', 'custom', 'cash', 'other', 'card'));
alter table public.store_orders add constraint store_orders_payment_reference_check
  check (payment_reference is null or char_length(payment_reference) <= 120);

alter table public.store_orders drop column if exists stripe_session_id;
alter table public.store_orders drop column if exists stripe_payment_intent_id;

-- ---------------------------------------------------------------------------
-- Delivery (internal) and the purchase steps
-- ---------------------------------------------------------------------------
-- The old functions were written for the payment webhook; they go.
drop function if exists public.complete_store_order(uuid, text, integer, text, text, text);
drop function if exists public.finish_store_order(uuid, text, text, text);

-- Marks an order as paid and gives the buyer the program. Safe to call twice for the same order. Internal: called only
-- by the functions below.
create or replace function public.deliver_store_order(p_order_id uuid, p_mode text, p_method text, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_assignment jsonb;
  v_note text;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order was not found';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'status', 'paid', 'already_paid', true, 'assignment_id', v_order.assignment_id);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'This order can no longer be completed';
  end if;

  begin
    v_assignment := public.assign_program_core(v_order.coach_id, v_order.buyer_client_id, v_order.program_template_id);
  exception when others then
    v_assignment := null;
    v_note := left('Program was not delivered: ' || sqlerrm, 300);
  end;

  update public.store_orders
  set status = 'paid',
      payment_mode = p_mode,
      paid_method = p_method,
      payment_reference = p_reference,
      assignment_id = (v_assignment ->> 'assignment_id')::uuid,
      note = v_note,
      purchased_at = statement_timestamp()
  where id = p_order_id;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', 'paid', 'already_paid', false,
    'assignment_id', v_assignment ->> 'assignment_id', 'delivered', v_assignment is not null
  );
end;
$$;

-- Starts (or resumes) a purchase for the signed-in client. Free products are delivered on the spot; a paid product
-- becomes an open order that waits for the client to pay the coach and the coach to confirm.
create or replace function public.begin_store_purchase(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.store_products%rowtype;
  v_order public.store_orders%rowtype;
  v_done jsonb;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to buy programs';
  end if;

  select * into v_product from public.store_products where id = p_product_id;
  if not found or not v_product.is_published or not exists (
    select 1 from public.coach_clients where coach_id = v_product.coach_id and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'This product is not available';
  end if;
  if not public.workflow_coach_is_active(v_product.coach_id) then
    raise exception 'This store is not accepting orders right now';
  end if;

  select * into v_order from public.store_orders
  where product_id = p_product_id and buyer_client_id = auth.uid() and status in ('pending', 'paid')
  for update;

  if found and v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'already_owned', true, 'completed', true);
  end if;

  if not found then
    insert into public.store_orders (product_id, buyer_client_id, coach_id, product_title, program_template_id, amount_cents, currency, payment_mode)
    values (p_product_id, auth.uid(), v_product.coach_id, v_product.title, v_product.program_template_id,
            v_product.price_cents, v_product.currency, case when v_product.price_cents = 0 then 'free' else 'manual' end)
    returning * into v_order;
  else
    -- The coach may have changed the price since the order was opened; a payment reported at the old price no longer counts.
    update public.store_orders
    set product_title = v_product.title, program_template_id = v_product.program_template_id,
        payment_reported_at = case
          when amount_cents <> v_product.price_cents or currency <> v_product.currency then null
          else payment_reported_at end,
        amount_cents = v_product.price_cents, currency = v_product.currency,
        payment_mode = case when v_product.price_cents = 0 then 'free' else 'manual' end
    where id = v_order.id
    returning * into v_order;
  end if;

  if v_order.amount_cents = 0 then
    v_done := public.deliver_store_order(v_order.id, 'free', null, null);
    return jsonb_build_object('order_id', v_order.id, 'already_owned', false, 'completed', true, 'assignment_id', v_done ->> 'assignment_id');
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'already_owned', false, 'completed', false,
    'amount_cents', v_order.amount_cents, 'currency', v_order.currency,
    'title', v_order.product_title, 'coach_id', v_order.coach_id,
    'payment_reported', v_order.payment_reported_at is not null
  );
end;
$$;

-- The client says they have paid. The order stays open until the coach confirms.
create or replace function public.report_store_payment(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  update public.store_orders
  set payment_reported_at = coalesce(payment_reported_at, now())
  where id = p_order_id and buyer_client_id = auth.uid() and status = 'pending' and amount_cents > 0;
  if not found then
    raise exception 'Only your own open orders can be reported as paid' using errcode = '42501';
  end if;
end;
$$;

-- The coach confirms that the money arrived (or hands the program over by hand); the buyer gets the program.
create or replace function public.confirm_store_payment(p_order_id uuid, p_method text, p_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reference text := nullif(btrim(p_reference), '');
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if p_method not in ('bank_transfer', 'custom', 'cash', 'other') then
    raise exception 'Choose how the order was paid' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 120 then
    raise exception 'The payment reference is too long' using errcode = '22023';
  end if;
  if not exists (select 1 from public.store_orders where id = p_order_id and coach_id = auth.uid()) then
    raise exception 'Order was not found' using errcode = 'P0002';
  end if;
  return public.deliver_store_order(p_order_id, 'manual', p_method, v_reference);
end;
$$;

-- Either side can close an open order: the coach declines it, the buyer withdraws it. The client can buy again later.
create or replace function public.cancel_store_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.store_orders
  set status = 'canceled', payment_reported_at = null
  where id = p_order_id and status = 'pending' and (buyer_client_id = auth.uid() or coach_id = auth.uid());
  if not found then
    raise exception 'Only your own open orders can be canceled' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the coach and the client see
-- ---------------------------------------------------------------------------
create or replace function public.get_store_sales()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  return jsonb_build_object(
    'orders_paid', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'paid'),
    'orders_pending', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'pending'),
    'revenue', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'cents', total) order by currency)
      from (
        select currency, sum(amount_cents)::bigint as total
        from public.store_orders where coach_id = auth.uid() and status = 'paid' group by currency
      ) r
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', p.id, 'title', p.title, 'sales', s.sales, 'cents', s.cents, 'currency', p.currency) order by s.sales desc, p.title)
      from public.store_products p
      cross join lateral (
        select count(*) filter (where o.status = 'paid')::integer as sales,
               coalesce(sum(o.amount_cents) filter (where o.status = 'paid'), 0)::bigint as cents
        from public.store_orders o where o.product_id = p.id
      ) s
      where p.coach_id = auth.uid()
    ), '[]'::jsonb),
    'pending', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'created_at', o.created_at, 'payment_reported_at', o.payment_reported_at,
        'buyer', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client')
      ) order by (o.payment_reported_at is null), coalesce(o.payment_reported_at, o.created_at) desc)
      from (
        select * from public.store_orders where coach_id = auth.uid() and status = 'pending' and amount_cents > 0
        order by created_at desc limit 50
      ) o
      left join public.coach_clients cc on cc.coach_id = o.coach_id and cc.client_id = o.buyer_client_id
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'payment_mode', o.payment_mode, 'paid_method', o.paid_method, 'payment_reference', o.payment_reference,
        'purchased_at', o.purchased_at, 'delivered', o.assignment_id is not null,
        'buyer', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client')
      ) order by o.purchased_at desc)
      from (
        select * from public.store_orders where coach_id = auth.uid() and status = 'paid' order by purchased_at desc limit 20
      ) o
      left join public.coach_clients cc on cc.coach_id = o.coach_id and cc.client_id = o.buyer_client_id
    ), '[]'::jsonb)
  );
end;
$$;

-- The client's store: their coach's published products, their open orders, what they own, and the purchased programs.
create or replace function public.get_my_store()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'price_cents', p.price_cents, 'currency', p.currency,
        'cover_image_url', p.cover_image_url, 'coach_id', p.coach_id,
        'coach_name', coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), '')),
        'owned', exists (select 1 from public.store_orders o where o.product_id = p.id and o.buyer_client_id = auth.uid() and o.status = 'paid'),
        'pending_order', (
          select jsonb_build_object('id', o.id, 'reported', o.payment_reported_at is not null)
          from public.store_orders o
          where o.product_id = p.id and o.buyer_client_id = auth.uid() and o.status = 'pending' and o.amount_cents > 0
          limit 1
        )
      ) order by p.created_at desc)
      from public.store_products p
      join public.coach_clients cc on cc.coach_id = p.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
      left join public.profiles pr on pr.id = p.coach_id
      where p.is_published and public.workflow_coach_is_active(p.coach_id)
    ), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'purchased_at', o.purchased_at,
        'program', case when o.program_template_id is null then null else public.program_summary(o.program_template_id) end
      ) order by o.purchased_at desc)
      from public.store_orders o
      where o.buyer_client_id = auth.uid() and o.status = 'paid'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.deliver_store_order(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.begin_store_purchase(uuid) from public, anon;
revoke all on function public.report_store_payment(uuid) from public, anon;
revoke all on function public.confirm_store_payment(uuid, text, text) from public, anon;
revoke all on function public.cancel_store_order(uuid) from public, anon;
revoke all on function public.get_store_sales() from public, anon;
revoke all on function public.get_my_store() from public, anon;
grant execute on function public.begin_store_purchase(uuid) to authenticated;
grant execute on function public.report_store_payment(uuid) to authenticated;
grant execute on function public.confirm_store_payment(uuid, text, text) to authenticated;
grant execute on function public.cancel_store_order(uuid) to authenticated;
grant execute on function public.get_store_sales() to authenticated;
grant execute on function public.get_my_store() to authenticated;

-- ---------------------------------------------------------------------------
-- What was left of Stripe
-- ---------------------------------------------------------------------------
-- The connected-account table, the invoice webhook function and the payment ids on invoices. Invoices already paid
-- keep their status and dates; only the gateway identifiers go.
drop function if exists public.mark_invoice_paid(uuid, text, text, integer, text);
drop table if exists public.coach_payment_accounts cascade;
alter table public.invoices drop column if exists stripe_checkout_session_id;
alter table public.invoices drop column if exists stripe_payment_intent_id;
update public.invoices set paid_method = 'card' where status = 'paid' and paid_method is null;

-- ===== 20261115002600_chat_voice_messages.sql =====

-- Voice messages in the two-way coach/client chat.
-- A voice message is a chat_messages row with message_type = 'voice' and the path of an audio file in the private
-- apexfit-chat-audio bucket. The file is uploaded first, then send_chat_voice_message checks the link between the two
-- people and the file, and saves the row. The browser only ever gets short-lived signed links to the audio.

alter table public.chat_messages
  add column if not exists message_type text not null default 'text',
  add column if not exists audio_path text,
  add column if not exists audio_duration_seconds integer,
  add column if not exists audio_mime text;

alter table public.chat_messages drop constraint if exists chat_messages_message_type_check;
alter table public.chat_messages
  add constraint chat_messages_message_type_check check (message_type in ('text', 'voice'));

-- Text messages keep their rules (1 to 2000 characters); a voice message has no text but needs its file and a length of 1 to 120 seconds.
alter table public.chat_messages drop constraint if exists chat_messages_message_text_check;
alter table public.chat_messages drop constraint if exists chat_messages_content_check;
alter table public.chat_messages
  add constraint chat_messages_content_check check (
    (message_type = 'text'
      and char_length(btrim(message_text)) between 1 and 2000
      and audio_path is null and audio_duration_seconds is null and audio_mime is null)
    or
    (message_type = 'voice'
      and message_text = ''
      and audio_path is not null
      and audio_duration_seconds between 1 and 120
      and audio_mime in ('audio/webm', 'audio/mp4', 'audio/ogg'))
  );

create unique index if not exists chat_messages_audio_path_idx on public.chat_messages (audio_path) where audio_path is not null;

-- Private bucket: 10 MB per file, audio only. Files live in a folder named after the person who recorded them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-chat-audio',
  'apexfit-chat-audio',
  false,
  10485760,
  array['audio/webm', 'audio/mp4', 'audio/ogg']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "People can upload their own chat audio" on storage.objects;
create policy "People can upload their own chat audio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-chat-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (public.is_client_account() or public.is_active_coach())
  );

-- The recorder can read the file, and so can the other person in the conversation it was sent to.
drop policy if exists "Chat participants can read chat audio" on storage.objects;
create policy "Chat participants can read chat audio"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-chat-audio'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.chat_messages m
        where m.audio_path = storage.objects.name
          and (m.sender_id = (select auth.uid()) or m.receiver_id = (select auth.uid()))
      )
    )
  );

-- Lets the app remove a recording whose message could not be saved.
drop policy if exists "People can delete their own chat audio" on storage.objects;
create policy "People can delete their own chat audio"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-chat-audio'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create or replace function public.send_chat_voice_message(
  p_receiver_id uuid,
  p_audio_path text,
  p_duration integer,
  p_mime text,
  p_client_ref uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mime text := lower(btrim(split_part(coalesce(p_mime, ''), ';', 1)));
  v_row public.chat_messages;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send messages';
  end if;
  if not public.chat_can_message(p_receiver_id) then
    raise exception 'You can only message your own coach or your active clients';
  end if;
  if p_duration is null or p_duration < 1 or p_duration > 120 then
    raise exception 'Voice messages can be 1 to 120 seconds long';
  end if;
  if v_mime not in ('audio/webm', 'audio/mp4', 'audio/ogg') then
    raise exception 'This audio format is not supported';
  end if;
  if p_audio_path is null
     or p_audio_path !~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webm|mp4|ogg)$') then
    raise exception 'The recording is not valid';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'apexfit-chat-audio' and o.name = p_audio_path) then
    raise exception 'The recording was not uploaded';
  end if;

  if p_client_ref is not null then
    select * into v_row from public.chat_messages where sender_id = auth.uid() and client_ref = p_client_ref;
    if found then
      return to_jsonb(v_row);
    end if;
  end if;

  if (select count(*) from public.chat_messages where sender_id = auth.uid() and created_at > statement_timestamp() - interval '1 minute') >= 40 then
    raise exception 'You are sending messages too fast. Wait a moment';
  end if;

  insert into public.chat_messages (sender_id, receiver_id, message_type, message_text, audio_path, audio_duration_seconds, audio_mime, client_ref, created_at)
  values (auth.uid(), p_receiver_id, 'voice', '', p_audio_path, p_duration, v_mime, p_client_ref, clock_timestamp())
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- Same pages as before, now with the voice fields.
create or replace function public.get_chat_messages(p_partner_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (select greatest(1, least(coalesce(p_limit, 50), 200)) as lim),
  page as (
    select m.id, m.sender_id, m.receiver_id, m.message_text, m.created_at, m.is_read,
           m.message_type, m.audio_path, m.audio_duration_seconds, m.audio_mime,
           row_number() over (order by m.created_at desc, m.id desc) as rn
    from public.chat_messages m
    where ((m.sender_id = auth.uid() and m.receiver_id = p_partner_id) or (m.sender_id = p_partner_id and m.receiver_id = auth.uid()))
      and (p_before is null or m.created_at < p_before)
    order by m.created_at desc, m.id desc
    limit (select lim + 1 from params)
  )
  select jsonb_build_object(
    'messages', coalesce(
      jsonb_agg(jsonb_build_object('id', id, 'sender_id', sender_id, 'receiver_id', receiver_id, 'message_text', message_text, 'created_at', created_at, 'is_read', is_read,
                                   'message_type', message_type, 'audio_path', audio_path, 'audio_duration_seconds', audio_duration_seconds, 'audio_mime', audio_mime)
                order by created_at, id) filter (where rn <= (select lim from params)),
      '[]'::jsonb),
    'has_more', coalesce(bool_or(rn > (select lim from params)), false)
  )
  from page;
$$;

-- The conversation list now also says whether the last message was a voice message.
create or replace function public.get_chat_conversations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_is_coach boolean;
begin
  if v_me is null then
    raise exception 'Sign in first';
  end if;
  v_is_coach := exists (select 1 from public.profiles where id = v_me and role = 'coach');

  return coalesce((
    select jsonb_agg(item order by (item ->> 'last_at') desc nulls last, (item ->> 'partner_name'))
    from (
      select jsonb_build_object(
        'partner_id', link.partner_id,
        'partner_name', link.partner_name,
        'partner_avatar_path', p.avatar_path,
        'status', link.status,
        'last_text', last.message_text,
        'last_type', last.message_type,
        'last_at', last.created_at,
        'last_sender_id', last.sender_id,
        'unread_count', coalesce(unread.n, 0)
      ) as item
      from (
        select case when v_is_coach then cc.client_id else cc.coach_id end as partner_id,
               coalesce(nullif(btrim(case when v_is_coach then cc.client_name else cc.coach_name end), ''),
                        nullif(btrim(case when v_is_coach then cc.client_email else cc.coach_email end), ''), 'ApexFit') as partner_name,
               case when cc.status = 'active' and (v_is_coach or public.workflow_coach_is_active(cc.coach_id)) then 'active' else 'archived' end as status
        from public.coach_clients cc
        where (v_is_coach and cc.coach_id = v_me) or (not v_is_coach and cc.client_id = v_me)
      ) link
      left join public.profiles p on p.id = link.partner_id
      left join lateral (
        select m.message_text, m.message_type, m.created_at, m.sender_id
        from public.chat_messages m
        where (m.sender_id = v_me and m.receiver_id = link.partner_id) or (m.sender_id = link.partner_id and m.receiver_id = v_me)
        order by m.created_at desc, m.id desc
        limit 1
      ) last on true
      left join lateral (
        select count(*)::integer as n
        from public.chat_messages m
        where m.sender_id = link.partner_id and m.receiver_id = v_me and not m.is_read
      ) unread on true
      where link.status = 'active' or last.created_at is not null
    ) rows
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.send_chat_voice_message(uuid, text, integer, text, uuid) from public, anon;
grant execute on function public.send_chat_voice_message(uuid, text, integer, text, uuid) to authenticated;

-- ===== 20261115002700_email_campaigns.sql =====

-- Email campaigns: a coach writes one message and sends it to some or all of their active clients.
-- The server (api/send-campaign.js) sends the emails with the provider key, which never reaches the browser; the
-- database decides who may be emailed. Everything is written through the functions below, so a coach can only reach
-- their own active clients and a client who opted out is never emailed.

alter table public.profiles add column if not exists email_marketing_opt_out boolean not null default false;
alter table public.profiles add column if not exists email_marketing_opt_out_at timestamptz;

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  subject text not null check (char_length(btrim(subject)) between 1 and 150),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  language text not null default 'en' check (language in ('en', 'ar', 'de', 'fr', 'es')),
  audience text not null check (audience in ('all', 'selected')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'partial', 'failed')),
  total_count integer not null default 0 check (total_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists email_campaigns_coach_idx on public.email_campaigns (coach_id, created_at desc);

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  email text,
  client_name text,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped_opt_out', 'skipped_no_email')),
  attempts integer not null default 0,
  error text check (error is null or char_length(error) <= 300),
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (campaign_id, client_id)
);

create index if not exists email_campaign_recipients_campaign_idx on public.email_campaign_recipients (campaign_id, status);

alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;

drop policy if exists "Coaches can read their email campaigns" on public.email_campaigns;
create policy "Coaches can read their email campaigns"
  on public.email_campaigns for select
  to authenticated
  using (coach_id = (select auth.uid()));

drop policy if exists "Coaches can read their campaign recipients" on public.email_campaign_recipients;
create policy "Coaches can read their campaign recipients"
  on public.email_campaign_recipients for select
  to authenticated
  using (exists (
    select 1 from public.email_campaigns c
    where c.id = email_campaign_recipients.campaign_id and c.coach_id = (select auth.uid())
  ));

revoke all on public.email_campaigns, public.email_campaign_recipients from anon, authenticated;
grant select on public.email_campaigns, public.email_campaign_recipients to authenticated;
grant all on public.email_campaigns, public.email_campaign_recipients to service_role;

-- Recounts a campaign from its recipients and closes it when nothing is left to send.
create or replace function public.email_campaign_refresh(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sent integer;
  v_failed integer;
  v_skipped integer;
  v_open integer;
begin
  select count(*) filter (where status = 'sent'),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status in ('skipped_opt_out', 'skipped_no_email')),
         count(*) filter (where status in ('pending', 'sending'))
  into v_sent, v_failed, v_skipped, v_open
  from public.email_campaign_recipients where campaign_id = p_campaign_id;

  update public.email_campaigns
  set sent_count = v_sent,
      failed_count = v_failed,
      skipped_count = v_skipped,
      status = case
        when v_open > 0 then 'sending'
        when v_failed = 0 then 'sent'
        when v_sent = 0 then 'failed'
        else 'partial'
      end,
      completed_at = case when v_open > 0 then null else coalesce(completed_at, now()) end
  where id = p_campaign_id;
end;
$$;

-- Creates the campaign and its recipient list. Clients who opted out or have no usable email are listed as skipped.
create or replace function public.create_email_campaign(
  p_subject text,
  p_body text,
  p_language text,
  p_client_ids uuid[] default null,
  p_send_to_all boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_language text := coalesce(nullif(btrim(p_language), ''), 'en');
  v_wanted uuid[] := coalesce(p_client_ids, '{}');
  v_found integer;
  v_campaign public.email_campaigns;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send campaigns';
  end if;
  if not public.is_active_coach() then
    raise exception 'An active coach plan is required to send campaigns';
  end if;
  if v_subject = '' or char_length(v_subject) > 150 then
    raise exception 'Write a subject of up to 150 characters';
  end if;
  if v_body = '' or char_length(v_body) > 5000 then
    raise exception 'Write a message of up to 5000 characters';
  end if;
  if v_language not in ('en', 'ar', 'de', 'fr', 'es') then
    raise exception 'Choose a supported language';
  end if;
  if not coalesce(p_send_to_all, false) and cardinality(v_wanted) = 0 then
    raise exception 'Choose at least one client';
  end if;
  if (select count(*) from public.email_campaigns where coach_id = auth.uid() and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'You have sent many campaigns in the last hour. Wait a while before sending another';
  end if;

  select count(*) into v_found
  from public.coach_clients cc
  where cc.coach_id = auth.uid() and cc.status = 'active'
    and (coalesce(p_send_to_all, false) or cc.client_id = any (v_wanted));
  if v_found = 0 then
    raise exception 'You have no active clients to email';
  end if;
  if v_found > 500 then
    raise exception 'A campaign can reach up to 500 clients';
  end if;
  if not coalesce(p_send_to_all, false) and v_found <> cardinality(v_wanted) then
    raise exception 'Some of the chosen people are not your active clients';
  end if;

  insert into public.email_campaigns (coach_id, subject, body, language, audience)
  values (auth.uid(), v_subject, v_body, v_language, case when coalesce(p_send_to_all, false) then 'all' else 'selected' end)
  returning * into v_campaign;

  insert into public.email_campaign_recipients (campaign_id, client_id, email, client_name, status)
  select v_campaign.id,
         cc.client_id,
         nullif(btrim(cc.client_email), ''),
         nullif(btrim(cc.client_name), ''),
         case
           when coalesce(p.email_marketing_opt_out, false) then 'skipped_opt_out'
           when nullif(btrim(cc.client_email), '') is null or btrim(cc.client_email) !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then 'skipped_no_email'
           else 'pending'
         end
  from public.coach_clients cc
  left join public.profiles p on p.id = cc.client_id
  where cc.coach_id = auth.uid() and cc.status = 'active'
    and (coalesce(p_send_to_all, false) or cc.client_id = any (v_wanted));

  update public.email_campaigns set total_count = v_found where id = v_campaign.id;
  perform public.email_campaign_refresh(v_campaign.id);
  select * into v_campaign from public.email_campaigns where id = v_campaign.id;
  return to_jsonb(v_campaign);
end;
$$;

-- Hands the server the next few people to email and marks them as being sent. People who opted out in the
-- meantime are skipped. A recipient stuck in "sending" (the server stopped midway) is offered again after 5 minutes.
create or replace function public.claim_email_campaign_batch(p_campaign_id uuid, p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign public.email_campaigns;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_batch jsonb;
  v_coach_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select * into v_campaign from public.email_campaigns where id = p_campaign_id and coach_id = auth.uid();
  if not found then
    raise exception 'Campaign not found';
  end if;
  if not public.is_active_coach() then
    raise exception 'An active coach plan is required to send campaigns';
  end if;

  update public.email_campaign_recipients
  set status = 'pending'
  where campaign_id = p_campaign_id and status = 'sending' and claimed_at < now() - interval '5 minutes';

  update public.email_campaign_recipients r
  set status = 'skipped_opt_out'
  from public.profiles p
  where r.campaign_id = p_campaign_id and r.status = 'pending' and p.id = r.client_id and p.email_marketing_opt_out;

  with picked as (
    select id from public.email_campaign_recipients
    where campaign_id = p_campaign_id and status = 'pending'
    order by id
    limit v_limit
    for update skip locked
  ),
  claimed as (
    update public.email_campaign_recipients r
    set status = 'sending', claimed_at = now(), attempts = r.attempts + 1
    from picked
    where r.id = picked.id
    returning r.id, r.client_id, r.email, r.client_name
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'client_id', client_id, 'email', email, 'name', client_name)), '[]'::jsonb)
  into v_batch from claimed;

  perform public.email_campaign_refresh(p_campaign_id);

  select coalesce(nullif(btrim(brand_name), ''), nullif(btrim(full_name), ''), 'ApexFit') into v_coach_name
  from public.profiles where id = auth.uid();

  return jsonb_build_object(
    'campaign', jsonb_build_object('id', v_campaign.id, 'subject', v_campaign.subject, 'body', v_campaign.body, 'language', v_campaign.language, 'coach_name', v_coach_name),
    'recipients', v_batch,
    'remaining', (select count(*) from public.email_campaign_recipients where campaign_id = p_campaign_id and status = 'pending')
  );
end;
$$;

create or replace function public.record_email_campaign_result(p_recipient_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select r.campaign_id into v_campaign_id
  from public.email_campaign_recipients r
  join public.email_campaigns c on c.id = r.campaign_id
  where r.id = p_recipient_id and c.coach_id = auth.uid();
  if v_campaign_id is null then
    raise exception 'Recipient not found';
  end if;

  update public.email_campaign_recipients
  set status = case when p_ok then 'sent' else 'failed' end,
      error = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'The email could not be sent'), 300) end,
      sent_at = case when p_ok then now() else null end
  where id = p_recipient_id and status = 'sending';

  perform public.email_campaign_refresh(v_campaign_id);
end;
$$;

-- Puts the failed recipients of a campaign back in the queue so the coach can send them again.
create or replace function public.retry_failed_email_recipients(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  if not exists (select 1 from public.email_campaigns where id = p_campaign_id and coach_id = auth.uid()) then
    raise exception 'Campaign not found';
  end if;
  update public.email_campaign_recipients set status = 'pending', error = null
  where campaign_id = p_campaign_id and status = 'failed';
  get diagnostics v_count = row_count;
  perform public.email_campaign_refresh(p_campaign_id);
  return v_count;
end;
$$;

-- A client's own choice about marketing emails (the unsubscribe link in each email sets the same flag).
create or replace function public.get_my_email_preferences()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('email_marketing_opt_out', coalesce(p.email_marketing_opt_out, false))
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.set_my_email_marketing_opt_out(p_opt_out boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  update public.profiles
  set email_marketing_opt_out = coalesce(p_opt_out, false),
      email_marketing_opt_out_at = case when coalesce(p_opt_out, false) then now() else null end
  where id = auth.uid();
  return jsonb_build_object('email_marketing_opt_out', coalesce(p_opt_out, false));
end;
$$;

revoke all on function public.email_campaign_refresh(uuid) from public, anon, authenticated;
revoke all on function public.create_email_campaign(text, text, text, uuid[], boolean) from public, anon;
revoke all on function public.claim_email_campaign_batch(uuid, integer) from public, anon;
revoke all on function public.record_email_campaign_result(uuid, boolean, text) from public, anon;
revoke all on function public.retry_failed_email_recipients(uuid) from public, anon;
revoke all on function public.get_my_email_preferences() from public, anon;
revoke all on function public.set_my_email_marketing_opt_out(boolean) from public, anon;
grant execute on function public.create_email_campaign(text, text, text, uuid[], boolean) to authenticated;
grant execute on function public.claim_email_campaign_batch(uuid, integer) to authenticated;
grant execute on function public.record_email_campaign_result(uuid, boolean, text) to authenticated;
grant execute on function public.retry_failed_email_recipients(uuid) to authenticated;
grant execute on function public.get_my_email_preferences() to authenticated;
grant execute on function public.set_my_email_marketing_opt_out(boolean) to authenticated;

-- ===== 20261115002800_coach_food_log_review.sql =====

-- A coach can read (never change) the food log of each of their active clients, to review what the client eats.
-- The client keeps full control of their own entries: the existing "for all" policy for the client is untouched, and
-- this policy only grants SELECT, so a coach still cannot insert, update or delete anything.
-- Daily calorie and macro goals already exist (public.nutrition_targets, set with set_client_nutrition_targets).

drop policy if exists "Coaches can read their clients' food logs" on public.client_food_logs;
create policy "Coaches can read their clients' food logs"
  on public.client_food_logs for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_food_logs.client_id
        and cc.status = 'active'
    )
  );

-- ===== 20261115002900_coach_dashboard.sql =====

-- The numbers on the coach's dashboard, all computed from the coach's own records in one call.
-- It runs with the database's permissions (security definer), so it checks everything itself: it answers only for an
-- active coach, and every count and every client in the answer belongs to that coach's own active clients.
--
--   active_clients : active clients linked to this coach
--   plans_created  : training programs this coach created (templates included)
--   revenue_month  : money received this calendar month (UTC), by currency, in cents: paid invoices (by paid_at)
--                    plus paid store orders (by purchase date)
--   clients[]      : one entry per active client with what the dashboard needs to work out workout adherence
--                    and the insights: distinct days with a logged workout and food log, the last of each, the weekly
--                    training goal from the onboarding form (null when not filled in) and unread messages
create or replace function public.get_coach_dashboard(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_month_start timestamptz := date_trunc('month', statement_timestamp());
  v_month_end timestamptz := date_trunc('month', statement_timestamp()) + interval '1 month';
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', v_days,
    'active_clients', (select count(*) from public.coach_clients where coach_id = auth.uid() and status = 'active'),
    'plans_created', (select count(*) from public.training_programs where coach_id = auth.uid()),
    'revenue_month', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'cents', total) order by currency)
      from (
        select currency, sum(cents)::bigint as total
        from (
          select i.currency, i.amount_cents as cents
          from public.invoices i
          where i.coach_id = auth.uid() and i.status = 'paid' and i.paid_at >= v_month_start and i.paid_at < v_month_end
          union all
          select o.currency, o.amount_cents
          from public.store_orders o
          where o.coach_id = auth.uid() and o.status = 'paid'
            and coalesce(o.purchased_at, o.created_at) >= v_month_start and coalesce(o.purchased_at, o.created_at) < v_month_end
        ) paid
        group by currency
      ) totals
    ), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', cc.client_id,
        'name', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client'),
        'joined_at', cc.created_at,
        'weekly_target', (select f.training_days_per_week from public.client_intake_forms f where f.client_id = cc.client_id),
        'workout_days_7', (select count(distinct s.workout_date) from public.client_workout_sessions s
                           where s.client_id = cc.client_id and s.workout_date > current_date - 7 and s.workout_date <= current_date + 1),
        'workout_days_period', (select count(distinct s.workout_date) from public.client_workout_sessions s
                                where s.client_id = cc.client_id and s.workout_date > current_date - v_days and s.workout_date <= current_date + 1),
        'last_workout_on', (select max(s.workout_date) from public.client_workout_sessions s where s.client_id = cc.client_id),
        'food_days_7', (select count(distinct l.logged_on) from public.client_food_logs l
                        where l.client_id = cc.client_id and l.logged_on > current_date - 7),
        'last_food_on', (select max(l.logged_on) from public.client_food_logs l where l.client_id = cc.client_id),
        'unread_messages', (select count(*) from public.chat_messages m
                            where m.sender_id = cc.client_id and m.receiver_id = auth.uid() and not m.is_read)
      ) order by coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client'))
      from public.coach_clients cc
      where cc.coach_id = auth.uid() and cc.status = 'active'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_coach_dashboard(integer) from public, anon;
grant execute on function public.get_coach_dashboard(integer) to authenticated;

-- ===== 20261115003000_custom_habits.sql =====

-- Custom habits: a client keeps their own list of habits, numeric (water, steps, reading minutes) or yes/no (creatine,
-- no sugar, morning stretch), and can add, edit, archive, restore and delete them.
--
-- Sleep, water and steps are the three habits every client starts with. They are rows in client_custom_habits too (with
-- builtin_key set) so their daily goal can be changed like any other, but their daily values keep living in
-- client_habit_logs (sleep_hours, water_liters, steps), so earlier history, points and reports are untouched.
-- Values of the habits a client adds are stored in client_custom_habit_logs (one number per habit per day; yes/no = 1).
--
-- Security: a client reads only their own rows and writes only through the functions below, which check who is asking.
-- An active coach can read, never change, the habits and values of their own active clients.

create table if not exists public.client_habit_settings (
  client_id uuid primary key references public.profiles (id) on delete cascade,
  defaults_added_at timestamptz not null default now()
);

create table if not exists public.client_custom_habits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  builtin_key text check (builtin_key in ('sleep', 'water', 'steps')),
  name text not null default '' check (char_length(name) <= 60),
  kind text not null check (kind in ('numeric', 'boolean')),
  unit text not null default '' check (char_length(unit) <= 20),
  daily_goal numeric(12, 2),
  quick_add numeric(12, 2),
  color text not null default 'blue' check (color in ('blue', 'green', 'amber', 'purple', 'pink', 'teal')),
  sort_order integer not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id),
  check (builtin_key is not null or char_length(btrim(name)) >= 1),
  check (builtin_key is null or kind = 'numeric'),
  check (
    (kind = 'numeric' and daily_goal is not null and daily_goal > 0 and daily_goal <= 1000000
      and quick_add is not null and quick_add > 0 and quick_add <= 1000000)
    or (kind = 'boolean' and daily_goal is null and quick_add is null)
  )
);

create unique index if not exists client_custom_habits_builtin_idx
  on public.client_custom_habits (client_id, builtin_key) where builtin_key is not null;
create unique index if not exists client_custom_habits_name_idx
  on public.client_custom_habits (client_id, lower(btrim(name))) where builtin_key is null;
create index if not exists client_custom_habits_client_idx
  on public.client_custom_habits (client_id, sort_order, created_at);

create table if not exists public.client_custom_habit_logs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  habit_id uuid not null,
  log_date date not null check (log_date <= current_date + 1),
  value numeric(14, 2) not null check (value >= 0 and value <= 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (habit_id, log_date),
  foreign key (habit_id, client_id) references public.client_custom_habits (id, client_id) on delete cascade
);

create index if not exists client_custom_habit_logs_client_date_idx
  on public.client_custom_habit_logs (client_id, log_date desc);

alter table public.client_habit_settings enable row level security;
alter table public.client_custom_habits enable row level security;
alter table public.client_custom_habit_logs enable row level security;

drop policy if exists "Clients can read their own habit settings" on public.client_habit_settings;
create policy "Clients can read their own habit settings"
  on public.client_habit_settings for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Clients can read their own habits" on public.client_custom_habits;
create policy "Clients can read their own habits"
  on public.client_custom_habits for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their clients' habits" on public.client_custom_habits;
create policy "Coaches can read their clients' habits"
  on public.client_custom_habits for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_custom_habits.client_id
        and cc.status = 'active'
    )
  );

drop policy if exists "Clients can read their own habit values" on public.client_custom_habit_logs;
create policy "Clients can read their own habit values"
  on public.client_custom_habit_logs for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their clients' habit values" on public.client_custom_habit_logs;
create policy "Coaches can read their clients' habit values"
  on public.client_custom_habit_logs for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_custom_habit_logs.client_id
        and cc.status = 'active'
    )
  );

-- The values of sleep, water and steps already live in client_habit_logs; a coach may read them, never change them.
drop policy if exists "Coaches can read their clients' habit logs" on public.client_habit_logs;
create policy "Coaches can read their clients' habit logs"
  on public.client_habit_logs for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_habit_logs.client_id
        and cc.status = 'active'
    )
  );

revoke all on public.client_habit_settings, public.client_custom_habits, public.client_custom_habit_logs from anon, authenticated;
grant select on public.client_habit_settings, public.client_custom_habits, public.client_custom_habit_logs to authenticated;

-- Gives a client the three starting habits, once. Habits they later delete are never added back.
create or replace function public.seed_default_habits(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.client_habit_settings (client_id) values (p_client_id) on conflict (client_id) do nothing;
  if not found then
    return;
  end if;
  insert into public.client_custom_habits (client_id, builtin_key, name, kind, daily_goal, quick_add, color, sort_order) values
    (p_client_id, 'sleep', '', 'numeric', 8, 0.5, 'blue', 1),
    (p_client_id, 'water', '', 'numeric', 2.5, 0.25, 'green', 2),
    (p_client_id, 'steps', '', 'numeric', 10000, 1000, 'amber', 3);
end;
$$;

create or replace function public.ensure_my_default_habits()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  perform public.seed_default_habits(auth.uid());
end;
$$;

-- Clients that already exist start with the same three habits, and their earlier values show up under them.
select public.seed_default_habits(id) from public.profiles where role = 'client';

-- Creates a habit (p_habit_id null) or edits one of the caller's own. The type can never change. For sleep, water and
-- steps only the goal, the quick-add step and the color can change.
create or replace function public.save_my_habit(
  p_habit_id uuid,
  p_name text,
  p_kind text,
  p_unit text,
  p_daily_goal numeric,
  p_quick_add numeric,
  p_color text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := auth.uid();
  v_habit public.client_custom_habits%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_color text := coalesce(nullif(btrim(p_color), ''), 'blue');
  v_max numeric := 1000000;
  v_quick numeric := coalesce(p_quick_add, 1);
  v_id uuid;
begin
  if v_client is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if v_color not in ('blue', 'green', 'amber', 'purple', 'pink', 'teal') then
    raise exception 'Choose one of the available colors' using errcode = '22023';
  end if;

  if p_habit_id is not null then
    select * into v_habit from public.client_custom_habits where id = p_habit_id and client_id = v_client for update;
    if not found then
      raise exception 'Habit not found' using errcode = 'P0002';
    end if;
    if p_kind is not null and p_kind <> v_habit.kind then
      raise exception 'The type of a habit cannot be changed' using errcode = '22023';
    end if;
    v_max := case v_habit.builtin_key when 'sleep' then 24 when 'water' then 50 when 'steps' then 200000 else 1000000 end;
  elsif p_kind is null or p_kind not in ('numeric', 'boolean') then
    raise exception 'Choose a habit type: numeric or yes/no' using errcode = '22023';
  end if;

  if p_habit_id is null or v_habit.builtin_key is null then
    if char_length(v_name) not between 1 and 60 then
      raise exception 'The habit name must be between 1 and 60 characters' using errcode = '22023';
    end if;
    if char_length(v_unit) > 20 then
      raise exception 'The unit cannot be longer than 20 characters' using errcode = '22023';
    end if;
  end if;

  if coalesce(p_kind, v_habit.kind) = 'numeric' then
    if p_daily_goal is null or p_daily_goal <= 0 or p_daily_goal > v_max then
      raise exception 'The daily goal must be greater than 0 and at most %', v_max using errcode = '22023';
    end if;
    if v_quick <= 0 or v_quick > v_max then
      raise exception 'The quick-add step must be greater than 0 and at most %', v_max using errcode = '22023';
    end if;
  end if;

  begin
    if p_habit_id is null then
      if (select count(*) from public.client_custom_habits where client_id = v_client) >= 30 then
        raise exception 'You can have up to 30 habits. Delete one first.' using errcode = '22023';
      end if;
      insert into public.client_custom_habits (client_id, name, kind, unit, daily_goal, quick_add, color, sort_order)
      values (
        v_client, v_name, p_kind,
        case when p_kind = 'numeric' then v_unit else '' end,
        case when p_kind = 'numeric' then p_daily_goal end,
        case when p_kind = 'numeric' then v_quick end,
        v_color,
        coalesce((select max(sort_order) from public.client_custom_habits where client_id = v_client), 0) + 1
      )
      returning id into v_id;
    else
      update public.client_custom_habits
      set name = case when builtin_key is null then v_name else name end,
          unit = case when builtin_key is null and kind = 'numeric' then v_unit else unit end,
          daily_goal = case when kind = 'numeric' then p_daily_goal end,
          quick_add = case when kind = 'numeric' then v_quick end,
          color = v_color,
          updated_at = now()
      where id = p_habit_id
      returning id into v_id;
    end if;
  exception when unique_violation then
    raise exception 'You already have a habit with this name' using errcode = '23505';
  end;
  return v_id;
end;
$$;

-- Archived habits disappear from the daily screen but keep their history; restoring brings them back.
create or replace function public.set_my_habit_status(p_habit_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'archived') then
    raise exception 'Choose active or archived' using errcode = '22023';
  end if;
  update public.client_custom_habits set status = p_status, updated_at = now()
  where id = p_habit_id and client_id = auth.uid();
  if not found then
    raise exception 'Habit not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Deletes a habit and everything recorded for it. For sleep, water and steps that means clearing the matching column.
create or replace function public.delete_my_habit(p_habit_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := auth.uid();
  v_habit public.client_custom_habits%rowtype;
begin
  if v_client is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  select * into v_habit from public.client_custom_habits where id = p_habit_id and client_id = v_client for update;
  if not found then
    raise exception 'Habit not found' using errcode = 'P0002';
  end if;

  if v_habit.builtin_key = 'sleep' then
    delete from public.client_habit_logs where client_id = v_client and water_liters is null and steps is null;
    update public.client_habit_logs set sleep_hours = null, updated_at = now() where client_id = v_client and sleep_hours is not null;
  elsif v_habit.builtin_key = 'water' then
    delete from public.client_habit_logs where client_id = v_client and sleep_hours is null and steps is null;
    update public.client_habit_logs set water_liters = null, updated_at = now() where client_id = v_client and water_liters is not null;
  elsif v_habit.builtin_key = 'steps' then
    delete from public.client_habit_logs where client_id = v_client and sleep_hours is null and water_liters is null;
    update public.client_habit_logs set steps = null, updated_at = now() where client_id = v_client and steps is not null;
  end if;

  delete from public.client_custom_habits where id = v_habit.id;
end;
$$;

-- Records one habit's value for one day. A number for numeric habits, 1 or 0 for yes/no ones; null (or 0 for yes/no)
-- removes the entry for that day.
create or replace function public.log_my_habit(p_habit_id uuid, p_date date, p_value numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := auth.uid();
  v_habit public.client_custom_habits%rowtype;
begin
  if v_client is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 400 then
    raise exception 'Choose a date from the last 400 days up to today' using errcode = '22023';
  end if;
  select * into v_habit from public.client_custom_habits where id = p_habit_id and client_id = v_client;
  if not found then
    raise exception 'Habit not found' using errcode = 'P0002';
  end if;
  if v_habit.status <> 'active' then
    raise exception 'Restore this habit before logging it' using errcode = '22023';
  end if;

  if v_habit.kind = 'boolean' then
    if p_value is not null and p_value not in (0, 1) then
      raise exception 'A yes/no habit is either done (1) or not done (0)' using errcode = '22023';
    end if;
    if coalesce(p_value, 0) = 0 then
      delete from public.client_custom_habit_logs where habit_id = v_habit.id and log_date = p_date;
    else
      insert into public.client_custom_habit_logs (client_id, habit_id, log_date, value)
      values (v_client, v_habit.id, p_date, 1)
      on conflict (habit_id, log_date) do update set value = 1, updated_at = now();
    end if;
    return;
  end if;

  if p_value is not null and (p_value < 0 or p_value > case v_habit.builtin_key when 'sleep' then 24 when 'water' then 50 when 'steps' then 200000 else 1000000 end) then
    raise exception 'That value is out of range for this habit' using errcode = '22023';
  end if;

  if v_habit.builtin_key = 'sleep' then
    if p_value is null then
      delete from public.client_habit_logs where client_id = v_client and habit_date = p_date and water_liters is null and steps is null;
      update public.client_habit_logs set sleep_hours = null, updated_at = now() where client_id = v_client and habit_date = p_date;
    else
      insert into public.client_habit_logs (client_id, habit_date, sleep_hours) values (v_client, p_date, p_value)
      on conflict (client_id, habit_date) do update set sleep_hours = excluded.sleep_hours, updated_at = now();
    end if;
  elsif v_habit.builtin_key = 'water' then
    if p_value is null then
      delete from public.client_habit_logs where client_id = v_client and habit_date = p_date and sleep_hours is null and steps is null;
      update public.client_habit_logs set water_liters = null, updated_at = now() where client_id = v_client and habit_date = p_date;
    else
      insert into public.client_habit_logs (client_id, habit_date, water_liters) values (v_client, p_date, p_value)
      on conflict (client_id, habit_date) do update set water_liters = excluded.water_liters, updated_at = now();
    end if;
  elsif v_habit.builtin_key = 'steps' then
    if p_value is not null and p_value <> trunc(p_value) then
      raise exception 'Steps must be a whole number' using errcode = '22023';
    end if;
    if p_value is null then
      delete from public.client_habit_logs where client_id = v_client and habit_date = p_date and sleep_hours is null and water_liters is null;
      update public.client_habit_logs set steps = null, updated_at = now() where client_id = v_client and habit_date = p_date;
    else
      insert into public.client_habit_logs (client_id, habit_date, steps) values (v_client, p_date, p_value)
      on conflict (client_id, habit_date) do update set steps = excluded.steps, updated_at = now();
    end if;
  elsif p_value is null then
    delete from public.client_custom_habit_logs where habit_id = v_habit.id and log_date = p_date;
  else
    insert into public.client_custom_habit_logs (client_id, habit_id, log_date, value)
    values (v_client, v_habit.id, p_date, p_value)
    on conflict (habit_id, log_date) do update set value = excluded.value, updated_at = now();
  end if;
end;
$$;

revoke all on function public.seed_default_habits(uuid) from public, anon, authenticated;
revoke all on function public.ensure_my_default_habits() from public, anon;
revoke all on function public.save_my_habit(uuid, text, text, text, numeric, numeric, text) from public, anon;
revoke all on function public.set_my_habit_status(uuid, text) from public, anon;
revoke all on function public.delete_my_habit(uuid) from public, anon;
revoke all on function public.log_my_habit(uuid, date, numeric) from public, anon;
grant execute on function public.ensure_my_default_habits() to authenticated;
grant execute on function public.save_my_habit(uuid, text, text, text, numeric, numeric, text) to authenticated;
grant execute on function public.set_my_habit_status(uuid, text) to authenticated;
grant execute on function public.delete_my_habit(uuid) to authenticated;
grant execute on function public.log_my_habit(uuid, date, numeric) to authenticated;

-- ===== 20261115003100_team_invitation_rules.sql =====

-- Who can accept an invitation to join another coach's team.
--
-- A new coach on the free 72-hour trial, with no clients, no paid subscription and no team of their own, can accept.
-- The trial by itself never blocks joining: it is a field on the profile, not a subscription.
--
-- An account is turned away only when it already runs its own practice:
--   * it has (or ever had) clients,
--   * it has a paid subscription that is still in force (active, or past due within its paid period),
--   * or it has its own team (trainers invited or active), which would be left without a head coach.
-- The first rule keeps its original message; the other two say exactly what is in the way.
create or replace function public.accept_team_invitation(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_member public.coach_team_members%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required to join a team';
  end if;
  select * into v_member from public.coach_team_members where id = p_member_id for update;
  if not found or v_member.status <> 'invited' or v_email = '' or v_member.invite_email <> v_email then
    raise exception 'This invitation is not available';
  end if;
  if exists (select 1 from public.coach_clients where coach_id = auth.uid())
    or exists (
      select 1 from public.coach_subscriptions s
      where s.user_id = auth.uid() and public.subscription_grants_access(s.status, s.current_period_end)
    ) then
    raise exception 'This account already runs its own coaching practice, so it cannot join a team';
  end if;
  if exists (select 1 from public.coach_team_members where head_coach_id = auth.uid()) then
    raise exception 'This account already has its own team, so it cannot join another one';
  end if;
  if exists (select 1 from public.coach_team_members where trainer_user_id = auth.uid() and status = 'active') then
    raise exception 'You already belong to a team';
  end if;

  update public.coach_team_members set trainer_user_id = auth.uid(), status = 'active' where id = p_member_id;
  return public.get_my_access_status();
end;
$$;

-- ===== 20261115003200_weekly_checkins.sql =====

-- Weekly check-ins: once a week a client reports how the week went (weight, sleep, how well they followed the plan,
-- energy, notes) with optional front / side / back photos. The coach (or an assistant trainer allowed to manage
-- programs) reviews it and writes feedback.
--
-- Security: a client reads their own check-ins; the coach side reads the check-ins of the clients they look after
-- (public.task_coach_for). Nobody writes the table directly: clients submit through submit_weekly_checkin and the coach
-- side reviews through review_weekly_checkin, which check who is asking and the values.
-- Photos live in the private bucket apexfit-checkin-photos under <client id>/, JPG/PNG/WebP up to 5 MB, and are
-- shown only through short-lived signed links.

create table if not exists public.weekly_checkins (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  coach_id uuid references public.profiles (id) on delete set null,
  week_start_date date not null check (extract(isodow from week_start_date) = 1),
  weight_kg numeric(5, 1) check (weight_kg between 20 and 500),
  sleep_hours numeric(4, 1) check (sleep_hours between 0 and 24),
  sleep_quality_1_5 smallint not null check (sleep_quality_1_5 between 1 and 5),
  workout_adherence_1_10 smallint not null check (workout_adherence_1_10 between 1 and 10),
  diet_adherence_1_10 smallint not null check (diet_adherence_1_10 between 1 and 10),
  energy_level_1_5 smallint not null check (energy_level_1_5 between 1 and 5),
  client_notes text not null default '' check (char_length(client_notes) <= 2000),
  photo_paths jsonb not null default '{}'::jsonb check (jsonb_typeof(photo_paths) = 'object'),
  status text not null default 'submitted' check (status in ('submitted', 'reviewed')),
  coach_feedback text check (coach_feedback is null or char_length(btrim(coach_feedback)) between 1 and 2000),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, week_start_date),
  check (status = 'submitted' or (coach_feedback is not null and reviewed_at is not null))
);

create index if not exists weekly_checkins_client_week_idx on public.weekly_checkins (client_id, week_start_date desc);
create index if not exists weekly_checkins_coach_status_idx on public.weekly_checkins (coach_id, status, created_at desc);

alter table public.weekly_checkins enable row level security;

drop policy if exists "Clients can read their own check-ins" on public.weekly_checkins;
create policy "Clients can read their own check-ins"
  on public.weekly_checkins for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their clients check-ins" on public.weekly_checkins;
create policy "Coaches can read their clients check-ins"
  on public.weekly_checkins for select
  to authenticated
  using (public.task_coach_for(client_id) is not null);

revoke all on public.weekly_checkins from anon, authenticated;
grant select on public.weekly_checkins to authenticated;

-- ---------------------------------------------------------------------------
-- Private photo bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-checkin-photos',
  'apexfit-checkin-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Clients upload their own check-in photos" on storage.objects;
create policy "Clients upload their own check-in photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-checkin-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_client_account()
  );

drop policy if exists "Clients delete their own check-in photos" on storage.objects;
create policy "Clients delete their own check-in photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-checkin-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_client_account()
  );

-- The client reads their own photos; the coach side reads the photos of the clients they look after.
drop policy if exists "Check-in photos are read by their owner and coach" on storage.objects;
create policy "Check-in photos are read by their owner and coach"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-checkin-photos'
    and case
      when (storage.foldername(name))[1] = (select auth.uid())::text then public.is_client_account()
      when (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then public.task_coach_for(((storage.foldername(name))[1])::uuid) is not null
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- Client: send the week's check-in (again, until the coach has reviewed it)
-- ---------------------------------------------------------------------------
create or replace function public.submit_weekly_checkin(
  p_week_start date,
  p_weight_kg numeric,
  p_sleep_hours numeric,
  p_sleep_quality integer,
  p_workout_adherence integer,
  p_diet_adherence integer,
  p_energy integer,
  p_notes text,
  p_photo_paths jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_client uuid := auth.uid();
  v_coach uuid;
  v_notes text := btrim(coalesce(p_notes, ''));
  v_photos jsonb := coalesce(p_photo_paths, '{}'::jsonb);
  v_key text;
  v_path text;
  v_existing public.weekly_checkins%rowtype;
  v_row public.weekly_checkins%rowtype;
begin
  if v_client is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'The week must start on a Monday' using errcode = '22023';
  end if;
  if p_week_start > current_date + 1 or p_week_start < current_date - 13 then
    raise exception 'You can send the check-in for this week or last week' using errcode = '22023';
  end if;
  if p_weight_kg is not null and (p_weight_kg < 20 or p_weight_kg > 500) then
    raise exception 'Weight must be between 20 and 500 kg' using errcode = '22023';
  end if;
  if p_sleep_hours is not null and (p_sleep_hours < 0 or p_sleep_hours > 24) then
    raise exception 'Sleep must be between 0 and 24 hours' using errcode = '22023';
  end if;
  if p_sleep_quality is null or p_sleep_quality not between 1 and 5 then
    raise exception 'Rate your sleep quality from 1 to 5' using errcode = '22023';
  end if;
  if p_workout_adherence is null or p_workout_adherence not between 1 and 10 then
    raise exception 'Rate how well you followed the workouts from 1 to 10' using errcode = '22023';
  end if;
  if p_diet_adherence is null or p_diet_adherence not between 1 and 10 then
    raise exception 'Rate how well you followed your nutrition from 1 to 10' using errcode = '22023';
  end if;
  if p_energy is null or p_energy not between 1 and 5 then
    raise exception 'Rate your energy from 1 to 5' using errcode = '22023';
  end if;
  if char_length(v_notes) > 2000 then
    raise exception 'Notes can be up to 2000 characters' using errcode = '22023';
  end if;
  if jsonb_typeof(v_photos) <> 'object' then
    raise exception 'Photos must be an object with front, side and back' using errcode = '22023';
  end if;
  for v_key, v_path in select key, value #>> '{}' from jsonb_each(v_photos) loop
    if v_key not in ('front', 'side', 'back') then
      raise exception 'Photos can only be front, side or back' using errcode = '22023';
    end if;
    if v_path is null or v_path !~ ('^' || v_client::text || '/[A-Za-z0-9._-]{1,120}\.(jpg|jpeg|png|webp)$') then
      raise exception 'A photo path is not valid' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'apexfit-checkin-photos' and o.name = v_path) then
      raise exception 'A photo was not uploaded' using errcode = '22023';
    end if;
  end loop;

  select * into v_existing from public.weekly_checkins where client_id = v_client and week_start_date = p_week_start for update;
  if found and v_existing.status = 'reviewed' then
    raise exception 'This check-in was already reviewed and can no longer be changed' using errcode = '22023';
  end if;

  select cc.coach_id into v_coach
  from public.coach_clients cc
  where cc.client_id = v_client and cc.status = 'active'
  order by cc.created_at limit 1;

  insert into public.weekly_checkins (
    client_id, coach_id, week_start_date, weight_kg, sleep_hours, sleep_quality_1_5, workout_adherence_1_10,
    diet_adherence_1_10, energy_level_1_5, client_notes, photo_paths
  )
  values (
    v_client, v_coach, p_week_start, p_weight_kg, p_sleep_hours, p_sleep_quality, p_workout_adherence,
    p_diet_adherence, p_energy, v_notes, v_photos
  )
  on conflict (client_id, week_start_date) do update
  set coach_id = excluded.coach_id,
      weight_kg = excluded.weight_kg,
      sleep_hours = excluded.sleep_hours,
      sleep_quality_1_5 = excluded.sleep_quality_1_5,
      workout_adherence_1_10 = excluded.workout_adherence_1_10,
      diet_adherence_1_10 = excluded.diet_adherence_1_10,
      energy_level_1_5 = excluded.energy_level_1_5,
      client_notes = excluded.client_notes,
      photo_paths = excluded.photo_paths,
      updated_at = now()
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- ---------------------------------------------------------------------------
-- Coach side: review a check-in
-- ---------------------------------------------------------------------------
create or replace function public.review_weekly_checkin(p_checkin_id uuid, p_feedback text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_checkin public.weekly_checkins%rowtype;
  v_feedback text := btrim(coalesce(p_feedback, ''));
  v_row public.weekly_checkins%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  select * into v_checkin from public.weekly_checkins where id = p_checkin_id for update;
  if not found or public.task_coach_for(v_checkin.client_id) is null then
    raise exception 'Check-in was not found' using errcode = 'P0002';
  end if;
  if char_length(v_feedback) not between 1 and 2000 then
    raise exception 'Write feedback of 1 to 2000 characters' using errcode = '22023';
  end if;
  update public.weekly_checkins
  set status = 'reviewed', coach_feedback = v_feedback, reviewed_at = now(), reviewed_by = auth.uid(), updated_at = now()
  where id = p_checkin_id
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- The coach's inbox (or the history of one client): each check-in with the client's name and the numbers of the
-- week before, so the screen can show what changed.
create or replace function public.get_checkins_for_coach(p_status text default null, p_client_id uuid default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
begin
  if auth.uid() is null or (p_status is not null and p_status not in ('submitted', 'reviewed')) then
    raise exception 'Choose submitted or reviewed' using errcode = '22023';
  end if;
  if p_client_id is not null and public.task_coach_for(p_client_id) is null then
    raise exception 'You can only see check-ins of your own clients' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.created_at desc)
    from (
      select c.id, c.client_id, c.week_start_date, c.weight_kg, c.sleep_hours, c.sleep_quality_1_5, c.workout_adherence_1_10,
             c.diet_adherence_1_10, c.energy_level_1_5, c.client_notes, c.photo_paths, c.status, c.coach_feedback,
             c.reviewed_at, c.created_at,
             coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client') as client_name,
             (
               select jsonb_build_object(
                 'week_start_date', p.week_start_date, 'weight_kg', p.weight_kg, 'sleep_hours', p.sleep_hours,
                 'sleep_quality_1_5', p.sleep_quality_1_5, 'workout_adherence_1_10', p.workout_adherence_1_10,
                 'diet_adherence_1_10', p.diet_adherence_1_10, 'energy_level_1_5', p.energy_level_1_5
               )
               from public.weekly_checkins p
               where p.client_id = c.client_id and p.week_start_date < c.week_start_date
               order by p.week_start_date desc limit 1
             ) as previous
      from public.weekly_checkins c
      left join lateral (
        select x.client_name, x.client_email from public.coach_clients x
        where x.client_id = c.client_id order by (x.coach_id = auth.uid()) desc, x.created_at limit 1
      ) cc on true
      where public.task_coach_for(c.client_id) is not null
        and (p_status is null or c.status = p_status)
        and (p_client_id is null or c.client_id = p_client_id)
      order by c.created_at desc
      limit v_limit
    ) r
  ), '[]'::jsonb);
end;
$$;

-- Has the signed-in client sent this week's check-in? p_today is the client's own date (the server accepts a day either way).
create or replace function public.get_my_checkin_status(p_today date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := case when p_today is not null and abs(p_today - current_date) <= 1 then p_today else current_date end;
  v_week date := date_trunc('week', v_today)::date;
  v_row public.weekly_checkins%rowtype;
  v_has_coach boolean;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  select exists (select 1 from public.coach_clients where client_id = auth.uid() and status = 'active') into v_has_coach;
  select * into v_row from public.weekly_checkins where client_id = auth.uid() and week_start_date = v_week;
  return jsonb_build_object(
    'week_start_date', v_week,
    'submitted', found,
    'status', case when found then v_row.status end,
    'has_coach', v_has_coach,
    'due', v_has_coach and not found
  );
end;
$$;

revoke all on function public.submit_weekly_checkin(date, numeric, numeric, integer, integer, integer, integer, text, jsonb) from public, anon;
revoke all on function public.review_weekly_checkin(uuid, text) from public, anon;
revoke all on function public.get_checkins_for_coach(text, uuid, integer) from public, anon;
revoke all on function public.get_my_checkin_status(date) from public, anon;
grant execute on function public.submit_weekly_checkin(date, numeric, numeric, integer, integer, integer, integer, text, jsonb) to authenticated;
grant execute on function public.review_weekly_checkin(uuid, text) to authenticated;
grant execute on function public.get_checkins_for_coach(text, uuid, integer) to authenticated;
grant execute on function public.get_my_checkin_status(date) to authenticated;

-- ===== 20261115003300_meal_plans.sql =====

-- Meal plans: a coach builds a plan of meals (breakfast, lunch, dinner, snack), each with foods in grams, calories and
-- macros, and alternatives for every food. A plan is either a reusable template or a plan given to one client. The
-- client sees their plan next to their food log and can copy any meal of it into their day with one tap.
--
-- Security: a coach reads and changes only their own plans, a client reads only the plans given to them. Nobody writes
-- the tables directly: plans are saved, given and deleted through functions that check who is asking and the numbers.
-- Giving a plan to a client makes a copy, so the template stays as it was.

create table if not exists public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  notes text not null default '' check (char_length(notes) <= 2000),
  is_template boolean not null default false,
  source_template_id uuid references public.meal_plans (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  check (not (is_template and client_id is not null))
);

create index if not exists meal_plans_coach_idx on public.meal_plans (coach_id, is_template, updated_at desc);
create index if not exists meal_plans_client_idx on public.meal_plans (client_id, updated_at desc) where client_id is not null;

create table if not exists public.meal_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.meal_plans (id) on delete cascade,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  position integer not null check (position >= 0),
  food_name text not null check (char_length(btrim(food_name)) between 1 and 160),
  food_ref text check (food_ref is null or char_length(food_ref) <= 80),
  grams numeric(7, 1) not null check (grams between 1 and 5000),
  calories numeric(7, 1) not null check (calories between 0 and 10000),
  protein_g numeric(6, 1) not null default 0 check (protein_g between 0 and 1000),
  carbs_g numeric(6, 1) not null default 0 check (carbs_g between 0 and 1000),
  fat_g numeric(6, 1) not null default 0 check (fat_g between 0 and 1000),
  notes text not null default '' check (char_length(notes) <= 300),
  -- [{ food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g }], at most 5 per food
  alternatives jsonb not null default '[]'::jsonb check (jsonb_typeof(alternatives) = 'array' and jsonb_array_length(alternatives) <= 5),
  unique (plan_id, meal_type, position)
);

create index if not exists meal_plan_items_plan_idx on public.meal_plan_items (plan_id, meal_type, position);

alter table public.meal_plans enable row level security;
alter table public.meal_plan_items enable row level security;

drop policy if exists "Coaches can read their meal plans" on public.meal_plans;
create policy "Coaches can read their meal plans"
  on public.meal_plans for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read the meal plans given to them" on public.meal_plans;
create policy "Clients can read the meal plans given to them"
  on public.meal_plans for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read the items of their meal plans" on public.meal_plan_items;
create policy "Coaches can read the items of their meal plans"
  on public.meal_plan_items for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (select 1 from public.meal_plans p where p.id = meal_plan_items.plan_id and p.coach_id = (select auth.uid()))
  );

drop policy if exists "Clients can read the items of their meal plans" on public.meal_plan_items;
create policy "Clients can read the items of their meal plans"
  on public.meal_plan_items for select
  to authenticated
  using (
    public.is_client_account()
    and exists (select 1 from public.meal_plans p where p.id = meal_plan_items.plan_id and p.client_id = (select auth.uid()))
  );

revoke all on public.meal_plans, public.meal_plan_items from anon, authenticated;
grant select on public.meal_plans, public.meal_plan_items to authenticated;

-- One food (or alternative) as the functions below accept it: name, grams and numbers inside the allowed ranges.
create or replace function public.meal_plan_food_valid(p_food jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if p_food is null or jsonb_typeof(p_food) <> 'object' then
    return false;
  end if;
  if jsonb_typeof(p_food -> 'food_name') is distinct from 'string' or char_length(btrim(p_food ->> 'food_name')) not between 1 and 160 then
    return false;
  end if;
  if p_food ? 'food_ref' and jsonb_typeof(p_food -> 'food_ref') not in ('string', 'null') then
    return false;
  end if;
  if char_length(coalesce(p_food ->> 'food_ref', '')) > 80 then
    return false;
  end if;
  for v_key in select unnest(array['grams', 'calories', 'protein_g', 'carbs_g', 'fat_g']) loop
    if p_food ? v_key and jsonb_typeof(p_food -> v_key) not in ('number', 'null') then
      return false;
    end if;
  end loop;
  if jsonb_typeof(p_food -> 'grams') is distinct from 'number' or (p_food ->> 'grams')::numeric not between 1 and 5000 then
    return false;
  end if;
  if jsonb_typeof(p_food -> 'calories') is distinct from 'number' or (p_food ->> 'calories')::numeric not between 0 and 10000 then
    return false;
  end if;
  if coalesce((p_food ->> 'protein_g')::numeric, 0) not between 0 and 1000
    or coalesce((p_food ->> 'carbs_g')::numeric, 0) not between 0 and 1000
    or coalesce((p_food ->> 'fat_g')::numeric, 0) not between 0 and 1000 then
    return false;
  end if;
  return true;
end;
$$;

-- The alternatives of a food, cleaned to the stored shape.
create or replace function public.meal_plan_clean_alternatives(p_alternatives jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_alt jsonb;
  v_result jsonb := '[]'::jsonb;
begin
  if p_alternatives is null or jsonb_typeof(p_alternatives) = 'null' then
    return v_result;
  end if;
  if jsonb_typeof(p_alternatives) <> 'array' or jsonb_array_length(p_alternatives) > 5 then
    raise exception 'A food can have up to 5 alternatives' using errcode = '22023';
  end if;
  for v_alt in select value from jsonb_array_elements(p_alternatives) loop
    if not public.meal_plan_food_valid(v_alt) then
      raise exception 'An alternative needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'food_name', btrim(v_alt ->> 'food_name'),
      'food_ref', nullif(btrim(coalesce(v_alt ->> 'food_ref', '')), ''),
      'grams', round((v_alt ->> 'grams')::numeric, 1),
      'calories', round((v_alt ->> 'calories')::numeric, 1),
      'protein_g', round(coalesce((v_alt ->> 'protein_g')::numeric, 0), 1),
      'carbs_g', round(coalesce((v_alt ->> 'carbs_g')::numeric, 0), 1),
      'fat_g', round(coalesce((v_alt ->> 'fat_g')::numeric, 0), 1)
    ));
  end loop;
  return v_result;
end;
$$;

create or replace function public.require_meal_coach()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage meal plans' using errcode = '42501';
  end if;
end;
$$;

-- Creates a plan (p_plan_id null) or replaces the content of one of the caller's own plans. A plan is a template or
-- belongs to one of the coach's active clients.
create or replace function public.save_meal_plan(
  p_plan_id uuid,
  p_title text,
  p_notes text,
  p_is_template boolean,
  p_client_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_template boolean := coalesce(p_is_template, false);
  v_plan_id uuid;
  v_item jsonb;
  v_index bigint;
  v_counts jsonb := '{}'::jsonb;
  v_position integer;
  v_meal text;
begin
  perform public.require_meal_coach();
  if char_length(v_title) not between 1 and 120 then
    raise exception 'The plan name must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if char_length(v_notes) > 2000 then
    raise exception 'Notes can be up to 2000 characters' using errcode = '22023';
  end if;
  if v_template and p_client_id is not null then
    raise exception 'A template does not belong to a client' using errcode = '22023';
  end if;
  if not v_template and p_client_id is null then
    raise exception 'Choose an active client, or save the plan as a template' using errcode = '22023';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.coach_clients where coach_id = v_coach and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 60 then
    raise exception 'A plan can have up to 60 foods' using errcode = '22023';
  end if;

  if p_plan_id is null then
    insert into public.meal_plans (coach_id, client_id, title, notes, is_template)
    values (v_coach, p_client_id, v_title, v_notes, v_template)
    returning id into v_plan_id;
  else
    update public.meal_plans
    set title = v_title, notes = v_notes, is_template = v_template, client_id = p_client_id, updated_at = now()
    where id = p_plan_id and coach_id = v_coach
    returning id into v_plan_id;
    if v_plan_id is null then
      raise exception 'Meal plan was not found' using errcode = 'P0002';
    end if;
    delete from public.meal_plan_items where plan_id = v_plan_id;
  end if;

  for v_item, v_index in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
    v_meal := v_item ->> 'meal_type';
    if v_meal is null or v_meal not in ('breakfast', 'lunch', 'dinner', 'snack') then
      raise exception 'Each food needs a meal: breakfast, lunch, dinner or snack' using errcode = '22023';
    end if;
    if not public.meal_plan_food_valid(v_item) then
      raise exception 'Each food needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    if char_length(coalesce(v_item ->> 'notes', '')) > 300 then
      raise exception 'A food note can be up to 300 characters' using errcode = '22023';
    end if;
    v_position := coalesce((v_counts ->> v_meal)::integer, 0);
    v_counts := v_counts || jsonb_build_object(v_meal, v_position + 1);
    insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives)
    values (
      v_plan_id, v_meal, v_position, btrim(v_item ->> 'food_name'), nullif(btrim(coalesce(v_item ->> 'food_ref', '')), ''),
      round((v_item ->> 'grams')::numeric, 1), round((v_item ->> 'calories')::numeric, 1),
      round(coalesce((v_item ->> 'protein_g')::numeric, 0), 1), round(coalesce((v_item ->> 'carbs_g')::numeric, 0), 1),
      round(coalesce((v_item ->> 'fat_g')::numeric, 0), 1), btrim(coalesce(v_item ->> 'notes', '')),
      public.meal_plan_clean_alternatives(v_item -> 'alternatives')
    );
  end loop;
  return v_plan_id;
end;
$$;

-- Gives one of the coach's plans to one of their active clients: a copy that belongs to the client.
create or replace function public.assign_meal_plan(p_plan_id uuid, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := auth.uid();
  v_source public.meal_plans%rowtype;
  v_new uuid;
begin
  perform public.require_meal_coach();
  select * into v_source from public.meal_plans where id = p_plan_id and coach_id = v_coach;
  if not found then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.coach_clients where coach_id = v_coach and client_id = p_client_id and status = 'active') then
    raise exception 'Choose an active client' using errcode = '22023';
  end if;
  insert into public.meal_plans (coach_id, client_id, title, notes, is_template, source_template_id)
  values (v_coach, p_client_id, v_source.title, v_source.notes, false, case when v_source.is_template then v_source.id else v_source.source_template_id end)
  returning id into v_new;
  insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives)
  select v_new, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives
  from public.meal_plan_items where plan_id = p_plan_id;
  return v_new;
end;
$$;

create or replace function public.delete_meal_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_meal_coach();
  delete from public.meal_plans where id = p_plan_id and coach_id = auth.uid();
  if not found then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
end;
$$;

-- A plan with its foods in meal order, for the coach who owns it or the client it was given to.
create or replace function public.get_meal_plan(p_plan_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.meal_plans%rowtype;
begin
  select * into v_plan from public.meal_plans where id = p_plan_id;
  if not found
    or not (coalesce(v_plan.coach_id = auth.uid() and public.is_active_coach(), false) or coalesce(v_plan.client_id = auth.uid() and public.is_client_account(), false)) then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  return to_jsonb(v_plan) || jsonb_build_object('items', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', i.id, 'meal_type', i.meal_type, 'position', i.position, 'food_name', i.food_name, 'food_ref', i.food_ref,
        'grams', i.grams, 'calories', i.calories, 'protein_g', i.protein_g, 'carbs_g', i.carbs_g, 'fat_g', i.fat_g,
        'notes', i.notes, 'alternatives', i.alternatives
      )
      order by case i.meal_type when 'breakfast' then 1 when 'lunch' then 2 when 'dinner' then 3 else 4 end, i.position
    )
    from public.meal_plan_items i where i.plan_id = v_plan.id
  ), '[]'::jsonb));
end;
$$;

-- The newest plan given to the signed-in client, or null.
create or replace function public.get_my_meal_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  select id into v_id from public.meal_plans where client_id = auth.uid() order by updated_at desc, created_at desc limit 1;
  if v_id is null then
    return null;
  end if;
  return public.get_meal_plan(v_id) || jsonb_build_object(
    'coach_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = (select coach_id from public.meal_plans where id = v_id))
  );
end;
$$;

-- Copies foods of the client's plan into their food log for one day. p_choices: [{ item_id, alternative }] where
-- alternative is null (the food itself) or the position (from 0) of one of its alternatives.
create or replace function public.log_meal_plan_items(p_plan_id uuid, p_date date, p_choices jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_choice jsonb;
  v_item public.meal_plan_items%rowtype;
  v_alt jsonb;
  v_position integer;
  v_count integer := 0;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.meal_plans where id = p_plan_id and client_id = auth.uid()) then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 30 then
    raise exception 'Choose a day from the last 30 days up to today' using errcode = '22023';
  end if;
  if p_choices is null or jsonb_typeof(p_choices) <> 'array' or jsonb_array_length(p_choices) not between 1 and 20 then
    raise exception 'Choose between 1 and 20 foods to log' using errcode = '22023';
  end if;

  for v_choice in select value from jsonb_array_elements(p_choices) loop
    select * into v_item from public.meal_plan_items
    where id = (case when v_choice ->> 'item_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_choice ->> 'item_id')::uuid end)
      and plan_id = p_plan_id;
    if not found then
      raise exception 'A food is not part of this plan' using errcode = '22023';
    end if;
    if jsonb_typeof(v_choice -> 'alternative') = 'number' then
      v_position := (v_choice ->> 'alternative')::integer;
      v_alt := v_item.alternatives -> v_position;
      if v_alt is null then
        raise exception 'That alternative does not exist' using errcode = '22023';
      end if;
      insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, ingredients, calories, protein_g, carbs_g, fat_g)
      values (
        auth.uid(), p_date, v_item.meal_type, left(v_alt ->> 'food_name', 160), trim_scale((v_alt ->> 'grams')::numeric)::text || ' g',
        (v_alt ->> 'calories')::numeric, (v_alt ->> 'protein_g')::numeric, (v_alt ->> 'carbs_g')::numeric, (v_alt ->> 'fat_g')::numeric
      );
    else
      insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, ingredients, calories, protein_g, carbs_g, fat_g)
      values (auth.uid(), p_date, v_item.meal_type, v_item.food_name, trim_scale(v_item.grams)::text || ' g', v_item.calories, v_item.protein_g, v_item.carbs_g, v_item.fat_g);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.meal_plan_food_valid(jsonb) from public, anon, authenticated;
revoke all on function public.meal_plan_clean_alternatives(jsonb) from public, anon, authenticated;
revoke all on function public.require_meal_coach() from public, anon, authenticated;
revoke all on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) from public, anon;
revoke all on function public.assign_meal_plan(uuid, uuid) from public, anon;
revoke all on function public.delete_meal_plan(uuid) from public, anon;
revoke all on function public.get_meal_plan(uuid) from public, anon;
revoke all on function public.get_my_meal_plan() from public, anon;
revoke all on function public.log_meal_plan_items(uuid, date, jsonb) from public, anon;
grant execute on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) to authenticated;
grant execute on function public.assign_meal_plan(uuid, uuid) to authenticated;
grant execute on function public.delete_meal_plan(uuid) to authenticated;
grant execute on function public.get_meal_plan(uuid) to authenticated;
grant execute on function public.get_my_meal_plan() to authenticated;
grant execute on function public.log_meal_plan_items(uuid, date, jsonb) to authenticated;

-- ===== 20261115003400_progression_suggestions.sql =====

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

-- ===== 20261115003500_client_report_data.sql =====

-- The real numbers behind Jack's client analysis and progress report drafts, in one call for the coach side
-- (a coach, or an assistant trainer who may manage programs for a client assigned to them).
--
-- It gathers what already exists: the period statistics (workouts, volume, weight, food, sleep, steps, tasks), the
-- strongest lifts (best estimated one-rep max in the period against the period before), the last weekly check-ins,
-- water and habit totals, the client's goal and the open progression suggestions. Nothing is estimated or invented:
-- a number that does not exist is null.
create or replace function public.get_client_report_data(p_client_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 7), 180);
  v_from date := current_date - (least(greatest(coalesce(p_days, 30), 7), 180) - 1);
  v_before date := current_date - 2 * least(greatest(coalesce(p_days, 30), 7), 180) + 1;
begin
  if auth.uid() is null or public.task_coach_for(p_client_id) is null then
    raise exception 'You can only build reports for your own clients' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', v_days,
    'stats', public.progress_stats_for(p_client_id, v_days),
    'intake', (
      select jsonb_build_object(
        'primary_goal', f.primary_goal, 'experience_level', f.experience_level, 'training_days_per_week', f.training_days_per_week,
        'equipment_access', f.equipment_access, 'injuries', f.injuries, 'dietary_preferences', f.dietary_preferences
      )
      from public.client_intake_forms f where f.client_id = p_client_id
    ),
    'strength', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.best_now desc nulls last)
      from (
        select e.name as exercise_name, e.name_i18n as exercise_name_i18n,
               max(case when w.workout_date >= v_from then w.e1rm end) as best_now,
               max(case when w.workout_date < v_from then w.e1rm end) as best_before
        from (
          select l.exercise_id, s.workout_date,
                 round(case when l.actual_reps = 1 then l.actual_weight_kg else l.actual_weight_kg * (1 + l.actual_reps / 30.0) end, 1) as e1rm
          from public.client_workout_set_logs l
          join public.client_workout_sessions s on s.id = l.session_id
          where s.client_id = p_client_id and s.workout_date >= v_before and l.actual_weight_kg > 0 and l.actual_reps between 1 and 12
        ) w
        join public.exercises e on e.id = w.exercise_id
        group by e.id, e.name, e.name_i18n
        having max(case when w.workout_date >= v_from then w.e1rm end) is not null
        order by max(case when w.workout_date >= v_from then w.e1rm end) desc
        limit 5
      ) s
    ), '[]'::jsonb),
    'checkins', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.week_start_date desc)
      from (
        select week_start_date, weight_kg, sleep_hours, sleep_quality_1_5, workout_adherence_1_10, diet_adherence_1_10, energy_level_1_5, status
        from public.weekly_checkins where client_id = p_client_id and week_start_date >= v_from - 7
        order by week_start_date desc limit 6
      ) c
    ), '[]'::jsonb),
    'habits', jsonb_build_object(
      'avg_water_liters', (select round(avg(water_liters), 1) from public.client_habit_logs where client_id = p_client_id and habit_date >= v_from and water_liters is not null),
      'days_logged', (select count(*) from public.client_habit_logs where client_id = p_client_id and habit_date >= v_from),
      'custom', coalesce((
        select jsonb_agg(jsonb_build_object('name', h.name, 'kind', h.kind, 'days_done', (
          select count(*) from public.client_custom_habit_logs l
          where l.habit_id = h.id and l.log_date >= v_from and (h.kind = 'boolean' or l.value >= coalesce(h.daily_goal, 0))
        )) order by h.sort_order)
        from public.client_custom_habits h where h.client_id = p_client_id and h.status = 'active' and h.builtin_key is null
      ), '[]'::jsonb)
    ),
    'nutrition_target', (select to_jsonb(t) - 'client_id' - 'set_by' - 'updated_at' from public.nutrition_targets t where t.client_id = p_client_id),
    'pending_suggestions', (select count(*) from public.progression_suggestions where client_id = p_client_id and status = 'pending')
  );
end;
$$;

revoke all on function public.get_client_report_data(uuid, integer) from public, anon;
grant execute on function public.get_client_report_data(uuid, integer) to authenticated;

-- ===== 20261115003600_coach_exercise_videos.sql =====

-- A coach can attach their own demo video to any exercise of the library (YouTube, Vimeo or a direct MP4/WebM link).
-- The shared library is not touched: the choice belongs to that coach, is shown to that coach and to the clients linked
-- to them, and takes the place of the library's own video for those people only.
--
-- Security: a coach reads and writes only their own links (writes through set_exercise_video, which checks the link);
-- a client reads the links of the coaches they are actively linked to. Links must be https, without credentials, from
-- YouTube, Vimeo or a direct video file.

create table if not exists public.coach_exercise_videos (
  coach_id uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  video_url text not null check (char_length(video_url) between 12 and 500),
  updated_at timestamptz not null default now(),
  primary key (coach_id, exercise_id)
);

create index if not exists coach_exercise_videos_exercise_idx on public.coach_exercise_videos (exercise_id);

alter table public.coach_exercise_videos enable row level security;

drop policy if exists "Coaches can read their own exercise videos" on public.coach_exercise_videos;
create policy "Coaches can read their own exercise videos"
  on public.coach_exercise_videos for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read the exercise videos of their coach" on public.coach_exercise_videos;
create policy "Clients can read the exercise videos of their coach"
  on public.coach_exercise_videos for select
  to authenticated
  using (
    public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = coach_exercise_videos.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
  );

revoke all on public.coach_exercise_videos from anon, authenticated;
grant select on public.coach_exercise_videos to authenticated;

-- True for an https link to YouTube, Vimeo or a video file, with no embedded login.
create or replace function public.exercise_video_url_valid(p_url text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_url is not null
    and p_url !~ '[[:space:]]'
    and p_url !~ '^https://[^/]*@'
    and (
      p_url ~* '^https://(www\.|m\.)?(youtube\.com|youtube-nocookie\.com)/[^[:space:]]+$'
      or p_url ~* '^https://youtu\.be/[A-Za-z0-9_-]{11}([?&#][^[:space:]]*)?$'
      or p_url ~* '^https://(www\.)?vimeo\.com/[^[:space:]]*[0-9]+[^[:space:]]*$'
      or p_url ~* '^https://player\.vimeo\.com/video/[0-9]+([?&#][^[:space:]]*)?$'
      or p_url ~* '^https://[^/[:space:]]+/[^[:space:]]*\.(mp4|webm)([?#][^[:space:]]*)?$'
    );
$$;

-- Sets (or, with an empty link, removes) the coach's own video for one exercise.
create or replace function public.set_exercise_video(p_exercise_id uuid, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to change exercise videos' using errcode = '42501';
  end if;
  if not exists (select 1 from public.exercises where id = p_exercise_id and is_published) then
    raise exception 'Exercise was not found' using errcode = 'P0002';
  end if;
  if v_url = '' then
    delete from public.coach_exercise_videos where coach_id = auth.uid() and exercise_id = p_exercise_id;
    return jsonb_build_object('exercise_id', p_exercise_id, 'video_url', null);
  end if;
  if char_length(v_url) not between 12 and 500 or not public.exercise_video_url_valid(v_url) then
    raise exception 'Use a secure https link to a YouTube or Vimeo video, or to an MP4 or WebM file' using errcode = '22023';
  end if;
  insert into public.coach_exercise_videos (coach_id, exercise_id, video_url)
  values (auth.uid(), p_exercise_id, v_url)
  on conflict (coach_id, exercise_id) do update set video_url = excluded.video_url, updated_at = now();
  return jsonb_build_object('exercise_id', p_exercise_id, 'video_url', v_url);
end;
$$;

revoke all on function public.exercise_video_url_valid(text) from public, anon;
revoke all on function public.set_exercise_video(uuid, text) from public, anon;
grant execute on function public.exercise_video_url_valid(text) to authenticated, service_role;
grant execute on function public.set_exercise_video(uuid, text) to authenticated;

-- ===== 20261115003700_trial_14_days.sql =====

-- Free trial for new coach accounts: 14 days (336 hours) instead of 72 hours.
-- Existing coaches keep the window they already have, so the constraint accepts both lengths.
alter table public.profiles drop constraint if exists coach_trial_window;
alter table public.profiles add constraint coach_trial_window check (
  (
    role = 'coach'
    and trial_started_at is not null
    and trial_ends_at in (trial_started_at + interval '72 hours', trial_started_at + interval '336 hours')
  )
  or (role = 'client' and trial_started_at is null and trial_ends_at is null)
);

-- The role may come from the browser (OAuth) or from the sign-up metadata (email confirmation in another browser).
create or replace function public.provision_my_profile(p_role text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(p_role, auth.jwt() -> 'user_metadata' ->> 'signup_role');
  v_name text := left(nullif(btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', '')), ''), 80);
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    if v_role is null or v_role not in ('coach', 'client') then
      raise exception 'Choose a coach or client account before signing in';
    end if;

    insert into public.profiles (id, role, full_name, trial_started_at, trial_ends_at)
    values (
      auth.uid(),
      v_role,
      v_name,
      case when v_role = 'coach' then statement_timestamp() else null end,
      case when v_role = 'coach' then statement_timestamp() + interval '336 hours' else null end
    )
    on conflict (id) do nothing;
  end if;

  return public.get_my_access_status();
end;
$$;

revoke all on function public.provision_my_profile(text) from public, anon;
grant execute on function public.provision_my_profile(text) to authenticated;
-- ===== 20261115003800_coach_custom_exercises.sql =====

-- Coach custom exercises. A coach can add their own exercises (name, description, muscles, equipment, difficulty, a
-- photo and a YouTube / Vimeo / MP4 link). They live in the same table as the shared library so programs, workout logs
-- and progression keep working, but they are visible only to the owning coach, that coach's active clients and the
-- trainers of that coach's team. The shared library is unchanged.
--
-- Security: the table is read-only for the browser; every write goes through save_custom_exercise /
-- delete_custom_exercise, which check the account, the plan, the link and the photo path. Photos are stored in a private
-- bucket under a folder named after the coach and are read through short-lived signed links.

alter table public.exercises add column if not exists owner_coach_id uuid references public.profiles (id) on delete cascade;
alter table public.exercises add column if not exists description text not null default '';
alter table public.exercises add column if not exists secondary_muscles text[] not null default '{}';
alter table public.exercises add column if not exists image_path text;

alter table public.exercises drop constraint if exists exercises_description_check;
alter table public.exercises add constraint exercises_description_check check (char_length(description) <= 2000);
alter table public.exercises drop constraint if exists exercises_image_path_check;
alter table public.exercises add constraint exercises_image_path_check check (
  image_path is null
  or (owner_coach_id is not null and char_length(image_path) <= 300 and image_path like owner_coach_id::text || '/%')
);

create index if not exists exercises_owner_idx on public.exercises (owner_coach_id) where owner_coach_id is not null;

-- Reading: the shared library for everyone; custom exercises for the owner, their active clients and their trainers.
drop policy if exists "Anyone can read published exercises" on public.exercises;
drop policy if exists "Anyone can read published library exercises" on public.exercises;
create policy "Anyone can read published library exercises"
  on public.exercises for select
  to anon, authenticated
  using (is_published and owner_coach_id is null);

drop policy if exists "Coaches can read their custom exercises" on public.exercises;
create policy "Coaches can read their custom exercises"
  on public.exercises for select
  to authenticated
  using (owner_coach_id = (select auth.uid()));

drop policy if exists "Clients can read the custom exercises of their coach" on public.exercises;
create policy "Clients can read the custom exercises of their coach"
  on public.exercises for select
  to authenticated
  using (
    owner_coach_id is not null
    and is_published
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = exercises.owner_coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
  );

drop policy if exists "Trainers can read the custom exercises of their head coach" on public.exercises;
create policy "Trainers can read the custom exercises of their head coach"
  on public.exercises for select
  to authenticated
  using (owner_coach_id is not null and is_published and owner_coach_id = public.my_team_head());

-- A program may only contain library exercises or the custom exercises of the coach who owns the program.
create or replace function public.training_program_exercise_owner_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_coach uuid;
begin
  select owner_coach_id into v_owner from public.exercises where id = new.exercise_id;
  if v_owner is not null then
    select p.coach_id into v_coach
    from public.training_program_days d
    join public.training_programs p on p.id = d.program_id
    where d.id = new.day_id;
    if v_coach is distinct from v_owner then
      raise exception 'A program references an unavailable exercise';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists training_program_exercise_owner on public.training_program_exercises;
create trigger training_program_exercise_owner
  before insert or update of exercise_id, day_id on public.training_program_exercises
  for each row execute function public.training_program_exercise_owner_check();

-- Private bucket for the photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-exercise-images',
  'apexfit-exercise-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Coaches upload their exercise images" on storage.objects;
create policy "Coaches upload their exercise images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-exercise-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Coaches delete their exercise images" on storage.objects;
create policy "Coaches delete their exercise images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-exercise-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Exercise images are read by their coach, clients and trainers" on storage.objects;
create policy "Exercise images are read by their coach, clients and trainers"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-exercise-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (storage.foldername(name))[1] = (select public.my_team_head())::text
      or exists (
        select 1 from public.coach_clients cc
        where cc.coach_id = ((storage.foldername(name))[1])::uuid
          and cc.client_id = (select auth.uid())
          and cc.status = 'active'
      )
    )
  );

-- Validates and normalises a list of muscle / equipment keys (lower-case words, at most 8, no duplicates).
create or replace function public.custom_exercise_keys(p_values text[], p_max integer default 8)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_clean text[];
begin
  if p_values is null then
    return '{}';
  end if;
  select coalesce(array_agg(distinct lower(btrim(v))), '{}') into v_clean from unnest(p_values) as v where btrim(v) <> '';
  if cardinality(v_clean) > p_max then
    raise exception 'Choose at most % options per list', p_max using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_clean) as v where v !~ '^[a-z][a-z0-9_]{0,39}$') then
    raise exception 'A muscle or equipment option is not valid' using errcode = '22023';
  end if;
  return v_clean;
end;
$$;

-- Creates (p_exercise_id null) or updates one of the coach's own exercises.
create or replace function public.save_custom_exercise(
  p_name text,
  p_description text,
  p_category text,
  p_primary_muscles text[],
  p_secondary_muscles text[],
  p_equipment text[],
  p_difficulty text,
  p_video_url text,
  p_image_path text,
  p_exercise_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_video text := nullif(btrim(coalesce(p_video_url, '')), '');
  v_image text := nullif(btrim(coalesce(p_image_path, '')), '');
  v_primary text[];
  v_secondary text[];
  v_equipment text[];
  v_id uuid;
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage custom exercises' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 160 then
    raise exception 'Exercise name must be between 1 and 160 characters' using errcode = '22023';
  end if;
  if char_length(v_description) > 2000 then
    raise exception 'Exercise description cannot exceed 2000 characters' using errcode = '22023';
  end if;
  if p_category is null or p_category not in ('strength', 'cardio', 'mobility', 'plyometrics', 'warmup') then
    raise exception 'Choose a valid exercise category' using errcode = '22023';
  end if;
  if p_difficulty is null or p_difficulty not in ('beginner', 'intermediate', 'advanced') then
    raise exception 'Choose a valid difficulty' using errcode = '22023';
  end if;

  v_primary := public.custom_exercise_keys(p_primary_muscles, 6);
  v_secondary := public.custom_exercise_keys(p_secondary_muscles, 8);
  v_equipment := public.custom_exercise_keys(p_equipment, 8);
  if cardinality(v_primary) = 0 then
    raise exception 'Choose at least one primary muscle' using errcode = '22023';
  end if;

  if v_video is not null and (char_length(v_video) not between 12 and 500 or not public.exercise_video_url_valid(v_video)) then
    raise exception 'Use a secure https link to a YouTube or Vimeo video, or to an MP4 or WebM file' using errcode = '22023';
  end if;

  if v_image is not null then
    if v_image not like auth.uid()::text || '/%' or char_length(v_image) > 300 then
      raise exception 'The exercise photo is not valid' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'apexfit-exercise-images' and o.name = v_image) then
      raise exception 'The exercise photo was not uploaded' using errcode = '22023';
    end if;
  end if;

  if p_exercise_id is null then
    if (select count(*) from public.exercises where owner_coach_id = auth.uid()) >= 300 then
      raise exception 'You can keep up to 300 custom exercises' using errcode = '54000';
    end if;
    v_id := gen_random_uuid();
    insert into public.exercises (
      id, slug, name, category, primary_muscles, secondary_muscles, equipment, difficulty,
      description, demo_video_url, image_path, thumbnail_url, is_published, owner_coach_id
    )
    values (
      v_id, 'custom-' || v_id::text, v_name, p_category, v_primary, v_secondary, v_equipment, p_difficulty,
      v_description, v_video, v_image, null, true, auth.uid()
    );
  else
    update public.exercises
    set name = v_name,
        category = p_category,
        primary_muscles = v_primary,
        secondary_muscles = v_secondary,
        equipment = v_equipment,
        difficulty = p_difficulty,
        description = v_description,
        demo_video_url = v_video,
        image_path = v_image,
        updated_at = now()
    where id = p_exercise_id and owner_coach_id = auth.uid()
    returning id into v_id;
    if v_id is null then
      raise exception 'Exercise was not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- Deletes one of the coach's own exercises and returns its photo path so the browser can remove the file.
create or replace function public.delete_custom_exercise(p_exercise_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image text;
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage custom exercises' using errcode = '42501';
  end if;
  select image_path into v_image from public.exercises where id = p_exercise_id and owner_coach_id = auth.uid();
  if not found then
    raise exception 'Exercise was not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.training_program_exercises where exercise_id = p_exercise_id)
    or exists (select 1 from public.client_workout_set_logs where exercise_id = p_exercise_id) then
    raise exception 'This exercise is used in a program or a workout log, so it cannot be deleted' using errcode = '23503';
  end if;
  delete from public.exercises where id = p_exercise_id and owner_coach_id = auth.uid();
  return jsonb_build_object('exercise_id', p_exercise_id, 'image_path', v_image);
end;
$$;

revoke all on function public.training_program_exercise_owner_check() from public, anon, authenticated;
revoke all on function public.custom_exercise_keys(text[], integer) from public, anon;
revoke all on function public.save_custom_exercise(text, text, text, text[], text[], text[], text, text, text, uuid) from public, anon;
revoke all on function public.delete_custom_exercise(uuid) from public, anon;
grant execute on function public.custom_exercise_keys(text[], integer) to authenticated;
grant execute on function public.save_custom_exercise(text, text, text, text[], text[], text[], text, text, text, uuid) to authenticated;
grant execute on function public.delete_custom_exercise(uuid) to authenticated;
-- Removing a coach account must not be blocked by programs or client workout history that still point at their
-- exercises: the programs go with the coach, and an exercise that clients have logged is kept hidden so their
-- history stays intact.
create or replace function public.detach_custom_exercises_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.exercises where owner_coach_id = old.id) then
    delete from public.training_programs where coach_id = old.id;
    update public.exercises e
    set owner_coach_id = null, is_published = false, image_path = null
    where e.owner_coach_id = old.id
      and exists (select 1 from public.client_workout_set_logs l where l.exercise_id = e.id);
  end if;
  return old;
end;
$$;

drop trigger if exists profiles_detach_custom_exercises on public.profiles;
create trigger profiles_detach_custom_exercises
  before delete on public.profiles
  for each row execute function public.detach_custom_exercises_on_profile_delete();

revoke all on function public.detach_custom_exercises_on_profile_delete() from public, anon, authenticated;
-- ===== 20261115003900_program_exercise_tempo.sql =====

-- Tempo for program exercises, e.g. 3-1-1-0: seconds lowering (eccentric), pause at the bottom, lifting (concentric),
-- pause at the top. Each part is a digit, or X for "as fast as possible". The column is optional (empty = no tempo).
-- Coaches write it through save_training_program / duplicate_training_program; clients read the programs assigned to
-- them through get_my_assigned_programs (a client has no direct access to the program tables).

alter table public.training_program_exercises add column if not exists tempo text not null default '';
alter table public.training_program_exercises drop constraint if exists training_program_exercises_tempo_check;
alter table public.training_program_exercises add constraint training_program_exercises_tempo_check
  check (tempo = '' or tempo ~ '^[0-9X]-[0-9X]-[0-9X]-[0-9X]$');
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
  v_tempo text;
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
      v_tempo := upper(btrim(coalesce(v_exercise ->> 'tempo', '')));
      if v_tempo <> '' and v_tempo !~ '^[0-9X]-[0-9X]-[0-9X]-[0-9X]$' then
        raise exception 'Tempo must have four parts such as 3-1-1-0 (digits, or X for explosive)';
      end if;

      insert into public.training_program_exercises (
        day_id, exercise_id, order_index, sets, reps, rest_seconds, notes, tempo
      )
      values (
        v_day_id,
        v_exercise_id,
        v_exercise_index::integer - 1,
        v_sets,
        v_reps,
        v_rest_seconds,
        v_notes,
        v_tempo
      );
    end loop;
  end loop;

  return v_program_id;
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
      day_id, exercise_id, order_index, sets, reps, rest_seconds, notes, tempo
    )
    select v_new_day_id, e.exercise_id, e.order_index, e.sets, e.reps, e.rest_seconds, e.notes, e.tempo
    from public.training_program_exercises e
    where e.day_id = v_day.id;
  end loop;

  return v_new_program_id;
end;
$$;

revoke all on function public.save_training_program(text, text, jsonb, uuid) from public;
grant execute on function public.save_training_program(text, text, jsonb, uuid) to authenticated;
revoke all on function public.duplicate_training_program(uuid, text, boolean) from public;
grant execute on function public.duplicate_training_program(uuid, text, boolean) to authenticated;

-- The programs a coach has assigned to the signed-in client (the latest assignment of each program, newest first,
-- at most three), with sets, reps, rest, tempo and notes for every exercise.
create or replace function public.get_my_assigned_programs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(s.program order by s.assigned_at desc)
    from (
      select a.assigned_at, jsonb_build_object(
        'program_id', a.program_id,
        'title', a.title,
        'description', a.description,
        'assigned_at', a.assigned_at,
        'days', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', d.id,
              'name', d.name,
              'exercises', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', pe.id,
                    'exercise_id', pe.exercise_id,
                    'sets', pe.sets,
                    'reps', pe.reps,
                    'rest_seconds', pe.rest_seconds,
                    'tempo', pe.tempo,
                    'notes', pe.notes,
                    'exercise', jsonb_build_object(
                      'id', e.id, 'slug', e.slug, 'name', e.name, 'name_i18n', e.name_i18n, 'category', e.category,
                      'difficulty', e.difficulty, 'primary_muscles', e.primary_muscles, 'equipment', e.equipment,
                      'demo_video_url', e.demo_video_url, 'thumbnail_url', e.thumbnail_url, 'animation_url', e.animation_url,
                      'image_frames', e.image_frames, 'owner_coach_id', e.owner_coach_id, 'image_path', e.image_path,
                      'description', e.description
                    )
                  )
                  order by pe.order_index
                )
                from public.training_program_exercises pe
                join public.exercises e on e.id = pe.exercise_id
                where pe.day_id = d.id
              ), '[]'::jsonb)
            )
            order by d.order_index
          )
          from public.training_program_days d
          where d.program_id = a.program_id
        ), '[]'::jsonb)
      ) as program
      from (
        select distinct on (pa.program_id) pa.program_id, pa.assigned_at, p.title, p.description
        from public.program_assignments pa
        join public.training_programs p on p.id = pa.program_id
        where pa.client_id = auth.uid()
          and exists (
            select 1 from public.coach_clients cc
            where cc.coach_id = pa.coach_id and cc.client_id = pa.client_id and cc.status = 'active'
          )
        order by pa.program_id, pa.assigned_at desc
      ) a
      order by a.assigned_at desc
      limit 3
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_my_assigned_programs() from public, anon;
grant execute on function public.get_my_assigned_programs() to authenticated;
-- ===== 20261115004000_calorie_calculator.sql =====

-- Calorie calculator support for coaches. The calculator itself (BMR / TDEE / macros) runs in the browser; the database
-- keeps the few facts it needs about a client that are not recorded anywhere else (sex, date of birth, height override,
-- activity level, goal and formula) and hands the coach everything already known (latest weight, body fat, intake height,
-- current daily goal). The result is written with the existing set_client_nutrition_targets function.
--
-- Security: a coach reads and writes only the rows of their own active clients, through security definer functions.

create table if not exists public.client_body_profiles (
  coach_id uuid not null,
  client_id uuid not null,
  sex text check (sex in ('male', 'female')),
  birth_date date check (birth_date between date '1900-01-01' and date '2100-01-01'),
  height_cm numeric(5, 1) check (height_cm between 50 and 275),
  activity_level text check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  goal text check (goal in ('cut', 'maintain', 'bulk')),
  formula text check (formula in ('mifflin', 'harris', 'katch')),
  updated_at timestamptz not null default now(),
  primary key (coach_id, client_id),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

alter table public.client_body_profiles enable row level security;

drop policy if exists "Coaches can read the body profiles of their clients" on public.client_body_profiles;
create policy "Coaches can read the body profiles of their clients"
  on public.client_body_profiles for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.client_body_profiles from anon, authenticated;
grant select on public.client_body_profiles to authenticated;

-- What the calculator can fill in on its own for one client.
create or replace function public.get_client_calculator_data(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.client_body_profiles%rowtype;
  v_weight record;
  v_fat record;
  v_intake record;
  v_target record;
begin
  if not public.is_active_coach() or not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client was not found' using errcode = 'P0002';
  end if;

  select * into v_profile from public.client_body_profiles where coach_id = auth.uid() and client_id = p_client_id;
  select weight_kg, measured_on into v_weight
  from public.client_body_metrics where client_id = p_client_id and weight_kg is not null
  order by measured_on desc limit 1;
  select body_fat_percentage, measured_on into v_fat
  from public.client_body_metrics where client_id = p_client_id and body_fat_percentage is not null
  order by measured_on desc limit 1;
  select height_cm, primary_goal into v_intake from public.client_intake_forms where client_id = p_client_id;
  select calories, protein_g, carbs_g, fats_g, updated_at into v_target from public.nutrition_targets where client_id = p_client_id;

  return jsonb_build_object(
    'client_id', p_client_id,
    'sex', v_profile.sex,
    'birth_date', v_profile.birth_date,
    'activity_level', v_profile.activity_level,
    'goal', v_profile.goal,
    'formula', v_profile.formula,
    'height_cm', coalesce(v_profile.height_cm, v_intake.height_cm),
    'height_source', case when v_profile.height_cm is not null then 'profile' when v_intake.height_cm is not null then 'intake' else null end,
    'weight_kg', v_weight.weight_kg,
    'weight_date', v_weight.measured_on,
    'body_fat_pct', v_fat.body_fat_percentage,
    'body_fat_date', v_fat.measured_on,
    'intake_goal', v_intake.primary_goal,
    'target', case when v_target.calories is null and v_target.protein_g is null and v_target.carbs_g is null and v_target.fats_g is null
      then null
      else jsonb_build_object('calories', v_target.calories, 'protein_g', v_target.protein_g, 'carbs_g', v_target.carbs_g, 'fats_g', v_target.fats_g, 'updated_at', v_target.updated_at) end
  );
end;
$$;

-- Remembers the coach's inputs for a client so the next calculation starts from them. Every value is optional.
create or replace function public.save_client_calculator_profile(
  p_client_id uuid,
  p_sex text,
  p_birth_date date,
  p_height_cm numeric,
  p_activity_level text,
  p_goal text,
  p_formula text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() or not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client was not found' using errcode = 'P0002';
  end if;
  if p_sex is not null and p_sex not in ('male', 'female') then
    raise exception 'Choose male or female' using errcode = '22023';
  end if;
  if p_birth_date is not null and (p_birth_date > current_date - interval '10 years' or p_birth_date < current_date - interval '100 years') then
    raise exception 'Date of birth must give an age between 10 and 100' using errcode = '22023';
  end if;
  if p_height_cm is not null and p_height_cm not between 100 and 250 then
    raise exception 'Height must be between 100 and 250 cm' using errcode = '22023';
  end if;
  if p_activity_level is not null and p_activity_level not in ('sedentary', 'light', 'moderate', 'active', 'very_active') then
    raise exception 'Choose a valid activity level' using errcode = '22023';
  end if;
  if p_goal is not null and p_goal not in ('cut', 'maintain', 'bulk') then
    raise exception 'Choose a valid goal' using errcode = '22023';
  end if;
  if p_formula is not null and p_formula not in ('mifflin', 'harris', 'katch') then
    raise exception 'Choose a valid formula' using errcode = '22023';
  end if;

  insert into public.client_body_profiles (coach_id, client_id, sex, birth_date, height_cm, activity_level, goal, formula)
  values (auth.uid(), p_client_id, p_sex, p_birth_date, p_height_cm, p_activity_level, p_goal, p_formula)
  on conflict (coach_id, client_id) do update
  set sex = excluded.sex,
      birth_date = excluded.birth_date,
      height_cm = excluded.height_cm,
      activity_level = excluded.activity_level,
      goal = excluded.goal,
      formula = excluded.formula,
      updated_at = now();
end;
$$;

revoke all on function public.get_client_calculator_data(uuid) from public, anon;
revoke all on function public.save_client_calculator_profile(uuid, text, date, numeric, text, text, text) from public, anon;
grant execute on function public.get_client_calculator_data(uuid) to authenticated;
grant execute on function public.save_client_calculator_profile(uuid, text, date, numeric, text, text, text) to authenticated;
-- ===== 20261115004100_ramadan_meals.sql =====

-- Ramadan meal categories: before iftar (pre_iftar), iftar and suhoor, next to breakfast, lunch, dinner and snack.
-- They are available in meal plans (meal_plan_items) and in the client's food log (client_food_logs). Whether the
-- extra categories are offered is a display choice made in the app; the database accepts all seven in both places.

alter table public.client_food_logs drop constraint if exists client_food_logs_meal_type_check;
alter table public.client_food_logs add constraint client_food_logs_meal_type_check
  check (meal_type in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor'));

alter table public.meal_plan_items drop constraint if exists meal_plan_items_meal_type_check;
alter table public.meal_plan_items add constraint meal_plan_items_meal_type_check
  check (meal_type in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor'));
create or replace function public.save_meal_plan(
  p_plan_id uuid,
  p_title text,
  p_notes text,
  p_is_template boolean,
  p_client_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_template boolean := coalesce(p_is_template, false);
  v_plan_id uuid;
  v_item jsonb;
  v_index bigint;
  v_counts jsonb := '{}'::jsonb;
  v_position integer;
  v_meal text;
begin
  perform public.require_meal_coach();
  if char_length(v_title) not between 1 and 120 then
    raise exception 'The plan name must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if char_length(v_notes) > 2000 then
    raise exception 'Notes can be up to 2000 characters' using errcode = '22023';
  end if;
  if v_template and p_client_id is not null then
    raise exception 'A template does not belong to a client' using errcode = '22023';
  end if;
  if not v_template and p_client_id is null then
    raise exception 'Choose an active client, or save the plan as a template' using errcode = '22023';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.coach_clients where coach_id = v_coach and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 60 then
    raise exception 'A plan can have up to 60 foods' using errcode = '22023';
  end if;

  if p_plan_id is null then
    insert into public.meal_plans (coach_id, client_id, title, notes, is_template)
    values (v_coach, p_client_id, v_title, v_notes, v_template)
    returning id into v_plan_id;
  else
    update public.meal_plans
    set title = v_title, notes = v_notes, is_template = v_template, client_id = p_client_id, updated_at = now()
    where id = p_plan_id and coach_id = v_coach
    returning id into v_plan_id;
    if v_plan_id is null then
      raise exception 'Meal plan was not found' using errcode = 'P0002';
    end if;
    delete from public.meal_plan_items where plan_id = v_plan_id;
  end if;

  for v_item, v_index in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
    v_meal := v_item ->> 'meal_type';
    if v_meal is null or v_meal not in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor') then
      raise exception 'Each food needs a meal: breakfast, lunch, dinner, snack or a Ramadan meal (before iftar, iftar, suhoor)' using errcode = '22023';
    end if;
    if not public.meal_plan_food_valid(v_item) then
      raise exception 'Each food needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    if char_length(coalesce(v_item ->> 'notes', '')) > 300 then
      raise exception 'A food note can be up to 300 characters' using errcode = '22023';
    end if;
    v_position := coalesce((v_counts ->> v_meal)::integer, 0);
    v_counts := v_counts || jsonb_build_object(v_meal, v_position + 1);
    insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives)
    values (
      v_plan_id, v_meal, v_position, btrim(v_item ->> 'food_name'), nullif(btrim(coalesce(v_item ->> 'food_ref', '')), ''),
      round((v_item ->> 'grams')::numeric, 1), round((v_item ->> 'calories')::numeric, 1),
      round(coalesce((v_item ->> 'protein_g')::numeric, 0), 1), round(coalesce((v_item ->> 'carbs_g')::numeric, 0), 1),
      round(coalesce((v_item ->> 'fat_g')::numeric, 0), 1), btrim(coalesce(v_item ->> 'notes', '')),
      public.meal_plan_clean_alternatives(v_item -> 'alternatives')
    );
  end loop;
  return v_plan_id;
end;
$$;

create or replace function public.get_meal_plan(p_plan_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.meal_plans%rowtype;
begin
  select * into v_plan from public.meal_plans where id = p_plan_id;
  if not found
    or not (coalesce(v_plan.coach_id = auth.uid() and public.is_active_coach(), false) or coalesce(v_plan.client_id = auth.uid() and public.is_client_account(), false)) then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  return to_jsonb(v_plan) || jsonb_build_object('items', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', i.id, 'meal_type', i.meal_type, 'position', i.position, 'food_name', i.food_name, 'food_ref', i.food_ref,
        'grams', i.grams, 'calories', i.calories, 'protein_g', i.protein_g, 'carbs_g', i.carbs_g, 'fat_g', i.fat_g,
        'notes', i.notes, 'alternatives', i.alternatives
      )
      order by case i.meal_type when 'breakfast' then 1 when 'lunch' then 2 when 'pre_iftar' then 3 when 'iftar' then 4 when 'dinner' then 5 when 'snack' then 6 else 7 end, i.position
    )
    from public.meal_plan_items i where i.plan_id = v_plan.id
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) from public, anon;
revoke all on function public.get_meal_plan(uuid) from public, anon;
grant execute on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) to authenticated;
grant execute on function public.get_meal_plan(uuid) to authenticated;