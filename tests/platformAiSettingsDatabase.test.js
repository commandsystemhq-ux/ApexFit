import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// The platform AI setting in the real schema, with row-level security and grants enforced.

const MIGRATION = new URL('../supabase/migrations/20261115001700_platform_ai_settings.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  trainer: '00000000-0000-4000-8000-0000000000d1',
  client: '00000000-0000-4000-8000-0000000000c1',
  owner: '00000000-0000-4000-8000-0000000000f1',
};
const CIPHERTEXT = 'v1:ZmFrZS1jaXBoZXJ0ZXh0';

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);

async function asServiceRole(sql, params = []) {
  await db.exec('set role service_role');
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users; delete from public.platform_ai_settings;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.trainer, email: 'tina@example.com', role: 'coach', fullName: 'Tina Trainer' });
  await addUser(db, { id: ids.client, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.owner, email: 'owner@example.com', role: 'coach', fullName: 'Platform Owner' });
  const memberId = (await as(ids.coach).rpc('invite_trainer', {
    p_email: 'tina@example.com', p_role_title: 'Assistant', p_permissions: { manage_programs: true, view_assessments: true, messages: true, manage_groups: true },
  })).data;
  await as(ids.trainer).rpc('accept_team_invitation', { p_member_id: memberId });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, coach_name) values ($1, $2, 'Sara Ali', 'Amal Strength')", [ids.coach, ids.client]);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('the short-lived per-coach settings are gone: a database that had them is cleaned up', async () => {
  // What migration 1600 used to create.
  await db.exec(`
    create table public.coach_ai_settings (coach_id uuid primary key, provider text, credentials_encrypted text);
    create function public.get_my_ai_settings() returns jsonb language sql as $$ select '{}'::jsonb $$;
    create function public.save_my_ai_settings(text, text, text, text, text) returns void language sql as $$ select $$;
    create function public.clear_my_ai_settings() returns void language sql as $$ select $$;
    create function public.record_my_ai_test(boolean) returns void language sql as $$ select $$;
    create function public.ai_settings_guard() returns void language sql as $$ select $$;
    create function public.resolve_ai_owner(uuid) returns uuid language sql as $$ select null::uuid $$;
    create function public.service_get_ai_settings(uuid) returns jsonb language sql as $$ select null::jsonb $$;
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assert.equal(await count("select count(*) as n from pg_tables where schemaname = 'public' and tablename = 'coach_ai_settings'"), 0);
  assert.deepEqual(await rows("select proname from pg_proc where pronamespace = 'public'::regnamespace and proname ~ 'ai_settings|ai_owner|ai_test' order by proname"), []);
  assert.equal(await count("select count(*) as n from pg_tables where schemaname = 'public' and tablename = 'platform_ai_settings'"), 1);
});

test('nobody who uses the app can read or write the platform setting: not coaches, trainers, clients or even the owner\'s own account', async () => {
  await asServiceRole("insert into public.platform_ai_settings (provider, model, credentials_encrypted) values ('bedrock', 'amazon.nova-pro-v1:0', $1)", [CIPHERTEXT]);
  const statements = [
    'select * from public.platform_ai_settings',
    'select credentials_encrypted from public.platform_ai_settings',
    'select count(*) from public.platform_ai_settings',
    "insert into public.platform_ai_settings (id, provider, credentials_encrypted) values (true, 'openai', 'x') on conflict (id) do update set provider = 'openai'",
    "update public.platform_ai_settings set provider = 'gemini'",
    "update public.platform_ai_settings set credentials_encrypted = 'stolen'",
    'delete from public.platform_ai_settings',
    'truncate public.platform_ai_settings',
  ];
  for (const user of [ids.coach, ids.trainer, ids.client, ids.owner]) {
    for (const statement of statements) {
      const result = await as(user).sql(statement);
      assert.ok(result.error, `${user}: ${statement}`);
      assert.match(result.error.message, /permission denied/);
    }
    const viaApi = await as(user).from('platform_ai_settings').select('*');
    assert.ok(viaApi.error || viaApi.data.length === 0, 'the table API shows nothing');
  }
  assert.deepEqual(await rows('select provider, credentials_encrypted from public.platform_ai_settings'), [{ provider: 'bedrock', credentials_encrypted: CIPHERTEXT }]);
});

test('row-level security is on, the app\'s roles have no grants and no policy, and no function opens the table to them', async () => {
  const [table] = await rows("select relrowsecurity from pg_class where oid = 'public.platform_ai_settings'::regclass");
  assert.equal(table.relrowsecurity, true);
  const policies = await rows("select policyname, roles::text as roles from pg_policies where tablename = 'platform_ai_settings'");
  assert.ok(policies.length > 0);
  for (const policy of policies) assert.ok(!/authenticated|anon|public/.test(policy.roles), `${policy.policyname}: ${policy.roles}`);
  assert.deepEqual(await rows("select grantee, privilege_type from information_schema.role_table_grants where table_name = 'platform_ai_settings' and grantee in ('anon', 'authenticated', 'PUBLIC')"), []);
  assert.deepEqual(await rows("select grantee from information_schema.column_privileges where table_name = 'platform_ai_settings' and grantee in ('anon', 'authenticated', 'PUBLIC')"), []);

  // Nothing in the public schema mentions the platform AI setting except the table itself.
  const touching = await rows(`select proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ilike '%platform_ai_settings%'`);
  assert.deepEqual(touching, []);
  for (const user of [ids.coach, ids.trainer, ids.client]) {
    for (const name of ['get_platform_ai_settings', 'save_platform_ai_settings', 'get_my_ai_settings', 'get_ai_settings']) {
      assert.ok((await as(user).rpc(name)).error, `${name} must not exist`);
    }
  }
});

test('the server\'s service role manages one row for the whole platform', async () => {
  await asServiceRole("insert into public.platform_ai_settings (provider, model, region, credentials_encrypted, updated_by) values ('bedrock', 'amazon.nova-pro-v1:0', 'us-east-1', $1, $2)", [CIPHERTEXT, ids.owner]);
  const [row] = await asServiceRole('select id, provider, model, region, updated_by, last_test_ok from public.platform_ai_settings');
  assert.deepEqual(row, { id: true, provider: 'bedrock', model: 'amazon.nova-pro-v1:0', region: 'us-east-1', updated_by: ids.owner, last_test_ok: null });

  // A second row is impossible; saving again replaces the one that exists.
  await assert.rejects(asServiceRole("insert into public.platform_ai_settings (id, provider, credentials_encrypted) values (true, 'openai', 'x')"), /duplicate key|unique/);
  await assert.rejects(asServiceRole("insert into public.platform_ai_settings (id, provider, credentials_encrypted) values (false, 'openai', 'x')"), /check/);
  await asServiceRole(`insert into public.platform_ai_settings (id, provider, model, credentials_encrypted) values (true, 'azure_foundry', 'gpt-4o', 'new')
                       on conflict (id) do update set provider = excluded.provider, model = excluded.model, credentials_encrypted = excluded.credentials_encrypted`);
  assert.deepEqual(await asServiceRole('select provider, model, credentials_encrypted from public.platform_ai_settings'), [{ provider: 'azure_foundry', model: 'gpt-4o', credentials_encrypted: 'new' }]);

  await asServiceRole('update public.platform_ai_settings set last_tested_at = now(), last_test_ok = true');
  assert.equal((await asServiceRole('select last_test_ok from public.platform_ai_settings'))[0].last_test_ok, true);
  await asServiceRole('delete from public.platform_ai_settings where id');
  assert.deepEqual(await asServiceRole('select * from public.platform_ai_settings'), []);
});

test('the stored values are validated', async () => {
  const insert = (columns, values) => asServiceRole(`insert into public.platform_ai_settings (${columns}) values (${values})`);
  await assert.rejects(insert('provider, credentials_encrypted', "'mystery', 'x'"), /check/);
  await assert.rejects(insert('provider, credentials_encrypted', "'openai', ''"), /check/);
  await assert.rejects(insert('provider, credentials_encrypted', "'openai', repeat('x', 8001)"), /check/);
  await assert.rejects(insert('provider, credentials_encrypted, model', "'openai', 'x', repeat('m', 201)"), /check/);
  await assert.rejects(insert('provider, credentials_encrypted, region', "'bedrock', 'x', repeat('r', 41)"), /check/);
  await assert.rejects(insert('provider, credentials_encrypted, endpoint', "'azure_foundry', 'x', repeat('e', 301)"), /check/);
  assert.equal(await count('select count(*) as n from public.platform_ai_settings'), 0);
});

test('removing the account that last saved the setting keeps the setting', async () => {
  await asServiceRole("insert into public.platform_ai_settings (provider, credentials_encrypted, updated_by) values ('openai', $1, $2)", [CIPHERTEXT, ids.owner]);
  await db.query('delete from auth.users where id = $1', [ids.owner]);
  assert.deepEqual(await asServiceRole('select provider, updated_by from public.platform_ai_settings'), [{ provider: 'openai', updated_by: null }]);
});
