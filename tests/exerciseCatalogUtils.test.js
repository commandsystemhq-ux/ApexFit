import test from 'node:test';
import assert from 'node:assert/strict';
import { getExerciseVideoSource, normalizeExerciseRecord } from '../src/services/exerciseCatalogUtils.js';

const validExercise = {
  slug: 'barbell-squat',
  name: 'Barbell Squat',
  category: 'strength',
  primary_muscles: ['quadriceps', 'glutes'],
  equipment: ['barbell'],
  difficulty: 'intermediate',
  instructions: ['Brace your core.', 'Lower with control.'],
  demo_video_url: 'https://youtu.be/abcdefghijk',
};

test('normalizes a verified catalog record without adding sample data', () => {
  const record = normalizeExerciseRecord(validExercise);

  assert.equal(record.slug, 'barbell-squat');
  assert.deepEqual(record.primary_muscles, ['quadriceps', 'glutes']);
  assert.equal(record.demo_video_url, 'https://youtu.be/abcdefghijk');
  assert.equal(record.is_published, undefined);
});

test('rejects invalid catalog identifiers and insecure demo URLs', () => {
  assert.throws(() => normalizeExerciseRecord({ ...validExercise, slug: 'Barbell Squat' }), /slug/);
  assert.throws(() => normalizeExerciseRecord({ ...validExercise, demo_video_url: 'http://example.com/demo.mp4' }), /HTTPS/);
  assert.throws(() => normalizeExerciseRecord({ ...validExercise, demo_video_url: 'https://user:pass@example.com/demo.mp4' }), /embedded credentials/);
  assert.throws(() => normalizeExerciseRecord({ ...validExercise, equipment: ['unmapped equipment'] }), /supported by the exercise filters/);
});

test('only returns embeddable HTTPS video sources from supported hosts or file types', () => {
  assert.deepEqual(getExerciseVideoSource('https://www.youtube.com/watch?v=abcdefghijk'), {
    kind: 'iframe',
    src: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
  });
  assert.deepEqual(getExerciseVideoSource('https://media.example.com/demo.mp4'), {
    kind: 'video',
    src: 'https://media.example.com/demo.mp4',
  });
  assert.equal(getExerciseVideoSource('https://youtube.com.attacker.test/watch?v=abcdefghijk'), null);
  assert.equal(getExerciseVideoSource('http://media.example.com/demo.mp4'), null);
});
