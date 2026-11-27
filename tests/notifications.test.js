import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  NOTIFICATION_ICONS, NOTIFICATION_TYPES, countUnread, describeNotification, formatInvoiceAmount, formatNotificationAge, markAllReadLocally, markReadLocally,
  mergeNotifications, safeNotificationLink, unreadLabel,
} from '../src/services/notificationUtils.js';
import { fillTemplate } from '../src/services/textTemplate.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115004300_notifications.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
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
const inbox = async (userId) => ok(as(userId).rpc('get_my_notifications', {}));
const stored = (userId, type) => rows('select * from public.notifications where user_id = $1 and ($2::text is null or type = $2) order by created_at', [userId, type ?? null]);

before(async () => {
  db = await createTestDatabase();
  monday = (await rows("select date_trunc('week', current_date)::date::text as d"))[0].d;
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; truncate public.exercises cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Amal', brandName: 'Amal Fitness' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara Ali' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client', fullName: 'Omar Hassan' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara Ali', 'sara@example.com'), ($3, $4, 'Omar Hassan', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
});

// ------------------------------------------------------------------------------------------ the database

test('the migration is in manual-setup.sql, can run again, and the table is protected', async () => {
  const migration = read('supabase/migrations/20261115004300_notifications.sql').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const [table] = await rows("select relrowsecurity from pg_class where oid = 'public.notifications'::regclass");
  assert.equal(table.relrowsecurity, true);
  assert.ok((await rows("select 1 from pg_policies where tablename = 'notifications'")).length >= 1);
});

test('a chat message notifies its receiver with the sender, the kind and the page to open', async () => {
  await ok(as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: 'Hello coach', p_client_ref: null }));
  const coach = await inbox(ids.coach);
  assert.equal(coach.unread_count, 1);
  assert.equal(coach.items[0].type, 'message');
  assert.equal(coach.items[0].payload.sender_name, 'Sara Ali');
  assert.equal(coach.items[0].payload.kind, 'text');
  assert.equal(coach.items[0].link, `/messages?with=${ids.sara}`);
  assert.equal((await inbox(ids.sara)).unread_count, 0, 'the sender gets nothing');

  await ok(as(ids.coach).rpc('send_chat_message', { p_receiver_id: ids.sara, p_text: 'Hi Sara', p_client_ref: null }));
  const sara = await inbox(ids.sara);
  assert.equal(sara.items[0].link, '/coach-hub');
  assert.equal(sara.items[0].payload.sender_name, 'Amal Fitness', 'a coach is shown by brand name');
});

test('several messages from the same person become one notification with a count; reading the chat clears it', async () => {
  for (const text of ['one', 'two', 'three']) await ok(as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: text, p_client_ref: null }));
  const coach = await inbox(ids.coach);
  assert.equal(coach.items.length, 1);
  assert.equal(coach.items[0].payload.count, 3);
  assert.equal(coach.unread_count, 1);

  await ok(as(ids.coach).rpc('mark_chat_read', { p_partner_id: ids.sara }));
  assert.equal((await inbox(ids.coach)).unread_count, 0);
  await ok(as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: 'four', p_client_ref: null }));
  const again = await inbox(ids.coach);
  assert.equal(again.items.length, 2, 'a message after reading starts a new notification');
  assert.equal(again.unread_count, 1);
});

test('a coach broadcast notifies the client', async () => {
  await db.query("insert into public.coach_messages (batch_id, coach_id, client_id, kind, body) values (gen_random_uuid(), $1, $2, 'note', 'Great week')", [ids.coach, ids.sara]);
  const sara = await inbox(ids.sara);
  assert.equal(sara.items[0].payload.kind, 'broadcast');
  assert.equal(sara.items[0].link, '/coach-hub');
});

test('a weekly check-in notifies the coach, and the review notifies the client', async () => {
  const answers = { p_week_start: monday, p_weight_kg: 80, p_sleep_hours: 7, p_sleep_quality: 4, p_workout_adherence: 8, p_diet_adherence: 7, p_energy: 3, p_notes: 'ok', p_photo_paths: {} };
  const checkin = await ok(as(ids.sara).rpc('submit_weekly_checkin', answers));
  const coach = await inbox(ids.coach);
  assert.equal(coach.items[0].type, 'checkin_submitted');
  assert.equal(coach.items[0].payload.client_name, 'Sara Ali');
  assert.equal(coach.items[0].link, '/checkins');

  await ok(as(ids.coach).rpc('review_weekly_checkin', { p_checkin_id: checkin.id, p_feedback: 'Keep going' }));
  const sara = await inbox(ids.sara);
  assert.equal(sara.items[0].type, 'checkin_reviewed');
  assert.equal(sara.items[0].payload.coach_name, 'Amal Fitness');
  assert.equal(sara.items[0].link, '/weekly-checkin');
});

test('invoices notify the client when sent and confirmed, and the coach when the client reports a payment', async () => {
  const invoiceId = await ok(as(ids.coach).rpc('create_invoice', { p_client_id: ids.sara, p_description: 'Monthly coaching', p_amount_cents: 12000, p_currency: 'usd', p_due_date: null }));
  const created = (await inbox(ids.sara)).items[0];
  assert.equal(created.type, 'invoice_new');
  assert.equal(created.payload.amount_cents, 12000);
  assert.equal(created.link, '/coach-hub?tab=billing');

  await ok(as(ids.sara).rpc('report_invoice_payment', { p_invoice_id: invoiceId }));
  const reported = (await inbox(ids.coach)).items[0];
  assert.equal(reported.type, 'invoice_reported');
  assert.equal(reported.payload.client_name, 'Sara Ali');
  assert.equal(reported.link, '/invoicing');

  await ok(as(ids.coach).rpc('confirm_invoice_payment', { p_invoice_id: invoiceId, p_method: 'bank_transfer', p_reference: null }));
  assert.deepEqual((await stored(ids.sara)).map((row) => row.type), ['invoice_new', 'invoice_paid']);
});

test('a progression suggestion notifies the coach and opens the client', async () => {
  const [{ id: exercise }] = await rows("insert into public.exercises (slug, name, category, difficulty, is_published) values ('squat', 'Squat', 'strength', 'beginner', true) returning id");
  await db.query("insert into public.progression_suggestions (coach_id, client_id, exercise_id, kind, current_weight_kg, suggested_weight_kg) values ($1, $2, $3, 'weight', 50, 55)", [ids.coach, ids.sara, exercise]);
  const coach = await inbox(ids.coach);
  assert.equal(coach.items[0].type, 'progression');
  assert.equal(coach.items[0].link, `/clients?client=${ids.sara}`);
});

test('people read, count and mark only their own notifications', async () => {
  await ok(as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: 'Hi', p_client_ref: null }));
  await ok(as(ids.omar).rpc('send_chat_message', { p_receiver_id: ids.other, p_text: 'Hi', p_client_ref: null }));
  const [mine] = await stored(ids.coach);
  assert.equal(await ok(as(ids.coach).rpc('get_my_unread_notification_count')), 1);
  assert.deepEqual((await as(ids.coach).from('notifications')).data.map((row) => row.id), [mine.id]);
  assert.deepEqual((await as(ids.sara).from('notifications')).data, []);

  await ok(as(ids.other).rpc('mark_notification_read', { p_id: mine.id }));
  assert.equal((await stored(ids.coach))[0].read_at, null, 'someone else cannot mark it');
  await ok(as(ids.coach).rpc('mark_notification_read', { p_id: mine.id }));
  assert.ok((await stored(ids.coach))[0].read_at);
  assert.equal(await ok(as(ids.coach).rpc('mark_all_notifications_read')), 0);
  assert.equal((await inbox(ids.other)).unread_count, 1, 'the other coach still has theirs');
});

test('mark all as read clears every unread notification of the caller only', async () => {
  await ok(as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: 'Hi', p_client_ref: null }));
  await db.query("insert into public.coach_messages (batch_id, coach_id, client_id, kind, body) values (gen_random_uuid(), $1, $2, 'note', 'x')", [ids.coach, ids.sara]);
  await ok(as(ids.omar).rpc('send_chat_message', { p_receiver_id: ids.other, p_text: 'Hi', p_client_ref: null }));
  assert.equal(await ok(as(ids.coach).rpc('mark_all_notifications_read')), 1);
  assert.equal((await inbox(ids.coach)).unread_count, 0);
  assert.equal((await inbox(ids.sara)).unread_count, 1);
  assert.equal((await inbox(ids.other)).unread_count, 1);
});

test('nobody writes notifications directly or calls the creating function', async () => {
  const sara = as(ids.sara);
  const insert = await sara.sql("insert into public.notifications (user_id, type) values ($1, 'message')", [ids.sara]);
  assert.match(insert.error.message, /permission denied/);
  await ok(as(ids.coach).rpc('send_chat_message', { p_receiver_id: ids.sara, p_text: 'Hi', p_client_ref: null }));
  const update = await sara.sql('update public.notifications set read_at = null where user_id = $1', [ids.sara]);
  assert.match(update.error.message, /permission denied/);
  const remove = await sara.sql('delete from public.notifications where user_id = $1', [ids.sara]);
  assert.match(remove.error.message, /permission denied/);
  const create = await sara.sql("select public.create_notification($1, 'message', '{}'::jsonb)", [ids.sara]);
  assert.match(create.error.message, /permission denied/);
  const anonymous = await db.query('select count(*)::int as n from public.notifications');
  assert.ok(anonymous.rows[0].n >= 1);
});

test('links must stay inside the app and the list keeps the newest 200', async () => {
  await assert.rejects(db.query("insert into public.notifications (user_id, type, link) values ($1, 'message', '//evil.example')", [ids.sara]), /violates check constraint/);
  await assert.rejects(db.query("insert into public.notifications (user_id, type, link) values ($1, 'message', 'https://evil.example')", [ids.sara]), /violates check constraint/);
  await db.exec(`select public.create_notification('${ids.sara}', 'reminder', jsonb_build_object('n', g), '/reminders', 'k' || g) from generate_series(1, 205) g`);
  assert.equal((await stored(ids.sara)).length, 200);
  const page = await ok(as(ids.sara).rpc('get_my_notifications', { p_limit: 500 }));
  assert.equal(page.items.length, 100, 'one page is capped at 100');
});

test('a failure while creating a notification never blocks the action that caused it', async () => {
  await db.exec('alter table public.notifications rename to notifications_hidden');
  try {
    const sent = await as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: 'Still delivered', p_client_ref: null });
    assert.equal(sent.error, null, sent.error?.message);
    assert.equal((await rows("select count(*)::int as n from public.chat_messages where message_text = 'Still delivered'"))[0].n, 1);
  } finally {
    await db.exec('alter table public.notifications_hidden rename to notifications');
  }
});

// ------------------------------------------------------------------------------------------ the app

test('every kind of notification has an icon, a title and a body in every language', () => {
  for (const locale of supportedLocales) {
    const t = (key) => translations[locale][key];
    for (const type of NOTIFICATION_TYPES) {
      assert.ok(NOTIFICATION_ICONS[type], `${type} icon`);
      assert.ok(t(`notifTitle_${type}`), `${locale} title ${type}`);
      if (type === 'message') for (const kind of ['text', 'voice', 'image', 'broadcast']) assert.ok(t(`notifBody_message_${kind}`), `${locale} ${kind}`);
      else if (type !== 'reminder') assert.ok(t(`notifBody_${type}`), `${locale} body ${type}`);
    }
    for (const key of ['notifBell', 'notifTitle', 'notifMarkAll', 'notifEmpty', 'notifUnread', 'notifTitle_unknown', 'notifBody_reminderFromCoach']) assert.ok(t(key), `${locale} ${key}`);
  }
  assert.match(translations.ar.notifBody_invoice_new, /[\u0600-\u06FF]/);
});

test('each translation keeps the same placeholders in every language', () => {
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of Object.keys(translations.en).filter((name) => name.startsWith('notifBody_'))) {
    for (const locale of supportedLocales) assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale} ${key}`);
  }
});

test('notifications are worded from their details in the reader language', () => {
  const t = (key) => translations.en[key];
  const message = describeNotification({ type: 'message', payload: { sender_name: 'Sara', kind: 'voice', count: 3 } }, t);
  assert.deepEqual(message, { title: 'New message', body: 'Sara sent you a voice message. (3)' });
  const invoice = describeNotification({ type: 'invoice_new', payload: { coach_name: 'Amal', invoice_number: 'INV-7', amount_cents: 12000, currency: 'usd' } }, t, 'en');
  assert.equal(invoice.body, 'Invoice INV-7 for $120.00 from Amal.');
  assert.equal(describeNotification({ type: 'checkin_submitted', payload: { client_name: 'Omar' } }, t).body, 'Omar submitted a weekly check-in.');
  const reminder = describeNotification({ type: 'reminder', payload: { title: 'Drink water', message: 'A glass', from_coach: true, coach_name: 'Amal' } }, t);
  assert.deepEqual(reminder, { title: 'Drink water', body: 'A glass · From Amal' });
  assert.equal(describeNotification({ type: 'something-new', payload: {} }, t).title, 'Notification');
  assert.equal(formatInvoiceAmount(12050, 'eur', 'en'), '€120.50');
  assert.equal(formatInvoiceAmount(500, 'zzz-not-a-currency', 'en'), '5.00');
  assert.equal(fillTemplate('Hi {name} {missing}', { name: 'Sara' }), 'Hi Sara {missing}');
});

test('links, ages, the unread label and list updates', () => {
  assert.equal(safeNotificationLink('/messages?with=abc-123'), '/messages?with=abc-123');
  assert.equal(safeNotificationLink('//evil.example'), null);
  assert.equal(safeNotificationLink('https://evil.example'), null);
  assert.equal(safeNotificationLink('/a b'), null);
  assert.equal(safeNotificationLink(null), null);
  assert.equal(unreadLabel(7), '7');
  assert.equal(unreadLabel(120), '99+');

  const now = new Date('2026-11-20T12:00:00Z');
  const label = (iso) => formatNotificationAge(iso, 'en', now);
  assert.equal(label('2026-11-20T11:59:30Z'), 'now');
  assert.equal(label('2026-11-20T11:55:00Z'), '5 min');
  assert.equal(label('2026-11-20T09:00:00Z'), '3 h');
  assert.equal(label('2026-11-18T12:00:00Z'), '2 d');
  assert.match(label('2026-10-01T12:00:00Z'), /Oct/);
  assert.equal(label('not a date'), '');

  const a = { id: 'a', created_at: '2026-11-20T10:00:00Z', read_at: null };
  const b = { id: 'b', created_at: '2026-11-20T11:00:00Z', read_at: null };
  const merged = mergeNotifications([a], [b, { ...a, read_at: '2026-11-20T11:30:00Z' }]);
  assert.deepEqual(merged.map((item) => item.id), ['b', 'a']);
  assert.equal(countUnread(merged), 1);
  assert.equal(countUnread(markAllReadLocally(merged)), 0);
  assert.equal(markReadLocally(merged, 'b')[0].is_read, true);
});

test('the bell sits in the top bar for coaches and clients and follows the page direction', () => {
  const shell = read('src/components/AppShell.jsx');
  assert.match(shell, /<NotificationBell userId=\{user\?\.id\} enabled=\{role === 'coach' \|\| role === 'client'\} \/>/);
  const bell = read('src/components/NotificationBell.jsx');
  assert.match(bell, /notifMarkAll/);
  assert.match(bell, /markAllRead/);
  assert.match(bell, /safeNotificationLink/);
  const css = read('src/styles/app.css');
  assert.match(css, /\.notif-menu \{[^}]*inset-inline-end: 0;/, 'the menu opens towards the inner side in both reading directions');
  assert.match(css, /\.notif-count \{[^}]*inset-inline-end: -6px;/);
});
