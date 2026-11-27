-- Recipes: a coach builds complete recipes from foods (ingredients with amounts in grams), writes the method, and the
-- calories and macros of the whole recipe and of one serving are calculated from the ingredients. A recipe can be put
-- into a meal plan as one meal item (a portion of it); the client who receives that plan can open the recipe to see
-- the ingredients and how to prepare it.
--
-- Security: a coach reads and changes only their own recipes. A client never reads the recipes table: get_recipe lets
-- them open a recipe only when one of the meal plans given to them contains it. Nobody writes the tables directly.

create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  instructions text not null default '' check (char_length(instructions) <= 6000),
  servings integer not null default 1 check (servings between 1 and 50),
  prep_minutes integer check (prep_minutes is null or prep_minutes between 0 and 1440),
  cook_minutes integer check (cook_minutes is null or cook_minutes between 0 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists recipes_coach_idx on public.recipes (coach_id, updated_at desc);

create table if not exists public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes (id) on delete cascade,
  position integer not null check (position >= 0),
  food_name text not null check (char_length(btrim(food_name)) between 1 and 160),
  food_ref text check (food_ref is null or char_length(food_ref) <= 80),
  grams numeric(7, 1) not null check (grams between 1 and 5000),
  calories numeric(7, 1) not null check (calories between 0 and 10000),
  protein_g numeric(6, 1) not null default 0 check (protein_g between 0 and 1000),
  carbs_g numeric(6, 1) not null default 0 check (carbs_g between 0 and 1000),
  fat_g numeric(6, 1) not null default 0 check (fat_g between 0 and 1000),
  notes text not null default '' check (char_length(notes) <= 200),
  unique (recipe_id, position)
);

create index if not exists recipe_ingredients_recipe_idx on public.recipe_ingredients (recipe_id, position);

alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;

drop policy if exists "Coaches can read their recipes" on public.recipes;
create policy "Coaches can read their recipes"
  on public.recipes for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Coaches can read the ingredients of their recipes" on public.recipe_ingredients;
create policy "Coaches can read the ingredients of their recipes"
  on public.recipe_ingredients for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (select 1 from public.recipes r where r.id = recipe_ingredients.recipe_id and r.coach_id = (select auth.uid()))
  );

revoke all on public.recipes, public.recipe_ingredients from anon, authenticated;
grant select on public.recipes, public.recipe_ingredients to authenticated;

-- A recipe with its ingredients, totals for the whole recipe and for one serving.
create or replace function public.recipe_json(p_recipe_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(r) || jsonb_build_object(
    'ingredients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'position', i.position, 'food_name', i.food_name, 'food_ref', i.food_ref, 'grams', i.grams,
        'calories', i.calories, 'protein_g', i.protein_g, 'carbs_g', i.carbs_g, 'fat_g', i.fat_g, 'notes', i.notes
      ) order by i.position)
      from public.recipe_ingredients i where i.recipe_id = r.id
    ), '[]'::jsonb),
    'totals', t.totals,
    'per_serving', jsonb_build_object(
      'grams', round((t.totals ->> 'grams')::numeric / r.servings, 1),
      'calories', round((t.totals ->> 'calories')::numeric / r.servings, 1),
      'protein_g', round((t.totals ->> 'protein_g')::numeric / r.servings, 1),
      'carbs_g', round((t.totals ->> 'carbs_g')::numeric / r.servings, 1),
      'fat_g', round((t.totals ->> 'fat_g')::numeric / r.servings, 1)
    )
  )
  from public.recipes r
  cross join lateral (
    select jsonb_build_object(
      'grams', coalesce(sum(i.grams), 0), 'calories', coalesce(sum(i.calories), 0), 'protein_g', coalesce(sum(i.protein_g), 0),
      'carbs_g', coalesce(sum(i.carbs_g), 0), 'fat_g', coalesce(sum(i.fat_g), 0)
    ) as totals
    from public.recipe_ingredients i where i.recipe_id = r.id
  ) t
  where r.id = p_recipe_id;
$$;

create or replace function public.require_recipe_coach()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage recipes' using errcode = '42501';
  end if;
end;
$$;

-- Creates (p_recipe_id null) or replaces one of the caller's own recipes. Each ingredient needs a name, grams and numbers
-- inside the allowed ranges (the same rules as the foods of a meal plan).
create or replace function public.save_recipe(
  p_recipe_id uuid,
  p_title text,
  p_description text,
  p_instructions text,
  p_servings integer,
  p_prep_minutes integer,
  p_cook_minutes integer,
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
  v_description text := btrim(coalesce(p_description, ''));
  v_instructions text := btrim(coalesce(p_instructions, ''));
  v_id uuid;
  v_item jsonb;
  v_position integer := 0;
begin
  perform public.require_recipe_coach();
  if char_length(v_title) not between 1 and 120 then
    raise exception 'The recipe name must be between 1 and 120 characters' using errcode = '22023';
  end if;
  if char_length(v_description) > 1000 then
    raise exception 'The description can be up to 1000 characters' using errcode = '22023';
  end if;
  if char_length(v_instructions) > 6000 then
    raise exception 'The method can be up to 6000 characters' using errcode = '22023';
  end if;
  if p_servings is null or p_servings not between 1 and 50 then
    raise exception 'Servings must be between 1 and 50' using errcode = '22023';
  end if;
  if (p_prep_minutes is not null and p_prep_minutes not between 0 and 1440) or (p_cook_minutes is not null and p_cook_minutes not between 0 and 1440) then
    raise exception 'Preparation and cooking time must be between 0 and 1440 minutes' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 40 then
    raise exception 'A recipe needs between 1 and 40 ingredients' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if not public.meal_plan_food_valid(v_item) then
      raise exception 'Each ingredient needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    if char_length(coalesce(v_item ->> 'notes', '')) > 200 then
      raise exception 'An ingredient note can be up to 200 characters' using errcode = '22023';
    end if;
  end loop;

  if p_recipe_id is null then
    if (select count(*) from public.recipes where coach_id = v_coach) >= 300 then
      raise exception 'You can keep up to 300 recipes' using errcode = '54000';
    end if;
    insert into public.recipes (coach_id, title, description, instructions, servings, prep_minutes, cook_minutes)
    values (v_coach, v_title, v_description, v_instructions, p_servings, p_prep_minutes, p_cook_minutes)
    returning id into v_id;
  else
    update public.recipes
    set title = v_title, description = v_description, instructions = v_instructions, servings = p_servings,
        prep_minutes = p_prep_minutes, cook_minutes = p_cook_minutes, updated_at = now()
    where id = p_recipe_id and coach_id = v_coach
    returning id into v_id;
    if v_id is null then
      raise exception 'Recipe was not found' using errcode = 'P0002';
    end if;
    delete from public.recipe_ingredients where recipe_id = v_id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into public.recipe_ingredients (recipe_id, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes)
    values (
      v_id, v_position, btrim(v_item ->> 'food_name'), nullif(btrim(coalesce(v_item ->> 'food_ref', '')), ''),
      round((v_item ->> 'grams')::numeric, 1), round((v_item ->> 'calories')::numeric, 1),
      round(coalesce((v_item ->> 'protein_g')::numeric, 0), 1), round(coalesce((v_item ->> 'carbs_g')::numeric, 0), 1),
      round(coalesce((v_item ->> 'fat_g')::numeric, 0), 1), btrim(coalesce(v_item ->> 'notes', ''))
    );
    v_position := v_position + 1;
  end loop;
  return v_id;
end;
$$;

create or replace function public.delete_recipe(p_recipe_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_recipe_coach();
  delete from public.recipes where id = p_recipe_id and coach_id = auth.uid();
  if not found then
    raise exception 'Recipe was not found' using errcode = 'P0002';
  end if;
end;
$$;

-- The coach's recipes (without ingredients) with per-serving numbers, newest first.
create or replace function public.list_my_recipes()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_recipe_coach();
  return coalesce((
    select jsonb_agg((public.recipe_json(r.id) - 'ingredients') order by r.updated_at desc, r.id)
    from public.recipes r where r.coach_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

-- One recipe in full: for the coach who owns it, or for a client whose meal plan contains it.
create or replace function public.get_recipe(p_recipe_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
begin
  select coach_id into v_owner from public.recipes where id = p_recipe_id;
  if v_owner is null
    or not (
      coalesce(v_owner = auth.uid() and public.is_active_coach(), false)
      or (
        coalesce(public.is_client_account(), false)
        and exists (
          select 1 from public.meal_plan_items i
          join public.meal_plans p on p.id = i.plan_id
          where i.recipe_id = p_recipe_id and p.client_id = auth.uid()
        )
      )
    ) then
    raise exception 'Recipe was not found' using errcode = 'P0002';
  end if;
  return public.recipe_json(p_recipe_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recipes inside meal plans
-- ---------------------------------------------------------------------------
-- A meal plan item can point at the recipe it came from. Its numbers are the portion the coach chose.
alter table public.meal_plan_items add column if not exists recipe_id uuid references public.recipes (id) on delete set null;
create index if not exists meal_plan_items_recipe_idx on public.meal_plan_items (recipe_id) where recipe_id is not null;

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
  v_recipe uuid;
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
    if v_meal is null or v_meal not in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor') then
      raise exception 'Each food needs a meal: breakfast, lunch, dinner, snack or a Ramadan meal (before iftar, iftar, suhoor)' using errcode = '22023';
    end if;
    if not public.meal_plan_food_valid(v_item) then
      raise exception 'Each food needs a name, grams and calories within the allowed range' using errcode = '22023';
    end if;
    if char_length(coalesce(v_item ->> 'notes', '')) > 300 then
      raise exception 'A food note can be up to 300 characters' using errcode = '22023';
    end if;
    v_recipe := null;
    if nullif(btrim(coalesce(v_item ->> 'recipe_id', '')), '') is not null then
      if (v_item ->> 'recipe_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'A recipe is not valid' using errcode = '22023';
      end if;
      v_recipe := (v_item ->> 'recipe_id')::uuid;
      if not exists (select 1 from public.recipes where id = v_recipe and coach_id = v_coach) then
        raise exception 'Choose one of your own recipes' using errcode = '22023';
      end if;
    end if;
    v_position := coalesce((v_counts ->> v_meal)::integer, 0);
    v_counts := v_counts || jsonb_build_object(v_meal, v_position + 1);
    insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives, recipe_id)
    values (
      v_plan_id, v_meal, v_position, btrim(v_item ->> 'food_name'), nullif(btrim(coalesce(v_item ->> 'food_ref', '')), ''),
      round((v_item ->> 'grams')::numeric, 1), round((v_item ->> 'calories')::numeric, 1),
      round(coalesce((v_item ->> 'protein_g')::numeric, 0), 1), round(coalesce((v_item ->> 'carbs_g')::numeric, 0), 1),
      round(coalesce((v_item ->> 'fat_g')::numeric, 0), 1), btrim(coalesce(v_item ->> 'notes', '')),
      public.meal_plan_clean_alternatives(v_item -> 'alternatives'), v_recipe
    );
  end loop;
  return v_plan_id;
end;
$$;

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
  insert into public.meal_plan_items (plan_id, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives, recipe_id)
  select v_new, meal_type, position, food_name, food_ref, grams, calories, protein_g, carbs_g, fat_g, notes, alternatives, recipe_id
  from public.meal_plan_items where plan_id = p_plan_id;
  return v_new;
end;
$$;

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
        'notes', i.notes, 'alternatives', i.alternatives, 'recipe_id', i.recipe_id
      )
      order by case i.meal_type when 'breakfast' then 1 when 'lunch' then 2 when 'pre_iftar' then 3 when 'iftar' then 4 when 'dinner' then 5 when 'snack' then 6 else 7 end, i.position
    )
    from public.meal_plan_items i where i.plan_id = v_plan.id
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.recipe_json(uuid) from public, anon, authenticated;
revoke all on function public.require_recipe_coach() from public, anon, authenticated;
revoke all on function public.save_recipe(uuid, text, text, text, integer, integer, integer, jsonb) from public, anon;
revoke all on function public.delete_recipe(uuid) from public, anon;
revoke all on function public.list_my_recipes() from public, anon;
revoke all on function public.get_recipe(uuid) from public, anon;
revoke all on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) from public, anon;
revoke all on function public.assign_meal_plan(uuid, uuid) from public, anon;
revoke all on function public.get_meal_plan(uuid) from public, anon;
grant execute on function public.save_recipe(uuid, text, text, text, integer, integer, integer, jsonb) to authenticated;
grant execute on function public.delete_recipe(uuid) to authenticated;
grant execute on function public.list_my_recipes() to authenticated;
grant execute on function public.get_recipe(uuid) to authenticated;
grant execute on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) to authenticated;
grant execute on function public.assign_meal_plan(uuid, uuid) to authenticated;
grant execute on function public.get_meal_plan(uuid) to authenticated;
