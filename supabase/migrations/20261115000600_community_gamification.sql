-- Community feed and gamification. A community belongs to one coach: the coach and that coach's active clients.

create table if not exists public.community_profiles (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 2 and 40),
  leaderboard_opt_in boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.point_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  source text not null check (source in ('workout', 'food', 'habit', 'metric')),
  source_id uuid not null,
  event_date date not null,
  points integer not null check (points between 1 and 100),
  created_at timestamptz not null default now(),
  unique (source, source_id)
);

create index if not exists point_events_user_date_idx on public.point_events (user_id, event_date);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('update', 'achievement', 'announcement')),
  body text not null default '' check (length(body) <= 1000),
  achievement_code text,
  created_at timestamptz not null default now(),
  check (
    (kind = 'achievement' and achievement_code is not null)
    or (kind <> 'achievement' and achievement_code is null and length(btrim(body)) > 0)
  )
);

create index if not exists community_posts_feed_idx on public.community_posts (coach_id, created_at desc);
create index if not exists community_posts_author_idx on public.community_posts (author_id, created_at desc);

create table if not exists public.community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.community_posts (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists community_comments_post_idx on public.community_comments (post_id, created_at);
create index if not exists community_comments_author_idx on public.community_comments (author_id, created_at desc);

create table if not exists public.community_reactions (
  post_id uuid not null references public.community_posts (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  reaction text not null check (reaction in ('like', 'fire', 'clap')),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.community_profiles enable row level security;
alter table public.point_events enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_reactions enable row level security;

drop policy if exists "Users can read their community profile" on public.community_profiles;
create policy "Users can read their community profile"
  on public.community_profiles for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Clients can read their point events" on public.point_events;
create policy "Clients can read their point events"
  on public.point_events for select
  to authenticated
  using (user_id = (select auth.uid()) and public.is_client_account());

-- Posts, comments, and reactions are only reachable through the security definer functions below.
revoke all on public.community_profiles, public.point_events, public.community_posts,
  public.community_comments, public.community_reactions from anon, authenticated;
grant select on public.community_profiles, public.point_events to authenticated;
grant all on public.community_profiles, public.point_events, public.community_posts,
  public.community_comments, public.community_reactions to service_role;

create or replace function public.can_access_community(p_coach_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or p_coach_id is null then
    return false;
  end if;
  if auth.uid() = p_coach_id then
    return public.is_active_coach();
  end if;
  return public.is_client_account()
    and exists (
      select 1 from public.coach_clients
      where coach_id = p_coach_id and client_id = auth.uid() and status = 'active'
    );
end;
$$;

-- Points: awarded by triggers, capped per day and source, and only for entries dated today or yesterday.
create or replace function public.award_points(
  p_user_id uuid,
  p_source text,
  p_source_id uuid,
  p_event_date date,
  p_points integer,
  p_daily_cap integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_awarded_today integer;
begin
  if p_event_date < current_date - 1 or p_event_date > current_date + 1 then
    return;
  end if;

  select coalesce(sum(points), 0) into v_awarded_today
  from public.point_events
  where user_id = p_user_id and source = p_source and event_date = p_event_date;

  if v_awarded_today + p_points > p_daily_cap then
    return;
  end if;

  insert into public.point_events (user_id, source, source_id, event_date, points)
  values (p_user_id, p_source, p_source_id, p_event_date, p_points)
  on conflict (source, source_id) do nothing;
end;
$$;

create or replace function public.award_workout_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'workout', new.id, new.workout_date, 50, 100);
  return new;
end;
$$;

create or replace function public.award_food_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'food', new.id, new.logged_on, 5, 20);
  return new;
end;
$$;

create or replace function public.award_habit_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'habit', new.id, new.habit_date, 10, 10);
  return new;
end;
$$;

create or replace function public.award_metric_points()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.award_points(new.client_id, 'metric', new.id, new.measured_on, 10, 10);
  return new;
end;
$$;

drop trigger if exists client_workout_sessions_award_points on public.client_workout_sessions;
create trigger client_workout_sessions_award_points
  after insert on public.client_workout_sessions
  for each row execute function public.award_workout_points();

drop trigger if exists client_food_logs_award_points on public.client_food_logs;
create trigger client_food_logs_award_points
  after insert on public.client_food_logs
  for each row execute function public.award_food_points();

drop trigger if exists client_habit_logs_award_points on public.client_habit_logs;
create trigger client_habit_logs_award_points
  after insert on public.client_habit_logs
  for each row execute function public.award_habit_points();

drop trigger if exists client_body_metrics_award_points on public.client_body_metrics;
create trigger client_body_metrics_award_points
  after insert on public.client_body_metrics
  for each row execute function public.award_metric_points();

-- Summary used for the progress screen and to verify shared achievements.
create or replace function public.gamification_summary(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_total integer;
  v_week integer;
  v_current_streak integer := 0;
  v_longest_streak integer := 0;
  v_workouts integer;
  v_food_days integer;
  v_level integer;
  v_badges jsonb := '[]'::jsonb;
begin
  select coalesce(sum(points), 0)::integer,
         coalesce(sum(points) filter (where event_date >= current_date - 6), 0)::integer
  into v_total, v_week
  from public.point_events
  where user_id = p_user_id;

  select coalesce(max(island_length), 0),
         coalesce(max(island_length) filter (where last_day >= current_date - 1), 0)
  into v_longest_streak, v_current_streak
  from (
    select count(*)::integer as island_length, max(event_date) as last_day
    from (
      select event_date, event_date - (row_number() over (order by event_date))::integer as island
      from (select distinct event_date from public.point_events where user_id = p_user_id) days
    ) numbered
    group by island
  ) islands;

  select count(*)::integer into v_workouts from public.client_workout_sessions where client_id = p_user_id;
  select count(distinct logged_on)::integer into v_food_days from public.client_food_logs where client_id = p_user_id;

  if v_workouts >= 1 then v_badges := v_badges || '"first_workout"'::jsonb; end if;
  if v_workouts >= 10 then v_badges := v_badges || '"workouts_10"'::jsonb; end if;
  if v_workouts >= 50 then v_badges := v_badges || '"workouts_50"'::jsonb; end if;
  if v_longest_streak >= 7 then v_badges := v_badges || '"streak_7"'::jsonb; end if;
  if v_longest_streak >= 30 then v_badges := v_badges || '"streak_30"'::jsonb; end if;
  if v_food_days >= 7 then v_badges := v_badges || '"food_7"'::jsonb; end if;
  if v_total >= 500 then v_badges := v_badges || '"points_500"'::jsonb; end if;
  if v_total >= 2000 then v_badges := v_badges || '"points_2000"'::jsonb; end if;

  v_level := 1 + v_total / 250;
  return jsonb_build_object(
    'total_points', v_total,
    'week_points', v_week,
    'level', v_level,
    'points_into_level', v_total - (v_level - 1) * 250,
    'points_per_level', 250,
    'current_streak', v_current_streak,
    'longest_streak', v_longest_streak,
    'workouts', v_workouts,
    'food_days', v_food_days,
    'badges', v_badges
  );
end;
$$;

create or replace function public.get_my_gamification()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_client_account() then
    raise exception 'A client account is required';
  end if;
  return public.gamification_summary(auth.uid());
end;
$$;

create or replace function public.join_community(p_display_name text, p_leaderboard_opt_in boolean default true)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if auth.uid() is null or not (public.is_client_account() or public.is_active_coach()) then
    raise exception 'An active ApexFit account is required to join the community';
  end if;
  if length(v_name) not between 2 and 40 then
    raise exception 'Display name must be between 2 and 40 characters';
  end if;

  insert into public.community_profiles (user_id, display_name, leaderboard_opt_in)
  values (auth.uid(), v_name, coalesce(p_leaderboard_opt_in, true))
  on conflict (user_id) do update
  set display_name = excluded.display_name,
      leaderboard_opt_in = excluded.leaderboard_opt_in,
      updated_at = statement_timestamp();
end;
$$;

create or replace function public.list_community_feed(
  p_coach_id uuid,
  p_limit integer default 20,
  p_before timestamptz default null
)
returns table (
  post_id uuid,
  author_id uuid,
  author_name text,
  author_is_coach boolean,
  kind text,
  body text,
  achievement_code text,
  created_at timestamptz,
  comment_count integer,
  reactions jsonb,
  my_reaction text,
  can_delete boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not public.can_access_community(p_coach_id) then
    raise exception 'You do not have access to this community';
  end if;

  return query
  select
    p.id,
    p.author_id,
    coalesce(cp.display_name, 'Member'),
    p.author_id = p.coach_id,
    p.kind,
    p.body,
    p.achievement_code,
    p.created_at,
    (select count(*)::integer from public.community_comments c where c.post_id = p.id),
    coalesce(
      (select jsonb_object_agg(r.reaction, r.reaction_count)
       from (select cr.reaction, count(*) as reaction_count
             from public.community_reactions cr where cr.post_id = p.id group by cr.reaction) r),
      '{}'::jsonb
    ),
    (select cr.reaction from public.community_reactions cr where cr.post_id = p.id and cr.user_id = auth.uid()),
    p.author_id = auth.uid() or p.coach_id = auth.uid()
  from public.community_posts p
  left join public.community_profiles cp on cp.user_id = p.author_id
  where p.coach_id = p_coach_id
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

create or replace function public.create_community_post(
  p_coach_id uuid,
  p_kind text,
  p_body text,
  p_achievement_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not public.can_access_community(p_coach_id) then
    raise exception 'You do not have access to this community';
  end if;
  if not exists (select 1 from public.community_profiles where user_id = auth.uid()) then
    raise exception 'Choose a display name before posting';
  end if;
  if p_kind not in ('update', 'achievement', 'announcement') then
    raise exception 'Unsupported post type';
  end if;
  if length(v_body) > 1000 then
    raise exception 'Posts cannot exceed 1000 characters';
  end if;
  if p_kind = 'announcement' and auth.uid() <> p_coach_id then
    raise exception 'Only the coach can post announcements';
  end if;
  if p_kind = 'achievement' then
    if not exists (
      select 1 from jsonb_array_elements_text(public.gamification_summary(auth.uid()) -> 'badges') badge
      where badge = coalesce(p_achievement_code, '')
    ) then
      raise exception 'You have not earned this achievement yet';
    end if;
  elsif p_achievement_code is not null then
    raise exception 'Only achievement posts can reference an achievement';
  elsif v_body = '' then
    raise exception 'Write something to share';
  end if;
  if (select count(*) from public.community_posts
      where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour') >= 10 then
    raise exception 'You are posting too quickly. Try again later';
  end if;

  insert into public.community_posts (coach_id, author_id, kind, body, achievement_code)
  values (p_coach_id, auth.uid(), p_kind, v_body, p_achievement_code)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_community_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.community_posts%rowtype;
begin
  select * into v_post from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_post.coach_id)
    or (v_post.author_id <> auth.uid() and v_post.coach_id <> auth.uid()) then
    raise exception 'Post not found';
  end if;
  delete from public.community_posts where id = p_post_id;
end;
$$;

create or replace function public.list_post_comments(p_post_id uuid)
returns table (
  comment_id uuid,
  author_id uuid,
  author_name text,
  author_is_coach boolean,
  body text,
  created_at timestamptz,
  can_delete boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_coach_id uuid;
begin
  select coach_id into v_coach_id from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_coach_id) then
    raise exception 'Post not found';
  end if;

  return query
  select c.id, c.author_id, coalesce(cp.display_name, 'Member'), c.author_id = v_coach_id,
         c.body, c.created_at, c.author_id = auth.uid() or v_coach_id = auth.uid()
  from public.community_comments c
  left join public.community_profiles cp on cp.user_id = c.author_id
  where c.post_id = p_post_id
  order by c.created_at
  limit 200;
end;
$$;

create or replace function public.add_post_comment(p_post_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach_id uuid;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  select coach_id into v_coach_id from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_coach_id) then
    raise exception 'Post not found';
  end if;
  if not exists (select 1 from public.community_profiles where user_id = auth.uid()) then
    raise exception 'Choose a display name before commenting';
  end if;
  if length(v_body) not between 1 and 500 then
    raise exception 'Comments must be between 1 and 500 characters';
  end if;
  if (select count(*) from public.community_comments
      where author_id = auth.uid() and created_at > statement_timestamp() - interval '1 hour') >= 30 then
    raise exception 'You are commenting too quickly. Try again later';
  end if;

  insert into public.community_comments (post_id, author_id, body)
  values (p_post_id, auth.uid(), v_body)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.delete_post_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_comment public.community_comments%rowtype;
  v_coach_id uuid;
begin
  select * into v_comment from public.community_comments where id = p_comment_id;
  if not found then
    raise exception 'Comment not found';
  end if;
  select coach_id into v_coach_id from public.community_posts where id = v_comment.post_id;
  if not public.can_access_community(v_coach_id) or (v_comment.author_id <> auth.uid() and v_coach_id <> auth.uid()) then
    raise exception 'Comment not found';
  end if;
  delete from public.community_comments where id = p_comment_id;
end;
$$;

create or replace function public.set_post_reaction(p_post_id uuid, p_reaction text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_coach_id uuid;
begin
  select coach_id into v_coach_id from public.community_posts where id = p_post_id;
  if not found or not public.can_access_community(v_coach_id) then
    raise exception 'Post not found';
  end if;

  if p_reaction is null then
    delete from public.community_reactions where post_id = p_post_id and user_id = auth.uid();
  else
    if p_reaction not in ('like', 'fire', 'clap') then
      raise exception 'Unsupported reaction';
    end if;
    insert into public.community_reactions (post_id, user_id, reaction)
    values (p_post_id, auth.uid(), p_reaction)
    on conflict (post_id, user_id) do update set reaction = excluded.reaction;
  end if;
end;
$$;

create or replace function public.get_leaderboard(p_coach_id uuid, p_period text default 'week')
returns table (
  lb_rank bigint,
  lb_user_id uuid,
  lb_display_name text,
  lb_points bigint,
  lb_level integer,
  lb_is_me boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_start date;
begin
  if not public.can_access_community(p_coach_id) then
    raise exception 'You do not have access to this community';
  end if;
  if p_period not in ('week', 'month', 'all') then
    raise exception 'Unsupported leaderboard period';
  end if;
  v_start := case p_period
    when 'week' then current_date - 6
    when 'month' then current_date - 29
    else date '1970-01-01'
  end;

  return query
  with scores as (
    select cc.client_id as score_user_id,
           cp.display_name as score_name,
           coalesce(sum(pe.points) filter (where pe.event_date >= v_start), 0)::bigint as period_points,
           coalesce(sum(pe.points), 0)::bigint as total_points
    from public.coach_clients cc
    join public.community_profiles cp on cp.user_id = cc.client_id
    left join public.point_events pe on pe.user_id = cc.client_id
    where cc.coach_id = p_coach_id
      and cc.status = 'active'
      and (cp.leaderboard_opt_in or cc.client_id = auth.uid())
    group by cc.client_id, cp.display_name
  )
  select rank() over (order by s.period_points desc),
         s.score_user_id,
         s.score_name,
         s.period_points,
         (1 + s.total_points / 250)::integer,
         s.score_user_id = auth.uid()
  from scores s
  order by 1, 3
  limit 50;
end;
$$;

revoke all on function public.can_access_community(uuid) from public, anon;
revoke all on function public.award_points(uuid, text, uuid, date, integer, integer) from public, anon, authenticated;
revoke all on function public.award_workout_points() from public, anon, authenticated;
revoke all on function public.award_food_points() from public, anon, authenticated;
revoke all on function public.award_habit_points() from public, anon, authenticated;
revoke all on function public.award_metric_points() from public, anon, authenticated;
revoke all on function public.gamification_summary(uuid) from public, anon, authenticated;
revoke all on function public.get_my_gamification() from public, anon;
revoke all on function public.join_community(text, boolean) from public, anon;
revoke all on function public.list_community_feed(uuid, integer, timestamptz) from public, anon;
revoke all on function public.create_community_post(uuid, text, text, text) from public, anon;
revoke all on function public.delete_community_post(uuid) from public, anon;
revoke all on function public.list_post_comments(uuid) from public, anon;
revoke all on function public.add_post_comment(uuid, text) from public, anon;
revoke all on function public.delete_post_comment(uuid) from public, anon;
revoke all on function public.set_post_reaction(uuid, text) from public, anon;
revoke all on function public.get_leaderboard(uuid, text) from public, anon;
grant execute on function public.can_access_community(uuid) to authenticated;
grant execute on function public.get_my_gamification() to authenticated;
grant execute on function public.join_community(text, boolean) to authenticated;
grant execute on function public.list_community_feed(uuid, integer, timestamptz) to authenticated;
grant execute on function public.create_community_post(uuid, text, text, text) to authenticated;
grant execute on function public.delete_community_post(uuid) to authenticated;
grant execute on function public.list_post_comments(uuid) to authenticated;
grant execute on function public.add_post_comment(uuid, text) to authenticated;
grant execute on function public.delete_post_comment(uuid) to authenticated;
grant execute on function public.set_post_reaction(uuid, text) to authenticated;
grant execute on function public.get_leaderboard(uuid, text) to authenticated;
