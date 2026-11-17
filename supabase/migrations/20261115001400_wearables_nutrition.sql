-- Wearables (Apple Health, Fitbit, Garmin, Oura) and nutrition tracking (MyFitnessPal exports and manual entries).
-- Rows are read through row-level security. Clients write through security definer functions that validate
-- every value; OAuth tokens are written only by the server (service role) and are never readable by the browser.

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
  provider text not null check (provider in ('apple_health', 'fitbit', 'garmin', 'oura')),
  status text not null default 'connected' check (status in ('connected', 'disconnected', 'error')),
  access_token_encrypted text check (access_token_encrypted is null or char_length(access_token_encrypted) <= 4000),
  refresh_token_encrypted text check (refresh_token_encrypted is null or char_length(refresh_token_encrypted) <= 4000),
  token_expires_at timestamptz,
  external_user_id text check (external_user_id is null or char_length(external_user_id) <= 100),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, provider),
  -- A connected cloud account always holds a token; Apple Health is imported from a file and has none.
  check (provider = 'apple_health' or status <> 'connected' or access_token_encrypted is not null or refresh_token_encrypted is not null)
);

create index if not exists wearable_connections_client_idx on public.wearable_connections (client_id);

create table if not exists public.wearable_daily_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles (id) on delete cascade,
  recorded_date date not null,
  provider text not null check (provider in ('apple_health', 'fitbit', 'garmin', 'oura', 'manual')),
  steps integer check (steps between 0 and 200000),
  active_calories integer check (active_calories between 0 and 20000),
  sleep_minutes integer check (sleep_minutes between 0 and 1440),
  resting_heart_rate integer check (resting_heart_rate between 20 and 250),
  hrv_ms numeric(6, 2) check (hrv_ms between 0 and 500),
  recovery_score integer check (recovery_score between 0 and 100),
  raw_payload jsonb check (raw_payload is null or (jsonb_typeof(raw_payload) = 'object' and octet_length(raw_payload::text) <= 8000)),
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
-- Column grants keep the encrypted OAuth tokens out of reach of every browser session.
grant select (id, client_id, provider, status, external_user_id, last_error, last_synced_at, created_at)
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
create or replace function public.wearable_metrics_upsert(p_client_id uuid, p_provider text, p_metrics jsonb, p_allow_raw boolean)
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
  v_raw jsonb;
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

    v_raw := case when p_allow_raw and jsonb_typeof(v_row -> 'raw') = 'object' then v_row -> 'raw' else null end;
    if v_raw is not null and octet_length(v_raw::text) > 8000 then
      raise exception 'The raw data of % is too large', v_date;
    end if;

    insert into public.wearable_daily_metrics (
      client_id, recorded_date, provider, steps, active_calories, sleep_minutes, resting_heart_rate, hrv_ms, recovery_score, raw_payload
    )
    values (p_client_id, v_date, p_provider, v_steps, v_calories, v_sleep, v_rhr, v_hrv, v_recovery, v_raw)
    on conflict (client_id, recorded_date, provider) do update
    set steps = coalesce(excluded.steps, wearable_daily_metrics.steps),
        active_calories = coalesce(excluded.active_calories, wearable_daily_metrics.active_calories),
        sleep_minutes = coalesce(excluded.sleep_minutes, wearable_daily_metrics.sleep_minutes),
        resting_heart_rate = coalesce(excluded.resting_heart_rate, wearable_daily_metrics.resting_heart_rate),
        hrv_ms = coalesce(excluded.hrv_ms, wearable_daily_metrics.hrv_ms),
        recovery_score = coalesce(excluded.recovery_score, wearable_daily_metrics.recovery_score),
        raw_payload = coalesce(excluded.raw_payload, wearable_daily_metrics.raw_payload),
        synced_at = statement_timestamp();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.health_number(jsonb, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.health_date(jsonb, text, integer, integer) from public, anon, authenticated;
revoke all on function public.wearable_metrics_upsert(uuid, text, jsonb, boolean) from public, anon, authenticated;

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

  v_saved := public.wearable_metrics_upsert(auth.uid(), p_provider, p_metrics, false);

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
  if p_provider is null or p_provider not in ('apple_health', 'fitbit', 'garmin', 'oura', 'manual') then
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
-- Functions for the server (service role only)
-- ---------------------------------------------------------------------------

-- OAuth syncs (Fitbit, Garmin, Oura) save normalized days here. Raw provider data may be attached per day.
create or replace function public.service_save_wearable_metrics(p_client_id uuid, p_provider text, p_metrics jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_provider is null or p_provider not in ('fitbit', 'garmin', 'oura') then
    raise exception 'Unsupported provider';
  end if;
  if not exists (select 1 from public.profiles where id = p_client_id and role = 'client') then
    raise exception 'Client was not found';
  end if;
  return public.wearable_metrics_upsert(p_client_id, p_provider, p_metrics, true);
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

revoke all on function public.service_save_wearable_metrics(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.service_save_wearable_metrics(uuid, text, jsonb) to service_role;
