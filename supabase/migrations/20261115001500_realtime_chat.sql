-- Two-way chat between a coach and each of their clients.
-- Messages are written only through send_chat_message, which checks that the two people are linked.
-- Reads are limited by row-level security to the two people in the conversation, and the table is added to
-- the supabase_realtime publication so new messages and read receipts arrive without refreshing the page.

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles (id) on delete cascade,
  receiver_id uuid not null references public.profiles (id) on delete cascade,
  message_text text not null check (char_length(btrim(message_text)) between 1 and 2000),
  created_at timestamptz not null default now(),
  is_read boolean not null default false,
  -- Chosen by the app for each message, so sending it again after a lost answer does not create a copy.
  client_ref uuid,
  check (sender_id <> receiver_id)
);

create unique index if not exists chat_messages_client_ref_idx on public.chat_messages (sender_id, client_ref) where client_ref is not null;
create index if not exists chat_messages_pair_idx on public.chat_messages (sender_id, receiver_id, created_at desc);
create index if not exists chat_messages_receiver_idx on public.chat_messages (receiver_id, sender_id, created_at desc);
create index if not exists chat_messages_unread_idx on public.chat_messages (receiver_id) where not is_read;

alter table public.chat_messages enable row level security;

drop policy if exists "Participants can read their chat messages" on public.chat_messages;
create policy "Participants can read their chat messages"
  on public.chat_messages for select
  to authenticated
  using (
    (sender_id = (select auth.uid()) or receiver_id = (select auth.uid()))
    and (public.is_client_account() or public.is_active_coach())
  );

revoke all on public.chat_messages from anon, authenticated;
grant select on public.chat_messages to authenticated;
grant all on public.chat_messages to service_role;

-- Live updates. Row-level security still decides who receives which row.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
     ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
exception when others then
  raise warning 'Could not add chat_messages to the supabase_realtime publication: %. Enable Realtime for this table in the Supabase dashboard (Database > Replication).', sqlerrm;
end
$$;

-- A coach and a client may chat while the client is one of the coach's active clients.
create or replace function public.chat_can_message(p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_other is not null and exists (
    select 1 from public.coach_clients cc
    where cc.status = 'active'
      and (
        (cc.coach_id = auth.uid() and cc.client_id = p_other and public.is_active_coach())
        or (cc.client_id = auth.uid() and cc.coach_id = p_other and public.is_client_account() and public.workflow_coach_is_active(cc.coach_id))
      )
  );
$$;

create or replace function public.send_chat_message(p_receiver_id uuid, p_text text, p_client_ref uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_row public.chat_messages;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send messages';
  end if;
  if not public.chat_can_message(p_receiver_id) then
    raise exception 'You can only message your own coach or your active clients';
  end if;
  if v_text = '' then
    raise exception 'Write a message first';
  end if;
  if char_length(v_text) > 2000 then
    raise exception 'Messages cannot exceed 2000 characters';
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

  insert into public.chat_messages (sender_id, receiver_id, message_text, client_ref, created_at)
  values (auth.uid(), p_receiver_id, v_text, p_client_ref, clock_timestamp())
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

-- One page of the conversation with one person, oldest first. Pass the time of the oldest message you
-- already have to load earlier ones.
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
           row_number() over (order by m.created_at desc, m.id desc) as rn
    from public.chat_messages m
    where ((m.sender_id = auth.uid() and m.receiver_id = p_partner_id) or (m.sender_id = p_partner_id and m.receiver_id = auth.uid()))
      and (p_before is null or m.created_at < p_before)
    order by m.created_at desc, m.id desc
    limit (select lim + 1 from params)
  )
  select jsonb_build_object(
    'messages', coalesce(
      jsonb_agg(jsonb_build_object('id', id, 'sender_id', sender_id, 'receiver_id', receiver_id, 'message_text', message_text, 'created_at', created_at, 'is_read', is_read)
                order by created_at, id) filter (where rn <= (select lim from params)),
      '[]'::jsonb),
    'has_more', coalesce(bool_or(rn > (select lim from params)), false)
  )
  from page;
$$;

-- The person opened the conversation: everything the other person sent becomes read.
create or replace function public.mark_chat_read(p_partner_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  update public.chat_messages
  set is_read = true
  where receiver_id = auth.uid() and sender_id = p_partner_id and not is_read;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The list on the left: every person the caller can chat with (and anyone they already talked to),
-- with the last message and the number of unread ones.
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
        select m.message_text, m.created_at, m.sender_id
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

create or replace function public.get_chat_unread_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.chat_messages where receiver_id = auth.uid() and not is_read;
$$;

revoke all on function public.chat_can_message(uuid) from public, anon;
revoke all on function public.send_chat_message(uuid, text, uuid) from public, anon;
revoke all on function public.get_chat_messages(uuid, timestamptz, integer) from public, anon;
revoke all on function public.mark_chat_read(uuid) from public, anon;
revoke all on function public.get_chat_conversations() from public, anon;
revoke all on function public.get_chat_unread_count() from public, anon;
grant execute on function public.chat_can_message(uuid) to authenticated;
grant execute on function public.send_chat_message(uuid, text, uuid) to authenticated;
grant execute on function public.get_chat_messages(uuid, timestamptz, integer) to authenticated;
grant execute on function public.mark_chat_read(uuid) to authenticated;
grant execute on function public.get_chat_conversations() to authenticated;
grant execute on function public.get_chat_unread_count() to authenticated;
