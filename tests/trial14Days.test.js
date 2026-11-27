import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { publicPagesContent } from '../src/i18n/publicPagesContent.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  client: '00000000-0000-4000-8000-0000000000c1',
  legacy: '00000000-0000-4000-8000-0000000000d1',
};
const HOUR = 3600 * 1000;
let db;

before(async () => { db = await createTestDatabase(); });
beforeEach(async () => { await db.exec('truncate public.profiles cascade; delete from auth.users;'); });

test('a new coach gets a 14-day trial from the database clock', async () => {
  await db.query("insert into auth.users (id, email) values ($1, 'new@example.com')", [ids.coach]);
  const { data, error } = await createUserClient(db, ids.coach).rpc('provision_my_profile', { p_role: 'coach' });
  assert.equal(error, null);
  assert.equal(data.access_state, 'trialing');
  const [row] = (await db.query('select trial_started_at, trial_ends_at from public.profiles where id = $1', [ids.coach])).rows;
  assert.equal(new Date(row.trial_ends_at) - new Date(row.trial_started_at), 14 * 24 * HOUR);
});

test('a new client has no trial window', async () => {
  await db.query("insert into auth.users (id, email) values ($1, 'client@example.com')", [ids.client]);
  const { error } = await createUserClient(db, ids.client).rpc('provision_my_profile', { p_role: 'client' });
  assert.equal(error, null);
  const [row] = (await db.query('select trial_started_at, trial_ends_at from public.profiles where id = $1', [ids.client])).rows;
  assert.deepEqual([row.trial_started_at, row.trial_ends_at], [null, null]);
});

test('coaches created before the change keep their 72-hour window, but other lengths are refused', async () => {
  await db.query("insert into auth.users (id, email) values ($1, 'old@example.com')", [ids.legacy]);
  await db.query("insert into public.profiles (id, role, trial_started_at, trial_ends_at) values ($1, 'coach', now(), now() + interval '72 hours')", [ids.legacy]);
  await assert.rejects(() => db.query("update public.profiles set trial_ends_at = trial_started_at + interval '5 days' where id = $1", [ids.legacy]), /coach_trial_window/);
  await db.query("update public.profiles set trial_ends_at = trial_started_at + interval '14 days' where id = $1", [ids.legacy]);
});

test('every language announces the 14-day trial and none still says 3 days or 72 hours', () => {
  const keys = ['trial', 'billingDescription', 'pricingDescription', 'pricingFeature1'];
  const stale = /\b3\b|\b72\b|٣|ثلاث|Three|Drei|Trois|Tres/i;
  for (const locale of supportedLocales) {
    for (const key of keys) {
      const text = translations[locale][key];
      assert.ok(/14|١٤/.test(text), `${locale}.${key}: ${text}`);
      assert.doesNotMatch(text.replace(/39|٣٩/g, ''), stale, `${locale}.${key}: ${text}`);
    }
    assert.ok(/14|١٤/.test(translations[locale].signupDescription ?? '14'), `${locale}.signupDescription`);
  }
  for (const locale of Object.keys(publicPagesContent)) {
    const page = JSON.stringify(publicPagesContent[locale]);
    assert.doesNotMatch(page.replace(/39/g, ''), /72|3-day|3 أيام/, locale);
  }
});

test('the manual setup file and the migration agree on the 14-day trial', () => {
  const manual = readFileSync(new URL('../supabase/manual-setup.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../supabase/migrations/20261115003700_trial_14_days.sql', import.meta.url), 'utf8');
  assert.match(migration, /interval '336 hours'/);
  assert.ok(manual.includes('-- ===== 20261115003700_trial_14_days.sql ====='));
});