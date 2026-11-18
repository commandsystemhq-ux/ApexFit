import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeExerciseMedia, normalizeExerciseRecord } from '../src/services/exerciseCatalogUtils.js';
import {
  MAX_ANIMATION_BYTES, animationKind, checkAnimationSize, chooseMedia, connectionIsLight, validFrames,
} from '../src/services/exerciseMedia.js';
import { translations } from '../src/i18n/translations.js';
import { createTestDatabase } from './helpers/pgliteSupabase.js';

// Looping exercise demos: which one is shown, how little data they cost, and how they are stored.

const MIGRATION = new URL('../supabase/migrations/20261115002200_exercise_animations.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const POSTER = 'https://cdn.example.com/squat/0.jpg';
const FRAMES = [POSTER, 'https://cdn.example.com/squat/1.jpg'];
const RECORD = { slug: 'squat', name: 'Squat', category: 'strength', primary_muscles: ['quadriceps'], equipment: ['bodyweight'], difficulty: 'beginner', instructions: ['Stand.'] };

// ------------------------------------------------------------------ what is shown

test('animation files are recognised by type and must be HTTPS', () => {
  assert.equal(animationKind('https://cdn.example.com/squat.mp4'), 'video');
  assert.equal(animationKind('https://cdn.example.com/squat.WEBM?v=2'), 'video');
  assert.equal(animationKind('https://cdn.example.com/squat.gif'), 'gif');
  assert.equal(animationKind('https://cdn.example.com/squat.webp'), 'gif');
  for (const bad of ['http://cdn.example.com/squat.mp4', 'https://user:pw@cdn.example.com/squat.mp4', 'https://cdn.example.com/squat.mov', 'https://cdn.example.com/squat', 'javascript:alert(1)', '', null, undefined, 42]) {
    assert.equal(animationKind(bad), null, String(bad));
  }
  assert.deepEqual(validFrames([...FRAMES, 'http://x.example.com/a.jpg', 'nope', ...FRAMES, 'https://c.example.com/3.jpg', 'https://c.example.com/4.jpg']), [...FRAMES, 'https://c.example.com/3.jpg', 'https://c.example.com/4.jpg']);
  assert.deepEqual(validFrames(null), []);
});

test('a video or GIF wins; otherwise the real start and end photos loop; otherwise the still photo', () => {
  const video = { thumbnail_url: POSTER, image_frames: FRAMES, animation_url: 'https://cdn.example.com/squat.mp4' };
  assert.deepEqual(chooseMedia(video), { mode: 'video', src: 'https://cdn.example.com/squat.mp4', poster: POSTER });
  assert.equal(chooseMedia({ ...video, animation_url: 'https://cdn.example.com/squat.gif' }).mode, 'gif');

  const frames = chooseMedia({ thumbnail_url: POSTER, image_frames: FRAMES });
  assert.deepEqual([frames.mode, frames.frames, frames.poster], ['frames', FRAMES, POSTER]);

  assert.deepEqual(chooseMedia({ thumbnail_url: POSTER, image_frames: [FRAMES[1]] }), { mode: 'still', poster: POSTER });
  assert.deepEqual(chooseMedia({ image_frames: [] , thumbnail_url: POSTER }), { mode: 'still', poster: POSTER });
  assert.deepEqual(chooseMedia({ image_frames: [FRAMES[1]] }), { mode: 'still', poster: FRAMES[1] });
  assert.deepEqual(chooseMedia({}), { mode: 'none' });
  assert.deepEqual(chooseMedia(null), { mode: 'none' });
});

test('slow connections and reduced motion get the poster, and the animation only when asked for', () => {
  const video = { thumbnail_url: POSTER, image_frames: FRAMES, animation_url: 'https://cdn.example.com/squat.mp4' };
  for (const prefs of [{ light: true }, { reducedMotion: true }, { light: true, reducedMotion: true }]) {
    const choice = chooseMedia(video, prefs);
    assert.deepEqual([choice.mode, choice.poster, choice.playable], ['poster', POSTER, { mode: 'video', src: 'https://cdn.example.com/squat.mp4' }], JSON.stringify(prefs));
    assert.equal(chooseMedia(video, { ...prefs, requested: true }).mode, 'video');
  }
  // The photos that loop cost a second image, so they are not loaded on a light connection either.
  assert.equal(chooseMedia({ thumbnail_url: POSTER, image_frames: FRAMES }, { light: true }).mode, 'still');
  assert.equal(chooseMedia({ thumbnail_url: POSTER, image_frames: FRAMES }, { reducedMotion: true }).mode, 'still');
});

test('a failed animation falls back to the photos', () => {
  const exercise = { thumbnail_url: POSTER, image_frames: FRAMES, animation_url: 'https://cdn.example.com/squat.mp4' };
  assert.equal(chooseMedia({ ...exercise, animation_url: null }).mode, 'frames');
  assert.equal(chooseMedia({ ...exercise, animation_url: null, image_frames: [] }).mode, 'still');
});

test('save-data and slow networks count as a light connection', () => {
  assert.equal(connectionIsLight({ saveData: true }), true);
  for (const effectiveType of ['slow-2g', '2g', '3g']) assert.equal(connectionIsLight({ effectiveType }), true, effectiveType);
  assert.equal(connectionIsLight({ effectiveType: '4g' }), false);
  assert.equal(connectionIsLight({}), false);
  assert.equal(connectionIsLight(undefined), false);
});

// ------------------------------------------------------------------ size limit

const reply = (status, length) => async () => ({ ok: status < 400, status, headers: { get: (name) => (name.toLowerCase() === 'content-length' && length !== undefined ? String(length) : null) } });

test('only light animation files are accepted', async () => {
  assert.equal(MAX_ANIMATION_BYTES, 2 * 1024 * 1024);
  assert.deepEqual(await checkAnimationSize('https://x/a.mp4', { fetchImpl: reply(200, 300_000) }), { ok: true, bytes: 300_000 });
  assert.equal((await checkAnimationSize('https://x/a.mp4', { fetchImpl: reply(200, MAX_ANIMATION_BYTES) })).ok, true);
  const heavy = await checkAnimationSize('https://x/a.gif', { fetchImpl: reply(200, 5 * 1024 * 1024) });
  assert.equal(heavy.ok, false);
  assert.match(heavy.reason, /5\.0 MB; the limit is 2 MB/);
  assert.match((await checkAnimationSize('https://x/a.gif', { fetchImpl: reply(404) })).reason, /HTTP 404/);
  assert.match((await checkAnimationSize('https://x/a.gif', { fetchImpl: reply(200) })).reason, /did not report its size/);
  assert.match((await checkAnimationSize('https://x/a.gif', { fetchImpl: async () => { throw new Error('offline'); } })).reason, /offline/);
  assert.equal((await checkAnimationSize('https://x/a.gif', { fetchImpl: reply(200, 900), maxBytes: 500 })).ok, false);
});

// ------------------------------------------------------------------ catalog records

test('animations and frames are validated and can be merged from a media file', () => {
  const ok = normalizeExerciseRecord({ ...RECORD, animation_url: 'https://cdn.example.com/squat.mp4', image_frames: [...FRAMES, FRAMES[0]] });
  assert.equal(ok.animation_url, 'https://cdn.example.com/squat.mp4');
  assert.deepEqual(ok.image_frames, FRAMES);
  const plain = normalizeExerciseRecord(RECORD);
  assert.deepEqual([plain.animation_url, plain.image_frames], [null, []]);

  assert.throws(() => normalizeExerciseRecord({ ...RECORD, animation_url: 'http://cdn.example.com/squat.mp4' }), /HTTPS/);
  assert.throws(() => normalizeExerciseRecord({ ...RECORD, animation_url: 'https://cdn.example.com/squat.mov' }), /\.gif/);
  assert.throws(() => normalizeExerciseRecord({ ...RECORD, image_frames: ['a', 'b', 'c', 'd', 'e'].map((name) => `https://c.example.com/${name}.jpg`) }), /at most 4/);
  assert.throws(() => normalizeExerciseRecord({ ...RECORD, image_frames: 'https://c.example.com/a.jpg' }), /image_frames/);

  const merged = mergeExerciseMedia([RECORD, { ...RECORD, slug: 'lunge' }], { squat: { animation_url: 'https://cdn.example.com/squat.mp4' } });
  assert.equal(merged[0].animation_url, 'https://cdn.example.com/squat.mp4');
  assert.equal('animation_url' in merged[1], false);
  assert.throws(() => mergeExerciseMedia([RECORD], { 'no-such': { animation_url: 'https://c.example.com/a.mp4' } }), /not in the catalog: no-such/);
  assert.deepEqual(mergeExerciseMedia([RECORD]), [RECORD]);
});

test('the shipped catalog loops the real start and end photos of nearly every exercise', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/free-exercise-db-apexfit.json', import.meta.url), 'utf8'));
  const looping = catalog.filter((record) => record.image_frames.length >= 2);
  assert.ok(looping.length >= 870, `only ${looping.length} exercises have two photos`);
  for (const record of looping) {
    assert.equal(record.image_frames[0], record.thumbnail_url, record.slug);
    assert.ok(record.image_frames.every((frame) => frame.startsWith('https://')), record.slug);
  }
  assert.ok(catalog.every((record) => record.animation_url === null), 'no animation is invented');
  assert.ok(catalog.every((record) => record.demo_video_url === null), 'no video is invented');
  catalog.forEach(normalizeExerciseRecord);
});

// ------------------------------------------------------------------ database

let db;
before(async () => {
  db = await createTestDatabase();
});

const insert = (slug, animation, frames = []) => db.query(
  "insert into public.exercises (slug, name, category, difficulty, animation_url, image_frames) values ($1, 'X', 'strength', 'beginner', $2, $3)",
  [slug, animation, frames],
);

test('the database stores animations and frames and refuses unsafe or oversized values', async () => {
  await insert('a1', 'https://cdn.example.com/squat.mp4', FRAMES);
  await insert('a2', 'https://cdn.example.com/a.GIF?v=3');
  await insert('a3', null);
  await assert.rejects(insert('b1', 'http://cdn.example.com/squat.mp4'), /animation_url_check/);
  await assert.rejects(insert('b2', 'https://cdn.example.com/squat.mov'), /animation_url_check/);
  await assert.rejects(insert('b3', 'https://cdn.example.com/squat'), /animation_url_check/);
  await assert.rejects(insert('b4', 'javascript:alert(1).mp4'), /animation_url_check/);
  await assert.rejects(insert('b5', 'https://user@cdn.example.com/squat.mp4'), /animation_url_check/);
  await assert.rejects(insert('b6', null, ['http://cdn.example.com/0.jpg']), /image_frames_check/);
  await assert.rejects(insert('b7', null, ['https://c.example.com/1.jpg', 'https://c.example.com/2.jpg', 'https://c.example.com/3.jpg', 'https://c.example.com/4.jpg', 'https://c.example.com/5.jpg']), /image_frames_check/);
  const [{ n }] = (await db.query("select count(*)::int as n from public.exercises where animation_url is not null")).rows;
  assert.equal(n, 2);
  assert.deepEqual((await db.query("select image_frames from public.exercises where slug = 'a3'")).rows[0].image_frames, []);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(migration);
});

test('the new button texts exist in every language', () => {
  for (const locale of ['en', 'ar', 'de', 'fr', 'es']) {
    assert.ok(translations[locale].exerciseMediaPlay && translations[locale].exerciseViewLarger, locale);
  }
});
