-- A coach can read (never change) the food log of each of their active clients, to review what the client eats.
-- The client keeps full control of their own entries: the existing "for all" policy for the client is untouched, and
-- this policy only grants SELECT, so a coach still cannot insert, update or delete anything.
-- Daily calorie and macro goals already exist (public.nutrition_targets, set with set_client_nutrition_targets).

drop policy if exists "Coaches can read their clients' food logs" on public.client_food_logs;
create policy "Coaches can read their clients' food logs"
  on public.client_food_logs for select
  to authenticated
  using (
    public.is_active_coach()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = (select auth.uid())
        and cc.client_id = client_food_logs.client_id
        and cc.status = 'active'
    )
  );
