import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { I18nManager } from 'react-native';
import * as Localization from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { isRtlLocale, pickLocale, translate } from './translations.js';

const LOCALE_KEY = 'apexfit.locale';
const LocaleContext = createContext(null);

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(() => pickLocale(Localization.getLocales()[0]?.languageCode));
  const [directionChanged, setDirectionChanged] = useState(false);

  // The saved choice wins over the phone's language.
  useEffect(() => {
    SecureStore.getItemAsync(LOCALE_KEY).then((saved) => { if (saved) setLocaleState(pickLocale(saved)); }).catch(() => null);
  }, []);

  const setLocale = useCallback(async (next) => {
    setLocaleState(next);
    await SecureStore.setItemAsync(LOCALE_KEY, next).catch(() => null);
    // The reading direction of the whole layout can only change after the app restarts.
    const rtl = isRtlLocale(next);
    if (I18nManager.isRTL !== rtl) {
      I18nManager.allowRTL(rtl);
      I18nManager.forceRTL(rtl);
      setDirectionChanged(true);
    } else {
      setDirectionChanged(false);
    }
  }, []);

  const value = useMemo(() => ({
    locale,
    setLocale,
    directionChanged,
    isRtl: isRtlLocale(locale),
    t: (key) => translate(locale, key),
  }), [locale, setLocale, directionChanged]);

  return createElement(LocaleContext.Provider, { value }, children);
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used inside LocaleProvider.');
  return value;
}