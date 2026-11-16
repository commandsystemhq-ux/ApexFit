import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runJack } from '../api/_lib/jackAgent.js';
import { executeTool, navigablePages, toolSpecsForRole } from '../api/_lib/jackTools.js';
import { inferProvider, parseWhen } from '../api/_lib/jackGrowthTools.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Jack's store, team and video session tools against the real schema with row-level security enforced.

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  saraK: '00000000-0000-4000-8000-0000000000c2',
  omar: '00000000-0000-4000-8000-0000000000c3',
  bFan: '00000000-0000-4000-8000-0000000000c4',
};
const TODAY = new Date().toISOString().slice(0, 10);
const daysFromNow = (days, time = '18:00') => `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}`;

let db;
let zoomCalls;
let notifyCalls;

const videoDeps = () => ({
  zoom: {
    isConfigured: () => true,
    createMeeting: async (details) => {
      zoomCalls.push({ type: 'create', details });
      return { id: '999', url: 'https://us02web.zoom.us/j/999?pwd=abc', passcode: 'abc123' };
    },
    deleteMeeting: async (id) => zoomCalls.push({ type: 'delete', id }),
  },
  notify: async (_context, type, id) => notifyCalls.push({ type, id }),
});

const ctx = (userId, role, extra = {}) => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today: TODAY, utcOffsetMinutes: 120, videoDeps: videoDeps(), access: { role }, ...extra });
const coach = () => ctx(ids.coachA, 'coach');
const client = (userId = ids.sara) => ctx(userId, 'client');
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);
const rpc = async (userId, name, args) => {
  const result = await createUserClient(db, userId).rpc(name, args);
  assert.equal(result.error, null, result.error?.message);
  return result.data;
};

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  zoomCalls = [];
  notifyCalls = [];
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.saraK, 'sarak@example.com'], [ids.omar, 'omar@example.com'], [ids.bFan, 'b@example.com']]) {
    await addUser(db, { id, email, role: 'client' });
  }
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email) values
       ($1, $2, 'Sara Ali', 'sara@example.com'), ($1, $3, 'Sara Khan', 'sarak@example.com'), ($1, $4, 'Omar Hassan', 'omar@example.com'), ($5, $6, 'Bea Fan', 'b@example.com')`,
    [ids.coachA, ids.sara, ids.saraK, ids.omar, ids.coachB, ids.bFan],
  );
  await db.query("insert into public.training_programs (coach_id, title, status) values ($1, 'Strength Basics', 'published'), ($1, 'Hypertrophy Plan', 'published'), ($2, 'Secret Plan', 'published')", [ids.coachA, ids.coachB]);
});

test('parseWhen understands local times, explicit zones and rejects nonsense', () => {
  assert.equal(parseWhen('2026-11-20T18:00', 120).toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(parseWhen('2026-11-20T18:00', -300).toISOString(), '2026-11-20T23:00:00.000Z');
  assert.equal(parseWhen('2026-11-20T18:00:00+02:00', 999).toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(parseWhen('2026-11-20T18:00Z', 120).toISOString(), '2026-11-20T18:00:00.000Z');
  assert.throws(() => parseWhen('tomorrow evening'), /must look like/);
  assert.throws(() => parseWhen(''), /required/);
  assert.equal(inferProvider(undefined, 'https://us02web.zoom.us/j/1'), 'zoom');
  assert.equal(inferProvider(undefined, 'https://meet.google.com/abc-defg-hij'), 'google_meet');
  assert.equal(inferProvider(undefined, 'https://video.example.org/x'), 'custom');
  assert.equal(inferProvider(undefined, ''), 'zoom');
  assert.equal(inferProvider('custom', 'https://us02web.zoom.us/j/1'), 'custom');
});

test('create_store_product puts a program on sale that the coach\'s clients can then see', async () => {
  const created = await executeTool('create_store_product', { program: 'strength basics', price: 29.9, currency: 'eur', description: '8 weeks' }, coach());
  assert.equal(created.ok, true, created.error);
  assert.deepEqual([created.result.price, created.result.currency, created.result.published, created.result.public_store_path], [29.9, 'eur', true, `/shop/${ids.coachA}`]);
  const [product] = await rows('select * from public.store_products');
  assert.deepEqual([product.coach_id, product.title, product.price_cents, product.currency, product.is_published], [ids.coachA, 'Strength Basics', 2990, 'eur', true]);

  const store = await executeTool('get_my_store', {}, client());
  assert.deepEqual(store.result.products, [{ title: 'Strength Basics', price: '€29.90', owned: false }]);
  assert.equal((await executeTool('get_my_store', {}, client(ids.bFan))).result.products.length, 0);

  const free = await executeTool('create_store_product', { program: 'Hypertrophy', title: 'Free taster', price: 0, publish: false }, coach());
  assert.equal(free.result.published, false);
  assert.deepEqual((await executeTool('get_my_store', {}, client())).result.products.map((item) => item.title), ['Strength Basics']);
});

test('create_store_product rejects bad input and other coaches\' programs without writing anything', async () => {
  assert.match((await executeTool('create_store_product', { program: 'Secret Plan', price: 10 }, coach())).error, /No program matches/);
  assert.match((await executeTool('create_store_product', { program: 'Strength Basics', price: -5 }, coach())).error, /price/);
  assert.match((await executeTool('create_store_product', { program: 'Strength Basics', price: 0.2 }, coach())).error, /not valid/);
  assert.match((await executeTool('create_store_product', { program: 'Strength Basics', price: 10, currency: 'xyz' }, coach())).error, /not valid/);
  assert.equal((await executeTool('create_store_product', { program: 'Strength Basics', price: 'abc' }, coach())).ok, false);
  assert.equal(await count('select count(*) as n from public.store_products'), 0);
});

test('get_store_sales summarizes paid orders and keeps test purchases visible', async () => {
  await executeTool('create_store_product', { program: 'Strength Basics', price: 29 }, coach());
  const [{ id: productId }] = await rows('select id from public.store_products');
  for (const buyer of [ids.sara, ids.omar]) {
    const { order_id: orderId } = await rpc(buyer, 'begin_store_purchase', { p_product_id: productId });
    await db.query("select public.complete_store_order($1, null, null, null, null, 'demo')", [orderId]);
  }
  const { order_id: pending } = await rpc(ids.saraK, 'begin_store_purchase', { p_product_id: productId });
  assert.ok(pending);

  const sales = await executeTool('get_store_sales', {}, coach());
  assert.equal(sales.ok, true, sales.error);
  assert.deepEqual([sales.result.orders_paid, sales.result.open_checkouts], [2, 1]);
  assert.deepEqual(sales.result.revenue, [{ currency: 'usd', amount: 58 }]);
  assert.deepEqual(sales.result.products, [{ title: 'Strength Basics', sales: 2, revenue: 58, currency: 'usd' }]);
  assert.ok(sales.result.recent.every((order) => order.test_purchase && order.date === TODAY));
  assert.deepEqual((await executeTool('get_store_sales', {}, ctx(ids.coachB, 'coach'))).result.revenue, []);

  const mine = await executeTool('get_my_store', {}, client());
  assert.deepEqual([mine.result.products[0].owned, mine.result.purchased_programs], [true, ['Strength Basics']]);
});

test('schedule_video_session books a one-to-one session at the user\'s local time and notifies', async () => {
  const when = daysFromNow(2, '18:00');
  const booked = await executeTool('schedule_video_session', { client: 'omar@example.com', title: 'Form check', when, duration_minutes: 45, provider: 'zoom' }, coach());
  assert.equal(booked.ok, true, booked.error);
  assert.deepEqual([booked.result.with, booked.result.link_generated_automatically, booked.result.clients_notified, booked.result.meeting_url], ['Omar Hassan', true, true, 'https://us02web.zoom.us/j/999?pwd=abc']);
  assert.equal(booked.result.starts_at_utc, `${when.slice(0, 10)}T16:00:00.000Z`, 'a 6 pm request at UTC+2 is stored as 16:00 UTC');
  assert.deepEqual(zoomCalls.map((call) => call.type), ['create']);
  assert.equal(zoomCalls[0].details.durationMinutes, 45);

  const [session] = await rows('select * from public.video_sessions');
  assert.deepEqual([session.coach_id, session.client_id, session.group_id, session.title, session.duration_minutes, session.meeting_passcode, session.status], [ids.coachA, ids.omar, null, 'Form check', 45, 'abc123', 'scheduled']);
  assert.deepEqual(notifyCalls, [{ type: 'video', id: session.id }]);

  const mine = await executeTool('get_my_sessions', {}, client(ids.omar));
  assert.equal(mine.ok, true, mine.error);
  assert.deepEqual(mine.result.upcoming.map((item) => [item.title, item.join_url, item.passcode, item.coach]), [['Form check', 'https://us02web.zoom.us/j/999?pwd=abc', 'abc123', 'Amal Strength']]);
  assert.deepEqual((await executeTool('get_my_sessions', {}, client(ids.sara))).result.upcoming, []);
});

test('schedule_video_session supports groups and a pasted link without calling Zoom', async () => {
  await executeTool('create_group', { name: 'Squad', clients: ['Sara Ali'] }, coach());
  const booked = await executeTool('schedule_video_session', {
    group: 'squad', title: 'Group call', when: daysFromNow(1), meeting_url: 'https://meet.google.com/abc-defg-hij',
  }, coach());
  assert.equal(booked.ok, true, booked.error);
  assert.deepEqual([booked.result.provider, booked.result.link_generated_automatically], ['google_meet', false]);
  assert.deepEqual(zoomCalls, []);
  assert.equal((await executeTool('get_my_sessions', {}, client(ids.sara))).result.upcoming[0].group, 'Squad');
  assert.deepEqual((await executeTool('get_my_sessions', {}, client(ids.omar))).result.upcoming, [], 'non-members do not see the group call');
});

test('schedule_video_session explains problems instead of guessing, and cleans up a Zoom meeting if saving fails', async () => {
  const base = { title: 'Call', when: daysFromNow(1) };
  assert.match((await executeTool('schedule_video_session', { ...base }, coach())).error, /either a client or a group/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'a', group: 'b' }, coach())).error, /either a client or a group/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'sara' }, coach())).error, /Several clients match/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'Bea Fan' }, coach())).error, /No client matches/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'Omar', when: 'next week' }, coach())).error, /must look like/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'Omar', when: daysFromNow(-3) }, coach())).error, /future/);
  assert.deepEqual(zoomCalls, [], 'no Zoom meeting is created for a request that is already invalid');

  const offline = coach();
  offline.videoDeps = { ...videoDeps(), zoom: { ...videoDeps().zoom, isConfigured: () => false } };
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'Omar' }, offline)).error, /Zoom is not configured/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'Omar', meeting_url: 'http://zoom.us/j/1' }, offline)).error, /https/);
  assert.match((await executeTool('schedule_video_session', { ...base, client: 'Omar', provider: 'google_meet', meeting_url: 'https://us02web.zoom.us/j/1' }, offline)).error, /does not match/);
  assert.equal(await count('select count(*) as n from public.video_sessions'), 0);
});

test('a Zoom meeting created for a session that then fails to save is deleted again', async () => {
  const failing = await import('../api/_lib/videoSessions.js').then(({ scheduleVideoSession }) => scheduleVideoSession(coach(), {
    clientId: ids.bFan, title: 'Call', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), provider: 'zoom',
  }, videoDeps()).then(() => null, (error) => error));
  assert.match(failing.message, /active client/);
  assert.equal(failing.status, 400);
  assert.deepEqual(zoomCalls.map((call) => call.type), ['create', 'delete'], 'the unused meeting is removed from Zoom');
  assert.equal(zoomCalls[1].id, '999');
});

test('invite_trainer creates an invitation with the chosen permissions', async () => {
  const invited = await executeTool('invite_trainer', { email: ' Tina@Example.com ', role_title: 'Nutrition coach', permissions: { messages: true, manage_groups: true } }, coach());
  assert.equal(invited.ok, true, invited.error);
  assert.equal(invited.result.email, 'tina@example.com');
  const [member] = await rows('select * from public.coach_team_members');
  assert.deepEqual([member.head_coach_id, member.status, member.role_title, member.permissions], [ids.coachA, 'invited', 'Nutrition coach', { manage_programs: false, view_assessments: false, messages: true, manage_groups: true }]);

  const defaults = await executeTool('invite_trainer', { email: 'tom@example.com' }, coach());
  assert.equal(defaults.ok, true);
  assert.deepEqual((await rows("select permissions from public.coach_team_members where invite_email = 'tom@example.com'"))[0].permissions, { manage_programs: true, view_assessments: true, messages: true, manage_groups: false });

  assert.match((await executeTool('invite_trainer', { email: 'not-an-email' }, coach())).error, /valid email/);
  assert.match((await executeTool('invite_trainer', { email: 'tina@example.com' }, coach())).error, /already been invited/);
  assert.match((await executeTool('invite_trainer', { email: 'amal@example.com' }, coach())).error, /yourself/);
});

test('the new tools respect roles, and assistant trainers can only navigate', async () => {
  for (const name of ['create_store_product', 'get_store_sales', 'schedule_video_session', 'invite_trainer']) {
    assert.equal((await executeTool(name, {}, client())).forbidden, true, `${name} for a client`);
    assert.equal((await executeTool(name, {}, ctx(ids.coachA, 'trainer'))).forbidden, true, `${name} for a trainer`);
  }
  for (const name of ['get_my_sessions', 'get_my_store', 'create_group', 'get_client_assessment', 'get_my_schedule']) {
    assert.equal((await executeTool(name, {}, ctx(ids.coachA, 'trainer'))).forbidden, true, `${name} for a trainer`);
  }
  assert.equal((await executeTool('get_my_sessions', {}, coach())).forbidden, true);
  assert.equal((await executeTool('get_my_store', {}, coach())).forbidden, true);

  assert.equal((await executeTool('navigate_to', { page: 'teamClients' }, ctx(ids.coachA, 'trainer'))).navigate, '/team-clients');
  assert.equal((await executeTool('navigate_to', { page: 'settings' }, ctx(ids.coachA, 'trainer'))).navigate, '/settings');
  assert.equal((await executeTool('navigate_to', { page: 'dashboard' }, ctx(ids.coachA, 'trainer'))).ok, false);
  assert.equal((await executeTool('navigate_to', { page: 'community' }, ctx(ids.coachA, 'trainer'))).ok, false);
  assert.deepEqual(navigablePages('trainer'), ['teamClients', 'settings']);
  assert.equal((await executeTool('navigate_to', { page: 'store' }, coach())).navigate, '/store');
  assert.equal((await executeTool('navigate_to', { page: 'sessions' }, coach())).navigate, '/sessions');
  assert.equal((await executeTool('navigate_to', { page: 'team' }, coach())).navigate, '/team');
  assert.equal((await executeTool('navigate_to', { page: 'team' }, client())).ok, false);
  assert.equal((await executeTool('navigate_to', { page: 'myStore' }, client())).navigate, '/my-store');
  assert.equal((await executeTool('navigate_to', { page: 'mySessions' }, client())).navigate, '/my-sessions');
  assert.equal((await executeTool('navigate_to', { page: 'mySessions' }, coach())).ok, false);
  assert.deepEqual(toolSpecsForRole('trainer').map((tool) => tool.name), ['navigate_to']);
});

test('the agent loop schedules a session and opens the page for the coach', async () => {
  const scripted = [
    { text: '', toolCalls: [{ id: 'a', name: 'schedule_video_session', args: { client: 'Omar Hassan', title: 'Check-in', when: daysFromNow(3), provider: 'zoom' } }] },
    { text: '', toolCalls: [{ id: 'b', name: 'navigate_to', args: { page: 'sessions' } }] },
    { text: 'Scheduled and opened.', toolCalls: [] },
  ];
  const events = [];
  await runJack({
    model: { complete: async () => scripted.shift() }, system: 's', history: [{ role: 'user', content: 'schedule a call with Omar' }],
    ctx: coach(), emit: (event) => events.push(event),
  });
  assert.deepEqual(events.filter((event) => event.type === 'step').map((event) => [event.tool, event.status]), [
    ['schedule_video_session', 'running'], ['schedule_video_session', 'done'], ['navigate_to', 'running'], ['navigate_to', 'done'],
  ]);
  assert.deepEqual(events.find((event) => event.type === 'navigate'), { type: 'navigate', path: '/sessions' });
  assert.equal(await count('select count(*) as n from public.video_sessions'), 1);
});
