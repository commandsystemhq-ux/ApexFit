-- A coach can attach their own demo video to any exercise of the library (YouTube, Vimeo or a direct MP4/WebM link).
-- The shared library is not touched: the choice belongs to that coach, is shown to that coach and to the clients linked
-- to them, and takes the place of the library's own video for those people only.
--
-- Security: a coach reads and writes only their own links (writes through set_exercise_video, which checks the link);
-- a client reads the links of the coaches they are actively linked to. Links must be https, without credentials, from
-- YouTube, Vimeo or a direct video file.

create table if not exists public.coach_exercise_videos (
  coach_id uuid not null references public.profiles (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  video_url text not null check (char_length(video_url) between 12 and 500),
  updated_at timestamptz not null default now(),
  primary key (coach_id, exercise_id)
);

create index if not exists coach_exercise_videos_exercise_idx on public.coach_exercise_videos (exercise_id);

alter table public.coach_exercise_videos enable row level security;

drop policy if exists "Coaches can read their own exercise videos" on public.coach_exercise_videos;
create policy "Coaches can read their own exercise videos"
  on public.coach_exercise_videos for select
  to authenticated
  using (coach_id = (select auth.uid()) and public.is_active_coach());

drop policy if exists "Clients can read the exercise videos of their coach" on public.coach_exercise_videos;
create policy "Clients can read the exercise videos of their coach"
  on public.coach_exercise_videos for select
  to authenticated
  using (
    public.is_client_account()
    and exists (
      select 1 from public.coach_clients cc
      where cc.coach_id = coach_exercise_videos.coach_id and cc.client_id = (select auth.uid()) and cc.status = 'active'
    )
  );

revoke all on public.coach_exercise_videos from anon, authenticated;
grant select on public.coach_exercise_videos to authenticated;

-- True for an https link to YouTube, Vimeo or a video file, with no embedded login.
create or replace function public.exercise_video_url_valid(p_url text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_url is not null
    and p_url !~ '[[:space:]]'
    and p_url !~ '^https://[^/]*@'
    and (
      p_url ~* '^https://(www\.|m\.)?(youtube\.com|youtube-nocookie\.com)/[^[:space:]]+$'
      or p_url ~* '^https://youtu\.be/[A-Za-z0-9_-]{11}([?&#][^[:space:]]*)?$'
      or p_url ~* '^https://(www\.)?vimeo\.com/[^[:space:]]*[0-9]+[^[:space:]]*$'
      or p_url ~* '^https://player\.vimeo\.com/video/[0-9]+([?&#][^[:space:]]*)?$'
      or p_url ~* '^https://[^/[:space:]]+/[^[:space:]]*\.(mp4|webm)([?#][^[:space:]]*)?$'
    );
$$;

-- Sets (or, with an empty link, removes) the coach's own video for one exercise.
create or replace function public.set_exercise_video(p_exercise_id uuid, p_url text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
begin
  if auth.uid() is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to change exercise videos' using errcode = '42501';
  end if;
  if not exists (select 1 from public.exercises where id = p_exercise_id and is_published) then
    raise exception 'Exercise was not found' using errcode = 'P0002';
  end if;
  if v_url = '' then
    delete from public.coach_exercise_videos where coach_id = auth.uid() and exercise_id = p_exercise_id;
    return jsonb_build_object('exercise_id', p_exercise_id, 'video_url', null);
  end if;
  if char_length(v_url) not between 12 and 500 or not public.exercise_video_url_valid(v_url) then
    raise exception 'Use a secure https link to a YouTube or Vimeo video, or to an MP4 or WebM file' using errcode = '22023';
  end if;
  insert into public.coach_exercise_videos (coach_id, exercise_id, video_url)
  values (auth.uid(), p_exercise_id, v_url)
  on conflict (coach_id, exercise_id) do update set video_url = excluded.video_url, updated_at = now();
  return jsonb_build_object('exercise_id', p_exercise_id, 'video_url', v_url);
end;
$$;

revoke all on function public.exercise_video_url_valid(text) from public, anon;
revoke all on function public.set_exercise_video(uuid, text) from public, anon;
grant execute on function public.exercise_video_url_valid(text) to authenticated, service_role;
grant execute on function public.set_exercise_video(uuid, text) to authenticated;
