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

