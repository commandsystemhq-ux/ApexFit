-- Free trial for new coach accounts: 14 days (336 hours) instead of 72 hours.
-- Existing coaches keep the window they already have, so the constraint accepts both lengths.
alter table public.profiles drop constraint if exists coach_trial_window;
alter table public.profiles add constraint coach_trial_window check (
  (
    role = 'coach'
    and trial_started_at is not null
    and trial_ends_at in (trial_started_at + interval '72 hours', trial_started_at + interval '336 hours')
  )
  or (role = 'client' and trial_started_at is null and trial_ends_at is null)
);

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
      case when v_role = 'coach' then statement_timestamp() + interval '336 hours' else null end
    )
    on conflict (id) do nothing;
  end if;

  return public.get_my_access_status();
end;
$$;

revoke all on function public.provision_my_profile(text) from public, anon;
grant execute on function public.provision_my_profile(text) to authenticated;