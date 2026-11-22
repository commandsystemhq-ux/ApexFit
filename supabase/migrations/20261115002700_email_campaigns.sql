-- Email campaigns: a coach writes one message and sends it to some or all of their active clients.
-- The server (api/send-campaign.js) sends the emails with the provider key, which never reaches the browser; the
-- database decides who may be emailed. Everything is written through the functions below, so a coach can only reach
-- their own active clients and a client who opted out is never emailed.

alter table public.profiles add column if not exists email_marketing_opt_out boolean not null default false;
alter table public.profiles add column if not exists email_marketing_opt_out_at timestamptz;

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  subject text not null check (char_length(btrim(subject)) between 1 and 150),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  language text not null default 'en' check (language in ('en', 'ar', 'de', 'fr', 'es')),
  audience text not null check (audience in ('all', 'selected')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'partial', 'failed')),
  total_count integer not null default 0 check (total_count >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists email_campaigns_coach_idx on public.email_campaigns (coach_id, created_at desc);

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  email text,
  client_name text,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped_opt_out', 'skipped_no_email')),
  attempts integer not null default 0,
  error text check (error is null or char_length(error) <= 300),
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (campaign_id, client_id)
);

create index if not exists email_campaign_recipients_campaign_idx on public.email_campaign_recipients (campaign_id, status);

alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;

drop policy if exists "Coaches can read their email campaigns" on public.email_campaigns;
create policy "Coaches can read their email campaigns"
  on public.email_campaigns for select
  to authenticated
  using (coach_id = (select auth.uid()));

drop policy if exists "Coaches can read their campaign recipients" on public.email_campaign_recipients;
create policy "Coaches can read their campaign recipients"
  on public.email_campaign_recipients for select
  to authenticated
  using (exists (
    select 1 from public.email_campaigns c
    where c.id = email_campaign_recipients.campaign_id and c.coach_id = (select auth.uid())
  ));

revoke all on public.email_campaigns, public.email_campaign_recipients from anon, authenticated;
grant select on public.email_campaigns, public.email_campaign_recipients to authenticated;
grant all on public.email_campaigns, public.email_campaign_recipients to service_role;

-- Recounts a campaign from its recipients and closes it when nothing is left to send.
create or replace function public.email_campaign_refresh(p_campaign_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sent integer;
  v_failed integer;
  v_skipped integer;
  v_open integer;
begin
  select count(*) filter (where status = 'sent'),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status in ('skipped_opt_out', 'skipped_no_email')),
         count(*) filter (where status in ('pending', 'sending'))
  into v_sent, v_failed, v_skipped, v_open
  from public.email_campaign_recipients where campaign_id = p_campaign_id;

  update public.email_campaigns
  set sent_count = v_sent,
      failed_count = v_failed,
      skipped_count = v_skipped,
      status = case
        when v_open > 0 then 'sending'
        when v_failed = 0 then 'sent'
        when v_sent = 0 then 'failed'
        else 'partial'
      end,
      completed_at = case when v_open > 0 then null else coalesce(completed_at, now()) end
  where id = p_campaign_id;
end;
$$;

-- Creates the campaign and its recipient list. Clients who opted out or have no usable email are listed as skipped.
create or replace function public.create_email_campaign(
  p_subject text,
  p_body text,
  p_language text,
  p_client_ids uuid[] default null,
  p_send_to_all boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text := btrim(coalesce(p_subject, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_language text := coalesce(nullif(btrim(p_language), ''), 'en');
  v_wanted uuid[] := coalesce(p_client_ids, '{}');
  v_found integer;
  v_campaign public.email_campaigns;
begin
  if auth.uid() is null then
    raise exception 'Sign in to send campaigns';
  end if;
  if not public.is_active_coach() then
    raise exception 'An active coach plan is required to send campaigns';
  end if;
  if v_subject = '' or char_length(v_subject) > 150 then
    raise exception 'Write a subject of up to 150 characters';
  end if;
  if v_body = '' or char_length(v_body) > 5000 then
    raise exception 'Write a message of up to 5000 characters';
  end if;
  if v_language not in ('en', 'ar', 'de', 'fr', 'es') then
    raise exception 'Choose a supported language';
  end if;
  if not coalesce(p_send_to_all, false) and cardinality(v_wanted) = 0 then
    raise exception 'Choose at least one client';
  end if;
  if (select count(*) from public.email_campaigns where coach_id = auth.uid() and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'You have sent many campaigns in the last hour. Wait a while before sending another';
  end if;

  select count(*) into v_found
  from public.coach_clients cc
  where cc.coach_id = auth.uid() and cc.status = 'active'
    and (coalesce(p_send_to_all, false) or cc.client_id = any (v_wanted));
  if v_found = 0 then
    raise exception 'You have no active clients to email';
  end if;
  if v_found > 500 then
    raise exception 'A campaign can reach up to 500 clients';
  end if;
  if not coalesce(p_send_to_all, false) and v_found <> cardinality(v_wanted) then
    raise exception 'Some of the chosen people are not your active clients';
  end if;

  insert into public.email_campaigns (coach_id, subject, body, language, audience)
  values (auth.uid(), v_subject, v_body, v_language, case when coalesce(p_send_to_all, false) then 'all' else 'selected' end)
  returning * into v_campaign;

  insert into public.email_campaign_recipients (campaign_id, client_id, email, client_name, status)
  select v_campaign.id,
         cc.client_id,
         nullif(btrim(cc.client_email), ''),
         nullif(btrim(cc.client_name), ''),
         case
           when coalesce(p.email_marketing_opt_out, false) then 'skipped_opt_out'
           when nullif(btrim(cc.client_email), '') is null or btrim(cc.client_email) !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then 'skipped_no_email'
           else 'pending'
         end
  from public.coach_clients cc
  left join public.profiles p on p.id = cc.client_id
  where cc.coach_id = auth.uid() and cc.status = 'active'
    and (coalesce(p_send_to_all, false) or cc.client_id = any (v_wanted));

  update public.email_campaigns set total_count = v_found where id = v_campaign.id;
  perform public.email_campaign_refresh(v_campaign.id);
  select * into v_campaign from public.email_campaigns where id = v_campaign.id;
  return to_jsonb(v_campaign);
end;
$$;

-- Hands the server the next few people to email and marks them as being sent. People who opted out in the
-- meantime are skipped. A recipient stuck in "sending" (the server stopped midway) is offered again after 5 minutes.
create or replace function public.claim_email_campaign_batch(p_campaign_id uuid, p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign public.email_campaigns;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_batch jsonb;
  v_coach_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select * into v_campaign from public.email_campaigns where id = p_campaign_id and coach_id = auth.uid();
  if not found then
    raise exception 'Campaign not found';
  end if;
  if not public.is_active_coach() then
    raise exception 'An active coach plan is required to send campaigns';
  end if;

  update public.email_campaign_recipients
  set status = 'pending'
  where campaign_id = p_campaign_id and status = 'sending' and claimed_at < now() - interval '5 minutes';

  update public.email_campaign_recipients r
  set status = 'skipped_opt_out'
  from public.profiles p
  where r.campaign_id = p_campaign_id and r.status = 'pending' and p.id = r.client_id and p.email_marketing_opt_out;

  with picked as (
    select id from public.email_campaign_recipients
    where campaign_id = p_campaign_id and status = 'pending'
    order by id
    limit v_limit
    for update skip locked
  ),
  claimed as (
    update public.email_campaign_recipients r
    set status = 'sending', claimed_at = now(), attempts = r.attempts + 1
    from picked
    where r.id = picked.id
    returning r.id, r.client_id, r.email, r.client_name
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'client_id', client_id, 'email', email, 'name', client_name)), '[]'::jsonb)
  into v_batch from claimed;

  perform public.email_campaign_refresh(p_campaign_id);

  select coalesce(nullif(btrim(brand_name), ''), nullif(btrim(full_name), ''), 'ApexFit') into v_coach_name
  from public.profiles where id = auth.uid();

  return jsonb_build_object(
    'campaign', jsonb_build_object('id', v_campaign.id, 'subject', v_campaign.subject, 'body', v_campaign.body, 'language', v_campaign.language, 'coach_name', v_coach_name),
    'recipients', v_batch,
    'remaining', (select count(*) from public.email_campaign_recipients where campaign_id = p_campaign_id and status = 'pending')
  );
end;
$$;

create or replace function public.record_email_campaign_result(p_recipient_id uuid, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_campaign_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select r.campaign_id into v_campaign_id
  from public.email_campaign_recipients r
  join public.email_campaigns c on c.id = r.campaign_id
  where r.id = p_recipient_id and c.coach_id = auth.uid();
  if v_campaign_id is null then
    raise exception 'Recipient not found';
  end if;

  update public.email_campaign_recipients
  set status = case when p_ok then 'sent' else 'failed' end,
      error = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'The email could not be sent'), 300) end,
      sent_at = case when p_ok then now() else null end
  where id = p_recipient_id and status = 'sending';

  perform public.email_campaign_refresh(v_campaign_id);
end;
$$;

-- Puts the failed recipients of a campaign back in the queue so the coach can send them again.
create or replace function public.retry_failed_email_recipients(p_campaign_id uuid)
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
  if not exists (select 1 from public.email_campaigns where id = p_campaign_id and coach_id = auth.uid()) then
    raise exception 'Campaign not found';
  end if;
  update public.email_campaign_recipients set status = 'pending', error = null
  where campaign_id = p_campaign_id and status = 'failed';
  get diagnostics v_count = row_count;
  perform public.email_campaign_refresh(p_campaign_id);
  return v_count;
end;
$$;

-- A client's own choice about marketing emails (the unsubscribe link in each email sets the same flag).
create or replace function public.get_my_email_preferences()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('email_marketing_opt_out', coalesce(p.email_marketing_opt_out, false))
  from public.profiles p where p.id = auth.uid();
$$;

create or replace function public.set_my_email_marketing_opt_out(p_opt_out boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  update public.profiles
  set email_marketing_opt_out = coalesce(p_opt_out, false),
      email_marketing_opt_out_at = case when coalesce(p_opt_out, false) then now() else null end
  where id = auth.uid();
  return jsonb_build_object('email_marketing_opt_out', coalesce(p_opt_out, false));
end;
$$;

revoke all on function public.email_campaign_refresh(uuid) from public, anon, authenticated;
revoke all on function public.create_email_campaign(text, text, text, uuid[], boolean) from public, anon;
revoke all on function public.claim_email_campaign_batch(uuid, integer) from public, anon;
revoke all on function public.record_email_campaign_result(uuid, boolean, text) from public, anon;
revoke all on function public.retry_failed_email_recipients(uuid) from public, anon;
revoke all on function public.get_my_email_preferences() from public, anon;
revoke all on function public.set_my_email_marketing_opt_out(boolean) from public, anon;
grant execute on function public.create_email_campaign(text, text, text, uuid[], boolean) to authenticated;
grant execute on function public.claim_email_campaign_batch(uuid, integer) to authenticated;
grant execute on function public.record_email_campaign_result(uuid, boolean, text) to authenticated;
grant execute on function public.retry_failed_email_recipients(uuid) to authenticated;
grant execute on function public.get_my_email_preferences() to authenticated;
grant execute on function public.set_my_email_marketing_opt_out(boolean) to authenticated;
