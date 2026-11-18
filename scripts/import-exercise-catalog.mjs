import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { mergeExerciseTranslations, normalizeExerciseRecord } from '../src/services/exerciseCatalogUtils.js';

const BATCH_SIZE = 100;

// data/exercise-translations/names.<locale>.json ({ slug: name }) and instructions.<locale>.json ({ slug: [steps] }), next to the catalog.
async function readTranslations(catalogPath) {
  const directory = path.join(path.dirname(catalogPath), 'exercise-translations');
  const result = { names: {}, instructions: {} };
  for (const locale of ['ar', 'de', 'fr', 'es']) {
    for (const [kind, key] of [['names', 'names'], ['instructions', 'instructions']]) {
      try {
        result[key][locale] = JSON.parse(await readFile(path.join(directory, `${kind}.${locale}.json`), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`${kind}.${locale}.json: ${error.message}`);
      }
    }
  }
  return result;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error('Usage: node scripts/import-exercise-catalog.mjs <catalog.json>');
  }

  const projectUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceRoleKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the local environment.');
  }

  const catalogPath = path.resolve(inputPath);
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new TypeError('The catalog JSON must be a non-empty array of exercise records.');
  }
  const input = mergeExerciseTranslations(catalog, await readTranslations(catalogPath));

  const slugs = new Set();
  const records = input.map((row, index) => {
    try {
      const record = normalizeExerciseRecord(row);
      if (slugs.has(record.slug)) throw new TypeError(`Duplicate slug: ${record.slug}.`);
      slugs.add(record.slug);
      return { ...record, is_published: true };
    } catch (error) {
      throw new Error(`Invalid catalog record ${index + 1}: ${error.message}`);
    }
  });

  const client = createClient(projectUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let imported = 0;
  for (let offset = 0; offset < records.length; offset += BATCH_SIZE) {
    const batch = records.slice(offset, offset + BATCH_SIZE);
    const { error } = await client.from('exercises').upsert(batch, { onConflict: 'slug' });
    if (error) throw error;
    imported += batch.length;
  }

  const withNames = records.filter((record) => Object.keys(record.name_i18n || {}).length > 0).length;
  const withSteps = records.filter((record) => Object.keys(record.instructions_i18n || {}).length > 0).length;
  console.log(`Imported ${imported} exercise records (${withNames} with translated names, ${withSteps} with translated steps).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
