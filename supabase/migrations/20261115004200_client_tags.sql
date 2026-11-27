-- Client tags and types. A coach labels clients with coloured tags (VIP, Cutting, Special follow-up ...) and with one
-- type (Online, In-person ...) to find them quickly. Tags belong to the coach, are private to them (clients never see
-- them) and are written only through the functions below.
--   kind = 'tag'   a client can have many
--   kind = 'type'  a client can have at most one

create table if not exists public.client_tags (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  color text not null default 'blue' check (color in ('red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink')),
  kind text not null default 'tag' check (kind in ('tag', 'type')),
  created_at timestamptz not null default now(),
  unique (id, coach_id)
);

create unique index if not exists client_tags_coach_name_idx on public.client_tags (coach_id, lower(btrim(name)));

create table if not exists public.client_tag_assignments (
  coach_id uuid not null,
  client_id uuid not null,
  tag_id uuid not null,
  assigned_at timestamptz not null default now(),
  primary key (client_id, tag_id),
  foreign key (tag_id, coach_id) references public.client_tags (id, coach_id) on delete cascade,
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

create index if not exists client_tag_assignments_coach_tag_idx on public.client_tag_assignments (coach_id, tag_id);

alter table public.client_tags enable row level security;
alter table public.client_tag_assignments enable row level security;

drop policy if exists "Coaches can read their client tags" on public.client_tags;
create policy "Coaches can read their client tags"
  on public.client_tags for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Coaches can read their tag assignments" on public.client_tag_assignments;
create policy "Coaches can read their tag assignments"
  on public.client_tag_assignments for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.client_tags, public.client_tag_assignments from anon, authenticated;
grant select on public.client_tags, public.client_tag_assignments to authenticated;

-- Creates (p_tag_id null) or updates one of the coach's tags. The kind of a tag in use cannot change.
create or replace function public.save_client_tag(p_tag_id uuid, p_name text, p_color text, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
  v_kind text;
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage client tags' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 30 then
    raise exception 'A tag name must be between 1 and 30 characters' using errcode = '22023';
  end if;
  if p_color is null or p_color not in ('red', 'orange', 'amber', 'green', 'teal', 'blue', 'purple', 'pink') then
    raise exception 'Choose a valid tag colour' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('tag', 'type') then
    raise exception 'Choose tag or type' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.client_tags
    where coach_id = auth.uid() and lower(btrim(name)) = lower(v_name) and id is distinct from p_tag_id
  ) then
    raise exception 'A tag with this name already exists' using errcode = '23505';
  end if;

  if p_tag_id is null then
    if (select count(*) from public.client_tags where coach_id = auth.uid()) >= 40 then
      raise exception 'You can keep up to 40 tags and types' using errcode = '54000';
    end if;
    insert into public.client_tags (coach_id, name, color, kind) values (auth.uid(), v_name, p_color, p_kind) returning id into v_id;
  else
    select kind into v_kind from public.client_tags where id = p_tag_id and coach_id = auth.uid();
    if not found then
      raise exception 'Tag was not found' using errcode = 'P0002';
    end if;
    if v_kind <> p_kind and exists (select 1 from public.client_tag_assignments where tag_id = p_tag_id) then
      raise exception 'Remove this tag from your clients before changing its kind' using errcode = '23503';
    end if;
    update public.client_tags set name = v_name, color = p_color, kind = p_kind where id = p_tag_id and coach_id = auth.uid();
    v_id := p_tag_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_client_tag(p_tag_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage client tags' using errcode = '42501';
  end if;
  delete from public.client_tags where id = p_tag_id and coach_id = auth.uid();
  if not found then
    raise exception 'Tag was not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Replaces the tags of one client: up to 10 of the coach's own tags, and at most one type.
create or replace function public.set_client_tags(p_client_id uuid, p_tag_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage client tags' using errcode = '42501';
  end if;
  if not exists (select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id) then
    raise exception 'Client was not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from unnest(coalesce(p_tag_ids, '{}')) as x where x is not null;
  if cardinality(v_ids) > 10 then
    raise exception 'A client can have up to 10 tags' using errcode = '22023';
  end if;
  if (select count(*) from public.client_tags where coach_id = auth.uid() and id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'Tag was not found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.client_tags where coach_id = auth.uid() and id = any (v_ids) and kind = 'type') > 1 then
    raise exception 'A client can have only one type' using errcode = '22023';
  end if;

  delete from public.client_tag_assignments where coach_id = auth.uid() and client_id = p_client_id;
  insert into public.client_tag_assignments (coach_id, client_id, tag_id)
  select auth.uid(), p_client_id, unnest(v_ids);
end;
$$;

revoke all on function public.save_client_tag(uuid, text, text, text) from public, anon;
revoke all on function public.delete_client_tag(uuid) from public, anon;
revoke all on function public.set_client_tags(uuid, uuid[]) from public, anon;
grant execute on function public.save_client_tag(uuid, text, text, text) to authenticated;
grant execute on function public.delete_client_tag(uuid) to authenticated;
grant execute on function public.set_client_tags(uuid, uuid[]) to authenticated;