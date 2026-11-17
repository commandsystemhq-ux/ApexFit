import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// The AI settings table and functions, in the real schema with row-level security and grants enforced.

const MIGRATION = new URL('../supabase/migrations/20261115001600_ai_provider_settings.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  loner: '00000000-0000-4000-8000-0000000000c9',
};
const ALL = { manage_programs: true, view_assessments: true, messages: true, manage_groups: true };
const CIPHERTEXT = 'v1:ZmFrZS1jaXBoZXJ0ZXh0';

let db;
const as = (userId) => createUserClient(db, userId);
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
async function asServiceRole(sql, params = []) {
  await db.exec('set role service_role');
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

const save = (userId, overrides = {}) => as(userId).rpc('save_my_ai_settings', {
  p_provider: 'bedrock', p_model: 'anthropic.claude-3-5-sonnet-20241022-v2:0', p_region: 'us-east-1', p_endpoint: null, p_credentials_encrypted: CIPHERTEXT, ...overrides,
});

async function activeTrainer() {
  const memberId = await ok(as(ids.coachA).rpc('invite_trainer', { p_email: 'tina@example.com', p_role_title: 'Assistant', p_permissions: ALL }));
  await ok(as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId }));
}

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina Trainer' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.loner, 'loner@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name) values
       ($1, $2, 'Sara Ali', 'sara@example.com', 'Amal Strength'), ($3, $4, 'Omar Hassan', 'omar@example.com', 'Coach Ben')`,
    [ids.coachA, ids.sara, ids.coachB, ids.omar],
  );
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

// ---------------------------------------------------------------- the table is closed

test('nobody who uses the app can read or write the settings table, not even the owner', async () => {
  await db.query("insert into public.coach_ai_settings (coach_id, provider, model, credentials_encrypted) values ($1, 'openai', 'gpt-4o', $2)", [ids.coachA, CIPHERTEXT]);
  const statements = [
    'select * from public.coach_ai_settings',
    'select credentials_encrypted from public.coach_ai_settings',
    'select count(*) from public.coach_ai_settings',
    `insert into public.coach_ai_settings (coach_id, provider, credentials_encrypted) values ('%ID%', 'openai', 'x')`,
    "update public.coach_ai_settings set provider = 'gemini'",
    "update public.coach_ai_settings set credentials_encrypted = 'stolen'",
    'delete from public.coach_ai_settings',
  ];
  for (const user of [ids.coachA, ids.coachB, ids.trainer, ids.sara, ids.omar]) {
    for (const statement of statements) {
      const result = await as(user).sql(statement.replace('%ID%', user));
      assert.ok(result.error, `${user}: ${statement}`);
      assert.match(result.error.message, /permission denied/);
    }
  }
  assert.deepEqual(await rows('select provider, credentials_encrypted from public.coach_ai_settings'), [{ provider: 'openai', credentials_encrypted: CIPHERTEXT }]);
});

test('row-level security is on and has no policy for the app\'s roles', async () => {
  const [table] = await rows("select relrowsecurity from pg_class where oid = 'public.coach_ai_settings'::regclass");
  assert.equal(table.relrowsecurity, true);
  const policies = await rows("select roles::text as roles from pg_policies where tablename = 'coach_ai_settings'");
  for (const policy of policies) assert.ok(!/authenticated|anon|public/.test(policy.roles), policy.roles);
  const grants = await rows("select grantee, privilege_type from information_schema.role_table_grants where table_name = 'coach_ai_settings' and grantee in ('anon', 'authenticated', 'PUBLIC')");
  assert.deepEqual(grants, []);
});

// ------------------------------------------------------- owner-only functions

test('the owner saves, reads (without credentials), tests and removes their settings', async () => {
  assert.deepEqual(await ok(as(ids.coachA).rpc('get_my_ai_settings')), { configured: false });

  await ok(save(ids.coachA, { p_model: '  amazon.nova-pro-v1:0  ', p_endpoint: '  ' }));
  const view = await ok(as(ids.coachA).rpc('get_my_ai_settings'));
  assert.deepEqual([view.configured, view.provider, view.model, view.region, view.endpoint, view.last_test_ok], [true, 'bedrock', 'amazon.nova-pro-v1:0', 'us-east-1', null, null]);
  assert.deepEqual(Object.keys(view).sort(), ['configured', 'endpoint', 'last_test_ok', 'last_tested_at', 'model', 'provider', 'region', 'updated_at']);
  assert.ok(!JSON.stringify(view).includes(CIPHERTEXT) && !('credentials_encrypted' in view));

  await ok(as(ids.coachA).rpc('record_my_ai_test', { p_ok: true }));
  assert.equal((await ok(as(ids.coachA).rpc('get_my_ai_settings'))).last_test_ok, true);
  await ok(save(ids.coachA, { p_provider: 'azure_foundry', p_model: 'gpt-4o', p_region: null, p_endpoint: 'https://res.openai.azure.com' }));
  const replaced = await ok(as(ids.coachA).rpc('get_my_ai_settings'));
  assert.deepEqual([replaced.provider, replaced.endpoint, replaced.region, replaced.last_test_ok], ['azure_foundry', 'https://res.openai.azure.com', null, null], 'a new save clears the old test result');
  assert.equal(await count('select count(*) as n from public.coach_ai_settings'), 1);

  await ok(as(ids.coachA).rpc('clear_my_ai_settings'));
  assert.deepEqual(await ok(as(ids.coachA).rpc('get_my_ai_settings')), { configured: false });
});

test('clients, assistant trainers, expired coaches and strangers are refused by the database itself', async () => {
  await activeTrainer();
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coachB]);
  await ok(save(ids.coachA));

  for (const user of [ids.sara, ids.omar, ids.loner, ids.trainer, ids.coachB]) {
    await fails(as(user).rpc('get_my_ai_settings'), /account owner only/);
    await fails(save(user), /account owner only/);
    await fails(as(user).rpc('clear_my_ai_settings'), /account owner only/);
    await fails(as(user).rpc('record_my_ai_test', { p_ok: true }), /account owner only/);
  }
  await fails(as('00000000-0000-4000-8000-000000000000').rpc('get_my_ai_settings'), /Sign in|Authentication|not been provisioned/);
  assert.deepEqual(await rows('select coach_id from public.coach_ai_settings'), [{ coach_id: ids.coachA }], 'the owner\'s settings are untouched');
});

test('settings are validated and every owner has their own', async () => {
  await fails(save(ids.coachA, { p_provider: 'mystery' }), /supported AI provider/);
  await fails(save(ids.coachA, { p_provider: null }), /supported AI provider/);
  await fails(save(ids.coachA, { p_credentials_encrypted: '   ' }), /Credentials are required/);
  await fails(save(ids.coachA, { p_model: 'x'.repeat(201) }), /check/);
  assert.equal(await count('select count(*) as n from public.coach_ai_settings'), 0);

  await ok(save(ids.coachA, { p_provider: 'openai', p_model: 'gpt-4o', p_region: null }));
  await db.query("update public.profiles set trial_started_at = now(), trial_ends_at = now() + interval '72 hours' where id = $1", [ids.coachB]);
  await ok(save(ids.coachB, { p_provider: 'gemini', p_model: null, p_region: null }));
  assert.equal((await ok(as(ids.coachA).rpc('get_my_ai_settings'))).provider, 'openai');
  assert.equal((await ok(as(ids.coachB).rpc('get_my_ai_settings'))).provider, 'gemini');
});

// ------------------------------------------------------ whose settings apply (server)

test('a coach uses their own settings, a trainer their head coach\'s, a client their coach\'s', async () => {
  await activeTrainer();
  await ok(save(ids.coachA, { p_credentials_encrypted: 'coach-a-secret' }));

  const resolve = async (user) => (await rows('select public.resolve_ai_owner($1) as owner', [user]))[0].owner;
  assert.equal(await resolve(ids.coachA), ids.coachA);
  assert.equal(await resolve(ids.trainer), ids.coachA);
  assert.equal(await resolve(ids.sara), ids.coachA);
  assert.equal(await resolve(ids.omar), ids.coachB);
  assert.equal(await resolve(ids.loner), null, 'a client without a coach has no owner');

  for (const user of [ids.coachA, ids.trainer, ids.sara]) {
    const [found] = await asServiceRole('select public.service_get_ai_settings($1) as settings', [user]);
    assert.deepEqual([found.settings.owner_id, found.settings.provider, found.settings.credentials_encrypted], [ids.coachA, 'bedrock', 'coach-a-secret']);
  }
  for (const user of [ids.omar, ids.coachB, ids.loner]) {
    assert.equal((await asServiceRole('select public.service_get_ai_settings($1) as settings', [user]))[0].settings, null);
  }
});

test('a client with two coaches uses the one who has chosen a provider; archived or expired coaches do not count', async () => {
  await ok(save(ids.coachA));
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, coach_name) values ($1, $2, 'Omar Hassan', 'Amal Strength')", [ids.coachA, ids.omar]);
  const owner = async (user) => (await rows('select public.resolve_ai_owner($1) as owner', [user]))[0].owner;
  assert.equal(await owner(ids.omar), ids.coachA, 'prefers the coach with settings over the older link');

  await db.query("update public.coach_clients set status = 'archived' where coach_id = $1", [ids.coachA]);
  assert.equal(await owner(ids.sara), null);
  assert.equal(await owner(ids.omar), ids.coachB);

  await db.query("update public.coach_clients set status = 'active' where coach_id = $1", [ids.coachA]);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coachA]);
  assert.equal(await owner(ids.sara), null, 'an expired coach\'s choice no longer applies to clients');
});

test('the server-only functions cannot be called from the app', async () => {
  await ok(save(ids.coachA));
  for (const user of [ids.coachA, ids.sara, ids.trainer]) {
    await fails(as(user).rpc('service_get_ai_settings', { p_user: ids.sara }), /permission denied/);
    await fails(as(user).rpc('resolve_ai_owner', { p_user: ids.sara }), /permission denied/);
    await fails(as(user).rpc('ai_settings_guard'), /permission denied/);
  }
  assert.equal(await count("select count(*) as n from information_schema.routine_privileges where routine_name = 'service_get_ai_settings' and grantee in ('anon', 'authenticated', 'PUBLIC')"), 0);
});

test('removing an account removes its settings', async () => {
  await ok(save(ids.coachA));
  await db.query('delete from auth.users where id = $1', [ids.coachA]);
  assert.equal(await count('select count(*) as n from public.coach_ai_settings'), 0);
});
