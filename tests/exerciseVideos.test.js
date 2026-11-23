import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEssentialList, resolveMovement } from '../scripts/build-essential-exercises.mjs';
import { checkVideoExists, planSeed, readVideoMap } from '../scripts/seed-exercise-videos.mjs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { exerciseVideoTranslations } from '../src/i18n/exerciseVideoTranslations.js';
import { getVideoPlayback, mergeVideoOverrides, providerLabel, validateVideoLink } from '../src/services/exerciseVideo.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115003600_coach_exercise_videos.sql', import.meta.url);
const catalog = JSON.parse(read('data/free-exercise-db-apexfit.json'));
const essential = JSON.parse(read('data/essential-exercises.json'));

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  loner: '00000000-0000-4000-8000-0000000000c3',
};
const YOUTUBE = 'https://www.youtube.com/watch?v=abcdefghijk';

let db;
let squat;
let hidden;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const setVideo = (userId, exerciseId, url) => as(userId).rpc('set_exercise_video', { p_exercise_id: exerciseId, p_url: url });

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; truncate public.exercises cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.loner, 'loner@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com'), ($3, $4, 'Omar', 'omar@example.com')",
    [ids.coach, ids.sara, ids.other, ids.omar],
  );
  [{ id: squat }] = await rows("insert into public.exercises (slug, name, category, difficulty, is_published) values ('barbell-squat', 'Barbell Squat', 'strength', 'beginner', true) returning id");
  [{ id: hidden }] = await rows("insert into public.exercises (slug, name, category, difficulty, is_published) values ('secret', 'Secret', 'strength', 'beginner', false) returning id");
});

// -------------------------------------------------------------------------------------------- the player

test('YouTube plays from youtube-nocookie.com, Vimeo with do-not-track, and a file as a plain video', () => {
  for (const link of [YOUTUBE, 'https://youtu.be/abcdefghijk', 'https://www.youtube.com/shorts/abcdefghijk', 'https://m.youtube.com/embed/abcdefghijk', 'https://www.youtube-nocookie.com/embed/abcdefghijk']) {
    const playback = getVideoPlayback(link);
    assert.equal(playback.provider, 'youtube', link);
    assert.equal(new URL(playback.src).hostname, 'www.youtube-nocookie.com');
    assert.equal(new URL(playback.src).searchParams.get('rel'), '0');
    assert.equal(new URL(playback.src).searchParams.has('autoplay'), false);
    assert.equal(playback.watchUrl, YOUTUBE);
  }
  assert.equal(new URL(getVideoPlayback(YOUTUBE, { autoplay: true }).src).searchParams.get('autoplay'), '1');
  const vimeo = getVideoPlayback('https://vimeo.com/123456789', { autoplay: true });
  assert.deepEqual([vimeo.provider, vimeo.kind, new URL(vimeo.src).hostname, new URL(vimeo.src).searchParams.get('dnt'), vimeo.watchUrl], ['vimeo', 'iframe', 'player.vimeo.com', '1', 'https://vimeo.com/123456789']);
  assert.equal(getVideoPlayback('https://player.vimeo.com/video/987654321').provider, 'vimeo');
  const file = getVideoPlayback('https://cdn.example.com/squat.mp4?x=1');
  assert.deepEqual([file.kind, file.provider, file.src], ['video', 'file', 'https://cdn.example.com/squat.mp4?x=1']);
  assert.equal(getVideoPlayback('https://cdn.example.com/squat.webm').kind, 'video');
});

test('nothing is embedded from a site that is not YouTube, Vimeo or a video file', () => {
  for (const link of ['http://www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com.attacker.test/watch?v=abcdefghijk', 'https://evil.example/embed/abcdefghijk', 'https://user:pass@www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/watch?v=short', 'https://vimeo.com/not-a-number', 'https://example.com/page.html', 'javascript:alert(1)', '', null, undefined]) {
    assert.equal(getVideoPlayback(link), null, String(link));
  }
  assert.equal(providerLabel('youtube'), 'YouTube');
});

test('what the coach types is checked and named', () => {
  assert.deepEqual(validateVideoLink('  '), { ok: true, empty: true, value: '', provider: null, error: null });
  assert.deepEqual(validateVideoLink(` ${YOUTUBE} `), { ok: true, empty: false, value: YOUTUBE, provider: 'youtube', error: null });
  assert.equal(validateVideoLink('https://vimeo.com/123').provider, 'vimeo');
  assert.equal(validateVideoLink('https://cdn.example.com/a.mp4').provider, 'file');
  assert.equal(validateVideoLink('not a link').error, 'evErr_invalid');
  assert.equal(validateVideoLink('http://www.youtube.com/watch?v=abcdefghijk').error, 'evErr_invalid');
  assert.equal(validateVideoLink('https://example.com/page').error, 'evErr_unsupported');
  assert.equal(validateVideoLink(`https://cdn.example.com/${'a'.repeat(600)}.mp4`).error, 'evErr_invalid');
});

test('a coach\'s own video replaces the library\'s for the exercises that have one', () => {
  const exercises = [{ id: 'a', demo_video_url: 'https://youtu.be/libraryvid1' }, { id: 'b', demo_video_url: null }, { id: 'c', demo_video_url: null }];
  const merged = mergeVideoOverrides(exercises, [
    { exercise_id: 'a', video_url: YOUTUBE },
    { exercise_id: 'b', video_url: 'https://evil.example/x.html' },
    { exercise_id: 'a', video_url: 'https://vimeo.com/5' },
  ]);
  assert.deepEqual([merged[0].demo_video_url, merged[0].video_origin, merged[0].original_video_url], [YOUTUBE, 'coach', 'https://youtu.be/libraryvid1']);
  assert.equal(merged[1].video_origin, undefined);
  assert.equal(merged[1].demo_video_url, null);
  assert.deepEqual(mergeVideoOverrides(exercises, []), exercises);
  assert.deepEqual(mergeVideoOverrides(exercises, null), exercises);
});

// ------------------------------------------------------------------------------------------ database

test('the migration is in manual-setup.sql and can run again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('the database accepts only secure YouTube, Vimeo and video-file links', async () => {
  const valid = async (url) => (await rows('select public.exercise_video_url_valid($1) as ok', [url]))[0].ok;
  for (const url of [YOUTUBE, 'https://youtu.be/abcdefghijk', 'https://www.youtube-nocookie.com/embed/abcdefghijk', 'https://vimeo.com/123456', 'https://player.vimeo.com/video/123456', 'https://cdn.example.com/a/b.mp4', 'https://cdn.example.com/a.webm?token=1']) assert.equal(await valid(url), true, url);
  for (const url of ['http://www.youtube.com/watch?v=abcdefghijk', 'https://user@www.youtube.com/watch?v=abcdefghijk', 'https://youtube.com.evil.test/watch?v=1', 'https://example.com/page.html', 'https://vimeo.com/abc', 'javascript:alert(1)', 'https://youtu.be/short', 'https://cdn.example.com/a b.mp4', null]) assert.equal(await valid(url), false, String(url));
});

test('a coach sets, replaces and removes their own video; nobody else is affected', async () => {
  assert.deepEqual((await setVideo(ids.coach, squat, YOUTUBE)).data, { exercise_id: squat, video_url: YOUTUBE });
  await setVideo(ids.coach, squat, 'https://vimeo.com/555');
  assert.deepEqual((await as(ids.coach).from('coach_exercise_videos').select('exercise_id,video_url')).data, [{ exercise_id: squat, video_url: 'https://vimeo.com/555' }]);
  assert.deepEqual((await as(ids.other).from('coach_exercise_videos').select('exercise_id')).data, []);
  assert.equal((await rows('select demo_video_url from public.exercises where id = $1', [squat]))[0].demo_video_url, null, 'the library itself is untouched');
  assert.deepEqual((await setVideo(ids.coach, squat, '  ')).data, { exercise_id: squat, video_url: null });
  assert.deepEqual((await as(ids.coach).from('coach_exercise_videos').select('exercise_id')).data, []);
});

test('bad links, unknown exercises and non-coaches are refused', async () => {
  assert.match((await setVideo(ids.coach, squat, 'https://example.com/page')).error.message, /secure https link/);
  assert.match((await setVideo(ids.coach, squat, 'http://youtu.be/abcdefghijk')).error.message, /secure https link/);
  assert.match((await setVideo(ids.coach, hidden, YOUTUBE)).error.message, /not found/);
  assert.match((await setVideo(ids.sara, squat, YOUTUBE)).error.message, /active coach/);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.other]);
  assert.match((await setVideo(ids.other, squat, YOUTUBE)).error.message, /active coach/);
  assert.equal((await rows('select count(*)::int as n from public.coach_exercise_videos'))[0].n, 0);
  assert.ok((await as(ids.coach).sql("insert into public.coach_exercise_videos (coach_id, exercise_id, video_url) values ($1, $2, 'https://youtu.be/abcdefghijk')", [ids.coach, squat])).error);
});

test('a client sees the video of their own coach and nobody else\'s', async () => {
  await setVideo(ids.coach, squat, YOUTUBE);
  await setVideo(ids.other, squat, 'https://vimeo.com/777');
  assert.deepEqual((await as(ids.sara).from('coach_exercise_videos').select('video_url')).data, [{ video_url: YOUTUBE }]);
  assert.deepEqual((await as(ids.omar).from('coach_exercise_videos').select('video_url')).data, [{ video_url: 'https://vimeo.com/777' }]);
  assert.deepEqual((await as(ids.loner).from('coach_exercise_videos').select('video_url')).data, []);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual((await as(ids.sara).from('coach_exercise_videos').select('video_url')).data, []);
  assert.ok((await as(ids.sara).sql("update public.coach_exercise_videos set video_url = 'https://youtu.be/zzzzzzzzzzz'")).error);
});

// ----------------------------------------------------------------------------------- the essential list

test('the essential list has 150 to 200 distinct exercises of the library, in groups', () => {
  assert.ok(essential.count >= 150 && essential.count <= 200, `${essential.count}`);
  assert.equal(essential.exercises.length, essential.count);
  const slugs = new Set(catalog.map((exercise) => exercise.slug));
  assert.equal(new Set(essential.exercises.map((item) => item.slug)).size, essential.count);
  assert.ok(essential.exercises.every((item) => slugs.has(item.slug) && item.name && item.group));
  assert.deepEqual([...new Set(essential.exercises.map((item) => item.group))].sort(), ['arms', 'back', 'chest', 'conditioning', 'core', 'legs', 'mobility', 'shoulders']);
  for (const name of ['Barbell Squat', 'Barbell Bench Press - Medium Grip', 'Barbell Deadlift', 'Pullups', 'Plank']) assert.ok(essential.exercises.some((item) => item.name === name), name);
});

test('a movement is matched to the plain exercise, not to a variation of it', () => {
  assert.equal(resolveMovement(catalog, 'barbell bench press - medium grip').name, 'Barbell Bench Press - Medium Grip');
  assert.equal(resolveMovement(catalog, 'barbell squat').name, 'Barbell Squat');
  assert.equal(resolveMovement(catalog, 'incline barbell bench press').name.includes('Incline'), true);
  assert.equal(resolveMovement(catalog, 'no such movement'), null);
  const { list, unmatched } = buildEssentialList(catalog);
  assert.equal(list.length, essential.count);
  assert.ok(Array.isArray(unmatched));
});

// ------------------------------------------------------------------------------------------ the seed script

test('the video file is read, checked and measured against the essential list', () => {
  const videos = readVideoMap({ _readme: 'note', 'barbell-squat': YOUTUBE, pullups: { url: 'https://vimeo.com/42' }, plank: 'https://example.com/plank', 'nope-slug': YOUTUBE, 'barbell-deadlift': '' });
  assert.deepEqual(videos.map((item) => item.slug), ['barbell-squat', 'pullups', 'plank', 'nope-slug', 'barbell-deadlift']);
  const plan = planSeed({ essential: essential.exercises, catalog, videos });
  assert.deepEqual(plan.valid.map((item) => [item.slug, item.provider]), [['barbell-squat', 'youtube'], ['pullups', 'vimeo']]);
  assert.deepEqual(plan.invalid.map((item) => item.slug).sort(), ['barbell-deadlift', 'nope-slug', 'plank']);
  assert.equal(plan.invalid.find((item) => item.slug === 'nope-slug').reason, 'The slug is not in the exercise catalog.');
  assert.deepEqual([plan.coverage.essential, plan.coverage.covered, plan.coverage.missing.length], [essential.count, 2, essential.count - 2]);
  assert.equal(planSeed({ essential: essential.exercises, catalog, videos: [{ slug: 'plank', url: YOUTUBE }, { slug: 'plank', url: YOUTUBE }] }).invalid[0].reason, 'The slug appears twice.');
  assert.deepEqual(planSeed({ essential: [], catalog, videos: [] }).coverage, { essential: 0, covered: 0, missing: [] });
});

test('the shipped video file has no invented links', () => {
  const shipped = readVideoMap(JSON.parse(read('data/exercise-videos.json')));
  assert.deepEqual(shipped, []);
});

test('a video is checked with its own site: YouTube and Vimeo answer, files are asked for their header', async () => {
  const seen = [];
  const answering = (status) => async (url, init) => { seen.push({ url, method: init.method }); return { ok: status === 200, status }; };
  assert.deepEqual(await checkVideoExists(YOUTUBE, answering(200)), { ok: true });
  assert.match(seen[0].url, /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=/);
  assert.deepEqual(await checkVideoExists('https://vimeo.com/42', answering(404)), { ok: false, reason: 'answered with HTTP 404' });
  assert.match(seen[1].url, /^https:\/\/vimeo\.com\/api\/oembed\.json\?url=/);
  assert.deepEqual(await checkVideoExists('https://cdn.example.com/a.mp4', answering(200)), { ok: true });
  assert.equal(seen[2].method, 'HEAD');
  assert.equal((await checkVideoExists(YOUTUBE, answering(403))).reason, 'the owner does not allow embedding');
  assert.match((await checkVideoExists(YOUTUBE, async () => { throw new Error('offline'); })).reason, /offline/);
  assert.equal((await checkVideoExists('https://example.com/x', answering(200))).ok, false);
});

// ---------------------------------------------------------------------------------------------- the screens

test('the library plays videos on request, falls back to pictures, and lets a coach set their own link', () => {
  const player = read('src/components/ExerciseVideoPlayer.jsx');
  assert.match(player, /started && playback\.kind === 'iframe'/);
  assert.match(player, /sandbox="allow-scripts allow-same-origin/);
  assert.match(player, /<ExerciseMedia exercise=\{exercise\}/);
  assert.match(player, /playsInline/);
  const card = read('src/components/ExerciseCard.jsx');
  assert.match(card, /<ExerciseVideoPlayer exercise=\{exercise\} large autoPlay \/>/);
  assert.match(card, /onEditVideo/);
  const page = read('src/pages/ExerciseLibraryPage.jsx');
  assert.match(page, /canEditVideo = roleOf\(profile\) === 'coach'/);
  assert.match(page, /<ExerciseVideoEditor/);
  assert.match(read('src/services/exerciseService.js'), /mergeVideoOverrides\(exercises, await listVideoOverrides/);
  assert.match(read('src/services/exerciseVideoService.js'), /set_exercise_video/);
  assert.match(read('src/styles/app.css'), /\.exercise-video-frame \{[^}]*aspect-ratio: 16 \/ 9/);
});

test('every video text exists in every language with the same placeholders', () => {
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  const used = new Set();
  for (const file of ['src/components/ExerciseVideoPlayer.jsx', 'src/components/ExerciseVideoEditor.jsx', 'src/components/ExerciseCard.jsx', 'src/services/exerciseVideo.js']) {
    for (const match of read(file).matchAll(/['"`](ev[A-Z][A-Za-z_]*)['"`]/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 12, `${used.size} keys`);
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(exerciseVideoTranslations[locale]).sort(), Object.keys(exerciseVideoTranslations.en).sort(), locale);
    for (const key of used) assert.ok(translations[locale][key], `${locale}.${key}`);
    for (const key of Object.keys(exerciseVideoTranslations.en)) assert.equal(placeholders(exerciseVideoTranslations[locale][key]), placeholders(exerciseVideoTranslations.en[key]), `${locale}.${key}`);
  }
  assert.match(translations.ar.evPlay, /[\u0600-\u06FF]/);
});
