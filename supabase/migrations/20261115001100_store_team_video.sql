-- Program store, trainer teams, and live video sessions.
-- Tables are read through row-level security and written only through security definer functions that
-- check the caller's role and ownership themselves.

-- ===========================================================================
-- 0. Shared program assignment (used by coaches, assistant trainers, groups and the store)
-- ===========================================================================

-- Assigns a program on behalf of a coach and starts that coach's "program assigned" workflows.
-- Internal only: callers must already have decided that the acting user may do this.
create or replace function public.assign_program_core(p_coach_id uuid, p_client_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignment uuid;
  v_queued integer;
begin
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = p_coach_id) then
    raise exception 'Program was not found';
  end if;
  if not exists (
    select 1 from public.coach_clients
    where coach_id = p_coach_id and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;

  insert into public.program_assignments (coach_id, client_id, program_id)
  values (p_coach_id, p_client_id, p_program_id)
  returning id into v_assignment;

  v_queued := public.workflow_schedule(p_coach_id, p_client_id, 'plan_assigned', 'program:' || v_assignment);
  perform public.workflow_run_due(p_coach_id, p_client_id);
  return jsonb_build_object('assignment_id', v_assignment, 'steps_queued', v_queued);
end;
$$;

revoke all on function public.assign_program_core(uuid, uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- 1. Trainer teams
-- ===========================================================================

create table if not exists public.coach_team_members (
  id uuid primary key default gen_random_uuid(),
  head_coach_id uuid not null references public.profiles (id) on delete cascade,
  trainer_user_id uuid references public.profiles (id) on delete cascade,
  invite_email text not null check (
    char_length(invite_email) between 3 and 254
    and invite_email = lower(invite_email)
    and invite_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  role_title text not null default '' check (char_length(role_title) <= 80),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object'),
  status text not null default 'invited' check (status in ('invited', 'active', 'disabled')),
  created_at timestamptz not null default now(),
  check (status = 'invited' or trainer_user_id is not null),
  check (trainer_user_id is null or trainer_user_id <> head_coach_id),
  unique (head_coach_id, invite_email),
  unique (id, head_coach_id)
);

-- A person works for one head coach at a time.
create unique index if not exists coach_team_members_one_active_team
  on public.coach_team_members (trainer_user_id) where status = 'active';
create index if not exists coach_team_members_trainer_idx on public.coach_team_members (trainer_user_id);
create index if not exists coach_team_members_email_idx on public.coach_team_members (invite_email) where status = 'invited';

create table if not exists public.client_trainer_assignments (
  id uuid primary key default gen_random_uuid(),
  head_coach_id uuid not null,
  client_id uuid not null,
  team_member_id uuid not null,
  assigned_at timestamptz not null default now(),
  -- One assistant per client, and the assistant must belong to the same head coach as the client.
  unique (head_coach_id, client_id),
  foreign key (head_coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  foreign key (team_member_id, head_coach_id) references public.coach_team_members (id, head_coach_id) on delete cascade
);

create index if not exists client_trainer_assignments_member_idx on public.client_trainer_assignments (team_member_id);

alter table public.coach_team_members enable row level security;
alter table public.client_trainer_assignments enable row level security;

-- Policy helpers (security definer, so policies on different tables cannot recurse into each other).
create or replace function public.my_team_head()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.head_coach_id
  from public.coach_team_members m
  where m.trainer_user_id = auth.uid() and m.status = 'active' and public.workflow_coach_is_active(m.head_coach_id)
  limit 1;
$$;

create or replace function public.team_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.coach_team_members m
    where m.trainer_user_id = auth.uid() and m.status = 'active'
      and m.permissions ->> p_permission = 'true'
      and public.workflow_coach_is_active(m.head_coach_id)
  );
$$;

create or replace function public.trainer_has_client(p_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.client_trainer_assignments a
    join public.coach_team_members m on m.id = a.team_member_id
    join public.coach_clients cc on cc.coach_id = a.head_coach_id and cc.client_id = a.client_id and cc.status = 'active'
    where a.client_id = p_client_id
      and m.trainer_user_id = auth.uid() and m.status = 'active'
      and public.workflow_coach_is_active(a.head_coach_id)
  );
$$;

create or replace function public.trainer_can_see_group(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.team_permission('manage_groups')
    and exists (select 1 from public.coaching_groups where id = p_group_id and coach_id = public.my_team_head());
$$;

create or replace function public.i_own_team_member(p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.coach_team_members where id = p_member_id and trainer_user_id = auth.uid());
$$;

drop policy if exists "Head coaches can read their team" on public.coach_team_members;
create policy "Head coaches can read their team"
  on public.coach_team_members for select
  to authenticated
  using (head_coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Trainers can read their own membership" on public.coach_team_members;
create policy "Trainers can read their own membership"
  on public.coach_team_members for select
  to authenticated
  using (trainer_user_id = (select auth.uid()));

drop policy if exists "Head coaches can read assignments" on public.client_trainer_assignments;
create policy "Head coaches can read assignments"
  on public.client_trainer_assignments for select
  to authenticated
  using (head_coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Trainers can read their assignments" on public.client_trainer_assignments;
create policy "Trainers can read their assignments"
  on public.client_trainer_assignments for select
  to authenticated
  using (public.i_own_team_member(team_member_id));

-- Assistant trainers get read access to exactly what their permissions cover, for their assigned clients only.
drop policy if exists "Trainers can read assigned clients" on public.coach_clients;
create policy "Trainers can read assigned clients"
  on public.coach_clients for select
  to authenticated
  using (coach_id = public.my_team_head() and public.trainer_has_client(client_id));

drop policy if exists "Trainers can read assigned client assessments" on public.client_assessments;
create policy "Trainers can read assigned client assessments"
  on public.client_assessments for select
  to authenticated
  using (
    coach_id = public.my_team_head()
    and public.team_permission('view_assessments')
    and public.trainer_has_client(client_id)
  );

drop policy if exists "Trainers can read the head coach programs" on public.training_programs;
create policy "Trainers can read the head coach programs"
  on public.training_programs for select
  to authenticated
  using (coach_id = public.my_team_head() and public.team_permission('manage_programs'));

drop policy if exists "Trainers can read assigned client messages" on public.coach_messages;
create policy "Trainers can read assigned client messages"
  on public.coach_messages for select
  to authenticated
  using (
    coach_id = public.my_team_head()
    and public.team_permission('messages')
    and public.trainer_has_client(client_id)
  );

drop policy if exists "Trainers can read the team groups" on public.coaching_groups;
create policy "Trainers can read the team groups"
  on public.coaching_groups for select
  to authenticated
  using (public.trainer_can_see_group(id));

drop policy if exists "Trainers can read the team group members" on public.coaching_group_members;
create policy "Trainers can read the team group members"
  on public.coaching_group_members for select
  to authenticated
  using (public.trainer_can_see_group(group_id));

drop policy if exists "Trainers can read the team group announcements" on public.group_announcements;
create policy "Trainers can read the team group announcements"
  on public.group_announcements for select
  to authenticated
  using (public.trainer_can_see_group(group_id));

revoke all on public.coach_team_members, public.client_trainer_assignments from anon, authenticated;
grant select on public.coach_team_members, public.client_trainer_assignments to authenticated;
grant all on public.coach_team_members, public.client_trainer_assignments to service_role;

-- Reduces whatever the browser sends to the four known permissions.
create or replace function public.normalize_team_permissions(p_permissions jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'manage_programs', coalesce(p_permissions ->> 'manage_programs', 'false') = 'true',
    'view_assessments', coalesce(p_permissions ->> 'view_assessments', 'false') = 'true',
    'messages', coalesce(p_permissions ->> 'messages', 'false') = 'true',
    'manage_groups', coalesce(p_permissions ->> 'manage_groups', 'false') = 'true'
  );
$$;

-- The access status now also reports trainer membership. A person with an active membership works under
-- the head coach's plan ('trainer' access), so being invited never unlocks the coach features for free.
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

  select status into v_subscription_status from public.coach_subscriptions where user_id = v_profile.id;

  if v_profile.role = 'coach' then
    select * into v_team from public.coach_team_members where trainer_user_id = v_profile.id and status = 'active' limit 1;
    v_has_team := found;
  end if;

  if v_profile.role = 'client' then
    v_access_state := 'client';
  elsif v_has_team then
    v_access_state := 'trainer';
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

-- Program assignment, now usable by an assistant trainer for their assigned clients.
create or replace function public.assign_program_to_client(p_client_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_active_coach() then
    return public.assign_program_core(auth.uid(), p_client_id, p_program_id);
  elsif public.team_permission('manage_programs') then
    if not public.trainer_has_client(p_client_id) then
      raise exception 'That client is not assigned to you';
    end if;
    return public.assign_program_core(public.my_team_head(), p_client_id, p_program_id);
  end if;
  raise exception 'An active coach account is required to assign programs';
end;
$$;

create or replace function public.get_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'invite_email', m.invite_email,
        'role_title', m.role_title,
        'permissions', m.permissions,
        'status', m.status,
        'trainer_name', (select nullif(btrim(p.full_name), '') from public.profiles p where p.id = m.trainer_user_id),
        'client_count', (select count(*) from public.client_trainer_assignments a where a.team_member_id = m.id),
        'created_at', m.created_at
      )
      order by m.created_at
    )
    from public.coach_team_members m
    where m.head_coach_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

create or replace function public.invite_trainer(p_email text, p_role_title text, p_permissions jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_title text := btrim(coalesce(p_role_title, ''));
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 254 then
    raise exception 'Enter a valid email address';
  end if;
  if v_email = lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'You cannot invite yourself';
  end if;
  if char_length(v_title) > 80 then
    raise exception 'The role title can be at most 80 characters';
  end if;
  if (select count(*) from public.coach_team_members where head_coach_id = auth.uid()) >= 10 then
    raise exception 'A team can have at most 10 trainers';
  end if;
  if exists (select 1 from public.coach_team_members where head_coach_id = auth.uid() and invite_email = v_email) then
    raise exception 'This email has already been invited';
  end if;

  insert into public.coach_team_members (head_coach_id, invite_email, role_title, permissions)
  values (auth.uid(), v_email, v_title, public.normalize_team_permissions(p_permissions))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_team_member(
  p_member_id uuid,
  p_role_title text,
  p_permissions jsonb,
  p_status text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.coach_team_members%rowtype;
  v_title text := btrim(coalesce(p_role_title, ''));
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  select * into v_member from public.coach_team_members where id = p_member_id and head_coach_id = auth.uid() for update;
  if not found then
    raise exception 'Team member was not found';
  end if;
  if char_length(v_title) > 80 then
    raise exception 'The role title can be at most 80 characters';
  end if;
  if p_status is not null and p_status not in ('active', 'disabled') then
    raise exception 'Unsupported status';
  end if;
  if p_status is not null and v_member.trainer_user_id is null then
    raise exception 'Wait until the trainer accepts the invitation';
  end if;

  update public.coach_team_members
  set role_title = v_title,
      permissions = public.normalize_team_permissions(p_permissions),
      status = coalesce(p_status, status)
  where id = p_member_id;
end;
$$;

create or replace function public.remove_team_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  delete from public.coach_team_members where id = p_member_id and head_coach_id = auth.uid();
  if not found then
    raise exception 'Team member was not found';
  end if;
end;
$$;

-- Gives a client to an assistant trainer (or takes them back when p_member_id is null).
create or replace function public.assign_client_trainer(p_client_id uuid, p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage a team';
  end if;
  if not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;

  if p_member_id is null then
    delete from public.client_trainer_assignments where head_coach_id = auth.uid() and client_id = p_client_id;
    return;
  end if;
  if not exists (
    select 1 from public.coach_team_members where id = p_member_id and head_coach_id = auth.uid() and status = 'active'
  ) then
    raise exception 'Choose an active trainer';
  end if;

  insert into public.client_trainer_assignments (head_coach_id, client_id, team_member_id)
  values (auth.uid(), p_client_id, p_member_id)
  on conflict (head_coach_id, client_id) do update set team_member_id = excluded.team_member_id, assigned_at = statement_timestamp();
end;
$$;

-- Invitations addressed to the signed-in coach's email.
create or replace function public.get_my_team_invitations()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid() and role = 'coach') then
    raise exception 'A coach account is required';
  end if;
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'role_title', m.role_title,
        'permissions', m.permissions,
        'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = m.head_coach_id),
        'created_at', m.created_at
      )
      order by m.created_at
    )
    from public.coach_team_members m
    where m.status = 'invited' and m.invite_email = v_email and v_email <> ''
  ), '[]'::jsonb);
end;
$$;

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
    or exists (select 1 from public.coach_subscriptions where user_id = auth.uid() and status = 'active') then
    raise exception 'This account already runs its own coaching practice, so it cannot join a team';
  end if;
  if exists (select 1 from public.coach_team_members where trainer_user_id = auth.uid() and status = 'active') then
    raise exception 'You already belong to a team';
  end if;

  update public.coach_team_members set trainer_user_id = auth.uid(), status = 'active' where id = p_member_id;
  return public.get_my_access_status();
end;
$$;

create or replace function public.decline_team_invitation(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  delete from public.coach_team_members where id = p_member_id and status = 'invited' and invite_email = v_email and v_email <> '';
  if not found then
    raise exception 'This invitation is not available';
  end if;
end;
$$;

create or replace function public.leave_team()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;
  delete from public.coach_team_members where trainer_user_id = auth.uid();
  return public.get_my_access_status();
end;
$$;

-- The assistant trainer's dashboard: only their assigned clients.
create or replace function public.get_trainer_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_head uuid := public.my_team_head();
begin
  if v_head is null then
    raise exception 'You are not part of an active team';
  end if;
  return jsonb_build_object(
    'head_coach_id', v_head,
    'head_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = v_head),
    'permissions', (select m.permissions from public.coach_team_members m where m.trainer_user_id = auth.uid() and m.status = 'active' limit 1),
    'clients', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'client_id', cc.client_id,
          'name', coalesce(nullif(btrim(cc.client_name), ''), nullif(split_part(coalesce(cc.client_email, ''), '@', 1), ''), 'Client'),
          'email', cc.client_email,
          'last_workout_date', (select max(s.workout_date) from public.client_workout_sessions s where s.client_id = cc.client_id),
          'workouts_7d', (select count(*) from public.client_workout_sessions s where s.client_id = cc.client_id and s.workout_date >= current_date - 6),
          'assessment_submitted', exists (select 1 from public.client_assessments a where a.client_id = cc.client_id and a.coach_id = cc.coach_id),
          'medical_clearance_required', exists (select 1 from public.client_assessments a where a.client_id = cc.client_id and a.coach_id = cc.coach_id and a.medical_clearance_required),
          'program', (
            select p.title from public.program_assignments pa join public.training_programs p on p.id = pa.program_id
            where pa.client_id = cc.client_id and pa.coach_id = cc.coach_id order by pa.assigned_at desc limit 1
          )
        )
        order by cc.created_at
      )
      from public.coach_clients cc
      where cc.coach_id = v_head and cc.status = 'active' and public.trainer_has_client(cc.client_id)
    ), '[]'::jsonb),
    'groups', case when public.team_permission('manage_groups') then coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.created_at desc)
      from public.coaching_groups g where g.coach_id = v_head
    ), '[]'::jsonb) else '[]'::jsonb end,
    'programs', case when public.team_permission('manage_programs') then coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title) order by p.updated_at desc)
      from public.training_programs p where p.coach_id = v_head
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$$;

-- An assistant trainer writes to an assigned client as the head coach's team (the client sees a coach note).
create or replace function public.send_team_message(p_client_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_batch uuid := gen_random_uuid();
  v_head uuid := public.my_team_head();
begin
  if v_head is null or not public.team_permission('messages') then
    raise exception 'You do not have permission to message clients';
  end if;
  if not public.trainer_has_client(p_client_id) then
    raise exception 'That client is not assigned to you';
  end if;
  if char_length(v_body) not between 1 and 2000 then
    raise exception 'Write a message of up to 2000 characters';
  end if;
  insert into public.coach_messages (batch_id, coach_id, client_id, kind, body)
  values (v_batch, v_head, p_client_id, 'note', v_body);
  return jsonb_build_object('batch_id', v_batch);
end;
$$;

-- Group management, now also available to assistant trainers with the "manage groups" permission.
create or replace function public.add_group_members(p_group_id uuid, p_client_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid;
  v_trainer boolean := false;
  v_program uuid;
  v_ids uuid[];
  v_client uuid;
  v_added integer := 0;
  v_assigned integer := 0;
  v_inserted integer;
begin
  if public.is_active_coach() then
    v_coach := auth.uid();
  elsif public.team_permission('manage_groups') then
    v_coach := public.my_team_head();
    v_trainer := true;
  else
    raise exception 'An active coach account is required to manage groups';
  end if;

  select program_template_id into v_program from public.coaching_groups where id = p_group_id and coach_id = v_coach;
  if not found then
    raise exception 'Group was not found';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_client_ids, '{}')) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'Choose at least one client';
  end if;
  if (
    select count(*) from public.coach_clients
    where coach_id = v_coach and status = 'active' and client_id = any (v_ids)
  ) <> array_length(v_ids, 1) then
    raise exception 'Only your active clients can be added to a group';
  end if;
  if v_trainer then
    foreach v_client in array v_ids loop
      if not public.trainer_has_client(v_client) then
        raise exception 'You can only add clients assigned to you';
      end if;
    end loop;
  end if;
  if (select count(*) from public.coaching_group_members where group_id = p_group_id) + array_length(v_ids, 1) > 100 then
    raise exception 'A group can have at most 100 members';
  end if;

  foreach v_client in array v_ids loop
    insert into public.coaching_group_members (group_id, client_id) values (p_group_id, v_client)
    on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted > 0 then
      v_added := v_added + 1;
      if v_program is not null then
        perform public.assign_program_core(v_coach, v_client, v_program);
        v_assigned := v_assigned + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object('added', v_added, 'program_assigned', v_assigned);
end;
$$;

create or replace function public.remove_group_member(p_group_id uuid, p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.is_active_coach() and public.is_group_owner(p_group_id) then
    null;
  elsif public.trainer_can_see_group(p_group_id) then
    if not public.trainer_has_client(p_client_id) then
      raise exception 'You can only manage clients assigned to you';
    end if;
  else
    raise exception 'Group was not found';
  end if;
  delete from public.coaching_group_members where group_id = p_group_id and client_id = p_client_id;
  if not found then
    raise exception 'That client is not in this group';
  end if;
end;
$$;

create or replace function public.post_group_announcement(p_group_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not ((public.is_active_coach() and public.is_group_owner(p_group_id)) or public.trainer_can_see_group(p_group_id)) then
    raise exception 'Group was not found';
  end if;
  if char_length(v_body) not between 1 and 1000 then
    raise exception 'Write an update of up to 1000 characters';
  end if;
  if (
    select count(*) from public.group_announcements
    where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour'
  ) >= 20 then
    raise exception 'You are posting too quickly. Try again later';
  end if;

  insert into public.group_announcements (group_id, author_id, body)
  values (p_group_id, auth.uid(), v_body)
  returning id into v_id;
  return v_id;
end;
$$;

-- ===========================================================================
-- 2. Program store
-- ===========================================================================

create table if not exists public.store_products (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  program_template_id uuid not null references public.training_programs (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  price_cents integer not null check (price_cents = 0 or price_cents between 50 and 100000000),
  currency text not null default 'usd' check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  cover_image_url text check (cover_image_url is null or (char_length(cover_image_url) <= 500 and cover_image_url ~ '^https://[^[:space:]<>"]+$')),
  is_published boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists store_products_coach_idx on public.store_products (coach_id, created_at desc);
create index if not exists store_products_published_idx on public.store_products (coach_id) where is_published;

create table if not exists public.store_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.store_products (id) on delete set null,
  buyer_client_id uuid not null,
  coach_id uuid not null,
  -- The title and program are copied so the buyer keeps access if the product is later removed.
  product_title text not null,
  program_template_id uuid references public.training_programs (id) on delete set null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null check (currency in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'canceled')),
  payment_mode text not null default 'stripe' check (payment_mode in ('stripe', 'free', 'demo')),
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  assignment_id uuid references public.program_assignments (id) on delete set null,
  note text check (note is null or char_length(note) <= 300),
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (coach_id, buyer_client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

-- A client can have only one open or paid order per product, so double clicks and retries never double-buy.
create unique index if not exists store_orders_one_per_product
  on public.store_orders (product_id, buyer_client_id) where status in ('pending', 'paid') and product_id is not null;
create index if not exists store_orders_coach_idx on public.store_orders (coach_id, created_at desc);
create index if not exists store_orders_buyer_idx on public.store_orders (buyer_client_id, created_at desc);

alter table public.store_products enable row level security;
alter table public.store_orders enable row level security;

drop policy if exists "Coaches can read their products" on public.store_products;
create policy "Coaches can read their products"
  on public.store_products for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read published products from their coach" on public.store_products;
create policy "Clients can read published products from their coach"
  on public.store_products for select
  to authenticated
  using (
    is_published
    and public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = store_products.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
  );

drop policy if exists "Coaches can read their orders" on public.store_orders;
create policy "Coaches can read their orders"
  on public.store_orders for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Buyers can read their orders" on public.store_orders;
create policy "Buyers can read their orders"
  on public.store_orders for select
  to authenticated
  using (buyer_client_id = (select auth.uid()) and public.is_client_account());

revoke all on public.store_products, public.store_orders from anon, authenticated;
grant select on public.store_products, public.store_orders to authenticated;
grant all on public.store_products, public.store_orders to service_role;

create or replace function public.save_store_product(
  p_product_id uuid,
  p_program_id uuid,
  p_title text,
  p_description text,
  p_price_cents integer,
  p_currency text,
  p_cover_image_url text,
  p_publish boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_cover text := nullif(btrim(coalesce(p_cover_image_url, '')), '');
  v_current public.store_products%rowtype;
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the product a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_price_cents is null or not (p_price_cents = 0 or p_price_cents between 50 and 100000000) then
    raise exception 'The price must be free or at least 0.50';
  end if;
  if p_currency is null or p_currency not in ('usd', 'eur', 'gbp', 'egp', 'sar', 'aed') then
    raise exception 'Choose a supported currency';
  end if;
  if v_cover is not null and (char_length(v_cover) > 500 or v_cover !~ '^https://[^[:space:]<>"]+$') then
    raise exception 'The cover image must be a secure https link';
  end if;
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = auth.uid()) then
    raise exception 'Program was not found';
  end if;

  if p_product_id is null then
    if (select count(*) from public.store_products where coach_id = auth.uid()) >= 50 then
      raise exception 'You can have at most 50 products';
    end if;
    insert into public.store_products (coach_id, program_template_id, title, description, price_cents, currency, cover_image_url, is_published)
    values (auth.uid(), p_program_id, v_title, v_description, p_price_cents, p_currency, v_cover, coalesce(p_publish, false))
    returning id into v_id;
    return v_id;
  end if;

  select * into v_current from public.store_products where id = p_product_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Product was not found';
  end if;
  if v_current.program_template_id <> p_program_id
    and exists (select 1 from public.store_orders where product_id = p_product_id) then
    raise exception 'The program cannot change once the product has orders';
  end if;

  update public.store_products
  set program_template_id = p_program_id, title = v_title, description = v_description, price_cents = p_price_cents,
      currency = p_currency, cover_image_url = v_cover, is_published = coalesce(p_publish, is_published)
  where id = p_product_id;
  return p_product_id;
end;
$$;

create or replace function public.set_store_product_published(p_product_id uuid, p_published boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  update public.store_products set is_published = coalesce(p_published, false)
  where id = p_product_id and coach_id = auth.uid();
  if not found then
    raise exception 'Product was not found';
  end if;
end;
$$;

create or replace function public.delete_store_product(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  if not exists (select 1 from public.store_products where id = p_product_id and coach_id = auth.uid()) then
    raise exception 'Product was not found';
  end if;
  if exists (select 1 from public.store_orders where product_id = p_product_id and status in ('paid', 'refunded')) then
    raise exception 'Products with sales cannot be deleted. Unpublish it instead';
  end if;
  delete from public.store_orders where product_id = p_product_id and status in ('pending', 'canceled');
  delete from public.store_products where id = p_product_id and coach_id = auth.uid();
end;
$$;

-- Marks an order as paid and gives the buyer the program. Safe to call twice for the same order.
create or replace function public.finish_store_order(
  p_order_id uuid,
  p_mode text,
  p_session_id text,
  p_payment_intent text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_assignment jsonb;
  v_note text;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found then
    raise exception 'Order was not found';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'status', 'paid', 'already_paid', true, 'assignment_id', v_order.assignment_id);
  end if;
  if v_order.status <> 'pending' then
    raise exception 'This order can no longer be completed';
  end if;

  begin
    v_assignment := public.assign_program_core(v_order.coach_id, v_order.buyer_client_id, v_order.program_template_id);
  exception when others then
    v_assignment := null;
    v_note := left('Program was not delivered: ' || sqlerrm, 300);
  end;

  update public.store_orders
  set status = 'paid',
      payment_mode = p_mode,
      stripe_session_id = coalesce(p_session_id, stripe_session_id),
      stripe_payment_intent_id = coalesce(p_payment_intent, stripe_payment_intent_id),
      assignment_id = (v_assignment ->> 'assignment_id')::uuid,
      note = v_note,
      purchased_at = statement_timestamp()
  where id = p_order_id;

  return jsonb_build_object(
    'order_id', p_order_id, 'status', 'paid', 'already_paid', false,
    'assignment_id', v_assignment ->> 'assignment_id', 'delivered', v_assignment is not null
  );
end;
$$;

-- Starts (or resumes) a purchase for the signed-in client. Free products are completed on the spot.
create or replace function public.begin_store_purchase(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.store_products%rowtype;
  v_order public.store_orders%rowtype;
  v_done jsonb;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to buy programs';
  end if;

  select * into v_product from public.store_products where id = p_product_id;
  if not found or not v_product.is_published or not exists (
    select 1 from public.coach_clients where coach_id = v_product.coach_id and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'This product is not available';
  end if;
  if not public.workflow_coach_is_active(v_product.coach_id) then
    raise exception 'This store is not accepting orders right now';
  end if;

  select * into v_order from public.store_orders
  where product_id = p_product_id and buyer_client_id = auth.uid() and status in ('pending', 'paid')
  for update;

  if found and v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'already_owned', true, 'completed', true);
  end if;

  if not found then
    insert into public.store_orders (product_id, buyer_client_id, coach_id, product_title, program_template_id, amount_cents, currency, payment_mode)
    values (p_product_id, auth.uid(), v_product.coach_id, v_product.title, v_product.program_template_id,
            v_product.price_cents, v_product.currency, case when v_product.price_cents = 0 then 'free' else 'stripe' end)
    returning * into v_order;
  else
    -- The coach may have changed the price since the checkout was started.
    update public.store_orders
    set product_title = v_product.title, program_template_id = v_product.program_template_id,
        amount_cents = v_product.price_cents, currency = v_product.currency,
        payment_mode = case when v_product.price_cents = 0 then 'free' else 'stripe' end,
        stripe_session_id = null
    where id = v_order.id
    returning * into v_order;
  end if;

  if v_order.amount_cents = 0 then
    v_done := public.finish_store_order(v_order.id, 'free', null, null);
    return jsonb_build_object('order_id', v_order.id, 'already_owned', false, 'completed', true, 'assignment_id', v_done ->> 'assignment_id');
  end if;

  return jsonb_build_object(
    'order_id', v_order.id, 'already_owned', false, 'completed', false,
    'amount_cents', v_order.amount_cents, 'currency', v_order.currency,
    'title', v_order.product_title, 'coach_id', v_order.coach_id
  );
end;
$$;

-- Called by the payment webhook (or by demo mode) with the service role. Verifies the amount before delivering.
create or replace function public.complete_store_order(
  p_order_id uuid,
  p_session_id text,
  p_amount_cents integer,
  p_currency text,
  p_payment_intent text,
  p_mode text default 'stripe'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
begin
  if p_mode not in ('stripe', 'demo') then
    raise exception 'Unsupported payment mode';
  end if;
  select * into v_order from public.store_orders where id = p_order_id;
  if not found then
    raise exception 'Order was not found';
  end if;
  if v_order.status = 'paid' then
    return jsonb_build_object('order_id', v_order.id, 'status', 'paid', 'already_paid', true);
  end if;
  if p_mode = 'stripe' and (p_amount_cents is distinct from v_order.amount_cents or lower(coalesce(p_currency, '')) <> v_order.currency) then
    raise exception 'The payment does not match the order';
  end if;
  return public.finish_store_order(p_order_id, p_mode, p_session_id, p_payment_intent);
end;
$$;

create or replace function public.get_store_sales()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage the store';
  end if;
  return jsonb_build_object(
    'orders_paid', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'paid'),
    'orders_pending', (select count(*) from public.store_orders where coach_id = auth.uid() and status = 'pending'),
    'revenue', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'cents', total) order by currency)
      from (
        select currency, sum(amount_cents)::bigint as total
        from public.store_orders where coach_id = auth.uid() and status = 'paid' group by currency
      ) r
    ), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', p.id, 'title', p.title, 'sales', s.sales, 'cents', s.cents, 'currency', p.currency) order by s.sales desc, p.title)
      from public.store_products p
      cross join lateral (
        select count(*) filter (where o.status = 'paid')::integer as sales,
               coalesce(sum(o.amount_cents) filter (where o.status = 'paid'), 0)::bigint as cents
        from public.store_orders o where o.product_id = p.id
      ) s
      where p.coach_id = auth.uid()
    ), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'payment_mode', o.payment_mode, 'purchased_at', o.purchased_at, 'delivered', o.assignment_id is not null,
        'buyer', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client')
      ) order by o.purchased_at desc)
      from (
        select * from public.store_orders where coach_id = auth.uid() and status = 'paid' order by purchased_at desc limit 20
      ) o
      left join public.coach_clients cc on cc.coach_id = o.coach_id and cc.client_id = o.buyer_client_id
    ), '[]'::jsonb)
  );
end;
$$;

-- What the client sees in the store: their coach's published products, what they own, and the purchased programs.
create or replace function public.get_my_store()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'price_cents', p.price_cents, 'currency', p.currency,
        'cover_image_url', p.cover_image_url,
        'coach_name', coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), '')),
        'owned', exists (select 1 from public.store_orders o where o.product_id = p.id and o.buyer_client_id = auth.uid() and o.status = 'paid')
      ) order by p.created_at desc)
      from public.store_products p
      join public.coach_clients cc on cc.coach_id = p.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
      left join public.profiles pr on pr.id = p.coach_id
      where p.is_published and public.workflow_coach_is_active(p.coach_id)
    ), '[]'::jsonb),
    'purchases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id, 'title', o.product_title, 'amount_cents', o.amount_cents, 'currency', o.currency,
        'purchased_at', o.purchased_at,
        'program', case when o.program_template_id is null then null else public.program_summary(o.program_template_id) end
      ) order by o.purchased_at desc)
      from public.store_orders o
      where o.buyer_client_id = auth.uid() and o.status = 'paid'
    ), '[]'::jsonb)
  );
end;
$$;

-- The coach's public storefront: published products only, no sign-in needed.
create or replace function public.get_public_store(p_coach_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
begin
  select coalesce(nullif(btrim(brand_name), ''), nullif(btrim(full_name), '')) into v_name
  from public.profiles where id = p_coach_id and role = 'coach';
  if not found or not public.workflow_coach_is_active(p_coach_id) then
    return null;
  end if;
  return jsonb_build_object(
    'coach_name', v_name,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'title', p.title, 'description', p.description, 'price_cents', p.price_cents,
        'currency', p.currency, 'cover_image_url', p.cover_image_url
      ) order by p.created_at desc)
      from public.store_products p where p.coach_id = p_coach_id and p.is_published
    ), '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- 3. Live video sessions
-- ===========================================================================

create table if not exists public.video_sessions (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid,
  group_id uuid references public.coaching_groups (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 480),
  provider text not null check (provider in ('zoom', 'google_meet', 'custom')),
  meeting_url text not null check (char_length(meeting_url) <= 500 and meeting_url ~ '^https://[^[:space:]<>"]+$'),
  meeting_passcode text not null default '' check (char_length(meeting_passcode) <= 50),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  -- A session is either one-to-one or for a group.
  check (num_nonnulls(client_id, group_id) = 1),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists video_sessions_coach_idx on public.video_sessions (coach_id, scheduled_at desc);
create index if not exists video_sessions_client_idx on public.video_sessions (client_id, scheduled_at desc) where client_id is not null;
create index if not exists video_sessions_group_idx on public.video_sessions (group_id, scheduled_at desc) where group_id is not null;

alter table public.video_sessions enable row level security;

drop policy if exists "Coaches can read their video sessions" on public.video_sessions;
create policy "Coaches can read their video sessions"
  on public.video_sessions for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read their video sessions" on public.video_sessions;
create policy "Clients can read their video sessions"
  on public.video_sessions for select
  to authenticated
  using (
    public.is_client_account()
    and (
      (
        client_id = (select auth.uid())
        and exists (
          select 1 from public.coach_clients cc
          where cc.coach_id = video_sessions.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
        )
      )
      or (group_id is not null and public.is_group_member(group_id))
    )
  );

revoke all on public.video_sessions from anon, authenticated;
grant select on public.video_sessions to authenticated;
grant all on public.video_sessions to service_role;

create or replace function public.video_link_matches_provider(p_provider text, p_url text)
returns boolean
language sql
immutable
as $$
  select case p_provider
    when 'zoom' then p_url ~* '^https://([a-z0-9-]+\.)*(zoom\.us|zoom\.com|zoomgov\.com)(/|\?|$)'
    when 'google_meet' then p_url ~* '^https://meet\.google\.com(/|\?|$)'
    when 'custom' then true
    else false
  end;
$$;

create or replace function public.schedule_video_session(
  p_client_id uuid,
  p_group_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_provider text,
  p_meeting_url text,
  p_meeting_passcode text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_url text := btrim(coalesce(p_meeting_url, ''));
  v_passcode text := btrim(coalesce(p_meeting_passcode, ''));
  v_id uuid;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if num_nonnulls(p_client_id, p_group_id) <> 1 then
    raise exception 'Choose one client or one group';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client';
  end if;
  if p_group_id is not null and not exists (
    select 1 from public.coaching_groups where id = p_group_id and coach_id = auth.uid()
  ) then
    raise exception 'Group was not found';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the session a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_scheduled_at is null or p_scheduled_at < statement_timestamp() - interval '1 hour'
    or p_scheduled_at > statement_timestamp() + interval '2 years' then
    raise exception 'Choose a date and time in the future';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    raise exception 'The duration must be between 5 and 480 minutes';
  end if;
  if p_provider is null or p_provider not in ('zoom', 'google_meet', 'custom') then
    raise exception 'Choose a video provider';
  end if;
  if char_length(v_url) > 500 or v_url !~ '^https://[^[:space:]<>"]+$' then
    raise exception 'The meeting link must be a secure https link';
  end if;
  if not public.video_link_matches_provider(p_provider, v_url) then
    raise exception 'The meeting link does not match the selected provider';
  end if;
  if char_length(v_passcode) > 50 then
    raise exception 'The passcode can be at most 50 characters';
  end if;
  if (select count(*) from public.video_sessions where coach_id = auth.uid() and status = 'scheduled' and scheduled_at > statement_timestamp()) >= 200 then
    raise exception 'You have too many upcoming sessions';
  end if;

  insert into public.video_sessions (
    coach_id, client_id, group_id, title, description, scheduled_at, duration_minutes, provider, meeting_url, meeting_passcode
  )
  values (auth.uid(), p_client_id, p_group_id, v_title, v_description, p_scheduled_at, p_duration_minutes, p_provider, v_url, v_passcode)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.update_video_session(
  p_session_id uuid,
  p_title text,
  p_description text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_provider text,
  p_meeting_url text,
  p_meeting_passcode text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_url text := btrim(coalesce(p_meeting_url, ''));
  v_passcode text := btrim(coalesce(p_meeting_passcode, ''));
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if not exists (select 1 from public.video_sessions where id = p_session_id and coach_id = auth.uid()) then
    raise exception 'Session was not found';
  end if;
  if char_length(v_title) not between 1 and 120 then
    raise exception 'Give the session a title of up to 120 characters';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description cannot exceed 1000 characters';
  end if;
  if p_scheduled_at is null or p_scheduled_at > statement_timestamp() + interval '2 years' then
    raise exception 'Choose a date and time in the future';
  end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 480 then
    raise exception 'The duration must be between 5 and 480 minutes';
  end if;
  if p_provider is null or p_provider not in ('zoom', 'google_meet', 'custom') then
    raise exception 'Choose a video provider';
  end if;
  if char_length(v_url) > 500 or v_url !~ '^https://[^[:space:]<>"]+$' then
    raise exception 'The meeting link must be a secure https link';
  end if;
  if not public.video_link_matches_provider(p_provider, v_url) then
    raise exception 'The meeting link does not match the selected provider';
  end if;
  if char_length(v_passcode) > 50 then
    raise exception 'The passcode can be at most 50 characters';
  end if;

  update public.video_sessions
  set title = v_title, description = v_description, scheduled_at = p_scheduled_at, duration_minutes = p_duration_minutes,
      provider = p_provider, meeting_url = v_url, meeting_passcode = v_passcode
  where id = p_session_id and coach_id = auth.uid();
end;
$$;

create or replace function public.set_video_session_status(p_session_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  if p_status is null or p_status not in ('scheduled', 'completed', 'cancelled') then
    raise exception 'Unsupported status';
  end if;
  update public.video_sessions set status = p_status where id = p_session_id and coach_id = auth.uid();
  if not found then
    raise exception 'Session was not found';
  end if;
end;
$$;

create or replace function public.delete_video_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to schedule sessions';
  end if;
  delete from public.video_sessions where id = p_session_id and coach_id = auth.uid();
  if not found then
    raise exception 'Session was not found';
  end if;
end;
$$;

-- The client's sessions with the coach and group names, for the recent past and the coming months.
create or replace function public.get_my_video_sessions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(s)::jsonb order by s.scheduled_at)
    from (
      select v.id, v.title, v.description, v.scheduled_at, v.duration_minutes, v.provider, v.meeting_url,
             v.meeting_passcode, v.status, v.group_id, g.name as group_name,
             coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), '')) as coach_name
      from public.video_sessions v
      left join public.coaching_groups g on g.id = v.group_id
      left join public.profiles pr on pr.id = v.coach_id
      where v.scheduled_at > statement_timestamp() - interval '30 days'
        and v.scheduled_at < statement_timestamp() + interval '180 days'
        and (
          (v.client_id = auth.uid() and exists (
            select 1 from public.coach_clients cc where cc.coach_id = v.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
          ))
          or (v.group_id is not null and public.is_group_member(v.group_id))
        )
      order by v.scheduled_at
      limit 100
    ) s
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- Grants
-- ===========================================================================

revoke all on function public.normalize_team_permissions(jsonb) from public, anon, authenticated;
revoke all on function public.video_link_matches_provider(text, text) from public, anon, authenticated;
revoke all on function public.finish_store_order(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.my_team_head() from public, anon;
revoke all on function public.team_permission(text) from public, anon;
revoke all on function public.trainer_has_client(uuid) from public, anon;
revoke all on function public.trainer_can_see_group(uuid) from public, anon;
revoke all on function public.i_own_team_member(uuid) from public, anon;
grant execute on function public.my_team_head() to authenticated;
grant execute on function public.team_permission(text) to authenticated;
grant execute on function public.trainer_has_client(uuid) to authenticated;
grant execute on function public.trainer_can_see_group(uuid) to authenticated;
grant execute on function public.i_own_team_member(uuid) to authenticated;

revoke all on function public.get_my_access_status() from public;
grant execute on function public.get_my_access_status() to authenticated;
revoke all on function public.assign_program_to_client(uuid, uuid) from public, anon;
grant execute on function public.assign_program_to_client(uuid, uuid) to authenticated;
revoke all on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon;
revoke all on function public.post_group_announcement(uuid, text) from public, anon;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.post_group_announcement(uuid, text) to authenticated;

revoke all on function public.get_team() from public, anon;
revoke all on function public.invite_trainer(text, text, jsonb) from public, anon;
revoke all on function public.update_team_member(uuid, text, jsonb, text) from public, anon;
revoke all on function public.remove_team_member(uuid) from public, anon;
revoke all on function public.assign_client_trainer(uuid, uuid) from public, anon;
revoke all on function public.get_my_team_invitations() from public, anon;
revoke all on function public.accept_team_invitation(uuid) from public, anon;
revoke all on function public.decline_team_invitation(uuid) from public, anon;
revoke all on function public.leave_team() from public, anon;
revoke all on function public.get_trainer_overview() from public, anon;
revoke all on function public.send_team_message(uuid, text) from public, anon;
grant execute on function public.get_team() to authenticated;
grant execute on function public.invite_trainer(text, text, jsonb) to authenticated;
grant execute on function public.update_team_member(uuid, text, jsonb, text) to authenticated;
grant execute on function public.remove_team_member(uuid) to authenticated;
grant execute on function public.assign_client_trainer(uuid, uuid) to authenticated;
grant execute on function public.get_my_team_invitations() to authenticated;
grant execute on function public.accept_team_invitation(uuid) to authenticated;
grant execute on function public.decline_team_invitation(uuid) to authenticated;
grant execute on function public.leave_team() to authenticated;
grant execute on function public.get_trainer_overview() to authenticated;
grant execute on function public.send_team_message(uuid, text) to authenticated;

revoke all on function public.save_store_product(uuid, uuid, text, text, integer, text, text, boolean) from public, anon;
revoke all on function public.set_store_product_published(uuid, boolean) from public, anon;
revoke all on function public.delete_store_product(uuid) from public, anon;
revoke all on function public.begin_store_purchase(uuid) from public, anon;
revoke all on function public.get_store_sales() from public, anon;
revoke all on function public.get_my_store() from public, anon;
grant execute on function public.save_store_product(uuid, uuid, text, text, integer, text, text, boolean) to authenticated;
grant execute on function public.set_store_product_published(uuid, boolean) to authenticated;
grant execute on function public.delete_store_product(uuid) to authenticated;
grant execute on function public.begin_store_purchase(uuid) to authenticated;
grant execute on function public.get_store_sales() to authenticated;
grant execute on function public.get_my_store() to authenticated;

-- Only the server (service role) may confirm a payment.
revoke all on function public.complete_store_order(uuid, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_store_order(uuid, text, integer, text, text, text) to service_role;

revoke all on function public.get_public_store(uuid) from public;
grant execute on function public.get_public_store(uuid) to anon, authenticated;

revoke all on function public.schedule_video_session(uuid, uuid, text, text, timestamptz, integer, text, text, text) from public, anon;
revoke all on function public.update_video_session(uuid, text, text, timestamptz, integer, text, text, text) from public, anon;
revoke all on function public.set_video_session_status(uuid, text) from public, anon;
revoke all on function public.delete_video_session(uuid) from public, anon;
revoke all on function public.get_my_video_sessions() from public, anon;
grant execute on function public.schedule_video_session(uuid, uuid, text, text, timestamptz, integer, text, text, text) to authenticated;
grant execute on function public.update_video_session(uuid, text, text, timestamptz, integer, text, text, text) to authenticated;
grant execute on function public.set_video_session_status(uuid, text) to authenticated;
grant execute on function public.delete_video_session(uuid) to authenticated;
grant execute on function public.get_my_video_sessions() to authenticated;
