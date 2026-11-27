-- Calorie calculator support for coaches. The calculator itself (BMR / TDEE / macros) runs in the browser; the database
-- keeps the few facts it needs about a client that are not recorded anywhere else (sex, date of birth, height override,
-- activity level, goal and formula) and hands the coach everything already known (latest weight, body fat, intake height,
-- current daily goal). The result is written with the existing set_client_nutrition_targets function.
--
-- Security: a coach reads and writes only the rows of their own active clients, through security definer functions.

create table if not exists public.client_body_profiles (
  coach_id uuid not null,
  client_id uuid not null,
  sex text check (sex in ('male', 'female')),
  birth_date date check (birth_date between date '1900-01-01' and date '2100-01-01'),
  height_cm numeric(5, 1) check (height_cm between 50 and 275),
  activity_level text check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  goal text check (goal in ('cut', 'maintain', 'bulk')),
  formula text check (formula in ('mifflin', 'harris', 'katch')),
  updated_at timestamptz not null default now(),
  primary key (coach_id, client_id),
  foreign key (coach_id, client_id) references public.coach_clients (coach_id, client_id) on delete cascade
);

alter table public.client_body_profiles enable row level security;

drop policy if exists "Coaches can read the body profiles of their clients" on public.client_body_profiles;
create policy "Coaches can read the body profiles of their clients"
  on public.client_body_profiles for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

revoke all on public.client_body_profiles from anon, authenticated;
grant select on public.client_body_profiles to authenticated;

-- What the calculator can fill in on its own for one client.
create or replace function public.get_client_calculator_data(p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.client_body_profiles%rowtype;
  v_weight record;
  v_fat record;
  v_intake record;
  v_target record;
begin
  if not public.is_active_coach() or not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client was not found' using errcode = 'P0002';
  end if;

  select * into v_profile from public.client_body_profiles where coach_id = auth.uid() and client_id = p_client_id;
  select weight_kg, measured_on into v_weight
  from public.client_body_metrics where client_id = p_client_id and weight_kg is not null
  order by measured_on desc limit 1;
  select body_fat_percentage, measured_on into v_fat
  from public.client_body_metrics where client_id = p_client_id and body_fat_percentage is not null
  order by measured_on desc limit 1;
  select height_cm, primary_goal into v_intake from public.client_intake_forms where client_id = p_client_id;
  select calories, protein_g, carbs_g, fats_g, updated_at into v_target from public.nutrition_targets where client_id = p_client_id;

  return jsonb_build_object(
    'client_id', p_client_id,
    'sex', v_profile.sex,
    'birth_date', v_profile.birth_date,
    'activity_level', v_profile.activity_level,
    'goal', v_profile.goal,
    'formula', v_profile.formula,
    'height_cm', coalesce(v_profile.height_cm, v_intake.height_cm),
    'height_source', case when v_profile.height_cm is not null then 'profile' when v_intake.height_cm is not null then 'intake' else null end,
    'weight_kg', v_weight.weight_kg,
    'weight_date', v_weight.measured_on,
    'body_fat_pct', v_fat.body_fat_percentage,
    'body_fat_date', v_fat.measured_on,
    'intake_goal', v_intake.primary_goal,
    'target', case when v_target.calories is null and v_target.protein_g is null and v_target.carbs_g is null and v_target.fats_g is null
      then null
      else jsonb_build_object('calories', v_target.calories, 'protein_g', v_target.protein_g, 'carbs_g', v_target.carbs_g, 'fats_g', v_target.fats_g, 'updated_at', v_target.updated_at) end
  );
end;
$$;

-- Remembers the coach's inputs for a client so the next calculation starts from them. Every value is optional.
create or replace function public.save_client_calculator_profile(
  p_client_id uuid,
  p_sex text,
  p_birth_date date,
  p_height_cm numeric,
  p_activity_level text,
  p_goal text,
  p_formula text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_active_coach() or not exists (
    select 1 from public.coach_clients where coach_id = auth.uid() and client_id = p_client_id and status = 'active'
  ) then
    raise exception 'Client was not found' using errcode = 'P0002';
  end if;
  if p_sex is not null and p_sex not in ('male', 'female') then
    raise exception 'Choose male or female' using errcode = '22023';
  end if;
  if p_birth_date is not null and (p_birth_date > current_date - interval '10 years' or p_birth_date < current_date - interval '100 years') then
    raise exception 'Date of birth must give an age between 10 and 100' using errcode = '22023';
  end if;
  if p_height_cm is not null and p_height_cm not between 100 and 250 then
    raise exception 'Height must be between 100 and 250 cm' using errcode = '22023';
  end if;
  if p_activity_level is not null and p_activity_level not in ('sedentary', 'light', 'moderate', 'active', 'very_active') then
    raise exception 'Choose a valid activity level' using errcode = '22023';
  end if;
  if p_goal is not null and p_goal not in ('cut', 'maintain', 'bulk') then
    raise exception 'Choose a valid goal' using errcode = '22023';
  end if;
  if p_formula is not null and p_formula not in ('mifflin', 'harris', 'katch') then
    raise exception 'Choose a valid formula' using errcode = '22023';
  end if;

  insert into public.client_body_profiles (coach_id, client_id, sex, birth_date, height_cm, activity_level, goal, formula)
  values (auth.uid(), p_client_id, p_sex, p_birth_date, p_height_cm, p_activity_level, p_goal, p_formula)
  on conflict (coach_id, client_id) do update
  set sex = excluded.sex,
      birth_date = excluded.birth_date,
      height_cm = excluded.height_cm,
      activity_level = excluded.activity_level,
      goal = excluded.goal,
      formula = excluded.formula,
      updated_at = now();
end;
$$;

revoke all on function public.get_client_calculator_data(uuid) from public, anon;
revoke all on function public.save_client_calculator_profile(uuid, text, date, numeric, text, text, text) from public, anon;
grant execute on function public.get_client_calculator_data(uuid) to authenticated;
grant execute on function public.save_client_calculator_profile(uuid, text, date, numeric, text, text, text) to authenticated;