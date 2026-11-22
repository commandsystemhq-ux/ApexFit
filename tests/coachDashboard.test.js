import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  DEFAULT_WEEKLY_TARGET, MAX_INSIGHTS, averageAdherence, buildInsights, daysSince, periodAdherence, relativeDays, revenueParts, summarizeDashboard, weeklyAdherence, weeklyGoal,
} from '../src/services/dashboardUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115002900_coach_dashboard.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  nagi: '00000000-0000-4000-8000-0000000000c3',
  bClient: '00000000-0000-4000-8000-0000000000c4',
};

let db;
const as = (userId) => createUserClient(db, userId);
const dashboard = async (userId = ids.coach, days = 30) => as(userId).rpc('get_coach_dashboard', { p_days: days });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.nagi, 'nagi@example.com'], [ids.bClient, 'b@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email, status) values
       ($1, $2, 'Sara Ali', 'sara@example.com', 'active'), ($1, $3, 'Omar Hassan', 'omar@example.com', 'archived'), ($1, $4, 'Nagi Salem', 'nagi@example.com', 'active'),
       ($5, $6, 'Bea Fan', 'b@example.com', 'active')`,
    [ids.coach, ids.sara, ids.omar, ids.nagi, ids.other, ids.bClient],
  );
});

const day = (offset) => `current_date - ${offset}`;
async function logWorkout(client, offset, title = 'Workout') {
  await db.query(`insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, ${day(offset)}, $2)`, [client, title]);
}

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('a coach with nothing yet gets real zeros, and their clients are listed with empty activity', async () => {
  await db.query('delete from public.coach_clients where coach_id = $1 and client_id <> $2', [ids.coach, ids.nagi]);
  const { data, error } = await dashboard();
  assert.equal(error, null, error?.message);
  assert.deepEqual([data.active_clients, data.plans_created, data.revenue_month], [1, 0, []]);
  assert.equal(data.clients.length, 1);
  assert.equal(data.clients[0].name, 'Nagi Salem');
  assert.deepEqual([data.clients[0].workout_days_7, data.clients[0].workout_days_period, data.clients[0].last_workout_on, data.clients[0].last_food_on, data.clients[0].weekly_target, data.clients[0].unread_messages], [0, 0, null, null, null, 0]);
  await db.query('delete from public.coach_clients where coach_id = $1', [ids.coach]);
  assert.deepEqual((await dashboard()).data, { days: 30, active_clients: 0, plans_created: 0, revenue_month: [], clients: [] });
});

test('active clients, plans and this month\'s income count only this coach\'s own records', async () => {
  await db.query("insert into public.training_programs (coach_id, title) values ($1, 'A1'), ($1, 'A2'), ($2, 'B1')", [ids.coach, ids.other]);
  const invoice = (number, coach, client, cents, currency, status, paidAt) => db.query(
    `insert into public.invoices (invoice_number, coach_id, client_id, description, amount_cents, currency, status, paid_at) values ($1, $2, $3, 'Plan', $4, $5, $6, ${paidAt})`,
    [number, coach, client, cents, currency, status],
  );
  await invoice('I-1', ids.coach, ids.sara, 5000, 'usd', 'paid', 'now()');
  await invoice('I-2', ids.coach, ids.sara, 20000, 'egp', 'paid', 'now()');
  await invoice('I-3', ids.coach, ids.nagi, 2500, 'usd', 'paid', 'now()');
  await invoice('I-4', ids.coach, ids.sara, 9900, 'usd', 'paid', "date_trunc('month', now()) - interval '2 days'");
  await invoice('I-5', ids.coach, ids.sara, 7700, 'usd', 'open', 'null');
  await invoice('I-6', ids.coach, ids.sara, 6600, 'usd', 'void', 'null');
  await invoice('I-7', ids.other, ids.bClient, 88800, 'usd', 'paid', 'now()');
  await db.query(
    `insert into public.store_orders (buyer_client_id, coach_id, product_title, amount_cents, currency, status, purchased_at) values
       ($1, $2, 'Program', 1000, 'usd', 'paid', now()), ($1, $2, 'Old', 4000, 'usd', 'paid', date_trunc('month', now()) - interval '1 day'),
       ($1, $2, 'Waiting', 3000, 'usd', 'pending', null), ($3, $4, 'Other', 5000, 'usd', 'paid', now())`,
    [ids.sara, ids.coach, ids.bClient, ids.other],
  );
  const { data } = await dashboard();
  assert.equal(data.active_clients, 2);
  assert.equal(data.plans_created, 2);
  assert.deepEqual(data.revenue_month, [{ currency: 'egp', cents: 20000 }, { currency: 'usd', cents: 8500 }]);
  assert.equal((await dashboard(ids.other)).data.revenue_month.find((row) => row.currency === 'usd').cents, 93800);
});

test('workout and food activity, the weekly goal and unread messages are counted per client', async () => {
  await db.query("insert into public.client_intake_forms (client_id, primary_goal, experience_level, training_days_per_week, equipment_access) values ($1, 'strength', 'beginner', 4, 'full_gym')", [ids.sara]);
  await logWorkout(ids.sara, 0);
  await logWorkout(ids.sara, 0, 'Second session the same day');
  await logWorkout(ids.sara, 2);
  await logWorkout(ids.sara, 10);
  await logWorkout(ids.sara, 45);
  await logWorkout(ids.omar, 1);
  await db.query(`insert into public.client_food_logs (client_id, logged_on, meal_type, food_name, calories) values ($1, ${day(1)}, 'lunch', 'Rice', 300), ($1, ${day(1)}, 'dinner', 'Chicken', 400), ($1, ${day(20)}, 'lunch', 'Old', 100)`, [ids.sara]);
  await db.query(
    "insert into public.chat_messages (sender_id, receiver_id, message_text, is_read) values ($1, $2, 'a', false), ($1, $2, 'b', false), ($1, $2, 'c', true), ($2, $1, 'mine', false), ($3, $2, 'other', false)",
    [ids.sara, ids.coach, ids.nagi],
  );
  const sara = (await dashboard()).data.clients.find((client) => client.client_id === ids.sara);
  assert.deepEqual(
    [sara.weekly_target, sara.workout_days_7, sara.workout_days_period, sara.food_days_7, sara.unread_messages],
    [4, 2, 3, 1, 2],
  );
  assert.ok(sara.last_workout_on && sara.last_food_on);
  const nagi = (await dashboard()).data.clients.find((client) => client.client_id === ids.nagi);
  assert.equal(nagi.unread_messages, 1);
  assert.equal((await dashboard(ids.coach, 60)).data.clients.find((client) => client.client_id === ids.sara).workout_days_period, 4);
});

test('archived clients and other coaches\' clients never appear, and nobody else may ask', async () => {
  const { data } = await dashboard();
  assert.deepEqual(data.clients.map((client) => client.name), ['Nagi Salem', 'Sara Ali']);
  assert.ok(!data.clients.some((client) => [ids.omar, ids.bClient].includes(client.client_id)));
  assert.deepEqual((await dashboard(ids.other)).data.clients.map((client) => client.client_id), [ids.bClient]);
  assert.match((await dashboard(ids.sara)).error.message, /active coach/);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coach]);
  assert.match((await dashboard()).error.message, /active coach/);
});

// ------------------------------------------------------------------------------------------ the numbers

const NOW = new Date('2026-11-20T10:00:00Z');
const client = (overrides = {}) => ({
  client_id: 'c', name: 'Sara', joined_at: '2026-09-01T00:00:00Z', weekly_target: 4, workout_days_7: 0, workout_days_period: 0, last_workout_on: null,
  food_days_7: 0, last_food_on: null, unread_messages: 0, ...overrides,
});

test('adherence is workouts logged against the weekly goal, and a missing goal means 3 days', () => {
  assert.equal(DEFAULT_WEEKLY_TARGET, 3);
  assert.equal(weeklyGoal(client({ weekly_target: null })), 3);
  assert.equal(weeklyGoal(client({ weekly_target: 5 })), 5);
  assert.equal(weeklyAdherence(client({ workout_days_7: 0 })), 0);
  assert.equal(weeklyAdherence(client({ workout_days_7: 2 })), 50);
  assert.equal(weeklyAdherence(client({ workout_days_7: 4 })), 100);
  assert.equal(weeklyAdherence(client({ workout_days_7: 7 })), 100);
  // 30 days at 4 a week is about 17 workouts.
  assert.equal(periodAdherence(client({ workout_days_period: 0 }), 30, NOW), 0);
  assert.equal(periodAdherence(client({ workout_days_period: 17 }), 30, NOW), 99);
  assert.equal(periodAdherence(client({ workout_days_period: 40 }), 30, NOW), 100);
  // A client who joined 2 days ago is judged on 3 days, not 30.
  const fresh = client({ joined_at: '2026-11-18T08:00:00Z', weekly_target: 7, workout_days_period: 3 });
  assert.equal(periodAdherence(fresh, 30, NOW), 100);
});

test('the average is a real 0% with no clients or no workouts, and an average of the clients otherwise', () => {
  assert.equal(averageAdherence([], 30, NOW), 0);
  assert.equal(averageAdherence(undefined, 30, NOW), 0);
  assert.equal(averageAdherence([client(), client({ client_id: 'd' })], 30, NOW), 0);
  assert.equal(averageAdherence([client({ workout_days_period: 17 }), client({ client_id: 'd', workout_days_period: 0 })], 30, NOW), 50);
});

test('income is shown in each currency that was received, and a plain 0 when nothing came in', () => {
  assert.deepEqual(revenueParts([], 'en'), { primary: '0', others: [] });
  assert.deepEqual(revenueParts([{ currency: 'usd', cents: 0 }], 'en'), { primary: '0', others: [] });
  const both = revenueParts([{ currency: 'egp', cents: 20000 }, { currency: 'usd', cents: 8500 }], 'en');
  assert.match(both.primary, /200/);
  assert.match(both.primary, /EGP/);
  assert.equal(both.others.length, 1);
  assert.match(both.others[0], /\$85\.00/);
});

test('days are counted in whole days and an unknown date stays unknown', () => {
  assert.equal(daysSince('2026-11-20', NOW), 0);
  assert.equal(daysSince('2026-11-17', NOW), 3);
  assert.equal(daysSince('2026-11-20T23:00:00Z', NOW), 0);
  assert.equal(daysSince(null, NOW), null);
  assert.equal(daysSince('not a date', NOW), null);
  assert.equal(daysSince('2026-12-01', NOW), 0);
});

test('relative days read naturally in each language, with its own plural forms', () => {
  assert.equal(relativeDays(0, 'en'), 'today');
  assert.equal(relativeDays(1, 'en'), 'yesterday');
  assert.equal(relativeDays(6, 'en'), '6 days ago');
  assert.match(relativeDays(6, 'ar'), /أيام/);
  assert.match(relativeDays(12, 'ar'), /يومًا/);
  assert.match(relativeDays(6, 'de'), /Tagen/);
  assert.equal(relativeDays(null, 'en'), null);
});

function insightsFor(rows) {
  return buildInsights(summarizeDashboard({ days: 30, clients: rows }, { now: NOW }).clients);
}

test('insights are built from what clients really did', () => {
  const rows = [
    client({ client_id: 'late', name: 'Late', last_workout_on: '2026-11-08', workout_days_7: 0, last_food_on: '2026-11-19' }),
    client({ client_id: 'never', name: 'Never', joined_at: '2026-11-10T00:00:00Z', last_food_on: '2026-11-19' }),
    client({ client_id: 'low', name: 'Low', last_workout_on: '2026-11-17', workout_days_7: 1, last_food_on: '2026-11-19' }),
    client({ client_id: 'good', name: 'Good', last_workout_on: '2026-11-20', workout_days_7: 4, last_food_on: '2026-11-20' }),
    client({ client_id: 'nofood', name: 'NoFood', last_workout_on: '2026-11-19', workout_days_7: 2, last_food_on: '2026-11-10' }),
    client({ client_id: 'nofoodnever', name: 'NoFoodEver', last_workout_on: '2026-11-19', workout_days_7: 2 }),
    client({ client_id: 'chat', name: 'Chat', last_workout_on: '2026-11-19', workout_days_7: 2, last_food_on: '2026-11-19', unread_messages: 3 }),
    client({ client_id: 'new', name: 'Brand new', joined_at: '2026-11-19T00:00:00Z' }),
  ];
  const { items } = insightsFor(rows);
  const byClient = (id) => items.filter((item) => item.clientId === id).map((item) => item.type);
  assert.deepEqual(byClient('late'), ['late']);
  assert.deepEqual(byClient('never'), ['lateNever']);
  assert.deepEqual(byClient('low'), ['low']);
  assert.deepEqual(byClient('good'), ['onTrack']);
  assert.deepEqual(byClient('nofood'), ['noFood']);
  assert.deepEqual(byClient('nofoodnever'), ['noFoodNever']);
  assert.deepEqual(byClient('chat'), ['unread']);
  assert.deepEqual(byClient('new'), [], 'a client who joined yesterday is not nagged');
  assert.equal(items.find((item) => item.type === 'late').values.days, 12);
  assert.deepEqual(items.find((item) => item.type === 'low').values, { done: 1, goal: 4 });
  // Warnings first, then information, then good news.
  const order = items.map((item) => item.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ['warning', 'info', 'success'].indexOf(a) - ['warning', 'info', 'success'].indexOf(b)));
});

test('there are no insights without clients, and the list is capped with a count of what is hidden', () => {
  assert.deepEqual(buildInsights([]), { items: [], hidden: 0 });
  assert.deepEqual(buildInsights(undefined), { items: [], hidden: 0 });
  const many = Array.from({ length: 12 }, (_, index) => client({ client_id: `c${index}`, name: `Client ${String(index).padStart(2, '0')}`, last_workout_on: '2026-10-01' }));
  const { items, hidden } = insightsFor(many);
  assert.equal(items.length, MAX_INSIGHTS);
  assert.ok(hidden >= 4);
});

test('the summary has real numbers for every card', () => {
  const summary = summarizeDashboard({
    days: 30, active_clients: 2, plans_created: 5, revenue_month: [{ currency: 'usd', cents: 9900 }],
    clients: [client({ workout_days_7: 4, workout_days_period: 17 }), client({ client_id: 'd', name: 'Nagi', workout_days_period: 0 })],
  }, { now: NOW });
  assert.deepEqual([summary.activeClients, summary.plansCreated, summary.avgAdherence], [2, 5, 50]);
  assert.deepEqual(summary.clients.map((row) => [row.weekly, row.period]), [[100, 99], [0, 0]]);
  const empty = summarizeDashboard({}, { now: NOW });
  assert.deepEqual([empty.activeClients, empty.plansCreated, empty.avgAdherence, empty.clients.length], [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------------------- the screens

test('the dashboard reads real data, shows zeros instead of dashes and links to each client\'s profile', () => {
  const page = read('src/pages/DashboardPage.jsx');
  for (const piece of ['getCoachDashboard', 'summarizeDashboard', 'buildInsights', 'openProfile', '/clients?client=', 'dashLoadError', "aria-busy"]) assert.ok(page.includes(piece), piece);
  assert.doesNotMatch(page, /awaitingData|dashboard-chart-empty/);
  // The only dash on the page is the one shown when the numbers could not be loaded.
  assert.equal((page.match(/\\u2014/g) || []).length, 1);
  assert.match(page, /status === 'error' \? '\\u2014'/);
  assert.match(read('src/services/dashboardService.js'), /rpc\('get_coach_dashboard'/);

  const clients = read('src/pages/ClientsPage.jsx');
  assert.match(clients, /searchParams\.get\('client'\)/);
  assert.match(clients, /id=\{`client-\$\{client\.client_id\}`\}/);
});

test('every language has the dashboard texts and the placeholders survive', () => {
  const keys = Object.keys(translations.en).filter((key) => /^dash(Cap|Ins_|Load|Retry|NoIns|More|Open|OfGoal|Adherence|Joined|Last|Period|Never)/.test(key));
  assert.ok(keys.length >= 20, `${keys.length} keys`);
  for (const locale of supportedLocales) {
    for (const key of keys) {
      assert.ok(translations[locale][key], `${locale}.${key}`);
      const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
      assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale}.${key} placeholders`);
    }
  }
  assert.match(translations.ar.dashIns_late, /\{when\}/);
  assert.match(translations.ar.dashCapActive, /[\u0600-\u06FF]/);
});
