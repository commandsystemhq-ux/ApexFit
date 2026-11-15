import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExerciseRecord } from '../src/services/exerciseCatalogUtils.js';

const catalogUrl = new URL('../data/free-exercise-db-apexfit.json', import.meta.url);
const catalog = JSON.parse(await readFile(catalogUrl, 'utf8'));

test('prepared public-domain exercise catalog contains unique, validated real source records', () => {
  assert.equal(catalog.length, 876);
  assert.equal(new Set(catalog.map((exercise) => exercise.slug)).size, catalog.length);
  for (const exercise of catalog) {
    assert.deepEqual(normalizeExerciseRecord(exercise), exercise);
    assert.equal(exercise.demo_video_url, null);
    if (exercise.thumbnail_url) assert.equal(new URL(exercise.thumbnail_url).protocol, 'https:');
  }
});
