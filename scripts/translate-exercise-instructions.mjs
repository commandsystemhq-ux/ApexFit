import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModelFromEnv } from '../api/_lib/jackModels.js';

// Translates the "how to do it" steps of the exercise catalog with the AI model configured in the environment
// (the same variables Jack uses: OPENAI_API_KEY, GEMINI_API_KEY, AZURE_FOUNDRY_*, AWS_* / BEDROCK_MODEL_ID, JACK_PROVIDER).
// It writes data/exercise-translations/instructions.<locale>.json, can be stopped and started again (finished exercises
// are skipped), and the next `npm run import:exercises` publishes the result.
//   npm run translate:exercises -- ar            (one language)
//   npm run translate:exercises -- all           (Arabic, German, French and Spanish)

export const LOCALE_NAMES = { ar: 'Arabic', de: 'German', fr: 'French', es: 'Spanish' };
const BATCH_SIZE = 6;

export function buildPrompt(locale, batch) {
  const items = batch.map((record) => ({ slug: record.slug, name: record.name, steps: record.instructions }));
  return {
    system: [
      `You translate gym exercise instructions into ${LOCALE_NAMES[locale]} for personal trainers and their clients.`,
      'Use the everyday gym terminology people actually use. Keep equipment and body-part words clear and natural. Do not add, remove, merge or split steps.',
      'Answer with one JSON object only, no markdown: { "<slug>": ["translated step 1", "translated step 2", ...], ... } with exactly the same slugs and the same number of steps for each exercise.',
    ].join(' '),
    user: JSON.stringify(items),
  };
}

// Reads the model's answer and keeps only exercises whose steps are valid (same count as the English, non-empty, bounded).
export function parseTranslatedBatch(text, batch) {
  const cleaned = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { accepted: {}, rejected: batch.map((record) => record.slug) };
  let data;
  try {
    data = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { accepted: {}, rejected: batch.map((record) => record.slug) };
  }
  const accepted = {};
  const rejected = [];
  for (const record of batch) {
    const steps = data?.[record.slug];
    const valid = Array.isArray(steps)
      && steps.length === record.instructions.length
      && steps.every((step) => typeof step === 'string' && step.trim().length > 0 && step.length <= 2000);
    if (valid) accepted[record.slug] = steps.map((step) => step.trim());
    else rejected.push(record.slug);
  }
  return { accepted, rejected };
}

export async function translateLocale({ model, locale, catalog, existing = {}, save = async () => {}, log = () => {}, retries = 2 }) {
  const result = { ...existing };
  const pending = catalog.filter((record) => record.instructions?.length > 0 && !result[record.slug]);
  const failed = [];
  for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
    let batch = pending.slice(offset, offset + BATCH_SIZE);
    for (let attempt = 0; attempt <= retries && batch.length > 0; attempt += 1) {
      const { system, user } = buildPrompt(locale, batch);
      const response = await model.complete({ system, messages: [{ role: 'user', content: user }], tools: [] });
      const { accepted, rejected } = parseTranslatedBatch(response.text, batch);
      Object.assign(result, accepted);
      batch = batch.filter((record) => rejected.includes(record.slug));
    }
    failed.push(...batch.map((record) => record.slug));
    await save(result);
    log(`${locale}: ${Object.keys(result).length}/${catalog.length}`);
  }
  return { translations: result, failed };
}

async function main() {
  const target = process.argv[2];
  const locales = target === 'all' ? Object.keys(LOCALE_NAMES) : [target];
  if (!locales.every((locale) => LOCALE_NAMES[locale])) throw new Error('Usage: npm run translate:exercises -- <ar|de|fr|es|all>');

  const catalogPath = path.resolve('data/free-exercise-db-apexfit.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const model = createModelFromEnv();
  for (const locale of locales) {
    const file = path.join(path.dirname(catalogPath), 'exercise-translations', `instructions.${locale}.json`);
    let existing = {};
    try {
      existing = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const { failed } = await translateLocale({
      model, locale, catalog, existing, log: console.log,
      save: (data) => writeFile(file, `${JSON.stringify(data)}\n`, 'utf8'),
    });
    if (failed.length) console.warn(`${locale}: ${failed.length} exercises could not be translated; run the command again to retry them.`);
  }
  console.log('Done. Run: npm run import:exercises -- data/free-exercise-db-apexfit.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}