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
do $$
begin
  if to_regclass('realtime.messages') is not null then
    alter table realtime.messages enable row level security;

    drop policy if exists "Video room members can receive signals" on realtime.messages;
    create policy "Video room members can receive signals"
      on realtime.messages for select
      to authenticated
      using (realtime.messages.extension = 'broadcast' and public.can_join_video_room((select realtime.topic())));

    drop policy if exists "Video room members can send signals" on realtime.messages;
    create policy "Video room members can send signals"
      on realtime.messages for insert
      to authenticated
      with check (realtime.messages.extension = 'broadcast' and public.can_join_video_room((select realtime.topic())));
  else
    raise notice 'realtime.messages was not found; enable Realtime on the project and run this migration again.';
  end if;
exception
  when insufficient_privilege then
    raise notice 'Could not create the realtime.messages policies with this role. Run this migration in the Supabase SQL Editor.';
end;
$$;
