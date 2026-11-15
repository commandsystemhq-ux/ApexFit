import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGES, homePathFor, legacyHashPath, navigationFor, pathFor, safeRedirectPath } from '../src/routes.js';
import { translations } from '../src/i18n/translations.js';

test('every page has a unique absolute path and a translated title', () => {
  const paths = Object.values(PAGES).map((page) => page.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const page of Object.values(PAGES)) {
    assert.ok(page.path.startsWith('/'));
    assert.ok(translations.en[page.titleKey], `Missing title ${page.titleKey}`);
  }
});

test('navigation only lists pages the role may open', () => {
  for (const role of ['coach', 'client']) {
    for (const { items } of navigationFor(role)) {
      for (const id of items) assert.ok(['any', role].includes(PAGES[id].access), `${role} cannot open ${id}`);
    }
  }
});

test('home path depends on role', () => {
  assert.equal(homePathFor('coach'), '/dashboard');
  assert.equal(homePathFor('client'), '/workouts');
});

test('pathFor resolves ids and keeps absolute paths', () => {
  assert.equal(pathFor('coachHub'), '/coach-hub');
  assert.equal(pathFor('home'), '/');
  assert.equal(pathFor('/settings'), '/settings');
});

test('legacy hash URLs map to the new paths', () => {
  assert.equal(legacyHashPath('#coachHub'), '/coach-hub');
  assert.equal(legacyHashPath('#portal'), '/workouts');
  assert.equal(legacyHashPath('#features'), null);
});

test('post-login redirects stay inside the app', () => {
  assert.equal(safeRedirectPath({ pathname: '/clients', search: '?a=1' }), '/clients?a=1');
  assert.equal(safeRedirectPath({ pathname: '/login' }), null);
  assert.equal(safeRedirectPath({ pathname: '//evil.example' }), null);
  assert.equal(safeRedirectPath(undefined), null);
});
