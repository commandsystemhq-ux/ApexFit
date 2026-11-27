-- Ramadan meal categories: before iftar (pre_iftar), iftar and suhoor, next to breakfast, lunch, dinner and snack.
-- They are available in meal plans (meal_plan_items) and in the client's food log (client_food_logs). Whether the
-- extra categories are offered is a display choice made in the app; the database accepts all seven in both places.

alter table public.client_food_logs drop constraint if exists client_food_logs_meal_type_check;
alter table public.client_food_logs add constraint client_food_logs_meal_type_check
  check (meal_type in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor'));

alter table public.meal_plan_items drop constraint if exists meal_plan_items_meal_type_check;
alter table public.meal_plan_items add constraint meal_plan_items_meal_type_check
  check (meal_type in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor'));
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
    if v_meal is null or v_meal not in ('breakfast', 'lunch', 'pre_iftar', 'iftar', 'dinner', 'snack', 'suhoor') then
      raise exception 'Each food needs a meal: breakfast, lunch, dinner, snack or a Ramadan meal (before iftar, iftar, suhoor)' using errcode = '22023';
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
      order by case i.meal_type when 'breakfast' then 1 when 'lunch' then 2 when 'pre_iftar' then 3 when 'iftar' then 4 when 'dinner' then 5 when 'snack' then 6 else 7 end, i.position
    )
    from public.meal_plan_items i where i.plan_id = v_plan.id
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) from public, anon;
revoke all on function public.get_meal_plan(uuid) from public, anon;
grant execute on function public.save_meal_plan(uuid, text, text, boolean, uuid, jsonb) to authenticated;
grant execute on function public.get_meal_plan(uuid) to authenticated;