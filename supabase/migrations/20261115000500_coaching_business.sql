-- Coaching business layer: coach-client links, messaging, packages and invoices, sessions, push.

-- Helpers used by row-level security policies
create or replace function public.is_active_coach()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
begin
  if auth.uid() is null
    or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    return false;
  end if;
  v_access := public.get_my_access_status();
  return v_access ->> 'access_state' in ('trialing', 'active');
end;
$$;

create or replace function public.is_client_account()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'client');
$$;

revoke all on function public.is_active_coach() from public, anon;
revoke all on function public.is_client_account() from public, anon;
grant execute on function public.is_active_coach() to authenticated;
grant execute on function public.is_client_account() to authenticated;

-- Coach <-> client relationship, created when a client redeems an invite code
create table if not exists public.coach_clients (
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  client_email text,
  client_name text,
  coach_email text,
  coach_name text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  primary key (coach_id, client_id),
  check (coach_id <> client_id)
);

create index if not exists coach_clients_client_idx on public.coach_clients (client_id);

create table if not exists public.client_invites (
  code text primary key check (code ~ '^[A-Z0-9]{12}$'),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  coach_email text,
  coach_name text,
  expires_at timestamptz not null,
  redeemed_by uuid references public.profiles (id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists client_invites_coach_idx on public.client_invites (coach_id, created_at desc);

alter table public.coach_clients enable row level security;
alter table public.client_invites enable row level security;

drop policy if exists "Coaches can read their clients" on public.coach_clients;
create policy "Coaches can read their clients"
  on public.coach_clients for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their coach links" on public.coach_clients;
create policy "Clients can read their coach links"
  on public.coach_clients for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their invites" on public.client_invites;
create policy "Coaches can read their invites"
  on public.client_invites for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.coach_clients, public.client_invites from anon, authenticated;
grant select on public.coach_clients, public.client_invites to authenticated;
grant all on public.coach_clients, public.client_invites to service_role;

create or replace function public.create_client_invite()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to invite clients';
  end if;
  if (
    select count(*) from public.client_invites
    where coach_id = auth.uid() and redeemed_at is null and expires_at > statement_timestamp()
  ) >= 25 then
    raise exception 'Too many open invites. Wait for them to be used or to expire';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.client_invites (code, coach_id, coach_email, coach_name, expires_at)
  values (
    v_code,
    auth.uid(),
    nullif(auth.jwt() ->> 'email', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    statement_timestamp() + interval '7 days'
  );
  return v_code;
end;
$$;

create or replace function public.redeem_client_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.client_invites%rowtype;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to join a coach';
  end if;

  select * into v_invite
  from public.client_invites
  where code = upper(btrim(coalesce(p_code, '')))
  for update;

  if not found or v_invite.redeemed_at is not null or v_invite.expires_at <= statement_timestamp() then
    raise exception 'This invite code is invalid or has expired';
  end if;

  insert into public.coach_clients (coach_id, client_id, client_email, client_name, coach_email, coach_name)
  values (
    v_invite.coach_id,
    auth.uid(),
    nullif(auth.jwt() ->> 'email', ''),
    nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''),
    v_invite.coach_email,
    v_invite.coach_name
  )
  on conflict (coach_id, client_id) do update set status = 'active';

  update public.client_invites
  set redeemed_by = auth.uid(), redeemed_at = statement_timestamp()
  where code = v_invite.code;

  return jsonb_build_object('coach_id', v_invite.coach_id, 'coach_name', v_invite.coach_name, 'coach_email', v_invite.coach_email);
end;
$$;

create or replace function public.set_client_status(p_client_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'Unsupported client status';
  end if;
  update public.coach_clients set status = p_status
  where coach_id = auth.uid() and client_id = p_client_id;
  if not found then
    raise exception 'Client was not found';
  end if;
end;
$$;

revoke all on function public.create_client_invite() from public, anon;
revoke all on function public.redeem_client_invite(text) from public, anon;
revoke all on function public.set_client_status(uuid, text) from public, anon;
grant execute on function public.create_client_invite() to authenticated;
grant execute on function public.redeem_client_invite(text) to authenticated;
grant execute on function public.set_client_status(uuid, text) to authenticated;

-- Coaches may read the onboarding form of their active clients
drop policy if exists "Coaches can read intake forms of their clients" on public.client_intake_forms;
create policy "Coaches can read intake forms of their clients"
  on public.client_intake_forms for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_intake_forms.client_id
        and cc.status = 'active'
    )
  );

-- Coach messages (notes and videos). Writes happen only through send_coach_message.
create table if not exists public.coach_messages (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  coach_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind in ('note', 'video')),
  body text not null default '' check (length(body) <= 2000),
  video_path text check (video_path is null or length(video_path) <= 300),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  check (
    (kind = 'note' and length(btrim(body)) > 0 and video_path is null)
    or (kind = 'video' and video_path is not null)
  )
);

create index if not exists coach_messages_client_idx on public.coach_messages (client_id, created_at desc);
create index if not exists coach_messages_coach_idx on public.coach_messages (coach_id, created_at desc);
create index if not exists coach_messages_batch_idx on public.coach_messages (batch_id);

alter table public.coach_messages enable row level security;

drop policy if exists "Coaches can read messages they sent" on public.coach_messages;
create policy "Coaches can read messages they sent"
  on public.coach_messages for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their messages" on public.coach_messages;
create policy "Clients can read their messages"
  on public.coach_messages for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Clients can mark their messages read" on public.coach_messages;
create policy "Clients can mark their messages read"
  on public.coach_messages for update
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account())
  with check (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.coach_messages from anon, authenticated;
grant select on public.coach_messages to authenticated;
grant update (read_at) on public.coach_messages to authenticated;
grant all on public.coach_messages to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-coach-videos',
  'apexfit-coach-videos',
  false,
  52428800,
  array['video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Coaches can upload their message videos" on storage.objects;
create policy "Coaches can upload their message videos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-coach-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Coaches can read their message videos" on storage.objects;
create policy "Coaches can read their message videos"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-coach-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Coaches can delete their message videos" on storage.objects;
create policy "Coaches can delete their message videos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-coach-videos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Clients can read videos sent to them" on storage.objects;
create policy "Clients can read videos sent to them"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-coach-videos'
    and public.is_client_account()
    and exists (
      select 1 from public.coach_messages m
      where m.video_path = storage.objects.name
        and m.client_id = (select auth.uid())
    )
  );

create or replace function public.send_coach_message(
  p_client_ids uuid[],
  p_send_to_all boolean,
  p_body text,
  p_video_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipients uuid[];
  v_batch uuid := gen_random_uuid();
  v_body text := btrim(coalesce(p_body, ''));
  v_kind text;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to send messages';
  end if;
  if length(v_body) > 2000 then
    raise exception 'Messages cannot exceed 2000 characters';
  end if;

  if p_video_path is not null then
    v_kind := 'video';
    if length(p_video_path) > 300
      or p_video_path not like (auth.uid()::text || '/%')
      or not exists (
        select 1 from storage.objects o
        where o.bucket_id = 'apexfit-coach-videos' and o.name = p_video_path
      ) then
      raise exception 'The video upload could not be verified';
    end if;
  else
    v_kind := 'note';
    if v_body = '' then
      raise exception 'Write a message or attach a video';
    end if;
  end if;

  select coalesce(array_agg(cc.client_id), '{}') into v_recipients
  from public.coach_clients cc
  where cc.coach_id = auth.uid()
    and cc.status = 'active'
    and (coalesce(p_send_to_all, false) or cc.client_id = any(coalesce(p_client_ids, '{}')));

  if coalesce(array_length(v_recipients, 1), 0) = 0 then
    raise exception 'Choose at least one active client';
  end if;
  if array_length(v_recipients, 1) > 500 then
    raise exception 'A message can be sent to at most 500 clients at once';
  end if;

  insert into public.coach_messages (batch_id, coach_id, client_id, kind, body, video_path)
  select v_batch, auth.uid(), recipient, v_kind, v_body, p_video_path
  from unnest(v_recipients) as recipient;

  return jsonb_build_object('batch_id', v_batch, 'recipient_count', array_length(v_recipients, 1));
end;
$$;

revoke all on function public.send_coach_message(uuid[], boolean, text, text) from public, anon;
grant execute on function public.send_coach_message(uuid[], boolean, text, text) to authenticated;

-- Web push subscriptions
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 2000 and endpoint like 'https://%'),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "Users can read their push subscriptions" on public.push_subscriptions;
create policy "Users can read their push subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.push_subscriptions from anon, authenticated;
grant select on public.push_subscriptions to authenticated;
grant all on public.push_subscriptions to service_role;

create or replace function public.save_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
  set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end;
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;

-- Packages, invoices, and session credits
create sequence if not exists public.invoice_number_seq;

create table if not exists public.coach_packages (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 500),
  session_count integer not null check (session_count between 1 and 500),
  price_cents integer not null check (price_cents between 50 and 100000000),
  currency text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists coach_packages_coach_idx on public.coach_packages (coach_id, created_at desc);

create table if not exists public.coach_payment_accounts (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  stripe_account_id text not null unique,
  charges_enabled boolean not null default false,
  details_submitted boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  coach_id uuid not null,
  client_id uuid not null,
  package_id uuid references public.coach_packages (id) on delete set null,
  description text not null check (length(btrim(description)) between 1 and 300),
  sessions_included integer check (sessions_included between 1 and 500),
  amount_cents integer not null check (amount_cents between 50 and 100000000),
  currency text not null check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  status text not null default 'open' check (status in ('open', 'paid', 'void')),
  due_date date,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists invoices_coach_idx on public.invoices (coach_id, created_at desc);
create index if not exists invoices_client_idx on public.invoices (client_id, created_at desc);

create table if not exists public.client_package_credits (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references public.invoices (id) on delete cascade,
  coach_id uuid not null,
  client_id uuid not null,
  package_name text not null,
  sessions_total integer not null check (sessions_total >= 1),
  sessions_remaining integer not null check (sessions_remaining >= 0),
  created_at timestamptz not null default now(),
  check (sessions_remaining <= sessions_total),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists client_package_credits_pair_idx on public.client_package_credits (coach_id, client_id, created_at);

alter table public.coach_packages enable row level security;
alter table public.coach_payment_accounts enable row level security;
alter table public.invoices enable row level security;
alter table public.client_package_credits enable row level security;

drop policy if exists "Coaches can manage their packages" on public.coach_packages;
create policy "Coaches can manage their packages"
  on public.coach_packages for all
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach())
  with check (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read active packages of their coach" on public.coach_packages;
create policy "Clients can read active packages of their coach"
  on public.coach_packages for select
  to authenticated
  using (
    is_active
    and public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = coach_packages.coach_id
        and cc.client_id = (select auth.uid())
        and cc.status = 'active'
    )
  );

drop policy if exists "Coaches can read their payment account" on public.coach_payment_accounts;
create policy "Coaches can read their payment account"
  on public.coach_payment_accounts for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Coaches can read their invoices" on public.invoices;
create policy "Coaches can read their invoices"
  on public.invoices for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their invoices" on public.invoices;
create policy "Clients can read their invoices"
  on public.invoices for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read credits they sold" on public.client_package_credits;
create policy "Coaches can read credits they sold"
  on public.client_package_credits for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their credits" on public.client_package_credits;
create policy "Clients can read their credits"
  on public.client_package_credits for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.coach_packages, public.coach_payment_accounts, public.invoices, public.client_package_credits
  from anon, authenticated;
grant select, insert, update, delete on public.coach_packages to authenticated;
grant select on public.coach_payment_accounts, public.invoices, public.client_package_credits to authenticated;
grant all on public.coach_packages, public.coach_payment_accounts, public.invoices, public.client_package_credits
  to service_role;

create or replace function public.create_invoice(
  p_client_id uuid,
  p_description text,
  p_amount_cents integer,
  p_currency text default 'usd',
  p_due_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to create invoices';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client is not linked to this coach';
  end if;
  if p_description is null or length(btrim(p_description)) not between 1 and 300 then
    raise exception 'Invoice description must be between 1 and 300 characters';
  end if;
  if p_amount_cents is null or p_amount_cents not between 50 and 100000000 then
    raise exception 'Invoice amount is out of range';
  end if;
  if p_currency not in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed') then
    raise exception 'Unsupported currency';
  end if;
  if p_due_date is not null and p_due_date < current_date - 1 then
    raise exception 'Due date cannot be in the past';
  end if;

  insert into public.invoices (invoice_number, coach_id, client_id, description, amount_cents, currency, due_date)
  values (
    'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'),
    auth.uid(), p_client_id, btrim(p_description), p_amount_cents, p_currency, p_due_date
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Coaches can sell a package to a linked client, and clients can buy an active package of their coach.
create or replace function public.create_package_invoice(p_client_id uuid, p_package_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_package public.coach_packages%rowtype;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_package from public.coach_packages where id = p_package_id and is_active;
  if not found then
    raise exception 'This package is not available';
  end if;

  if auth.uid() = v_package.coach_id then
    if not public.is_active_coach() then
      raise exception 'An active coach account is required to sell packages';
    end if;
  elsif auth.uid() = p_client_id then
    if not public.is_client_account() then
      raise exception 'A client account is required to buy packages';
    end if;
  else
    raise exception 'You cannot create an invoice for this package';
  end if;

  if not exists (
    select 1 from public.coach_clients
    where coach_id = v_package.coach_id and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client is not linked to this coach';
  end if;

  select id into v_id
  from public.invoices
  where coach_id = v_package.coach_id and client_id = p_client_id
    and package_id = p_package_id and status = 'open'
  order by created_at desc
  limit 1;
  if found then
    return v_id;
  end if;

  insert into public.invoices (
    invoice_number, coach_id, client_id, package_id, description, sessions_included, amount_cents, currency
  )
  values (
    'INV-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0'),
    v_package.coach_id, p_client_id, v_package.id, v_package.name,
    v_package.session_count, v_package.price_cents, v_package.currency
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.void_invoice(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  update public.invoices set status = 'void'
  where id = p_invoice_id and coach_id = auth.uid() and status = 'open';
  if not found then
    raise exception 'Only open invoices can be voided';
  end if;
end;
$$;

-- Called only by the Stripe webhook (service role). Idempotent.
create or replace function public.mark_invoice_paid(
  p_invoice_id uuid,
  p_checkout_session_id text,
  p_payment_intent_id text,
  p_amount_cents integer,
  p_currency text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status = 'paid' then
    return false;
  end if;
  if v_invoice.amount_cents <> p_amount_cents or lower(v_invoice.currency) <> lower(p_currency) then
    raise exception 'Payment amount does not match the invoice';
  end if;

  update public.invoices
  set status = 'paid',
      paid_at = statement_timestamp(),
      stripe_checkout_session_id = p_checkout_session_id,
      stripe_payment_intent_id = p_payment_intent_id
  where id = v_invoice.id;

  if v_invoice.sessions_included is not null then
    insert into public.client_package_credits (
      invoice_id, coach_id, client_id, package_name, sessions_total, sessions_remaining
    )
    values (
      v_invoice.id, v_invoice.coach_id, v_invoice.client_id, v_invoice.description,
      v_invoice.sessions_included, v_invoice.sessions_included
    );
  end if;
  return true;
end;
$$;

revoke all on function public.create_invoice(uuid, text, integer, text, date) from public, anon;
revoke all on function public.create_package_invoice(uuid, uuid) from public, anon;
revoke all on function public.void_invoice(uuid) from public, anon;
revoke all on function public.mark_invoice_paid(uuid, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.create_invoice(uuid, text, integer, text, date) to authenticated;
grant execute on function public.create_package_invoice(uuid, uuid) to authenticated;
grant execute on function public.void_invoice(uuid) to authenticated;
grant execute on function public.mark_invoice_paid(uuid, text, text, integer, text) to service_role;

-- Training sessions (calendar)
create table if not exists public.coach_sessions (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  client_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  location text not null default '' check (length(location) <= 200),
  notes text not null default '' check (length(notes) <= 1000),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'canceled')),
  credit_id uuid references public.client_package_credits (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '12 hours'),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists coach_sessions_coach_idx on public.coach_sessions (coach_id, starts_at);
create index if not exists coach_sessions_client_idx on public.coach_sessions (client_id, starts_at);

drop trigger if exists coach_sessions_set_updated_at on public.coach_sessions;
create trigger coach_sessions_set_updated_at
  before update on public.coach_sessions
  for each row execute function public.set_updated_at();

alter table public.coach_sessions enable row level security;

drop policy if exists "Coaches can read their sessions" on public.coach_sessions;
create policy "Coaches can read their sessions"
  on public.coach_sessions for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their sessions" on public.coach_sessions;
create policy "Clients can read their sessions"
  on public.coach_sessions for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.coach_sessions from anon, authenticated;
grant select on public.coach_sessions to authenticated;
grant all on public.coach_sessions to service_role;

create or replace function public.schedule_coach_session(
  p_client_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_location text default '',
  p_notes text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client is not linked to this coach';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 160 then
    raise exception 'Session title must be between 1 and 160 characters';
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at
    or p_ends_at > p_starts_at + interval '12 hours' then
    raise exception 'Session end must be after its start and within 12 hours';
  end if;

  insert into public.coach_sessions (coach_id, client_id, title, starts_at, ends_at, location, notes)
  values (auth.uid(), p_client_id, btrim(p_title), p_starts_at, p_ends_at,
          coalesce(p_location, ''), coalesce(p_notes, ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.set_coach_session_status(p_session_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.coach_sessions%rowtype;
  v_credit_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required';
  end if;
  if p_status not in ('scheduled', 'completed', 'canceled') then
    raise exception 'Unsupported session status';
  end if;

  select * into v_session
  from public.coach_sessions
  where id = p_session_id and coach_id = auth.uid()
  for update;
  if not found then
    raise exception 'Session was not found';
  end if;
  if v_session.status = p_status then
    return jsonb_build_object('status', v_session.status, 'credit_used', v_session.credit_id is not null);
  end if;

  v_credit_id := v_session.credit_id;
  if v_session.status = 'completed' and v_credit_id is not null then
    update public.client_package_credits
    set sessions_remaining = least(sessions_total, sessions_remaining + 1)
    where id = v_credit_id;
    v_credit_id := null;
  end if;

  if p_status = 'completed' then
    select id into v_credit_id
    from public.client_package_credits
    where coach_id = v_session.coach_id and client_id = v_session.client_id and sessions_remaining > 0
    order by created_at
    limit 1
    for update;
    if found then
      update public.client_package_credits
      set sessions_remaining = sessions_remaining - 1
      where id = v_credit_id;
    else
      v_credit_id := null;
    end if;
  end if;

  update public.coach_sessions set status = p_status, credit_id = v_credit_id where id = v_session.id;
  return jsonb_build_object('status', p_status, 'credit_used', v_credit_id is not null);
end;
$$;

revoke all on function public.schedule_coach_session(uuid, text, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.set_coach_session_status(uuid, text) from public, anon;
grant execute on function public.schedule_coach_session(uuid, text, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.set_coach_session_status(uuid, text) to authenticated;
