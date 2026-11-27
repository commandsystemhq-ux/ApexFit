-- Custom reminders: a client or a coach schedules reminders (water, a meal, a workout, the weekly check-in or anything
-- else) for certain days of the week at a certain time. When one comes due it appears in the notification center, and the
-- scheduled job that already serves workflows (/api/workflows) also sends it to the person's devices as a Web Push.
-- A coach can also schedule a reminder for one of their active clients.
--
-- Security: a person reads the reminders they created and the ones created for them. Nobody writes the table
-- directly: save_reminder / delete_reminder check who is asking. The times are the person's own local time, kept with
-- their time zone, so "08:00" means 08:00 where they live.
--
-- Delivery: fire_due_reminders turns due reminders into notifications. It runs
--   - for the signed-in person whenever they open the app or the bell refreshes (get_my_notifications), and
--   - for everyone from run_reminder_engine (service role: the /api/workflows cron job, or pg_cron when available).
-- A reminder fires at most once per local day. Reminders that are more than 12 hours late are skipped for that day.

create table if not exists public.custom_reminders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  target_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'custom' check (kind in ('water', 'meal', 'workout', 'checkin', 'custom')),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  message text not null default '' check (char_length(message) <= 300),
  time_of_day time not null,
  -- ISO weekdays: 1 = Monday ... 7 = Sunday
  days_of_week smallint[] not null check (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  is_active boolean not null default true,
  last_fired_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists custom_reminders_target_idx on public.custom_reminders (target_id, is_active);
create index if not exists custom_reminders_owner_idx on public.custom_reminders (owner_id, created_at desc);

alter table public.custom_reminders enable row level security;

drop policy if exists "People can read their reminders" on public.custom_reminders;
create policy "People can read their reminders"
  on public.custom_reminders for select
  to authenticated
  using (owner_id = (select auth.uid()) or target_id = (select auth.uid()));

revoke all on public.custom_reminders from anon, authenticated;
grant select on public.custom_reminders to authenticated;
grant all on public.custom_reminders to service_role;

-- Creates (p_id null) or updates a reminder the caller owns. p_target is null for the caller themself, or one of a
-- coach's active clients.
create or replace function public.save_reminder(
  p_id uuid,
  p_kind text,
  p_title text,
  p_message text,
  p_time time,
  p_days integer[],
  p_timezone text,
  p_active boolean default true,
  p_target uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_message text := btrim(coalesce(p_message, ''));
  v_target uuid := coalesce(p_target, v_me);
  v_days smallint[];
  v_id uuid;
begin
  if v_me is null or not (public.is_client_account() or public.is_active_coach()) then
    raise exception 'Sign in with a client or an active coach account to manage reminders' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('water', 'meal', 'workout', 'checkin', 'custom') then
    raise exception 'Choose a valid reminder type' using errcode = '22023';
  end if;
  if char_length(v_title) not between 1 and 80 then
    raise exception 'The reminder title must be between 1 and 80 characters' using errcode = '22023';
  end if;
  if char_length(v_message) > 300 then
    raise exception 'The reminder message can be up to 300 characters' using errcode = '22023';
  end if;
  if p_time is null then
    raise exception 'Choose the time of the reminder' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct d::smallint order by d::smallint), '{}') into v_days from unnest(coalesce(p_days, '{}')) as d where d between 1 and 7;
  if cardinality(v_days) = 0 then
    raise exception 'Choose at least one day of the week' using errcode = '22023';
  end if;
  if p_timezone is null or not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Choose a valid time zone' using errcode = '22023';
  end if;
  if v_target <> v_me and not (
    public.is_active_coach()
    and exists (select 1 from public.coach_clients where coach_id = v_me and client_id = v_target and status = 'active')
  ) then
    raise exception 'You can only schedule reminders for your own active clients' using errcode = '42501';
  end if;

  if p_id is null then
    if (select count(*) from public.custom_reminders where owner_id = v_me) >= 40 then
      raise exception 'You can keep up to 40 reminders' using errcode = '54000';
    end if;
    insert into public.custom_reminders (owner_id, target_id, kind, title, message, time_of_day, days_of_week, timezone, is_active)
    values (v_me, v_target, p_kind, v_title, v_message, p_time, v_days, p_timezone, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.custom_reminders
    set kind = p_kind, title = v_title, message = v_message, time_of_day = p_time, days_of_week = v_days,
        timezone = p_timezone, is_active = coalesce(p_active, true), target_id = v_target, last_fired_on = null, updated_at = now()
    where id = p_id and owner_id = v_me
    returning id into v_id;
    if v_id is null then
      raise exception 'Reminder was not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_reminder(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  delete from public.custom_reminders where id = p_id and owner_id = auth.uid();
  if not found then
    raise exception 'Reminder was not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Where a reminder of this type leads, for a client or for a coach.
create or replace function public.reminder_link(p_kind text, p_role text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_role = 'client' then case p_kind when 'water' then '/habits' when 'meal' then '/food' when 'workout' then '/workouts' when 'checkin' then '/weekly-checkin' else '/reminders' end
    else case p_kind when 'meal' then '/meal-plans' when 'workout' then '/workout-builder' when 'checkin' then '/checkins' else '/reminders' end
  end;
$$;

-- Turns the reminders that are due into notifications. p_user limits it to one person (null = everyone). Returns the
-- notifications that still need a push: [{ user_id, notification_id, title, message, link }].
-- p_mark_pushed = true marks them as already delivered (the person is looking at the app right now).
create or replace function public.fire_due_reminders(p_user uuid default null, p_mark_pushed boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_local timestamp;
  v_local_day date;
  v_late interval;
  v_role text;
  v_link text;
  v_id uuid;
  v_created jsonb := '[]'::jsonb;
begin
  for v_row in
    select r.*, p.role as target_role
    from public.custom_reminders r
    join public.profiles p on p.id = r.target_id
    where r.is_active and (p_user is null or r.target_id = p_user)
    for update of r skip locked
  loop
    v_local := now() at time zone v_row.timezone;
    v_local_day := v_local::date;
    continue when v_row.last_fired_on = v_local_day;
    continue when not (extract(isodow from v_local)::smallint = any (v_row.days_of_week));
    continue when v_local::time < v_row.time_of_day;

    update public.custom_reminders set last_fired_on = v_local_day where id = v_row.id;
    v_late := v_local::time - v_row.time_of_day;
    continue when v_late > interval '12 hours';

    v_role := v_row.target_role;
    v_link := public.reminder_link(v_row.kind, v_role);
    v_id := public.create_notification(
      v_row.target_id,
      'reminder',
      jsonb_build_object(
        'reminder_id', v_row.id, 'kind', v_row.kind, 'title', v_row.title, 'message', v_row.message,
        'from_coach', v_row.owner_id <> v_row.target_id,
        'coach_name', case when v_row.owner_id <> v_row.target_id then public.notification_display_name(v_row.owner_id) end
      ),
      v_link,
      'reminder:' || v_row.id::text || ':' || v_local_day::text,
      p_mark_pushed
    );
    if not p_mark_pushed and v_id is not null then
      v_created := v_created || jsonb_build_array(jsonb_build_object(
        'user_id', v_row.target_id, 'notification_id', v_id, 'title', v_row.title, 'message', v_row.message, 'link', v_link
      ));
    end if;
  end loop;
  return v_created;
end;
$$;

-- Everyone, from the scheduled job. Also hands out the reminder notifications that were created but not pushed yet
-- (for example by pg_cron), so each one is pushed once.
create or replace function public.run_reminder_engine()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending jsonb;
begin
  perform public.fire_due_reminders(null, false);
  with due as (
    update public.notifications n
    set pushed_at = now()
    where n.type = 'reminder' and n.pushed_at is null and n.read_at is null and n.created_at > now() - interval '24 hours'
    returning n.id, n.user_id, n.payload, n.link
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', due.user_id, 'notification_id', due.id, 'title', due.payload ->> 'title', 'message', due.payload ->> 'message', 'link', due.link
  )), '[]'::jsonb) into v_pending from due;
  return v_pending;
end;
$$;

-- The bell reads: due reminders of the signed-in person first become notifications (already marked as delivered).
create or replace function public.get_my_notifications(p_limit integer default 30, p_before timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
begin
  if v_me is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  perform public.fire_due_reminders(v_me, true);
  return jsonb_build_object(
    'unread_count', (select count(*)::integer from public.notifications where user_id = v_me and read_at is null),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'type', n.type, 'payload', n.payload, 'link', n.link,
        'created_at', n.created_at, 'read_at', n.read_at, 'is_read', n.read_at is not null
      ) order by n.created_at desc, n.id desc)
      from (
        select * from public.notifications
        where user_id = v_me and (p_before is null or created_at < p_before)
        order by created_at desc, id desc
        limit v_limit
      ) n
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.get_my_unread_notification_count()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  perform public.fire_due_reminders(auth.uid(), true);
  return (select count(*)::integer from public.notifications where user_id = auth.uid() and read_at is null);
end;
$$;

revoke all on function public.save_reminder(uuid, text, text, text, time, integer[], text, boolean, uuid) from public, anon;
revoke all on function public.delete_reminder(uuid) from public, anon;
revoke all on function public.reminder_link(text, text) from public, anon, authenticated;
revoke all on function public.fire_due_reminders(uuid, boolean) from public, anon, authenticated;
revoke all on function public.run_reminder_engine() from public, anon, authenticated;
revoke all on function public.get_my_notifications(integer, timestamptz) from public, anon;
revoke all on function public.get_my_unread_notification_count() from public, anon;
grant execute on function public.save_reminder(uuid, text, text, text, time, integer[], text, boolean, uuid) to authenticated;
grant execute on function public.delete_reminder(uuid) to authenticated;
grant execute on function public.fire_due_reminders(uuid, boolean) to service_role;
grant execute on function public.run_reminder_engine() to service_role;
grant execute on function public.get_my_notifications(integer, timestamptz) to authenticated;
grant execute on function public.get_my_unread_notification_count() to authenticated;

-- Hourly pass for in-app delivery when pg_cron is available. Push delivery is done by the /api/workflows cron job,
-- which also picks up whatever this pass created.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'apexfit-reminder-engine';
    perform cron.schedule('apexfit-reminder-engine', '*/15 * * * *', 'select public.fire_due_reminders(null, false)');
  end if;
exception when others then
  raise notice 'pg_cron scheduling for reminders skipped: %', sqlerrm;
end
$$;
