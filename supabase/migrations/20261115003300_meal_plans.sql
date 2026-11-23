-- Meal plans: a coach builds a plan of meals (breakfast, lunch, dinner, snack), each with foods in grams, calories and
-- macros, and alternatives for every food. A plan is either a reusable template or a plan given to one client. The
-- client sees their plan next to their food log and can copy any meal of it into their day with one tap.
--
-- Security: a coach reads and changes only their own plans, a client reads only the plans given to them. Nobody writes
-- the tables directly: plans are saved, given and deleted through functions that check who is asking and the numbers.
-- Giving a plan to a client makes a copy, so the template stays as it was.

create table if not exists public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  notes text not null default '' check (char_length(notes) <= 2000),
  is_template boolean not null default false,
  source_template_id uuid references public.meal_plans (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade,
  check (not (is_template and client_id is not null))
);

create index if not exists meal_plans_coach_idx on public.meal_plans (coach_id, is_template, updated_at desc);
create index if not exists meal_plans_client_idx on public.meal_plans (client_id, updated_at desc) where client_id is not null;

create table if not exists public.meal_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.meal_plans (id) on delete cascade,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  position integer not null check (position >= 0),
  food_name text not null check (char_length(btrim(food_name)) between 1 and 160),
  food_ref text check (food_ref is null or char_length(food_ref) <= 80),
  grams numeric(7, 1) not null check (grams between 1 and 5000),
  calories numeric(7, 1) not null check (calories between 0 and 10000),
  protein_g numeric(6, 1) not null default 0 check (protein_g between 0 and 1000),
  carbs_g numeric(6, 1) not null default 0 check (carbs_g between 0 and 1000),
  fat_g numeric(6, 1) not null default 0 check (fat_g between 0 and 1000),
  notes text not null default '' check (char_length(notes) <= 300),
  -- [{ food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g }], at most 5 per food
  alternatives jsonb not null default '[]'::jsonb check (jsonb_typeof(alternatives) = 'array' and jsonb_array_length(alternatives) <= 5),
  unique (plan_id, meal_type, position)
);

create index if not exists meal_plan_items_plan_idx on public.meal_plan_items (plan_id, meal_type, position);

alter table public.meal_plans enable row level security;
alter table public.meal_plan_items enable row level security;

drop policy if exists "Coaches can read their meal plans" on public.meal_plans;
create policy "Coaches can read their meal plans"
  on public.meal_plans for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read the meal plans given to them" on public.meal_plans;
create policy "Clients can read the meal plans given to them"
  on public.meal_plans for select
  to authenticated
  using (client_id = (select auth.uid()) and public.is_client_account());

drop policy if exists "Coaches can read the items of their meal plans" on public.meal_plan_items;
create policy "Coaches can read the items of their meal plans"
  on public.meal_plan_items for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (select 1 from public.meal_plans p where p.id = meal_plan_items.plan_id and p.coach_id = (select auth.uid()))
  );

drop policy if exists "Clients can read the items of their meal plans" on public.meal_plan_items;
create policy "Clients can read the items of their meal plans"
  on public.meal_plan_items for select
  to authenticated
  using (
    public.is_client_account()
    and exists (select 1 from public.meal_plans p where p.id = meal_plan_items.plan_id and p.client_id = (select auth.uid()))
  );

revoke all on public.meal_plans, public.meal_plan_items from anon, authenticated;
grant select on public.meal_plans, public.meal_plan_items to authenticated;

-- One food (or alternative) as the functions below accept it: name, grams and numbers inside the allowed ranges.
create or replace function public.meal_plan_food_valid(p_food jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if p_food is null or jsonb_typeof(p_food) <> 'object' then
    return false;
  end if;
  if jsonb_typeof(p_food -> 'food_name') is distinct from 'string' or char_length(btrim(p_food ->> 'food_name')) not between 1 and 160 then
    return false;
  end if;
  if p_food ? 'food_ref' and jsonb_typeof(p_food -> 'food_ref') not in ('string', 'null') then
    return false;
  end if;
  if char_length(coalesce(p_food ->> 'food_ref', '')) > 80 then
    return false;
  end if;
  for v_key in select unnest(array['grams', 'calories', 'protein_g', 'carbs_g', 'fat_g']) loop
    if p_food ? v_key and jsonb_typeof(p_food -> v_key) not in ('number', 'null') then
      return false;
    end if;
  end loop;
  if jsonb_typeof(p_food -> 'grams') is distinct from 'number' or (p_food ->> 'grams')::numeric not between 1 and 5000 then
    return false;
  end if;
  if jsonb_typeof(p_food -> 'calories') is distinct from 'number' or (p_food ->> 'calories')::numeric not between 0 and 10000 then
    return false;
  end if;
  if coalesce((p_food ->> 'protein_g')::numeric, 0) not between 0 and 1000
    or coalesce((p_food ->> 'carbs_g')::numeric, 0) not between 0 and 1000
    or coalesce((p_food ->> 'fat_g')::numeric, 0) not between 0 and 1000 then
    return false;
  end if;
  return true;
end;
$$;

-- The alternatives of a food, cleaned to the stored shape.
create or replace function public.meal_plan_clean_alternatives(p_alternatives jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_alt jsonb;
  v_result jsonb := '[]'::jsonb;
begin
  if p_alternatives is null or jsonb_typeof(p_alternatives) = 'null' then
    return v_result;
  end if;
  if jsonb_typeof(p_alternatives) <> 'array' or jsonb_array_length(p_alternatives) > 5 then
    raise exception 'A food can have up to 5 alternatives' using errcode = '22023';
  end if;
  for v_alt in select value from jsonb_array_elements(p_alternatives) loop
    if not public.meal_plan_food_valid(v_alt) then
      raise exception 'An alternative needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'food_name', btrim(v_alt ->> 'food_name'),
      'food_ref', nullif(btrim(coalesce(v_alt ->> 'food_ref', '')), ''),
      'grams', round((v_alt ->> 'grams')::numeric, 1),
      'calories', round((v_alt ->> 'calories')::numeric, 1),
      'protein_g', round(coalesce((v_alt ->> 'protein_g')::numeric, 0), 1),
      'carbs_g', round(coalesce((v_alt ->> 'carbs_g')::numeric, 0), 1),
      'fat_g', round(coalesce((v_alt ->> 'fat_g')::numeric, 0), 1)
    ));
  end loop;
  return v_result;
end;
$$;

create or replace function public.require_meal_coach()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage meal plans' using errcode = '42501';
  end if;
end;
$$;

-- Creates a plan (p_plan_id null) or replaces the content of one of the caller's own plans. A plan is a template or
-- belongs to one of the coach's active clients.
create or replace function public.save_meal_plan(
  p_plan_id uuid,
  p_title text,
  p_notes text,
  p_is_template boolean,
  p_client_id uuid,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_notes text := btrim(coalesce(p_notes, ''));
  v_template boolean := coalesce(p_is_template, false);
  v_plan_id uuid;
  v_item jsonb;
  v_index bigint;
  v_counts jsonb := '{}'::jsonb;
  v_position integer;
  v_meal text;
begin
  perform public.require_meal_coach();
  if char_length(v_title) not between 1 and 120 then
    raise exception 'The plan name must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if char_length(v_notes) > 2000 then
    raise exception 'Notes can be up to 2000 characters' using errcode = '22023';
  end if;
  if v_template and p_client_id is not null then
    raise exception 'A template does not belong to a client' using errcode = '22023';
  end if;
  if not v_template and p_client_id is null then
    raise exception 'Choose an active client, or save the plan as a template' using errcode = '22023';
  end if;
  if p_client_id is not null and not exists (
    select 1 from public.coach_clients where coach_id = v_coach and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Choose an active client' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 60 then
    raise exception 'A plan can have up to 60 foods' using errcode = '22023';
  end if;

  if p_plan_id is null then
    insert into public.meal_plans (coach_id, client_id, title, notes, is_template)
    values (v_coach, p_client_id, v_title, v_notes, v_template)
    returning id into v_plan_id;
  else
    update public.meal_plans
    set title = v_title, notes = v_notes, is_template = v_template, client_id = p_client_id, updated_at = now()
    where id = p_plan_id and coach_id = v_coach
    returning id into v_plan_id;
    if v_plan_id is null then
      raise exception 'Meal plan was not found' using errcode = 'P0002';
    end if;
    delete from public.meal_plan_items where plan_id = v_plan_id;
  end if;

  for v_item, v_index in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
    v_meal := v_item ->> 'meal_type';
    if v_meal is null or v_meal not in ('breakfast', 'lunch', 'dinner', 'snack') then
      raise exception 'Each food needs a meal: breakfast, lunch, dinner or snack' using errcode = '22023';
    end if;
    if not public.meal_plan_food_valid(v_item) then
      raise exception 'Each food needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    if char_length(coalesce(v_item ->> 'notes', '')) > 300 then
      raise exception 'A food note can be up to 300 characters' using errcode = '22023';
    end if;
    v_position := coalesce((v_counts ->> v_meal)::integer, 0);
    v_counts := v_counts || jsonb_build_object(v_meal, v_position + 1);
    insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives)
    values (
      v_plan_id, v_meal, v_position, btrim(v_item ->> 'food_name'), nullif(btrim(coalesce(v_item ->> 'food_ref', '')), ''),
      round((v_item ->> 'grams')::numeric, 1), round((v_item ->> 'calories')::numeric, 1),
      round(coalesce((v_item ->> 'protein_g')::numeric, 0), 1), round(coalesce((v_item ->> 'carbs_g')::numeric, 0), 1),
      round(coalesce((v_item ->> 'fat_g')::numeric, 0), 1), btrim(coalesce(v_item ->> 'notes', '')),
      public.meal_plan_clean_alternatives(v_item -> 'alternatives')
    );
  end loop;
  return v_plan_id;
end;
$$;

-- Gives one of the coach's plans to one of their active clients: a copy that belongs to the client.
create or replace function public.assign_meal_plan(p_plan_id uuid, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach uuid := auth.uid();
  v_source public.meal_plans%rowtype;
  v_new uuid;
begin
  perform public.require_meal_coach();
  select * into v_source from public.meal_plans where id = p_plan_id and coach_id = v_coach;
  if not found then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.coach_clients where coach_id = v_coach and client_id = p_client_id and status = 'active') then
    raise exception 'Choose an active client' using errcode = '22023';
  end if;
  insert into public.meal_plans (coach_id, client_id, title, notes, is_template, source_template_id)
  values (v_coach, p_client_id, v_source.title, v_source.notes, false, case when v_source.is_template then v_source.id else v_source.source_template_id end)
  returning id into v_new;
  insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives)
  select v_new, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives
  from public.meal_plan_items where plan_id = p_plan_id;
  return v_new;
end;
$$;

create or replace function public.delete_meal_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_meal_coach();
  delete from public.meal_plans where id = p_plan_id and coach_id = auth.uid();
  if not found then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
end;
$$;

-- A plan with its foods in meal order, for the coach who owns it or the client it was given to.
create or replace function public.get_meal_plan(p_plan_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.meal_plans%rowtype;
begin
  select * into v_plan from public.meal_plans where id = p_plan_id;
  if not found
    or not (coalesce(v_plan.coach_id = auth.uid() and public.is_active_coach(), false) or coalesce(v_plan.client_id = auth.uid() and public.is_client_account(), false)) then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  return to_jsonb(v_plan) || jsonb_build_object('items', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', i.id, 'meal_type', i.meal_type, 'position', i.position, 'food_name', i.food_name, 'food_ref', i.food_ref,
        'grams', i.grams, 'calories', i.calories, 'protein_g', i.protein_g, 'carbs_g', i.carbs_g, 'fat_g', i.fat_g,
        'notes', i.notes, 'alternatives', i.alternatives
      )
      order by case i.meal_type when 'breakfast' then 1 when 'lunch' then 2 when 'dinner' then 3 else 4 end, i.position
    )
    from public.meal_plan_items i where i.plan_id = v_plan.id
  ), '[]'::jsonb));
end;
$$;

-- The newest plan given to the signed-in client, or null.
create or replace function public.get_my_meal_plan()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  select id into v_id from public.meal_plans where client_id = auth.uid() order by updated_at desc, created_at desc limit 1;
  if v_id is null then
    return null;
  end if;
  return public.get_meal_plan(v_id) || jsonb_build_object(
    'coach_name', (select coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), '')) from public.profiles p where p.id = (select coach_id from public.meal_plans where id = v_id))
  );
end;
$$;

-- Copies foods of the client's plan into their food log for one day. p_choices: [{ item_id, alternative }] where
-- alternative is null (the food itself) or the position (from 0) of one of its alternatives.
create or replace function public.log_meal_plan_items(p_plan_id uuid, p_date date, p_choices jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_choice jsonb;
  v_item public.meal_plan_items%rowtype;
  v_alt jsonb;
  v_position integer;
  v_count integer := 0;
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.meal_plans where id = p_plan_id and client_id = auth.uid()) then
    raise exception 'Meal plan was not found' using errcode = 'P0002';
  end if;
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 30 then
    raise exception 'Choose a day from the last 30 days up to today' using errcode = '22023';
  end if;
  if p_choices is null or jsonb_typeof(p_choices) <> 'array' or jsonb_array_length(p_choices) not between 1 and 20 then
    raise exception 'Choose between 1 and 20 foods to log' using errcode = '22023';
  end if;

  for v_choice in select value from jsonb_array_elements(p_choices) loop
    select * into v_item from public.meal_plan_items
    where id = (case when v_choice ->> 'item_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_choice ->> 'item_id')::uuid end)
      and plan_id = p_plan_id;
    if not found then
      raise exception 'A food is not part of this plan' using errcode = '22023';
    end if;
    if jsonb_typeof(v_choice -> 'alternative') = 'number' then
      v_position := (v_choice ->> 'alternative')::integer;
      v_alt := v_item.alternatives -> v_position;
      if v_alt is null then
        raise exception 'That alternative does not exist' using errcode = '22023';
      end if;
      insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, ingredients, calories, protein_g, carbs_g, fat_g)
      values (
        auth.uid(), p_date, v_item.meal_type, left(v_alt ->> 'food_name', 160), trim_scale((v_alt ->> 'grams')::numeric)::text || ' g',
        (v_alt ->> 'calories')::numeric, (v_alt ->> 'protein_g')::numeric, (v_alt ->> 'carbs_g')::numeric, (v_alt ->> 'fat_g')::numeric
      );
    else
      insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, ingredients, calories, protein_g, carbs_g, fat_g)
      values (auth.uid(), p_date, v_item.meal_type, v_item.food_name, trim_scale(v_item.grams)::text || ' g', v_item.calories, v_item.protein_g, v_item.carbs_g, v_item.fat_g);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.meal_plan_food_valid(jsonb) from public, anon, authenticated;
revoke all on function public.meal_plan_clean_alternatives(jsonb) from public, anon, authenticated;
revoke all on function public.require_meal_coach() from public, anon, authenticated;
revoke all on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) from public, anon;
revoke all on function public.assign_meal_plan(uuid, uuid) from public, anon;
revoke all on function public.delete_meal_plan(uuid) from public, anon;
revoke all on function public.get_meal_plan(uuid) from public, anon;
revoke all on function public.get_my_meal_plan() from public, anon;
revoke all on function public.log_meal_plan_items(uuid, date, jsonb) from public, anon;
grant execute on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) to authenticated;
grant execute on function public.assign_meal_plan(uuid, uuid) to authenticated;
grant execute on function public.delete_meal_plan(uuid) to authenticated;
grant execute on function public.get_meal_plan(uuid) to authenticated;
grant execute on function public.get_my_meal_plan() to authenticated;
grant execute on function public.log_meal_plan_items(uuid, date, jsonb) to authenticated;
