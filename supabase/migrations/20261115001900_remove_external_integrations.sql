-- ApexFit no longer connects to outside accounts that need developer approval: Google Calendar and the Fitbit,
-- Garmin and Oura cloud APIs are gone. Smart-device data comes from Apple Health files and quick entries, and
-- tasks live in the in-app checklist.
--
-- The migrations that used to create those pieces no longer do, so a new project never has them. This one cleans
-- up a project that already had them. It is safe to run again, and on a new project it changes nothing.

-- ---------------------------------------------------------------------------
-- Google Calendar
-- ---------------------------------------------------------------------------
-- The stored calendar connections (including their encrypted tokens) are deleted with the table.

drop function if exists public.get_my_google_calendar_status();
drop function if exists public.get_my_calendar_connection();
drop table if exists public.google_calendar_connections;
drop table if exists public.platform_integration_settings;

alter table public.coach_sessions drop column if exists google_event_id;
alter table public.coach_sessions drop column if exists google_synced_at;

-- The checklist keeps its tasks and times, but has no calendar choice any more.
drop function if exists public.add_checklist_task(date, text, text, numeric, text, time, jsonb, boolean);
drop function if exists public.update_checklist_calendar(uuid, time, boolean);
alter table public.checklist_templates drop column if exists calendar_sync;
alter table public.checklist_entries drop column if exists calendar_sync;

-- ---------------------------------------------------------------------------
-- Fitbit, Garmin and Oura
-- ---------------------------------------------------------------------------
-- Their connections (which held encrypted tokens) and the numbers they delivered are removed. Apple Health and
-- manually entered numbers are untouched.

delete from public.wearable_daily_metrics where provider in ('fitbit', 'garmin', 'oura');
delete from public.wearable_connections where provider in ('fitbit', 'garmin', 'oura');

drop function if exists public.service_save_wearable_metrics(uuid, text, jsonb);
drop function if exists public.wearable_metrics_upsert(uuid, text, jsonb, boolean);

do $$
declare
  v_name text;
  v_changed boolean := false;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.wearable_daily_metrics'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%fitbit%'
  loop
    execute format('alter table public.wearable_daily_metrics drop constraint %I', v_name);
    v_changed := true;
  end loop;
  if v_changed then
    alter table public.wearable_daily_metrics add constraint wearable_daily_metrics_provider_check check (provider in ('apple_health', 'manual'));
  end if;

  v_changed := false;
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.wearable_connections'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%fitbit%'
  loop
    execute format('alter table public.wearable_connections drop constraint %I', v_name);
    v_changed := true;
  end loop;
  if v_changed then
    alter table public.wearable_connections add constraint wearable_connections_provider_check check (provider = 'apple_health');
  end if;
end
$$;

alter table public.wearable_connections drop column if exists access_token_encrypted;
alter table public.wearable_connections drop column if exists refresh_token_encrypted;
alter table public.wearable_connections drop column if exists token_expires_at;
alter table public.wearable_connections drop column if exists external_user_id;
alter table public.wearable_daily_metrics drop column if exists raw_payload;
