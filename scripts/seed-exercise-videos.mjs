// Links the essential exercises of the library to clean demo videos.
//
//   node scripts/seed-exercise-videos.mjs --report            how many of the essential exercises have a video, and which do not
//   node scripts/seed-exercise-videos.mjs --dry-run           check data/exercise-videos.json and show what would be written
//   node scripts/seed-exercise-videos.mjs --check-urls        also ask YouTube / Vimeo / the file host whether each video really exists
//   node scripts/seed-exercise-videos.mjs                     write the videos into exercises.demo_video_url (needs the two variables below)
//
// data/exercise-videos.json is the list you maintain: { "barbell-squat": "https://www.youtube.com/watch?v=...", ... }
// (the slug is the exercise's slug in data/free-exercise-db-apexfit.json). A link may be a YouTube, Vimeo or direct MP4/WebM
// address; YouTube links are always played from youtube-nocookie.com. data/essential-exercises.json is the list of the
// 150-200 exercises that should have one (build it again with scripts/build-essential-exercises.mjs).
// Run it as often as you like: it only touches the exercises named in the file, and leaves the rest alone.
//
//   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to write (never put the service-role key in the browser).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getVideoPlayback, validateVideoLink } from '../src/services/exerciseVideo.js';

const root = path.resolve(import.meta.dirname, '..');
const BATCH_PAUSE_MS = 120;

// { slug: url } or { slug: { url } }; keys that start with "_" are notes.
export function readVideoMap(json) {
  const entries = [];
  for (const [slug, value] of Object.entries(json || {})) {
    if (slug.startsWith('_')) continue;
    const url = typeof value === 'string' ? value : value?.url;
    entries.push({ slug, url: String(url ?? '').trim() });
  }
  return entries;
}

// Sorts the file's entries into ones that can be written and ones that cannot, and measures the coverage of the essential list.
export function planSeed({ essential, catalog, videos }) {
  const known = new Set(catalog.map((exercise) => exercise.slug));
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const { slug, url } of videos) {
    if (!known.has(slug)) {
      invalid.push({ slug, url, reason: 'The slug is not in the exercise catalog.' });
      continue;
    }
    if (seen.has(slug)) {
      invalid.push({ slug, url, reason: 'The slug appears twice.' });
      continue;
    }
    seen.add(slug);
    const check = validateVideoLink(url);
    if (!url || check.empty) invalid.push({ slug, url, reason: 'The link is empty.' });
    else if (!check.ok) invalid.push({ slug, url, reason: check.error === 'evErr_unsupported' ? 'Use a YouTube or Vimeo link, or a direct MP4/WebM file.' : 'The link must be a complete https address.' });
    else valid.push({ slug, url: check.value, provider: check.provider });
  }
  const covered = new Set(valid.map((item) => item.slug));
  const missing = essential.filter((item) => !covered.has(item.slug));
  return {
    valid,
    invalid,
    coverage: { essential: essential.length, covered: essential.length - missing.length, missing },
  };
}

// Asks the video's own site whether the video exists and may be embedded. A file is checked with a HEAD request.
export async function checkVideoExists(url, fetchImpl = fetch) {
  const playback = getVideoPlayback(url);
  if (!playback) return { ok: false, reason: 'not a supported link' };
  const target = playback.provider === 'youtube'
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(playback.watchUrl)}`
    : playback.provider === 'vimeo'
      ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(playback.watchUrl)}`
      : playback.src;
  try {
    const response = await fetchImpl(target, { method: playback.provider === 'file' ? 'HEAD' : 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (response.ok) return { ok: true };
    return { ok: false, reason: response.status === 401 || response.status === 403 ? 'the owner does not allow embedding' : `answered with HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, reason: `could not be reached (${error.message})` };
  }
}

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(path.join(root, file), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`${file}: ${error.message}`);
  }
};

async function main() {
  const flags = new Set(process.argv.slice(2));
  const catalog = await readJson('data/free-exercise-db-apexfit.json');
  const essential = (await readJson('data/essential-exercises.json')).exercises;
  const videos = readVideoMap(await readJson('data/exercise-videos.json', {}));
  const plan = planSeed({ essential, catalog, videos });

  console.log(`${plan.valid.length} usable video link(s) in data/exercise-videos.json.`);
  for (const item of plan.invalid) console.log(`  skipped ${item.slug}: ${item.reason}`);
  const { covered, essential: total, missing } = plan.coverage;
  console.log(`Coverage of the essential exercises: ${covered} of ${total} (${Math.round((covered / Math.max(1, total)) * 100)}%).`);

  if (flags.has('--report')) {
    await writeFile(path.join(root, 'data', 'exercise-videos.missing.json'), `${JSON.stringify(missing.map(({ slug, name, group }) => ({ slug, name, group, url: '' })), null, 2)}\n`);
    console.log(`The ${missing.length} exercises still without a video are listed in data/exercise-videos.missing.json (fill in "url" and move the entries into exercise-videos.json).`);
    return;
  }

  let usable = plan.valid;
  if (flags.has('--check-urls')) {
    usable = [];
    for (const item of plan.valid) {
      const result = await checkVideoExists(item.url);
      if (result.ok) usable.push(item);
      else console.log(`  not available ${item.slug}: ${result.reason}`);
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    }
    console.log(`${usable.length} of ${plan.valid.length} link(s) answered.`);
  }
  if (flags.has('--dry-run')) {
    console.log('Dry run: nothing was written.');
    return;
  }
  if (usable.length === 0) {
    console.log('Nothing to write.');
    return;
  }

  const projectUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the local environment to write the videos.');
  const client = createClient(projectUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  let written = 0;
  for (const item of usable) {
    const { data, error } = await client.from('exercises').update({ demo_video_url: item.url }).eq('slug', item.slug).select('slug');
    if (error) throw new Error(`${item.slug}: ${error.message}`);
    if (data?.length) written += 1;
    else console.log(`  ${item.slug} is not in the database yet: import the catalog first.`);
  }
  console.log(`${written} exercise(s) now have their video.`);
}

if (process.argv[1]?.endsWith('seed-exercise-videos.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}