import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../api/_lib/jackTools.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Jack's assessment, contract and group tools, run against the real schema with row-level security enforced.

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  saraK: '00000000-0000-4000-8000-0000000000c2',
  omar: '00000000-0000-4000-8000-0000000000c3',
  bFan: '00000000-0000-4000-8000-0000000000c4',
};
const TODAY = new Date().toISOString().slice(0, 10);
const NO = { q1: false, q2: false, q3: false, q4: false, q5: false, q6: false, q7: false };
const SIGNATURE = `data:image/png;base64,${'iVBORw0KGgo'.repeat(30)}`;

let db;

const ctx = (userId, role, access = {}) => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today: TODAY, access: { role, ...access } });
const coach = () => ctx(ids.coachA, 'coach', { full_name: 'Coach Amal', brand_name: 'Amal Strength' });
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
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.saraK, 'sarak@example.com'], [ids.omar, 'omar@example.com'], [ids.bFan, 'b@example.com']]) {
    await addUser(db, { id, email, role: 'client' });
  }
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email) values
       ($1, $2, 'Sara Ali', 'sara@example.com'), ($1, $3, 'Sara Khan', 'sarak@example.com'),
       ($1, $4, 'Omar Hassan', 'omar@example.com'), ($5, $6, 'Bea Fan', 'b@example.com')`,
    [ids.coachA, ids.sara, ids.saraK, ids.omar, ids.coachB, ids.bFan],
  );
  await db.query(
    "insert into public.training_programs (coach_id, title, status) values ($1, 'Strength Basics', 'published'), ($1, 'Hypertrophy Plan', 'published'), ($2, 'Secret Plan', 'published')",
    [ids.coachA, ids.coachB],
  );
});

test('create_group creates the group, adds named clients and gives them the program in one request', async () => {
  const result = await executeTool('create_group', {
    name: '90-day challenge', description: 'Get fit together', clients: ['Omar Hassan', 'sara@example.com'], program: 'strength basics',
  }, coach());
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result.members_added.sort(), ['Omar Hassan', 'Sara Ali']);
  assert.equal(result.result.program, 'Strength Basics');

  const [group] = await rows('select * from public.coaching_groups');
  assert.deepEqual([group.coach_id, group.name, group.description], [ids.coachA, '90-day challenge', 'Get fit together']);
  assert.equal(await count('select count(*) as n from public.coaching_group_members'), 2);
  assert.deepEqual((await rows('select client_id from public.program_assignments order by client_id')).map((row) => row.client_id).sort(), [ids.sara, ids.omar].sort());
  assert.ok(group.program_template_id);
});

test('create_group stops before creating anything when a name is ambiguous, unknown, or belongs to another coach', async () => {
  const ambiguous = await executeTool('create_group', { name: 'Team', clients: ['sara'] }, coach());
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /Several clients match/);

  const stranger = await executeTool('create_group', { name: 'Team', clients: ['Bea Fan'] }, coach());
  assert.match(stranger.error, /No client matches/);

  const foreignProgram = await executeTool('create_group', { name: 'Team', program: 'Secret Plan' }, coach());
  assert.match(foreignProgram.error, /No program matches/);

  const invalid = await executeTool('create_group', { name: '  ' }, coach());
  assert.equal(invalid.ok, false);
  assert.equal(await count('select count(*) as n from public.coaching_groups'), 0);

  const plain = await executeTool('create_group', { name: 'Just a group' }, coach());
  assert.equal(plain.ok, true, plain.error);
  assert.deepEqual(plain.result.members_added, []);
});

test('assign_program_to_group assigns by name to every member and rejects unclear names', async () => {
  await executeTool('create_group', { name: 'Legs group', clients: ['Omar Hassan', 'Sara Ali'] }, coach());
  await executeTool('create_group', { name: 'Legs and arms', clients: ['Sara Khan'] }, coach());

  const ambiguous = await executeTool('assign_program_to_group', { group: 'legs', program: 'Strength Basics' }, coach());
  assert.match(ambiguous.error, /Several groups match/);

  const done = await executeTool('assign_program_to_group', { group: 'Legs group', program: 'hypertrophy' }, coach());
  assert.equal(done.ok, true, done.error);
  assert.deepEqual([done.result.group, done.result.program, done.result.members_assigned], ['Legs group', 'Hypertrophy Plan', 2]);
  assert.equal(await count('select count(*) as n from public.program_assignments'), 2);

  assert.match((await executeTool('assign_program_to_group', { group: 'Legs group', program: 'Secret Plan' }, coach())).error, /No program matches/);
  assert.match((await executeTool('assign_program_to_group', { group: 'Nope', program: 'Strength Basics' }, coach())).error, /No group matches/);
  assert.match((await executeTool('assign_program_to_group', { group: 'Legs group', program: 'Strength Basics' }, ctx(ids.coachB, 'coach'))).error, /No group matches/);
});

test('get_client_assessment gives an overview, then the details of one client, within the coach\'s own clients', async () => {
  await rpc(ids.sara, 'submit_my_assessment', { p_coach_id: null, p_parq: { ...NO, q2: true, q5: true }, p_goals: 'Run a 10k', p_injuries: 'Left knee surgery in 2022' });
  await rpc(ids.omar, 'submit_my_assessment', { p_coach_id: null, p_parq: NO, p_goals: 'Lose weight', p_injuries: '' });

  const overview = await executeTool('get_client_assessment', {}, coach());
  assert.equal(overview.ok, true, overview.error);
  assert.deepEqual(overview.result.need_medical_clearance, { count: 1, names: ['Sara Ali'] });
  assert.deepEqual(overview.result.not_submitted, { count: 1, names: ['Sara Khan'] });
  assert.equal(overview.result.submitted, 2);
  assert.equal(JSON.stringify(overview.result).includes('@'), false);

  const detail = await executeTool('get_client_assessment', { client: 'sara@example.com' }, coach());
  assert.equal(detail.ok, true, detail.error);
  assert.equal(detail.result.medical_clearance_required, true);
  assert.deepEqual(detail.result.yes_answers, ['chest pain during physical activity', 'bone or joint problem that exercise could worsen']);
  assert.deepEqual([detail.result.fitness_goals, detail.result.injuries_notes], ['Run a 10k', 'Left knee surgery in 2022']);
  assert.equal(detail.result.submitted_on, TODAY);

  assert.deepEqual((await executeTool('get_client_assessment', { client: 'Sara Khan' }, coach())).result, { client: 'Sara Khan', submitted: false });
  assert.match((await executeTool('get_client_assessment', { client: 'sara' }, coach())).error, /Several clients match/);
  assert.match((await executeTool('get_client_assessment', { client: 'Bea Fan' }, coach())).error, /No client matches/);

  const other = await executeTool('get_client_assessment', {}, ctx(ids.coachB, 'coach'));
  assert.equal(other.result.need_medical_clearance.count, 0, 'another coach never sees these assessments');
  assert.equal(other.result.submitted, 0);
});

test('create_contract saves a contract that the coach\'s clients can then see', async () => {
  const created = await executeTool('create_contract', { title: 'Liability waiver', content: 'I accept the risks of training.', required: true }, coach());
  assert.equal(created.ok, true, created.error);
  assert.equal(created.result.required_on_onboarding, true);
  const [contract] = await rows('select * from public.contracts');
  assert.deepEqual([contract.coach_id, contract.title, contract.is_required_on_onboarding], [ids.coachA, 'Liability waiver', true]);

  assert.equal((await executeTool('create_contract', { title: ' ', content: 'x' }, coach())).ok, false);
  assert.equal((await executeTool('create_contract', { title: 'T', content: '' }, coach())).ok, false);
  assert.equal((await executeTool('create_contract', { title: 'T', content: 'x'.repeat(20001) }, coach())).ok, false);
  assert.equal(await count('select count(*) as n from public.contracts'), 1);
});

test('get_my_contracts separates contracts to sign from signed ones and stays within the client\'s coach', async () => {
  await executeTool('create_contract', { title: 'Waiver', content: 'Text', required: true }, coach());
  await executeTool('create_contract', { title: 'Policy', content: 'Text', required: false }, coach());
  const [{ id: waiverId }] = await rows("select id from public.contracts where title = 'Waiver'");

  const before = await executeTool('get_my_contracts', {}, client());
  assert.equal(before.ok, true, before.error);
  assert.deepEqual(before.result.to_sign.map((item) => [item.title, item.required]).sort(), [['Policy', false], ['Waiver', true]]);
  assert.deepEqual(before.result.signed, []);
  assert.equal(before.result.sign_on_page, 'myContracts');

  await rpc(ids.sara, 'sign_contract', { p_contract_id: waiverId, p_signer_name: 'Sara Ali', p_signature_data_url: SIGNATURE });
  const after = await executeTool('get_my_contracts', {}, client());
  assert.deepEqual(after.result.to_sign.map((item) => item.title), ['Policy']);
  assert.deepEqual(after.result.signed, [{ title: 'Waiver', signed_on: TODAY }]);

  const otherCoachClient = await executeTool('get_my_contracts', {}, client(ids.bFan));
  assert.deepEqual(otherCoachClient.result, { to_sign: [], signed: [], sign_on_page: 'myContracts' });
});

test('get_my_groups lists a client\'s groups with the program and the latest updates, and nothing for non-members', async () => {
  await executeTool('create_group', { name: 'Summer shred', clients: ['Sara Ali'], program: 'Strength Basics' }, coach());
  const [{ id: groupId }] = await rows('select id from public.coaching_groups');
  await rpc(ids.coachA, 'post_group_announcement', { p_group_id: groupId, p_body: 'Weigh-in on Friday' });

  const mine = await executeTool('get_my_groups', {}, client());
  assert.equal(mine.ok, true, mine.error);
  assert.equal(mine.result.count, 1);
  assert.deepEqual(
    [mine.result.groups[0].name, mine.result.groups[0].coach, mine.result.groups[0].program, mine.result.groups[0].latest_updates],
    ['Summer shred', 'Amal Strength', 'Strength Basics', ['Weigh-in on Friday']],
  );

  assert.deepEqual((await executeTool('get_my_groups', {}, client(ids.omar))).result, { count: 0, groups: [] });
  assert.deepEqual((await executeTool('get_my_groups', {}, client(ids.bFan))).result, { count: 0, groups: [] });
});

test('navigation reaches the new pages only for the right role', async () => {
  assert.equal((await executeTool('navigate_to', { page: 'groups' }, coach())).navigate, '/groups');
  assert.equal((await executeTool('navigate_to', { page: 'contracts' }, coach())).navigate, '/contracts');
  assert.equal((await executeTool('navigate_to', { page: 'assessments' }, coach())).ok, false);
  assert.equal((await executeTool('navigate_to', { page: 'assessments' }, client())).navigate, '/assessments');
  assert.equal((await executeTool('navigate_to', { page: 'myContracts' }, client())).navigate, '/my-contracts');
  assert.equal((await executeTool('navigate_to', { page: 'myGroups' }, client())).navigate, '/my-groups');
  assert.equal((await executeTool('navigate_to', { page: 'groups' }, client())).ok, false);
  assert.equal((await executeTool('navigate_to', { page: 'myGroups' }, coach())).ok, false);
});
