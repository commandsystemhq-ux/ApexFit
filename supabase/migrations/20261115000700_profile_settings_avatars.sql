-- Editable account profile (name, brand, avatar) and the public avatars bucket.

alter table public.profiles
  add column if not exists full_name text,
  add column if not exists brand_name text,
  add column if not exists avatar_path text;

alter table public.profiles drop constraint if exists profiles_full_name_length;
alter table public.profiles add constraint profiles_full_name_length
  check (full_name is null or char_length(full_name) between 1 and 80);

alter table public.profiles drop constraint if exists profiles_brand_name_length;
alter table public.profiles add constraint profiles_brand_name_length
  check (brand_name is null or char_length(brand_name) between 1 and 80);

alter table public.profiles drop constraint if exists profiles_avatar_path_length;
alter table public.profiles add constraint profiles_avatar_path_length
  check (avatar_path is null or char_length(avatar_path) between 1 and 300);

create or replace function public.get_my_access_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_subscription_status text;
  v_access_state text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select * into v_profile
  from public.profiles
  where id = auth.uid();

  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  select status into v_subscription_status
  from public.coach_subscriptions
  where user_id = v_profile.id;

  if v_profile.role = 'client' then
    v_access_state := 'client';
  elsif v_subscription_status = 'active' then
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
      v_subscription_status,
      case when v_profile.role = 'coach' and v_profile.trial_ends_at > statement_timestamp() then 'trialing' else 'none' end
    ),
    'access_state', v_access_state
  );
end;
$$;

-- The role may come from the browser (OAuth) or from the sign-up metadata (email confirmation in another browser).
create or replace function public.provision_my_profile(p_role text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text := coalesce(p_role, auth.jwt() -> 'user_metadata' ->> 'signup_role');
  v_name text := left(nullif(btrim(coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', '')), ''), 80);
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  if not exists (select 1 from public.profiles where id = auth.uid()) then
    if v_role is null or v_role not in ('coach', 'client') then
      raise exception 'Choose a coach or client account before signing in';
    end if;

    insert into public.profiles (id, role, full_name, trial_started_at, trial_ends_at)
    values (
      auth.uid(),
      v_role,
      v_name,
      case when v_role = 'coach' then statement_timestamp() else null end,
      case when v_role = 'coach' then statement_timestamp() + interval '72 hours' else null end
    )
    on conflict (id) do nothing;
  end if;

  return public.get_my_access_status();
end;
$$;

create or replace function public.update_my_profile(
  p_full_name text,
  p_brand_name text,
  p_avatar_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_name text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_brand text := nullif(btrim(coalesce(p_brand_name, '')), '');
  v_avatar text := nullif(btrim(coalesce(p_avatar_path, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  select role into v_role from public.profiles where id = auth.uid();
  if not found then
    raise exception 'Account profile has not been provisioned';
  end if;

  if v_name is not null and char_length(v_name) > 80 then
    raise exception 'Name is too long';
  end if;
  if v_brand is not null and char_length(v_brand) > 80 then
    raise exception 'Brand name is too long';
  end if;
  if v_role <> 'coach' then
    v_brand := null;
  end if;
  if v_avatar is not null and v_avatar not like auth.uid()::text || '/%' then
    raise exception 'Invalid avatar path';
  end if;

  update public.profiles
  set full_name = v_name, brand_name = v_brand, avatar_path = v_avatar, updated_at = statement_timestamp()
  where id = auth.uid();

  -- Keep the names that clients see on coach links and invites in sync.
  if v_role = 'coach' and coalesce(v_brand, v_name) is not null then
    update public.coach_clients set coach_name = coalesce(v_brand, v_name) where coach_id = auth.uid();
    update public.client_invites set coach_name = coalesce(v_brand, v_name) where coach_id = auth.uid();
  end if;

  return public.get_my_access_status();
end;
$$;

revoke all on function public.get_my_access_status() from public;
revoke all on function public.provision_my_profile(text) from public;
revoke all on function public.update_my_profile(text, text, text) from public;
grant execute on function public.get_my_access_status() to authenticated;
grant execute on function public.provision_my_profile(text) to authenticated;
grant execute on function public.update_my_profile(text, text, text) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload their own avatar" on storage.objects;
create policy "Users can upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can read their own avatar files" on storage.objects;
create policy "Users can read their own avatar files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Users can delete their own avatar" on storage.objects;
create policy "Users can delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
