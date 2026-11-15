import test from 'node:test';
import assert from 'node:assert/strict';
import { localeNames, supportedLocales, translations } from '../src/i18n/translations.js';

test('all supported locales provide the same translation keys', () => {
  const englishKeys = Object.keys(translations.en).sort();

  assert.deepEqual(supportedLocales, ['en', 'ar', 'de', 'fr', 'es']);
  for (const locale of supportedLocales) {
    assert.ok(localeNames[locale], `Missing display name for ${locale}`);
    assert.deepEqual(Object.keys(translations[locale]).sort(), englishKeys, `Incomplete translations for ${locale}`);
  }
});
