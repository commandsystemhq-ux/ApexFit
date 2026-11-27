import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  DEFAULT_THEME_MODE, THEME_COLORS, THEME_MODES, THEME_STORAGE_KEY, applyTheme, nextThemeMode, normalizeThemeMode, readThemeMode, resolveTheme, writeThemeMode,
} from '../src/services/themeUtils.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tokens = read('src/styles/tokens.css');
const app = read('src/styles/app.css');

// ---------------------------------------------------------------------------------------------- reading the CSS

function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} block exists`);
  return css.slice(start, css.indexOf('\n}', start));
}
const declarations = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
const dark = declarations(block(tokens, ":root,\n:root[data-theme='dark']"));
const light = declarations(block(tokens, ":root[data-theme='light']"));

const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(h.slice(at, at + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// ---------------------------------------------------------------------------------------------- the three appearances

test('the saved choice is one of dark, light or system; dark is the default and anything else falls back to it', () => {
  assert.deepEqual(THEME_MODES, ['dark', 'light', 'system']);
  assert.equal(DEFAULT_THEME_MODE, 'dark');
  assert.equal(THEME_STORAGE_KEY, 'apexfit.theme');
  assert.equal(normalizeThemeMode('light'), 'light');
  assert.equal(normalizeThemeMode('system'), 'system');
  for (const bad of ['', 'blue', null, undefined, 3]) assert.equal(normalizeThemeMode(bad), 'dark');
});

test('system follows prefers-color-scheme; dark and light ignore it', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('nonsense', true), 'dark');
});

test('the choice is saved in localStorage and survives a storage that refuses', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readThemeMode(storage), 'dark');
  writeThemeMode(storage, 'light');
  assert.equal(store.get('apexfit.theme'), 'light');
  assert.equal(readThemeMode(storage), 'light');
  writeThemeMode(storage, 'garbage');
  assert.equal(store.get('apexfit.theme'), 'dark');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readThemeMode(broken), 'dark');
  assert.doesNotThrow(() => writeThemeMode(broken, 'light'));
  assert.equal(readThemeMode(null), 'dark');
});

test('applying a choice writes the resolved look and the saved choice on <html>, and the browser colour', () => {
  const attributes = {};
  const root = { setAttribute: (name, value) => { attributes[name] = value; } };
  const meta = { content: '', setAttribute(name, value) { this[name] = value; } };
  assert.equal(applyTheme(root, 'system', true, meta), 'light');
  assert.deepEqual(attributes, { 'data-theme': 'light', 'data-theme-mode': 'system' });
  assert.equal(meta.content, THEME_COLORS.light);
  assert.equal(applyTheme(root, 'dark', true, meta), 'dark');
  assert.equal(attributes['data-theme-mode'], 'dark');
  assert.equal(meta.content, THEME_COLORS.dark);
  assert.equal(THEME_COLORS.dark, '#07090d', 'the dark colour is the one index.html always had');
  assert.equal(nextThemeMode('dark'), 'light');
  assert.equal(nextThemeMode('light'), 'system');
  assert.equal(nextThemeMode('system'), 'dark');
});

test('the page sets the saved look before the first paint, with the same key and rules as the app', () => {
  const html = read('index.html');
  assert.match(html, /getItem\('apexfit\.theme'\)/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.match(html, /setAttribute\('data-theme', light \? 'light' : 'dark'\)/);
  assert.match(html, /setAttribute\('data-theme-mode', mode\)/);
  assert.ok(html.indexOf('apexfit.theme') < html.indexOf('/src/main.jsx'), 'the script runs before the app is loaded');
});

test('the toggle is in the top bar, in Settings and on the public pages; the provider wraps the app', () => {
  assert.match(read('src/main.jsx'), /<ThemeProvider>[\s\S]*<LocaleProvider>[\s\S]*<App \/>/);
  assert.match(read('src/components/AppShell.jsx'), /<ThemeToggle compact \/>/);
  assert.match(read('src/pages/SettingsPage.jsx'), /<ThemeToggle \/>/);
  for (const file of ['src/pages/LandingPage.jsx', 'src/components/AuthLayout.jsx', 'src/pages/PublicPages.jsx', 'src/pages/PublicStorePage.jsx']) assert.match(read(file), /<ThemeToggle compact \/>/, file);
  const provider = read('src/contexts/ThemeContext.jsx');
  assert.match(provider, /prefers-color-scheme: light/);
  assert.match(provider, /addEventListener\('change', update\)/, 'System follows the device while the app is open');
  assert.match(read('src/components/ThemeToggle.jsx'), /role="radiogroup"/);
});

test('every language names the three appearances', () => {
  for (const locale of supportedLocales) {
    const names = ['themeDark', 'themeLight', 'themeSystem'].map((key) => translations[locale][key]);
    assert.ok(names.every(Boolean), locale);
    assert.equal(new Set(names).size, 3, `${locale} names differ`);
    assert.ok(translations[locale].themeLabel && translations[locale].themeHelp);
  }
  assert.match(translations.ar.themeLight, /[\u0600-\u06FF]/);
});

// ---------------------------------------------------------------------------------------------- the stylesheet

test('dark keeps the original colours and light overrides every colour token', () => {
  assert.equal(dark['--bg'], '#07090d');
  assert.equal(dark['--surface'], '#10151e');
  assert.equal(dark['--text'], '#f4f7fb');
  assert.equal(dark['--blue'], '#328aff');
  assert.equal(dark['--bg-chrome'], '#080a0f');
  const colourTokens = Object.keys(dark).filter((name) => !['--radius', '--radius-lg', '--sidebar-width', '--font-display', '--gradient', '--gradient-blue'].includes(name));
  const missing = colourTokens.filter((name) => !(name in light));
  assert.deepEqual(missing, [], 'light must define a value for every dark colour token');
  assert.ok(Object.keys(dark).filter((name) => name.startsWith('--tx-')).length >= 40);
  assert.match(tokens, /:root\[data-theme='light'\] \{\s*color-scheme: light;/);
  assert.match(tokens, /color-scheme: dark;/);
  assert.match(block(tokens, '.live-room,\n.native-room'), /--text: #f4f7fb;/, 'video rooms stay dark in every appearance');
});

test('every variable the stylesheet uses is defined', () => {
  const defined = new Set([...Object.keys(dark), ...[...app.matchAll(/(--[\w-]+):/g)].map((match) => match[1])]);
  const used = [...new Set([...app.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))];
  assert.deepEqual(used.filter((name) => !defined.has(name)), []);
});

test('light text is readable: every text colour has at least 4.5:1 contrast on the light page and cards', () => {
  const backgrounds = [light['--bg'], light['--surface'], light['--bg-raised']];
  const textTokens = ['--text', '--muted', '--subtle', '--cyan', '--green', '--amber', '--red', '--purple', ...Object.keys(light).filter((name) => name.startsWith('--tx-'))];
  for (const name of textTokens) {
    for (const background of backgrounds) assert.ok(contrast(light[name], background) >= 4.5, `${name} ${light[name]} on ${background}: ${contrast(light[name], background).toFixed(2)}`);
  }
  assert.ok(contrast('#ffffff', light['--blue']) >= 4.5, 'white on the blue badge');
  assert.ok(contrast(light['--on-green'], light['--green']) >= 4.5, 'text on the green unread badge');
  assert.ok(contrast('#ffffff', light['--red']) >= 4.5, 'white on the red bell counter');
});

test('dark text keeps its original brightness', () => {
  for (const [name, value] of Object.entries(dark).filter(([key]) => key.startsWith('--tx-'))) {
    assert.equal(value, `#${name.slice(5)}`, `${name} is the colour it replaced`);
    assert.ok(contrast(value, dark['--bg']) >= 3, `${name} on the dark page`);
  }
});

test('no light colour is hard-coded for text; light-on-dark text only appears on surfaces that are dark in every appearance', () => {
  const allowedWhite = /button-primary|button-danger|jack-message-user|jack-send|jack-meal-save|nav-badge|chat-send|voice-play|chat-row\.is-mine|room-control|video-cover|exercise-media-play|jack-fab|\.avatar|chat-bubble|\.pricing|hero|landing|notif-count|lightbox|video-tile|live-room|native-room|room-/;
  const offenders = [];
  for (const line of app.split('\n')) {
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    const selector = line.slice(0, brace);
    for (const match of line.slice(brace).matchAll(/(?:^|[;{\s])(?:color|fill)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) {
      const hex = match[1].length === 4 ? `#${match[1].slice(1).split('').map((c) => c + c).join('')}` : match[1];
      if (luminance(hex) < 0.12) continue;
      if (hex.toLowerCase() === '#ffffff' && allowedWhite.test(selector)) continue;
      if (/live-room|native-room|video-tile|room-|chat-ticks|auth-google/.test(selector)) continue;
      offenders.push(`${selector.trim()} -> ${hex}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('washes and borders follow the theme: no white overlay is hard-coded outside media and avatars', () => {
  const offenders = app.split('\n').filter((line) => /rgba\(\s*255\s*,\s*255\s*,\s*255/.test(line) && !/^\.(avatar|exercise-media-play|lightbox-close)\b/.test(line));
  assert.deepEqual(offenders, []);
  for (const surface of ['sidebar', 'topbar', 'toast', 'video-dialog', 'habit-modal', 'jack-drawer', 'nav-tooltip', 'phone-frame', 'panel']) {
    const rule = app.split('\n').find((line) => new RegExp(`^[^{]*\\.${surface}\\b[^{]*\\{`).test(line) && /background/.test(line));
    assert.ok(rule, `${surface} has a background rule`);
    assert.doesNotMatch(rule, /background: #[0-9a-f]{6}\b/i, `${surface} background is a theme variable`);
  }
});

test('the light look softens shadows and the toggle is styled for both reading directions', () => {
  assert.match(app, /:root\[data-theme='light'\] \.panel,/);
  assert.match(app, /:root\[data-theme='light'\] \.toast,/);
  assert.match(app, /\.theme-toggle \{ display: inline-flex;/);
  assert.doesNotMatch(app.match(/\.theme-toggle[^\n]*/g).join('\n'), /margin-left|margin-right|padding-left|padding-right/, 'only logical properties, so it works right-to-left');
});
