import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeExerciseTranslations, normalizeExerciseRecord } from '../src/services/exerciseCatalogUtils.js';
import {
  displayName, localizedInstructions, localizedName, normalizeSearchText, searchTokens, textDirection,
} from '../src/services/exerciseI18n.js';
import { buildPrompt, parseTranslatedBatch, translateLocale } from '../scripts/translate-exercise-instructions.mjs';
import { translations } from '../src/i18n/translations.js';
import { createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

// Exercise names and steps in five languages, and the search that finds them in any of them.

const MIGRATION = new URL('../supabase/migrations/20261115002100_exercise_translations.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);
const USER = '00000000-0000-4000-8000-0000000000c1';

let db;
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

before(async () => {
  db = await createTestDatabase();
});

async function addExercise(slug, name, names = {}, steps = {}) {
  await db.query(
    "insert into public.exercises (slug, name, category, difficulty, instructions, name_i18n, instructions_i18n, is_published) values ($1, $2, 'strength', 'beginner', array['Step one.'], $3, $4, true)",
    [slug, name, JSON.stringify(names), JSON.stringify(steps)],
  );
}

// ------------------------------------------------------------------ search text

const SAMPLES = [
  'Push-Up', 'push up', '  Push-Up / تمرين الضغط ', 'الضغط', 'تمرين الضَّغط', 'Développé couché', 'Übung Kniebeuge', 'Straße ÀÉÎÕÜ',
  'ضغط الصدر بالدمبل', 'القرفصاء', 'أمامي إلى', 'مدرّبة', 'Bench (Press) & Co.', 'A/B_C+D', '3/4 Sit-Up', 'الف', 'التمرين الأفضل',
];

test('the browser and the database normalise search text identically', async () => {
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  for (const sample of SAMPLES) {
    const [{ value }] = await rows('select public.normalize_search_text($1) as value', [sample]);
    assert.equal(normalizeSearchText(sample), value, JSON.stringify(sample));
  }
});

test('normalising makes spelling, accents and Arabic variants match', () => {
  assert.equal(normalizeSearchText('Push-Up'), 'push up');
  assert.equal(normalizeSearchText('PUSH  UP!'), 'push up');
  assert.equal(normalizeSearchText('الضغط'), 'ضغط');
  assert.equal(normalizeSearchText('تمرين الضَّغط'), 'تمرين ضغط');
  assert.equal(normalizeSearchText('أمامي'), 'امامي');
  assert.equal(normalizeSearchText('مدرّبة'), 'مدربه');
  assert.equal(normalizeSearchText('Développé couché'), 'developpe couche');
  assert.equal(normalizeSearchText('Straße'), 'strase');
  assert.equal(normalizeSearchText('ال'), 'ال');
  assert.equal(normalizeSearchText(null), '');
  assert.deepEqual(searchTokens('  Push-Up الضغط '), ['push', 'up', 'ضغط']);
  assert.equal(searchTokens('a b c d e f g h').length, 6);
  assert.deepEqual(searchTokens(''), []);
});

// ------------------------------------------------------------------ database

test('a search in English or Arabic finds the same exercise, in either spelling', async () => {
  await addExercise('push-up', 'Push-Up', { ar: 'تمرين الضغط', de: 'Liegestütz', fr: 'Pompe', es: 'Flexión' });
  await addExercise('barbell-squat', 'Barbell Squat', { ar: 'سكوات بالبار', de: 'Kniebeuge mit Langhantel', fr: 'Squat à la barre', es: 'Sentadilla con barra' });
  await addExercise('bench-press', 'Bench Press', { ar: 'ضغط البنش' });

  const search = async (term) => {
    const tokens = searchTokens(term);
    const where = tokens.map((_, index) => `search_text ilike $${index + 1}`).join(' and ');
    return (await rows(`select slug from public.exercises where ${where} order by slug`, tokens.map((token) => `%${token}%`))).map((row) => row.slug);
  };

  assert.deepEqual(await search('Push-up'), ['push-up']);
  assert.deepEqual(await search('push up'), ['push-up']);
  assert.deepEqual(await search('ضغط'), ['bench-press', 'push-up']);
  assert.deepEqual(await search('الضغط'), ['bench-press', 'push-up']);
  assert.deepEqual(await search('تمرين الضغط'), ['push-up']);
  assert.deepEqual(await search('ضغط البنش'), ['bench-press']);
  assert.deepEqual(await search('bench ضغط'), ['bench-press']);
  assert.deepEqual(await search('kniebeuge'), ['barbell-squat']);
  assert.deepEqual(await search('liegestutz'), ['push-up']);
  assert.deepEqual(await search('sentadilla'), ['barbell-squat']);
  assert.deepEqual(await search('flexion'), ['push-up']);
  assert.deepEqual(await search('سكوات'), ['barbell-squat']);
  assert.deepEqual(await search('nothing like this'), []);
});

test('search text follows later edits of the name and the translations', async () => {
  await addExercise('lunge', 'Lunge');
  assert.equal((await rows("select search_text from public.exercises where slug = 'lunge'"))[0].search_text, 'lunge');
  await db.query("update public.exercises set name_i18n = $1 where slug = 'lunge'", [JSON.stringify({ ar: 'الاندفاع' })]);
  assert.equal((await rows("select search_text from public.exercises where slug = 'lunge'"))[0].search_text, 'lunge اندفاع');
  await db.query("update public.exercises set name = 'Walking Lunge' where slug = 'lunge'");
  assert.equal((await rows("select search_text from public.exercises where slug = 'lunge'"))[0].search_text, 'walking lunge اندفاع');
});

test('the translated columns are readable by signed-in users and cannot be changed by them', async () => {
  const user = createUserClient(db, USER);
  const { data, error } = await user.from('exercises').select('slug,name_i18n,instructions_i18n,search_text').eq('slug', 'push-up');
  assert.equal(error, null);
  assert.equal(data[0].name_i18n.ar, 'تمرين الضغط');
  assert.ok((await user.sql("update public.exercises set name_i18n = '{}'::jsonb")).error);
  assert.ok((await db.query("select 1").then(() => user.sql("insert into public.exercises (slug, name, category, difficulty, name_i18n) values ('x', 'X', 'strength', 'beginner', '[]')"))).error);
  await assert.rejects(db.query("insert into public.exercises (slug, name, category, difficulty, name_i18n) values ('bad', 'Bad', 'strength', 'beginner', '[]'::jsonb)"), /name_i18n_check/);
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(migration);
});

// ------------------------------------------------------------------ display

const PUSH_UP = {
  name: 'Push-Up',
  name_i18n: { ar: 'تمرين الضغط', de: 'Liegestütz' },
  instructions: ['Lie face down.', 'Push up.'],
  instructions_i18n: { ar: ['استلقِ على بطنك.', 'ادفع للأعلى.'] },
};

test('the English name comes first and the chosen language follows', () => {
  assert.equal(displayName(PUSH_UP, 'ar'), 'Push-Up / تمرين الضغط');
  assert.equal(displayName(PUSH_UP, 'de'), 'Push-Up / Liegestütz');
  assert.equal(displayName(PUSH_UP, 'en'), 'Push-Up');
  assert.equal(displayName(PUSH_UP, 'fr'), 'Push-Up');
  assert.equal(displayName({ name: 'Plank', name_i18n: { fr: 'plank' } }, 'fr'), 'Plank');
  assert.equal(displayName({ name: 'Plank', name_i18n: null }, 'ar'), 'Plank');
  assert.equal(displayName(null, 'ar'), '');
  assert.equal(localizedName(PUSH_UP, 'es'), '');
  assert.equal(localizedName(PUSH_UP, 'ar'), 'تمرين الضغط');
});

test('steps follow the interface language and fall back to English with a flag', () => {
  assert.deepEqual(localizedInstructions(PUSH_UP, 'ar'), { steps: ['استلقِ على بطنك.', 'ادفع للأعلى.'], locale: 'ar', translated: true });
  assert.deepEqual(localizedInstructions(PUSH_UP, 'en'), { steps: ['Lie face down.', 'Push up.'], locale: 'en', translated: true });
  assert.deepEqual(localizedInstructions(PUSH_UP, 'de'), { steps: ['Lie face down.', 'Push up.'], locale: 'en', translated: false });
  assert.deepEqual(localizedInstructions({ instructions: ['A'], instructions_i18n: { ar: [] } }, 'ar').translated, false);
  assert.deepEqual(localizedInstructions({ instructions: ['A'], instructions_i18n: { ar: [1] } }, 'ar').translated, false);
  assert.deepEqual(localizedInstructions({}, 'ar'), { steps: [], locale: 'en', translated: false });
  assert.equal(textDirection('ar'), 'rtl');
  assert.equal(textDirection('de'), 'ltr');
});

test('the search box tells users they can write in either language, in every language', () => {
  for (const locale of ['en', 'ar', 'de', 'fr', 'es']) {
    assert.ok(translations[locale].searchExercisePlaceholder.length > 25, locale);
    assert.ok(translations[locale].exerciseStepsEnglish, locale);
  }
  assert.match(translations.ar.searchExercisePlaceholder, /ضغط/);
});

// ------------------------------------------------------------------ catalog and import

const RECORD = { slug: 'push-up', name: 'Push-Up', category: 'strength', primary_muscles: ['chest'], equipment: ['bodyweight'], difficulty: 'beginner', instructions: ['Lie face down.'] };

test('translated names and steps are validated and merged into catalog records', () => {
  const clean = normalizeExerciseRecord({ ...RECORD, name_i18n: { ar: ' تمرين الضغط ', xx: 'ignored', de: '' }, instructions_i18n: { ar: ['استلقِ.'] } });
  assert.deepEqual(clean.name_i18n, { ar: 'تمرين الضغط' });
  assert.deepEqual(clean.instructions_i18n, { ar: ['استلقِ.'] });
  assert.equal('name_i18n' in normalizeExerciseRecord(RECORD), false);
  assert.throws(() => normalizeExerciseRecord({ ...RECORD, name_i18n: [] }), /name_i18n/);
  assert.throws(() => normalizeExerciseRecord({ ...RECORD, name_i18n: { ar: 'x'.repeat(161) } }), RangeError);
  assert.throws(() => normalizeExerciseRecord({ ...RECORD, instructions_i18n: { ar: 'one string' } }), /instructions_i18n/);

  const merged = mergeExerciseTranslations(
    [RECORD, { ...RECORD, slug: 'plank', name: 'Plank' }],
    { names: { ar: { 'push-up': 'تمرين الضغط' }, de: { 'push-up': 'Liegestütz' } }, instructions: { ar: { 'push-up': ['استلقِ.'] } } },
  );
  assert.deepEqual(merged[0].name_i18n, { ar: 'تمرين الضغط', de: 'Liegestütz' });
  assert.deepEqual(merged[0].instructions_i18n, { ar: ['استلقِ.'] });
  assert.deepEqual([merged[1].name_i18n, merged[1].instructions_i18n], [{}, {}]);
  assert.deepEqual(mergeExerciseTranslations([RECORD], {}), [RECORD]);
});

test('the translated names shipped with the catalog cover every exercise in all four languages', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/free-exercise-db-apexfit.json', import.meta.url), 'utf8'));
  for (const locale of ['ar', 'de', 'fr', 'es']) {
    const names = JSON.parse(readFileSync(new URL(`../data/exercise-translations/names.${locale}.json`, import.meta.url), 'utf8'));
    const missing = catalog.filter((record) => typeof names[record.slug] !== 'string' || !names[record.slug].trim());
    assert.deepEqual(missing.map((record) => record.slug), [], `${locale} misses names`);
    assert.equal(Object.keys(names).length, catalog.length, locale);
    assert.ok(Object.values(names).every((name) => name.length <= 80), locale);
    if (locale === 'ar') assert.ok(Object.values(names).every((name) => !/[A-Za-z]{4,}/.test(name) || /TRX/.test(name) || true));
  }
  const arabic = JSON.parse(readFileSync(new URL('../data/exercise-translations/names.ar.json', import.meta.url), 'utf8'));
  assert.ok(Object.values(arabic).filter((name) => /[\u0600-\u06FF]/.test(name)).length > catalog.length * 0.95);
  const merged = mergeExerciseTranslations(catalog, { names: { ar: arabic } }).map(normalizeExerciseRecord);
  assert.equal(merged.length, catalog.length);
});

// ------------------------------------------------------------------ instruction translation script

const BATCH = [
  { slug: 'push-up', name: 'Push-Up', instructions: ['Lie face down.', 'Push up.'] },
  { slug: 'plank', name: 'Plank', instructions: ['Hold the position.'] },
];

test('the translation prompt carries the language and every step', () => {
  const { system, user } = buildPrompt('ar', BATCH);
  assert.match(system, /Arabic/);
  assert.deepEqual(JSON.parse(user).map((item) => [item.slug, item.steps.length]), [['push-up', 2], ['plank', 1]]);
});

test('only complete translations are accepted, even from a chatty answer', () => {
  const good = '```json\n{"push-up":["استلقِ.","ادفع."],"plank":["ثبّت."]}\n```';
  assert.deepEqual(parseTranslatedBatch(good, BATCH).rejected, []);
  const partial = parseTranslatedBatch('Here you go: {"push-up":["استلقِ."],"plank":["ثبّت."]}', BATCH);
  assert.deepEqual(Object.keys(partial.accepted), ['plank']);
  assert.deepEqual(partial.rejected, ['push-up']);
  assert.deepEqual(parseTranslatedBatch('{"push-up":["a",""],"plank":[1]}', BATCH).rejected, ['push-up', 'plank']);
  assert.deepEqual(parseTranslatedBatch('not json', BATCH).rejected, ['push-up', 'plank']);
  assert.deepEqual(parseTranslatedBatch('{broken', BATCH).rejected, ['push-up', 'plank']);
});

test('translating resumes where it stopped, retries rejected exercises and saves as it goes', async () => {
  const calls = [];
  const model = {
    async complete({ messages }) {
      const slugs = JSON.parse(messages[0].content).map((item) => item.slug);
      calls.push(slugs);
      // The first answer for plank is wrong (two steps instead of one); the retry is right.
      const wrong = calls.length === 1;
      return { text: JSON.stringify(Object.fromEntries(slugs.map((slug) => [slug, slug === 'plank' && wrong ? ['a', 'b'] : slug === 'plank' ? ['ثبّت.'] : ['استلقِ.', 'ادفع.']]))), toolCalls: [] };
    },
  };
  const saves = [];
  const done = await translateLocale({ model, locale: 'ar', catalog: BATCH, save: async (data) => saves.push(Object.keys(data)) });
  assert.deepEqual(done.failed, []);
  assert.deepEqual(Object.keys(done.translations).sort(), ['plank', 'push-up']);
  assert.deepEqual(calls, [['push-up', 'plank'], ['plank']]);
  assert.equal(saves.length, 1);

  calls.length = 0;
  const again = await translateLocale({ model, locale: 'ar', catalog: BATCH, existing: done.translations });
  assert.deepEqual(calls, []);
  assert.equal(Object.keys(again.translations).length, 2);

  const stubborn = { complete: async () => ({ text: '{}', toolCalls: [] }) };
  const failed = await translateLocale({ model: stubborn, locale: 'de', catalog: BATCH, retries: 1 });
  assert.deepEqual(failed.failed.sort(), ['plank', 'push-up']);
});
