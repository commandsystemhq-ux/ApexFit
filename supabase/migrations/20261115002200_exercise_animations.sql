-- Short looping demos for exercises: an animation (GIF, MP4 or WebM) and the still frames of the movement.
-- thumbnail_url stays as the poster image shown while the animation loads, on slow connections and if it fails.

alter table public.exercises add column if not exists animation_url text;
alter table public.exercises add column if not exists image_frames text[] not null default '{}';

alter table public.exercises drop constraint if exists exercises_animation_url_check;
alter table public.exercises add constraint exercises_animation_url_check
  check (
    animation_url is null
    or (
      char_length(animation_url) <= 2000
      and animation_url ~* '^https://[^/@[:space:]]+/[^?#[:space:]]*\.(gif|mp4|webm|webp)(\?[^[:space:]]*)?$'
    )
  );

-- Check constraints cannot contain subqueries, so the frame list is checked by a small function.
create or replace function public.exercise_frames_valid(p_frames text[])
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_frames is not null
    and cardinality(p_frames) <= 4
    and coalesce((select bool_and(frame ~* '^https://[^/@[:space:]]+/[^[:space:]]+$' and char_length(frame) <= 2000) from unnest(p_frames) as frame), true);
$$;

alter table public.exercises drop constraint if exists exercises_image_frames_check;
alter table public.exercises add constraint exercises_image_frames_check check (public.exercise_frames_valid(image_frames));

revoke all on function public.exercise_frames_valid(text[]) from public, anon, authenticated;
grant execute on function public.exercise_frames_valid(text[]) to service_role;
