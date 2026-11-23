// Builds data/essential-exercises.json: the 150-200 most useful exercises of the library, picked by name from a curated
// list of movements and matched to the catalog (data/free-exercise-db-apexfit.json). Run it again after the catalog or
// the list changes:  node scripts/build-essential-exercises.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// [group, movement]. The movement is matched by words, so "romanian deadlift" finds "Romanian Deadlift".
export const ESSENTIAL_MOVEMENTS = [
  ['legs', 'barbell squat'], ['legs', 'front squat'], ['legs', 'goblet squat'], ['legs', 'bodyweight squat'], ['legs', 'leg press'], ['legs', 'hack squat'],
  ['legs', 'split squat'], ['legs', 'walking lunge'], ['legs', 'dumbbell lunges'], ['legs', 'reverse lunge'], ['legs', 'step-up'], ['legs', 'romanian deadlift'],
  ['legs', 'stiff-legged barbell deadlift'], ['legs', 'sumo deadlift'], ['legs', 'trap bar deadlift'], ['legs', 'barbell deadlift'], ['legs', 'leg extensions'],
  ['legs', 'lying leg curls'], ['legs', 'seated leg curl'], ['legs', 'standing calf raises'], ['legs', 'seated calf raise'], ['legs', 'barbell hip thrust'],
  ['legs', 'glute bridge'], ['legs', 'good morning'], ['legs', 'wall sit'], ['legs', 'box squat'], ['legs', 'smith machine squat'], ['legs', 'dumbbell squat'],
  ['legs', 'kettlebell swing'], ['legs', 'sumo squat'], ['legs', 'pistol squat'], ['legs', 'donkey calf raises'], ['legs', 'adductor'], ['legs', 'abductor'],
  ['legs', 'cable pull through'], ['legs', 'single leg deadlift'], ['legs', 'jump squat'], ['legs', 'box jump'], ['legs', 'hip abduction'], ['legs', 'lateral lunge'],
  ['chest', 'barbell bench press - medium grip'], ['chest', 'incline barbell bench press'], ['chest', 'decline barbell bench press'], ['chest', 'dumbbell bench press'],
  ['chest', 'incline dumbbell press'], ['chest', 'decline dumbbell bench press'], ['chest', 'pushups'], ['chest', 'push-ups'], ['chest', 'incline push-up'], ['chest', 'decline push-up'],
  ['chest', 'diamond push-up'], ['chest', 'wide-grip push-up'], ['chest', 'dumbbell flyes'], ['chest', 'incline dumbbell flyes'], ['chest', 'cable crossover'],
  ['chest', 'butterfly'], ['chest', 'chest dip'], ['chest', 'machine bench press'], ['chest', 'smith machine bench press'], ['chest', 'close-grip bench press'],
  ['chest', 'dumbbell pullover'], ['chest', 'floor press'], ['chest', 'cable chest press'], ['chest', 'incline cable flye'],
  ['back', 'pullups'], ['back', 'chin-up'], ['back', 'wide-grip lat pulldown'], ['back', 'close-grip front lat pulldown'], ['back', 'bent over barbell row'],
  ['back', 'one-arm dumbbell row'], ['back', 'seated cable rows'], ['back', 't-bar row'], ['back', 'inverted row'], ['back', 'face pull'], ['back', 'straight-arm pulldown'],
  ['back', 'hyperextensions'], ['back', 'barbell shrug'], ['back', 'dumbbell shrug'], ['back', 'reverse flyes'], ['back', 'dumbbell row'], ['back', 'machine row'],
  ['back', 'muscle up'], ['back', 'rack pull'], ['back', 'smith machine bent over row'], ['back', 'band pull apart'], ['back', 'superman'],
  ['shoulders', 'standing military press'], ['shoulders', 'dumbbell shoulder press'], ['shoulders', 'arnold dumbbell press'], ['shoulders', 'side lateral raise'],
  ['shoulders', 'front dumbbell raise'], ['shoulders', 'upright barbell row'], ['shoulders', 'push press'], ['shoulders', 'seated dumbbell press'], ['shoulders', 'cable lateral raise'],
  ['shoulders', 'bent over dumbbell rear delt raise'], ['shoulders', 'machine shoulder press'], ['shoulders', 'seated barbell military press'], ['shoulders', 'handstand push-ups'],
  ['shoulders', 'face pull'], ['shoulders', 'kettlebell press'], ['shoulders', 'plate front raise'],
  ['arms', 'barbell curl'], ['arms', 'dumbbell bicep curl'], ['arms', 'hammer curls'], ['arms', 'preacher curl'], ['arms', 'concentration curls'], ['arms', 'cable curl'],
  ['arms', 'incline dumbbell curl'], ['arms', 'ez-bar curl'], ['arms', 'triceps pushdown'], ['arms', 'lying triceps press'], ['arms', 'standing dumbbell triceps extension'],
  ['arms', 'cable rope overhead triceps extension'], ['arms', 'bench dips'], ['arms', 'dumbbell tricep extension'], ['arms', 'tricep kickback'], ['arms', 'close-grip push-up'],
  ['arms', 'wrist curl'], ['arms', 'reverse barbell curl'], ['arms', 'zottman curl'], ['arms', 'dips triceps version'], ['arms', 'machine triceps extension'],
  ['core', 'plank'], ['core', 'side plank'], ['core', 'crunches'], ['core', 'bicycle crunch'], ['core', 'air bike'], ['core', 'hanging leg raise'], ['core', 'russian twist'],
  ['core', 'cable crunch'], ['core', 'ab roller'], ['core', 'mountain climbers'], ['core', 'dead bug'], ['core', 'bird dog'], ['core', 'flat bench leg pull-in'], ['core', 'v-up'],
  ['core', 'flutter kicks'], ['core', 'sit-up'], ['core', 'wood chop'], ['core', 'reverse crunch'], ['core', 'leg raises'], ['core', 'toe touchers'], ['core', 'pallof press'],
  ['core', 'side bend'], ['core', 'decline crunch'], ['core', 'jackknife sit-up'], ['core', 'hollow'], ['core', 'bodyweight'],
  ['conditioning', 'burpee'], ['conditioning', 'rope jumping'], ['conditioning', 'jumping jacks'], ['conditioning', 'high knees'], ['conditioning', 'farmers walk'],
  ['conditioning', 'battle ropes'], ['conditioning', 'sled push'], ['conditioning', 'kettlebell clean'], ['conditioning', 'kettlebell snatch'], ['conditioning', 'turkish get-up'],
  ['conditioning', 'clean and press'], ['conditioning', 'power clean'], ['conditioning', 'thruster'], ['conditioning', 'medicine ball slam'], ['conditioning', 'stair climber'],
  ['conditioning', 'rowing machine'], ['conditioning', 'running treadmill'], ['conditioning', 'elliptical trainer'], ['conditioning', 'bear crawl'], ['conditioning', 'skater'],
  ['mobility', 'worlds greatest stretch'], ['mobility', 'cat stretch'], ['mobility', 'childs pose'], ['mobility', 'hip flexor stretch'], ['mobility', 'hamstring stretch'],
  ['mobility', 'quad stretch'], ['mobility', 'shoulder stretch'], ['mobility', 'chest stretch'], ['mobility', 'neck stretch'], ['mobility', 'pigeon stretch'],
  ['mobility', 'butterfly stretch'], ['mobility', 'calf stretch'], ['mobility', 'arm circles'], ['mobility', 'hip circles'], ['mobility', 'torso rotation'],
  ['mobility', 'foam roll'], ['mobility', 'thoracic'], ['mobility', 'ankle circles'], ['mobility', 'groiners'], ['mobility', 'spinal twist'],
];

const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (text) => normalize(text).split(' ').filter(Boolean).map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
const DIFFICULTY = { beginner: 0, intermediate: 1, advanced: 2 };
// Words that make a different exercise: "Decline Barbell Bench Press" is not what "barbell bench press" means.
const MODIFIERS = new Set(['incline', 'decline', 'close', 'wide', 'reverse', 'single', 'one', 'alternating', 'alternate', 'kneeling', 'seated', 'lying', 'handstand', 'crossover', 'band', 'chain', 'smith', 'machine', 'cable', 'kettlebell', 'dumbbell', 'barbell', 'bodyweight', 'medicine', 'ball', 'stability', 'bosu', 'sled', 'front', 'rear', 'side', 'bent', 'arm', 'leg', 'overhead']);

// The catalog entry that best fits a movement: every word of the movement in the name, the exact name first, then the
// shortest and easiest one.
export function resolveMovement(catalog, movement) {
  const wanted = tokens(movement);
  const exact = normalize(movement);
  const fits = catalog.filter((exercise) => {
    const words = new Set(tokens(exercise.name));
    return wanted.every((word) => words.has(word));
  });
  const penalty = (exercise) => tokens(exercise.name).filter((word) => MODIFIERS.has(word) && !wanted.includes(word)).length;
  const extras = (exercise) => tokens(exercise.name).filter((word) => !wanted.includes(word)).length;
  return fits.sort((a, b) => (normalize(b.name) === exact) - (normalize(a.name) === exact)
    || penalty(a) - penalty(b)
    || extras(a) - extras(b)
    || a.name.length - b.name.length
    || DIFFICULTY[a.difficulty] - DIFFICULTY[b.difficulty]
    || a.slug.localeCompare(b.slug))[0] || null;
}

export function buildEssentialList(catalog) {
  const seen = new Set();
  const list = [];
  const unmatched = [];
  for (const [group, movement] of ESSENTIAL_MOVEMENTS) {
    const match = resolveMovement(catalog, movement);
    if (!match) {
      unmatched.push(movement);
      continue;
    }
    if (seen.has(match.slug)) continue;
    seen.add(match.slug);
    list.push({ slug: match.slug, name: match.name, group, category: match.category, difficulty: match.difficulty });
  }
  return { list, unmatched };
}

async function main() {
  const catalog = JSON.parse(await readFile(path.join(root, 'data', 'free-exercise-db-apexfit.json'), 'utf8'));
  const { list, unmatched } = buildEssentialList(catalog);
  await writeFile(path.join(root, 'data', 'essential-exercises.json'), `${JSON.stringify({ note: 'The essential exercises that should have a demo video. Built by scripts/build-essential-exercises.mjs.', count: list.length, exercises: list }, null, 2)}\n`);
  console.log(`${list.length} essential exercises written to data/essential-exercises.json.`);
  if (unmatched.length) console.log(`Not found in the catalog (skipped): ${unmatched.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('build-essential-exercises.mjs')) await main();