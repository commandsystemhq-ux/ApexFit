-- ApexFit Supabase setup. Run this file once in the Supabase SQL Editor.
-- Migration files are concatenated in filename order.

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
  workout_date date not null default current_date check (workout_date <= current_date),
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
  measured_on date not null default current_date check (measured_on <= current_date),
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
  habit_date date not null default current_date check (habit_date <= current_date),
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
  if p_workout_date is null or p_workout_date > current_date then
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
