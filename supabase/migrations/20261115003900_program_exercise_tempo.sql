-- Tempo for program exercises, e.g. 3-1-1-0: seconds lowering (eccentric), pause at the bottom, lifting (concentric),
-- pause at the top. Each part is a digit, or X for "as fast as possible". The column is optional (empty = no tempo).
-- Coaches write it through save_training_program / duplicate_training_program; clients read the programs assigned to
-- them through get_my_assigned_programs (a client has no direct access to the program tables).

alter table public.training_program_exercises add column if not exists tempo text not null default '';
alter table public.training_program_exercises drop constraint if exists training_program_exercises_tempo_check;
alter table public.training_program_exercises add constraint training_program_exercises_tempo_check
  check (tempo = '' or tempo ~ '^[0-9X]-[0-9X]-[0-9X]-[0-9X]$');
create or replace function public.save_training_program(
  p_title text,
  p_description text,
  p_days jsonb,
  p_program_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
  v_program_id uuid;
  v_day jsonb;
  v_exercise jsonb;
  v_day_id uuid;
  v_exercise_id uuid;
  v_day_index bigint;
  v_exercise_index bigint;
  v_day_count integer;
  v_exercise_count integer;
  v_sets integer;
  v_rest_seconds integer;
  v_reps text;
  v_notes text;
  v_tempo text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  v_access := public.get_my_access_status();
  if v_access ->> 'role' <> 'coach'
    or v_access ->> 'access_state' not in ('trialing', 'active') then
    raise exception 'An active coach account is required to save programs';
  end if;

  if p_title is null or length(btrim(p_title)) not between 1 and 160 then
    raise exception 'Program title must be between 1 and 160 characters';
  end if;
  if length(coalesce(p_description, '')) > 2000 then
    raise exception 'Program description cannot exceed 2000 characters';
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' then
    raise exception 'Program days must be provided as an array';
  end if;
  v_day_count := jsonb_array_length(p_days);
  if v_day_count < 1 or v_day_count > 14 then
    raise exception 'A program must contain between 1 and 14 days';
  end if;

  if p_program_id is null then
    insert into public.training_programs (coach_id, title, description)
    values (auth.uid(), btrim(p_title), coalesce(p_description, ''))
    returning id into v_program_id;
  else
    update public.training_programs
    set title = btrim(p_title),
        description = coalesce(p_description, ''),
        updated_at = statement_timestamp()
    where id = p_program_id
      and coach_id = auth.uid()
    returning id into v_program_id;

    if v_program_id is null then
      raise exception 'Program was not found or does not belong to this coach';
    end if;

    delete from public.training_program_days
    where program_id = v_program_id;
  end if;

  for v_day, v_day_index in
    select value, ordinality
    from jsonb_array_elements(p_days) with ordinality
  loop
    if jsonb_typeof(v_day) <> 'object'
      or v_day ->> 'name' is null
      or length(btrim(v_day ->> 'name')) not between 1 and 100 then
      raise exception 'Each training day must have a name between 1 and 100 characters';
    end if;
    if v_day -> 'exercises' is null or jsonb_typeof(v_day -> 'exercises') <> 'array' then
      raise exception 'Each training day must contain an exercises array';
    end if;
    v_exercise_count := jsonb_array_length(v_day -> 'exercises');
    if v_exercise_count > 60 then
      raise exception 'A training day cannot contain more than 60 exercises';
    end if;

    insert into public.training_program_days (program_id, name, order_index)
    values (v_program_id, btrim(v_day ->> 'name'), v_day_index::integer - 1)
    returning id into v_day_id;

    for v_exercise, v_exercise_index in
      select value, ordinality
      from jsonb_array_elements(v_day -> 'exercises') with ordinality
    loop
      begin
        v_exercise_id := (v_exercise ->> 'exercise_id')::uuid;
      exception
        when invalid_text_representation then
          raise exception 'Each program exercise must reference a valid exercise ID';
      end;

      if not exists (
        select 1
        from public.exercises e
        where e.id = v_exercise_id
          and e.is_published
      ) then
        raise exception 'A program references an unavailable exercise';
      end if;

      v_sets := coalesce(nullif(v_exercise ->> 'sets', ''), '3')::integer;
      v_reps := coalesce(nullif(btrim(v_exercise ->> 'reps'), ''), '8-12');
      v_rest_seconds := coalesce(nullif(v_exercise ->> 'rest_seconds', ''), '90')::integer;
      v_notes := coalesce(v_exercise ->> 'notes', '');
      v_tempo := upper(btrim(coalesce(v_exercise ->> 'tempo', '')));
      if v_tempo <> '' and v_tempo !~ '^[0-9X]-[0-9X]-[0-9X]-[0-9X]$' then
        raise exception 'Tempo must have four parts such as 3-1-1-0 (digits, or X for explosive)';
      end if;

      insert into public.training_program_exercises (
        day_id, exercise_id, order_index, sets, reps, rest_seconds, notes, tempo
      )
      values (
        v_day_id,
        v_exercise_id,
        v_exercise_index::integer - 1,
        v_sets,
        v_reps,
        v_rest_seconds,
        v_notes,
        v_tempo
      );
    end loop;
  end loop;

  return v_program_id;
end;
$$;

create or replace function public.duplicate_training_program(
  p_program_id uuid,
  p_title text default null,
  p_as_template boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_access jsonb;
  v_source public.training_programs%rowtype;
  v_day public.training_program_days%rowtype;
  v_new_program_id uuid;
  v_new_day_id uuid;
  v_title text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required';
  end if;

  v_access := public.get_my_access_status();
  if v_access ->> 'role' <> 'coach'
    or v_access ->> 'access_state' not in ('trialing', 'active') then
    raise exception 'An active coach account is required to duplicate programs';
  end if;

  select * into v_source
  from public.training_programs
  where id = p_program_id
    and coach_id = auth.uid();

  if not found then
    raise exception 'Program was not found or does not belong to this coach';
  end if;

  v_title := coalesce(nullif(btrim(p_title), ''), left(v_source.title, 150) || ' (copy)');
  if length(v_title) > 160 then
    raise exception 'Program title cannot exceed 160 characters';
  end if;

  insert into public.training_programs (coach_id, title, description, is_template)
  values (auth.uid(), v_title, v_source.description, coalesce(p_as_template, false))
  returning id into v_new_program_id;

  for v_day in
    select *
    from public.training_program_days
    where program_id = p_program_id
    order by order_index
  loop
    insert into public.training_program_days (program_id, name, order_index)
    values (v_new_program_id, v_day.name, v_day.order_index)
    returning id into v_new_day_id;

    insert into public.training_program_exercises (
      day_id, exercise_id, order_index, sets, reps, rest_seconds, notes, tempo
    )
    select v_new_day_id, e.exercise_id, e.order_index, e.sets, e.reps, e.rest_seconds, e.notes, e.tempo
    from public.training_program_exercises e
    where e.day_id = v_day.id;
  end loop;

  return v_new_program_id;
end;
$$;

revoke all on function public.save_training_program(text, text, jsonb, uuid) from public;
grant execute on function public.save_training_program(text, text, jsonb, uuid) to authenticated;
revoke all on function public.duplicate_training_program(uuid, text, boolean) from public;
grant execute on function public.duplicate_training_program(uuid, text, boolean) to authenticated;

-- The programs a coach has assigned to the signed-in client (the latest assignment of each program, newest first,
-- at most three), with sets, reps, rest, tempo and notes for every exercise.
create or replace function public.get_my_assigned_programs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_client_account() then
    raise exception 'A client account is required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(s.program order by s.assigned_at desc)
    from (
      select a.assigned_at, jsonb_build_object(
        'program_id', a.program_id,
        'title', a.title,
        'description', a.description,
        'assigned_at', a.assigned_at,
        'days', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id', d.id,
              'name', d.name,
              'exercises', coalesce((
                select jsonb_agg(
                  jsonb_build_object(
                    'id', pe.id,
                    'exercise_id', pe.exercise_id,
                    'sets', pe.sets,
                    'reps', pe.reps,
                    'rest_seconds', pe.rest_seconds,
                    'tempo', pe.tempo,
                    'notes', pe.notes,
                    'exercise', jsonb_build_object(
                      'id', e.id, 'slug', e.slug, 'name', e.name, 'name_i18n', e.name_i18n, 'category', e.category,
                      'difficulty', e.difficulty, 'primary_muscles', e.primary_muscles, 'equipment', e.equipment,
                      'demo_video_url', e.demo_video_url, 'thumbnail_url', e.thumbnail_url, 'animation_url', e.animation_url,
                      'image_frames', e.image_frames, 'owner_coach_id', e.owner_coach_id, 'image_path', e.image_path,
                      'description', e.description
                    )
                  )
                  order by pe.order_index
                )
                from public.training_program_exercises pe
                join public.exercises e on e.id = pe.exercise_id
                where pe.day_id = d.id
              ), '[]'::jsonb)
            )
            order by d.order_index
          )
          from public.training_program_days d
          where d.program_id = a.program_id
        ), '[]'::jsonb)
      ) as program
      from (
        select distinct on (pa.program_id) pa.program_id, pa.assigned_at, p.title, p.description
        from public.program_assignments pa
        join public.training_programs p on p.id = pa.program_id
        where pa.client_id = auth.uid()
          and exists (
            select 1 from public.coach_clients cc
            where cc.coach_id = pa.coach_id and cc.client_id = pa.client_id and cc.status = 'active'
          )
        order by pa.program_id, pa.assigned_at desc
      ) a
      order by a.assigned_at desc
      limit 3
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_my_assigned_programs() from public, anon;
grant execute on function public.get_my_assigned_programs() to authenticated;