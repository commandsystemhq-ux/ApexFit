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
