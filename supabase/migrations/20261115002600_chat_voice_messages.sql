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
