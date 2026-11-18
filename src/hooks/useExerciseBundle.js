import { useEffect, useState } from 'react';
import { loadExerciseBundle, peekExerciseBundle } from '../services/exerciseBundle.js';

// The exercise names and steps that ship with the app for a language (null for English, and until they have loaded).
export function useExerciseBundle(locale) {
  const [loaded, setLoaded] = useState(() => ({ locale, bundle: peekExerciseBundle(locale) }));

  useEffect(() => {
    let active = true;
    const cached = peekExerciseBundle(locale);
    if (cached || locale === 'en') {
      setLoaded({ locale, bundle: cached });
      return undefined;
    }
    loadExerciseBundle(locale).then((bundle) => {
      if (active) setLoaded({ locale, bundle });
    });
    return () => { active = false; };
  }, [locale]);

  return loaded.locale === locale ? loaded.bundle : peekExerciseBundle(locale);
}