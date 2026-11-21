import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTH_PATHS, PAGES, PUBLIC_PATHS } from '../src/routes.js';
import { publicContentFor, publicPagesContent } from '../src/i18n/publicPagesContent.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('public paths are distinct from the app and auth paths', () => {
  assert.deepEqual(PUBLIC_PATHS, { pricing: '/pricing', terms: '/terms', privacy: '/privacy', refunds: '/refunds' });
  const taken = new Set([...Object.values(PAGES).map((page) => page.path), ...Object.values(AUTH_PATHS)]);
  for (const path of Object.values(PUBLIC_PATHS)) assert.ok(!taken.has(path), `${path} clashes with another route`);
});

test('public pages are routed outside the login guard so guests are not sent to the dashboard', () => {
  const app = read('src/App.jsx');
  const guarded = app.indexOf('<RequireAuth />');
  assert.ok(guarded > 0);
  for (const id of ['pricing', 'terms', 'privacy', 'refunds']) {
    const at = app.indexOf(`path={PUBLIC_PATHS.${id}}`);
    assert.ok(at > 0 && at < guarded, `${id} must be declared before the RequireAuth routes`);
    assert.ok(!app.slice(at, app.indexOf('/>', at)).includes('LandingGate'), `${id} must not use LandingGate`);
  }
});

test('footer is shown on the landing, login/signup and public pages and links all four pages', () => {
  assert.match(read('src/pages/LandingPage.jsx'), /<PublicFooter \/>/);
  assert.match(read('src/components/AuthLayout.jsx'), /<PublicFooter \/>/);
  assert.match(read('src/pages/PublicPages.jsx'), /<PublicFooter \/>/);
  const footer = read('src/components/PublicFooter.jsx');
  for (const id of ['pricing', 'terms', 'privacy', 'refunds']) assert.ok(footer.includes(`'${id}'`), `footer misses ${id}`);
  for (const locale of supportedLocales) {
    for (const key of ['footerPricing', 'footerTerms', 'footerPrivacy', 'footerRefunds']) assert.ok(translations[locale][key], `${locale} misses ${key}`);
  }
});

test('Arabic and English public content have the same structure and state the plan', () => {
  const { en, ar } = publicPagesContent;
  for (const page of ['terms', 'privacy', 'refunds']) {
    assert.equal(ar[page].sections.length, en[page].sections.length, `${page} sections differ`);
    for (const [heading, paragraphs] of [...en[page].sections, ...ar[page].sections]) assert.ok(heading && paragraphs.length);
  }
  assert.equal(ar.pricing.features.length, en.pricing.features.length);
  for (const locale of [en, ar]) {
    assert.equal(locale.pricing.price, '$39');
    assert.match(locale.pricing.trial, /3/);
  }
  assert.equal(publicContentFor('ar').locale, 'ar');
  assert.equal(publicContentFor('de').locale, 'en');
});