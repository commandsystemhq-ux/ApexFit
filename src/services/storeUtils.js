import { CURRENCIES, formatMoney } from './coachingUtils.js';

export const STORE_LIMITS = { title: 120, description: 1000, cover: 500, minPriceCents: 50, maxPriceCents: 100000000 };

// "29", "29.9", "29,90" → cents. Zero means a free product. Returns null when the text is not a price.
export function parsePriceToCents(input) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function centsToInput(cents) {
  return cents === 0 ? '0' : (cents / 100).toFixed(2);
}

export function isSecureUrl(value) {
  return typeof value === 'string' && value.length <= STORE_LIMITS.cover && /^https:\/\/[^\s<>"]+$/.test(value);
}

export function emptyProductDraft(overrides = {}) {
  return { id: null, programId: '', title: '', description: '', price: '29', currency: 'usd', cover: '', publish: true, locked: false, ...overrides };
}

export function validateProductForm(form) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  const description = String(form.description ?? '').trim();
  const cover = String(form.cover ?? '').trim();
  const cents = parsePriceToCents(form.price);

  if (!form.programId) errors.programId = 'strErrProgram';
  if (!title) errors.title = 'strErrTitle';
  else if (title.length > STORE_LIMITS.title) errors.title = 'strErrTitleLength';
  if (description.length > STORE_LIMITS.description) errors.description = 'strErrDescription';
  if (cents === null || !(cents === 0 || (cents >= STORE_LIMITS.minPriceCents && cents <= STORE_LIMITS.maxPriceCents))) errors.price = 'strErrPrice';
  if (!CURRENCIES.includes(form.currency)) errors.currency = 'strErrCurrency';
  if (cover && !isSecureUrl(cover)) errors.cover = 'strErrCover';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: {
      id: form.id ?? null,
      programId: form.programId,
      title,
      description,
      priceCents: cents ?? 0,
      currency: form.currency,
      cover: cover || null,
      publish: Boolean(form.publish),
    },
  };
}

export function formatPrice(cents, currency, locale, freeLabel) {
  return cents === 0 ? freeLabel : formatMoney(cents, currency, locale);
}

// Revenue lines like "$58.00 · €15.00".
export function formatRevenue(revenue, locale) {
  if (!revenue?.length) return formatMoney(0, 'usd', locale);
  return revenue.map((line) => formatMoney(Number(line.cents), line.currency, locale)).join(' · ');
}

export function publicStorePath(coachId) {
  return `/shop/${coachId}`;
}

export function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}