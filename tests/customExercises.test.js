import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { customExerciseTranslations } from '../src/i18n/customExerciseTranslations.js';
import {
  emptyCustomExerciseForm, exerciseImagePath, formFromExercise, isCustomExercise, toggleOption, validateCustomExercise, validateExerciseImage,
} from '../src/services/customExerciseUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  trainer: '00000000-0000-4000-8000-0000000000e1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
};
const YOUTUBE = 'https://www.youtube.com/watch?v=abcdefghijk';
let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const save = (userId, overrides = {}) => as(userId).sql(
  'select public.save_custom_exercise($1, $2, $3, $4::text[], $5::text[], $6::text[], $7, $8, $9, $10) as id',
  [
    overrides.name ?? 'Cable Fly Plus', overrides.description ?? 'Slow and controlled.', overrides.category ?? 'strength',
    overrides.primary ?? ['chest'], overrides.secondary ?? ['shoulders'], overrides.equipment ?? ['cable'],
    overrides.difficulty ?? 'intermediate', overrides.video ?? YOUTUBE, overrides.image ?? null, overrides.id ?? null,
  ],
);
const create = async (userId, overrides) => {
  const result = await save(userId, overrides);
  assert.equal(result.error, null, result.error?.message);
  return result.rows[0].id;
};

before(async () => { db = await createTestDatabase(); });

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users; delete from storage.objects; truncate public.exercises cascade;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
  await db.query("insert into public.exercises (slug, name, category, difficulty, is_published) values ('barbell-squat', 'Barbell Squat', 'strength', 'beginner', true)");
});

// ------------------------------------------------------------------------------------------ the database

test('a coach creates a custom exercise that is private to them and published in the shared table', async () => {
  const id = await create(ids.coach, { name: '  Cable Fly Plus  ' });
  const [row] = await rows('select * from public.exercises where id = $1', [id]);
  assert.deepEqual(
    [row.name, row.owner_coach_id, row.slug, row.is_published, row.category, row.primary_muscles, row.secondary_muscles, row.equipment, row.demo_video_url],
    ['Cable Fly Plus', ids.coach, `custom-${id}`, true, 'strength', ['chest'], ['shoulders'], ['cable'], YOUTUBE],
  );
  assert.match(row.search_text, /cable fly plus/);
});

test('only the owner, their active clients and nobody else can read a custom exercise; the library stays public', async () => {
  const id = await create(ids.coach);
  const visible = async (userId) => (await as(userId).from('exercises').eq('id', id)).data.length;
  assert.equal(await visible(ids.coach), 1);
  assert.equal(await visible(ids.sara), 1);
  assert.equal(await visible(ids.other), 0);
  assert.equal(await visible(ids.omar), 0);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.equal(await visible(ids.sara), 0);
  const anon = await db.query("set role anon; select count(*)::int as n from public.exercises where id = $1", [id]).catch(() => null);
  await db.exec('reset role');
  assert.equal(anon?.rows?.[0]?.n ?? 0, 0);
  const library = (await as(ids.other).from('exercises').eq('slug', 'barbell-squat')).data;
  assert.equal(library.length, 1);
});

test('trainers read the custom exercises of their head coach', async () => {
  await db.query("insert into auth.users (id, email) values ($1, 'tina@example.com')", [ids.trainer]);
  await db.query("insert into public.profiles (id, role, trial_started_at, trial_ends_at) values ($1, 'coach', now(), now() + interval '336 hours')", [ids.trainer]);
  const id = await create(ids.coach);
  assert.equal((await as(ids.trainer).from('exercises').eq('id', id)).data.length, 0);
  await db.query("insert into public.coach_team_members (head_coach_id, trainer_user_id, invite_email, status) values ($1, $2, 'tina@example.com', 'active')", [ids.coach, ids.trainer]);
  assert.equal((await as(ids.trainer).from('exercises').eq('id', id)).data.length, 1);
});

test('the browser cannot write the table directly and clients cannot create exercises', async () => {
  const direct = await as(ids.coach).sql("insert into public.exercises (slug, name, category, difficulty, is_published) values ('x', 'X', 'strength', 'beginner', true)");
  assert.ok(direct.error);
  const asClient = await save(ids.sara);
  assert.match(asClient.error.message, /active coach account/);
  const update = await as(ids.coach).sql("update public.exercises set name = 'Hacked' where slug = 'barbell-squat'");
  assert.equal((await rows("select name from public.exercises where slug = 'barbell-squat'"))[0].name, 'Barbell Squat');
  assert.ok(update.error || update.rows.length === 0);
});

test('invalid input is refused: name, category, muscles, video link', async () => {
  for (const [overrides, pattern] of [
    [{ name: '   ' }, /name must be/],
    [{ name: 'x'.repeat(161) }, /name must be/],
    [{ category: 'yoga' }, /valid exercise category/],
    [{ difficulty: 'expert' }, /valid difficulty/],
    [{ primary: [] }, /at least one primary muscle/],
    [{ primary: ['Chest; drop table'] }, /not valid/],
    [{ equipment: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, /at most 8/],
    [{ video: 'http://youtube.com/watch?v=abcdefghijk' }, /secure https link/],
    [{ video: 'https://evil.example/page.html' }, /secure https link/],
    [{ description: 'x'.repeat(2001) }, /cannot exceed 2000/],
  ]) {
    const result = await save(ids.coach, overrides);
    assert.match(result.error?.message ?? '', pattern, JSON.stringify(overrides).slice(0, 60));
  }
  assert.equal((await rows('select count(*)::int as n from public.exercises where owner_coach_id is not null'))[0].n, 0);
});

test('a photo must exist in the coach own folder of the private bucket', async () => {
  const mine = `${ids.coach}/photo.jpg`;
  const theirs = `${ids.other}/photo.jpg`;
  await db.query("insert into storage.buckets (id, name, public) values ('apexfit-exercise-images', 'apexfit-exercise-images', false) on conflict do nothing");
  await db.query("insert into storage.objects (bucket_id, name) values ('apexfit-exercise-images', $1), ('apexfit-exercise-images', $2)", [mine, theirs]);
  assert.match((await save(ids.coach, { image: theirs })).error.message, /photo is not valid/);
  assert.match((await save(ids.coach, { image: `${ids.coach}/missing.jpg` })).error.message, /was not uploaded/);
  const id = await create(ids.coach, { image: mine });
  assert.equal((await rows('select image_path from public.exercises where id = $1', [id]))[0].image_path, mine);
  const bucket = (await rows("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'apexfit-exercise-images'"))[0];
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), 5 * 1024 * 1024);
  assert.deepEqual(bucket.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
});

test('a coach edits only their own exercise', async () => {
  const id = await create(ids.coach);
  const edited = await create(ids.coach, { id, name: 'Cable Fly Pro', primary: ['chest', 'shoulders'], secondary: [] });
  assert.equal(edited, id);
  const [row] = await rows('select name, primary_muscles, secondary_muscles from public.exercises where id = $1', [id]);
  assert.deepEqual([row.name, row.primary_muscles, row.secondary_muscles], ['Cable Fly Pro', ['chest', 'shoulders'], []]);
  assert.match((await save(ids.other, { id })).error.message, /not found/);
  const [library] = await rows("select id from public.exercises where slug = 'barbell-squat'");
  assert.match((await save(ids.coach, { id: library.id })).error.message, /not found/);
});

test('programs may use the coach own exercises but not those of another coach', async () => {
  const mine = await create(ids.coach);
  const days = (exerciseId) => [{ name: 'Day 1', exercises: [{ exercise_id: exerciseId, sets: 3, reps: '10', rest_seconds: 60, notes: '' }] }];
  const ok = await as(ids.coach).rpc('save_training_program', { p_title: 'Chest', p_description: '', p_days: days(mine) });
  assert.equal(ok.error, null, ok.error?.message);
  const stolen = await as(ids.other).rpc('save_training_program', { p_title: 'Copy', p_description: '', p_days: days(mine) });
  assert.match(stolen.error.message, /unavailable exercise/);
  const duplicated = await as(ids.coach).rpc('duplicate_training_program', { p_program_id: ok.data, p_title: 'Chest 2' });
  assert.equal(duplicated.error, null);
});

test('an exercise used in a program cannot be deleted; an unused one can, and its photo path is returned', async () => {
  const used = await create(ids.coach, { name: 'Used' });
  const free = await create(ids.coach, { name: 'Free' });
  const saved = await as(ids.coach).rpc('save_training_program', {
    p_title: 'P', p_description: '', p_days: [{ name: 'D', exercises: [{ exercise_id: used, sets: 3, reps: '10', rest_seconds: 60, notes: '' }] }],
  });
  assert.equal(saved.error, null);
  assert.match((await as(ids.coach).rpc('delete_custom_exercise', { p_exercise_id: used })).error.message, /used in a program/);
  assert.match((await as(ids.other).rpc('delete_custom_exercise', { p_exercise_id: free })).error.message, /not found/);
  const removed = await as(ids.coach).rpc('delete_custom_exercise', { p_exercise_id: free });
  assert.equal(removed.error, null);
  assert.equal(removed.data.exercise_id, free);
  assert.equal((await rows('select count(*)::int as n from public.exercises where id = $1', [free]))[0].n, 0);
});

test('a coach is limited to 300 custom exercises', async () => {
  await db.query(
    `insert into public.exercises (slug, name, category, difficulty, is_published, owner_coach_id, primary_muscles)
     select 'c-' || g, 'E' || g, 'strength', 'beginner', true, $1, array['chest'] from generate_series(1, 300) g`,
    [ids.coach],
  );
  assert.match((await save(ids.coach)).error.message, /up to 300/);
});

test('deleting a coach account is not blocked by their programs or by client workout history', async () => {
  const used = await create(ids.coach, { name: 'Logged' });
  const free = await create(ids.coach, { name: 'Unused' });
  await as(ids.coach).rpc('save_training_program', { p_title: 'P', p_description: '', p_days: [{ name: 'D', exercises: [{ exercise_id: used, sets: 3, reps: '10', rest_seconds: 60, notes: '' }] }] });
  const [session] = await rows("insert into public.client_workout_sessions (client_id, workout_date, title) values ($1, current_date, 'Legs') returning id", [ids.sara]);
  await db.query("insert into public.client_workout_set_logs (session_id, exercise_id, exercise_order, set_number, actual_reps) values ($1, $2, 0, 1, 10)", [session.id, used]);
  await db.query('delete from public.profiles where id = $1', [ids.coach]);
  assert.equal((await rows('select count(*)::int as n from public.exercises where id = $1', [free]))[0].n, 0);
  const [kept] = await rows('select owner_coach_id, is_published from public.exercises where id = $1', [used]);
  assert.deepEqual([kept.owner_coach_id, kept.is_published], [null, false]);
  assert.equal((await rows('select count(*)::int as n from public.client_workout_set_logs'))[0].n, 1);
  assert.equal((await as(ids.sara).from('exercises').eq('id', used)).data.length, 0);
});

// ------------------------------------------------------------------------------------------ the form rules

const filled = (changes = {}) => ({ ...emptyCustomExerciseForm(), name: ' Fly ', primaryMuscles: ['chest'], ...changes });

test('the form is valid with a name and one primary muscle and produces the RPC arguments', () => {
  const check = validateCustomExercise(filled({ secondaryMuscles: ['chest', 'triceps'], equipment: ['cable', 'unknown'], videoUrl: ` ${YOUTUBE} `, imagePath: 'a/b.jpg' }));
  assert.equal(check.ok, true);
  assert.deepEqual(check.payload, {
    p_name: 'Fly', p_description: '', p_category: 'strength', p_primary_muscles: ['chest'], p_secondary_muscles: ['triceps'],
    p_equipment: ['cable'], p_difficulty: 'beginner', p_video_url: YOUTUBE, p_image_path: 'a/b.jpg',
  });
});

test('the form reports each problem with a translation key', () => {
  const check = validateCustomExercise(filled({ name: ' ', primaryMuscles: [], category: 'x', difficulty: 'y', videoUrl: 'https://example.com/a.html', description: 'z'.repeat(2001) }));
  assert.equal(check.ok, false);
  assert.deepEqual(check.errors, {
    name: 'ceErr_name', description: 'ceErr_description', category: 'ceErr_category', difficulty: 'ceErr_difficulty',
    primaryMuscles: 'ceErr_muscle', videoUrl: 'evErr_unsupported',
  });
  for (const key of Object.values(check.errors)) assert.ok(translations.en[key], key);
});

test('photo rules: JPG, PNG or WebP up to 5 MB, stored under the coach folder', () => {
  assert.equal(validateExerciseImage({ type: 'image/png', size: 1000 }), null);
  assert.equal(validateExerciseImage({ type: 'image/gif', size: 1000 }), 'ceErr_imageType');
  assert.equal(validateExerciseImage({ type: 'image/webp', size: 5 * 1024 * 1024 + 1 }), 'ceErr_imageSize');
  assert.equal(validateExerciseImage(null), 'ceErr_imageType');
  assert.equal(exerciseImagePath(ids.coach, { type: 'image/jpeg' }, 'u1'), `${ids.coach}/u1.jpg`);
});

test('toggleOption, formFromExercise and isCustomExercise', () => {
  assert.deepEqual(toggleOption(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleOption(['a', 'b'], 'a'), ['b']);
  const form = formFromExercise({ name: 'N', primary_muscles: ['core'], demo_video_url: YOUTUBE, image_path: 'p' });
  assert.deepEqual([form.name, form.primaryMuscles, form.videoUrl, form.imagePath, form.category], ['N', ['core'], YOUTUBE, 'p', 'strength']);
  assert.equal(isCustomExercise({ owner_coach_id: ids.coach }), true);
  assert.equal(isCustomExercise({ owner_coach_id: null }), false);
});

test('every custom exercise text exists in all five languages and is merged into the app dictionary', () => {
  const keys = Object.keys(customExerciseTranslations.en).sort();
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(customExerciseTranslations[locale]).sort(), keys, locale);
    for (const key of keys) assert.equal(translations[locale][key], customExerciseTranslations[locale][key], `${locale}.${key}`);
  }
  assert.match(translations.ar.ceAdd, /[\u0600-\u06FF]/);
  assert.ok(translations.en.ceDeleteConfirm.includes('{name}') && translations.ar.ceDeleteConfirm.includes('{name}'));
});

test('the library and the builder both offer the custom scope, and the manual setup contains the migration', () => {
  assert.match(read('src/pages/ExerciseLibraryPage.jsx'), /CustomExerciseEditor/);
  assert.match(read('src/pages/WorkoutBuilderPage.jsx'), /scope: pickerScope/);
  assert.ok(read('supabase/manual-setup.sql').includes('-- ===== 20261115003800_coach_custom_exercises.sql ====='));
});
