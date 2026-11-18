-- Coach subscriptions that do not depend on a payment gateway.
--
-- public.coach_subscriptions (created in the first migration) holds one row per coach with the gateway named in
-- `provider` (Paddle today). Gateways report what happened through apply_subscription_event(), which only the server
-- (service role) can call; the app reads the result and never trusts anything the browser says about billing.

alter table public.coach_subscriptions add column if not exists plan text not null default 'coach_monthly';
alter table public.coach_subscriptions add column if not exists price_id text;
alter table public.coach_subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.coach_subscriptions add column if not exists started_at timestamptz;
alter table public.coach_subscriptions add column if not exists canceled_at timestamptz;
alter table public.coach_subscriptions add column if not exists last_event_at timestamptz;
alter table public.coach_subscriptions add column if not exists created_at timestamptz not null default now();

alter table public.coach_subscriptions drop constraint if exists coach_subscriptions_status_check;
alter table public.coach_subscriptions add constraint coach_subscriptions_status_check
  check (status in ('active', 'past_due', 'paused', 'canceled'));
alter table public.coach_subscriptions drop constraint if exists coach_subscriptions_plan_check;
alter table public.coach_subscriptions add constraint coach_subscriptions_plan_check
  check (char_length(plan) between 1 and 60);
alter table public.coach_subscriptions drop constraint if exists coach_subscriptions_provider_check;
alter table public.coach_subscriptions add constraint coach_subscriptions_provider_check
  check (provider ~ '^[a-z][a-z0-9_]{1,29}$');

create index if not exists coach_subscriptions_customer_idx
  on public.coach_subscriptions (provider, provider_customer_id) where provider_customer_id is not null;

-- Every message a gateway sent us, once. The event id makes a retried or duplicated message harmless.
create table if not exists public.billing_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  user_id uuid references public.profiles (id) on delete set null,
  provider_subscription_id text,
  outcome text not null default 'received',
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create index if not exists billing_events_user_idx on public.billing_events (user_id, received_at desc);

alter table public.billing_events enable row level security;
revoke all on public.billing_events from public, anon, authenticated;
grant all on public.billing_events to service_role;

-- Does this subscription give access right now? A paid or past-due subscription keeps working for 3 days after its
-- period ends, so a renewal message that arrives late never locks a paying coach out.
create or replace function public.subscription_grants_access(p_status text, p_period_end timestamptz)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_status = 'active' then p_period_end is null or p_period_end + interval '3 days' > statement_timestamp()
    when p_status = 'past_due' then p_period_end is not null and p_period_end + interval '3 days' > statement_timestamp()
    else false
  end;
$$;

revoke all on function public.subscription_grants_access(text, timestamptz) from public, anon;
grant execute on function public.subscription_grants_access(text, timestamptz) to authenticated, service_role;

-- A coach's access: the subscription when it is in force, otherwise the 72-hour trial (same rules as before, with the
-- subscription's end date now respected).
create or replace function public.workflow_coach_is_active(p_coach_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.coach_subscriptions s on s.user_id = p.id
    where p.id = p_coach_id
      and p.role = 'coach'
      and (
        (s.user_id is not null and public.subscription_grants_access(s.status, s.current_period_end))
        or p.trial_ends_at > statement_timestamp()
      )
  );
$$;

create or replace function public.get_my_access_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_subscription public.coach_subscriptions%rowtype;
  v_has_subscription boolean := false;
  v_paid boolean := false;
  v_access_state text;
  v_team public.coach_team_members%rowtype;
  v_has_team boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  select * into v_subscription from public.coach_subscriptions where user_id = v_profile.id;
  v_has_subscription := found;
  v_paid := v_has_subscription and public.subscription_grants_access(v_subscription.status, v_subscription.current_period_end);

  if v_profile.role = 'coach' then
    select * into v_team from public.coach_team_members where trainer_user_id = v_profile.id and status = 'active' limit 1;
    v_has_team := found;
  end if;

  if v_profile.role = 'client' then
    v_access_state := 'client';
  elsif v_has_team then
    v_access_state := 'trainer';
  elsif v_paid then
    v_access_state := 'active';
  elsif v_profile.trial_ends_at > statement_timestamp() then
    v_access_state := 'trialing';
  else
    v_access_state := 'expired';
  end if;

  return jsonb_build_object(
    'id', v_profile.id,
    'role', v_profile.role,
    'locale', v_profile.locale,
    'full_name', v_profile.full_name,
    'brand_name', v_profile.brand_name,
    'avatar_path', v_profile.avatar_path,
    'trial_started_at', v_profile.trial_started_at,
    'trial_ends_at', v_profile.trial_ends_at,
    'subscription_status', coalesce(
      case when v_has_subscription then v_subscription.status end,
      case when v_profile.role = 'coach' and v_profile.trial_ends_at > statement_timestamp() then 'trialing' else 'none' end
    ),
    'access_state', v_access_state,
    'team', case when v_has_team then jsonb_build_object(
      'member_id', v_team.id,
      'head_coach_id', v_team.head_coach_id,
      'role_title', v_team.role_title,
      'permissions', v_team.permissions,
      'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = v_team.head_coach_id),
      'head_active', public.workflow_coach_is_active(v_team.head_coach_id)
    ) else null end
  );
end;
$$;

-- What the billing page shows: the coach's own subscription, without gateway identifiers.
create or replace function public.get_my_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_subscription public.coach_subscriptions%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required';
  end if;
  select * into v_subscription from public.coach_subscriptions where user_id = auth.uid();
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'provider', v_subscription.provider,
    'plan', v_subscription.plan,
    'status', v_subscription.status,
    'current_period_end', v_subscription.current_period_end,
    'cancel_at_period_end', v_subscription.cancel_at_period_end,
    'started_at', v_subscription.started_at,
    'canceled_at', v_subscription.canceled_at,
    'grants_access', public.subscription_grants_access(v_subscription.status, v_subscription.current_period_end),
    'can_manage', v_subscription.provider_customer_id is not null
  );
end;
$$;

-- Applies one gateway event to the coach it belongs to. Server only.
--   duplicate     this event id was already handled
--   unknown_user  a first message for a subscription we cannot tie to a coach (nothing is created)
--   conflict      the coach already has a different live subscription; the new one is left alone
--   stale         an older message arriving after a newer one
--   applied       the subscription row now reflects the event
create or replace function public.apply_subscription_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_user_id uuid,
  p_subscription_id text,
  p_customer_id text,
  p_status text,
  p_plan text,
  p_price_id text,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_started_at timestamptz,
  p_canceled_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_subscriptions%rowtype;
  v_found boolean;
  v_user uuid;
  v_outcome text;
  v_inserted integer;
begin
  if p_status not in ('active', 'past_due', 'paused', 'canceled') then
    raise exception 'Unsupported subscription status %', p_status using errcode = '22023';
  end if;
  if coalesce(p_provider, '') = '' or coalesce(p_event_id, '') = '' or coalesce(p_subscription_id, '') = '' then
    raise exception 'The event needs a provider, an event id and a subscription id' using errcode = '22023';
  end if;

  insert into public.billing_events (provider, event_id, event_type, occurred_at, provider_subscription_id)
  values (p_provider, p_event_id, p_event_type, p_occurred_at, p_subscription_id)
  on conflict (provider, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  select * into v_row from public.coach_subscriptions
  where provider = p_provider and provider_subscription_id = p_subscription_id for update;
  v_found := found;

  if v_found then
    v_user := v_row.user_id;
  else
    -- First message about this subscription: the coach comes from the id the server attached when it created the
    -- checkout, and must be a real coach account.
    if p_user_id is null or not exists (select 1 from public.profiles where id = p_user_id and role = 'coach') then
      update public.billing_events set outcome = 'unknown_user' where provider = p_provider and event_id = p_event_id;
      return jsonb_build_object('outcome', 'unknown_user');
    end if;
    v_user := p_user_id;
    select * into v_row from public.coach_subscriptions where user_id = v_user for update;
    v_found := found;
    if v_found
      and v_row.provider_subscription_id is distinct from p_subscription_id
      and public.subscription_grants_access(v_row.status, v_row.current_period_end) then
      update public.billing_events set outcome = 'conflict', user_id = v_user where provider = p_provider and event_id = p_event_id;
      return jsonb_build_object('outcome', 'conflict');
    end if;
  end if;

  if v_found and v_row.provider_subscription_id = p_subscription_id and v_row.last_event_at is not null and p_occurred_at < v_row.last_event_at then
    update public.billing_events set outcome = 'stale', user_id = v_user where provider = p_provider and event_id = p_event_id;
    return jsonb_build_object('outcome', 'stale');
  end if;

  insert into public.coach_subscriptions (
    user_id, status, provider, provider_customer_id, provider_subscription_id, plan, price_id,
    current_period_end, cancel_at_period_end, started_at, canceled_at, last_event_at, updated_at
  )
  values (
    v_user, p_status, p_provider, p_customer_id, p_subscription_id, coalesce(nullif(p_plan, ''), 'coach_monthly'), p_price_id,
    p_period_end, coalesce(p_cancel_at_period_end, false), p_started_at, p_canceled_at, p_occurred_at, now()
  )
  on conflict (user_id) do update set
    status = excluded.status,
    provider = excluded.provider,
    provider_customer_id = coalesce(excluded.provider_customer_id, public.coach_subscriptions.provider_customer_id),
    provider_subscription_id = excluded.provider_subscription_id,
    plan = excluded.plan,
    price_id = coalesce(excluded.price_id, public.coach_subscriptions.price_id),
    current_period_end = coalesce(excluded.current_period_end, public.coach_subscriptions.current_period_end),
    cancel_at_period_end = excluded.cancel_at_period_end,
    started_at = coalesce(excluded.started_at, public.coach_subscriptions.started_at),
    canceled_at = case when excluded.status = 'canceled' then coalesce(excluded.canceled_at, public.coach_subscriptions.canceled_at, excluded.last_event_at) else null end,
    last_event_at = excluded.last_event_at,
    updated_at = now();

  v_outcome := 'applied';
  update public.billing_events set outcome = v_outcome, user_id = v_user where provider = p_provider and event_id = p_event_id;
  return jsonb_build_object('outcome', v_outcome, 'user_id', v_user);
end;
$$;

revoke all on function public.get_my_subscription() from public, anon;
grant execute on function public.get_my_subscription() to authenticated;
revoke all on function public.apply_subscription_event(text, text, text, timestamptz, uuid, text, text, text, text, text, timestamptz, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_subscription_event(text, text, text, timestamptz, uuid, text, text, text, text, text, timestamptz, boolean, timestamptz, timestamptz) to service_role;
revoke all on function public.get_my_access_status() from public, anon;
grant execute on function public.get_my_access_status() to authenticated;

-- The server (service role) must be able to read and write every table, as Supabase's own defaults used to grant.
-- Projects created recently do not grant it automatically, which showed up as "permission denied for table
-- coach_subscriptions" (code 42501) when the billing endpoint looked up a coach's subscription.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;