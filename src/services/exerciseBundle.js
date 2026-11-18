// The translated exercise names and steps that ship with the app (data/exercise-translations/names.<locale>.json and
// instructions.<locale>.json). They are loaded on demand, one language at a time, as separate cacheable files, so the
// library is translated without any database import or outside service. This file is only used in the browser build.
const files = import.meta.glob('../../data/exercise-translations/{names,instructions}.*.json', { import: 'default' });

const cache = new Map();

export function peekExerciseBundle(locale) {
  return cache.get(locale)?.bundle ?? null;
}

export function loadExerciseBundle(locale) {
  if (locale === 'en') return Promise.resolve(null);
  const cached = cache.get(locale);
  if (cached) return cached.promise;

  const load = (kind) => files[`../../data/exercise-translations/${kind}.${locale}.json`]?.() ?? Promise.resolve({});
  const entry = { bundle: null };
  entry.promise = Promise.all([load('names'), load('instructions')])
    .then(([names, steps]) => {
      entry.bundle = { names, steps };
      return entry.bundle;
    })
    .catch(() => {
      cache.delete(locale);
      return null;
    });
  cache.set(locale, entry);
  return entry.promise;
}