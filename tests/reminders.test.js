import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReminderPush } from '../api/_lib/pushText.js';
import { reminderTranslations } from '../src/i18n/reminderTranslations.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { PAGES, navigationFor } from '../src/routes.js';
import {
  ALL_DAYS, REMINDER_KINDS, REMINDER_KIND_KEYS, activeReminders, defaultTitleKey, describeDays, emptyReminderForm, formatReminderTime, localTimezone,
  reminderToForm, toggleDay, validateReminder, weekdayLabel,
} from '../src/services/reminderUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
const ZONES = ['Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Halifax',
  'America/Sao_Paulo', 'Atlantic/South_Georgia', 'Atlantic/Azores', 'UTC', 'Europe/Paris', 'Africa/Cairo', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Dhaka',
  'Asia/Bangkok', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Noumea', 'Pacific/Auckland', 'Pacific/Kiritimati'];

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result;
}
async function refused(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

// A zone whose local hour is between min and max right now, so "five minutes ago" never crosses midnight.
async function zoneWithLocalHour(min, max) {
  for (const zone of ZONES) {
    const [{ hour }] = await rows('select extract(hour from now() at time zone $1)::int as hour', [zone]);
    if (hour >= min && hour <= max) return zone;
  }
  throw new Error(`No zone has a local hour between ${min} and ${max}`);
}
const localTime = async (zone, shift) => (await rows("select to_char(((now() at time zone $1)::time + $2::interval)::time, 'HH24:MI') as t", [zone, shift]))[0].t;
const localDay = async (zone) => (await rows('select extract(isodow from now() at time zone $1)::int as d', [zone]))[0].d;

const save = (userId, { id = null, kind = 'water', title = 'Drink water', message = 'A glass', time = '09:00', days = [1, 2, 3, 4, 5, 6, 7], timezone = 'UTC', active = true, target = null } = {}) =>
  as(userId).sql('select public.save_reminder($1, $2, $3, $4, $5::time, $6::int[], $7, $8, $9) as id', [id, kind, title, message, time, days, timezone, active, target]);
const savedId = async (userId, values) => (await ok(save(userId, values))).rows[0].id;
const inbox = async (userId) => (await ok(as(userId).rpc('get_my_notifications', {}))).data;

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Amal', brandName: 'Amal Fitness' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client', fullName: 'Omar' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
});

// ------------------------------------------------------------------------------------------ the database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = read('supabase/migrations/20261115004600_custom_reminders.sql').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(read('supabase/migrations/20261115004600_custom_reminders.sql'));
});

test('a client and a coach each schedule reminders for themselves', async () => {
  const mine = await savedId(ids.sara, { title: 'Drink water', days: [3, 1, 3, 2], time: '10:30' });
  const [reminder] = await rows('select * from public.custom_reminders where id = $1', [mine]);
  assert.deepEqual([reminder.owner_id, reminder.target_id, reminder.kind, reminder.time_of_day, reminder.days_of_week, reminder.timezone, reminder.is_active],
    [ids.sara, ids.sara, 'water', '10:30:00', [1, 2, 3], 'UTC', true]);
  await savedId(ids.coach, { kind: 'checkin', title: 'Review check-ins', timezone: 'Africa/Cairo' });
  assert.equal((await as(ids.sara).from('custom_reminders')).data.length, 1);
  assert.equal((await as(ids.coach).from('custom_reminders')).data.length, 1);
  assert.deepEqual((await as(ids.omar).from('custom_reminders')).data, []);
});

test('reminder input is validated: type, title, message, days, time zone, owner and limit', async () => {
  await refused(save(ids.sara, { kind: 'sleep' }), /valid reminder type/);
  await refused(save(ids.sara, { title: '   ' }), /between 1 and 80/);
  await refused(save(ids.sara, { title: 'x'.repeat(81) }), /between 1 and 80/);
  await refused(save(ids.sara, { message: 'x'.repeat(301) }), /up to 300/);
  await refused(save(ids.sara, { days: [] }), /at least one day/);
  await refused(save(ids.sara, { days: [0, 8] }), /at least one day/);
  await refused(save(ids.sara, { timezone: 'Mars/Olympus' }), /valid time zone/);
  await refused(save(ids.sara, { time: null }), /Choose the time/);
  const theirs = await savedId(ids.omar, {});
  await refused(save(ids.sara, { id: theirs }), /not found/);
  await refused(as(ids.sara).rpc('delete_reminder', { p_id: theirs }), /not found/);
  await db.query("insert into public.custom_reminders (owner_id, target_id, title, time_of_day, days_of_week) select $1, $1, 'R' || g, '08:00', '{1}' from generate_series(1, 40) g", [ids.sara]);
  await refused(save(ids.sara, { title: 'One too many' }), /up to 40/);
  const direct = await as(ids.sara).sql("insert into public.custom_reminders (owner_id, target_id, title, time_of_day, days_of_week) values ($1, $1, 'x', '08:00', '{1}')", [ids.sara]);
  assert.match(direct.error.message, /permission denied/);
});

test('a coach schedules a reminder for one of their active clients; nobody else can', async () => {
  const id = await savedId(ids.coach, { kind: 'meal', title: 'Log your lunch', target: ids.sara });
  const [reminder] = await rows('select owner_id, target_id from public.custom_reminders where id = $1', [id]);
  assert.deepEqual([reminder.owner_id, reminder.target_id], [ids.coach, ids.sara]);
  const sees = (await as(ids.sara).from('custom_reminders')).data;
  assert.deepEqual(sees.map((row) => row.id), [id], 'the client sees what the coach set for them');
  await refused(save(ids.sara, { id, title: 'Changed by client' }), /not found/);
  await refused(as(ids.sara).rpc('delete_reminder', { p_id: id }), /not found/);
  await refused(save(ids.coach, { target: ids.omar }), /own active clients/);
  await refused(save(ids.sara, { target: ids.coach }), /own active clients/);
  await refused(save(ids.sara, { target: ids.omar }), /own active clients/);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  await refused(save(ids.coach, { target: ids.sara, title: 'Archived client' }), /own active clients/);
  await ok(as(ids.coach).rpc('delete_reminder', { p_id: id }));
  assert.deepEqual((await as(ids.sara).from('custom_reminders')).data, []);
});

test('a due reminder becomes a notification once a day, at the right link, in the person own time', async () => {
  const zone = await zoneWithLocalHour(6, 17);
  const day = await localDay(zone);
  const due = await savedId(ids.sara, { kind: 'workout', title: 'Time to train', message: 'Leg day', time: await localTime(zone, '-5 minutes'), timezone: zone });
  await savedId(ids.sara, { title: 'Later today', time: await localTime(zone, '+2 hours'), timezone: zone });
  await savedId(ids.sara, { title: 'Another day', time: await localTime(zone, '-5 minutes'), timezone: zone, days: ALL_DAYS.filter((value) => value !== day) });
  await savedId(ids.sara, { title: 'Switched off', time: await localTime(zone, '-5 minutes'), timezone: zone, active: false });

  const first = await inbox(ids.sara);
  assert.equal(first.unread_count, 1);
  assert.deepEqual(first.items.map((item) => [item.type, item.payload.title, item.payload.message, item.link]), [['reminder', 'Time to train', 'Leg day', '/workouts']]);
  assert.equal(first.items[0].payload.reminder_id, due);
  assert.equal((await inbox(ids.sara)).items.length, 1, 'asking again does not repeat it today');
  assert.equal(await (async () => (await as(ids.sara).rpc('get_my_unread_notification_count')).data)(), 1);
  const [{ last_fired_on: firedOn }] = await rows('select last_fired_on::text from public.custom_reminders where id = $1', [due]);
  assert.equal(firedOn, (await rows('select (now() at time zone $1)::date::text as d', [zone]))[0].d);

  await ok(as(ids.sara).rpc('mark_all_notifications_read'));
  await db.query("update public.custom_reminders set last_fired_on = last_fired_on - 1 where id = $1", [due]);
  assert.equal((await inbox(ids.sara)).items.length, 2, 'the next day it fires again');
});

test('reminders lead to the right page for a coach and for a client', async () => {
  const zone = await zoneWithLocalHour(6, 17);
  const time = await localTime(zone, '-5 minutes');
  for (const kind of ['water', 'meal', 'checkin', 'custom']) await savedId(ids.sara, { kind, title: kind, time, timezone: zone });
  for (const kind of ['meal', 'checkin', 'workout', 'water']) await savedId(ids.coach, { kind, title: kind, time, timezone: zone });
  const links = async (userId) => Object.fromEntries((await inbox(userId)).items.map((item) => [item.payload.title, item.link]));
  assert.deepEqual(await links(ids.sara), { water: '/habits', meal: '/food', checkin: '/weekly-checkin', custom: '/reminders' });
  assert.deepEqual(await links(ids.coach), { meal: '/meal-plans', checkin: '/checkins', workout: '/workout-builder', water: '/reminders' });
});

test('a reminder set by the coach tells the client who it is from; one that is more than 12 hours late is skipped for the day', async () => {
  const zone = await zoneWithLocalHour(6, 17);
  await savedId(ids.coach, { kind: 'meal', title: 'Log your lunch', target: ids.sara, time: await localTime(zone, '-5 minutes'), timezone: zone });
  const item = (await inbox(ids.sara)).items[0];
  assert.equal(item.payload.from_coach, true);
  assert.equal(item.payload.coach_name, 'Amal Fitness');
  assert.equal((await inbox(ids.coach)).items.length, 0, 'the coach is not reminded of what they set for a client');

  const lateZone = await zoneWithLocalHour(13, 17);
  const late = await savedId(ids.omar, { title: 'Way too late', time: await localTime(lateZone, '-13 hours'), timezone: lateZone });
  assert.equal((await inbox(ids.omar)).items.length, 0);
  const [{ last_fired_on: fired }] = await rows('select last_fired_on from public.custom_reminders where id = $1', [late]);
  assert.ok(fired, 'it is marked for the day, so it does not appear later today');
});

test('the scheduled job fires everyone due and hands out each push once; people cannot call it', async () => {
  const zone = await zoneWithLocalHour(6, 17);
  const time = await localTime(zone, '-5 minutes');
  await savedId(ids.sara, { title: 'Water', time, timezone: zone });
  await savedId(ids.coach, { kind: 'meal', title: 'Prep meals', time, timezone: zone });
  await savedId(ids.omar, { title: 'Not due', time: await localTime(zone, '+3 hours'), timezone: zone });

  for (const userId of [ids.sara, ids.coach]) {
    const denied = await as(userId).sql('select public.run_reminder_engine()');
    assert.match(denied.error.message, /permission denied/);
    const denied2 = await as(userId).sql('select public.fire_due_reminders($1, true)', [userId]);
    assert.match(denied2.error.message, /permission denied/);
  }
  const first = (await rows('select public.run_reminder_engine() as result'))[0].result;
  assert.deepEqual(first.map((entry) => [entry.user_id, entry.title, entry.link]).sort(), [[ids.coach, 'Prep meals', '/meal-plans'], [ids.sara, 'Water', '/habits']].sort());
  assert.ok(first.every((entry) => entry.notification_id));
  assert.deepEqual((await rows('select public.run_reminder_engine() as result'))[0].result, [], 'a second pass sends nothing again');
  assert.equal((await rows("select count(*)::int as n from public.notifications where type = 'reminder' and pushed_at is not null"))[0].n, 2);
  assert.equal((await inbox(ids.sara)).unread_count, 1, 'the notification is also in the bell');
});

test('a reminder fired while the person has the app open is not pushed again by the scheduled job', async () => {
  const zone = await zoneWithLocalHour(6, 17);
  await savedId(ids.sara, { title: 'Water', time: await localTime(zone, '-5 minutes'), timezone: zone });
  await inbox(ids.sara);
  assert.deepEqual((await rows('select public.run_reminder_engine() as result'))[0].result, []);
});

test('a reminder that was fired but not pushed (for example by pg_cron) is still pushed by the scheduled job', async () => {
  const zone = await zoneWithLocalHour(6, 17);
  await savedId(ids.sara, { title: 'Water', time: await localTime(zone, '-5 minutes'), timezone: zone });
  await db.query('select public.fire_due_reminders(null, false)');
  const pushed = (await rows('select public.run_reminder_engine() as result'))[0].result;
  assert.deepEqual(pushed.map((entry) => entry.title), ['Water']);
});

// ------------------------------------------------------------------------------------------ the app and the server

test('the form is checked and becomes the arguments of the database function', () => {
  const good = validateReminder({ ...emptyReminderForm('meal'), title: ' Lunch ', message: ' log it ', time: '12:30', days: [5, 1, 1, 9], target: 'abc' }, 'Africa/Cairo');
  assert.equal(good.valid, true);
  assert.deepEqual(good.payload, { id: null, kind: 'meal', title: 'Lunch', message: 'log it', time: '12:30:00', days: [1, 5], timezone: 'Africa/Cairo', active: true, target: 'abc' });
  const bad = validateReminder({ kind: 'sleep', title: '', message: 'x'.repeat(301), time: '25:00', days: [] });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['days', 'kind', 'message', 'time', 'title']);
  assert.equal(validateReminder({ ...emptyReminderForm(), title: 'x', time: '9:00' }).errors.time, 'rmErrTime');
  assert.equal(localTimezone().length > 0, true);
});

test('a saved reminder opens as a form, days toggle, and schedules read naturally in each language', () => {
  const row = { id: 'r1', kind: 'water', title: 'Water', message: '', time_of_day: '10:30:00', days_of_week: [3, 1], is_active: true, owner_id: 'me', target_id: 'me' };
  assert.deepEqual(reminderToForm(row, 'me'), { id: 'r1', kind: 'water', title: 'Water', message: '', time: '10:30', days: [1, 3], active: true, target: '' });
  assert.equal(reminderToForm({ ...row, target_id: 'client' }, 'me').target, 'client');
  assert.deepEqual(toggleDay([1, 3], 2), [1, 2, 3]);
  assert.deepEqual(toggleDay([1, 2, 3], 2), [1, 3]);
  assert.equal(weekdayLabel(1, 'en'), 'Mon');
  assert.equal(weekdayLabel(7, 'en'), 'Sun');
  assert.notEqual(weekdayLabel(1, 'ar'), weekdayLabel(1, 'en'));
  assert.match(weekdayLabel(1, 'ar'), /[\u0600-\u06FF]/);
  assert.match(formatReminderTime('14:05:00', 'en'), /2:05/);
  const t = (key) => translations.en[key];
  assert.equal(describeDays(ALL_DAYS, 'en', t), 'Every day');
  assert.equal(describeDays([1, 2, 3, 4, 5], 'en', t), 'Weekdays');
  assert.equal(describeDays([1, 3], 'en', t), 'Mon · Wed');
  assert.deepEqual(activeReminders([{ is_active: true, time_of_day: '18:00:00' }, { is_active: false, time_of_day: '07:00:00' }, { is_active: true, time_of_day: '08:00:00' }]).map((item) => item.time_of_day), ['08:00:00', '18:00:00']);
});

test('the Reminders page is in the menu of coaches and clients, and its texts exist in every language', () => {
  assert.equal(PAGES.reminders.path, '/reminders');
  for (const role of ['coach', 'client']) assert.ok(navigationFor(role).flatMap((section) => section.items).includes('reminders'), role);
  assert.match(read('src/App.jsx'), /<Route path=\{PAGES\.reminders\.path\} element=\{<RemindersPage \/>\} \/>/);
  const keys = Object.keys(reminderTranslations.en);
  assert.ok(keys.length >= 40);
  for (const key of keys) for (const locale of supportedLocales) assert.equal(translations[locale][key], reminderTranslations[locale][key], `${locale} ${key}`);
  for (const kind of REMINDER_KINDS) for (const locale of supportedLocales) {
    assert.ok(translations[locale][REMINDER_KIND_KEYS[kind]], `${locale} ${kind}`);
    assert.ok(translations[locale][defaultTitleKey(kind)], `${locale} default title ${kind}`);
  }
  assert.match(translations.ar.rmDescription, /[\u0600-\u06FF]/);
});

test('reminders reach the existing Web Push through the existing scheduled job: no new function is added', () => {
  const push = buildReminderPush({ title: 'Drink water', message: 'A glass', link: '/habits' });
  assert.deepEqual(push, { title: 'Drink water', body: 'A glass', url: '/habits', tag: 'apexfit-reminder' });
  assert.equal(buildReminderPush({ title: 'x'.repeat(200), message: 'y'.repeat(500) }).title.length, 80);
  assert.equal(buildReminderPush({ title: '', message: '' }).title, 'ApexFit');
  assert.equal(buildReminderPush({}).url, '/reminders');

  const workflows = read('api/workflows.js');
  assert.match(workflows, /rpc\('run_reminder_engine'\)/);
  assert.match(workflows, /deliverReminderPushes\(data\)/);
  assert.match(workflows, /isAuthorizedCron/, 'the job still checks the cron secret');
  assert.match(read('api/_lib/pushNotify.js'), /export async function deliverReminderPushes/);
  assert.match(read('api/_lib/pushNotify.js'), /buildReminderPush\(reminder\)/);
  assert.match(read('vercel.json'), /"path": "\/api\/workflows"/);
  const sw = read('public/sw.js');
  assert.match(sw, /data\.url/);
});
