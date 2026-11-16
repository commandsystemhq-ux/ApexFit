-- Health assessments (PAR-Q), e-signed contracts, and group coaching.
-- Every table is read through row-level security and written only through the security definer
-- functions below, which check the caller's role and ownership themselves.

-- ---------------------------------------------------------------------------
-- 1. Health & fitness assessments (PAR-Q)
-- ---------------------------------------------------------------------------

create table if not exists public.client_assessments (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null,
  client_id uuid not null,
  parq_answers jsonb not null check (jsonb_typeof(parq_answers) = 'object'),
  fitness_goals text not null default '' check (length(fitness_goals) <= 1000),
  injuries_notes text not null default '' check (length(injuries_notes) <= 1000),
  medical_clearance_required boolean not null default false,
  submitted_at timestamptz not null default now(),
  -- A client keeps one current assessment per coach; filling it in again replaces it.
  unique (coach_id, client_id),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists client_assessments_client_idx on public.client_assessments (client_id);
create index if not exists client_assessments_clearance_idx
  on public.client_assessments (coach_id) where medical_clearance_required;

alter table public.client_assessments enable row level security;

drop policy if exists "Clients can read their assessments" on public.client_assessments;
create policy "Clients can read their assessments"
  on public.client_assessments for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their clients assessments" on public.client_assessments;
create policy "Coaches can read their clients assessments"
  on public.client_assessments for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.client_assessments from anon, authenticated;
grant select on public.client_assessments to authenticated;
grant all on public.client_assessments to service_role;

-- The client answers seven yes/no PAR-Q questions (q1..q7). Any "yes" requires medical clearance;
-- that flag is computed here, never taken from the browser.
create or replace function public.submit_my_assessment(
  p_coach_id uuid,
  p_parq jsonb,
  p_goals text,
  p_injuries text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := p_coach_id;
  v_links integer;
  v_goals text := btrim(coalesce(p_goals, ''));
  v_injuries text := btrim(coalesce(p_injuries, ''));
  v_answers jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_clearance boolean := false;
  v_submitted timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to submit an assessment';
  end if;

  if v_coach is null then
    select count(*) into v_links from public.coach_clients where client_id = auth.uid() and status = 'active';
    if v_links = 0 then
      raise exception 'Join a coach before submitting an assessment';
    elsif v_links > 1 then
      raise exception 'Choose which coach receives this assessment';
    end if;
    select coach_id into v_coach from public.coach_clients where client_id = auth.uid() and status = 'active';
  elsif not exists (
    select 1 from public.coach_clients where coach_id = v_coach and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'You are not linked to this coach';
  end if;

  if p_parq is null or jsonb_typeof(p_parq) <> 'object' then
    raise exception 'Answer all seven health questions';
  end if;
  for i in 1..7 loop
    v_key := 'q' || i;
    v_value := p_parq -> v_key;
    if v_value is null or jsonb_typeof(v_value) <> 'boolean' then
      raise exception 'Answer all seven health questions with yes or no';
    end if;
    v_answers := v_answers || jsonb_build_object(v_key, v_value);
    if v_value = 'true'::jsonb then
      v_clearance := true;
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(p_parq)) <> 7 then
    raise exception 'Unexpected health question answers';
  end if;

  if v_goals = '' then
    raise exception 'Describe your fitness goals';
  end if;
  if char_length(v_goals) > 1000 or char_length(v_injuries) > 1000 then
    raise exception 'Goals and injury notes can be at most 1000 characters';
  end if;

  insert into public.client_assessments (
    coach_id, client_id, parq_answers, fitness_goals, injuries_notes, medical_clearance_required, submitted_at
  )
  values (v_coach, auth.uid(), v_answers, v_goals, v_injuries, v_clearance, v_submitted)
  on conflict (coach_id, client_id) do update
  set parq_answers = excluded.parq_answers,
      fitness_goals = excluded.fitness_goals,
      injuries_notes = excluded.injuries_notes,
      medical_clearance_required = excluded.medical_clearance_required,
      submitted_at = excluded.submitted_at;

  return jsonb_build_object('coach_id', v_coach, 'medical_clearance_required', v_clearance, 'submitted_at', v_submitted);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Contracts and e-signatures
-- ---------------------------------------------------------------------------

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 160),
  content_text text not null check (length(btrim(content_text)) between 1 and 20000),
  is_required_on_onboarding boolean not null default false,
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists contracts_coach_idx on public.contracts (coach_id, created_at desc);

create table if not exists public.contract_signatures (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  signer_full_name text not null check (char_length(btrim(signer_full_name)) between 2 and 120),
  signature_data_url text not null check (
    char_length(signature_data_url) <= 300000
    and signature_data_url ~ '^data:image/png;base64,[A-Za-z0-9+/=]{100,}$'
  ),
  -- The signed wording is kept with the signature, so the record never changes afterwards.
  contract_title text not null,
  content_snapshot text not null,
  ip_or_user_agent text check (ip_or_user_agent is null or char_length(ip_or_user_agent) <= 400),
  signed_at timestamptz not null default now(),
  -- A client signs a contract only once.
  unique (contract_id, client_id)
);

create index if not exists contract_signatures_client_idx on public.contract_signatures (client_id, signed_at desc);

alter table public.contracts enable row level security;
alter table public.contract_signatures enable row level security;

-- Policy helpers are security definer so the contracts and signatures policies cannot recurse into each other.
create or replace function public.is_contract_owner(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.contracts where id = p_contract_id and coach_id = auth.uid());
$$;

create or replace function public.i_signed_contract(p_contract_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.contract_signatures where contract_id = p_contract_id and client_id = auth.uid());
$$;

drop policy if exists "Coaches can read their contracts" on public.contracts;
create policy "Coaches can read their contracts"
  on public.contracts for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read contracts from their coach" on public.contracts;
create policy "Clients can read contracts from their coach"
  on public.contracts for select
  to authenticated
  using (
    public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = contracts.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
    and (not is_archived or public.i_signed_contract(id))
  );

drop policy if exists "Clients can read their signatures" on public.contract_signatures;
create policy "Clients can read their signatures"
  on public.contract_signatures for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read signatures on their contracts" on public.contract_signatures;
create policy "Coaches can read signatures on their contracts"
  on public.contract_signatures for select
  to authenticated
  using (public.is_active_coach() and public.is_contract_owner(contract_id));

revoke all on public.contracts, public.contract_signatures from anon, authenticated;
grant select on public.contracts, public.contract_signatures to authenticated;
grant all on public.contracts, public.contract_signatures to service_role;

-- Best-effort "ip | user agent" from the PostgREST request headers.
create or replace function public.request_client_hint()
returns text
language plpgsql
stable
as $$
declare
  v_headers json;
  v_ip text;
  v_agent text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  v_agent := nullif(btrim(coalesce(v_headers ->> 'user-agent', '')), '');
  return nullif(left(concat_ws(' | ', v_ip, v_agent), 400), '');
end;
$$;

create or replace function public.save_contract(
  p_contract_id uuid,
  p_title text,
  p_content text,
  p_required boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_content text := btrim(coalesce(p_content, ''));
  v_current public.contracts%rowtype;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage contracts';
  end if;
  if char_length(v_title) not between 1 and 160 then
    raise exception 'Give the contract a title of up to 160 characters';
  end if;
  if char_length(v_content) not between 1 and 20000 then
    raise exception 'The contract text must be between 1 and 20000 characters';
  end if;

  if p_contract_id is null then
    if (select count(*) from public.contracts where coach_id = auth.uid()) >= 50 then
      raise exception 'You can have at most 50 contracts. Archive or delete old ones first';
    end if;
    insert into public.contracts (coach_id, title, content_text, is_required_on_onboarding)
    values (auth.uid(), v_title, v_content, coalesce(p_required, false))
    returning id into v_id;
    return v_id;
  end if;

  select * into v_current from public.contracts where id = p_contract_id and coach_id = auth.uid() for update;
  if not found then
    raise exception 'Contract was not found';
  end if;
  if (v_current.title <> v_title or v_current.content_text <> v_content)
    and exists (select 1 from public.contract_signatures where contract_id = p_contract_id) then
    raise exception 'This contract already has signatures. Archive it and create a new version instead';
  end if;

  update public.contracts
  set title = v_title, content_text = v_content, is_required_on_onboarding = coalesce(p_required, is_required_on_onboarding)
  where id = p_contract_id;
  return p_contract_id;
end;
$$;

create or replace function public.set_contract_archived(p_contract_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage contracts';
  end if;
  update public.contracts set is_archived = coalesce(p_archived, false)
  where id = p_contract_id and coach_id = auth.uid();
  if not found then
    raise exception 'Contract was not found';
  end if;
end;
$$;

create or replace function public.delete_contract(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage contracts';
  end if;
  if not exists (select 1 from public.contracts where id = p_contract_id and coach_id = auth.uid()) then
    raise exception 'Contract was not found';
  end if;
  if exists (select 1 from public.contract_signatures where contract_id = p_contract_id) then
    raise exception 'Signed contracts cannot be deleted. Archive it instead';
  end if;
  delete from public.contracts where id = p_contract_id and coach_id = auth.uid();
end;
$$;

create or replace function public.sign_contract(
  p_contract_id uuid,
  p_signer_name text,
  p_signature_data_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contract public.contracts%rowtype;
  v_name text := btrim(coalesce(p_signer_name, ''));
  v_id uuid;
  v_signed timestamptz := statement_timestamp();
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required to sign contracts';
  end if;

  select * into v_contract from public.contracts where id = p_contract_id;
  if not found or v_contract.is_archived or not exists (
    select 1 from public.coach_clients
    where coach_id = v_contract.coach_id and client_id = auth.uid() and status = 'active'
  ) then
    raise exception 'This contract is not available for signing';
  end if;

  if char_length(v_name) not between 2 and 120 then
    raise exception 'Type your full name to sign';
  end if;
  if p_signature_data_url is null
    or char_length(p_signature_data_url) > 300000
    or p_signature_data_url !~ '^data:image/png;base64,[A-Za-z0-9+/=]{100,}$' then
    raise exception 'Draw your signature before signing';
  end if;
  if exists (select 1 from public.contract_signatures where contract_id = p_contract_id and client_id = auth.uid()) then
    raise exception 'You have already signed this contract';
  end if;

  insert into public.contract_signatures (
    contract_id, client_id, signer_full_name, signature_data_url, contract_title, content_snapshot, ip_or_user_agent, signed_at
  )
  values (
    p_contract_id, auth.uid(), v_name, p_signature_data_url, v_contract.title, v_contract.content_text,
    public.request_client_hint(), v_signed
  )
  returning id into v_id;

  return jsonb_build_object('signature_id', v_id, 'signed_at', v_signed);
exception
  when unique_violation then
    raise exception 'You have already signed this contract';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Group coaching
-- ---------------------------------------------------------------------------

create table if not exists public.coaching_groups (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  program_template_id uuid references public.training_programs (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists coaching_groups_coach_idx on public.coaching_groups (coach_id, created_at desc);

create table if not exists public.coaching_group_members (
  group_id uuid not null references public.coaching_groups (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, client_id)
);

create index if not exists coaching_group_members_client_idx on public.coaching_group_members (client_id);

create table if not exists public.group_announcements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.coaching_groups (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists group_announcements_group_idx on public.group_announcements (group_id, created_at desc);

alter table public.coaching_groups enable row level security;
alter table public.coaching_group_members enable row level security;
alter table public.group_announcements enable row level security;

create or replace function public.is_group_owner(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.coaching_groups where id = p_group_id and coach_id = auth.uid());
$$;

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.coaching_group_members m
    join public.coaching_groups g on g.id = m.group_id
    join public.coach_clients cc on cc.coach_id = g.coach_id and cc.client_id = m.client_id and cc.status = 'active'
    where m.group_id = p_group_id and m.client_id = auth.uid()
  );
$$;

drop policy if exists "Coaches can read their groups" on public.coaching_groups;
create policy "Coaches can read their groups"
  on public.coaching_groups for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Members can read their groups" on public.coaching_groups;
create policy "Members can read their groups"
  on public.coaching_groups for select
  to authenticated
  using (public.is_client_account() and public.is_group_member(id));

drop policy if exists "Coaches can read their group members" on public.coaching_group_members;
create policy "Coaches can read their group members"
  on public.coaching_group_members for select
  to authenticated
  using (public.is_active_coach() and public.is_group_owner(group_id));

drop policy if exists "Clients can read their own memberships" on public.coaching_group_members;
create policy "Clients can read their own memberships"
  on public.coaching_group_members for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read their group announcements" on public.group_announcements;
create policy "Coaches can read their group announcements"
  on public.group_announcements for select
  to authenticated
  using (public.is_active_coach() and public.is_group_owner(group_id));

drop policy if exists "Members can read their group announcements" on public.group_announcements;
create policy "Members can read their group announcements"
  on public.group_announcements for select
  to authenticated
  using (public.is_client_account() and public.is_group_member(group_id));

revoke all on public.coaching_groups, public.coaching_group_members, public.group_announcements from anon, authenticated;
grant select on public.coaching_groups, public.coaching_group_members, public.group_announcements to authenticated;
grant all on public.coaching_groups, public.coaching_group_members, public.group_announcements to service_role;

create or replace function public.save_group(p_group_id uuid, p_name text, p_description text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Give the group a name of up to 80 characters';
  end if;
  if char_length(v_description) > 500 then
    raise exception 'The description cannot exceed 500 characters';
  end if;

  if p_group_id is null then
    if (select count(*) from public.coaching_groups where coach_id = auth.uid()) >= 25 then
      raise exception 'You can have at most 25 groups';
    end if;
    insert into public.coaching_groups (coach_id, name, description)
    values (auth.uid(), v_name, v_description)
    returning id into v_id;
    return v_id;
  end if;

  update public.coaching_groups set name = v_name, description = v_description
  where id = p_group_id and coach_id = auth.uid()
  returning id into v_id;
  if v_id is null then
    raise exception 'Group was not found';
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  delete from public.coaching_groups where id = p_group_id and coach_id = auth.uid();
  if not found then
    raise exception 'Group was not found';
  end if;
end;
$$;

-- Adds active clients of this coach. When the group already has a program, new members receive it too.
create or replace function public.add_group_members(p_group_id uuid, p_client_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_program uuid;
  v_ids uuid[];
  v_client uuid;
  v_added integer := 0;
  v_assigned integer := 0;
  v_inserted integer;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  select program_template_id into v_program from public.coaching_groups where id = p_group_id and coach_id = auth.uid();
  if not found then
    raise exception 'Group was not found';
  end if;

  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_client_ids, '{}')) as x;
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'Choose at least one client';
  end if;
  if (
    select count(*) from public.coach_clients
    where coach_id = auth.uid() and status = 'active' and client_id = any (v_ids)
  ) <> array_length(v_ids, 1) then
    raise exception 'Only your active clients can be added to a group';
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
        perform public.assign_program_to_client(v_client, v_program);
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
  if not public.is_active_coach() or not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  delete from public.coaching_group_members where group_id = p_group_id and client_id = p_client_id;
  if not found then
    raise exception 'That client is not in this group';
  end if;
end;
$$;

-- One click: the program becomes the group's program and is assigned to every active member
-- (which also starts any "program assigned" workflow for each of them).
create or replace function public.assign_program_to_group(p_group_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member uuid;
  v_assigned integer := 0;
  v_skipped integer := 0;
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  if not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  if not exists (select 1 from public.training_programs where id = p_program_id and coach_id = auth.uid()) then
    raise exception 'Program was not found';
  end if;

  update public.coaching_groups set program_template_id = p_program_id where id = p_group_id;

  for v_member in
    select m.client_id
    from public.coaching_group_members m
    left join public.coach_clients cc on cc.coach_id = auth.uid() and cc.client_id = m.client_id and cc.status = 'active'
    where m.group_id = p_group_id and cc.client_id is not null
    order by m.joined_at
  loop
    perform public.assign_program_to_client(v_member, p_program_id);
    v_assigned := v_assigned + 1;
  end loop;

  select count(*) into v_skipped
  from public.coaching_group_members m
  where m.group_id = p_group_id
    and not exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = auth.uid() and cc.client_id = m.client_id and cc.status = 'active'
    );

  return jsonb_build_object('assigned', v_assigned, 'skipped_inactive', v_skipped);
end;
$$;

create or replace function public.clear_group_program(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() or not public.is_group_owner(p_group_id) then
    raise exception 'Group was not found';
  end if;
  update public.coaching_groups set program_template_id = null where id = p_group_id;
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
  if not public.is_active_coach() or not public.is_group_owner(p_group_id) then
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

create or replace function public.delete_group_announcement(p_announcement_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() then
    raise exception 'An active coach account is required to manage groups';
  end if;
  delete from public.group_announcements a
  where a.id = p_announcement_id and public.is_group_owner(a.group_id);
  if not found then
    raise exception 'Announcement was not found';
  end if;
end;
$$;

-- Days and exercises of a program in a compact form (used for what a member sees).
create or replace function public.program_summary(p_program_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'title', p.title,
    'days', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'name', d.name,
          'exercises', coalesce((
            select jsonb_agg(jsonb_build_object('name', e.name, 'sets', pe.sets, 'reps', pe.reps) order by pe.order_index)
            from (
              select * from public.training_program_exercises x where x.day_id = d.id order by x.order_index limit 12
            ) pe
            join public.exercises e on e.id = pe.exercise_id
          ), '[]'::jsonb)
        )
        order by d.order_index
      )
      from (
        select * from public.training_program_days y where y.program_id = p.id order by y.order_index limit 7
      ) d
    ), '[]'::jsonb)
  )
  from public.training_programs p
  where p.id = p_program_id;
$$;

-- What a client sees: their groups, the shared program, and the coach's updates. Other members are never listed.
create or replace function public.get_my_groups()
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
    select jsonb_agg(
      jsonb_build_object(
        'id', g.id,
        'name', g.name,
        'description', g.description,
        'joined_at', m.joined_at,
        'coach_name', coalesce(nullif(btrim(pr.brand_name), ''), nullif(btrim(pr.full_name), ''), nullif(btrim(cc.coach_name), '')),
        'member_count', (select count(*) from public.coaching_group_members x where x.group_id = g.id),
        'program', case when g.program_template_id is null then null else public.program_summary(g.program_template_id) end,
        'announcements', coalesce((
          select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'created_at', a.created_at) order by a.created_at desc)
          from (
            select * from public.group_announcements y where y.group_id = g.id order by y.created_at desc limit 10
          ) a
        ), '[]'::jsonb)
      )
      order by m.joined_at desc
    )
    from public.coaching_group_members m
    join public.coaching_groups g on g.id = m.group_id
    join public.coach_clients cc on cc.coach_id = g.coach_id and cc.client_id = m.client_id and cc.status = 'active'
    left join public.profiles pr on pr.id = g.coach_id
    where m.client_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Onboarding checklist for clients (assessment + contracts)
-- ---------------------------------------------------------------------------

create or replace function public.get_my_onboarding_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_coach boolean;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  select exists (select 1 from public.coach_clients where client_id = auth.uid() and status = 'active') into v_has_coach;

  return jsonb_build_object(
    'has_coach', v_has_coach,
    'assessment_submitted', exists (
      select 1 from public.client_assessments a
      join public.coach_clients cc on cc.coach_id = a.coach_id and cc.client_id = a.client_id and cc.status = 'active'
      where a.client_id = auth.uid()
    ),
    'medical_clearance_required', exists (
      select 1 from public.client_assessments a
      join public.coach_clients cc on cc.coach_id = a.coach_id and cc.client_id = a.client_id and cc.status = 'active'
      where a.client_id = auth.uid() and a.medical_clearance_required
    ),
    'pending_contracts', (
      select count(*)::integer
      from public.contracts c
      join public.coach_clients cc on cc.coach_id = c.coach_id and cc.client_id = auth.uid() and cc.status = 'active'
      where c.is_required_on_onboarding and not c.is_archived
        and not exists (select 1 from public.contract_signatures s where s.contract_id = c.id and s.client_id = auth.uid())
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.request_client_hint() from public, anon, authenticated;
revoke all on function public.program_summary(uuid) from public, anon, authenticated;
revoke all on function public.is_contract_owner(uuid) from public, anon;
revoke all on function public.i_signed_contract(uuid) from public, anon;
revoke all on function public.is_group_owner(uuid) from public, anon;
revoke all on function public.is_group_member(uuid) from public, anon;
grant execute on function public.is_contract_owner(uuid) to authenticated;
grant execute on function public.i_signed_contract(uuid) to authenticated;
grant execute on function public.is_group_owner(uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;

revoke all on function public.submit_my_assessment(uuid, jsonb, text, text) from public, anon;
revoke all on function public.save_contract(uuid, text, text, boolean) from public, anon;
revoke all on function public.set_contract_archived(uuid, boolean) from public, anon;
revoke all on function public.delete_contract(uuid) from public, anon;
revoke all on function public.sign_contract(uuid, text, text) from public, anon;
revoke all on function public.save_group(uuid, text, text) from public, anon;
revoke all on function public.delete_group(uuid) from public, anon;
revoke all on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon;
revoke all on function public.assign_program_to_group(uuid, uuid) from public, anon;
revoke all on function public.clear_group_program(uuid) from public, anon;
revoke all on function public.post_group_announcement(uuid, text) from public, anon;
revoke all on function public.delete_group_announcement(uuid) from public, anon;
revoke all on function public.get_my_groups() from public, anon;
revoke all on function public.get_my_onboarding_status() from public, anon;

grant execute on function public.submit_my_assessment(uuid, jsonb, text, text) to authenticated;
grant execute on function public.save_contract(uuid, text, text, boolean) to authenticated;
grant execute on function public.set_contract_archived(uuid, boolean) to authenticated;
grant execute on function public.delete_contract(uuid) to authenticated;
grant execute on function public.sign_contract(uuid, text, text) to authenticated;
grant execute on function public.save_group(uuid, text, text) to authenticated;
grant execute on function public.delete_group(uuid) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.assign_program_to_group(uuid, uuid) to authenticated;
grant execute on function public.clear_group_program(uuid) to authenticated;
grant execute on function public.post_group_announcement(uuid, text) to authenticated;
grant execute on function public.delete_group_announcement(uuid) to authenticated;
grant execute on function public.get_my_groups() to authenticated;
grant execute on function public.get_my_onboarding_status() to authenticated;
