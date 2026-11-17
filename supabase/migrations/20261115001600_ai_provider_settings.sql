-- Which AI provider and model Jack uses, chosen by the coach (the account owner).
-- Clients and assistant trainers never see or change these settings: they only use Jack, which runs on the
-- coach's choice in the background. The credentials are encrypted by the server before they are stored, and the
-- table has no access at all for the app's roles; it is reachable only through the owner-only functions below
-- and the server's service role.

create table if not exists public.coach_ai_settings (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  provider text not null check (provider in ('openai', 'gemini', 'bedrock', 'azure_foundry')),
  model text check (model is null or char_length(model) <= 200),
  region text check (region is null or char_length(region) <= 40),
  endpoint text check (endpoint is null or char_length(endpoint) <= 300),
  credentials_encrypted text not null check (char_length(credentials_encrypted) between 1 and 8000),
  updated_at timestamptz not null default now(),
  last_tested_at timestamptz,
  last_test_ok boolean
);

alter table public.coach_ai_settings enable row level security;

-- No policies for anon or authenticated: with row-level security on, that means no rows, ever.
drop policy if exists "Service role manages AI settings" on public.coach_ai_settings;
create policy "Service role manages AI settings"
  on public.coach_ai_settings for all
  to service_role
  using (true)
  with check (true);

revoke all on public.coach_ai_settings from public, anon, authenticated;
grant all on public.coach_ai_settings to service_role;

-- Only a head coach with an active plan may manage the settings. Clients and assistant trainers (whose access
-- state is 'trainer') are refused.
create or replace function public.ai_settings_guard()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to continue';
  end if;
  v_access := public.get_my_access_status();
  if v_access ->> 'role' is distinct from 'coach' or v_access ->> 'access_state' not in ('trialing', 'active') then
    raise exception 'AI settings are available to the account owner only';
  end if;
end;
$$;

-- What the settings screen shows: never the credentials, not even in encrypted form.
create or replace function public.get_my_ai_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.coach_ai_settings;
begin
  perform public.ai_settings_guard();
  select * into v_row from public.coach_ai_settings where coach_id = auth.uid();
  if not found then
    return jsonb_build_object('configured', false);
  end if;
  return jsonb_build_object(
    'configured', true,
    'provider', v_row.provider,
    'model', v_row.model,
    'region', v_row.region,
    'endpoint', v_row.endpoint,
    'updated_at', v_row.updated_at,
    'last_tested_at', v_row.last_tested_at,
    'last_test_ok', v_row.last_test_ok
  );
end;
$$;

create or replace function public.save_my_ai_settings(
  p_provider text,
  p_model text,
  p_region text,
  p_endpoint text,
  p_credentials_encrypted text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ai_settings_guard();
  if p_provider is null or p_provider not in ('openai', 'gemini', 'bedrock', 'azure_foundry') then
    raise exception 'Choose a supported AI provider';
  end if;
  if p_credentials_encrypted is null or btrim(p_credentials_encrypted) = '' then
    raise exception 'Credentials are required';
  end if;

  insert into public.coach_ai_settings (coach_id, provider, model, region, endpoint, credentials_encrypted, updated_at, last_tested_at, last_test_ok)
  values (auth.uid(), p_provider, nullif(btrim(p_model), ''), nullif(btrim(p_region), ''), nullif(btrim(p_endpoint), ''), p_credentials_encrypted, statement_timestamp(), null, null)
  on conflict (coach_id) do update
  set provider = excluded.provider,
      model = excluded.model,
      region = excluded.region,
      endpoint = excluded.endpoint,
      credentials_encrypted = excluded.credentials_encrypted,
      updated_at = statement_timestamp(),
      last_tested_at = null,
      last_test_ok = null;
end;
$$;

create or replace function public.clear_my_ai_settings()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ai_settings_guard();
  delete from public.coach_ai_settings where coach_id = auth.uid();
end;
$$;

create or replace function public.record_my_ai_test(p_ok boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ai_settings_guard();
  update public.coach_ai_settings
  set last_tested_at = statement_timestamp(), last_test_ok = p_ok
  where coach_id = auth.uid();
end;
$$;

-- Whose settings apply to a person: a coach uses their own, an assistant trainer the head coach's, and a client
-- the settings of their coach (preferring a coach who has chosen a provider). Server use only.
create or replace function public.resolve_ai_owner(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p.role = 'client' then (
      select cc.coach_id
      from public.coach_clients cc
      where cc.client_id = p.id and cc.status = 'active' and public.workflow_coach_is_active(cc.coach_id)
      order by exists (select 1 from public.coach_ai_settings s where s.coach_id = cc.coach_id) desc, cc.created_at
      limit 1
    )
    when p.role = 'coach' then coalesce(
      (select m.head_coach_id from public.coach_team_members m where m.trainer_user_id = p.id and m.status = 'active' limit 1),
      p.id
    )
  end
  from public.profiles p
  where p.id = p_user;
$$;

-- The stored (encrypted) settings that apply to a person, or null. Only the server's service role may call this.
create or replace function public.service_get_ai_settings(p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'owner_id', s.coach_id,
    'provider', s.provider,
    'model', s.model,
    'region', s.region,
    'endpoint', s.endpoint,
    'credentials_encrypted', s.credentials_encrypted,
    'updated_at', s.updated_at
  )
  from public.coach_ai_settings s
  where s.coach_id = public.resolve_ai_owner(p_user);
$$;

revoke all on function public.ai_settings_guard() from public, anon, authenticated;
revoke all on function public.get_my_ai_settings() from public, anon;
revoke all on function public.save_my_ai_settings(text, text, text, text, text) from public, anon;
revoke all on function public.clear_my_ai_settings() from public, anon;
revoke all on function public.record_my_ai_test(boolean) from public, anon;
revoke all on function public.resolve_ai_owner(uuid) from public, anon, authenticated;
revoke all on function public.service_get_ai_settings(uuid) from public, anon, authenticated;
grant execute on function public.get_my_ai_settings() to authenticated;
grant execute on function public.save_my_ai_settings(text, text, text, text, text) to authenticated;
grant execute on function public.clear_my_ai_settings() to authenticated;
grant execute on function public.record_my_ai_test(boolean) to authenticated;
grant execute on function public.service_get_ai_settings(uuid) to service_role;
