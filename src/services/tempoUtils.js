import { fillText } from './accountabilityUtils.js';

// Lifting tempo such as 3-1-1-0: seconds lowering, pause at the bottom, lifting, pause at the top.
// Each part is one digit, or X for "as fast as possible". An empty tempo means none was set.

export const TEMPO_PATTERN = /^[0-9X]-[0-9X]-[0-9X]-[0-9X]$/;
export const TEMPO_PHASES = Object.freeze(['down', 'bottom', 'up', 'top']);

const ARABIC_DIGITS = /[\u0660-\u0669]/g;
const EASTERN_ARABIC_DIGITS = /[\u06F0-\u06F9]/g;

// Accepts what a coach is likely to type: 3110, 3 1 1 0, 3,1,1,0, 3/1/1/0, 3-1-x-0 or Arabic-Indic digits.
export function normalizeTempo(value) {
  const text = String(value ?? '')
    .replace(ARABIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(EASTERN_ARABIC_DIGITS, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .trim()
    .toUpperCase()
    .replace(/[\s,.\u2013\u2014/_]+/g, '-');
  return /^[0-9X]{4}$/.test(text) ? [...text].join('-') : text;
}

export const isValidTempo = (value) => {
  const tempo = normalizeTempo(value);
  return tempo === '' || TEMPO_PATTERN.test(tempo);
};

// [{ phase: 'down', value: '3' }, ...] for a valid tempo, otherwise null.
export function tempoParts(value) {
  const tempo = normalizeTempo(value);
  if (!TEMPO_PATTERN.test(tempo)) return null;
  return tempo.split('-').map((part, index) => ({ phase: TEMPO_PHASES[index], value: part }));
}

// "Lowering 3 s · Pause at the bottom 1 s · Lifting 1 s · Pause at the top 0 s" in the user's language.
export function describeTempo(value, t) {
  const parts = tempoParts(value);
  if (!parts) return '';
  return parts
    .map((part) => `${t(`tpPhase_${part.phase}`)} ${part.value === 'X' ? t('tpExplosive') : fillText(t('tpSeconds'), { n: part.value })}`)
    .join(' \u00B7 ');
}
