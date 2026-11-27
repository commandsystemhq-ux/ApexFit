-- Coach custom exercises. A coach can add their own exercises (name, description, muscles, equipment, difficulty, a
-- photo and a YouTube / Vimeo / MP4 link). They live in the same table as the shared library so programs, workout logs
-- and progression keep working, but they are visible only to the owning coach, that coach's active clients and the
-- trainers of that coach's team. The shared library is unchanged.
--
-- Security: the table is read-only for the browser; every write goes through save_custom_exercise /
-- delete_custom_exercise, which check the account, the plan, the link and the photo path. Photos are stored in a private
-- bucket under a folder named after the coach and are read through short-lived signed links.

alter table public.exercises add column if not exists owner_coach_id uuid references public.profiles (id) on delete cascade;
alter table public.exercises add column if not exists description text not null default '';
alter table public.exercises add column if not exists secondary_muscles text[] not null default '{}';
alter table public.exercises add column if not exists image_path text;

alter table public.exercises drop constraint if exists exercises_description_check;
alter table public.exercises add constraint exercises_description_check check (char_length(description) <= 2000);
alter table public.exercises drop constraint if exists exercises_image_path_check;
alter table public.exercises add constraint exercises_image_path_check check (
  image_path is null
  or (owner_coach_id is not null and char_length(image_path) <= 300 and image_path like owner_coach_id::text || '/%')
);

create index if not exists exercises_owner_idx on public.exercises (owner_coach_id) where owner_coach_id is not null;

-- Reading: the shared library for everyone; custom exercises for the owner, their active clients and their trainers.
drop policy if exists "Anyone can read published exercises" on public.exercises;
drop policy if exists "Anyone can read published library exercises" on public.exercises;
create policy "Anyone can read published library exercises"
  on public.exercises for select
  to anon, authenticated
  using (is_published and owner_coach_id is null);

drop policy if exists "Coaches can read their custom exercises" on public.exercises;
create policy "Coaches can read their custom exercises"
  on public.exercises for select
  to authenticated
  using (owner_coach_id = (select auth.uid()));

drop policy if exists "Clients can read the custom exercises of their coach" on public.exercises;
create policy "Clients can read the custom exercises of their coach"
  on public.exercises for select
  to authenticated
  using (
    owner_coach_id is not null
    and is_published
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = exercises.owner_coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
  );

drop policy if exists "Trainers can read the custom exercises of their head coach" on public.exercises;
create policy "Trainers can read the custom exercises of their head coach"
  on public.exercises for select
  to authenticated
  using (owner_coach_id is not null and is_published and owner_coach_id = public.my_team_head());

-- A program may only contain library exercises or the custom exercises of the coach who owns the program.
create or replace function public.training_program_exercise_owner_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner uuid;
  v_coach uuid;
begin
  select owner_coach_id into v_owner from public.exercises where id = new.exercise_id;
  if v_owner is not null then
    select p.coach_id into v_coach
    from public.training_program_days d
    join public.training_programs p on p.id = d.program_id
    where d.id = new.day_id;
    if v_coach is distinct from v_owner then
      raise exception 'A program references an unavailable exercise';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists training_program_exercise_owner on public.training_program_exercises;
create trigger training_program_exercise_owner
  before insert or update of exercise_id, day_id on public.training_program_exercises
  for each row execute function public.training_program_exercise_owner_check();

-- Private bucket for the photos.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'apexfit-exercise-images',
  'apexfit-exercise-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Coaches upload their exercise images" on storage.objects;
create policy "Coaches upload their exercise images"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'apexfit-exercise-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and public.is_active_coach()
  );

drop policy if exists "Coaches delete their exercise images" on storage.objects;
create policy "Coaches delete their exercise images"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'apexfit-exercise-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Exercise images are read by their coach, clients and trainers" on storage.objects;
create policy "Exercise images are read by their coach, clients and trainers"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'apexfit-exercise-images'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (storage.foldername(name))[1] = (select public.my_team_head())::text
      or exists (
        select 1 from public.coach_clients cc
        where cc.coach_id = ((storage.foldername(name))[1])::uuid
          and cc.client_id = (select auth.uid())
          and cc.status = 'active'
      )
    )
  );

-- Validates and normalises a list of muscle / equipment keys (lower-case words, at most 8, no duplicates).
create or replace function public.custom_exercise_keys(p_values text[], p_max integer default 8)
returns text[]
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_clean text[];
begin
  if p_values is null then
    return '{}';
  end if;
  select coalesce(array_agg(distinct lower(btrim(v))), '{}') into v_clean from unnest(p_values) as v where btrim(v) <> '';
  if cardinality(v_clean) > p_max then
    raise exception 'Choose at most % options per list', p_max using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_clean) as v where v !~ '^[a-z][a-z0-9_]{0,39}$') then
    raise exception 'A muscle or equipment option is not valid' using errcode = '22023';
  end if;
  return v_clean;
end;
$$;

-- Creates (p_exercise_id null) or updates one of the coach's own exercises.
create or replace function public.save_custom_exercise(
  p_name text,
  p_description text,
  p_category text,
  p_primary_muscles text[],
  p_secondary_muscles text[],
  p_equipment text[],
  p_difficulty text,
  p_video_url text,
  p_image_path text,
  p_exercise_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := btrim(coalesce(p_description, ''));
  v_video text := nullif(btrim(coalesce(p_video_url, '')), '');
  v_image text := nullif(btrim(coalesce(p_image_path, '')), '');
  v_primary text[];
  v_secondary text[];
  v_equipment text[];
  v_id uuid;
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage custom exercises' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 160 then
    raise exception 'Exercise name must be between 1 and 160 characters' using errcode = '22023';
  end if;
  if char_length(v_description) > 2000 then
    raise exception 'Exercise description cannot exceed 2000 characters' using errcode = '22023';
  end if;
  if p_category is null or p_category not in ('strength', 'cardio', 'mobility', 'plyometrics', 'warmup') then
    raise exception 'Choose a valid exercise category' using errcode = '22023';
  end if;
  if p_difficulty is null or p_difficulty not in ('beginner', 'intermediate', 'advanced') then
    raise exception 'Choose a valid difficulty' using errcode = '22023';
  end if;

  v_primary := public.custom_exercise_keys(p_primary_muscles, 6);
  v_secondary := public.custom_exercise_keys(p_secondary_muscles, 8);
  v_equipment := public.custom_exercise_keys(p_equipment, 8);
  if cardinality(v_primary) = 0 then
    raise exception 'Choose at least one primary muscle' using errcode = '22023';
  end if;

  if v_video is not null and (char_length(v_video) not between 12 and 500 or not public.exercise_video_url_valid(v_video)) then
    raise exception 'Use a secure https link to a YouTube or Vimeo video, or to an MP4 or WebM file' using errcode = '22023';
  end if;

  if v_image is not null then
    if v_image not like auth.uid()::text || '/%' or char_length(v_image) > 300 then
      raise exception 'The exercise photo is not valid' using errcode = '22023';
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'apexfit-exercise-images' and o.name = v_image) then
      raise exception 'The exercise photo was not uploaded' using errcode = '22023';
    end if;
  end if;

  if p_exercise_id is null then
    if (select count(*) from public.exercises where owner_coach_id = auth.uid()) >= 300 then
      raise exception 'You can keep up to 300 custom exercises' using errcode = '54000';
    end if;
    v_id := gen_random_uuid();
    insert into public.exercises (
      id, slug, name, category, primary_muscles, secondary_muscles, equipment, difficulty,
      description, demo_video_url, image_path, thumbnail_url, is_published, owner_coach_id
    )
    values (
      v_id, 'custom-' || v_id::text, v_name, p_category, v_primary, v_secondary, v_equipment, p_difficulty,
      v_description, v_video, v_image, null, true, auth.uid()
    );
  else
    update public.exercises
    set name = v_name,
        category = p_category,
        primary_muscles = v_primary,
        secondary_muscles = v_secondary,
        equipment = v_equipment,
        difficulty = p_difficulty,
        description = v_description,
        demo_video_url = v_video,
        image_path = v_image,
        updated_at = now()
    where id = p_exercise_id and owner_coach_id = auth.uid()
    returning id into v_id;
    if v_id is null then
      raise exception 'Exercise was not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- Deletes one of the coach's own exercises and returns its photo path so the browser can remove the file.
create or replace function public.delete_custom_exercise(p_exercise_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_image text;
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to manage custom exercises' using errcode = '42501';
  end if;
  select image_path into v_image from public.exercises where id = p_exercise_id and owner_coach_id = auth.uid();
  if not found then
    raise exception 'Exercise was not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.training_program_exercises where exercise_id = p_exercise_id)
    or exists (select 1 from public.client_workout_set_logs where exercise_id = p_exercise_id) then
    raise exception 'This exercise is used in a program or a workout log, so it cannot be deleted' using errcode = '23503';
  end if;
  delete from public.exercises where id = p_exercise_id and owner_coach_id = auth.uid();
  return jsonb_build_object('exercise_id', p_exercise_id, 'image_path', v_image);
end;
$$;

revoke all on function public.training_program_exercise_owner_check() from public, anon, authenticated;
revoke all on function public.custom_exercise_keys(text[], integer) from public, anon;
revoke all on function public.save_custom_exercise(text, text, text, text[], text[], text[], text, text, text, uuid) from public, anon;
revoke all on function public.delete_custom_exercise(uuid) from public, anon;
grant execute on function public.custom_exercise_keys(text[], integer) to authenticated;
grant execute on function public.save_custom_exercise(text, text, text, text[], text[], text[], text, text, text, uuid) to authenticated;
grant execute on function public.delete_custom_exercise(uuid) to authenticated;
-- Removing a coach account must not be blocked by programs or client workout history that still point at their
-- exercises: the programs go with the coach, and an exercise that clients have logged is kept hidden so their
-- history stays intact.
create or replace function public.detach_custom_exercises_on_profile_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.exercises where owner_coach_id = old.id) then
    delete from public.training_programs where coach_id = old.id;
    update public.exercises e
    set owner_coach_id = null, is_published = false, image_path = null
    where e.owner_coach_id = old.id
      and exists (select 1 from public.client_workout_set_logs l where l.exercise_id = e.id);
  end if;
  return old;
end;
$$;

drop trigger if exists profiles_detach_custom_exercises on public.profiles;
create trigger profiles_detach_custom_exercises
  before delete on public.profiles
  for each row execute function public.detach_custom_exercises_on_profile_delete();

revoke all on function public.detach_custom_exercises_on_profile_delete() from public, anon, authenticated;