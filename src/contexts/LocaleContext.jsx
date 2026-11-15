import { createContext, useContext, useMemo, useState } from 'react';
import { supportedLocales, translations } from '../i18n/translations.js';

const LocaleContext = createContext(null);
const STORAGE_KEY = 'apexfit.locale';

function getInitialLocale() {
  const savedLocale = window.localStorage.getItem(STORAGE_KEY);
  return supportedLocales.includes(savedLocale) ? savedLocale : 'en';
}

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(getInitialLocale);
  const value = useMemo(() => {
    function setLocale(nextLocale) {
      if (!supportedLocales.includes(nextLocale)) {
        throw new RangeError(`Unsupported locale: ${nextLocale}`);
      }
      window.localStorage.setItem(STORAGE_KEY, nextLocale);
      setLocaleState(nextLocale);
    }

    return {
      locale,
      setLocale,
      t: (key) => translations[locale][key] || translations.en[key] || key,
    };
  }, [locale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale must be used inside LocaleProvider');
  return context;
}
