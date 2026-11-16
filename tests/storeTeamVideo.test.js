import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// The real supabase/manual-setup.sql in an in-process Postgres. Every call goes through the "authenticated"
// role as one user, so row-level security and function permissions are genuinely enforced.

const MIGRATION = new URL('../supabase/migrations/20261115001100_store_team_video.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  trainer2: '00000000-0000-4000-8000-0000000000d2',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  lina: '00000000-0000-4000-8000-0000000000c3',
  bFan: '00000000-0000-4000-8000-0000000000c4',
};

const NO = { q1: false, q2: false, q3: false, q4: false, q5: false, q6: false, q7: false };
const ALL_PERMISSIONS = { manage_programs: true, view_assessments: true, messages: true, manage_groups: true };
const expireTrial = (id) => db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [id]);
const startTrial = (id) => db.query("update public.profiles set trial_started_at = now(), trial_ends_at = now() + interval '72 hours' where id = $1", [id]);
const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

let db;
const as = (userId, options) => createUserClient(db, userId, options);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);

async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function fails(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}

let programA;
let programB;

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina Trainer' });
  await addUser(db, { id: ids.trainer2, email: 'tom@example.com', role: 'coach', fullName: 'Tom Trainer' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.lina, 'lina@example.com'], [ids.bFan, 'b@example.com']]) {
    await addUser(db, { id, email, role: 'client' });
  }
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name) values
       ($1, $2, 'Sara Ali', 'sara@example.com', 'Amal Strength'), ($1, $3, 'Omar Hassan', 'omar@example.com', 'Amal Strength'),
       ($1, $4, 'Lina Noor', 'lina@example.com', 'Amal Strength'), ($5, $6, 'Bea Fan', 'b@example.com', 'Coach Ben')`,
    [ids.coachA, ids.sara, ids.omar, ids.lina, ids.coachB, ids.bFan],
  );
  [{ id: programA }] = await rows("insert into public.training_programs (coach_id, title, status) values ($1, 'Strength Basics', 'published') returning id", [ids.coachA]);
  [{ id: programB }] = await rows("insert into public.training_programs (coach_id, title, status) values ($1, 'Ben plan', 'published') returning id", [ids.coachB]);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

// ---------------------------------------------------------------------- store

const saveProduct = (userId, o = {}) => as(userId).rpc('save_store_product', {
  p_product_id: o.id ?? null,
  p_program_id: o.program ?? programA,
  p_title: o.title ?? 'Strength Basics 8-week plan',
  p_description: o.description ?? 'Eight weeks of strength training',
  p_price_cents: o.price ?? 2900,
  p_currency: o.currency ?? 'usd',
  p_cover_image_url: o.cover ?? null,
  p_publish: o.publish ?? true,
});

const completeOrder = (orderId, o = {}) => db.query(
  'select public.complete_store_order($1, $2, $3, $4, $5, $6) as result',
  [orderId, o.session === undefined ? `cs_${orderId}` : o.session, o.amount ?? 2900, o.currency ?? 'usd', o.intent ?? 'pi_1', o.mode ?? 'stripe'],
);

test('coaches create, edit, publish and delete store products', async () => {
  const id = await ok(saveProduct(ids.coachA, { publish: false, cover: 'https://img.example.com/cover.png' }));
  const [product] = await rows('select * from public.store_products where id = $1', [id]);
  assert.deepEqual([product.coach_id, product.program_template_id, product.price_cents, product.currency, product.is_published], [ids.coachA, programA, 2900, 'usd', false]);

  await ok(saveProduct(ids.coachA, { id, title: 'Renamed', price: 0, currency: 'eur', publish: true }));
  const [edited] = await rows('select title, price_cents, currency, is_published from public.store_products where id = $1', [id]);
  assert.deepEqual(edited, { title: 'Renamed', price_cents: 0, currency: 'eur', is_published: true });

  await ok(as(ids.coachA).rpc('set_store_product_published', { p_product_id: id, p_published: false }));
  assert.equal((await rows('select is_published from public.store_products where id = $1', [id]))[0].is_published, false);
  await ok(as(ids.coachA).rpc('delete_store_product', { p_product_id: id }));
  assert.equal(await count('select count(*) as n from public.store_products'), 0);
});

test('store product input is validated and limited to the owning coach', async () => {
  await fails(saveProduct(ids.coachA, { title: ' ' }), /title/);
  await fails(saveProduct(ids.coachA, { price: 25 }), /price/);
  await fails(saveProduct(ids.coachA, { price: -5 }), /price/);
  await fails(saveProduct(ids.coachA, { currency: 'xyz' }), /currency/);
  await fails(saveProduct(ids.coachA, { cover: 'http://img.example.com/a.png' }), /https/);
  await fails(saveProduct(ids.coachA, { cover: 'javascript:alert(1)' }), /https/);
  await fails(saveProduct(ids.coachA, { description: 'd'.repeat(1001) }), /description/);
  await fails(saveProduct(ids.coachA, { program: programB }), /Program was not found/);
  await fails(saveProduct(ids.sara), /active coach/);

  const id = await ok(saveProduct(ids.coachA));
  await fails(saveProduct(ids.coachB, { id, program: programB }), /Product was not found/);
  await fails(as(ids.coachB).rpc('set_store_product_published', { p_product_id: id, p_published: false }), /not found/);
  await fails(as(ids.coachB).rpc('delete_store_product', { p_product_id: id }), /not found/);

  const direct = await as(ids.coachA).from('store_products').upsert({ id, coach_id: ids.coachA, title: 'x', price_cents: 1 }, { onConflict: 'id' });
  assert.match(direct.error.message, /permission denied/);
});

test('clients only see published products of their own coach', async () => {
  await ok(saveProduct(ids.coachA, { title: 'Published', publish: true }));
  await ok(saveProduct(ids.coachA, { title: 'Draft', publish: false }));
  await ok(saveProduct(ids.coachB, { title: 'Ben product', program: programB }));

  const titles = async (userId) => (await ok(as(userId).from('store_products').select('title').order('title'))).map((row) => row.title);
  assert.deepEqual(await titles(ids.coachA), ['Draft', 'Published']);
  assert.deepEqual(await titles(ids.sara), ['Published']);
  assert.deepEqual(await titles(ids.bFan), ['Ben product']);
  assert.deepEqual(await titles(ids.coachB), ['Ben product']);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.omar]);
  assert.deepEqual(await titles(ids.omar), [], 'archived clients lose the store');
  assert.deepEqual(await titles(ids.trainer), []);

  const store = await ok(as(ids.sara).rpc('get_my_store'));
  assert.deepEqual(store.products.map((product) => [product.title, product.owned, product.coach_name]), [['Published', false, 'Amal Strength']]);
});

test('a free product is delivered instantly and cannot be bought twice', async () => {
  const productId = await ok(saveProduct(ids.coachA, { price: 0, title: 'Free starter' }));
  const first = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  assert.deepEqual([first.completed, first.already_owned], [true, false]);

  const [order] = await rows('select * from public.store_orders');
  assert.deepEqual([order.status, order.payment_mode, order.amount_cents, order.buyer_client_id, order.coach_id], ['paid', 'free', 0, ids.sara, ids.coachA]);
  assert.ok(order.purchased_at && order.assignment_id);
  assert.deepEqual((await rows('select client_id, program_id from public.program_assignments')).map((row) => [row.client_id, row.program_id]), [[ids.sara, programA]]);

  const again = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  assert.deepEqual([again.completed, again.already_owned], [true, true]);
  assert.equal(await count('select count(*) as n from public.store_orders'), 1);
  assert.equal(await count('select count(*) as n from public.program_assignments'), 1);

  await db.query("insert into public.store_orders (product_id, buyer_client_id, coach_id, product_title, amount_cents, currency, status) values ($1, $2, $3, 'dup', 0, 'usd', 'paid')", [productId, ids.sara, ids.coachA]).then(
    () => assert.fail('the database should refuse a second paid order'),
    (error) => assert.match(error.message, /duplicate key|unique/i),
  );
});

test('a paid product waits for the payment, reuses the open order and follows price changes', async () => {
  const productId = await ok(saveProduct(ids.coachA, { price: 2900 }));
  const first = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  assert.deepEqual([first.completed, first.amount_cents, first.currency, first.title, first.coach_id], [false, 2900, 'usd', 'Strength Basics 8-week plan', ids.coachA]);
  assert.equal(await count('select count(*) as n from public.program_assignments'), 0, 'nothing is delivered before payment');

  const second = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  assert.equal(second.order_id, first.order_id);
  assert.equal(await count('select count(*) as n from public.store_orders'), 1);

  await ok(saveProduct(ids.coachA, { id: productId, price: 3500, currency: 'eur' }));
  const third = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  assert.deepEqual([third.order_id, third.amount_cents, third.currency], [first.order_id, 3500, 'eur']);
});

test('only clients of the coach can start a purchase of a published product', async () => {
  const published = await ok(saveProduct(ids.coachA));
  const draft = await ok(saveProduct(ids.coachA, { publish: false }));
  await fails(as(ids.bFan).rpc('begin_store_purchase', { p_product_id: published }), /not available/);
  await fails(as(ids.sara).rpc('begin_store_purchase', { p_product_id: draft }), /not available/);
  await fails(as(ids.sara).rpc('begin_store_purchase', { p_product_id: '00000000-0000-4000-8000-00000000ffff' }), /not available/);
  await fails(as(ids.coachA).rpc('begin_store_purchase', { p_product_id: published }), /client account/);
  await fails(as(ids.trainer).rpc('begin_store_purchase', { p_product_id: published }), /client account/);

  await expireTrial(ids.coachA);
  await fails(as(ids.sara).rpc('begin_store_purchase', { p_product_id: published }), /not accepting orders/);
  assert.equal(await count('select count(*) as n from public.store_orders'), 0);
});

test('payments are confirmed only by the server, only for the right amount, and only once', async () => {
  await ok(as(ids.coachA).rpc('save_workflow', {
    p_workflow_id: null, p_name: 'Plan ready', p_description: '', p_trigger_type: 'plan_assigned', p_is_active: true,
    p_steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Thanks for your purchase, {client_name}!' }],
  }));
  const productId = await ok(saveProduct(ids.coachA, { price: 2900 }));
  const { order_id: orderId } = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));

  await fails(as(ids.sara).rpc('complete_store_order', { p_order_id: orderId, p_session_id: 'cs', p_amount_cents: 2900, p_currency: 'usd', p_payment_intent: 'pi', p_mode: 'demo' }), /permission denied/);
  await fails(as(ids.coachA).rpc('complete_store_order', { p_order_id: orderId, p_session_id: 'cs', p_amount_cents: 2900, p_currency: 'usd', p_payment_intent: 'pi', p_mode: 'demo' }), /permission denied/);
  assert.equal((await rows('select status from public.store_orders'))[0].status, 'pending');

  await assert.rejects(completeOrder(orderId, { amount: 100 }), /does not match/);
  await assert.rejects(completeOrder(orderId, { currency: 'eur' }), /does not match/);
  await assert.rejects(completeOrder(orderId, { mode: 'cash' }), /Unsupported payment mode/);
  assert.equal(await count('select count(*) as n from public.program_assignments'), 0);

  const [{ result }] = (await completeOrder(orderId)).rows;
  assert.deepEqual([result.status, result.already_paid, result.delivered], ['paid', false, true]);
  const [order] = await rows('select * from public.store_orders');
  assert.deepEqual([order.status, order.stripe_session_id, order.stripe_payment_intent_id, order.payment_mode], ['paid', `cs_${orderId}`, 'pi_1', 'stripe']);
  assert.ok(order.purchased_at && order.assignment_id);
  assert.deepEqual((await rows('select body from public.coach_messages')).map((row) => row.body), ['Thanks for your purchase, Sara Ali!'], 'the plan-assigned workflow ran');

  const [{ result: replay }] = (await completeOrder(orderId)).rows;
  assert.equal(replay.already_paid, true);
  assert.equal(await count('select count(*) as n from public.program_assignments'), 1, 'a repeated webhook never assigns twice');
  assert.equal(await count('select count(*) as n from public.coach_messages'), 1);
});

test('demo mode confirmation skips the amount check but is still recorded as demo', async () => {
  const productId = await ok(saveProduct(ids.coachA, { price: 4900 }));
  const { order_id: orderId } = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  await completeOrder(orderId, { mode: 'demo', session: null, amount: null, currency: null, intent: null });
  const [order] = await rows('select status, payment_mode from public.store_orders');
  assert.deepEqual(order, { status: 'paid', payment_mode: 'demo' });
});

test('a paid order is kept even when the program cannot be delivered', async () => {
  const productId = await ok(saveProduct(ids.coachA, { price: 2900 }));
  const { order_id: orderId } = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  const [{ result }] = (await completeOrder(orderId)).rows;
  assert.deepEqual([result.status, result.delivered], ['paid', false]);
  const [order] = await rows('select status, assignment_id, note from public.store_orders');
  assert.equal(order.status, 'paid');
  assert.equal(order.assignment_id, null);
  assert.match(order.note, /not delivered/);
});

test('sales figures add up per currency and per product, and sold products cannot be deleted', async () => {
  const strength = await ok(saveProduct(ids.coachA, { price: 2900, title: 'Strength' }));
  const euro = await ok(saveProduct(ids.coachA, { price: 1500, currency: 'eur', title: 'Mobility' }));
  const unsold = await ok(saveProduct(ids.coachA, { price: 900, title: 'Unsold' }));
  for (const [client, product, amount, currency] of [[ids.sara, strength, 2900, 'usd'], [ids.omar, strength, 2900, 'usd'], [ids.sara, euro, 1500, 'eur']]) {
    const { order_id: orderId } = await ok(as(client).rpc('begin_store_purchase', { p_product_id: product }));
    await completeOrder(orderId, { amount, currency });
  }
  await ok(as(ids.lina).rpc('begin_store_purchase', { p_product_id: unsold }));

  const sales = await ok(as(ids.coachA).rpc('get_store_sales'));
  assert.deepEqual([sales.orders_paid, sales.orders_pending], [3, 1]);
  assert.deepEqual(sales.revenue, [{ currency: 'eur', cents: 1500 }, { currency: 'usd', cents: 5800 }]);
  assert.deepEqual(sales.products.map((item) => [item.title, item.sales, Number(item.cents)]), [['Strength', 2, 5800], ['Mobility', 1, 1500], ['Unsold', 0, 0]]);
  assert.equal(sales.recent.length, 3);
  assert.ok(sales.recent.every((order) => order.delivered));
  assert.deepEqual(sales.recent.map((order) => order.buyer).sort(), ['Omar Hassan', 'Sara Ali', 'Sara Ali']);
  assert.deepEqual((await ok(as(ids.coachB).rpc('get_store_sales'))).revenue, []);

  await fails(as(ids.coachA).rpc('delete_store_product', { p_product_id: strength }), /Products with sales/);
  await ok(as(ids.coachA).rpc('delete_store_product', { p_product_id: unsold }));
  const [{ id: otherProgram }] = await rows("insert into public.training_programs (coach_id, title, status) values ($1, 'Another', 'published') returning id", [ids.coachA]);
  await fails(saveProduct(ids.coachA, { id: strength, program: otherProgram, price: 2900, title: 'Strength' }), /cannot change once the product has orders/);
  await ok(saveProduct(ids.coachA, { id: strength, program: programA, price: 3100, title: 'Strength' }));
});

test('buyers keep their purchased program, and order visibility is private', async () => {
  const productId = await ok(saveProduct(ids.coachA, { price: 2900 }));
  const { order_id: orderId } = await ok(as(ids.sara).rpc('begin_store_purchase', { p_product_id: productId }));
  await completeOrder(orderId);
  await db.query("insert into public.exercises (slug, name, category, difficulty, is_published) values ('squat', 'Back Squat', 'strength', 'beginner', true)");
  await db.query("insert into public.training_program_days (program_id, name, order_index) values ($1, 'Day 1', 0)", [programA]);
  await db.query("insert into public.training_program_exercises (day_id, exercise_id, order_index, sets, reps) select d.id, e.id, 0, 5, '5' from public.training_program_days d, public.exercises e where e.slug = 'squat'");

  const mine = await ok(as(ids.sara).rpc('get_my_store'));
  assert.deepEqual(mine.products.map((product) => product.owned), [true]);
  assert.equal(mine.purchases.length, 1);
  assert.deepEqual(mine.purchases[0].program.days[0].exercises, [{ name: 'Back Squat', sets: 5, reps: '5' }]);

  // The product disappears, the buyer still has the copy.
  await ok(as(ids.coachA).rpc('set_store_product_published', { p_product_id: productId, p_published: false }));
  assert.equal((await ok(as(ids.sara).rpc('get_my_store'))).purchases.length, 1);

  const orders = async (userId) => (await ok(as(userId).from('store_orders').select('id'))).length;
  assert.deepEqual([await orders(ids.sara), await orders(ids.coachA), await orders(ids.omar), await orders(ids.coachB), await orders(ids.bFan)], [1, 1, 0, 0, 0]);
  const direct = await as(ids.sara).from('store_orders').upsert({ id: orderId, status: 'paid' }, { onConflict: 'id' });
  assert.match(direct.error.message, /permission denied/);
});

test('the public storefront lists published products without signing in', async () => {
  await ok(saveProduct(ids.coachA, { title: 'Public one', cover: 'https://img.example.com/a.png' }));
  await ok(saveProduct(ids.coachA, { title: 'Hidden draft', publish: false }));

  await db.exec('set role anon');
  try {
    const { rows: [{ store }] } = await db.query('select public.get_public_store($1) as store', [ids.coachA]);
    assert.equal(store.coach_name, 'Amal Strength');
    assert.deepEqual(store.products.map((product) => product.title), ['Public one']);
    assert.equal(store.products[0].cover_image_url, 'https://img.example.com/a.png');
    assert.equal(JSON.stringify(store).includes('@'), false);
    assert.equal((await db.query('select public.get_public_store($1) as store', [ids.sara])).rows[0].store, null, 'clients have no storefront');
    await assert.rejects(db.query('select * from public.store_products'), /permission denied/);
    await assert.rejects(db.query('select public.begin_store_purchase($1)', [ids.sara]), /permission denied/);
  } finally {
    await db.exec('reset role');
  }
});

// ----------------------------------------------------------------------- team

const invite = (userId, o = {}) => as(userId).rpc('invite_trainer', {
  p_email: o.email ?? 'tina@example.com', p_role_title: o.title ?? 'Assistant coach', p_permissions: o.permissions ?? ALL_PERMISSIONS,
});

async function activeTrainer(o = {}) {
  const memberId = await ok(invite(ids.coachA, { email: o.email ?? 'tina@example.com', permissions: o.permissions ?? ALL_PERMISSIONS }));
  await ok(as(o.userId ?? ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
  return memberId;
}

test('head coaches invite trainers with normalized permissions', async () => {
  const memberId = await ok(invite(ids.coachA, { email: '  Tina@Example.COM ', permissions: { manage_programs: true, messages: 'yes', admin: true } }));
  const [member] = await rows('select * from public.coach_team_members where id = $1', [memberId]);
  assert.deepEqual([member.head_coach_id, member.invite_email, member.status, member.trainer_user_id, member.role_title], [ids.coachA, 'tina@example.com', 'invited', null, 'Assistant coach']);
  assert.deepEqual(member.permissions, { manage_programs: true, view_assessments: false, messages: false, manage_groups: false });

  await fails(invite(ids.coachA, { email: 'TINA@example.com' }), /already been invited/);
  await fails(invite(ids.coachA, { email: 'not-an-email' }), /valid email/);
  await fails(invite(ids.coachA, { email: 'amal@example.com' }), /yourself/);
  await fails(invite(ids.coachA, { email: 'x@example.com', title: 't'.repeat(81) }), /role title/);
  await fails(invite(ids.sara), /active coach/);
  for (let index = 0; index < 9; index += 1) await ok(invite(ids.coachA, { email: `t${index}@example.com` }));
  await fails(invite(ids.coachA, { email: 'one-too-many@example.com' }), /at most 10/);

  const team = await ok(as(ids.coachA).rpc('get_team'));
  assert.equal(team.length, 10);
  assert.deepEqual(team[0], { ...team[0], invite_email: 'tina@example.com', status: 'invited', trainer_name: null, client_count: 0 });
  assert.deepEqual((await ok(as(ids.coachB).rpc('get_team'))), []);
  await fails(as(ids.sara).rpc('get_team'), /active coach/);
});

test('only the invited email can accept, and accepting makes the account a trainer', async () => {
  const memberId = await ok(invite(ids.coachA));
  const invitations = await ok(as(ids.trainer).rpc('get_my_team_invitations'));
  assert.deepEqual(invitations.map((item) => [item.id, item.head_name, item.role_title]), [[memberId, 'Amal Strength', 'Assistant coach']]);
  assert.deepEqual(await ok(as(ids.trainer2).rpc('get_my_team_invitations')), []);

  await fails(as(ids.trainer2).rpc('accept_team_invitation', { p_member_id: memberId }), /not available/);
  await fails(as(ids.sara).rpc('accept_team_invitation', { p_member_id: memberId }), /coach account/);
  await fails(as(ids.coachB).rpc('accept_team_invitation', { p_member_id: memberId }), /not available/);

  const status = await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
  assert.equal(status.access_state, 'trainer');
  assert.deepEqual([status.team.head_coach_id, status.team.head_name, status.team.role_title, status.team.head_active], [ids.coachA, 'Amal Strength', 'Assistant coach', true]);
  assert.deepEqual(status.team.permissions, ALL_PERMISSIONS);
  await fails(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }), /not available/);

  const refreshed = await ok(as(ids.trainer).rpc('get_my_access_status'));
  assert.equal(refreshed.access_state, 'trainer');
  assert.equal((await ok(as(ids.coachA).rpc('get_my_access_status'))).team, null);
  assert.equal((await ok(as(ids.sara).rpc('get_my_access_status'))).access_state, 'client');
});

test('an account that runs its own practice cannot join a team, and trainers get no free coach features', async () => {
  const memberId = await ok(invite(ids.coachA, { email: 'ben@example.com' }));
  await fails(as(ids.coachB).rpc('accept_team_invitation', { p_member_id: memberId }), /own coaching practice/);

  const trainerMember = await ok(invite(ids.coachA, { email: 'tina@example.com' }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: trainerMember }));
  for (const [name, args] of [
    ['create_client_invite', {}],
    ['save_workflow', { p_workflow_id: null, p_name: 'x', p_description: '', p_trigger_type: 'client_joined', p_is_active: true, p_steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'hi' }] }],
    ['save_store_product', { p_product_id: null, p_program_id: programA, p_title: 'x', p_description: '', p_price_cents: 0, p_currency: 'usd', p_cover_image_url: null, p_publish: false }],
    ['save_group', { p_group_id: null, p_name: 'x', p_description: '' }],
    ['get_team', {}],
    ['invite_trainer', { p_email: 'a@b.co', p_role_title: '', p_permissions: {} }],
  ]) {
    await fails(as(ids.trainer).rpc(name, args), /active coach|coach account/);
  }
  assert.equal((await ok(as(ids.trainer).from('coach_clients').select('client_id'))).length, 0);
  assert.equal((await ok(as(ids.trainer).from('workflows').select('id'))).length, 0);
});

test('head coaches hand clients to trainers, one trainer per client', async () => {
  const tina = await activeTrainer();
  const pending = await ok(invite(ids.coachA, { email: 'tom@example.com' }));
  const assign = (userId, client, member) => as(userId).rpc('assign_client_trainer', { p_client_id: client, p_member_id: member });

  await ok(assign(ids.coachA, ids.sara, tina));
  await ok(assign(ids.coachA, ids.omar, tina));
  assert.equal((await ok(as(ids.coachA).rpc('get_team')))[0].client_count, 2);
  assert.equal((await ok(as(ids.coachA).from('client_trainer_assignments').select('client_id'))).length, 2);

  const tom = await ok(invite(ids.coachA, { email: 'tom2@example.com' }));
  await db.query("update public.coach_team_members set status = 'active', trainer_user_id = $1 where id = $2", [ids.trainer2, tom]);
  await ok(assign(ids.coachA, ids.sara, tom));
  assert.equal(await count('select count(*) as n from public.client_trainer_assignments where client_id = $1', [ids.sara]), 1, 'reassigning replaces the previous trainer');
  assert.equal((await rows('select team_member_id from public.client_trainer_assignments where client_id = $1', [ids.sara]))[0].team_member_id, tom);

  await ok(assign(ids.coachA, ids.sara, null));
  assert.equal(await count('select count(*) as n from public.client_trainer_assignments where client_id = $1', [ids.sara]), 0);

  await fails(assign(ids.coachA, ids.sara, pending), /active trainer/);
  await fails(assign(ids.coachA, ids.bFan, tina), /active client/);
  await fails(assign(ids.coachB, ids.bFan, tina), /active trainer/);
  await fails(assign(ids.trainer, ids.lina, tina), /active coach|coach account/);
  await fails(assign(ids.sara, ids.sara, tina), /active coach/);
});

test('an assistant trainer sees only the assigned clients and what their permissions allow', async () => {
  const tina = await activeTrainer({ permissions: { manage_programs: true, view_assessments: true, messages: false, manage_groups: false } });
  await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: tina }));
  await ok(as(ids.sara).rpc('submit_my_assessment', { p_coach_id: null, p_parq: { ...NO, q2: true }, p_goals: 'Run', p_injuries: '' }));
  await ok(as(ids.omar).rpc('submit_my_assessment', { p_coach_id: null, p_parq: NO, p_goals: 'Lift', p_injuries: '' }));
  await ok(as(ids.coachA).rpc('send_coach_message', { p_client_ids: [ids.sara], p_send_to_all: false, p_body: 'Hello Sara' }));
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  await db.query("insert into public.contracts (coach_id, title, content_text) values ($1, 'Waiver', 'text')", [ids.coachA]);

  const trainer = as(ids.trainer);
  assert.deepEqual((await ok(trainer.from('coach_clients').select('client_id'))).map((row) => row.client_id), [ids.sara]);
  assert.deepEqual((await ok(trainer.from('client_assessments').select('client_id,medical_clearance_required'))).map((row) => [row.client_id, row.medical_clearance_required]), [[ids.sara, true]]);
  assert.deepEqual((await ok(trainer.from('training_programs').select('title'))).map((row) => row.title), ['Strength Basics']);
  assert.equal((await ok(trainer.from('coach_messages').select('id'))).length, 0, 'no messages permission');
  assert.equal((await ok(trainer.from('coaching_groups').select('id'))).length, 0, 'no groups permission');
  assert.equal((await ok(trainer.from('contracts').select('id'))).length, 0, 'contracts stay with the head coach');
  assert.equal((await ok(trainer.from('invoices').select('id'))).length, 0);
  assert.equal((await ok(trainer.from('client_trainer_assignments').select('client_id'))).length, 1);
  assert.equal((await ok(trainer.from('coach_team_members').select('id'))).length, 1);
  assert.ok(groupId);

  await db.query("update public.coach_team_members set permissions = $1 where id = $2", [JSON.stringify({ ...ALL_PERMISSIONS, view_assessments: false }), tina]);
  assert.equal((await ok(as(ids.trainer).from('client_assessments').select('id'))).length, 0);
  assert.equal((await ok(as(ids.trainer).from('coach_messages').select('id'))).length, 1);
  assert.equal((await ok(as(ids.trainer).from('coaching_groups').select('id'))).length, 1);

  // The head coach still sees everything.
  assert.equal((await ok(as(ids.coachA).from('coach_clients').select('client_id'))).length, 3);
  assert.equal((await ok(as(ids.coachA).from('client_assessments').select('id'))).length, 2);
  assert.equal((await ok(as(ids.coachB).from('client_trainer_assignments').select('client_id'))).length, 0);
});

test('an assistant trainer assigns programs and messages assigned clients, never anyone else', async () => {
  const tina = await activeTrainer();
  await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: tina }));
  const trainer = as(ids.trainer);

  const assigned = await ok(trainer.rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: programA }));
  assert.ok(assigned.assignment_id);
  assert.deepEqual((await rows('select coach_id, client_id from public.program_assignments')).map((row) => [row.coach_id, row.client_id]), [[ids.coachA, ids.sara]]);
  await fails(trainer.rpc('assign_program_to_client', { p_client_id: ids.omar, p_program_id: programA }), /not assigned to you/);
  await fails(trainer.rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: programB }), /Program was not found/);

  await ok(trainer.rpc('send_team_message', { p_client_id: ids.sara, p_body: '  Great work this week!  ' }));
  assert.deepEqual((await rows('select coach_id, client_id, kind, body from public.coach_messages')).map((row) => [row.coach_id, row.client_id, row.kind, row.body]), [[ids.coachA, ids.sara, 'note', 'Great work this week!']]);
  assert.equal((await ok(as(ids.sara).from('coach_messages').select('body'))).length, 1, 'the client receives it as a coach note');
  await fails(trainer.rpc('send_team_message', { p_client_id: ids.omar, p_body: 'hi' }), /not assigned to you/);
  await fails(trainer.rpc('send_team_message', { p_client_id: ids.sara, p_body: ' ' }), /Write a message/);
  await fails(as(ids.coachB).rpc('send_team_message', { p_client_id: ids.sara, p_body: 'hi' }), /permission/);

  await db.query("update public.coach_team_members set permissions = '{}'::jsonb where id = $1", [tina]);
  await fails(trainer.rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: programA }), /active coach/);
  await fails(trainer.rpc('send_team_message', { p_client_id: ids.sara, p_body: 'hi' }), /permission/);
});

test('an assistant trainer can manage groups for assigned clients only', async () => {
  const tina = await activeTrainer();
  await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: tina }));
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  await ok(as(ids.coachA).rpc('assign_program_to_group', { p_group_id: groupId, p_program_id: programA }));
  const trainer = as(ids.trainer);

  const added = await ok(trainer.rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.sara] }));
  assert.deepEqual(added, { added: 1, program_assigned: 1 });
  assert.equal(await count('select count(*) as n from public.program_assignments where client_id = $1', [ids.sara]), 1, 'the group program reaches the new member');
  await fails(trainer.rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.omar] }), /assigned to you/);
  await fails(trainer.rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.bFan] }), /Only your active clients/);

  await ok(trainer.rpc('post_group_announcement', { p_group_id: groupId, p_body: 'Weigh-in Friday' }));
  assert.deepEqual((await ok(as(ids.sara).rpc('get_my_groups')))[0].announcements.map((item) => item.body), ['Weigh-in Friday']);

  await ok(as(ids.coachA).rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.omar] }));
  await fails(trainer.rpc('remove_group_member', { p_group_id: groupId, p_client_id: ids.omar }), /assigned to you/);
  await ok(trainer.rpc('remove_group_member', { p_group_id: groupId, p_client_id: ids.sara }));
  await fails(as(ids.trainer2).rpc('post_group_announcement', { p_group_id: groupId, p_body: 'x' }), /not found/);

  await db.query("update public.coach_team_members set permissions = jsonb_set(permissions, '{manage_groups}', 'false') where id = $1", [tina]);
  await fails(trainer.rpc('post_group_announcement', { p_group_id: groupId, p_body: 'x' }), /not found/);
  await fails(trainer.rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.sara] }), /active coach/);
});

test('the trainer dashboard lists only assigned clients with their status', async () => {
  const tina = await activeTrainer();
  await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: tina }));
  await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: ids.omar, p_member_id: tina }));
  await ok(as(ids.sara).rpc('submit_my_assessment', { p_coach_id: null, p_parq: { ...NO, q6: true }, p_goals: 'Run', p_injuries: '' }));
  await db.query("insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, current_date, 'Legs')", [ids.sara]);
  await ok(as(ids.trainer).rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: programA }));
  await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));

  const overview = await ok(as(ids.trainer).rpc('get_trainer_overview'));
  assert.equal(overview.head_name, 'Amal Strength');
  assert.deepEqual(overview.clients.map((client) => client.name), ['Sara Ali', 'Omar Hassan']);
  const sara = overview.clients[0];
  assert.deepEqual([sara.workouts_7d, sara.assessment_submitted, sara.medical_clearance_required, sara.program], [1, true, true, 'Strength Basics']);
  assert.deepEqual(overview.programs.map((program) => program.title), ['Strength Basics']);
  assert.deepEqual(overview.groups.map((group) => group.name), ['Squad']);
  assert.equal(JSON.stringify(overview.clients).includes('lina'), false);

  await fails(as(ids.coachA).rpc('get_trainer_overview'), /not part of an active team/);
  await fails(as(ids.coachB).rpc('get_trainer_overview'), /not part of an active team/);
});

test('disabling, removing or leaving ends a trainer\'s access immediately', async () => {
  const tina = await activeTrainer();
  await ok(as(ids.coachA).rpc('assign_client_trainer', { p_client_id: ids.sara, p_member_id: tina }));
  assert.equal((await ok(as(ids.trainer).from('coach_clients').select('client_id'))).length, 1);

  await ok(as(ids.coachA).rpc('update_team_member', { p_member_id: tina, p_role_title: 'Senior', p_permissions: { messages: true }, p_status: 'disabled' }));
  assert.equal((await ok(as(ids.trainer).from('coach_clients').select('client_id'))).length, 0);
  assert.notEqual((await ok(as(ids.trainer).rpc('get_my_access_status'))).access_state, 'trainer');
  await fails(as(ids.trainer).rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: programA }), /Program was not found|Choose an active client/);

  await ok(as(ids.coachA).rpc('update_team_member', { p_member_id: tina, p_role_title: 'Senior', p_permissions: { messages: true }, p_status: 'active' }));
  const [member] = await rows('select role_title, permissions, status from public.coach_team_members where id = $1', [tina]);
  assert.deepEqual([member.role_title, member.status, member.permissions.messages, member.permissions.manage_programs], ['Senior', 'active', true, false]);
  assert.equal((await ok(as(ids.trainer).from('coach_clients').select('client_id'))).length, 1);

  await expireTrial(ids.coachA);
  assert.equal((await ok(as(ids.trainer).from('coach_clients').select('client_id'))).length, 0, 'the head coach\'s plan ending also ends the team\'s access');
  assert.equal((await ok(as(ids.trainer).rpc('get_my_access_status'))).team.head_active, false);
  await startTrial(ids.coachA);

  await fails(as(ids.coachB).rpc('update_team_member', { p_member_id: tina, p_role_title: '', p_permissions: {}, p_status: 'disabled' }), /not found/);
  await fails(as(ids.coachB).rpc('remove_team_member', { p_member_id: tina }), /not found/);
  await ok(as(ids.coachA).rpc('remove_team_member', { p_member_id: tina }));
  assert.equal(await count('select count(*) as n from public.client_trainer_assignments'), 0);

  const second = await activeTrainer({ email: 'tina@example.com' });
  const left = await ok(as(ids.trainer).rpc('leave_team'));
  assert.notEqual(left.access_state, 'trainer');
  assert.equal(await count('select count(*) as n from public.coach_team_members where id = $1', [second]), 0);
});

test('an invitation can be declined only by its recipient, and a person joins one team at a time', async () => {
  const mine = await ok(invite(ids.coachA, { email: 'tina@example.com' }));
  await fails(as(ids.trainer2).rpc('decline_team_invitation', { p_member_id: mine }), /not available/);
  await ok(as(ids.trainer).rpc('decline_team_invitation', { p_member_id: mine }));
  assert.equal(await count('select count(*) as n from public.coach_team_members'), 0);

  await addUser(db, { id: '00000000-0000-4000-8000-0000000000b2', email: 'zed@example.com', role: 'coach', fullName: 'Coach Zed' });
  const first = await ok(invite(ids.coachA, { email: 'tom@example.com' }));
  const other = await ok(invite('00000000-0000-4000-8000-0000000000b2', { email: 'tom@example.com' }));
  await ok(as(ids.trainer2).rpc('accept_team_invitation', { p_member_id: first }));
  await fails(as(ids.trainer2).rpc('accept_team_invitation', { p_member_id: other }), /already belong to a team/);
});

// ---------------------------------------------------------------------- video

const schedule = (userId, o = {}) => as(userId).rpc('schedule_video_session', {
  p_client_id: o.client === undefined ? ids.sara : o.client,
  p_group_id: o.group ?? null,
  p_title: o.title ?? 'Form check',
  p_description: o.description ?? '',
  p_scheduled_at: o.at ?? inHours(24),
  p_duration_minutes: o.duration ?? 45,
  p_provider: o.provider ?? 'zoom',
  p_meeting_url: o.url ?? 'https://us02web.zoom.us/j/123456789?pwd=abc',
  p_meeting_passcode: o.passcode ?? '123456',
});

test('coaches schedule one-to-one and group video sessions', async () => {
  const single = await ok(schedule(ids.coachA, { title: '  Form check ' }));
  const [row] = await rows('select * from public.video_sessions where id = $1', [single]);
  assert.deepEqual([row.coach_id, row.client_id, row.group_id, row.title, row.duration_minutes, row.provider, row.status, row.meeting_passcode], [ids.coachA, ids.sara, null, 'Form check', 45, 'zoom', 'scheduled', '123456']);

  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  const grouped = await ok(schedule(ids.coachA, { client: null, group: groupId, provider: 'google_meet', url: 'https://meet.google.com/abc-defg-hij', passcode: '' }));
  const [groupRow] = await rows('select client_id, group_id, provider from public.video_sessions where id = $1', [grouped]);
  assert.deepEqual([groupRow.client_id, groupRow.group_id, groupRow.provider], [null, groupId, 'google_meet']);

  const custom = await ok(schedule(ids.coachA, { provider: 'custom', url: 'https://video.example.org/room/42' }));
  assert.ok(custom);
});

test('video session input is validated', async () => {
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  const otherGroup = await ok(as(ids.coachB).rpc('save_group', { p_group_id: null, p_name: 'Ben group', p_description: '' }));
  await fails(schedule(ids.coachA, { client: null, group: null }), /one client or one group/);
  await fails(schedule(ids.coachA, { client: ids.sara, group: groupId }), /one client or one group/);
  await fails(schedule(ids.coachA, { client: ids.bFan }), /active client/);
  await fails(schedule(ids.coachA, { client: null, group: otherGroup }), /Group was not found/);
  await fails(schedule(ids.coachA, { title: ' ' }), /title/);
  await fails(schedule(ids.coachA, { at: inHours(-5) }), /future/);
  await fails(schedule(ids.coachA, { at: inHours(24 * 800) }), /future/);
  await fails(schedule(ids.coachA, { duration: 2 }), /duration/);
  await fails(schedule(ids.coachA, { duration: 600 }), /duration/);
  await fails(schedule(ids.coachA, { provider: 'skype' }), /provider/);
  await fails(schedule(ids.coachA, { url: 'http://zoom.us/j/1' }), /https/);
  await fails(schedule(ids.coachA, { url: 'https://zoom.us/j/1 <script>' }), /https/);
  await fails(schedule(ids.coachA, { url: 'https://evilzoom.us.example.com/j/1' }), /does not match/);
  await fails(schedule(ids.coachA, { provider: 'google_meet', url: 'https://us02web.zoom.us/j/1' }), /does not match/);
  await fails(schedule(ids.coachA, { passcode: 'p'.repeat(51) }), /passcode/);
  await fails(schedule(ids.sara), /active coach/);
  assert.equal(await count('select count(*) as n from public.video_sessions'), 0);
});

test('coaches edit, complete, cancel and delete their sessions', async () => {
  const id = await ok(schedule(ids.coachA));
  await ok(as(ids.coachA).rpc('update_video_session', {
    p_session_id: id, p_title: 'Moved', p_description: 'New time', p_scheduled_at: inHours(48), p_duration_minutes: 30,
    p_provider: 'custom', p_meeting_url: 'https://video.example.org/r/1', p_meeting_passcode: '',
  }));
  const [row] = await rows('select title, duration_minutes, provider, meeting_url from public.video_sessions where id = $1', [id]);
  assert.deepEqual(row, { title: 'Moved', duration_minutes: 30, provider: 'custom', meeting_url: 'https://video.example.org/r/1' });

  await ok(as(ids.coachA).rpc('set_video_session_status', { p_session_id: id, p_status: 'cancelled' }));
  assert.equal((await rows('select status from public.video_sessions where id = $1', [id]))[0].status, 'cancelled');
  await fails(as(ids.coachA).rpc('set_video_session_status', { p_session_id: id, p_status: 'banana' }), /Unsupported/);
  await ok(as(ids.coachA).rpc('set_video_session_status', { p_session_id: id, p_status: 'completed' }));

  await fails(as(ids.coachB).rpc('set_video_session_status', { p_session_id: id, p_status: 'cancelled' }), /not found/);
  await fails(as(ids.coachB).rpc('delete_video_session', { p_session_id: id }), /not found/);
  await fails(as(ids.coachB).rpc('update_video_session', { p_session_id: id, p_title: 'x', p_description: '', p_scheduled_at: inHours(2), p_duration_minutes: 30, p_provider: 'custom', p_meeting_url: 'https://a.example.org/x', p_meeting_passcode: '' }), /not found/);
  await ok(as(ids.coachA).rpc('delete_video_session', { p_session_id: id }));
  assert.equal(await count('select count(*) as n from public.video_sessions'), 0);
});

test('clients see only their own sessions and the sessions of groups they belong to', async () => {
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  await ok(as(ids.coachA).rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.omar] }));
  await ok(schedule(ids.coachA, { client: ids.sara, title: 'Sara solo', at: inHours(5) }));
  await ok(schedule(ids.coachA, { client: ids.lina, title: 'Lina solo', at: inHours(6) }));
  await ok(schedule(ids.coachA, { client: null, group: groupId, title: 'Squad call', at: inHours(7), url: 'https://video.example.org/squad' , provider: 'custom'}));

  const titles = async (userId) => (await ok(as(userId).from('video_sessions').select('title').order('title'))).map((row) => row.title);
  assert.deepEqual(await titles(ids.sara), ['Sara solo']);
  assert.deepEqual(await titles(ids.omar), ['Squad call']);
  assert.deepEqual(await titles(ids.lina), ['Lina solo']);
  assert.deepEqual(await titles(ids.bFan), []);
  assert.deepEqual(await titles(ids.coachB), []);
  assert.deepEqual(await titles(ids.coachA), ['Lina solo', 'Sara solo', 'Squad call']);
  assert.deepEqual(await titles(ids.trainer), []);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual(await titles(ids.sara), []);
  await ok(as(ids.coachA).rpc('remove_group_member', { p_group_id: groupId, p_client_id: ids.omar }));
  assert.deepEqual(await titles(ids.omar), [], 'leaving the group ends access to its sessions');

  const direct = await as(ids.lina).from('video_sessions').upsert({ id: ids.lina, coach_id: ids.coachA, title: 'x' }, { onConflict: 'id' });
  assert.match(direct.error.message, /permission denied/);
});

test('get_my_video_sessions returns the client\'s sessions with coach and group names', async () => {
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  await ok(as(ids.coachA).rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.sara] }));
  await ok(schedule(ids.coachA, { title: 'Solo', at: inHours(30) }));
  await ok(schedule(ids.coachA, { client: null, group: groupId, title: 'Group', at: inHours(3), provider: 'custom', url: 'https://video.example.org/g', passcode: '' }));
  await ok(schedule(ids.coachA, { client: ids.omar, title: 'Not mine' }));
  await db.query("insert into public.video_sessions (coach_id, client_id, title, scheduled_at, provider, meeting_url, status) values ($1, $2, 'Old call', now() - interval '3 days', 'zoom', 'https://zoom.us/j/9', 'completed')", [ids.coachA, ids.sara]);

  const sessions = await ok(as(ids.sara).rpc('get_my_video_sessions'));
  assert.deepEqual(sessions.map((session) => session.title), ['Old call', 'Group', 'Solo']);
  const group = sessions.find((session) => session.title === 'Group');
  assert.deepEqual([group.group_name, group.coach_name, group.provider], ['Squad', 'Amal Strength', 'custom']);
  assert.equal(sessions.find((session) => session.title === 'Solo').meeting_url, 'https://us02web.zoom.us/j/123456789?pwd=abc');
  assert.deepEqual(await ok(as(ids.bFan).rpc('get_my_video_sessions')), []);
  await fails(as(ids.coachA).rpc('get_my_video_sessions'), /client account/);
});
