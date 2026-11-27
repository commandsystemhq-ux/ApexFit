import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const NEW_MIGRATIONS = [
  '20261115003700_trial_14_days.sql',
  '20261115003800_coach_custom_exercises.sql',
  '20261115003900_program_exercise_tempo.sql',
  '20261115004000_calorie_calculator.sql',
  '20261115004100_ramadan_meals.sql',
  '20261115004200_client_tags.sql',
];

test('the new migrations are appended to manual-setup.sql in order, byte for byte', () => {
  const manual = readFileSync(new URL('supabase/manual-setup.sql', root), 'utf8').replace(/\r\n/g, '\n');
  let cursor = -1;
  for (const name of NEW_MIGRATIONS) {
    const marker = `-- ===== ${name} =====`;
    const at = manual.indexOf(marker);
    assert.ok(at > cursor, `${name} is missing or out of order`);
    cursor = at;
    const migration = readFileSync(new URL(`supabase/migrations/${name}`, root), 'utf8').replace(/\r\n/g, '\n').trim();
    assert.ok(manual.includes(migration), `${name} differs from its copy in manual-setup.sql`);
  }
});

test('migration file names are unique and sorted, so they run in the order they were written', () => {
  const files = readdirSync(new URL('supabase/migrations/', root)).filter((name) => name.endsWith('.sql'));
  assert.deepEqual(files, [...files].sort());
  assert.equal(new Set(files.map((name) => name.slice(0, 14))).size, files.length);
  assert.deepEqual(files.slice(-NEW_MIGRATIONS.length), NEW_MIGRATIONS);
});

test('no serverless function was added: api/ keeps its 11 endpoints (Vercel Hobby allows 12)', () => {
  const endpoints = readdirSync(new URL('api/', root), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.js'));
  assert.equal(endpoints.length, 11);
});