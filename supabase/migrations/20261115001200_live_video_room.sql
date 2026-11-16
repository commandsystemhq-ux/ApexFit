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
