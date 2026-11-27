import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { applyTheme, normalizeThemeMode, readThemeMode, writeThemeMode } from '../services/themeUtils.js';

const ThemeContext = createContext(null);
const LIGHT_QUERY = '(prefers-color-scheme: light)';

const lightQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(LIGHT_QUERY) : null);

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState(() => readThemeMode(typeof window === 'undefined' ? null : window.localStorage));
  const [prefersLight, setPrefersLight] = useState(() => Boolean(lightQuery()?.matches));

  // "System" follows the operating system, including when it switches while the app is open.
  useEffect(() => {
    const query = lightQuery();
    if (!query) return undefined;
    const update = () => setPrefersLight(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    applyTheme(document.documentElement, mode, prefersLight, document.querySelector('meta[name="theme-color"]'));
  }, [mode, prefersLight]);

  const value = useMemo(() => ({
    mode,
    resolved: mode === 'system' ? (prefersLight ? 'light' : 'dark') : mode,
    setMode(next) {
      const normalized = normalizeThemeMode(next);
      writeThemeMode(window.localStorage, normalized);
      setModeState(normalized);
    },
  }), [mode, prefersLight]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
