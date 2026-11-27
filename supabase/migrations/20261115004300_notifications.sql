-- In-app notification center. A notification is a small row for one person: what happened (type), the details the
-- screen needs to word it in the person's language (payload), where tapping it leads (link) and whether it was read.
-- The bell in the top bar reads them through get_my_notifications.
--
-- Security: each person reads only their own notifications (row-level security). Nobody can insert, change or delete
-- rows directly: they are created by database triggers on the events below (create_notification, which no app role can
-- call) and marked read through mark_notification_read / mark_all_notifications_read.
--
-- Events that create a notification:
--   message              a chat message (text, voice or image) or a coach broadcast arrived        -> the receiver
--   checkin_submitted    a client sent their weekly check-in                                        -> the coach
--   checkin_reviewed     the coach reviewed the check-in and left feedback                          -> the client
--   invoice_new          the coach sent an invoice                                                  -> the client
--   invoice_reported     the client says they paid an invoice                                       -> the coach
--   invoice_paid         the coach confirmed the payment                                            -> the client
--   progression          the system suggests a heavier weight / more repetitions for a client       -> the coach
--   reminder             a custom reminder came due (see the custom_reminders migration)            -> its target
-- Several unread notifications of the same kind from the same source collapse into one with a count.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null check (type in ('message', 'checkin_submitted', 'checkin_reviewed', 'invoice_new', 'invoice_reported', 'invoice_paid', 'progression', 'reminder')),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 4000),
  link text check (link is null or (char_length(link) <= 200 and link ~ '^/[A-Za-z0-9/_?=&.%:-]*$' and link not like '//%')),
  source_key text check (source_key is null or char_length(source_key) <= 160),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz
);

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;
-- One unread notification per source: a second event of the same kind raises its count instead of adding a row.
create unique index if not exists notifications_unread_source_idx on public.notifications (user_id, source_key) where read_at is null and source_key is not null;

alter table public.notifications enable row level security;

drop policy if exists "People can read their own notifications" on public.notifications;
create policy "People can read their own notifications"
  on public.notifications for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- Live updates for the bell. Row-level security still decides who receives which row.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
     ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
exception when others then
  raise warning 'Could not add notifications to the supabase_realtime publication: %. Enable Realtime for this table in the Supabase dashboard (Database > Replication); the bell still refreshes by itself every minute.', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------------
-- Creating notifications (triggers only)
-- ---------------------------------------------------------------------------

-- A person's name as the other side should see it: a coach by brand name, a client by name.
create or replace function public.notification_display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select left(coalesce(
    case when p.role = 'coach' then nullif(btrim(p.brand_name), '') end,
    nullif(btrim(p.full_name), ''),
    nullif(btrim(p.brand_name), ''),
    (select nullif(btrim(cc.client_name), '') from public.coach_clients cc where cc.client_id = p_user and nullif(btrim(cc.client_name), '') is not null limit 1),
    'ApexFit'
  ), 80)
  from public.profiles p
  where p.id = p_user;
$$;

create or replace function public.create_notification(
  p_user uuid,
  p_type text,
  p_payload jsonb,
  p_link text default null,
  p_source_key text default null,
  p_mark_pushed boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user is null then
    return null;
  end if;
  insert into public.notifications (user_id, type, payload, link, source_key, pushed_at)
  values (p_user, p_type, coalesce(p_payload, '{}'::jsonb), p_link, p_source_key, case when p_mark_pushed then now() end)
  on conflict (user_id, source_key) where read_at is null and source_key is not null
  do update set
    payload = public.notifications.payload || excluded.payload
              || jsonb_build_object('count', coalesce((public.notifications.payload ->> 'count')::integer, 1) + 1),
    created_at = now(),
    pushed_at = case when p_mark_pushed then now() else null end
  returning id into v_id;

  -- Keep the newest 200 per person.
  delete from public.notifications
  where user_id = p_user
    and id in (select id from public.notifications where user_id = p_user order by created_at desc, id desc offset 200);
  return v_id;
end;
$$;

revoke all on function public.notification_display_name(uuid) from public, anon, authenticated;
revoke all on function public.create_notification(uuid, text, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.create_notification(uuid, text, jsonb, text, text, boolean) to service_role;

-- A new chat message (text, voice or image).
create or replace function public.notify_on_chat_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receiver_role text;
begin
  select role into v_receiver_role from public.profiles where id = new.receiver_id;
  perform public.create_notification(
    new.receiver_id,
    'message',
    jsonb_build_object('sender_id', new.sender_id, 'sender_name', public.notification_display_name(new.sender_id), 'kind', new.message_type),
    case when v_receiver_role = 'coach' then '/messages?with=' || new.sender_id::text else '/coach-hub' end,
    'chat:' || new.sender_id::text
  );
  return new;
exception when others then
  raise warning 'notify_on_chat_message: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists chat_messages_notify on public.chat_messages;
create trigger chat_messages_notify
  after insert on public.chat_messages
  for each row execute function public.notify_on_chat_message();

-- A coach broadcast (note or video) reaching a client.
create or replace function public.notify_on_coach_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.create_notification(
    new.client_id,
    'message',
    jsonb_build_object('sender_id', new.coach_id, 'sender_name', public.notification_display_name(new.coach_id), 'kind', 'broadcast'),
    '/coach-hub',
    'chat:' || new.coach_id::text
  );
  return new;
exception when others then
  raise warning 'notify_on_coach_message: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists coach_messages_notify on public.coach_messages;
create trigger coach_messages_notify
  after insert on public.coach_messages
  for each row execute function public.notify_on_coach_message();

-- Weekly check-ins: sent by the client, reviewed by the coach.
create or replace function public.notify_on_weekly_checkin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'submitted' and new.coach_id is not null then
    perform public.create_notification(
      new.coach_id,
      'checkin_submitted',
      jsonb_build_object('client_id', new.client_id, 'client_name', public.notification_display_name(new.client_id), 'week_start', new.week_start_date),
      '/checkins',
      'checkin:' || new.id::text
    );
  elsif new.status = 'reviewed' and tg_op = 'UPDATE' and old.status is distinct from 'reviewed' then
    perform public.create_notification(
      new.client_id,
      'checkin_reviewed',
      jsonb_build_object('coach_name', public.notification_display_name(coalesce(new.coach_id, new.reviewed_by)), 'week_start', new.week_start_date),
      '/weekly-checkin',
      'checkin-reviewed:' || new.id::text
    );
  end if;
  return new;
exception when others then
  raise warning 'notify_on_weekly_checkin: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists weekly_checkins_notify on public.weekly_checkins;
create trigger weekly_checkins_notify
  after insert or update on public.weekly_checkins
  for each row execute function public.notify_on_weekly_checkin();

-- Invoices: sent, reported as paid by the client, confirmed by the coach.
create or replace function public.notify_on_invoice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_detail jsonb := jsonb_build_object('invoice_number', new.invoice_number, 'amount_cents', new.amount_cents, 'currency', new.currency);
begin
  if tg_op = 'INSERT' then
    if new.status = 'open' then
      perform public.create_notification(new.client_id, 'invoice_new',
        v_detail || jsonb_build_object('coach_name', public.notification_display_name(new.coach_id)),
        '/coach-hub?tab=billing', 'invoice:' || new.id::text || ':new');
    end if;
  else
    if new.payment_reported_at is not null and old.payment_reported_at is null and new.status = 'open' then
      perform public.create_notification(new.coach_id, 'invoice_reported',
        v_detail || jsonb_build_object('client_id', new.client_id, 'client_name', public.notification_display_name(new.client_id)),
        '/invoicing', 'invoice:' || new.id::text || ':reported');
    end if;
    if new.status = 'paid' and old.status is distinct from 'paid' then
      perform public.create_notification(new.client_id, 'invoice_paid',
        v_detail || jsonb_build_object('coach_name', public.notification_display_name(new.coach_id)),
        '/coach-hub?tab=billing', 'invoice:' || new.id::text || ':paid');
    end if;
  end if;
  return new;
exception when others then
  raise warning 'notify_on_invoice: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists invoices_notify on public.invoices;
create trigger invoices_notify
  after insert or update on public.invoices
  for each row execute function public.notify_on_invoice();

-- A new progression suggestion (heavier weight or more repetitions) waiting for the coach's decision.
create or replace function public.notify_on_progression_suggestion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'pending' then
    perform public.create_notification(
      new.coach_id,
      'progression',
      jsonb_build_object('client_id', new.client_id, 'client_name', public.notification_display_name(new.client_id), 'kind', new.kind),
      '/clients?client=' || new.client_id::text,
      'progression:' || new.client_id::text
    );
  end if;
  return new;
exception when others then
  raise warning 'notify_on_progression_suggestion: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists progression_suggestions_notify on public.progression_suggestions;
create trigger progression_suggestions_notify
  after insert on public.progression_suggestions
  for each row execute function public.notify_on_progression_suggestion();

-- ---------------------------------------------------------------------------
-- Reading and marking read
-- ---------------------------------------------------------------------------

create or replace function public.get_my_notifications(p_limit integer default 30, p_before timestamptz default null)
returns jsonb
language plpgsql
stable
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
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  return (select count(*)::integer from public.notifications where user_id = auth.uid() and read_at is null);
end;
$$;

create or replace function public.mark_notification_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.notifications set read_at = coalesce(read_at, now()) where id = p_id and user_id = auth.uid();
end;
$$;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.notifications set read_at = now() where user_id = auth.uid() and read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.get_my_notifications(integer, timestamptz) from public, anon;
revoke all on function public.get_my_unread_notification_count() from public, anon;
revoke all on function public.mark_notification_read(uuid) from public, anon;
revoke all on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.get_my_notifications(integer, timestamptz) to authenticated;
grant execute on function public.get_my_unread_notification_count() to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

-- Opening a conversation reads the messages and also clears the bell entry for that person.
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
  update public.notifications
  set read_at = now()
  where user_id = auth.uid() and read_at is null and source_key = 'chat:' || p_partner_id::text;
  return v_count;
end;
$$;

revoke all on function public.mark_chat_read(uuid) from public, anon;
grant execute on function public.mark_chat_read(uuid) to authenticated;
