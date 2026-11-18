-- Daily checklist (workout, meals, water, habits and own tasks) with optional Google Calendar reminders,
-- and the platform owner's own place to keep the keys of the connected services (Fitbit, Garmin, Oura, Google).

-- ---------------------------------------------------------------------------
-- Keys of the connected services, set by the platform owner
-- ---------------------------------------------------------------------------
-- Same rules as platform_ai_settings: the secret is encrypted by the server, and the app's roles (anon,
-- authenticated) have no access at all. Only the server, after checking PLATFORM_ADMIN_EMAILS, reads or writes it.

create table if not exists public.platform_integration_settings (
  provider text primary key check (provider in ('fitbit', 'garmin', 'oura', 'google')),
  client_id text not null check (char_length(client_id) between 1 and 300),
  client_secret_encrypted text not null check (char_length(client_secret_encrypted) between 1 and 4000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);

alter table public.platform_integration_settings enable row level security;

drop policy if exists "Service role manages the integration keys" on public.platform_integration_settings;
create policy "Service role manages the integration keys"
  on public.platform_integration_settings for all
  to service_role
  using (true)
  with check (true);

revoke all on public.platform_integration_settings from public, anon, authenticated;
grant all on public.platform_integration_settings to service_role;

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
  calendar_sync boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not calendar_sync or remind_time is not null)
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
  calendar_sync boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not calendar_sync or remind_time is not null)
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
    'remind_time', to_char(p_entry.remind_time, 'HH24:MI'),
    'calendar_sync', p_entry.calendar_sync
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
  insert into public.checklist_entries (client_id, task_date, template_id, category, title, target_amount, unit, remind_time, calendar_sync)
  select t.client_id, p_date, t.id, t.category, t.title, t.target_amount, t.unit, t.remind_time, t.calendar_sync
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
  p_repeat_days jsonb default null,
  p_calendar_sync boolean default false
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
  if coalesce(p_calendar_sync, false) and p_remind_time is null then
    raise exception 'Choose a time before adding the task to the calendar';
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
    insert into public.checklist_templates (client_id, category, title, target_amount, unit, days_of_week, remind_time, calendar_sync)
    values (auth.uid(), p_category, v_title, p_target, v_unit, v_days, p_remind_time, coalesce(p_calendar_sync, false))
    returning * into v_template;

    perform public.checklist_materialize(auth.uid(), p_date);
    select * into v_entry from public.checklist_entries where client_id = auth.uid() and task_date = p_date and template_id = v_template.id;
    return jsonb_build_object('template_id', v_template.id, 'entry', case when v_entry.id is null then null else public.checklist_entry_json(v_entry) end);
  end if;

  if (select count(*) from public.checklist_entries where client_id = auth.uid() and task_date = p_date) >= 100 then
    raise exception 'A day can have up to 100 tasks';
  end if;
  insert into public.checklist_entries (client_id, task_date, category, title, target_amount, unit, remind_time, calendar_sync)
  values (auth.uid(), p_date, p_category, v_title, p_target, v_unit, p_remind_time, coalesce(p_calendar_sync, false))
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

-- Sets the reminder time and whether the task is added to the calendar. For a repeating task it applies from this
-- day on and to the template.
create or replace function public.update_checklist_calendar(p_entry_id uuid, p_remind_time time, p_sync boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry public.checklist_entries;
  v_sync boolean := coalesce(p_sync, false);
begin
  perform public.checklist_require_client();
  select * into v_entry from public.checklist_entries where id = p_entry_id and client_id = auth.uid() for update;
  if not found then
    raise exception 'That task was not found';
  end if;
  if v_sync and p_remind_time is null then
    raise exception 'Choose a time before adding the task to the calendar';
  end if;

  if v_entry.template_id is not null then
    update public.checklist_templates set remind_time = p_remind_time, calendar_sync = v_sync, updated_at = statement_timestamp()
    where id = v_entry.template_id and client_id = auth.uid();
    update public.checklist_entries set remind_time = p_remind_time, calendar_sync = v_sync, updated_at = statement_timestamp()
    where template_id = v_entry.template_id and client_id = auth.uid() and task_date >= v_entry.task_date;
  else
    update public.checklist_entries set remind_time = p_remind_time, calendar_sync = v_sync, updated_at = statement_timestamp()
    where id = v_entry.id;
  end if;
  select * into v_entry from public.checklist_entries where id = p_entry_id;
  return public.checklist_entry_json(v_entry);
end;
$$;

-- Removes a task. A repeating task is removed for good (its template and this day onward; earlier days stay as
-- history). The ids come back so the calendar events can be removed too.
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
    update public.checklist_entries set calendar_sync = false
    where template_id = v_entry.template_id and client_id = auth.uid() and task_date < v_entry.task_date;
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

-- ---------------------------------------------------------------------------
-- Google Calendar connection status for any signed-in person (coaches already have their own function)
-- ---------------------------------------------------------------------------

create or replace function public.get_my_calendar_connection()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection public.google_calendar_connections%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue';
  end if;
  select * into v_connection from public.google_calendar_connections where coach_id = auth.uid();
  return jsonb_build_object('connected', found, 'google_email', case when found then v_connection.google_email else null end);
end;
$$;

revoke all on function public.checklist_entry_json(public.checklist_entries) from public, anon;
revoke all on function public.checklist_date_ok(date, integer) from public, anon;
revoke all on function public.checklist_require_client() from public, anon, authenticated;
revoke all on function public.checklist_materialize(uuid, date) from public, anon, authenticated;
revoke all on function public.get_my_checklist(date) from public, anon;
revoke all on function public.add_checklist_task(date, text, text, numeric, text, time, jsonb, boolean) from public, anon;
revoke all on function public.set_checklist_item(uuid, boolean, numeric, numeric) from public, anon;
revoke all on function public.update_checklist_calendar(uuid, time, boolean) from public, anon;
revoke all on function public.delete_checklist_task(uuid) from public, anon;
revoke all on function public.get_checklist_summary(date, integer) from public, anon;
revoke all on function public.get_my_calendar_connection() from public, anon;
grant execute on function public.checklist_entry_json(public.checklist_entries) to authenticated;
grant execute on function public.checklist_date_ok(date, integer) to authenticated;
grant execute on function public.get_my_checklist(date) to authenticated;
grant execute on function public.add_checklist_task(date, text, text, numeric, text, time, jsonb, boolean) to authenticated;
grant execute on function public.set_checklist_item(uuid, boolean, numeric, numeric) to authenticated;
grant execute on function public.update_checklist_calendar(uuid, time, boolean) to authenticated;
grant execute on function public.delete_checklist_task(uuid) to authenticated;
grant execute on function public.get_checklist_summary(date, integer) to authenticated;
grant execute on function public.get_my_calendar_connection() to authenticated;
