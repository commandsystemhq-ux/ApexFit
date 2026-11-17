-- Which AI provider and model Jack uses is a decision for the platform owner, and it applies to everyone:
-- every coach, assistant trainer and client. There is one settings row for the whole platform.
-- Only the server can touch it (with the service role, after checking that the signed-in person is a platform
-- admin listed in PLATFORM_ADMIN_EMAILS). The app's roles (anon, authenticated) have no access at all and there
-- is no function they can call: coaches, trainers and clients cannot read, change or even detect the settings.
-- The credentials are encrypted by the server before they are stored.

-- Per-coach AI settings existed briefly; they are replaced by the platform setting.
drop function if exists public.service_get_ai_settings(uuid);
drop function if exists public.resolve_ai_owner(uuid);
drop function if exists public.record_my_ai_test(boolean);
drop function if exists public.clear_my_ai_settings();
drop function if exists public.save_my_ai_settings(text, text, text, text, text);
drop function if exists public.get_my_ai_settings();
drop function if exists public.ai_settings_guard();
drop table if exists public.coach_ai_settings;

create table if not exists public.platform_ai_settings (
  -- A single row: the primary key can only ever be true.
  id boolean primary key default true check (id),
  provider text not null check (provider in ('openai', 'gemini', 'bedrock', 'azure_foundry')),
  model text check (model is null or char_length(model) <= 200),
  region text check (region is null or char_length(region) <= 40),
  endpoint text check (endpoint is null or char_length(endpoint) <= 300),
  credentials_encrypted text not null check (char_length(credentials_encrypted) between 1 and 8000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null,
  last_tested_at timestamptz,
  last_test_ok boolean
);

alter table public.platform_ai_settings enable row level security;

-- No policy for anon or authenticated: with row-level security on, that means no rows, ever.
drop policy if exists "Service role manages the platform AI settings" on public.platform_ai_settings;
create policy "Service role manages the platform AI settings"
  on public.platform_ai_settings for all
  to service_role
  using (true)
  with check (true);

revoke all on public.platform_ai_settings from public, anon, authenticated;
grant all on public.platform_ai_settings to service_role;
