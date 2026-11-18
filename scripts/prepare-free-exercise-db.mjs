import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExerciseRecord } from '../src/services/exerciseCatalogUtils.js';

const SOURCE_REVISION = 'f00c92c7dcf1216a928a52c3706c7ce8e2f71ed5';
const SOURCE_URL = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${SOURCE_REVISION}/dist/exercises.json`;
const IMAGE_ROOT = `https://raw.githubusercontent.com/yuhonas/free-exercise-db/${SOURCE_REVISION}/exercises/`;
const OUTPUT_PATH = fileURLToPath(new URL('../data/free-exercise-db-apexfit.json', import.meta.url));

const categoryMap = {
  cardio: 'cardio',
  plyometrics: 'plyometrics',
  stretching: 'mobility',
  strength: 'strength',
  'olympic weightlifting': 'strength',
  powerlifting: 'strength',
  strongman: 'strength',
};

const difficultyMap = { beginner: 'beginner', intermediate: 'intermediate', expert: 'advanced' };
const equipmentMap = {
  bands: 'resistance_band',
  barbell: 'barbell',
  'body only': 'bodyweight',
  cable: 'cable',
  dumbbell: 'dumbbell',
  'e-z curl bar': 'barbell',
  'exercise ball': 'exercise_ball',
  'foam roll': 'foam_roller',
  kettlebells: 'kettlebell',
  machine: 'machine',
  'medicine ball': 'medicine_ball',
  other: 'other',
};
const muscleMap = {
  abdominals: 'core',
  abductors: 'abductors',
  adductors: 'adductors',
  biceps: 'biceps',
  calves: 'calves',
  chest: 'chest',
  forearms: 'forearms',
  glutes: 'glutes',
  hamstrings: 'hamstrings',
  lats: 'back',
  'lower back': 'lower_back',
  'middle back': 'back',
  neck: 'neck',
  quadriceps: 'quadriceps',
  shoulders: 'shoulders',
  traps: 'traps',
  triceps: 'triceps',
};

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function convertExercise(source) {
  const category = categoryMap[source.category];
  const difficulty = difficultyMap[source.level];
  if (!category || !difficulty) {
    throw new Error(`Unsupported category or level in upstream record "${source.name}".`);
  }

  const equipment = source.equipment ? equipmentMap[source.equipment] : null;
  if (source.equipment && !equipment) {
    throw new Error(`Unsupported equipment "${source.equipment}" in upstream record "${source.name}".`);
  }

  const primaryMuscles = (source.primaryMuscles || []).map((muscle) => {
    const mappedMuscle = muscleMap[muscle];
    if (!mappedMuscle) throw new Error(`Unsupported muscle "${muscle}" in upstream record "${source.name}".`);
    return mappedMuscle;
  });
  const firstImage = source.images?.[0];
  // The upstream photos of the start and end of the movement; shown as a looping animation by the app.
  const frames = (source.images || []).slice(0, 4).map((image) => new URL(image, IMAGE_ROOT).href);
  const instructions = (source.instructions || []).filter(
    (instruction) => typeof instruction === 'string' && instruction.trim(),
  );
  const normalized = normalizeExerciseRecord({
    slug: slugify(source.id || source.name),
    name: source.name,
    category,
    primary_muscles: primaryMuscles,
    equipment: equipment ? [equipment] : [],
    difficulty,
    instructions,
    demo_video_url: null,
    thumbnail_url: firstImage ? new URL(firstImage, IMAGE_ROOT).href : null,
    image_frames: frames.length >= 2 ? frames : [],
  });

  return normalized;
}

async function main() {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`Could not download the source dataset: HTTP ${response.status}`);
  const sourceRecords = await response.json();
  if (!Array.isArray(sourceRecords) || sourceRecords.length === 0) {
    throw new TypeError('The upstream exercise dataset is empty or has an invalid shape.');
  }

  const slugs = new Set();
  const records = sourceRecords.map((record) => {
    const normalized = convertExercise(record);
    if (slugs.has(normalized.slug)) throw new Error(`Duplicate exercise slug in source: ${normalized.slug}.`);
    slugs.add(normalized.slug);
    return normalized;
  });

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  console.log(`Prepared ${records.length} real exercise records from free-exercise-db.`);
  console.log('The source contains photos (start and end of each movement) but no videos or GIFs; demo_video_url and animation_url stay empty.');
  console.log('Add your own licensed animations in data/exercise-media.json, see data/README.md.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
