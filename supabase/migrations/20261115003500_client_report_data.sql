-- The real numbers behind Jack's client analysis and progress report drafts, in one call for the coach side
-- (a coach, or an assistant trainer who may manage programs for a client assigned to them).
--
-- It gathers what already exists: the period statistics (workouts, volume, weight, food, sleep, steps, tasks), the
-- strongest lifts (best estimated one-rep max in the period against the period before), the last weekly check-ins,
-- water and habit totals, the client's goal and the open progression suggestions. Nothing is estimated or invented:
-- a number that does not exist is null.
create or replace function public.get_client_report_data(p_client_id uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 7), 180);
  v_from date := current_date - (least(greatest(coalesce(p_days, 30), 7), 180) - 1);
  v_before date := current_date - 2 * least(greatest(coalesce(p_days, 30), 7), 180) + 1;
begin
  if auth.uid() is null or public.task_coach_for(p_client_id) is null then
    raise exception 'You can only build reports for your own clients' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', v_days,
    'stats', public.progress_stats_for(p_client_id, v_days),
    'intake', (
      select jsonb_build_object(
        'primary_goal', f.primary_goal, 'experience_level', f.experience_level, 'training_days_per_week', f.training_days_per_week,
        'equipment_access', f.equipment_access, 'injuries', f.injuries, 'dietary_preferences', f.dietary_preferences
      )
      from public.client_intake_forms f where f.client_id = p_client_id
    ),
    'strength', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.best_now desc nulls last)
      from (
        select e.name as exercise_name, e.name_i18n as exercise_name_i18n,
               max(case when w.workout_date >= v_from then w.e1rm end) as best_now,
               max(case when w.workout_date < v_from then w.e1rm end) as best_before
        from (
          select l.exercise_id, s.workout_date,
                 round(case when l.actual_reps = 1 then l.actual_weight_kg else l.actual_weight_kg * (1 + l.actual_reps / 30.0) end, 1) as e1rm
          from public.client_workout_set_logs l
          join public.client_workout_sessions s on s.id = l.session_id
          where s.client_id = p_client_id and s.workout_date >= v_before and l.actual_weight_kg > 0 and l.actual_reps between 1 and 12
        ) w
        join public.exercises e on e.id = w.exercise_id
        group by e.id, e.name, e.name_i18n
        having max(case when w.workout_date >= v_from then w.e1rm end) is not null
        order by max(case when w.workout_date >= v_from then w.e1rm end) desc
        limit 5
      ) s
    ), '[]'::jsonb),
    'checkins', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.week_start_date desc)
      from (
        select week_start_date, weight_kg, sleep_hours, sleep_quality_1_5, workout_adherence_1_10, diet_adherence_1_10, energy_level_1_5, status
        from public.weekly_checkins where client_id = p_client_id and week_start_date >= v_from - 7
        order by week_start_date desc limit 6
      ) c
    ), '[]'::jsonb),
    'habits', jsonb_build_object(
      'avg_water_liters', (select round(avg(water_liters), 1) from public.client_habit_logs where client_id = p_client_id and habit_date >= v_from and water_liters is not null),
      'days_logged', (select count(*) from public.client_habit_logs where client_id = p_client_id and habit_date >= v_from),
      'custom', coalesce((
        select jsonb_agg(jsonb_build_object('name', h.name, 'kind', h.kind, 'days_done', (
          select count(*) from public.client_custom_habit_logs l
          where l.habit_id = h.id and l.log_date >= v_from and (h.kind = 'boolean' or l.value >= coalesce(h.daily_goal, 0))
        )) order by h.sort_order)
        from public.client_custom_habits h where h.client_id = p_client_id and h.status = 'active' and h.builtin_key is null
      ), '[]'::jsonb)
    ),
    'nutrition_target', (select to_jsonb(t) - 'client_id' - 'set_by' - 'updated_at' from public.nutrition_targets t where t.client_id = p_client_id),
    'pending_suggestions', (select count(*) from public.progression_suggestions where client_id = p_client_id and status = 'pending')
  );
end;
$$;

revoke all on function public.get_client_report_data(uuid, integer) from public, anon;
grant execute on function public.get_client_report_data(uuid, integer) to authenticated;
