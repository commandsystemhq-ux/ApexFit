-- The numbers on the coach's dashboard, all computed from the coach's own records in one call.
-- It runs with the database's permissions (security definer), so it checks everything itself: it answers only for an
-- active coach, and every count and every client in the answer belongs to that coach's own active clients.
--
--   active_clients : active clients linked to this coach
--   plans_created  : training programs this coach created (templates included)
--   revenue_month  : money received this calendar month (UTC), by currency, in cents: paid invoices (by paid_at)
--                    plus paid store orders (by purchase date)
--   clients[]      : one entry per active client with what the dashboard needs to work out workout adherence
--                    and the insights: distinct days with a logged workout and food log, the last of each, the weekly
--                    training goal from the onboarding form (null when not filled in) and unread messages
create or replace function public.get_coach_dashboard(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_month_start timestamptz := date_trunc('month', statement_timestamp());
  v_month_end timestamptz := date_trunc('month', statement_timestamp()) + interval '1 month';
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'days', v_days,
    'active_clients', (select count(*) from public.coach_clients where coach_id = auth.uid() and status = 'active'),
    'plans_created', (select count(*) from public.training_programs where coach_id = auth.uid()),
    'revenue_month', coalesce((
      select jsonb_agg(jsonb_build_object('currency', currency, 'cents', total) order by currency)
      from (
        select currency, sum(cents)::bigint as total
        from (
          select i.currency, i.amount_cents as cents
          from public.invoices i
          where i.coach_id = auth.uid() and i.status = 'paid' and i.paid_at >= v_month_start and i.paid_at < v_month_end
          union all
          select o.currency, o.amount_cents
          from public.store_orders o
          where o.coach_id = auth.uid() and o.status = 'paid'
            and coalesce(o.purchased_at, o.created_at) >= v_month_start and coalesce(o.purchased_at, o.created_at) < v_month_end
        ) paid
        group by currency
      ) totals
    ), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', cc.client_id,
        'name', coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client'),
        'joined_at', cc.created_at,
        'weekly_target', (select f.training_days_per_week from public.client_intake_forms f where f.client_id = cc.client_id),
        'workout_days_7', (select count(distinct s.workout_date) from public.client_workout_sessions s
                           where s.client_id = cc.client_id and s.workout_date > current_date - 7 and s.workout_date <= current_date + 1),
        'workout_days_period', (select count(distinct s.workout_date) from public.client_workout_sessions s
                                where s.client_id = cc.client_id and s.workout_date > current_date - v_days and s.workout_date <= current_date + 1),
        'last_workout_on', (select max(s.workout_date) from public.client_workout_sessions s where s.client_id = cc.client_id),
        'food_days_7', (select count(distinct l.logged_on) from public.client_food_logs l
                        where l.client_id = cc.client_id and l.logged_on > current_date - 7),
        'last_food_on', (select max(l.logged_on) from public.client_food_logs l where l.client_id = cc.client_id),
        'unread_messages', (select count(*) from public.chat_messages m
                            where m.sender_id = cc.client_id and m.receiver_id = auth.uid() and not m.is_read)
      ) order by coalesce(nullif(btrim(cc.client_name), ''), nullif(btrim(cc.client_email), ''), 'Client'))
      from public.coach_clients cc
      where cc.coach_id = auth.uid() and cc.status = 'active'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_coach_dashboard(integer) from public, anon;
grant execute on function public.get_coach_dashboard(integer) to authenticated;
