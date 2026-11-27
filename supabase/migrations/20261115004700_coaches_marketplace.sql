-- Coaches marketplace: a coach publishes a public profile, signed-in clients search for coaches and ask them to get in
-- touch, and the platform owner moderates what is published.
--
-- What is public. Only the columns that the read functions below return: name or brand, photo (the account avatar),
-- headline, bio, specialties, languages, certifications, years of experience, city and country, training mode, intro
-- video link, whether the coach takes new clients, and review totals. E-mail addresses, phone numbers and anything about
-- the coach's clients are never part of a result.
--
-- When a coach is listed. All four must hold, checked at read time (so a lapsed subscription hides the profile by
-- itself, with no scheduled job):
--   1. the coach turned "list me" on (is_listed, off by default),
--   2. the owner has not hidden the profile (is_hidden),
--   3. the coach has a live subscription or trial (workflow_coach_is_active),
--   4. the account is a head coach, not an assistant trainer.
--
-- Security model. Every table has row-level security with no policy and no grant for the app roles: nobody reads or writes
-- a table directly. Everything goes through security definer functions that re-check who is asking.
--   * Reviews: only a client who has been linked to the coach for at least 14 days, one review per client and coach
--     (the client may edit it). The coach may add one public reply. Nobody deletes a review: the owner can hide one.
--   * Reports: any signed-in person may report a coach profile or a review, once per target.
--   * Contact requests: a client sends a short message (3 a day, one open request per coach). The coach accepts or
--     declines; accepting links the client to the coach (the same coach_clients link an invite code creates) and tells both.
--   * Moderation: admin_* functions check platform_admins, a table only the project owner can fill (SQL editor), e.g.
--       insert into public.platform_admins (user_id) select id from auth.users where lower(email) = lower('owner@example.com');
--
-- A client may be linked to several coaches in this platform (coach_clients is one row per coach and client), so
-- accepting a request is never refused for that reason; the answer says how many other active coaches the client has.

-- ---------------------------------------------------------------------------
-- Owner access
-- ---------------------------------------------------------------------------

create table if not exists public.platform_admins (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from public, anon, authenticated;
grant all on public.platform_admins to service_role;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.marketplace_require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'Platform owner access is required' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

create or replace function public.marketplace_list_valid(p_items text[], p_max_count integer, p_max_len integer)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_items is not null
    and coalesce(cardinality(p_items), 0) <= p_max_count
    and not exists (select 1 from unnest(p_items) item where item is null or char_length(btrim(item)) = 0 or char_length(item) > p_max_len);
$$;

-- Trims, collapses spaces, drops empty and repeated (case-insensitive) items and checks the limits.
create or replace function public.marketplace_clean_list(p_items text[], p_max_count integer, p_max_len integer, p_label text, p_lower boolean default false)
returns text[]
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_out text[] := '{}';
  v_seen text[] := '{}';
  v_item text;
  v_key text;
begin
  foreach v_item in array coalesce(p_items, '{}') loop
    v_item := regexp_replace(btrim(coalesce(v_item, '')), '\s+', ' ', 'g');
    continue when v_item = '';
    if char_length(v_item) > p_max_len then
      raise exception '% entries can have up to % characters', p_label, p_max_len;
    end if;
    if p_lower then
      v_item := lower(v_item);
    end if;
    v_key := lower(v_item);
    continue when v_key = any (v_seen);
    v_seen := v_seen || v_key;
    v_out := v_out || v_item;
  end loop;
  if cardinality(v_out) > p_max_count then
    raise exception 'Add up to % %', p_max_count, lower(p_label);
  end if;
  return v_out;
end;
$$;

-- The name people see for a coach: brand name, then full name.
create or replace function public.marketplace_display_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select left(coalesce(nullif(btrim(p.brand_name), ''), nullif(btrim(p.full_name), ''), ''), 80) from public.profiles p where p.id = p_user;
$$;

-- "Sara A.": first name and the initial of the next word, so a review never shows a full name.
create or replace function public.marketplace_short_name(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_rest text;
begin
  select btrim(coalesce(full_name, '')) into v_name from public.profiles where id = p_user;
  if coalesce(v_name, '') = '' then
    return '';
  end if;
  v_rest := btrim(substr(v_name, position(' ' in v_name) + 1));
  if position(' ' in v_name) = 0 or v_rest = '' then
    return left(v_name, 40);
  end if;
  return left(split_part(v_name, ' ', 1), 40) || ' ' || upper(left(v_rest, 1)) || '.';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.coach_marketplace_profiles (
  coach_id uuid primary key references public.profiles (id) on delete cascade,
  is_listed boolean not null default false,
  accepting_clients boolean not null default true,
  headline text not null default '' check (char_length(headline) <= 120),
  bio text not null default '' check (char_length(bio) <= 2000),
  specialties text[] not null default '{}' check (public.marketplace_list_valid(specialties, 10, 40)),
  languages text[] not null default '{}' check (
    public.marketplace_list_valid(languages, 8, 2) and array_to_string(languages, ',') ~ '^([a-z]{2}(,[a-z]{2})*)?$'
  ),
  certifications text[] not null default '{}' check (public.marketplace_list_valid(certifications, 10, 80)),
  years_experience smallint check (years_experience is null or years_experience between 0 and 60),
  city text not null default '' check (char_length(city) <= 80),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  training_mode text not null default 'online' check (training_mode in ('online', 'in_person', 'both')),
  intro_video_url text check (intro_video_url is null or (char_length(intro_video_url) <= 500 and public.exercise_video_url_valid(intro_video_url))),
  is_hidden boolean not null default false,
  hidden_reason text check (hidden_reason is null or char_length(hidden_reason) <= 500),
  hidden_at timestamptz,
  hidden_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coach_marketplace_listed_idx on public.coach_marketplace_profiles (country_code) where is_listed and not is_hidden;

create table if not exists public.coach_reviews (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text not null default '' check (char_length(comment) <= 1000),
  coach_reply text check (coach_reply is null or char_length(btrim(coach_reply)) between 1 and 1000),
  coach_reply_at timestamptz,
  is_hidden boolean not null default false,
  hidden_reason text check (hidden_reason is null or char_length(hidden_reason) <= 500),
  hidden_at timestamptz,
  hidden_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (coach_id, client_id),
  check (coach_id <> client_id)
);

create index if not exists coach_reviews_coach_idx on public.coach_reviews (coach_id, created_at desc) where not is_hidden;

create table if not exists public.marketplace_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles (id) on delete cascade,
  target_type text not null check (target_type in ('coach', 'review')),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  review_id uuid references public.coach_reviews (id) on delete cascade,
  reason text not null check (reason in ('spam', 'misleading', 'inappropriate', 'harassment', 'fake', 'other')),
  details text not null default '' check (char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 500),
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check ((target_type = 'coach' and review_id is null) or (target_type = 'review' and review_id is not null))
);

-- One report per person and target, whatever happened to the earlier one.
create unique index if not exists marketplace_reports_coach_once_idx on public.marketplace_reports (reporter_id, coach_id) where target_type = 'coach';
create unique index if not exists marketplace_reports_review_once_idx on public.marketplace_reports (reporter_id, review_id) where target_type = 'review';
create index if not exists marketplace_reports_status_idx on public.marketplace_reports (status, created_at);

create table if not exists public.coach_contact_requests (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles (id) on delete cascade,
  client_id uuid not null references public.profiles (id) on delete cascade,
  message text not null check (char_length(btrim(message)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  -- Kept only to fill the coach-client link when the coach accepts. Never returned by any function.
  requester_email text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (coach_id <> client_id)
);

create unique index if not exists coach_contact_requests_open_idx on public.coach_contact_requests (coach_id, client_id) where status = 'pending';
create index if not exists coach_contact_requests_client_idx on public.coach_contact_requests (client_id, created_at desc);
create index if not exists coach_contact_requests_coach_idx on public.coach_contact_requests (coach_id, status, created_at desc);

create table if not exists public.marketplace_moderation_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles (id) on delete set null,
  action text not null check (char_length(action) <= 40),
  target_type text not null check (target_type in ('coach', 'review', 'report')),
  coach_id uuid,
  review_id uuid,
  report_id uuid,
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

alter table public.coach_marketplace_profiles enable row level security;
alter table public.coach_reviews enable row level security;
alter table public.marketplace_reports enable row level security;
alter table public.coach_contact_requests enable row level security;
alter table public.marketplace_moderation_log enable row level security;

revoke all on public.coach_marketplace_profiles, public.coach_reviews, public.marketplace_reports,
  public.coach_contact_requests, public.marketplace_moderation_log from public, anon, authenticated;
grant all on public.coach_marketplace_profiles, public.coach_reviews, public.marketplace_reports,
  public.coach_contact_requests, public.marketplace_moderation_log to service_role;

-- ---------------------------------------------------------------------------
-- Who is listed
-- ---------------------------------------------------------------------------

create or replace function public.marketplace_coach_visible(p_coach_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.coach_marketplace_profiles m
    join public.profiles p on p.id = m.coach_id
    where m.coach_id = p_coach_id
      and m.is_listed
      and not m.is_hidden
      and p.role = 'coach'
      and public.workflow_coach_is_active(p.id)
      and not exists (select 1 from public.coach_team_members t where t.trainer_user_id = p.id and t.status = 'active')
  );
$$;

-- Review totals of one coach (hidden reviews do not count).
create or replace function public.marketplace_rating(p_coach_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'rating_avg', coalesce(round(avg(r.rating)::numeric, 1), 0),
    'rating_count', count(*)::integer,
    'distribution', jsonb_build_object(
      '1', count(*) filter (where r.rating = 1), '2', count(*) filter (where r.rating = 2), '3', count(*) filter (where r.rating = 3),
      '4', count(*) filter (where r.rating = 4), '5', count(*) filter (where r.rating = 5)
    )
  )
  from public.coach_reviews r
  where r.coach_id = p_coach_id and not r.is_hidden;
$$;

-- ---------------------------------------------------------------------------
-- The coach's own profile
-- ---------------------------------------------------------------------------

create or replace function public.get_my_marketplace_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_row public.coach_marketplace_profiles%rowtype;
  v_found boolean;
  v_reasons text[];
begin
  if v_me is null or not exists (select 1 from public.profiles where id = v_me and role = 'coach') then
    raise exception 'A coach account is required' using errcode = '42501';
  end if;
  select * into v_row from public.coach_marketplace_profiles where coach_id = v_me;
  v_found := found;
  v_reasons := array_remove(array[
    case when not coalesce(v_row.is_listed, false) then 'not_listed' end,
    case when coalesce(v_row.is_hidden, false) then 'hidden_by_moderation' end,
    case when not public.workflow_coach_is_active(v_me) then 'subscription_inactive' end,
    case when exists (select 1 from public.coach_team_members t where t.trainer_user_id = v_me and t.status = 'active') then 'assistant_trainer' end
  ], null);
  return jsonb_build_object(
    'coach_id', v_me,
    'exists', v_found,
    'display_name', public.marketplace_display_name(v_me),
    'avatar_path', (select avatar_path from public.profiles where id = v_me),
    'is_listed', coalesce(v_row.is_listed, false),
    'accepting_clients', coalesce(v_row.accepting_clients, true),
    'headline', coalesce(v_row.headline, ''),
    'bio', coalesce(v_row.bio, ''),
    'specialties', to_jsonb(coalesce(v_row.specialties, '{}'::text[])),
    'languages', to_jsonb(coalesce(v_row.languages, '{}'::text[])),
    'certifications', to_jsonb(coalesce(v_row.certifications, '{}'::text[])),
    'years_experience', v_row.years_experience,
    'city', coalesce(v_row.city, ''),
    'country_code', v_row.country_code,
    'training_mode', coalesce(v_row.training_mode, 'online'),
    'intro_video_url', v_row.intro_video_url,
    'is_hidden', coalesce(v_row.is_hidden, false),
    'hidden_reason', v_row.hidden_reason,
    'visible', coalesce(array_length(v_reasons, 1), 0) = 0,
    'hidden_reasons', to_jsonb(v_reasons),
    'pending_requests', (select count(*)::integer from public.coach_contact_requests where coach_id = v_me and status = 'pending')
  ) || public.marketplace_rating(v_me);
end;
$$;

create or replace function public.save_my_marketplace_profile(
  p_is_listed boolean,
  p_accepting_clients boolean,
  p_headline text,
  p_bio text,
  p_specialties text[],
  p_languages text[],
  p_certifications text[],
  p_years_experience integer,
  p_city text,
  p_country_code text,
  p_training_mode text,
  p_intro_video_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_headline text := btrim(coalesce(p_headline, ''));
  v_bio text := btrim(coalesce(p_bio, ''));
  v_city text := regexp_replace(btrim(coalesce(p_city, '')), '\s+', ' ', 'g');
  v_country text := nullif(upper(btrim(coalesce(p_country_code, ''))), '');
  v_mode text := coalesce(nullif(btrim(coalesce(p_training_mode, '')), ''), 'online');
  v_video text := nullif(btrim(coalesce(p_intro_video_url, '')), '');
  v_specialties text[];
  v_languages text[];
  v_certifications text[];
begin
  if v_me is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to edit the marketplace profile' using errcode = '42501';
  end if;
  if exists (select 1 from public.coach_team_members t where t.trainer_user_id = v_me and t.status = 'active') then
    raise exception 'Assistant trainers cannot publish a marketplace profile' using errcode = '42501';
  end if;
  if char_length(v_headline) > 120 then
    raise exception 'The headline can have up to 120 characters';
  end if;
  if char_length(v_bio) > 2000 then
    raise exception 'The bio can have up to 2000 characters';
  end if;
  if char_length(v_city) > 80 then
    raise exception 'The city can have up to 80 characters';
  end if;
  if v_mode not in ('online', 'in_person', 'both') then
    raise exception 'Choose online, in person or both';
  end if;
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    raise exception 'Choose a valid country';
  end if;
  if p_years_experience is not null and p_years_experience not between 0 and 60 then
    raise exception 'Years of experience must be between 0 and 60';
  end if;
  if v_video is not null and (char_length(v_video) > 500 or not public.exercise_video_url_valid(v_video)) then
    raise exception 'The intro video must be an https link to YouTube, Vimeo or an MP4/WebM file';
  end if;
  v_specialties := public.marketplace_clean_list(p_specialties, 10, 40, 'Specialty');
  v_languages := public.marketplace_clean_list(p_languages, 8, 2, 'Language', true);
  v_certifications := public.marketplace_clean_list(p_certifications, 10, 80, 'Certification');
  if array_to_string(v_languages, ',') !~ '^([a-z]{2}(,[a-z]{2})*)?$' then
    raise exception 'Languages must be two-letter codes';
  end if;
  if coalesce(p_is_listed, false) and (
    char_length(v_headline) < 10 or char_length(v_bio) < 30 or cardinality(v_specialties) = 0 or cardinality(v_languages) = 0 or v_country is null
  ) then
    raise exception 'Complete your profile before listing it: headline, bio, a specialty, a language and a country';
  end if;

  insert into public.coach_marketplace_profiles (
    coach_id, is_listed, accepting_clients, headline, bio, specialties, languages, certifications,
    years_experience, city, country_code, training_mode, intro_video_url
  ) values (
    v_me, coalesce(p_is_listed, false), coalesce(p_accepting_clients, true), v_headline, v_bio, v_specialties, v_languages, v_certifications,
    p_years_experience, v_city, v_country, v_mode, v_video
  )
  on conflict (coach_id) do update set
    is_listed = excluded.is_listed,
    accepting_clients = excluded.accepting_clients,
    headline = excluded.headline,
    bio = excluded.bio,
    specialties = excluded.specialties,
    languages = excluded.languages,
    certifications = excluded.certifications,
    years_experience = excluded.years_experience,
    city = excluded.city,
    country_code = excluded.country_code,
    training_mode = excluded.training_mode,
    intro_video_url = excluded.intro_video_url,
    updated_at = statement_timestamp();

  return public.get_my_marketplace_profile();
end;
$$;

-- ---------------------------------------------------------------------------
-- Searching and reading public profiles (signed-in people only)
-- ---------------------------------------------------------------------------

create or replace function public.search_marketplace_coaches(
  p_query text default null,
  p_specialty text default null,
  p_language text default null,
  p_country text default null,
  p_city text default null,
  p_mode text default null,
  p_min_rating numeric default null,
  p_accepting_only boolean default false,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_specialty text := lower(btrim(coalesce(p_specialty, '')));
  v_language text := lower(btrim(coalesce(p_language, '')));
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_city text := lower(btrim(coalesce(p_city, '')));
  v_mode text := lower(btrim(coalesce(p_mode, '')));
  v_min numeric := greatest(0, least(coalesce(p_min_rating, 0), 5));
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if v_mode not in ('', 'online', 'in_person') then
    raise exception 'Unsupported training mode';
  end if;
  return (
    with base as (
      select m.coach_id, public.marketplace_display_name(m.coach_id) as display_name, p.avatar_path, m.headline, m.bio, m.specialties,
             m.languages, m.country_code, m.city, m.training_mode, m.years_experience, m.accepting_clients, m.intro_video_url,
             coalesce(r.avg_rating, 0) as rating_avg, coalesce(r.total, 0) as rating_count
      from public.coach_marketplace_profiles m
      join public.profiles p on p.id = m.coach_id
      left join lateral (
        select round(avg(cr.rating)::numeric, 1) as avg_rating, count(*)::integer as total
        from public.coach_reviews cr where cr.coach_id = m.coach_id and not cr.is_hidden
      ) r on true
      where public.marketplace_coach_visible(m.coach_id)
        and (not coalesce(p_accepting_only, false) or m.accepting_clients)
        and (v_country = '' or m.country_code = v_country)
        and (v_city = '' or position(v_city in lower(m.city)) > 0)
        and (v_language = '' or v_language = any (m.languages))
        and (v_specialty = '' or exists (select 1 from unnest(m.specialties) s where lower(s) = v_specialty))
        and (v_mode = '' or m.training_mode in (v_mode, 'both'))
        and (v_min = 0 or coalesce(r.avg_rating, 0) >= v_min)
        and (
          v_query = ''
          or position(v_query in lower(public.marketplace_display_name(m.coach_id) || ' ' || m.headline || ' ' || m.bio || ' ' || array_to_string(m.specialties, ' ') || ' ' || m.city)) > 0
        )
    ), page as (
      select b.*, row_number() over (order by b.accepting_clients desc, b.rating_avg desc, b.rating_count desc, lower(b.display_name), b.coach_id) as rank_no
      from base b
      order by b.accepting_clients desc, b.rating_avg desc, b.rating_count desc, lower(b.display_name), b.coach_id
      limit v_limit offset v_offset
    )
    select jsonb_build_object(
      'total', (select count(*)::integer from base),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'coach_id', pg.coach_id, 'display_name', pg.display_name, 'avatar_path', pg.avatar_path, 'headline', pg.headline,
          'summary', left(pg.bio, 220), 'specialties', to_jsonb(pg.specialties), 'languages', to_jsonb(pg.languages),
          'country_code', pg.country_code, 'city', pg.city, 'training_mode', pg.training_mode, 'years_experience', pg.years_experience,
          'accepting_clients', pg.accepting_clients, 'rating_avg', pg.rating_avg, 'rating_count', pg.rating_count,
          'has_intro_video', pg.intro_video_url is not null
        ) order by pg.rank_no)
        from page pg
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.get_marketplace_coach(p_coach_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_row public.coach_marketplace_profiles%rowtype;
  v_link public.coach_clients%rowtype;
  v_linked boolean;
  v_review public.coach_reviews%rowtype;
  v_has_review boolean;
  v_request public.coach_contact_requests%rowtype;
  v_has_request boolean;
  v_is_client boolean;
  v_used integer;
begin
  if v_me is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_coach_id is null or not public.marketplace_coach_visible(p_coach_id) then
    return null;
  end if;
  select * into v_row from public.coach_marketplace_profiles where coach_id = p_coach_id;
  v_is_client := public.is_client_account();
  select * into v_link from public.coach_clients where coach_id = p_coach_id and client_id = v_me;
  v_linked := found;
  select * into v_review from public.coach_reviews where coach_id = p_coach_id and client_id = v_me;
  v_has_review := found;
  select * into v_request from public.coach_contact_requests where coach_id = p_coach_id and client_id = v_me and status = 'pending';
  v_has_request := found;
  select count(*)::integer into v_used from public.coach_contact_requests where client_id = v_me and created_at > statement_timestamp() - interval '24 hours';

  return jsonb_build_object(
    'coach_id', p_coach_id,
    'display_name', public.marketplace_display_name(p_coach_id),
    'avatar_path', (select avatar_path from public.profiles where id = p_coach_id),
    'headline', v_row.headline,
    'bio', v_row.bio,
    'specialties', to_jsonb(v_row.specialties),
    'languages', to_jsonb(v_row.languages),
    'certifications', to_jsonb(v_row.certifications),
    'years_experience', v_row.years_experience,
    'city', v_row.city,
    'country_code', v_row.country_code,
    'training_mode', v_row.training_mode,
    'intro_video_url', v_row.intro_video_url,
    'accepting_clients', v_row.accepting_clients,
    'is_self', v_me = p_coach_id,
    'viewer', jsonb_build_object(
      'is_client', v_is_client,
      'is_linked', v_linked and v_link.status = 'active',
      'can_review', v_is_client and v_linked and v_link.created_at <= statement_timestamp() - interval '14 days',
      'review_eligible_at', case when v_is_client and v_linked then v_link.created_at + interval '14 days' end,
      'my_review', case when v_has_review then jsonb_build_object(
        'id', v_review.id, 'rating', v_review.rating, 'comment', v_review.comment, 'is_hidden', v_review.is_hidden,
        'updated_at', v_review.updated_at, 'coach_reply', v_review.coach_reply) end,
      'pending_request', case when v_has_request then jsonb_build_object('id', v_request.id, 'created_at', v_request.created_at) end,
      'requests_left', greatest(0, 3 - v_used),
      'reported_coach', exists (select 1 from public.marketplace_reports where reporter_id = v_me and target_type = 'coach' and coach_id = p_coach_id)
    )
  ) || public.marketplace_rating(p_coach_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------------

create or replace function public.list_coach_reviews(p_coach_id uuid, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if v_me is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_coach_id is null or not (public.marketplace_coach_visible(p_coach_id) or v_me = p_coach_id) then
    return jsonb_build_object('total', 0, 'items', '[]'::jsonb) || public.marketplace_rating(null);
  end if;
  return jsonb_build_object(
    'total', (select count(*)::integer from public.coach_reviews where coach_id = p_coach_id and not is_hidden),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'rating', r.rating, 'comment', r.comment, 'created_at', r.created_at, 'updated_at', r.updated_at,
        'reviewer_name', public.marketplace_short_name(r.client_id), 'coach_reply', r.coach_reply, 'coach_reply_at', r.coach_reply_at,
        'is_mine', r.client_id = v_me,
        'reported_by_me', exists (select 1 from public.marketplace_reports mr where mr.reporter_id = v_me and mr.review_id = r.id)
      ) order by r.created_at desc, r.id)
      from (
        select * from public.coach_reviews
        where coach_id = p_coach_id and not is_hidden
        order by created_at desc, id
        limit v_limit offset v_offset
      ) r
    ), '[]'::jsonb)
  ) || public.marketplace_rating(p_coach_id);
end;
$$;

-- Creates the client's review of a coach, or edits it (one review per client and coach).
create or replace function public.submit_coach_review(p_coach_id uuid, p_rating integer, p_comment text default '')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_comment text := btrim(coalesce(p_comment, ''));
  v_link public.coach_clients%rowtype;
  v_id uuid;
begin
  if v_me is null or not public.is_client_account() then
    raise exception 'A client account is required to review a coach' using errcode = '42501';
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'Choose a rating from 1 to 5';
  end if;
  if char_length(v_comment) > 1000 then
    raise exception 'A review can have up to 1000 characters';
  end if;
  if not exists (select 1 from public.profiles where id = p_coach_id and role = 'coach') then
    raise exception 'Coach was not found' using errcode = 'P0002';
  end if;
  select * into v_link from public.coach_clients where coach_id = p_coach_id and client_id = v_me;
  if not found then
    raise exception 'You can review a coach you have trained with for at least 14 days' using errcode = '42501';
  end if;
  if v_link.created_at > statement_timestamp() - interval '14 days' then
    raise exception 'You can review this coach after 14 days of training together' using errcode = '42501';
  end if;

  insert into public.coach_reviews (coach_id, client_id, rating, comment)
  values (p_coach_id, v_me, p_rating, v_comment)
  on conflict (coach_id, client_id) do update
    set rating = excluded.rating, comment = excluded.comment, updated_at = statement_timestamp()
  returning id into v_id;
  return v_id;
end;
$$;

-- The one public reply a coach may add to a review about them. It cannot be edited or removed.
create or replace function public.reply_to_coach_review(p_review_id uuid, p_reply text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_reply text := btrim(coalesce(p_reply, ''));
  v_review public.coach_reviews%rowtype;
begin
  if v_me is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to reply' using errcode = '42501';
  end if;
  if char_length(v_reply) not between 1 and 1000 then
    raise exception 'A reply needs 1 to 1000 characters';
  end if;
  select * into v_review from public.coach_reviews where id = p_review_id and coach_id = v_me and not is_hidden for update;
  if not found then
    raise exception 'Review was not found' using errcode = 'P0002';
  end if;
  if v_review.coach_reply is not null then
    raise exception 'You already replied to this review';
  end if;
  update public.coach_reviews set coach_reply = v_reply, coach_reply_at = statement_timestamp() where id = p_review_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create or replace function public.report_marketplace(p_target_type text, p_target_id uuid, p_reason text, p_details text default '')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_details text := btrim(coalesce(p_details, ''));
  v_coach uuid;
  v_review public.coach_reviews%rowtype;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_target_type not in ('coach', 'review') then
    raise exception 'Unsupported report target';
  end if;
  if p_reason is null or p_reason not in ('spam', 'misleading', 'inappropriate', 'harassment', 'fake', 'other') then
    raise exception 'Choose a reason for the report';
  end if;
  if char_length(v_details) > 500 then
    raise exception 'The details can have up to 500 characters';
  end if;

  if p_target_type = 'coach' then
    v_coach := p_target_id;
    if v_coach = v_me then
      raise exception 'You cannot report yourself';
    end if;
    if not public.marketplace_coach_visible(v_coach) then
      raise exception 'Coach was not found' using errcode = 'P0002';
    end if;
  else
    select * into v_review from public.coach_reviews where id = p_target_id and not is_hidden;
    if not found or not (public.marketplace_coach_visible(v_review.coach_id) or v_review.coach_id = v_me) then
      raise exception 'Review was not found' using errcode = 'P0002';
    end if;
    if v_review.client_id = v_me then
      raise exception 'You cannot report your own review';
    end if;
    v_coach := v_review.coach_id;
  end if;

  perform pg_advisory_xact_lock(hashtext('marketplace-report:' || v_me::text));
  if (select count(*) from public.marketplace_reports where reporter_id = v_me and created_at > statement_timestamp() - interval '24 hours') >= 10 then
    raise exception 'You sent too many reports today. Try again tomorrow';
  end if;

  begin
    insert into public.marketplace_reports (reporter_id, target_type, coach_id, review_id, reason, details)
    values (v_me, p_target_type, v_coach, case when p_target_type = 'review' then p_target_id end, p_reason, v_details)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'You already reported this';
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contact requests
-- ---------------------------------------------------------------------------

create or replace function public.send_contact_request(p_coach_id uuid, p_message text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_message text := btrim(coalesce(p_message, ''));
  v_used integer;
  v_id uuid;
  v_name text;
begin
  if v_me is null or not public.is_client_account() then
    raise exception 'A client account is required to contact a coach' using errcode = '42501';
  end if;
  if char_length(v_message) not between 1 and 500 then
    raise exception 'Write a message of up to 500 characters';
  end if;
  if p_coach_id is null or not public.marketplace_coach_visible(p_coach_id) then
    raise exception 'This coach is not available' using errcode = 'P0002';
  end if;
  if not (select accepting_clients from public.coach_marketplace_profiles where coach_id = p_coach_id) then
    raise exception 'This coach is not accepting new clients right now';
  end if;
  if exists (select 1 from public.coach_clients where coach_id = p_coach_id and client_id = v_me and status = 'active') then
    raise exception 'You already train with this coach';
  end if;

  perform pg_advisory_xact_lock(hashtext('marketplace-request:' || v_me::text));
  if exists (select 1 from public.coach_contact_requests where coach_id = p_coach_id and client_id = v_me and status = 'pending') then
    raise exception 'You already have an open request to this coach';
  end if;
  select count(*)::integer into v_used from public.coach_contact_requests where client_id = v_me and created_at > statement_timestamp() - interval '24 hours';
  if v_used >= 3 then
    raise exception 'You can send up to 3 contact requests a day. Try again tomorrow';
  end if;

  insert into public.coach_contact_requests (coach_id, client_id, message, requester_email)
  values (p_coach_id, v_me, v_message, nullif(auth.jwt() ->> 'email', ''))
  returning id into v_id;

  v_name := coalesce(nullif(btrim((select full_name from public.profiles where id = v_me)), ''), '');
  perform public.create_notification(
    p_coach_id, 'marketplace_request',
    jsonb_build_object('client_name', v_name, 'request_id', v_id),
    '/marketplace', 'mkt-request:' || v_id::text
  );
  return jsonb_build_object('id', v_id, 'requests_left', greatest(0, 3 - v_used - 1));
end;
$$;

create or replace function public.cancel_contact_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.coach_contact_requests set status = 'cancelled', responded_at = statement_timestamp()
  where id = p_request_id and client_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'Request was not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.list_my_contact_requests()
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
    select jsonb_agg(jsonb_build_object(
      'id', q.id, 'coach_id', q.coach_id, 'coach_name', public.marketplace_display_name(q.coach_id),
      'avatar_path', (select avatar_path from public.profiles where id = q.coach_id),
      'message', q.message, 'status', q.status, 'created_at', q.created_at, 'responded_at', q.responded_at
    ) order by q.created_at desc)
    from (
      select * from public.coach_contact_requests where client_id = auth.uid() order by created_at desc limit 30
    ) q
  ), '[]'::jsonb);
end;
$$;

-- What a coach sees: the client's name and message. The e-mail stays hidden; the client id is shown only after accepting.
create or replace function public.list_coach_contact_requests(p_status text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null or not public.is_active_coach() then
    raise exception 'An active coach account is required' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending', 'accepted', 'declined', 'cancelled') then
    raise exception 'Unsupported status';
  end if;
  return jsonb_build_object(
    'pending_count', (select count(*)::integer from public.coach_contact_requests where coach_id = v_me and status = 'pending'),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'client_name', coalesce(nullif(btrim((select full_name from public.profiles where id = q.client_id)), ''), ''),
        'message', q.message, 'status', q.status, 'created_at', q.created_at, 'responded_at', q.responded_at,
        'client_id', case when q.status = 'accepted' then q.client_id end
      ) order by (q.status <> 'pending'), q.created_at desc)
      from (
        select * from public.coach_contact_requests
        where coach_id = v_me and (p_status is null or status = p_status)
        order by created_at desc limit 50
      ) q
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.respond_contact_request(p_request_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_request public.coach_contact_requests%rowtype;
  v_coach_name text;
  v_client_name text;
  v_link public.coach_clients%rowtype;
  v_already boolean := false;
  v_others integer;
begin
  if v_me is null or not public.is_active_coach() then
    raise exception 'An active coach account is required to answer requests' using errcode = '42501';
  end if;
  select * into v_request from public.coach_contact_requests where id = p_request_id and coach_id = v_me for update;
  if not found then
    raise exception 'Request was not found' using errcode = 'P0002';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request was already answered';
  end if;
  v_coach_name := public.marketplace_display_name(v_me);

  if not coalesce(p_accept, false) then
    update public.coach_contact_requests set status = 'declined', responded_at = statement_timestamp() where id = p_request_id;
    perform public.create_notification(
      v_request.client_id, 'marketplace_declined',
      jsonb_build_object('coach_name', v_coach_name, 'request_id', p_request_id), '/coaches', 'mkt-declined:' || p_request_id::text
    );
    return jsonb_build_object('request_id', p_request_id, 'status', 'declined');
  end if;

  if not exists (select 1 from public.profiles where id = v_request.client_id and role = 'client') then
    raise exception 'This client account is no longer available';
  end if;
  v_client_name := coalesce(nullif(btrim((select full_name from public.profiles where id = v_request.client_id)), ''), '');

  select * into v_link from public.coach_clients where coach_id = v_me and client_id = v_request.client_id for update;
  if found then
    v_already := v_link.status = 'active';
    update public.coach_clients set status = 'active' where coach_id = v_me and client_id = v_request.client_id;
  else
    insert into public.coach_clients (coach_id, client_id, client_email, client_name, coach_email, coach_name)
    values (v_me, v_request.client_id, v_request.requester_email, nullif(v_client_name, ''), nullif(auth.jwt() ->> 'email', ''), nullif(v_coach_name, ''));
  end if;
  select count(*)::integer into v_others from public.coach_clients where client_id = v_request.client_id and coach_id <> v_me and status = 'active';

  update public.coach_contact_requests set status = 'accepted', responded_at = statement_timestamp() where id = p_request_id;
  perform public.create_notification(
    v_request.client_id, 'marketplace_accepted',
    jsonb_build_object('coach_name', v_coach_name, 'coach_id', v_me, 'request_id', p_request_id), '/coach-hub', 'mkt-accepted:' || p_request_id::text
  );
  perform public.create_notification(
    v_me, 'marketplace_linked',
    jsonb_build_object('client_name', v_client_name, 'client_id', v_request.client_id, 'request_id', p_request_id),
    '/messages?with=' || v_request.client_id::text, 'mkt-linked:' || p_request_id::text
  );
  return jsonb_build_object(
    'request_id', p_request_id, 'status', 'accepted', 'client_id', v_request.client_id,
    'already_linked', v_already, 'other_active_coaches', v_others, 'chat_path', '/messages?with=' || v_request.client_id::text
  );
end;
$$;

-- Used by /api/push (with the caller's own session) to find the person to notify, so a browser can never push to
-- someone it has no business with: 'request' is only for the client who sent it, 'accepted' only for the coach who accepted.
create or replace function public.marketplace_push_target(p_request_id uuid, p_event text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.coach_contact_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into v_request from public.coach_contact_requests where id = p_request_id;
  if not found then
    return null;
  end if;
  if p_event = 'request' and v_request.client_id = auth.uid() and v_request.status = 'pending' then
    return v_request.coach_id;
  end if;
  if p_event = 'accepted' and v_request.coach_id = auth.uid() and v_request.status = 'accepted' then
    return v_request.client_id;
  end if;
  return null;
end;
$$;

-- In-app notification kinds for the events above.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'message', 'checkin_submitted', 'checkin_reviewed', 'invoice_new', 'invoice_reported', 'invoice_paid', 'progression', 'reminder',
  'marketplace_request', 'marketplace_accepted', 'marketplace_declined', 'marketplace_linked'
));

-- ---------------------------------------------------------------------------
-- Owner moderation (every function starts by checking platform_admins)
-- ---------------------------------------------------------------------------

create or replace function public.admin_list_marketplace_reports(p_status text default 'open', p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_status text := coalesce(p_status, 'open');
begin
  perform public.marketplace_require_admin();
  if v_status not in ('open', 'resolved', 'dismissed', 'all') then
    raise exception 'Unsupported status';
  end if;
  return jsonb_build_object(
    'open_count', (select count(*)::integer from public.marketplace_reports where status = 'open'),
    'total', (select count(*)::integer from public.marketplace_reports where v_status = 'all' or status = v_status),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'target_type', r.target_type, 'status', r.status, 'reason', r.reason, 'details', r.details, 'created_at', r.created_at,
        'reporter_name', coalesce(nullif(btrim((select full_name from public.profiles where id = r.reporter_id)), ''), ''),
        'coach_id', r.coach_id, 'coach_name', public.marketplace_display_name(r.coach_id),
        'coach_is_hidden', coalesce((select m.is_hidden from public.coach_marketplace_profiles m where m.coach_id = r.coach_id), false),
        'review_id', r.review_id,
        'review_rating', (select rv.rating from public.coach_reviews rv where rv.id = r.review_id),
        'review_comment', (select rv.comment from public.coach_reviews rv where rv.id = r.review_id),
        'review_is_hidden', (select rv.is_hidden from public.coach_reviews rv where rv.id = r.review_id),
        'resolution_note', r.resolution_note, 'resolved_at', r.resolved_at
      ) order by (case when v_status = 'open' then r.created_at end) asc nulls last, r.created_at desc)
      from (
        select * from public.marketplace_reports
        where v_status = 'all' or status = v_status
        order by (case when v_status = 'open' then created_at end) asc nulls last, created_at desc
        limit v_limit offset v_offset
      ) r
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.admin_list_marketplace_coaches(p_query text default null, p_state text default 'all', p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_state text := coalesce(p_state, 'all');
begin
  perform public.marketplace_require_admin();
  if v_state not in ('all', 'listed', 'hidden') then
    raise exception 'Unsupported state';
  end if;
  return (
    with base as (
      select m.*, public.marketplace_display_name(m.coach_id) as display_name
      from public.coach_marketplace_profiles m
      where (v_state = 'all' or (v_state = 'listed' and m.is_listed) or (v_state = 'hidden' and m.is_hidden))
        and (v_query = '' or position(v_query in lower(public.marketplace_display_name(m.coach_id) || ' ' || m.headline)) > 0)
    )
    select jsonb_build_object(
      'total', (select count(*)::integer from base),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'coach_id', b.coach_id, 'display_name', b.display_name, 'headline', b.headline, 'is_listed', b.is_listed, 'is_hidden', b.is_hidden,
          'hidden_reason', b.hidden_reason, 'visible', public.marketplace_coach_visible(b.coach_id), 'country_code', b.country_code, 'city', b.city,
          'open_reports', (select count(*)::integer from public.marketplace_reports r where r.coach_id = b.coach_id and r.status = 'open'),
          'rating_avg', (public.marketplace_rating(b.coach_id) ->> 'rating_avg')::numeric,
          'rating_count', (public.marketplace_rating(b.coach_id) ->> 'rating_count')::integer,
          'updated_at', b.updated_at
        ) order by b.is_hidden desc, b.updated_at desc, b.coach_id)
        from (select * from base order by is_hidden desc, updated_at desc, coach_id limit v_limit offset v_offset) b
      ), '[]'::jsonb)
    )
  );
end;
$$;

create or replace function public.admin_list_coach_reviews(p_coach_id uuid, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  perform public.marketplace_require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'rating', r.rating, 'comment', r.comment, 'created_at', r.created_at, 'coach_reply', r.coach_reply,
      'reviewer_name', public.marketplace_short_name(r.client_id), 'is_hidden', r.is_hidden, 'hidden_reason', r.hidden_reason
    ) order by r.created_at desc, r.id)
    from (
      select * from public.coach_reviews where coach_id = p_coach_id order by created_at desc, id limit v_limit offset v_offset
    ) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.marketplace_log_moderation(p_admin uuid, p_action text, p_target_type text, p_coach uuid, p_review uuid, p_report uuid, p_reason text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.marketplace_moderation_log (admin_id, action, target_type, coach_id, review_id, report_id, reason)
  values (p_admin, p_action, p_target_type, p_coach, p_review, p_report, nullif(p_reason, ''));
$$;

create or replace function public.admin_set_coach_hidden(p_coach_id uuid, p_hidden boolean, p_reason text, p_report_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := public.marketplace_require_admin();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_closed integer := 0;
begin
  if coalesce(p_hidden, false) and char_length(v_reason) < 3 then
    raise exception 'Write the reason for hiding this profile';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason can have up to 500 characters';
  end if;
  if p_report_id is not null and not exists (
    select 1 from public.marketplace_reports where id = p_report_id and target_type = 'coach' and coach_id = p_coach_id
  ) then
    raise exception 'That report is not about this coach';
  end if;
  update public.coach_marketplace_profiles
  set is_hidden = coalesce(p_hidden, false),
      hidden_reason = case when coalesce(p_hidden, false) then v_reason end,
      hidden_at = case when coalesce(p_hidden, false) then statement_timestamp() end,
      hidden_by = case when coalesce(p_hidden, false) then v_admin end,
      updated_at = statement_timestamp()
  where coach_id = p_coach_id;
  if not found then
    raise exception 'Marketplace profile was not found' using errcode = 'P0002';
  end if;
  if p_report_id is not null then
    update public.marketplace_reports
    set status = 'resolved', resolution_note = v_reason, resolved_by = v_admin, resolved_at = statement_timestamp()
    where status = 'open' and target_type = 'coach' and coach_id = p_coach_id;
    get diagnostics v_closed = row_count;
  end if;
  perform public.marketplace_log_moderation(v_admin, case when coalesce(p_hidden, false) then 'hide_coach' else 'unhide_coach' end, 'coach', p_coach_id, null, p_report_id, v_reason);
  return jsonb_build_object('coach_id', p_coach_id, 'is_hidden', coalesce(p_hidden, false), 'reports_closed', v_closed);
end;
$$;

create or replace function public.admin_set_review_hidden(p_review_id uuid, p_hidden boolean, p_reason text, p_report_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := public.marketplace_require_admin();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_coach uuid;
  v_closed integer := 0;
begin
  if coalesce(p_hidden, false) and char_length(v_reason) < 3 then
    raise exception 'Write the reason for hiding this review';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'The reason can have up to 500 characters';
  end if;
  if p_report_id is not null and not exists (
    select 1 from public.marketplace_reports where id = p_report_id and target_type = 'review' and review_id = p_review_id
  ) then
    raise exception 'That report is not about this review';
  end if;
  update public.coach_reviews
  set is_hidden = coalesce(p_hidden, false),
      hidden_reason = case when coalesce(p_hidden, false) then v_reason end,
      hidden_at = case when coalesce(p_hidden, false) then statement_timestamp() end,
      hidden_by = case when coalesce(p_hidden, false) then v_admin end
  where id = p_review_id
  returning coach_id into v_coach;
  if not found then
    raise exception 'Review was not found' using errcode = 'P0002';
  end if;
  if p_report_id is not null then
    update public.marketplace_reports
    set status = 'resolved', resolution_note = v_reason, resolved_by = v_admin, resolved_at = statement_timestamp()
    where status = 'open' and target_type = 'review' and review_id = p_review_id;
    get diagnostics v_closed = row_count;
  end if;
  perform public.marketplace_log_moderation(v_admin, case when coalesce(p_hidden, false) then 'hide_review' else 'unhide_review' end, 'review', v_coach, p_review_id, p_report_id, v_reason);
  return jsonb_build_object('review_id', p_review_id, 'is_hidden', coalesce(p_hidden, false), 'reports_closed', v_closed);
end;
$$;

create or replace function public.admin_resolve_marketplace_report(p_report_id uuid, p_status text, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin uuid := public.marketplace_require_admin();
  v_note text := btrim(coalesce(p_note, ''));
begin
  if p_status not in ('resolved', 'dismissed') then
    raise exception 'Choose resolved or dismissed';
  end if;
  if char_length(v_note) not between 3 and 500 then
    raise exception 'Write a note of 3 to 500 characters';
  end if;
  update public.marketplace_reports
  set status = p_status, resolution_note = v_note, resolved_by = v_admin, resolved_at = statement_timestamp()
  where id = p_report_id and status = 'open';
  if not found then
    raise exception 'Open report was not found' using errcode = 'P0002';
  end if;
  perform public.marketplace_log_moderation(v_admin, 'close_report_' || p_status, 'report', null, null, p_report_id, v_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------

revoke all on function public.marketplace_require_admin() from public, anon, authenticated;
revoke all on function public.marketplace_list_valid(text[], integer, integer) from public, anon, authenticated;
revoke all on function public.marketplace_clean_list(text[], integer, integer, text, boolean) from public, anon, authenticated;
revoke all on function public.marketplace_display_name(uuid) from public, anon, authenticated;
revoke all on function public.marketplace_short_name(uuid) from public, anon, authenticated;
revoke all on function public.marketplace_coach_visible(uuid) from public, anon, authenticated;
revoke all on function public.marketplace_rating(uuid) from public, anon, authenticated;
revoke all on function public.marketplace_log_moderation(uuid, text, text, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.marketplace_list_valid(text[], integer, integer) to authenticated, service_role;

revoke all on function public.is_platform_admin() from public, anon;
revoke all on function public.get_my_marketplace_profile() from public, anon;
revoke all on function public.save_my_marketplace_profile(boolean, boolean, text, text, text[], text[], text[], integer, text, text, text, text) from public, anon;
revoke all on function public.search_marketplace_coaches(text, text, text, text, text, text, numeric, boolean, integer, integer) from public, anon;
revoke all on function public.get_marketplace_coach(uuid) from public, anon;
revoke all on function public.list_coach_reviews(uuid, integer, integer) from public, anon;
revoke all on function public.submit_coach_review(uuid, integer, text) from public, anon;
revoke all on function public.reply_to_coach_review(uuid, text) from public, anon;
revoke all on function public.report_marketplace(text, uuid, text, text) from public, anon;
revoke all on function public.send_contact_request(uuid, text) from public, anon;
revoke all on function public.cancel_contact_request(uuid) from public, anon;
revoke all on function public.list_my_contact_requests() from public, anon;
revoke all on function public.list_coach_contact_requests(text) from public, anon;
revoke all on function public.respond_contact_request(uuid, boolean) from public, anon;
revoke all on function public.marketplace_push_target(uuid, text) from public, anon;
revoke all on function public.admin_list_marketplace_reports(text, integer, integer) from public, anon;
revoke all on function public.admin_list_marketplace_coaches(text, text, integer, integer) from public, anon;
revoke all on function public.admin_list_coach_reviews(uuid, integer, integer) from public, anon;
revoke all on function public.admin_set_coach_hidden(uuid, boolean, text, uuid) from public, anon;
revoke all on function public.admin_set_review_hidden(uuid, boolean, text, uuid) from public, anon;
revoke all on function public.admin_resolve_marketplace_report(uuid, text, text) from public, anon;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.get_my_marketplace_profile() to authenticated;
grant execute on function public.save_my_marketplace_profile(boolean, boolean, text, text, text[], text[], text[], integer, text, text, text, text) to authenticated;
grant execute on function public.search_marketplace_coaches(text, text, text, text, text, text, numeric, boolean, integer, integer) to authenticated;
grant execute on function public.get_marketplace_coach(uuid) to authenticated;
grant execute on function public.list_coach_reviews(uuid, integer, integer) to authenticated;
grant execute on function public.submit_coach_review(uuid, integer, text) to authenticated;
grant execute on function public.reply_to_coach_review(uuid, text) to authenticated;
grant execute on function public.report_marketplace(text, uuid, text, text) to authenticated;
grant execute on function public.send_contact_request(uuid, text) to authenticated;
grant execute on function public.cancel_contact_request(uuid) to authenticated;
grant execute on function public.list_my_contact_requests() to authenticated;
grant execute on function public.list_coach_contact_requests(text) to authenticated;
grant execute on function public.respond_contact_request(uuid, boolean) to authenticated;
grant execute on function public.marketplace_push_target(uuid, text) to authenticated;
grant execute on function public.admin_list_marketplace_reports(text, integer, integer) to authenticated;
grant execute on function public.admin_list_marketplace_coaches(text, text, integer, integer) to authenticated;
grant execute on function public.admin_list_coach_reviews(uuid, integer, integer) to authenticated;
grant execute on function public.admin_set_coach_hidden(uuid, boolean, text, uuid) to authenticated;
grant execute on function public.admin_set_review_hidden(uuid, boolean, text, uuid) to authenticated;
grant execute on function public.admin_resolve_marketplace_report(uuid, text, text) to authenticated;
