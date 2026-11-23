import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { teamErrorTranslations } from '../src/i18n/teamErrorTranslations.js';
import { TEAM_ERROR_KEYS, TEAM_ERROR_MESSAGES, teamErrorKey, teamErrorText } from '../src/services/teamErrors.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003100_team_invitation_rules.sql', import.meta.url);

const ids = {
  head: '00000000-0000-4000-8000-0000000000a1',
  head2: '00000000-0000-4000-8000-0000000000a2',
  newbie: '00000000-0000-4000-8000-0000000000d1',
  sara: '00000000-0000-4000-8000-0000000000c1',
};
const PERMISSIONS = { manage_programs: true, view_assessments: true, messages: true, manage_groups: true };

let db;
const as = (userId) => createUserClient(db, userId);

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

const invite = async (email = 'newbie@example.com') => ok(as(ids.head).rpc('invite_trainer', { p_email: email, p_role_title: 'Assistant', p_permissions: PERMISSIONS }));
const accept = (memberId, userId = ids.newbie) => as(userId).rpc('accept_team_invitation', { p_member_id: memberId });
const subscribe = (userId, status, periodEnd) => db.query(
  "insert into public.coach_subscriptions (user_id, status, provider, current_period_end) values ($1, $2, 'paddle', $3)",
  [userId, status, periodEnd],
);
const days = (count) => new Date(Date.now() + count * 86_400_000).toISOString();

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.head, email: 'head@example.com', role: 'coach', fullName: 'Head Coach' });
  await addUser(db, { id: ids.head2, email: 'head2@example.com', role: 'coach', fullName: 'Second Coach' });
  await addUser(db, { id: ids.newbie, email: 'newbie@example.com', role: 'coach', fullName: 'New Coach' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
});

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('a brand-new coach on the free trial, with nothing of their own, joins a team without trouble', async () => {
  const profile = (await db.query('select trial_ends_at > now() as trial from public.profiles where id = $1', [ids.newbie])).rows[0];
  assert.equal(profile.trial, true);
  const status = await ok(accept(await invite()));
  assert.equal(status.access_state, 'trainer');
  assert.equal(status.team.head_coach_id, ids.head);
});

test('a coach whose trial already ended, and who has nothing of their own, can join too', async () => {
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.newbie]);
  const status = await ok(accept(await invite()));
  assert.equal(status.access_state, 'trainer');
});

test('a coach with clients keeps running their own practice and cannot join', async () => {
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com')", [ids.newbie, ids.sara]);
  await refused(accept(await invite()), /own coaching practice/);
  assert.equal((await db.query("select count(*)::int as n from public.coach_team_members where status = 'active'")).rows[0].n, 0);
});

test('a paid subscription in force blocks joining; an ended or canceled one does not', async () => {
  const memberId = await invite();
  await subscribe(ids.newbie, 'active', days(20));
  await refused(accept(memberId), /own coaching practice/);

  await db.query("update public.coach_subscriptions set status = 'past_due', current_period_end = $2 where user_id = $1", [ids.newbie, days(-1)]);
  await refused(accept(memberId), /own coaching practice/);

  await db.query("update public.coach_subscriptions set status = 'past_due', current_period_end = $2 where user_id = $1", [ids.newbie, days(-10)]);
  assert.equal((await ok(accept(memberId))).access_state, 'trainer');
});

test('a canceled subscription does not stop a coach from joining', async () => {
  await subscribe(ids.newbie, 'canceled', days(-30));
  assert.equal((await ok(accept(await invite()))).access_state, 'trainer');
});

test('a coach who has a team of their own cannot join another one', async () => {
  const memberId = await invite();
  await ok(as(ids.newbie).rpc('invite_trainer', { p_email: 'someone@example.com', p_role_title: '', p_permissions: PERMISSIONS }));
  await refused(accept(memberId), /already has its own team/);
  await db.query('delete from public.coach_team_members where head_coach_id = $1', [ids.newbie]);
  assert.equal((await ok(accept(memberId))).access_state, 'trainer');
});

test('only the invited coach can accept, and a second team is refused', async () => {
  const memberId = await invite();
  await refused(accept(memberId, ids.head2), /not available/);
  await refused(accept(memberId, ids.sara), /coach account/);
  await ok(accept(memberId));
  const other = await ok(as(ids.head2).rpc('invite_trainer', { p_email: 'newbie@example.com', p_role_title: '', p_permissions: PERMISSIONS }));
  await refused(accept(other), /already belong to a team/);
});

// ----------------------------------------------------------------------------------------- the words

function messagesIn(sql, functionName) {
  const start = sql.indexOf(`create or replace function public.${functionName}(`);
  assert.ok(start >= 0, functionName);
  const next = sql.indexOf('create or replace function', start + 10);
  const body = sql.slice(start, next === -1 ? undefined : next);
  return [...body.matchAll(/raise exception '((?:[^']|'')+)'/g)].map((match) => match[1].replace(/''/g, "'"));
}

test('every refusal of the team functions has a translation key', () => {
  const store = read('supabase/migrations/20261115001100_store_team_video.sql');
  const rules = read('supabase/migrations/20261115003100_team_invitation_rules.sql');
  const wanted = [
    ...['invite_trainer', 'update_team_member', 'remove_team_member', 'assign_client_trainer', 'get_my_team_invitations', 'decline_team_invitation', 'leave_team', 'get_trainer_overview', 'send_team_message']
      .flatMap((name) => messagesIn(store, name)),
    ...messagesIn(rules, 'accept_team_invitation'),
  ];
  assert.ok(wanted.length >= 25, `${wanted.length} messages`);
  for (const message of new Set(wanted)) assert.ok(teamErrorKey(message), `no translation for: ${message}`);
});

test('every sentence in the map is a real message of the database', () => {
  const sql = read('supabase/manual-setup.sql');
  for (const message of TEAM_ERROR_MESSAGES) assert.ok(sql.includes(`'${message.replace(/'/g, "''")}`), message);
});

test('the error is shown in the chosen language, and unknown errors are shown as they came', () => {
  const english = (key) => translations.en[key];
  const arabic = (key) => translations.ar[key];
  const error = new Error('This account already runs its own coaching practice, so it cannot join a team');
  assert.equal(teamErrorKey(error), 'tmErr_ownPractice');
  assert.equal(teamErrorText(error, arabic), 'هذا الحساب يعمل كمدرب مستقل بالفعل ولديه عملاء أو اشتراك نشط، لذا لا يمكنه الانضمام لفريق مدرب آخر.');
  assert.match(teamErrorText(error, english), /already runs its own coaching practice/);
  assert.equal(teamErrorText({ message: 'You already belong to a team.' }, arabic), 'أنت تنتمي إلى فريق بالفعل.');
  assert.equal(teamErrorText({ message: 'Something nobody planned for' }, arabic), 'Something nobody planned for');
  assert.equal(teamErrorText(null, arabic), '');
  assert.equal(teamErrorKey(undefined), null);
});

test('every language translates every team error, with no left-over English in Arabic', () => {
  assert.deepEqual([...new Set(TEAM_ERROR_KEYS)].sort(), Object.keys(teamErrorTranslations.en).sort());
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(teamErrorTranslations[locale]).sort(), Object.keys(teamErrorTranslations.en).sort(), locale);
    for (const key of TEAM_ERROR_KEYS) assert.ok(translations[locale][key], `${locale}.${key}`);
  }
  for (const key of TEAM_ERROR_KEYS) assert.doesNotMatch(translations.ar[key], /[A-Za-z]{3,}/, key);
});

test('the team screens translate what the database says instead of printing it', () => {
  for (const file of ['src/components/TeamInvitationNotice.jsx', 'src/pages/TeamPage.jsx', 'src/pages/TeamClientsPage.jsx']) {
    const source = read(file);
    assert.match(source, /teamErrorText\(/, file);
    assert.doesNotMatch(source, /\$\{\w*[eE]rror\.message\}|setError\(\w*[eE]rror\.message\)|showToast\(\w*[eE]rror\.message\)/, file);
  }
});
