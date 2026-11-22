// Builds src/data/common-foods.json from the text files in scripts/foods-parts/.
// Each line is: English|Arabic|kcal|protein g|carbs g|fat g|serving g (blank = 100 g)|extra search words
// All numbers are per 100 g. Lines starting with # and empty lines are ignored.
//
//   node scripts/build-common-foods.mjs            builds the file (fails when a line is wrong or fewer than 1000 foods remain)
//   node scripts/build-common-foods.mjs --check    only validates
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hasArabic, normalizeSearchText } from '../src/services/searchText.js';

export const MIN_FOODS = 1000;
const PARTS = new URL('./foods-parts/', import.meta.url);
const OUTPUT = new URL('../src/data/common-foods.json', import.meta.url);
const round1 = (value) => Math.round(value * 10) / 10;

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// The energy that the three macros give (4/4/9 kcal per gram) must be close to the calories, otherwise a number is wrong.
export function energyProblem({ calories, protein_g: protein, carbs_g: carbs, fat_g: fat }) {
  if (calories === 0 && protein + carbs + fat === 0) return null;
  const energy = protein * 4 + carbs * 4 + fat * 9;
  const allowed = Math.max(25, calories * 0.18);
  return Math.abs(energy - calories) > allowed ? `${calories} kcal but the macros give ${Math.round(energy)}` : null;
}

export function parseLine(line, where) {
  const fields = line.split('|').map((field) => field.trim());
  const [en, ar, kcal, protein, carbs, fat, serving = '', extra = ''] = fields;
  const problems = [];
  if (fields.length < 6) problems.push('needs at least 6 fields');
  if (!en || !/[A-Za-z]/.test(en)) problems.push('English name missing');
  if (!ar || !hasArabic(ar)) problems.push('Arabic name missing');
  if (/[?؟]/.test(`${en}${ar}`)) problems.push('a name contains a question mark');
  const numbers = [kcal, protein, carbs, fat].map(Number);
  if (numbers.some((value) => !Number.isFinite(value) || value < 0)) problems.push('calories and macros must be numbers of 0 or more');
  const servingValue = serving === '' ? 0 : Number(serving);
  if (!Number.isFinite(servingValue) || servingValue < 0 || servingValue > 1000) problems.push('serving must be 0 to 1000 g');
  if (problems.length) return { error: `${where}: ${problems.join('; ')} -> ${line}` };

  const [calories, protein_g, carbs_g, fat_g] = numbers.map(round1);
  const per100g = { calories, protein_g, carbs_g, fat_g };
  if (calories > 900 || protein_g + carbs_g + fat_g > 100.5) return { error: `${where}: more than 100 g of nutrients per 100 g or over 900 kcal -> ${line}` };
  const energy = energyProblem(per100g);
  if (energy) return { error: `${where}: ${energy} -> ${line}` };

  const words = extra.split(/\s+/).filter(Boolean);
  return {
    food: {
      id: slugify(en),
      name: { en, ar },
      per100g,
      serving_g: servingValue > 0 ? round1(servingValue) : null,
      aliases: { ar: words.filter(hasArabic), en: words.filter((word) => !hasArabic(word)) },
    },
  };
}

export function buildFoods(files) {
  const foods = [];
  const errors = [];
  const seenIds = new Set();
  const seenNames = new Set();
  let duplicates = 0;
  for (const { name, text } of files) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      const parsed = parseLine(line, `${name}:${index + 1}`);
      if (parsed.error) {
        errors.push(parsed.error);
        return;
      }
      const arabicKey = normalizeSearchText(parsed.food.name.ar);
      if (seenIds.has(parsed.food.id) || seenNames.has(arabicKey)) {
        duplicates += 1;
        return;
      }
      seenIds.add(parsed.food.id);
      seenNames.add(arabicKey);
      foods.push(parsed.food);
    });
  }
  return { foods, errors, duplicates };
}

export function readParts() {
  return readdirSync(PARTS).filter((name) => name.endsWith('.txt')).sort().map((name) => ({ name, text: readFileSync(new URL(name, PARTS), 'utf8') }));
}

export function serialize(foods) {
  const note = 'Typical reference values per 100 g (cooked or raw as named). Recipes, brands and restaurants vary, so treat them as estimates.';
  return `{\n"version": 2,\n"note": ${JSON.stringify(note)},\n"foods": [\n${foods.map((food) => JSON.stringify(food)).join(',\n')}\n]\n}\n`;
}

if (process.argv[1] && new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).pathname.endsWith('build-common-foods.mjs')) {
  const { foods, errors, duplicates } = buildFoods(readParts());
  if (errors.length) {
    console.error(`${errors.length} line(s) need fixing:\n${errors.join('\n')}`);
    process.exit(1);
  }
  if (foods.length < MIN_FOODS) {
    console.error(`Only ${foods.length} foods; at least ${MIN_FOODS} are required.`);
    process.exit(1);
  }
  if (!process.argv.includes('--check')) writeFileSync(OUTPUT, serialize(foods), 'utf8');
  console.log(`${foods.length} foods${process.argv.includes('--check') ? ' (checked)' : ' written to src/data/common-foods.json'}; ${duplicates} duplicate(s) skipped.`);
}
