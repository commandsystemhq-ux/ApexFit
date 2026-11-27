import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import pricingHandler from '../api/paddle.js';
import {
  GLOBAL_USD, PRICED_COUNTRIES, configuredPriceIds, createCheckoutTransaction, mapPaddleEvent, priceIdForCountry, pricingForCountry,
  pricingFromRequest, resolveCountry,
} from '../api/_lib/paddle.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { checkoutOptions } from '../src/services/billingUtils.js';
import { fetchPricing } from '../src/services/pricingService.js';
import {
  COMPARISON_SOURCES, COMPARISON_VERIFIED_ON, FALLBACK_PRICING, chargedPrice, fill, formatLocal, formatUsd, headlinePrice, isApproximate,
  normalizePricing, testCountry,
} from '../src/services/pricingUtils.js';

// Price by country: the server reads the visitor's country from Vercel's IP header (a VPN changes it), a test parameter
// works outside production, and anything unknown gets the world price. The pages show the local price and, for Egypt,
// Saudi Arabia and the UAE, the approximate local amount next to the USD Paddle really charges.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const request = (country, { url = '/api/paddle?action=pricing', method = 'GET', headers = {} } = {}) => ({
  method, url, headers: { ...(country ? { 'x-vercel-ip-country': country } : {}), ...headers },
});

function fakeResponse() {
  return {
    statusCode: 200, body: undefined, headers: {}, headersSent: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

// ------------------------------------------------------------------ country from the IP

test('the country comes from the Vercel IP header, in any letter case', () => {
  assert.deepEqual(resolveCountry(request('EG'), {}), { country: 'EG', source: 'ip' });
  assert.deepEqual(resolveCountry(request('sa'), {}), { country: 'SA', source: 'ip' });
  assert.deepEqual(resolveCountry({ url: '/', headers: { 'x-vercel-ip-country': ['AE', 'US'] } }, {}), { country: 'AE', source: 'ip' });
});

test('an unknown country falls back to the world price', () => {
  for (const req of [request(null), request(''), request('XX'), request('T1'), request('EGY'), request('1'), { url: '/', headers: {} }, undefined]) {
    assert.deepEqual(resolveCountry(req, {}), { country: null, source: 'fallback' });
  }
  const pricing = pricingFromRequest(request(null), {});
  assert.deepEqual([pricing.region, pricing.usd, pricing.local, pricing.localized, pricing.source], ['GLOBAL', 39, null, false, 'fallback']);
  assert.equal(GLOBAL_USD, 39);
});

test('?country= tries a price outside production and is ignored in production', () => {
  const tried = request('US', { url: '/api/paddle?action=pricing&country=eg' });
  assert.deepEqual(resolveCountry(tried, {}), { country: 'EG', source: 'query' });
  assert.deepEqual(resolveCountry(tried, { VERCEL_ENV: 'preview' }), { country: 'EG', source: 'query' });
  assert.deepEqual(resolveCountry(tried, { VERCEL_ENV: 'development' }), { country: 'EG', source: 'query' });
  assert.deepEqual(resolveCountry(tried, { VERCEL_ENV: 'production' }), { country: 'US', source: 'ip' });
  assert.deepEqual(resolveCountry({ ...tried, query: { country: 'SA' }, url: '/api/paddle' }, {}), { country: 'SA', source: 'query' });
  // A badly formed test value does not hide the real country.
  assert.deepEqual(resolveCountry(request('AE', { url: '/api/paddle?country=zzz' }), {}), { country: 'AE', source: 'ip' });
});

// ------------------------------------------------------------------ the prices

test('Egypt, Saudi Arabia and the UAE have their own USD price and an approximate local amount; everyone else pays $39', () => {
  const egypt = pricingForCountry('EG', {});
  assert.deepEqual([egypt.region, egypt.usd, egypt.local, egypt.localized], ['EG', 15, { currency: 'EGP', amount: 750, approximate: true }, true]);
  const saudi = pricingForCountry('SA', {});
  assert.deepEqual([saudi.region, saudi.usd, saudi.local], ['SA', 25, { currency: 'SAR', amount: 94, approximate: true }]);
  const emirates = pricingForCountry('AE', {});
  assert.deepEqual([emirates.region, emirates.usd, emirates.local], ['AE', 25, { currency: 'AED', amount: 92, approximate: true }]);
  for (const country of ['US', 'DE', 'FR', 'ES', 'GB', null, undefined, 'XX']) {
    const world = pricingForCountry(country, {});
    assert.deepEqual([world.region, world.usd, world.local, world.localized, world.trialDays], ['GLOBAL', 39, null, false, 14]);
  }
  assert.deepEqual(Object.keys(PRICED_COUNTRIES), ['EG', 'SA', 'AE']);
});

test('the prices can be changed in the server settings, and a bad value keeps the default', () => {
  const environment = { PRICING_GLOBAL_USD: '49', PRICING_EG_USD: '12', PRICING_EG_LOCAL: '600', PRICING_SA_USD: 'abc', PRICING_AE_LOCAL: '-5' };
  assert.equal(pricingForCountry('US', environment).usd, 49);
  assert.equal(pricingForCountry('US', environment).globalUsd, 49);
  assert.deepEqual([pricingForCountry('EG', environment).usd, pricingForCountry('EG', environment).local.amount], [12, 600]);
  assert.equal(pricingForCountry('SA', environment).usd, 25);
  assert.equal(pricingForCountry('AE', environment).local.amount, 92);
});

test('the Paddle price follows the country, with the main price as the fallback', () => {
  const environment = { PADDLE_PRICE_ID: 'pri_main', PADDLE_PRICE_ID_EG: 'pri_eg', PADDLE_PRICE_ID_SA: ' pri_sa ' };
  assert.equal(priceIdForCountry('EG', environment), 'pri_eg');
  assert.equal(priceIdForCountry('SA', environment), 'pri_sa');
  assert.equal(priceIdForCountry('AE', environment), 'pri_main');
  assert.equal(priceIdForCountry('US', environment), 'pri_main');
  assert.equal(priceIdForCountry(null, environment), 'pri_main');
  assert.equal(priceIdForCountry('US', { PADDLE_PRICE_ID_US: 'pri_us', PADDLE_PRICE_ID: 'pri_main' }), 'pri_main', 'only the priced countries have their own price');
  assert.deepEqual(configuredPriceIds(environment), ['pri_main', 'pri_eg', 'pri_sa']);
  assert.deepEqual(configuredPriceIds({}), []);
});

test('a subscription bought at a country price is still the coach plan; an unknown price is not', () => {
  const event = (priceId) => ({
    event_id: 'evt_1', event_type: 'subscription.created', occurred_at: '2026-11-27T10:00:00Z',
    data: { id: 'sub_1', status: 'active', customer_id: 'ctm_1', custom_data: { user_id: '00000000-0000-4000-8000-0000000000a1' }, items: [{ price: { id: priceId } }] },
  });
  const known = configuredPriceIds({ PADDLE_PRICE_ID: 'pri_main', PADDLE_PRICE_ID_EG: 'pri_eg' });
  assert.equal(mapPaddleEvent(event('pri_eg'), { priceId: known }).plan, 'coach_monthly');
  assert.equal(mapPaddleEvent(event('pri_main'), { priceId: known }).plan, 'coach_monthly');
  assert.equal(mapPaddleEvent(event('pri_other'), { priceId: known }).plan, 'other');
  assert.equal(mapPaddleEvent(event('pri_main'), { priceId: 'pri_main' }).plan, 'coach_monthly', 'a single id still works');
  assert.equal(mapPaddleEvent(event('pri_anything'), { priceId: [] }).plan, 'coach_monthly');
});

test('the checkout is created with the price chosen for the country', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ data: { id: 'txn_01abc' } }) }; };
  const config = { environment: 'sandbox', apiKey: 'key', priceId: 'pri_main' };
  await createCheckoutTransaction({ userId: 'u1', customerId: null, config, fetchImpl, priceId: 'pri_eg' });
  await createCheckoutTransaction({ userId: 'u1', customerId: null, config, fetchImpl });
  assert.equal(sent[0].items[0].price_id, 'pri_eg');
  assert.equal(sent[1].items[0].price_id, 'pri_main');
});

// ------------------------------------------------------------------ the pricing action of api/paddle.js

test('the pricing action is public: GET or POST, no sign-in, never cached', async () => {
  const get = fakeResponse();
  await pricingHandler(request('EG'), get);
  assert.equal(get.statusCode, 200);
  assert.deepEqual([get.body.region, get.body.usd, get.body.local.amount, get.body.source], ['EG', 15, 750, 'ip']);
  assert.equal(get.headers['cache-control'], 'private, no-store');
  assert.equal('priceId' in get.body, false, 'no Paddle ids are sent to the page');

  const post = fakeResponse();
  await pricingHandler({ method: 'POST', url: '/api/paddle', headers: { 'x-vercel-ip-country': 'US' }, body: { action: 'pricing' } }, post);
  assert.deepEqual([post.statusCode, post.body.region, post.body.usd], [200, 'GLOBAL', 39]);

  const unknown = fakeResponse();
  await pricingHandler(request(null), unknown);
  assert.deepEqual([unknown.body.region, unknown.body.usd, unknown.body.source], ['GLOBAL', 39, 'fallback']);
});

test('the other actions still need a signed-in coach and other methods are refused', async () => {
  const checkout = fakeResponse();
  await pricingHandler({ method: 'POST', url: '/api/paddle', headers: {}, body: { action: 'checkout' } }, checkout);
  assert.equal(checkout.statusCode, 401);
  const portal = fakeResponse();
  await pricingHandler({ method: 'POST', url: '/api/paddle', headers: {}, body: { action: 'portal' } }, portal);
  assert.equal(portal.statusCode, 401);
  const getCheckout = fakeResponse();
  await pricingHandler(request('EG', { url: '/api/paddle?action=checkout' }), getCheckout);
  assert.equal(getCheckout.statusCode, 400);
  const put = fakeResponse();
  await pricingHandler({ method: 'PUT', url: '/api/paddle', headers: {} }, put);
  assert.equal(put.statusCode, 405);
});

test('no function was added to api/ (Vercel Hobby allows 12)', () => {
  const functions = readdirSync(new URL('../api/', import.meta.url)).filter((name) => !name.startsWith('_'));
  assert.equal(functions.length, 11);
  assert.ok(functions.includes('paddle.js'));
});

// ------------------------------------------------------------------ what the pages show

test('the headline price is the local amount for Egypt, Saudi Arabia and the UAE, and dollars elsewhere', () => {
  const egypt = normalizePricing(pricingForCountry('EG', {}));
  assert.equal(headlinePrice(egypt, 'ar'), '750 ج.م');
  assert.equal(headlinePrice(egypt, 'en'), '750 EGP');
  assert.equal(headlinePrice(egypt, 'de'), '750 EGP');
  assert.equal(chargedPrice(egypt), '$15');
  assert.equal(isApproximate(egypt), true);
  assert.equal(formatLocal(egypt.local, 'ar-EG'), '750 ج.م');

  assert.equal(headlinePrice(normalizePricing(pricingForCountry('SA', {})), 'ar'), '94 ر.س');
  assert.equal(headlinePrice(normalizePricing(pricingForCountry('AE', {})), 'en'), '92 AED');
  assert.equal(chargedPrice(normalizePricing(pricingForCountry('SA', {}))), '$25');

  const world = normalizePricing(pricingForCountry('US', {}));
  assert.equal(headlinePrice(world, 'ar'), '$39');
  assert.equal(isApproximate(world), false);
  assert.equal(formatUsd(1234.5), '$1,234.5');
});

test('anything odd from the network becomes the world price', () => {
  for (const bad of [null, undefined, 'x', {}, { usd: 0 }, { usd: 'abc' }, { usd: -3 }]) {
    assert.deepEqual(normalizePricing(bad), FALLBACK_PRICING);
  }
  // A local price without a known currency, or for a country that has none, is dropped.
  const noCurrency = normalizePricing({ usd: 15, region: 'EG', local: { currency: 'XYZ', amount: 750 } });
  assert.deepEqual([noCurrency.region, noCurrency.local, noCurrency.localized], ['GLOBAL', null, false]);
  const wrongRegion = normalizePricing({ usd: 39, region: 'US', local: { currency: 'EGP', amount: 750 } });
  assert.deepEqual([wrongRegion.region, wrongRegion.local], ['GLOBAL', null]);
  assert.equal(normalizePricing({ usd: 25, region: 'SA', local: { currency: 'SAR', amount: 94 }, source: 'weird' }).source, 'fallback');
});

test('the page asks the server for the price and keeps working when the server is not there', async () => {
  const urls = [];
  const ok = async (url) => { urls.push(url); return { ok: true, json: async () => pricingForCountry('SA', {}) }; };
  assert.equal((await fetchPricing({ search: '', fetchImpl: ok })).region, 'SA');
  await fetchPricing({ search: '?country=eg', fetchImpl: ok });
  assert.deepEqual(urls, ['/api/paddle?action=pricing', '/api/paddle?action=pricing&country=EG']);

  assert.deepEqual(await fetchPricing({ search: '', fetchImpl: async () => { throw new Error('offline'); } }), FALLBACK_PRICING);
  assert.deepEqual(await fetchPricing({ search: '', fetchImpl: async () => ({ ok: false, json: async () => ({}) }) }), FALLBACK_PRICING);
  assert.deepEqual(await fetchPricing({ search: '', fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('not json'); } }) }), FALLBACK_PRICING);
  assert.equal(testCountry('?country=us&x=1'), 'US');
  assert.equal(testCountry('?country=usa'), '');
  assert.equal(testCountry(''), '');
});

test('Paddle is told the country only when it has its own price', () => {
  assert.deepEqual(checkoutOptions({ transactionId: 'txn_1', locale: 'ar', email: 'a@b.co', countryCode: 'EG' }).customer, { email: 'a@b.co', address: { countryCode: 'EG' } });
  assert.deepEqual(checkoutOptions({ transactionId: 'txn_1', locale: 'ar', countryCode: 'SA' }).customer, { address: { countryCode: 'SA' } });
  assert.equal('customer' in checkoutOptions({ transactionId: 'txn_1', locale: 'ar', countryCode: null }), false);
  assert.deepEqual(checkoutOptions({ transactionId: 'txn_1', locale: 'en', email: 'a@b.co' }).customer, { email: 'a@b.co' });
});

test('placeholders in sentences are filled, and left alone when no value is given', () => {
  assert.equal(fill('{days}-day trial, then {price}', { days: 14, price: '$39' }), '14-day trial, then $39');
  assert.equal(fill('about {price} {missing}', { price: '750 EGP' }), 'about 750 EGP {missing}');
  assert.equal(fill(undefined), '');
});

// ------------------------------------------------------------------ the five languages

const marketingKeys = Object.keys(translations.en).filter((key) => key.startsWith('mk'));

test('every marketing sentence exists in all five languages with the same placeholders', () => {
  assert.ok(marketingKeys.length > 250);
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const locale of supportedLocales) {
    for (const key of marketingKeys) {
      const text = translations[locale][key];
      assert.ok(text && text.trim(), `${locale}.${key} is empty`);
      assert.equal(placeholders(text), placeholders(translations.en[key]), `${locale}.${key} placeholders`);
    }
  }
});

test('the Arabic page is real Arabic and keeps the key promises', () => {
  const arabic = /[\u0600-\u06FF]/;
  for (const key of marketingKeys.filter((name) => !/^(mkTab4Name|mkPvJackName|mkCmpColApex)$/.test(name))) {
    assert.match(translations.ar[key], arabic, `ar.${key} has no Arabic`);
  }
  const { ar } = translations;
  assert.match(ar.mkBadge, /الأشمل للمدرب العربي/);
  assert.match(`${ar.mkHeroA} ${ar.mkHeroB}`, /أول منصة عربية متكاملة في الشرق الأوسط/);
  assert.match(ar.mkCtaTrial, /14/);
  assert.equal(ar.mkCtaFeatures, 'شاهد المميزات');
  assert.match(ar.mkProblemTitle, /واتساب وإكسيل وPDF/);
  assert.match(ar.mkApproxTag, /تقريباً/);
  assert.match(ar.mkPerMonth, /شهرياً/);
  assert.match(ar.mkTab2B4, /رمضان/);
  assert.ok(ar.mkHeroSub.includes('1,204'));
  for (const locale of supportedLocales) {
    assert.match(translations[locale].mkCtaTrial, /14/, locale);
    assert.ok(translations[locale].mkStatFoods && translations[locale].mkBadgeCountry.includes('{country}'));
    assert.doesNotMatch(translations[locale].mkCtaTrial, /\b72\b/);
  }
});

test('the plan lists every feature and the comparison has the same rows in every language', () => {
  for (const locale of supportedLocales) {
    for (let index = 1; index <= 12; index += 1) assert.ok(translations[locale][`mkPlanF${index}`], `${locale} mkPlanF${index}`);
    for (let row = 1; row <= 8; row += 1) for (const column of ['L', 'A', 'F', 'M']) assert.ok(translations[locale][`mkCmpR${row}${column}`], `${locale} row ${row}${column}`);
    for (let index = 1; index <= 6; index += 1) assert.ok(translations[locale][`mkFaq${index}Q`] && translations[locale][`mkFaq${index}A`]);
    for (const region of ['EG', 'SA', 'AE']) assert.ok(translations[locale][`mkCountry${region}`]);
    assert.match(translations[locale].mkApproxNote, /\{usd\}/, `${locale} says what is really charged`);
  }
});

// ------------------------------------------------------------------ the pages and the stylesheet

test('the comparison gives its sources and the date they were checked', () => {
  assert.match(COMPARISON_VERIFIED_ON, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(COMPARISON_SOURCES.map((source) => new URL(source.href).protocol), ['https:', 'https:']);
  for (const locale of supportedLocales) assert.match(translations[locale].mkCmpSourceNote, /\{sources\}.*\{date\}/, locale);
  const table = read('src/components/marketing/ComparisonTable.jsx');
  assert.match(table, /COMPARISON_VERIFIED_ON/);
  assert.match(table, /rel="noopener noreferrer"/);
  assert.match(table, /mkCmpColApex[\s\S]*mkCmpColForeign[\s\S]*mkCmpColManual/);
});

test('the home page and /pricing show the one plan with the local price, the comparison under it, and the footer', () => {
  const landing = read('src/pages/LandingPage.jsx');
  for (const piece of ['AppPreview', 'FeatureShowcase', 'PlanCard', 'ComparisonTable', 'Faq', 'usePricing', '<PublicFooter />', '<ThemeToggle compact />']) assert.ok(landing.includes(piece), piece);
  for (const id of ['features', 'pricing', 'compare', 'faq']) assert.match(landing, new RegExp(`id="${id}"`), `section ${id}`);
  assert.ok(landing.indexOf('<PlanCard') < landing.indexOf('<ComparisonTable'), 'the comparison is under the plan');
  assert.ok(landing.indexOf('<h1>') < landing.indexOf('<AppPreview'));

  const pricing = read('src/pages/PublicPages.jsx');
  assert.ok(pricing.indexOf('<PlanCard') < pricing.indexOf('<ComparisonTable'));
  assert.match(pricing, /usePricing\(\)/);
  assert.match(pricing, /PAGES\.billing\.path/);

  const card = read('src/components/marketing/PlanCard.jsx');
  assert.match(card, /mkBadgeCountry/);
  assert.match(card, /mkApproxNote/);
  assert.match(card, /mkPlanF\$\{index \+ 1\}/);

  const preview = read('src/components/marketing/AppPreview.jsx');
  assert.doesNotMatch(preview, /<img|https?:\/\//, 'the preview is made of CSS, with no external images');
});

test('every public path and the app routes still exist', () => {
  const app = read('src/App.jsx');
  for (const piece of ['<LandingPage />', 'PricingPage', 'TermsPage', 'PrivacyPage', 'RefundsPage', 'RequireAuth', 'BillingPage']) assert.ok(app.includes(piece), piece);
});

test('the stylesheet follows the theme: no white overlays, no physical left/right, and every variable is defined', () => {
  const css = read('src/styles/marketing.css');
  const tokens = read('src/styles/tokens.css');
  assert.doesNotMatch(css, /rgba\(\s*255\s*,\s*255\s*,\s*255/);
  assert.doesNotMatch(css, /(margin|padding)-(left|right)|text-align:\s*(left|right)|(?:^|[\s{;])(?:left|right)\s*:/m, 'logical properties only, so Arabic mirrors correctly');
  const defined = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map((match) => match[1]).concat([...css.matchAll(/(--[\w-]+):/g)].map((match) => match[1])));
  const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))];
  assert.deepEqual(used.filter((name) => !defined.has(name)), []);
  assert.match(css, /\[dir='rtl'\] \.mk-hero h1 \{[^}]*letter-spacing: 0/, 'Arabic letters must stay joined');
  assert.match(css, /\[dir='rtl'\] \.mk-arrow/);
  assert.match(css, /:root\[data-theme='light'\] \.mk-gradient/);
});

test('text colours used on the home page are readable on the light and the dark page', () => {
  const tokens = read('src/styles/tokens.css').replace(/\n\s*\n/g, '\n');
  const take = (selector) => { const start = tokens.indexOf(`${selector} {`); return tokens.slice(start, tokens.indexOf('\n}', start)); };
  const values = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((match) => [match[1], match[2]]));
  const dark = values(take(":root,\n:root[data-theme='dark']"));
  const light = values(take(":root[data-theme='light']"));
  const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const luminance = (hex) => { const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  const css = read('src/styles/marketing.css');
  const textTokens = [...new Set([...css.matchAll(/(?:^|[;{\s])color:\s*var\((--[\w-]+)\)/g)].map((match) => match[1]))];
  assert.ok(textTokens.length >= 6);
  for (const name of textTokens) {
    for (const surface of ['--bg', '--surface', '--bg-raised']) {
      assert.ok(contrast(light[name], light[surface]) >= 4.5, `light ${name} on ${surface}: ${contrast(light[name], light[surface]).toFixed(2)}`);
      assert.ok(contrast(dark[name], dark[surface]) >= 4.5, `dark ${name} on ${surface}: ${contrast(dark[name], dark[surface]).toFixed(2)}`);
    }
  }
  // The gradient headline words in the light look, against the page and the card.
  for (const hex of ['#1f5fd0', '#087078']) for (const surface of ['--bg', '--surface']) assert.ok(contrast(hex, light[surface]) >= 4.5, `${hex} on ${surface}`);
});
