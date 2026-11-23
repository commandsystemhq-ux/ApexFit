import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NOTIFICATION_TYPES, buildPushMessage } from '../api/_lib/pushText.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { checkinTranslations } from '../src/i18n/checkinTranslations.js';
import {
  MAX_CHECKIN_PHOTO_BYTES, PHOTO_SLOTS, checkinPhotoPath, defaultComparison, diffCheckins, emptyCheckinForm, formFromCheckin, photoCount,
  validateCheckinForm, validateCheckinPhoto, weekStartOf, weeksWithPhoto,
} from '../src/services/checkinUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003200_weekly_checkins.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  loner: '00000000-0000-4000-8000-0000000000c3',
};

let db;
let monday;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function refused(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

const answers = (overrides = {}) => ({
  p_week_start: monday, p_weight_kg: 82.4, p_sleep_hours: 7.5, p_sleep_quality: 4, p_workout_adherence: 8, p_diet_adherence: 7, p_energy: 3,
  p_notes: 'Good week', p_photo_paths: {}, ...overrides,
});
const submit = (userId, overrides) => as(userId).rpc('submit_weekly_checkin', answers(overrides));
const uploadPhoto = (owner, name) => db.query("insert into storage.objects (bucket_id, name, owner) values ('apexfit-checkin-photos', $1, $2)", [`${owner}/${name}`, owner]);
const addDays = async (days) => (await rows("select (date_trunc('week', current_date)::date + $1::int)::text as d", [days]))[0].d;

before(async () => {
  db = await createTestDatabase();
  monday = (await rows("select date_trunc('week', current_date)::date::text as d"))[0].d;
  await db.exec('grant select, insert, delete on storage.objects to authenticated');
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users; delete from storage.objects;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.loner, 'loner@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara Ali', 'sara@example.com'), ($3, $4, 'Omar Hassan', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
});

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('the photo bucket is private, 5 MB, images only', async () => {
  const [bucket] = await rows("select public, file_size_limit::int as size, allowed_mime_types as types from storage.buckets where id = 'apexfit-checkin-photos'");
  assert.deepEqual([bucket.public, bucket.size, bucket.types], [false, 5 * 1024 * 1024, ['image/jpeg', 'image/png', 'image/webp']]);
});

test('a client sends the week\'s check-in and can change it until the coach reviews it', async () => {
  const sent = await ok(submit(ids.sara));
  assert.deepEqual([sent.client_id, sent.coach_id, sent.week_start_date, sent.status, Number(sent.weight_kg)], [ids.sara, ids.coach, monday, 'submitted', 82.4]);
  await ok(submit(ids.sara, { p_weight_kg: 81.9, p_notes: 'Updated' }));
  const mine = await ok(as(ids.sara).from('weekly_checkins').select('weight_kg,client_notes'));
  assert.equal(mine.length, 1);
  assert.deepEqual([Number(mine[0].weight_kg), mine[0].client_notes], [81.9, 'Updated']);

  const reviewed = await ok(as(ids.coach).rpc('review_weekly_checkin', { p_checkin_id: sent.id, p_feedback: 'Great work' }));
  assert.equal(reviewed.status, 'reviewed');
  await refused(submit(ids.sara, { p_notes: 'Too late' }), /already reviewed/);
});

test('the answers are checked: week, ranges, ratings and photos', async () => {
  await refused(submit(ids.sara, { p_week_start: await addDays(1) }), /Monday/);
  await refused(submit(ids.sara, { p_week_start: await addDays(-28) }), /this week or last week/);
  await refused(submit(ids.sara, { p_week_start: await addDays(7) }), /this week or last week/);
  await refused(submit(ids.sara, { p_weight_kg: 10 }), /Weight/);
  await refused(submit(ids.sara, { p_sleep_hours: 25 }), /Sleep must be/);
  await refused(submit(ids.sara, { p_sleep_quality: 6 }), /sleep quality/);
  await refused(submit(ids.sara, { p_workout_adherence: 0 }), /workouts/);
  await refused(submit(ids.sara, { p_diet_adherence: 11 }), /nutrition/);
  await refused(submit(ids.sara, { p_energy: null }), /energy/);
  await refused(submit(ids.sara, { p_notes: 'n'.repeat(2001) }), /Notes/);
  await refused(submit(ids.coach), /client account/);
  assert.deepEqual(await rows('select id from public.weekly_checkins'), []);

  const ok1 = await ok(submit(ids.sara, { p_week_start: await addDays(-7), p_weight_kg: null, p_sleep_hours: null }));
  assert.equal(ok1.weight_kg, null);
});

test('photos must be the client\'s own uploaded files in front, side or back', async () => {
  await refused(submit(ids.sara, { p_photo_paths: { front: `${ids.sara}/a.jpg` } }), /not uploaded/);
  await uploadPhoto(ids.sara, 'a.jpg');
  await uploadPhoto(ids.omar, 'b.jpg');
  await refused(submit(ids.sara, { p_photo_paths: { top: `${ids.sara}/a.jpg` } }), /front, side or back/);
  await refused(submit(ids.sara, { p_photo_paths: { front: `${ids.omar}/b.jpg` } }), /not valid/);
  await refused(submit(ids.sara, { p_photo_paths: { front: `${ids.sara}/../x.jpg` } }), /not valid/);
  await refused(submit(ids.sara, { p_photo_paths: { front: `${ids.sara}/a.gif` } }), /not valid/);
  await refused(submit(ids.sara, { p_photo_paths: ['x'] }), /object/);
  const saved = await ok(submit(ids.sara, { p_photo_paths: { front: `${ids.sara}/a.jpg` } }));
  assert.deepEqual(saved.photo_paths, { front: `${ids.sara}/a.jpg` });
});

test('only the client and the coach who looks after them can read a check-in', async () => {
  await ok(submit(ids.sara));
  await ok(submit(ids.omar));
  assert.equal((await ok(as(ids.sara).from('weekly_checkins').select('id'))).length, 1);
  assert.equal((await ok(as(ids.omar).from('weekly_checkins').select('client_id')))[0].client_id, ids.omar);
  assert.deepEqual((await ok(as(ids.coach).from('weekly_checkins').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  assert.deepEqual((await ok(as(ids.other).from('weekly_checkins').select('client_id'))).map((row) => row.client_id), [ids.omar]);
  assert.deepEqual(await ok(as(ids.loner).from('weekly_checkins').select('id')), []);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual(await ok(as(ids.coach).from('weekly_checkins').select('id')), []);
  await db.query("update public.coach_clients set status = 'active' where client_id = $1", [ids.sara]);
  assert.equal((await ok(as(ids.coach).from('weekly_checkins').select('id'))).length, 1);
});

test('an assistant trainer who may manage programs sees only the clients assigned to them', async () => {
  await ok(submit(ids.sara));
  const memberId = await ok(as(ids.coach).rpc('invite_trainer', {
    p_email: 'tina@example.com', p_role_title: 'Assistant', p_permissions: { manage_programs: true, view_assessments: false, messages: false, manage_groups: false },
  }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
  assert.deepEqual(await ok(as(ids.trainer).from('weekly_checkins').select('id')), []);
  await ok(as(ids.coach).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: memberId }));
  assert.equal((await ok(as(ids.trainer).from('weekly_checkins').select('id'))).length, 1);
  const inbox = await ok(as(ids.trainer).rpc('get_checkins_for_coach', { p_status: 'submitted' }));
  assert.equal(inbox.length, 1);
});

test('nobody writes check-ins directly, and only the coach side can review', async () => {
  const sent = await ok(submit(ids.sara));
  assert.ok((await as(ids.sara).sql("update public.weekly_checkins set status = 'reviewed', coach_feedback = 'self', reviewed_at = now() where id = $1", [sent.id])).error);
  assert.ok((await as(ids.sara).sql('delete from public.weekly_checkins')).error);
  assert.ok((await as(ids.coach).sql("update public.weekly_checkins set coach_feedback = 'x'")).error);
  assert.ok((await as(ids.coach).sql("insert into public.weekly_checkins (client_id, week_start_date, sleep_quality_1_5, workout_adherence_1_10, diet_adherence_1_10, energy_level_1_5) values ($1, current_date, 1, 1, 1, 1)", [ids.sara])).error);
  await refused(as(ids.sara).rpc('review_weekly_checkin', { p_checkin_id: sent.id, p_feedback: 'I am my own coach' }), /not found/);
  await refused(as(ids.other).rpc('review_weekly_checkin', { p_checkin_id: sent.id, p_feedback: 'Not my client' }), /not found/);
  await refused(as(ids.coach).rpc('review_weekly_checkin', { p_checkin_id: sent.id, p_feedback: '   ' }), /1 to 2000/);
  await refused(as(ids.coach).rpc('review_weekly_checkin', { p_checkin_id: sent.id, p_feedback: 'x'.repeat(2001) }), /1 to 2000/);
  const reviewed = await ok(as(ids.coach).rpc('review_weekly_checkin', { p_checkin_id: sent.id, p_feedback: '  Keep going  ' }));
  assert.deepEqual([reviewed.status, reviewed.coach_feedback, reviewed.reviewed_by], ['reviewed', 'Keep going', ids.coach]);
  assert.ok(reviewed.reviewed_at);
  const seenByClient = await ok(as(ids.sara).from('weekly_checkins').select('coach_feedback,status'));
  assert.deepEqual(seenByClient, [{ coach_feedback: 'Keep going', status: 'reviewed' }]);
});

test('the coach\'s inbox shows the client, the change from the week before, and respects who is asking', async () => {
  const lastWeek = await addDays(-7);
  await ok(submit(ids.sara, { p_week_start: lastWeek, p_weight_kg: 84, p_energy: 2 }));
  await ok(submit(ids.sara, { p_weight_kg: 82.4 }));
  await ok(submit(ids.omar));
  const inbox = await ok(as(ids.coach).rpc('get_checkins_for_coach', { p_status: 'submitted' }));
  assert.equal(inbox.length, 2);
  assert.ok(inbox.every((row) => row.client_name === 'Sara Ali'));
  const latest = inbox.find((row) => row.week_start_date === monday);
  assert.deepEqual([Number(latest.previous.weight_kg), latest.previous.energy_level_1_5, latest.previous.week_start_date], [84, 2, lastWeek]);
  assert.equal(inbox.find((row) => row.week_start_date === lastWeek).previous, null);

  await ok(as(ids.coach).rpc('review_weekly_checkin', { p_checkin_id: latest.id, p_feedback: 'Nice' }));
  assert.equal((await ok(as(ids.coach).rpc('get_checkins_for_coach', { p_status: 'submitted' }))).length, 1);
  assert.equal((await ok(as(ids.coach).rpc('get_checkins_for_coach', { p_status: 'reviewed' }))).length, 1);
  assert.equal((await ok(as(ids.coach).rpc('get_checkins_for_coach', { p_client_id: ids.sara }))).length, 2);
  await refused(as(ids.coach).rpc('get_checkins_for_coach', { p_client_id: ids.omar }), /own clients/);
  await refused(as(ids.coach).rpc('get_checkins_for_coach', { p_status: 'pending' }), /submitted or reviewed/);
  assert.deepEqual(await ok(as(ids.loner).rpc('get_checkins_for_coach', { p_status: null })), []);
});

test('the client is told when this week\'s check-in is still due', async () => {
  const before = await ok(as(ids.sara).rpc('get_my_checkin_status', { p_today: null }));
  assert.deepEqual([before.week_start_date, before.submitted, before.due, before.has_coach], [monday, false, true, true]);
  await ok(submit(ids.sara));
  const after = await ok(as(ids.sara).rpc('get_my_checkin_status', { p_today: null }));
  assert.deepEqual([after.submitted, after.due, after.status], [true, false, 'submitted']);
  const noCoach = await ok(as(ids.loner).rpc('get_my_checkin_status', { p_today: null }));
  assert.deepEqual([noCoach.due, noCoach.has_coach], [false, false]);
  await refused(as(ids.coach).rpc('get_my_checkin_status', { p_today: null }), /client account/);
});

test('photos in storage: a client uploads to their own folder; the coach reads their client\'s photos; nobody else does', async () => {
  const bucket = 'apexfit-checkin-photos';
  const upload = (userId, folder) => as(userId).sql("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, `${folder}/week.jpg`, userId]);
  assert.equal((await upload(ids.sara, ids.sara)).error, null);
  assert.ok((await upload(ids.sara, ids.omar)).error, 'a client cannot upload into someone else\'s folder');
  assert.ok((await upload(ids.coach, ids.coach)).error, 'a coach has no check-in photos of their own');
  await upload(ids.omar, ids.omar);

  const visible = async (userId) => (await as(userId).sql('select name from storage.objects where bucket_id = $1 order by name', [bucket])).rows.map((row) => row.name);
  assert.deepEqual(await visible(ids.sara), [`${ids.sara}/week.jpg`]);
  assert.deepEqual(await visible(ids.coach), [`${ids.sara}/week.jpg`]);
  assert.deepEqual(await visible(ids.other), [`${ids.omar}/week.jpg`]);
  assert.deepEqual(await visible(ids.loner), []);

  assert.equal((await as(ids.sara).sql('delete from storage.objects where name = $1', [`${ids.sara}/week.jpg`])).error, null);
  assert.deepEqual(await visible(ids.coach), []);
});

// ------------------------------------------------------------------------------------- the numbers

test('a week starts on Monday, in any month or year', () => {
  assert.equal(weekStartOf('2026-11-23'), '2026-11-23');
  assert.equal(weekStartOf('2026-11-29'), '2026-11-23');
  assert.equal(weekStartOf('2026-11-25'), '2026-11-23');
  assert.equal(weekStartOf('2027-01-01'), '2026-12-28');
  assert.equal(weekStartOf('2024-03-01'), '2024-02-26');
});

test('the form is checked before it is sent', () => {
  const good = validateCheckinForm({ ...emptyCheckinForm(), sleepQuality: 4, workout: 8, diet: 7, energy: 3, weight: '82.44', sleepHours: '7.5', notes: ' ok ' });
  assert.deepEqual([good.valid, good.payload.weightKg, good.payload.sleepHours, good.payload.notes], [true, 82.4, 7.5, 'ok']);
  assert.equal(validateCheckinForm({ ...emptyCheckinForm(), sleepQuality: 4, workout: 8, diet: 7, energy: 3 }).payload.weightKg, null);
  const empty = validateCheckinForm(emptyCheckinForm());
  assert.deepEqual(Object.keys(empty.errors).sort(), ['diet', 'energy', 'sleepQuality', 'workout']);
  assert.equal(validateCheckinForm({ ...emptyCheckinForm(), sleepQuality: 6, workout: 11, diet: 0, energy: 5.5 }).valid, false);
  assert.equal(validateCheckinForm({ ...emptyCheckinForm(), sleepQuality: 3, workout: 3, diet: 3, energy: 3, weight: '19' }).errors.weight, 'ckErr_weight');
  assert.equal(validateCheckinForm({ ...emptyCheckinForm(), sleepQuality: 3, workout: 3, diet: 3, energy: 3, sleepHours: '30' }).errors.sleepHours, 'ckErr_sleepHours');
  assert.equal(validateCheckinForm({ ...emptyCheckinForm(), sleepQuality: 3, workout: 3, diet: 3, energy: 3, notes: 'x'.repeat(2001) }).errors.notes, 'ckErr_notes');
  const form = formFromCheckin({ weight_kg: '82.4', sleep_hours: null, sleep_quality_1_5: 4, workout_adherence_1_10: 8, diet_adherence_1_10: 7, energy_level_1_5: 3, client_notes: 'hi' });
  assert.deepEqual([form.weight, form.sleepHours, form.workout, form.notes], ['82.4', '', 8, 'hi']);
});

test('photos are JPG, PNG or WebP up to 5 MB and are named inside the client\'s own folder', () => {
  assert.equal(validateCheckinPhoto({ type: 'image/png', size: 1000 }), null);
  assert.equal(validateCheckinPhoto({ type: 'image/gif', size: 1000 }), 'ckErr_photoType');
  assert.equal(validateCheckinPhoto(null), 'ckErr_photoType');
  assert.equal(validateCheckinPhoto({ type: 'image/webp', size: MAX_CHECKIN_PHOTO_BYTES + 1 }), 'ckErr_photoSize');
  assert.equal(validateCheckinPhoto({ type: 'image/jpeg', size: MAX_CHECKIN_PHOTO_BYTES }), null);
  assert.equal(checkinPhotoPath('c1', '2026-11-23', 'front', { type: 'image/webp' }, 'u1'), 'c1/2026-11-23-front-u1.webp');
  assert.deepEqual([...PHOTO_SLOTS], ['front', 'side', 'back']);
});

test('the change since last week is worked out per number, and missing numbers stay unknown', () => {
  const rowsOut = diffCheckins(
    { weight_kg: '82.4', sleep_hours: null, sleep_quality_1_5: 4, workout_adherence_1_10: 6, diet_adherence_1_10: 7, energy_level_1_5: 3 },
    { weight_kg: '84.0', sleep_hours: '7', sleep_quality_1_5: 4, workout_adherence_1_10: 8, diet_adherence_1_10: 5, energy_level_1_5: 3 },
  );
  const byKey = Object.fromEntries(rowsOut.map((row) => [row.key, row]));
  assert.deepEqual([byKey.weight_kg.delta, byKey.weight_kg.direction], [-1.6, 'down']);
  assert.deepEqual([byKey.sleep_hours.delta, byKey.sleep_hours.direction, byKey.sleep_hours.value], [null, null, null]);
  assert.equal(byKey.workout_adherence_1_10.direction, 'down');
  assert.equal(byKey.diet_adherence_1_10.direction, 'up');
  assert.equal(byKey.energy_level_1_5.direction, 'same');
  assert.ok(diffCheckins({ weight_kg: 80 }, null).every((row) => row.delta === null));
});

test('the photo comparison offers the weeks that have a photo and starts with the first and the latest', () => {
  const week = (id, date, photos = {}) => ({ id, week_start_date: date, photo_paths: photos });
  const checkins = [week('a', '2026-11-02', { front: 'p1' }), week('b', '2026-11-09'), week('c', '2026-11-16', { front: 'p2', side: 'p3' }), week('d', '2026-11-23', { front: 'p4' })];
  assert.deepEqual(weeksWithPhoto(checkins, 'front').map((item) => item.id), ['d', 'c', 'a']);
  assert.deepEqual(defaultComparison(checkins, 'front'), { left: 'a', right: 'd' });
  assert.deepEqual(defaultComparison(checkins, 'side'), { left: '', right: 'c' });
  assert.deepEqual(defaultComparison(checkins, 'back'), { left: '', right: '' });
  assert.equal(photoCount(checkins[2]), 2);
});

// ---------------------------------------------------------------------------------------- the screens

test('clients get a check-in page with a badge when it is due, coaches an inbox and a tab on every client', () => {
  const routes = read('src/routes.js');
  assert.match(routes, /weeklyCheckin: \{ path: '\/weekly-checkin'.*access: 'client'/);
  assert.match(routes, /checkins: \{ path: '\/checkins'.*access: 'coach'/);
  const app = read('src/App.jsx');
  assert.ok(app.includes('<WeeklyCheckinPage />') && app.includes('<CheckinInboxPage />'));
  assert.match(read('src/components/AppShell.jsx'), /useCheckinBadge/);
  const clients = read('src/pages/ClientsPage.jsx');
  assert.match(clients, /detailTab === 'checkins'/);
  assert.match(clients, /<ClientCheckinsReview clientId=/);
  const card = read('src/components/CheckinReviewCard.jsx');
  assert.match(card, /reviewCheckin\(/);
  assert.match(card, /notifyClients\('checkin'/);
  assert.match(read('src/components/PhotoCompare.jsx'), /PHOTO_SLOTS/);
  assert.match(read('src/services/checkinService.js'), /createSignedUrls\(unique, SIGNED_URL_SECONDS\)/);
  assert.match(read('api/_lib/pushNotify.js'), /checkin: \{ table: 'weekly_checkins'/);
});

test('every text the check-in screens use exists in every language', () => {
  const sources = ['src/pages/WeeklyCheckinPage.jsx', 'src/pages/CheckinInboxPage.jsx', 'src/components/CheckinReviewCard.jsx', 'src/components/PhotoCompare.jsx', 'src/components/ClientCheckinsReview.jsx', 'src/services/checkinUtils.js', 'src/components/AppShell.jsx', 'src/pages/ClientsPage.jsx', 'src/routes.js'];
  const used = new Set();
  for (const file of sources) {
    for (const match of read(file).matchAll(/['"`]((?:ck[A-Z][A-Za-z]*|ckErr_[A-Za-z]+|navCheckins|navWeeklyCheckin|clientTabCheckins))['"`]/g)) used.add(match[1]);
  }
  for (const slot of PHOTO_SLOTS) used.add(`ckSlot_${slot}`);
  assert.ok(used.size >= 50, `${used.size} keys`);
  for (const locale of supportedLocales) {
    for (const key of used) assert.ok(translations[locale][key], `${locale}.${key}`);
  }
});

test('the check-in texts have the same placeholders in every language and Arabic is Arabic', () => {
  const keys = Object.keys(checkinTranslations.en);
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(checkinTranslations[locale]).sort(), [...keys].sort(), locale);
    for (const key of keys) assert.equal(placeholders(checkinTranslations[locale][key]), placeholders(checkinTranslations.en[key]), `${locale}.${key}`);
  }
  for (const key of ['ckTitle', 'ckSubmit', 'ckCompareTitle', 'navWeeklyCheckin', 'ckFeedbackSent']) assert.match(translations.ar[key], /[\u0600-\u06FF]/, key);
});

test('the push message for a reviewed check-in exists in every language, and no text was lost to question marks', () => {
  assert.ok(NOTIFICATION_TYPES.includes('checkin'));
  for (const locale of supportedLocales) {
    for (const type of NOTIFICATION_TYPES) {
      const message = buildPushMessage(type, locale);
      assert.doesNotMatch(`${message.title} ${message.body}`, /\?{2,}|[^\s]\?[a-zA-Z]/, `${locale}.${type}`);
    }
  }
  assert.equal(buildPushMessage('checkin', 'ar').url, '/weekly-checkin');
  assert.match(buildPushMessage('chat', 'ar').title, /[\u0600-\u06FF]/);
});
