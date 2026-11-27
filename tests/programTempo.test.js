import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { tempoTranslations } from '../src/i18n/tempoTranslations.js';
import { describeTempo, isValidTempo, normalizeTempo, tempoParts } from '../src/services/tempoUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
let db;
let squat;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const day = (extra = {}) => [{ name: 'Day 1', exercises: [{ exercise_id: squat, sets: 4, reps: '6-8', rest_seconds: 120, notes: 'Brace', ...extra }] }];
const save = (userId, extra, title = 'Strength') => as(userId).rpc('save_training_program', { p_title: title, p_description: '', p_days: day(extra) });

before(async () => { db = await createTestDatabase(); });

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; truncate public.exercises cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.omar, email: 'omar@example.com', role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
  [{ id: squat }] = await rows("insert into public.exercises (slug, name, category, difficulty, is_published) values ('barbell-squat', 'Barbell Squat', 'strength', 'beginner', true) returning id");
});

// ------------------------------------------------------------------------------------------ the database

test('a program exercise stores its tempo, upper-cased; no tempo is an empty string', async () => {
  const withTempo = await save(ids.coach, { tempo: ' 3-1-x-0 ' });
  assert.equal(withTempo.error, null, withTempo.error?.message);
  const without = await save(ids.coach, {}, 'No tempo');
  assert.equal(without.error, null);
  const stored = await rows('select p.title, e.tempo from public.training_program_exercises e join public.training_program_days d on d.id = e.day_id join public.training_programs p on p.id = d.program_id order by p.title');
  assert.deepEqual(stored.map((row) => [row.title, row.tempo]), [['No tempo', ''], ['Strength', '3-1-X-0']]);
});

test('a malformed tempo is refused by the save function and by the table', async () => {
  for (const tempo of ['3-1-1', '3-1-1-0-1', 'fast', '10-1-1-0', '3_1_1_0']) {
    const result = await save(ids.coach, { tempo });
    assert.match(result.error?.message ?? '', /Tempo must have four parts/, tempo);
  }
  assert.equal((await rows('select count(*)::int as n from public.training_programs'))[0].n, 0);
  const [{ id: programId }] = await rows("insert into public.training_programs (coach_id, title) values ($1, 'T') returning id", [ids.coach]);
  const [{ id: dayId }] = await rows("insert into public.training_program_days (program_id, name, order_index) values ($1, 'D', 0) returning id", [programId]);
  await assert.rejects(
    () => db.query("insert into public.training_program_exercises (day_id, exercise_id, order_index, tempo) values ($1, $2, 0, '3-1-1')", [dayId, squat]),
    /tempo_check/,
  );
});

test('duplicating a program or a template keeps the tempo of every exercise', async () => {
  const saved = await save(ids.coach, { tempo: '4-0-1-0' });
  const copy = await as(ids.coach).rpc('duplicate_training_program', { p_program_id: saved.data, p_title: 'Copy', p_as_template: true });
  assert.equal(copy.error, null, copy.error?.message);
  const [row] = await rows('select e.tempo, e.notes, e.rest_seconds from public.training_program_exercises e join public.training_program_days d on d.id = e.day_id where d.program_id = $1', [copy.data]);
  assert.deepEqual([row.tempo, row.notes, row.rest_seconds], ['4-0-1-0', 'Brace', 120]);
});

test('the builder can read the tempo back through the program query', async () => {
  const saved = await save(ids.coach, { tempo: '2-0-2-0' });
  const [row] = await rows('select tempo from public.training_program_exercises where day_id in (select id from public.training_program_days where program_id = $1)', [saved.data]);
  assert.equal(row.tempo, '2-0-2-0');
  assert.match(read('src/services/workoutProgramService.js'), /rest_seconds,tempo,notes/);
});

test('a client sees the programs assigned to them, with tempo, and nobody else does', async () => {
  const saved = await save(ids.coach, { tempo: '3-1-1-0' });
  const other = await save(ids.coach, { tempo: '5-0-1-0' }, 'Not assigned');
  assert.equal(other.error, null);
  assert.equal((await as(ids.sara).rpc('get_my_assigned_programs')).data.length, 0);
  const assigned = await as(ids.coach).rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: saved.data });
  assert.equal(assigned.error, null, assigned.error?.message);
  const mine = await as(ids.sara).rpc('get_my_assigned_programs');
  assert.equal(mine.error, null, mine.error?.message);
  assert.equal(mine.data.length, 1);
  const [program] = mine.data;
  assert.equal(program.title, 'Strength');
  const [item] = program.days[0].exercises;
  assert.deepEqual([item.tempo, item.sets, item.reps, item.rest_seconds, item.notes, item.exercise.name], ['3-1-1-0', 4, '6-8', 120, 'Brace', 'Barbell Squat']);
  assert.equal((await as(ids.omar).rpc('get_my_assigned_programs')).data.length, 0);
  assert.match((await as(ids.coach).rpc('get_my_assigned_programs')).error.message, /client account/);
});

test('an assigned program disappears when the client is archived, and an assigned program is listed once', async () => {
  const saved = await save(ids.coach, { tempo: '3-1-1-0' });
  await as(ids.coach).rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: saved.data });
  await as(ids.coach).rpc('assign_program_to_client', { p_client_id: ids.sara, p_program_id: saved.data });
  assert.equal((await as(ids.sara).rpc('get_my_assigned_programs')).data.length, 1);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.equal((await as(ids.sara).rpc('get_my_assigned_programs')).data.length, 0);
});

// ------------------------------------------------------------------------------------------ the helpers

test('tempo input is normalised: separators, plain digits, case and Arabic-Indic digits', () => {
  for (const [input, expected] of [['3-1-1-0', '3-1-1-0'], ['3110', '3-1-1-0'], ['3 1 1 0', '3-1-1-0'], ['3,1,1,0', '3-1-1-0'], ['3/1/1/0', '3-1-1-0'], ['2-0-x-0', '2-0-X-0'], ['٣-١-١-٠', '3-1-1-0'], ['  ', ''], [null, '']]) {
    assert.equal(normalizeTempo(input), expected, String(input));
  }
});

test('tempo validity: empty is fine, four digits or X are fine, anything else is not', () => {
  for (const value of ['', '3-1-1-0', '3110', 'X-0-X-0', '٣١١٠']) assert.equal(isValidTempo(value), true, value);
  for (const value of ['3-1-1', '3-1-1-0-1', 'abcd', '31-1-1-0', '3-1-1-']) assert.equal(isValidTempo(value), false, value);
  assert.equal(tempoParts('bad'), null);
  assert.deepEqual(tempoParts('3-1-X-0'), [
    { phase: 'down', value: '3' }, { phase: 'bottom', value: '1' }, { phase: 'up', value: 'X' }, { phase: 'top', value: '0' },
  ]);
});

test('the tempo is explained in the user language', () => {
  const t = (locale) => (key) => translations[locale][key] || key;
  assert.equal(describeTempo('3-1-X-0', t('en')), 'Lowering 3 s · Pause at the bottom 1 s · Lifting explosive · Pause at the top 0 s');
  assert.match(describeTempo('3-1-1-0', t('ar')), /النزول 3 ث/);
  assert.match(describeTempo('3-1-1-0', t('de')), /Absenken 3 s/);
  assert.equal(describeTempo('nope', t('en')), '');
});

test('every tempo text exists in all five languages and is merged into the app dictionary', () => {
  const keys = Object.keys(tempoTranslations.en).sort();
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(tempoTranslations[locale]).sort(), keys, locale);
    for (const key of keys) assert.equal(translations[locale][key], tempoTranslations[locale][key], `${locale}.${key}`);
  }
  assert.match(translations.ar.tpHelp, /[\u0600-\u06FF]/);
});

test('the builder, the templates page and the client workouts page all show tempo', () => {
  assert.match(read('src/pages/WorkoutBuilderPage.jsx'), /tempo: normalizeTempo\(exercise\.tempo\)/);
  assert.match(read('src/pages/ProgramTemplatesPage.jsx'), /ProgramPreview/);
  assert.match(read('src/pages/ClientPortalPage.jsx'), /section === 'workouts' && <><ClientAssignedProgram \/>/);
  assert.ok(read('supabase/manual-setup.sql').includes('-- ===== 20261115003900_program_exercise_tempo.sql ====='));
});
