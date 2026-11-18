-- Exercise library in several languages: translated names and steps, and a search that understands them all.

alter table public.exercises add column if not exists name_i18n jsonb not null default '{}'::jsonb;
alter table public.exercises add column if not exists instructions_i18n jsonb not null default '{}'::jsonb;
alter table public.exercises add column if not exists search_text text not null default '';

alter table public.exercises drop constraint if exists exercises_name_i18n_check;
alter table public.exercises add constraint exercises_name_i18n_check
  check (jsonb_typeof(name_i18n) = 'object' and pg_column_size(name_i18n) <= 4000);
alter table public.exercises drop constraint if exists exercises_instructions_i18n_check;
alter table public.exercises add constraint exercises_instructions_i18n_check
  check (jsonb_typeof(instructions_i18n) = 'object' and pg_column_size(instructions_i18n) <= 200000);

-- Text for searching: lower case, no accents, Arabic letters unified (alef forms, ya, ta marbuta), Arabic
-- diacritics and the leading "al-" removed, and punctuation turned into spaces. The browser applies the same
-- rules to what the user types (normalizeSearchText in src/services/exerciseI18n.js), so "push up", "Push-Up",
-- "ضغط" and "الضغط" all find the same exercise.
create or replace function public.normalize_search_text(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          translate(
            lower(coalesce(p_text, '')),
            'àâäáãåçéèêëíìîïñóòôöõúùûüýÿßÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ' || U&'\0623\0625\0622\0671\0649\0629',
            'aaaaaaceeeeiiiinooooouuuuyysaaaaaaceeeeiiiinooooouuuuy' || U&'\0627\0627\0627\0627\064A\0647'
          ),
          U&'[\064B-\0652\0640\0670]', '', 'g'
        ),
        '[-/_,.()''"+&:;!?%\\*]+', ' ', 'g'
      ),
      U&'(^| )\0627\0644(?=[^ ]{2})', '\1', 'g'
    ),
    '\s+', ' ', 'g'
  ));
$$;

create or replace function public.exercises_set_search_text()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.search_text := public.normalize_search_text(
    new.name || ' ' || case when jsonb_typeof(new.name_i18n) = 'object' then coalesce((select string_agg(value, ' ') from jsonb_each_text(new.name_i18n)), '') else '' end
  );
  return new;
end;
$$;

drop trigger if exists exercises_search_text on public.exercises;
create trigger exercises_search_text
  before insert or update of name, name_i18n on public.exercises
  for each row execute function public.exercises_set_search_text();

-- Exercises that were imported before this migration get their search text now.
update public.exercises set name = name where search_text = '';

revoke all on function public.normalize_search_text(text) from public, anon, authenticated;
grant execute on function public.normalize_search_text(text) to authenticated, anon, service_role;
