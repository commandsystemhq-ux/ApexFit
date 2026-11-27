// Pure helpers for the Dark / Light / System appearance. The saved choice lives in localStorage; the page itself only
// ever sees the resolved value ('dark' or 'light') in <html data-theme>.

export const THEME_STORAGE_KEY = 'apexfit.theme';
export const THEME_MODES = ['dark', 'light', 'system'];
export const DEFAULT_THEME_MODE = 'dark';
export const THEME_COLORS = { dark: '#07090d', light: '#eef1f6' };

export function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : DEFAULT_THEME_MODE;
}

export function resolveTheme(mode, prefersLight) {
  const normalized = normalizeThemeMode(mode);
  if (normalized === 'system') return prefersLight ? 'light' : 'dark';
  return normalized;
}

export function readThemeMode(storage) {
  try {
    return normalizeThemeMode(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function writeThemeMode(storage, mode) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalizeThemeMode(mode));
  } catch {
    // Private browsing can refuse storage; the choice then lasts until the page closes.
  }
}

// Writes the appearance to <html>. `root` is document.documentElement, `meta` the theme-color <meta> (optional).
export function applyTheme(root, mode, prefersLight, meta = null) {
  const resolved = resolveTheme(mode, prefersLight);
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', normalizeThemeMode(mode));
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
  return resolved;
}

// The next mode when the compact toggle is pressed: dark -> light -> system -> dark.
export function nextThemeMode(mode) {
  const index = THEME_MODES.indexOf(normalizeThemeMode(mode));
  return THEME_MODES[(index + 1) % THEME_MODES.length];
}
