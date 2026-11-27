// Pure rules for the plan price shown on the home page, /pricing and the billing page (no network, no React).
// The server (api/paddle.js, action "pricing") decides the country and the price; this file only shapes and words it.

export const GLOBAL_USD = 39;
export const TRIAL_DAYS = 14;

// What is shown while the server has not answered (or cannot, for example in plain `vite dev`): the world price.
export const FALLBACK_PRICING = Object.freeze({
  country: null, region: 'GLOBAL', localized: false, usd: GLOBAL_USD, globalUsd: GLOBAL_USD, local: null, trialDays: TRIAL_DAYS, source: 'fallback',
});

export const COUNTRY_FLAGS = { EG: '\u{1F1EA}\u{1F1EC}', SA: '\u{1F1F8}\u{1F1E6}', AE: '\u{1F1E6}\u{1F1EA}', GLOBAL: '\u{1F30D}' };

// The sources behind the comparison table, and when they were last checked against the providers' public pricing pages.
export const COMPARISON_VERIFIED_ON = '2026-11-27';
export const COMPARISON_SOURCES = [
  { label: 'trainerize.com/pricing', href: 'https://www.trainerize.com/pricing/' },
  { label: 'truecoach.co/pricing', href: 'https://truecoach.co/pricing/' },
];

const CURRENCY_LABELS = {
  EGP: { en: 'EGP', ar: 'ج.م', de: 'EGP', fr: 'EGP', es: 'EGP' },
  SAR: { en: 'SAR', ar: 'ر.س', de: 'SAR', fr: 'SAR', es: 'SAR' },
  AED: { en: 'AED', ar: 'د.إ', de: 'AED', fr: 'AED', es: 'AED' },
};

const cleanNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

// Accepts whatever came back from the network and returns a complete pricing object; anything odd becomes the world price.
export function normalizePricing(payload) {
  const usd = cleanNumber(payload?.usd);
  if (!payload || typeof payload !== 'object' || !usd) return { ...FALLBACK_PRICING };
  const amount = cleanNumber(payload.local?.amount);
  const label = typeof payload.local?.currency === 'string' ? payload.local.currency.toUpperCase() : '';
  const local = amount && CURRENCY_LABELS[label] ? { currency: label, amount, approximate: true } : null;
  const region = local && ['EG', 'SA', 'AE'].includes(payload.region) ? payload.region : 'GLOBAL';
  return {
    country: typeof payload.country === 'string' && /^[A-Z]{2}$/.test(payload.country) ? payload.country : null,
    region,
    localized: region !== 'GLOBAL',
    usd,
    globalUsd: cleanNumber(payload.globalUsd) || GLOBAL_USD,
    local: region === 'GLOBAL' ? null : local,
    trialDays: cleanNumber(payload.trialDays) || TRIAL_DAYS,
    source: ['ip', 'query'].includes(payload.source) ? payload.source : 'fallback',
  };
}

const groupDigits = (amount) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount);

export function formatUsd(amount) {
  return `$${groupDigits(amount)}`;
}

export function currencyLabel(currency, locale = 'en') {
  const language = String(locale).slice(0, 2);
  return CURRENCY_LABELS[currency]?.[language] || CURRENCY_LABELS[currency]?.en || currency;
}

// "750 ج.م" in Arabic, "750 EGP" elsewhere. Digits stay Western so the price reads the same in every language.
export function formatLocal(local, locale = 'en') {
  return `${groupDigits(local.amount)} ${currencyLabel(local.currency, locale)}`;
}

// The big price: the local amount in the country's currency when there is one, otherwise dollars.
export function headlinePrice(pricing, locale = 'en') {
  return pricing.local ? formatLocal(pricing.local, locale) : formatUsd(pricing.usd);
}

// What Paddle really charges. It is the same as the headline price for the world price, and the dollar equivalent for local prices.
export function chargedPrice(pricing) {
  return formatUsd(pricing.usd);
}

// Keeps an amount such as "$15" reading left to right inside an Arabic sentence.
export const isolate = (text) => `\u2066${text}\u2069`;

// Fills {name} placeholders of a translated sentence.
export function fill(text, values = {}) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

// Whether to show the "about" wording and the "paid in USD" note.
export const isApproximate = (pricing) => Boolean(pricing.local?.approximate);

// A country picked in the address bar (?country=EG) is passed along so previews can try every price; the server ignores it in production.
export function testCountry(search = '') {
  const code = new URLSearchParams(search).get('country');
  return code && /^[a-zA-Z]{2}$/.test(code) ? code.toUpperCase() : '';
}