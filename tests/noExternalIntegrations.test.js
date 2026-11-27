import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { ADMIN_PATHS, PAGES } from '../src/routes.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { createTestDatabase } from './helpers/pgliteSupabase.js';

// ApexFit works without any integration that needs a developer or company account of its own: no Google Calendar,
// no Fitbit, Garmin or Oura. (Google sign-in, Google Meet links and the Gemini AI option are different things and stay.)

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const exists = (path) => existsSync(new URL(path, root));

function sourceFiles(directory) {
  return readdirSync(new URL(`${directory}/`, root)).flatMap((name) => {
    const path = `${directory}/${name}`;
    return statSync(new URL(path, root)).isDirectory() ? sourceFiles(path) : [path];
  });
}

// ------------------------------------------------------------------ nothing is left in the code

test('the server code, pages and routes for the removed services are gone', () => {
  for (const path of [
    'api/google.js', 'api/platform.js', 'api/wearables', 'api/_lib/wearables.js', 'api/_lib/googleCalendar.js', 'api/_lib/googleAuth.js',
    'api/_lib/checklistCalendar.js', 'api/_lib/platformIntegrations.js', 'api/_lib/today.js',
    'src/pages/AdminIntegrationsPage.jsx', 'src/components/PlatformIntegrationsPanel.jsx', 'src/services/platformService.js', 'src/i18n/platformIntegrationTranslations.js',
  ]) assert.equal(exists(path), false, path);
  assert.deepEqual(ADMIN_PATHS, { ai: '/admin/ai', marketplace: '/admin/marketplace' });
  assert.ok(!Object.values(PAGES).some((page) => /integrations\/|google|admin/.test(page.path)));

  // The serverless functions that remain: Vercel counts every file in api/ except the _lib folder.
  const functions = readdirSync(new URL('api/', root)).filter((name) => !name.startsWith('_'));
  assert.deepEqual(functions.sort(), ['ai.js', 'food-search.js', 'jack-assistant.js', 'jack.js', 'paddle-webhook.js', 'paddle.js', 'push.js', 'send-campaign.js', 'unsubscribe.js', 'video-sessions.js', 'workflows.js']);
});

test('no code or screen text mentions Google Calendar, Fitbit, Garmin, Oura or their keys', () => {
  const removed = /google ?calendar|googleapis\.com\/calendar|calendar\.events|google_calendar|GOOGLE_CLIENT|syncSessionToGoogle|fitbit|garmin|\boura\b|FITBIT_|GARMIN_|OURA_|wearables\/|platform_integration|calendar_sync/i;
  const checked = [...sourceFiles('api'), ...sourceFiles('src'), '.env.example', 'vercel.json', 'package.json'];
  const offenders = checked.filter((path) => removed.test(read(path)));
  assert.deepEqual(offenders, []);
});

test('Google sign-in, Google Meet links and the Gemini AI option are untouched', () => {
  assert.match(read('src/services/authService.js'), /signInWithOAuth|signInWithGoogle/);
  assert.match(read('src/pages/LoginPage.jsx'), /Google/);
  assert.match(read('api/_lib/jackModels.js'), /createGeminiModel/);
  assert.match(read('supabase/migrations/20261115001200_live_video_room.sql'), /google_meet/);
});

test('the pages and the manual setup file have no leftovers', () => {
  const schedule = read('src/pages/SchedulePage.jsx');
  assert.doesNotMatch(schedule, /google|Google/);
  assert.doesNotMatch(read('src/services/scheduleService.js'), /google|callApi/i);
  const checklist = read('src/pages/ChecklistPage.jsx') + read('src/services/checklistService.js') + read('src/services/checklistUtils.js');
  assert.doesNotMatch(checklist, /calendar/i);
  const devices = read('src/components/WearablesPanel.jsx') + read('src/services/healthService.js') + read('src/services/healthUtils.js');
  assert.doesNotMatch(devices, /startWearableConnection|syncWearable|disconnectWearable|getWearableProviders|CLOUD_PROVIDERS|unconfigured|callApi/);
  assert.doesNotMatch(read('src/pages/SettingsPage.jsx'), /ADMIN_PATHS\.integrations|adminInt/);
  assert.doesNotMatch(read('.env.example'), /GOOGLE|FITBIT|GARMIN|OURA|PLATFORM_INTEGRATION/);
  assert.doesNotMatch(read('README.md'), /\/api\/google|\/api\/wearables|FITBIT_CLIENT|GOOGLE_CLIENT|OURA_CLIENT|GARMIN_CLIENT/);
});

// ------------------------------------------------------------------------- translations

test('no language has texts for the removed connections, and the schedule and checklist read cleanly', () => {
  const leftovers = /^(google|syncGoogle|resyncGoogle|sessionScheduledSynced|chkCalendar|chkAddToCalendar|chkInCalendar|chkErrCalendarTime|adminInt|hltSetupNeeded|hltUnconfigured|hltConnect|hltConnecting|hltReconnect|hltSync|hltDisconnect|hltResult_|hltProv_(fitbit|garmin|oura)|hltProvDesc_(fitbit|garmin|oura)|hltState_(error|unconfigured))/;
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(translations[locale]).filter((key) => leftovers.test(key)), [], locale);
    for (const [key, value] of Object.entries(translations[locale])) {
      assert.doesNotMatch(String(value), /Google (Calendar|Kalender|Agenda)|تقويم Google|Fitbit|Garmin|\bOura\b/i, `${locale}.${key}`);
    }
  }
  for (const key of ['schedule', 'scheduleDescription', 'sessionScheduled', 'chkPageDescription', 'chkReminder', 'chkReminderSave', 'hltPageDescription', 'hltState_connected', 'hltState_disconnected', 'hltLastSync', 'hltProv_apple_health']) {
    for (const locale of supportedLocales) assert.ok(translations[locale][key], `${locale}.${key}`);
  }
  assert.equal(translations.ar.chkReminder, 'الوقت');
});

test('Jack\'s guide no longer sends anyone to a calendar connection or a device sign-in', () => {
  for (const role of ['coach', 'client', 'trainer']) {
    const prompt = buildSystemPrompt({ role, locale: 'en', route: '/schedule', pageTitle: 'schedule', name: 'Sam', summary: '', today: '2026-11-18' });
    assert.doesNotMatch(prompt, /Google Calendar|Fitbit|Garmin|\bOura\b|Sync now|calendar/i, role);
  }
  const client = buildSystemPrompt({ role: 'client', locale: 'en', route: '/integrations', pageTitle: 'integrations', name: 'Sara', summary: '', today: '2026-11-18' });
  assert.match(client, /Apple Health export/);
  assert.match(client, /Quick entry/);
});

// ----------------------------------------------------------------------------- the database

const MIGRATION = new URL('supabase/migrations/20261115001900_remove_external_integrations.sql', root);
const CLIENT = '00000000-0000-4000-8000-0000000000c1';
let db;

before(async () => {
  db = await createTestDatabase();
});

test('a new project never creates the removed pieces', async () => {
  assert.deepEqual((await db.query("select table_name from information_schema.tables where table_schema = 'public' and table_name ~ 'google|platform_integration'")).rows, []);
  assert.deepEqual((await db.query("select column_name from information_schema.columns where table_schema = 'public' and column_name ~ 'google|calendar_sync|token|external_user|raw_payload'")).rows, []);
  assert.deepEqual((await db.query("select proname from pg_proc where pronamespace = 'public'::regnamespace and proname ~ 'google|calendar|service_save_wearable|update_checklist_calendar'")).rows, []);
  const manual = read('supabase/manual-setup.sql');
  assert.ok(manual.includes('20261115001900_remove_external_integrations.sql'));
  assert.ok(manual.replace(/\r\n/g, '\n').includes(readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim()));
});

test('the cleanup is safe to run again and changes nothing on a clean project', async () => {
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assert.equal(Number((await db.query("select count(*) as n from pg_tables where schemaname = 'public' and tablename = 'wearable_connections'")).rows[0].n), 1);
});

// What a project that ran the earlier versions looks like: the old tables, columns, constraints and functions, with data.
async function olderProject() {
  const old = new PGlite();
  const helper = readFileSync(new URL('tests/helpers/pgliteSupabase.js', root), 'utf8');
  await old.exec(helper.match(/const SUPABASE_STUBS = `([\s\S]*?)`;/)[1]);
  // Everything up to (not including) the cleanup migration: the setup file as a project would have run it.
  const manual = read('supabase/manual-setup.sql').replace(/\r\n/g, '\n');
  await old.exec(manual.slice(0, manual.indexOf('-- ===== 20261115001900_remove_external_integrations.sql =====')));
  await old.exec(`
    alter table public.coach_sessions add column google_event_id text, add column google_synced_at timestamptz;
    create table public.google_calendar_connections (coach_id uuid primary key references public.profiles (id) on delete cascade, google_email text, refresh_token_encrypted text not null, calendar_id text not null default 'primary');
    create table public.platform_integration_settings (provider text primary key, client_id text not null, client_secret_encrypted text not null);
    create function public.get_my_google_calendar_status() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.get_my_calendar_connection() returns jsonb language sql as $$ select '{}'::jsonb $$;
    alter table public.checklist_templates add column calendar_sync boolean not null default false;
    alter table public.checklist_entries add column calendar_sync boolean not null default false;
    create function public.update_checklist_calendar(uuid, time, boolean) returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.add_checklist_task(date, text, text, numeric, text, time, jsonb, boolean) returns jsonb language sql as $$ select '{}'::jsonb $$;
    alter table public.wearable_connections add column access_token_encrypted text, add column refresh_token_encrypted text, add column token_expires_at timestamptz, add column external_user_id text;
    alter table public.wearable_daily_metrics add column raw_payload jsonb;
    alter table public.wearable_connections drop constraint wearable_connections_provider_check;
    alter table public.wearable_connections add constraint wearable_connections_provider_check check (provider in ('apple_health', 'fitbit', 'garmin', 'oura'));
    alter table public.wearable_daily_metrics drop constraint wearable_daily_metrics_provider_check;
    alter table public.wearable_daily_metrics add constraint wearable_daily_metrics_provider_check check (provider in ('apple_health', 'fitbit', 'garmin', 'oura', 'manual'));
    create function public.wearable_metrics_upsert(uuid, text, jsonb, boolean) returns integer language sql as $$ select 0 $$;
    create function public.service_save_wearable_metrics(uuid, text, jsonb) returns integer language sql as $$ select 0 $$;
  `);
  await old.query('insert into auth.users (id, email) values ($1, $2)', [CLIENT, 'sara@example.com']);
  await old.query("insert into public.profiles (id, role) values ($1, 'client')", [CLIENT]);
  await old.query("insert into public.google_calendar_connections (coach_id, refresh_token_encrypted) values ($1, 'cipher')", [CLIENT]);
  await old.query("insert into public.wearable_connections (client_id, provider, status, access_token_encrypted) values ($1, 'fitbit', 'connected', 'token'), ($1, 'apple_health', 'connected', null)", [CLIENT]);
  await old.query("insert into public.wearable_daily_metrics (client_id, recorded_date, provider, steps) values ($1, current_date, 'oura', 5), ($1, current_date, 'garmin', 6), ($1, current_date, 'apple_health', 7), ($1, current_date, 'manual', 9)", [CLIENT]);
  await old.query("insert into public.checklist_entries (client_id, task_date, category, title, remind_time, calendar_sync) values ($1, current_date, 'custom', 'Call', '08:00', true)", [CLIENT]);
  return old;
}

test('a project that had the old integrations is cleaned up and keeps the people\'s own data', async () => {
  const old = await olderProject();
  await old.exec(readFileSync(MIGRATION, 'utf8'));
  const query = async (sql) => (await old.query(sql)).rows;

  assert.deepEqual(await query("select table_name from information_schema.tables where table_schema = 'public' and table_name ~ 'google|platform_integration'"), []);
  assert.deepEqual(await query("select column_name from information_schema.columns where table_schema = 'public' and column_name ~ 'google|calendar_sync|token|external_user|raw_payload'"), []);
  assert.deepEqual(await query("select proname from pg_proc where pronamespace = 'public'::regnamespace and proname ~ 'google|calendar|service_save_wearable|update_checklist_calendar'"), []);
  assert.deepEqual(await query("select proname, pronargs from pg_proc where pronamespace = 'public'::regnamespace and proname in ('add_checklist_task', 'wearable_metrics_upsert') order by 1"), [{ proname: 'add_checklist_task', pronargs: 7 }, { proname: 'wearable_metrics_upsert', pronargs: 3 }]);

  // Apple Health and manual numbers, the Apple Health connection and the checklist task are all still there.
  assert.deepEqual(await query('select provider, steps from public.wearable_daily_metrics order by provider'), [{ provider: 'apple_health', steps: 7 }, { provider: 'manual', steps: 9 }]);
  assert.deepEqual(await query('select provider from public.wearable_connections'), [{ provider: 'apple_health' }]);
  assert.deepEqual(await query('select title, remind_time::text as t from public.checklist_entries'), [{ title: 'Call', t: '08:00:00' }]);

  // The services that are gone can no longer be stored.
  await assert.rejects(old.query("insert into public.wearable_daily_metrics (client_id, recorded_date, provider, steps) values ($1, current_date - 1, 'fitbit', 1)", [CLIENT]), /check/);
  await assert.rejects(old.query("insert into public.wearable_connections (client_id, provider, status) values ($1, 'oura', 'connected')", [CLIENT]), /check/);

  // Running the whole setup file again on the cleaned project works.
  await old.exec(read('supabase/manual-setup.sql'));
  assert.equal(Number((await query("select count(*) as n from public.checklist_entries")).at(0).n), 1);
  await old.close();
});
