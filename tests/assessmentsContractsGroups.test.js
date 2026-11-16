import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Runs the real supabase/manual-setup.sql in an in-process Postgres. Every call below goes through the
// "authenticated" role as one user, so row-level security and function permissions are genuinely enforced.

const MIGRATION = new URL('../supabase/migrations/20261115001000_assessments_contracts_groups.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  lina: '00000000-0000-4000-8000-0000000000c3',
  bFan: '00000000-0000-4000-8000-0000000000c4',
  loner: '00000000-0000-4000-8000-0000000000c5',
};

const NO = { q1: false, q2: false, q3: false, q4: false, q5: false, q6: false, q7: false };
const SIGNATURE = `data:image/png;base64,${'iVBORw0KGgo'.repeat(30)}`;

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

const submit = (userId, { coach = null, answers = NO, goals = 'Lose fat', injuries = '' } = {}) =>
  as(userId).rpc('submit_my_assessment', { p_coach_id: coach, p_parq: answers, p_goals: goals, p_injuries: injuries });

const saveContract = (userId, { id = null, title = 'Coaching agreement', content = 'I agree to follow the plan.', required = false } = {}) =>
  as(userId).rpc('save_contract', { p_contract_id: id, p_title: title, p_content: content, p_required: required });

const sign = (userId, contractId, { name = 'Sara Ali', signature = SIGNATURE, headers } = {}) =>
  as(userId, { headers }).rpc('sign_contract', { p_contract_id: contractId, p_signer_name: name, p_signature_data_url: signature });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec(`
    truncate public.profiles cascade;
    delete from auth.users;
  `);
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.lina, 'lina@example.com'], [ids.bFan, 'b@example.com'], [ids.loner, 'loner@example.com']]) {
    await addUser(db, { id, email, role: 'client' });
  }
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name) values
       ($1, $2, 'Sara Ali', 'sara@example.com', 'Amal Strength'),
       ($1, $3, 'Omar Hassan', 'omar@example.com', 'Amal Strength'),
       ($1, $4, 'Lina Noor', 'lina@example.com', 'Amal Strength'),
       ($5, $6, 'Bea Fan', 'b@example.com', 'Coach Ben')`,
    [ids.coachA, ids.sara, ids.omar, ids.lina, ids.coachB, ids.bFan],
  );
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

// ---------------------------------------------------------------- assessments

test('a PAR-Q with only "no" answers does not require medical clearance', async () => {
  const result = await ok(submit(ids.sara, { goals: ' Build strength ', injuries: 'Old knee sprain' }));
  assert.equal(result.medical_clearance_required, false);
  assert.equal(result.coach_id, ids.coachA);

  const [row] = await rows('select * from public.client_assessments');
  assert.deepEqual([row.coach_id, row.client_id, row.fitness_goals, row.injuries_notes], [ids.coachA, ids.sara, 'Build strength', 'Old knee sprain']);
  assert.deepEqual(row.parq_answers, NO);
  assert.equal(row.medical_clearance_required, false);
});

test('a single "yes" on any of the seven questions requires medical clearance', async () => {
  for (let question = 1; question <= 7; question += 1) {
    const result = await ok(submit(ids.sara, { answers: { ...NO, [`q${question}`]: true } }));
    assert.equal(result.medical_clearance_required, true, `q${question}`);
  }
  assert.equal(await count('select count(*) as n from public.client_assessments'), 1, 'resubmitting replaces the previous answers');
  assert.equal((await rows('select medical_clearance_required as m from public.client_assessments'))[0].m, true);

  await ok(submit(ids.sara, { answers: NO }));
  assert.equal((await rows('select medical_clearance_required as m from public.client_assessments'))[0].m, false, 'clearing every answer clears the flag');
});

test('invalid assessments are rejected and nothing is stored', async () => {
  const { q7, ...sixAnswers } = NO;
  await fails(submit(ids.sara, { answers: sixAnswers }), /all seven/);
  await fails(submit(ids.sara, { answers: { ...NO, q3: 'yes' } }), /yes or no/);
  await fails(submit(ids.sara, { answers: { ...NO, extra: true } }), /Unexpected/);
  await fails(submit(ids.sara, { answers: [true, false] }), /all seven/);
  await fails(submit(ids.sara, { goals: '   ' }), /fitness goals/);
  await fails(submit(ids.sara, { goals: 'g'.repeat(1001) }), /1000/);
  await fails(submit(ids.sara, { injuries: 'i'.repeat(1001) }), /1000/);
  assert.equal(await count('select count(*) as n from public.client_assessments'), 0);
});

test('a client can only submit to a coach they are linked to', async () => {
  await fails(submit(ids.loner), /Join a coach/);
  await fails(submit(ids.sara, { coach: ids.coachB }), /not linked/);
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name) values ($1, $2, 'Sara')", [ids.coachB, ids.sara]);
  await fails(submit(ids.sara), /Choose which coach/);
  await ok(submit(ids.sara, { coach: ids.coachB }));
  assert.equal((await rows('select coach_id from public.client_assessments'))[0].coach_id, ids.coachB);
  await fails(as(ids.coachA).rpc('submit_my_assessment', { p_coach_id: null, p_parq: NO, p_goals: 'x', p_injuries: '' }), /client account/);
});

test('assessments are readable only by the client and their own coach, and never writable directly', async () => {
  await ok(submit(ids.sara, { answers: { ...NO, q5: true }, goals: 'Run a 10k' }));

  assert.equal((await ok(as(ids.sara).from('client_assessments').select('id'))).length, 1);
  assert.equal((await ok(as(ids.coachA).from('client_assessments').select('id'))).length, 1);
  assert.equal((await ok(as(ids.coachB).from('client_assessments').select('id'))).length, 0, 'another coach sees nothing');
  assert.equal((await ok(as(ids.omar).from('client_assessments').select('id'))).length, 0, 'another client sees nothing');
  assert.equal((await ok(as(ids.bFan).from('client_assessments').select('id'))).length, 0);

  const direct = await as(ids.sara).from('client_assessments').upsert({ coach_id: ids.coachA, client_id: ids.sara, parq_answers: NO }, { onConflict: 'coach_id,client_id' });
  assert.match(direct.error.message, /permission denied/);
  const forged = await as(ids.coachA).from('client_assessments').upsert({ coach_id: ids.coachA, client_id: ids.omar, parq_answers: NO }, { onConflict: 'coach_id,client_id' });
  assert.match(forged.error.message, /permission denied/);
});

test('the onboarding checklist reports the assessment, clearance flag and unsigned required contracts', async () => {
  const status = () => ok(as(ids.sara).rpc('get_my_onboarding_status'));
  assert.deepEqual(await status(), { has_coach: true, assessment_submitted: false, medical_clearance_required: false, pending_contracts: 0 });

  await ok(saveContract(ids.coachA, { title: 'Waiver', required: true }));
  await ok(saveContract(ids.coachA, { title: 'Optional policy', required: false }));
  await ok(submit(ids.sara, { answers: { ...NO, q1: true } }));
  assert.deepEqual(await status(), { has_coach: true, assessment_submitted: true, medical_clearance_required: true, pending_contracts: 1 });

  const noCoach = await ok(as(ids.loner).rpc('get_my_onboarding_status'));
  assert.deepEqual(noCoach, { has_coach: false, assessment_submitted: false, medical_clearance_required: false, pending_contracts: 0 });
  await fails(as(ids.coachA).rpc('get_my_onboarding_status'), /client account/);
});

// ------------------------------------------------------------------ contracts

test('coaches create, edit, archive and delete their contracts', async () => {
  const id = await ok(saveContract(ids.coachA, { title: 'Liability waiver', content: 'I accept the risks.', required: true }));
  const [created] = await rows('select * from public.contracts where id = $1', [id]);
  assert.deepEqual([created.coach_id, created.title, created.is_required_on_onboarding, created.is_archived], [ids.coachA, 'Liability waiver', true, false]);

  await ok(saveContract(ids.coachA, { id, title: 'Liability waiver v2', content: 'Updated text', required: false }));
  assert.equal((await rows('select title from public.contracts where id = $1', [id]))[0].title, 'Liability waiver v2');

  await ok(as(ids.coachA).rpc('set_contract_archived', { p_contract_id: id, p_archived: true }));
  assert.equal((await rows('select is_archived as a from public.contracts where id = $1', [id]))[0].a, true);
  await ok(as(ids.coachA).rpc('delete_contract', { p_contract_id: id }));
  assert.equal(await count('select count(*) as n from public.contracts'), 0);
});

test('contract input is validated and limited to the owning coach', async () => {
  await fails(saveContract(ids.coachA, { title: ' ' }), /title/);
  await fails(saveContract(ids.coachA, { content: ' ' }), /between 1 and 20000/);
  await fails(saveContract(ids.coachA, { content: 'x'.repeat(20001) }), /between 1 and 20000/);
  await fails(saveContract(ids.sara), /active coach/);

  const id = await ok(saveContract(ids.coachA));
  await fails(saveContract(ids.coachB, { id }), /not found/);
  await fails(as(ids.coachB).rpc('set_contract_archived', { p_contract_id: id, p_archived: true }), /not found/);
  await fails(as(ids.coachB).rpc('delete_contract', { p_contract_id: id }), /not found/);
  await fails(as(ids.sara).rpc('delete_contract', { p_contract_id: id }), /active coach/);

  const direct = await as(ids.coachA).from('contracts').upsert({ coach_id: ids.coachA, title: 'x', content_text: 'y' }, { onConflict: 'id' });
  assert.match(direct.error.message, /permission denied/);
});

test('contracts are visible to the coach and to that coach\'s active clients only', async () => {
  const id = await ok(saveContract(ids.coachA, { title: 'Agreement' }));
  const archived = await ok(saveContract(ids.coachA, { title: 'Old agreement' }));
  await ok(as(ids.coachA).rpc('set_contract_archived', { p_contract_id: archived, p_archived: true }));

  const titles = async (userId) => (await ok(as(userId).from('contracts').select('title').order('title'))).map((row) => row.title);
  assert.deepEqual(await titles(ids.coachA), ['Agreement', 'Old agreement']);
  assert.deepEqual(await titles(ids.sara), ['Agreement'], 'archived contracts are hidden from clients who did not sign them');
  assert.deepEqual(await titles(ids.bFan), []);
  assert.deepEqual(await titles(ids.loner), []);
  assert.deepEqual(await titles(ids.coachB), []);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.omar]);
  assert.deepEqual(await titles(ids.omar), [], 'archived clients lose access');
  assert.ok(id);
});

test('a client signs a contract once and the record keeps the signed wording', async () => {
  const id = await ok(saveContract(ids.coachA, { title: 'Waiver', content: 'Original text', required: true }));
  const result = await ok(sign(ids.sara, id, { name: '  Sara Ali ', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'TestBrowser/1.0' } }));
  assert.ok(result.signature_id);

  const [signature] = await rows('select * from public.contract_signatures');
  assert.deepEqual(
    [signature.contract_id, signature.client_id, signature.signer_full_name, signature.contract_title, signature.content_snapshot],
    [id, ids.sara, 'Sara Ali', 'Waiver', 'Original text'],
  );
  assert.equal(signature.signature_data_url, SIGNATURE);
  assert.equal(signature.ip_or_user_agent, '203.0.113.9 | TestBrowser/1.0');
  assert.ok(Date.now() - new Date(signature.signed_at).getTime() < 60_000);

  assert.equal((await ok(as(ids.sara).rpc('get_my_onboarding_status'))).pending_contracts, 0);
});

test('signing twice is refused, by the function and by the database constraint', async () => {
  const id = await ok(saveContract(ids.coachA));
  await ok(sign(ids.sara, id));
  await fails(sign(ids.sara, id), /already signed/);
  assert.equal(await count('select count(*) as n from public.contract_signatures'), 1);

  await assert.rejects(
    db.query(
      `insert into public.contract_signatures (contract_id, client_id, signer_full_name, signature_data_url, contract_title, content_snapshot)
       values ($1, $2, 'Sara Ali', $3, 't', 'c')`,
      [id, ids.sara, SIGNATURE],
    ),
    /duplicate key|unique/i,
  );
});

test('signatures need a real name, a PNG drawing, and an available contract', async () => {
  const id = await ok(saveContract(ids.coachA));
  await fails(sign(ids.sara, id, { name: 'S' }), /full name/);
  await fails(sign(ids.sara, id, { name: ' ' }), /full name/);
  await fails(sign(ids.sara, id, { signature: '' }), /Draw your signature/);
  await fails(sign(ids.sara, id, { signature: 'data:image/png;base64,AAAA' }), /Draw your signature/);
  await fails(sign(ids.sara, id, { signature: `data:image/jpeg;base64,${'A'.repeat(200)}` }), /Draw your signature/);
  await fails(sign(ids.sara, id, { signature: `data:text/html;base64,${'A'.repeat(200)}` }), /Draw your signature/);
  await fails(sign(ids.sara, id, { signature: `data:image/png;base64,${'A'.repeat(300001)}` }), /Draw your signature/);
  await fails(sign(ids.sara, id, { signature: `data:image/png;base64,${'A'.repeat(150)}"><script>` }), /Draw your signature/);
  assert.equal(await count('select count(*) as n from public.contract_signatures'), 0);

  await fails(sign(ids.bFan, id), /not available/);
  await fails(sign(ids.loner, id), /not available/);
  await fails(sign(ids.coachA, id), /client account/);
  await fails(sign(ids.sara, '00000000-0000-4000-8000-00000000ffff'), /not available/);

  await ok(as(ids.coachA).rpc('set_contract_archived', { p_contract_id: id, p_archived: true }));
  await fails(sign(ids.sara, id), /not available/);
});

test('signed contracts are protected: no edits to the wording, no deletion, signatures cannot be forged', async () => {
  const id = await ok(saveContract(ids.coachA, { title: 'Waiver', content: 'Text', required: false }));
  await ok(sign(ids.sara, id));

  await fails(saveContract(ids.coachA, { id, title: 'Waiver', content: 'Changed text' }), /already has signatures/);
  await fails(saveContract(ids.coachA, { id, title: 'New title', content: 'Text' }), /already has signatures/);
  await ok(saveContract(ids.coachA, { id, title: 'Waiver', content: 'Text', required: true }));
  assert.equal((await rows('select is_required_on_onboarding as r from public.contracts where id = $1', [id]))[0].r, true);
  await fails(as(ids.coachA).rpc('delete_contract', { p_contract_id: id }), /Signed contracts cannot be deleted/);
  await ok(as(ids.coachA).rpc('set_contract_archived', { p_contract_id: id, p_archived: true }));

  const forged = await as(ids.omar).from('contract_signatures').upsert({ contract_id: id, client_id: ids.omar, signer_full_name: 'Omar', signature_data_url: SIGNATURE, contract_title: 't', content_snapshot: 'c' }, { onConflict: 'contract_id,client_id' });
  assert.match(forged.error.message, /permission denied/);
});

test('signatures are visible to the signer and the contract\'s coach only, and archived contracts stay viewable once signed', async () => {
  const id = await ok(saveContract(ids.coachA, { title: 'Waiver' }));
  await ok(sign(ids.sara, id));
  await ok(as(ids.coachA).rpc('set_contract_archived', { p_contract_id: id, p_archived: true }));

  const signatures = (userId) => ok(as(userId).from('contract_signatures').select('signer_full_name,signature_data_url'));
  assert.equal((await signatures(ids.sara)).length, 1);
  assert.equal((await signatures(ids.coachA)).length, 1);
  assert.equal((await signatures(ids.coachB)).length, 0);
  assert.equal((await signatures(ids.omar)).length, 0);
  assert.equal((await signatures(ids.bFan)).length, 0);

  assert.deepEqual((await ok(as(ids.sara).from('contracts').select('title'))).map((row) => row.title), ['Waiver'], 'the signer keeps access to the archived contract');
  assert.equal((await ok(as(ids.omar).from('contracts').select('title'))).length, 0);
});

// --------------------------------------------------------------------- groups

async function makeGroup(userId = ids.coachA, name = '90-day challenge', description = 'Get stronger together') {
  return ok(as(userId).rpc('save_group', { p_group_id: null, p_name: name, p_description: description }));
}

async function makeProgram(coachId = ids.coachA, title = 'Strength Basics') {
  const [row] = await rows('insert into public.training_programs (coach_id, title, status) values ($1, $2, $3) returning id', [coachId, title, 'published']);
  return row.id;
}

const addMembers = (userId, groupId, clients) => as(userId).rpc('add_group_members', { p_group_id: groupId, p_client_ids: clients });

test('coaches create, rename and delete groups', async () => {
  const id = await makeGroup();
  const [group] = await rows('select * from public.coaching_groups where id = $1', [id]);
  assert.deepEqual([group.coach_id, group.name, group.description, group.program_template_id], [ids.coachA, '90-day challenge', 'Get stronger together', null]);

  await ok(as(ids.coachA).rpc('save_group', { p_group_id: id, p_name: 'Bulking group', p_description: '' }));
  assert.equal((await rows('select name from public.coaching_groups where id = $1', [id]))[0].name, 'Bulking group');

  await fails(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: ' ', p_description: '' }), /name/);
  await fails(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'x'.repeat(81), p_description: '' }), /name/);
  await fails(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'ok', p_description: 'd'.repeat(501) }), /description/);
  await fails(as(ids.sara).rpc('save_group', { p_group_id: null, p_name: 'ok', p_description: '' }), /active coach/);
  await fails(as(ids.coachB).rpc('save_group', { p_group_id: id, p_name: 'Hijacked', p_description: '' }), /not found/);
  await fails(as(ids.coachB).rpc('delete_group', { p_group_id: id }), /not found/);

  await ok(as(ids.coachA).rpc('delete_group', { p_group_id: id }));
  assert.equal(await count('select count(*) as n from public.coaching_groups'), 0);
});

test('only a coach\'s own active clients can join their groups', async () => {
  const id = await makeGroup();
  const added = await ok(addMembers(ids.coachA, id, [ids.sara, ids.omar]));
  assert.deepEqual(added, { added: 2, program_assigned: 0 });

  const again = await ok(addMembers(ids.coachA, id, [ids.sara, ids.lina]));
  assert.equal(again.added, 1, 'existing members are not added twice');
  assert.equal(await count('select count(*) as n from public.coaching_group_members'), 3);

  await fails(addMembers(ids.coachA, id, [ids.bFan]), /Only your active clients/);
  await fails(addMembers(ids.coachA, id, [ids.loner]), /Only your active clients/);
  await fails(addMembers(ids.coachA, id, '{}'), /at least one client/);
  await fails(addMembers(ids.coachB, id, [ids.bFan]), /not found/);
  await fails(addMembers(ids.sara, id, [ids.sara]), /active coach/);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.lina]);
  const second = await makeGroup(ids.coachA, 'Second');
  await fails(addMembers(ids.coachA, second, [ids.lina]), /Only your active clients/);
  assert.equal(await count('select count(*) as n from public.coaching_group_members where client_id = $1', [ids.bFan]), 0);
});

test('members can be removed, and removal is limited to the group\'s coach', async () => {
  const id = await makeGroup();
  await ok(addMembers(ids.coachA, id, [ids.sara, ids.omar]));
  await fails(as(ids.coachB).rpc('remove_group_member', { p_group_id: id, p_client_id: ids.sara }), /not found/);
  await fails(as(ids.sara).rpc('remove_group_member', { p_group_id: id, p_client_id: ids.omar }), /not found/);
  await ok(as(ids.coachA).rpc('remove_group_member', { p_group_id: id, p_client_id: ids.sara }));
  await fails(as(ids.coachA).rpc('remove_group_member', { p_group_id: id, p_client_id: ids.sara }), /not in this group/);
  assert.deepEqual((await rows('select client_id from public.coaching_group_members')).map((row) => row.client_id), [ids.omar]);
});

test('assigning a program to a group gives it to every active member in one step and starts workflows', async () => {
  const programId = await makeProgram();
  await ok(as(ids.coachA).rpc('save_workflow', {
    p_workflow_id: null, p_name: 'Plan ready', p_description: '', p_trigger_type: 'plan_assigned', p_is_active: true,
    p_steps: [{ delay_days: 0, action_type: 'send_message', message_template: 'Your plan is ready, {client_name}.' }],
  }));
  const id = await makeGroup();
  await ok(addMembers(ids.coachA, id, [ids.sara, ids.omar, ids.lina]));
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.lina]);

  const result = await ok(as(ids.coachA).rpc('assign_program_to_group', { p_group_id: id, p_program_id: programId }));
  assert.deepEqual(result, { assigned: 2, skipped_inactive: 1 });
  assert.equal((await rows('select program_template_id from public.coaching_groups where id = $1', [id]))[0].program_template_id, programId);
  assert.deepEqual((await rows('select client_id from public.program_assignments order by client_id')).map((row) => row.client_id), [ids.sara, ids.omar]);
  assert.deepEqual((await rows('select client_id, body from public.coach_messages order by client_id')).map((row) => [row.client_id, row.body]), [
    [ids.sara, 'Your plan is ready, Sara Ali.'],
    [ids.omar, 'Your plan is ready, Omar Hassan.'],
  ]);

  const otherProgram = await makeProgram(ids.coachB, 'Ben plan');
  await fails(as(ids.coachA).rpc('assign_program_to_group', { p_group_id: id, p_program_id: otherProgram }), /Program was not found/);
  await fails(as(ids.coachB).rpc('assign_program_to_group', { p_group_id: id, p_program_id: otherProgram }), /Group was not found/);
});

test('clients who join a group that already has a program receive it automatically', async () => {
  const programId = await makeProgram();
  const id = await makeGroup();
  await ok(addMembers(ids.coachA, id, [ids.sara]));
  await ok(as(ids.coachA).rpc('assign_program_to_group', { p_group_id: id, p_program_id: programId }));
  const joined = await ok(addMembers(ids.coachA, id, [ids.omar]));
  assert.deepEqual(joined, { added: 1, program_assigned: 1 });
  assert.equal(await count('select count(*) as n from public.program_assignments where client_id = $1', [ids.omar]), 1);

  await ok(as(ids.coachA).rpc('clear_group_program', { p_group_id: id }));
  assert.equal((await rows('select program_template_id from public.coaching_groups where id = $1', [id]))[0].program_template_id, null);
});

test('group data is private: only the coach and the members can read it', async () => {
  const id = await makeGroup();
  await ok(addMembers(ids.coachA, id, [ids.sara, ids.omar]));
  await ok(as(ids.coachA).rpc('post_group_announcement', { p_group_id: id, p_body: 'Weigh-in on Friday' }));

  const visibleGroups = async (userId) => (await ok(as(userId).from('coaching_groups').select('id'))).length;
  assert.equal(await visibleGroups(ids.coachA), 1);
  assert.equal(await visibleGroups(ids.sara), 1);
  assert.equal(await visibleGroups(ids.lina), 0, 'a client of the same coach who is not in the group');
  assert.equal(await visibleGroups(ids.bFan), 0);
  assert.equal(await visibleGroups(ids.coachB), 0);

  assert.equal((await ok(as(ids.coachA).from('coaching_group_members').select('client_id'))).length, 2);
  assert.deepEqual((await ok(as(ids.sara).from('coaching_group_members').select('client_id'))).map((row) => row.client_id), [ids.sara], 'members cannot list each other');
  assert.equal((await ok(as(ids.lina).from('coaching_group_members').select('client_id'))).length, 0);
  assert.equal((await ok(as(ids.coachB).from('coaching_group_members').select('client_id'))).length, 0);

  assert.equal((await ok(as(ids.sara).from('group_announcements').select('body'))).length, 1);
  assert.equal((await ok(as(ids.lina).from('group_announcements').select('body'))).length, 0);
  assert.equal((await ok(as(ids.coachB).from('group_announcements').select('body'))).length, 0);

  const attempts = [
    ['coaching_groups', { id: ids.sara, coach_id: ids.coachA, name: 'x' }, 'id'],
    ['coaching_group_members', { group_id: id, client_id: ids.lina, joined_at: new Date().toISOString() }, 'group_id,client_id'],
    ['group_announcements', { id: ids.sara, group_id: id, author_id: ids.sara, body: 'x' }, 'id'],
  ];
  for (const [table, row, conflict] of attempts) {
    const direct = await as(ids.sara).from(table).upsert(row, { onConflict: conflict });
    assert.match(direct.error.message, /permission denied/, table);
  }
});

test('coaches post announcements to their own groups only', async () => {
  const id = await makeGroup();
  const announcement = await ok(as(ids.coachA).rpc('post_group_announcement', { p_group_id: id, p_body: '  Great work this week!  ' }));
  assert.equal((await rows('select body, author_id from public.group_announcements where id = $1', [announcement]))[0].body, 'Great work this week!');

  await fails(as(ids.coachA).rpc('post_group_announcement', { p_group_id: id, p_body: ' ' }), /1000/);
  await fails(as(ids.coachA).rpc('post_group_announcement', { p_group_id: id, p_body: 'x'.repeat(1001) }), /1000/);
  await fails(as(ids.coachB).rpc('post_group_announcement', { p_group_id: id, p_body: 'hi' }), /not found/);
  await fails(as(ids.sara).rpc('post_group_announcement', { p_group_id: id, p_body: 'hi' }), /not found/);
  await fails(as(ids.coachB).rpc('delete_group_announcement', { p_announcement_id: announcement }), /not found/);
  await ok(as(ids.coachA).rpc('delete_group_announcement', { p_announcement_id: announcement }));
  assert.equal(await count('select count(*) as n from public.group_announcements'), 0);
});

test('a member sees their groups with the shared program and the coach\'s updates', async () => {
  const programId = await makeProgram();
  await db.query("insert into public.exercises (slug, name, category, difficulty, is_published) values ('squat', 'Back Squat', 'strength', 'beginner', true)");
  await db.query("insert into public.training_program_days (program_id, name, order_index) values ($1, 'Day 1 - Legs', 0)", [programId]);
  await db.query("insert into public.training_program_exercises (day_id, exercise_id, order_index, sets, reps) select d.id, e.id, 0, 5, '5' from public.training_program_days d, public.exercises e where e.slug = 'squat'");

  const id = await makeGroup(ids.coachA, 'Legs group', 'Squat more');
  await ok(addMembers(ids.coachA, id, [ids.sara, ids.omar]));
  await ok(as(ids.coachA).rpc('assign_program_to_group', { p_group_id: id, p_program_id: programId }));
  await ok(as(ids.coachA).rpc('post_group_announcement', { p_group_id: id, p_body: 'Squat day tomorrow' }));

  const [group] = await ok(as(ids.sara).rpc('get_my_groups'));
  assert.equal(group.name, 'Legs group');
  assert.equal(group.coach_name, 'Amal Strength');
  assert.equal(group.member_count, 2);
  assert.equal(group.program.title, 'Strength Basics');
  assert.deepEqual(group.program.days[0].exercises, [{ name: 'Back Squat', sets: 5, reps: '5' }]);
  assert.deepEqual(group.announcements.map((item) => item.body), ['Squat day tomorrow']);
  assert.equal(JSON.stringify(group).includes('omar'), false, 'other members are not exposed');

  assert.deepEqual(await ok(as(ids.lina).rpc('get_my_groups')), []);
  assert.deepEqual(await ok(as(ids.bFan).rpc('get_my_groups')), []);
  await fails(as(ids.coachA).rpc('get_my_groups'), /client account/);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual(await ok(as(ids.sara).rpc('get_my_groups')), [], 'archived clients no longer see the group');
});

test('deleting a group removes its members and announcements but keeps the program and assignments', async () => {
  const programId = await makeProgram();
  const id = await makeGroup();
  await ok(addMembers(ids.coachA, id, [ids.sara]));
  await ok(as(ids.coachA).rpc('assign_program_to_group', { p_group_id: id, p_program_id: programId }));
  await ok(as(ids.coachA).rpc('post_group_announcement', { p_group_id: id, p_body: 'Hello' }));
  await ok(as(ids.coachA).rpc('delete_group', { p_group_id: id }));

  assert.equal(await count('select count(*) as n from public.coaching_group_members'), 0);
  assert.equal(await count('select count(*) as n from public.group_announcements'), 0);
  assert.equal(await count('select count(*) as n from public.training_programs'), 1);
  assert.equal(await count('select count(*) as n from public.program_assignments'), 1);
});
