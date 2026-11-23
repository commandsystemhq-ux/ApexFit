-- Who can accept an invitation to join another coach's team.
--
-- A new coach on the free 72-hour trial, with no clients, no paid subscription and no team of their own, can accept.
-- The trial by itself never blocks joining: it is a field on the profile, not a subscription.
--
-- An account is turned away only when it already runs its own practice:
--   * it has (or ever had) clients,
--   * it has a paid subscription that is still in force (active, or past due within its paid period),
--   * or it has its own team (trainers invited or active), which would be left without a head coach.
-- The first rule keeps its original message; the other two say exactly what is in the way.
create or replace function public.accept_team_invitation(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_member public.coach_team_members%rowtype;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required to join a team';
  end if;
  select * into v_member from public.coach_team_members where id = p_member_id for update;
  if not found or v_member.status <> 'invited' or v_email = '' or v_member.invite_email <> v_email then
    raise exception 'This invitation is not available';
  end if;
  if exists (select 1 from public.coach_clients where coach_id = auth.uid())
    or exists (
      select 1 from public.coach_subscriptions s
      where s.user_id = auth.uid() and public.subscription_grants_access(s.status, s.current_period_end)
    ) then
    raise exception 'This account already runs its own coaching practice, so it cannot join a team';
  end if;
  if exists (select 1 from public.coach_team_members where head_coach_id = auth.uid()) then
    raise exception 'This account already has its own team, so it cannot join another one';
  end if;
  if exists (select 1 from public.coach_team_members where trainer_user_id = auth.uid() and status = 'active') then
    raise exception 'You already belong to a team';
  end if;

  update public.coach_team_members set trainer_user_id = auth.uid(), status = 'active' where id = p_member_id;
  return public.get_my_access_status();
end;
$$;
