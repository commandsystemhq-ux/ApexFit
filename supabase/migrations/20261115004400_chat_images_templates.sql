-- Photos in the two-way chat and ready-made message templates for coaches.
--
-- Photos: an image message is a chat_messages row with message_type = 'image', the path of the file in the private
-- apexfit-chat-images bucket and an optional caption in message_text. The file is uploaded first, then
-- send_chat_image_message checks the link between the two people and the file and saves the row. The browser only ever
-- gets short-lived signed links to the photo. JPG / PNG / WebP, up to 5 MB.
--
-- Templates: a coach keeps reusable messages (welcome, encouragement, check-in reminder, diet change, ...) and inserts
-- them into the chat box with one tap. {client_name} is replaced by the app when the template is inserted. Templates
-- are private to their coach and are written only through the functions below.

alter table public.chat_messages
  add column if not exists image_path text,
  add column if not exists image_mime text;

alter table public.chat_messages drop constraint if exists chat_messages_message_type_check;
alter table public.chat_messages
  add constraint chat_messages_message_type_check check (message_type in ('text', 'voice', 'image'));

alter table public.chat_messages drop constraint if exists chat_messages_content_check;
alter table public.chat_messages
  add constraint chat_messages_content_check check (
    (message_type = 'text'
      and char_length(btrim(message_text)) between 1 and 2000
      and audio_path is null and audio_duration_seconds is null and audio_mime is null
      and image_path is null and image_mime is null)
    or
    (message_type = 'voice'
      and message_text = ''
      and audio_path is not null
      and audio_duration_seconds between 1 and 120
      and audio_mime in ('audio/webm', 'audio/mp4', 'audio/ogg')
      and image_path is null and image_mime is null)
    or
    (message_type = 'image'
      and char_length(message_text) <= 2000
      and image_path is not null
      and image_mime in ('image/jpeg', 'image/png', 'image/webp')
      and audio_path is null and audio_duration_seconds is null and audio_mime is null)
  );

create unique index if not exists chat_messages_image_path_idx on public.chat_messages (image_path) where image_path is not null;

-- Private bucket: 5 MB per file, images only. Files live in a folder named after the person who sent them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-chat-images',
  'apexfit-chat-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "People can upload their own chat images" on storage.objects;
create policy "People can upload their own chat images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-chat-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (public.is_client_account() or public.is_active_coach())
  );

-- The sender can read the file, and so can the other person in the conversation it was sent to.
drop policy if exists "Chat participants can read chat images" on storage.objects;
create policy "Chat participants can read chat images"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-chat-images'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or exists (
        select 1 from public.chat_messages m
        where m.image_path = storage.objects.name
          and (m.sender_id = (select auth.uid()) or m.receiver_id = (select auth.uid()))
      )
    )
  );

-- Lets the app remove a photo whose message could not be saved.
drop policy if exists "People can delete their own chat images" on storage.objects;
create policy "People can delete their own chat images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-chat-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create or replace function public.send_chat_image_message(
  p_receiver_id uuid,
  p_image_path text,
  p_mime text,
  p_caption text default '',
  p_client_ref uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mime text := lower(btrim(split_part(coalesce(p_mime, ''), ';', 1)));
  v_caption text := btrim(coalesce(p_caption, ''));
  v_row public.chat_messages;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send messages';
  end if;
  if not public.chat_can_message(p_receiver_id) then
    raise exception 'You can only message your own coach or your active clients';
  end if;
  if v_mime not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'Choose a JPG, PNG or WebP image';
  end if;
  if char_length(v_caption) > 2000 then
    raise exception 'Messages cannot exceed 2000 characters';
  end if;
  if p_image_path is null
     or p_image_path !~ ('^' || auth.uid()::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$') then
    raise exception 'The image is not valid';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'apexfit-chat-images' and o.name = p_image_path) then
    raise exception 'The image was not uploaded';
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

  insert into public.chat_messages (sender_id, receiver_id, message_type, message_text, image_path, image_mime, client_ref, created_at)
  values (auth.uid(), p_receiver_id, 'image', v_caption, p_image_path, v_mime, p_client_ref, clock_timestamp())
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- Same pages as before, now with the image fields.
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
           m.message_type, m.audio_path, m.audio_duration_seconds, m.audio_mime, m.image_path, m.image_mime,
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
                                   'message_type', message_type, 'audio_path', audio_path, 'audio_duration_seconds', audio_duration_seconds, 'audio_mime', audio_mime,
                                   'image_path', image_path, 'image_mime', image_mime)
                order by created_at, id) filter (where rn <= (select lim from params)),
      '[]'::jsonb),
    'has_more', coalesce(bool_or(rn > (select lim from params)), false)
  )
  from page;
$$;

revoke all on function public.send_chat_image_message(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.send_chat_image_message(uuid, text, text, text, uuid) to authenticated;
revoke all on function public.get_chat_messages(uuid, timestamptz, integer) from public, anon;
grant execute on function public.get_chat_messages(uuid, timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Message templates (coach)
-- ---------------------------------------------------------------------------
create table if not exists public.coach_message_templates (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 60),
  category text not null default 'custom' check (category in ('welcome', 'encouragement', 'checkin', 'diet', 'custom')),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists coach_message_templates_title_idx on public.coach_message_templates (coach_id, lower(btrim(title)));
create index if not exists coach_message_templates_coach_idx on public.coach_message_templates (coach_id, category, created_at);

alter table public.coach_message_templates enable row level security;

drop policy if exists "Coaches can read their message templates" on public.coach_message_templates;
create policy "Coaches can read their message templates"
  on public.coach_message_templates for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.coach_message_templates from anon, authenticated;
grant select on public.coach_message_templates to authenticated;

-- Creates (p_id null) or updates one of the coach's templates.
create or replace function public.save_message_template(p_id uuid, p_title text, p_category text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage message templates' using errcode = '42501';
  end if;
  if char_length(v_title) not between 1 and 60 then
    raise exception 'The template name must be between 1 and 60 characters' using errcode = '22023';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'The template text must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  if p_category is null or p_category not in ('welcome', 'encouragement', 'checkin', 'diet', 'custom') then
    raise exception 'Choose a valid template category' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.coach_message_templates
    where coach_id = auth.uid() and lower(btrim(title)) = lower(v_title) and id is distinct from p_id
  ) then
    raise exception 'A template with this name already exists' using errcode = '23505';
  end if;

  if p_id is null then
    if (select count(*) from public.coach_message_templates where coach_id = auth.uid()) >= 50 then
      raise exception 'You can keep up to 50 message templates' using errcode = '54000';
    end if;
    insert into public.coach_message_templates (coach_id, title, category, body)
    values (auth.uid(), v_title, p_category, v_body)
    returning id into v_id;
  else
    update public.coach_message_templates
    set title = v_title, category = p_category, body = v_body, updated_at = now()
    where id = p_id and coach_id = auth.uid()
    returning id into v_id;
    if v_id is null then
      raise exception 'Template was not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_message_template(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage message templates' using errcode = '42501';
  end if;
  delete from public.coach_message_templates where id = p_id and coach_id = auth.uid();
  if not found then
    raise exception 'Template was not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.save_message_template(uuid, text, text, text) from public, anon;
revoke all on function public.delete_message_template(uuid) from public, anon;
grant execute on function public.save_message_template(uuid, text, text, text) to authenticated;
grant execute on function public.delete_message_template(uuid) to authenticated;
