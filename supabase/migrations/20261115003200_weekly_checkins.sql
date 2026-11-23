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
