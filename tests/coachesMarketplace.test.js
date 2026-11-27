import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { marketplaceTranslations } from '../src/i18n/marketplaceTranslations.js';
import { buildPushMessage } from '../api/_lib/pushText.js';
import { ADMIN_PATHS, PAGES, navigationFor } from '../src/routes.js';
import { NOTIFICATION_ICONS, NOTIFICATION_TYPES, describeNotification, safeNotificationLink } from '../src/services/notificationUtils.js';
import {
  COUNTRY_CODES, HIDDEN_REASON_KEYS, REPORT_REASON_KEYS, REQUEST_STATUS_KEYS, TRAINING_MODE_KEYS, chatPathForCoach, coachPath, contactState, countryName, countryOptions, daysUntilReview,
  distributionBars, emptyFilters, emptyProfileForm, formatRating, hasActiveFilters, pageCount, parseList, profileToForm, searchArgs, starStates, validateModerationReason,
  validateProfileForm, validateReport, validateRequestMessage, validateReview,
} from '../src/services/marketplaceUtils.js';import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  amal: '00000000-0000-4000-8000-0000000000a1',
  ben: '00000000-0000-4000-8000-0000000000b1',
  cara: '00000000-0000-4000-8000-0000000000b2',
  dan: '00000000-0000-4000-8000-0000000000b3',
  owner: '00000000-0000-4000-8000-0000000000e1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  lina: '00000000-0000-4000-8000-0000000000c3',
};
let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;

const profileArgs = (over = {}) => ({
  p_is_listed: true,
  p_accepting_clients: true,
  p_headline: 'Strength and mobility coach',
  p_bio: 'I help busy people build strength with simple, sustainable training plans.',
  p_specialties: ['Strength', 'Mobility'],
  p_languages: ['en', 'ar'],
  p_certifications: ['NASM CPT'],
  p_years_experience: 6,
  p_city: 'Dubai',
  p_country_code: 'AE',
  p_training_mode: 'both',
  p_intro_video_url: 'https://youtu.be/dQw4w9WgXcQ',
  ...over,
});

async function publish(coachId, over = {}) {
  const result = await as(coachId).rpc('save_my_marketplace_profile', profileArgs(over));
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}

const search = async (userId, args = {}) => {
  const result = await as(userId).rpc('search_marketplace_coaches', args);
  assert.equal(result.error, null, result.error?.message);
  return result.data;
};
const link = (coach, client, age = '20 days', status = 'active') => db.query(
  `insert into public.coach_clients (coach_id, client_id, client_name, status, created_at) values ($1, $2, 'Linked', $3, now() - $4::interval)
   on conflict (coach_id, client_id) do update set created_at = excluded.created_at, status = excluded.status`,
  [coach, client, status, age],
);
const expireTrial = (coach) => db.query(
  `update public.profiles set trial_started_at = now() - interval '30 days', trial_ends_at = now() - interval '30 days' + interval '336 hours' where id = $1`,
  [coach],
);
const names = (result) => result.items.map((item) => item.display_name);

before(async () => { db = await createTestDatabase(); });

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.amal, email: 'amal-secret@example.com', role: 'coach', fullName: 'Amal Hassan', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.ben, email: 'ben-secret@example.com', role: 'coach', fullName: 'Ben Carter' });
  await addUser(db, { id: ids.cara, email: 'cara-secret@example.com', role: 'coach', fullName: 'Cara Diaz' });
  await addUser(db, { id: ids.dan, email: 'dan-secret@example.com', role: 'coach', fullName: 'Dan Roe' });
  await addUser(db, { id: ids.owner, email: 'owner@example.com', role: 'coach', fullName: 'Owner' });
  await addUser(db, { id: ids.sara, email: 'sara-secret@example.com', role: 'client', fullName: 'Sara Ali' });
  await addUser(db, { id: ids.omar, email: 'omar-secret@example.com', role: 'client', fullName: 'Omar Khan' });
  await addUser(db, { id: ids.lina, email: 'lina-secret@example.com', role: 'client', fullName: 'Lina Noor' });
  await db.query('insert into public.platform_admins (user_id) values ($1)', [ids.owner]);
});

// ------------------------------------------------------------------------------------------ the public profile and who is listed

test('a profile is private until the coach lists it, and listing needs a complete profile', async () => {
  await publish(ids.amal, { p_is_listed: false });
  assert.equal((await search(ids.sara)).total, 0);
  assert.equal((await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data, null);

  const incomplete = await as(ids.amal).rpc('save_my_marketplace_profile', profileArgs({ p_bio: 'Too short', p_specialties: ['Strength'] }));
  assert.match(incomplete.error.message, /Complete your profile/);
  assert.match((await as(ids.amal).rpc('save_my_marketplace_profile', profileArgs({ p_country_code: null }))).error.message, /Complete your profile/);

  const mine = await publish(ids.amal);
  assert.equal(mine.is_listed, true);
  assert.equal(mine.visible, true);
  assert.deepEqual(mine.hidden_reasons, []);
  const found = await search(ids.sara);
  assert.deepEqual(names(found), ['Amal Strength']);
  assert.equal((await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data.headline, 'Strength and mobility coach');
});

test('the profile is hidden by itself when the coach trial ends and shown again with a subscription', async () => {
  await publish(ids.amal);
  assert.equal((await search(ids.sara)).total, 1);

  await expireTrial(ids.amal);
  assert.equal((await search(ids.sara)).total, 0);
  assert.equal((await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data, null);
  assert.equal((await as(ids.sara).rpc('list_coach_reviews', { p_coach_id: ids.amal })).data.total, 0);

  await db.query(`insert into public.coach_subscriptions (user_id, status, provider, current_period_end) values ($1, 'active', 'paddle', now() + interval '20 days')`, [ids.amal]);
  assert.equal((await search(ids.sara)).total, 1);

  await db.query(`update public.coach_subscriptions set status = 'canceled' where user_id = $1`, [ids.amal]);
  assert.equal((await search(ids.sara)).total, 0);

  await db.query(`update public.coach_subscriptions set status = 'active', current_period_end = now() - interval '10 days' where user_id = $1`, [ids.amal]);
  assert.equal((await search(ids.sara)).total, 0, 'a subscription that ended more than 3 days ago does not list the coach');
  const own = await as(ids.amal).rpc('get_my_marketplace_profile');
  assert.equal(own.data.visible, false);
  assert.ok(own.data.hidden_reasons.includes('subscription_inactive'));
});

test('turning the listing off, and being an assistant trainer, also hide the profile', async () => {
  await publish(ids.amal);
  await publish(ids.amal, { p_is_listed: false });
  assert.equal((await search(ids.sara)).total, 0);
  assert.deepEqual((await as(ids.amal).rpc('get_my_marketplace_profile')).data.hidden_reasons, ['not_listed']);

  await publish(ids.ben);
  await db.query(
    `insert into public.coach_team_members (head_coach_id, trainer_user_id, invite_email, status) values ($1, $2, 'ben-secret@example.com', 'active')`,
    [ids.amal, ids.ben],
  );
  assert.equal((await search(ids.sara)).total, 0);
  assert.match((await as(ids.ben).rpc('save_my_marketplace_profile', profileArgs())).error.message, /active coach account|Assistant trainers/);
});

test('only a coach can edit a profile and every field is validated', async () => {
  assert.match((await as(ids.sara).rpc('save_my_marketplace_profile', profileArgs())).error.message, /coach account/);
  assert.match((await as(ids.sara).rpc('get_my_marketplace_profile')).error.message, /coach account/);
  const bad = async (over, pattern) => assert.match((await as(ids.amal).rpc('save_my_marketplace_profile', profileArgs(over))).error?.message || 'accepted', pattern);
  await bad({ p_headline: 'x'.repeat(121) }, /headline/);
  await bad({ p_training_mode: 'telepathy' }, /online, in person or both/);
  await bad({ p_years_experience: 70 }, /Years of experience/);
  await bad({ p_country_code: 'UAE' }, /valid country/);
  await bad({ p_intro_video_url: 'http://youtu.be/dQw4w9WgXcQ' }, /intro video/);
  await bad({ p_intro_video_url: 'https://evil.example.com/watch?v=1' }, /intro video/);
  await bad({ p_intro_video_url: 'https://user:pw@youtu.be/dQw4w9WgXcQ' }, /intro video/);
  await bad({ p_specialties: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] }, /up to 10/);
  await bad({ p_languages: ['english'] }, /up to 2 characters/);
  await bad({ p_certifications: ['y'.repeat(81)] }, /up to 80 characters/);

  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://vimeo.com/123456789', 'https://cdn.example.com/intro.mp4']) {
    assert.equal((await as(ids.amal).rpc('save_my_marketplace_profile', profileArgs({ p_intro_video_url: url }))).error, null, url);
  }
  const clean = await publish(ids.amal, { p_specialties: ['  Strength ', 'strength', 'Mobility', ''], p_languages: ['EN', 'en', 'ar'], p_city: '  New   York ', p_country_code: 'us' });
  assert.deepEqual(clean.specialties, ['Strength', 'Mobility']);
  assert.deepEqual(clean.languages, ['en', 'ar']);
  assert.equal(clean.city, 'New York');
  assert.equal(clean.country_code, 'US');
});

// ------------------------------------------------------------------------------------------ privacy

test('search and detail results contain only public columns: no e-mail, phone or client data', async () => {
  await publish(ids.amal);
  await link(ids.amal, ids.omar);
  await db.query(`insert into public.coach_reviews (coach_id, client_id, rating, comment) values ($1, $2, 5, 'Great coach')`, [ids.amal, ids.omar]);

  const result = await search(ids.sara);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    'accepting_clients', 'avatar_path', 'city', 'coach_id', 'country_code', 'display_name', 'has_intro_video', 'headline', 'languages',
    'rating_avg', 'rating_count', 'specialties', 'summary', 'training_mode', 'years_experience',
  ]);
  const detail = (await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data;
  assert.deepEqual(Object.keys(detail).sort(), [
    'accepting_clients', 'avatar_path', 'bio', 'certifications', 'city', 'coach_id', 'country_code', 'display_name', 'distribution', 'headline',
    'intro_video_url', 'is_self', 'languages', 'rating_avg', 'rating_count', 'specialties', 'training_mode', 'viewer', 'years_experience',
  ]);
  const reviews = (await as(ids.sara).rpc('list_coach_reviews', { p_coach_id: ids.amal })).data;
  const everything = JSON.stringify([result, detail, reviews]);
  assert.doesNotMatch(everything, /secret|@example\.com|phone|Omar Khan/i);
  assert.equal(reviews.items[0].reviewer_name, 'Omar K.');
  assert.equal(Object.hasOwn(reviews.items[0], 'client_id'), false);
});

test('the marketplace tables cannot be read or written directly, and anonymous visitors cannot call anything', async () => {
  await publish(ids.amal);
  const sara = as(ids.sara);
  for (const table of ['coach_marketplace_profiles', 'coach_reviews', 'marketplace_reports', 'coach_contact_requests', 'marketplace_moderation_log', 'platform_admins']) {
    assert.match((await sara.sql(`select * from public.${table}`)).error.message, /permission denied/, table);
    assert.match((await as(ids.amal).sql(`select * from public.${table}`)).error.message, /permission denied/, `coach ${table}`);
  }
  assert.match((await as(ids.amal).sql('update public.coach_marketplace_profiles set is_hidden = false')).error.message, /permission denied/);
  assert.match((await as(ids.sara).sql('insert into public.platform_admins (user_id) values ($1)', [ids.sara])).error.message, /permission denied/);

  await db.exec('set role anon');
  try {
    await assert.rejects(() => db.query('select public.search_marketplace_coaches()'), /permission denied/);
    await assert.rejects(() => db.query('select public.get_marketplace_coach($1)', [ids.amal]), /permission denied/);
    await assert.rejects(() => db.query('select public.admin_list_marketplace_reports()'), /permission denied/);
  } finally {
    await db.exec('reset role');
  }
  for (const helper of ['marketplace_coach_visible', 'marketplace_require_admin', 'marketplace_display_name']) {
    const call = helper === 'marketplace_require_admin' ? `public.${helper}()` : `public.${helper}('${ids.amal}')`;
    assert.match((await sara.sql(`select ${call}`)).error.message, /permission denied/, helper);
  }
});

// ------------------------------------------------------------------------------------------ search

test('search filters by text, specialty, language, place, training mode, rating and availability', async () => {
  await publish(ids.amal);
  await publish(ids.ben, { p_headline: 'Yoga and breathwork teacher', p_specialties: ['Yoga', 'Breathwork'], p_languages: ['en', 'fr'], p_city: 'Paris', p_country_code: 'FR', p_training_mode: 'in_person', p_years_experience: 3 });
  await publish(ids.cara, { p_headline: 'Online nutrition and weight loss', p_specialties: ['Nutrition'], p_languages: ['es'], p_city: 'Madrid', p_country_code: 'ES', p_training_mode: 'online', p_accepting_clients: false });
  await publish(ids.dan, { p_is_listed: false });

  assert.equal((await search(ids.sara)).total, 3);
  assert.deepEqual(names(await search(ids.sara, { p_query: 'yoga' })), ['Ben Carter']);
  assert.deepEqual(names(await search(ids.sara, { p_query: 'AMAL' })), ['Amal Strength']);
  assert.deepEqual(names(await search(ids.sara, { p_specialty: 'nutrition' })), ['Cara Diaz']);
  assert.deepEqual(names(await search(ids.sara, { p_language: 'fr' })), ['Ben Carter']);
  assert.deepEqual(names(await search(ids.sara, { p_country: 'es' })), ['Cara Diaz']);
  assert.deepEqual(names(await search(ids.sara, { p_city: 'pari' })), ['Ben Carter']);
  assert.deepEqual(names(await search(ids.sara, { p_mode: 'online' })).sort(), ['Amal Strength', 'Cara Diaz']);
  assert.deepEqual(names(await search(ids.sara, { p_mode: 'in_person' })).sort(), ['Amal Strength', 'Ben Carter']);
  assert.deepEqual(names(await search(ids.sara, { p_accepting_only: true })).sort(), ['Amal Strength', 'Ben Carter']);
  assert.equal((await search(ids.sara, { p_query: '%' })).total, 0, 'a percent sign is plain text, not a wildcard');
  assert.match((await as(ids.sara).rpc('search_marketplace_coaches', { p_mode: 'both' })).error.message, /Unsupported training mode/);

  await link(ids.amal, ids.omar);
  await link(ids.ben, ids.omar);
  await as(ids.omar).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 5, p_comment: 'Excellent' });
  await as(ids.omar).rpc('submit_coach_review', { p_coach_id: ids.ben, p_rating: 3, p_comment: 'Fine' });
  assert.deepEqual(names(await search(ids.sara, { p_min_rating: 4 })), ['Amal Strength']);
  assert.deepEqual(names(await search(ids.sara)), ['Amal Strength', 'Ben Carter', 'Cara Diaz'], 'best rated and available coaches first');

  const page = await search(ids.sara, { p_limit: 1, p_offset: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(names(page), ['Ben Carter']);
});

// ------------------------------------------------------------------------------------------ reviews

test('a client can review only after 14 days with the coach, once, and may edit it', async () => {
  await publish(ids.amal);
  const review = (client, rating = 5, comment = 'Great') => as(client).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: rating, p_comment: comment });

  assert.match((await review(ids.sara)).error.message, /at least 14 days/, 'never linked');
  await link(ids.amal, ids.sara, '13 days');
  assert.match((await review(ids.sara)).error.message, /after 14 days/);
  let detail = (await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data;
  assert.equal(detail.viewer.can_review, false);
  assert.ok(detail.viewer.review_eligible_at);

  await link(ids.amal, ids.sara, '15 days');
  detail = (await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data;
  assert.equal(detail.viewer.can_review, true);
  const first = await review(ids.sara, 4, 'Good plans');
  assert.equal(first.error, null);
  const second = await review(ids.sara, 5, 'Even better after a month');
  assert.equal(second.data, first.data, 'the same review is edited');
  assert.equal((await rows('select count(*)::int as n from public.coach_reviews'))[0].n, 1);
  assert.deepEqual((await rows('select rating, comment from public.coach_reviews'))[0], { rating: 5, comment: 'Even better after a month' });

  assert.match((await review(ids.sara, 6)).error.message, /1 to 5/);
  assert.match((await review(ids.sara, 0)).error.message, /1 to 5/);
  assert.match((await review(ids.sara, 5, 'x'.repeat(1001))).error.message, /1000/);
  assert.match((await as(ids.ben).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 5, p_comment: '' })).error.message, /client account/);

  await link(ids.amal, ids.omar, '40 days', 'archived');
  assert.equal((await review(ids.omar, 3, 'It was fine')).error, null, 'a client who used to train with the coach can review');
  const totals = (await as(ids.lina).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data;
  assert.equal(totals.rating_count, 2);
  assert.equal(Number(totals.rating_avg), 4);
  assert.deepEqual(totals.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 });
});

test('the coach adds one public reply and can never delete or change a review', async () => {
  await publish(ids.amal);
  await link(ids.amal, ids.sara);
  await as(ids.sara).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 2, p_comment: 'Slow replies' });
  const [{ id: reviewId }] = await rows('select id from public.coach_reviews');

  assert.match((await as(ids.ben).rpc('reply_to_coach_review', { p_review_id: reviewId, p_reply: 'Not mine' })).error.message, /Review was not found/);
  assert.match((await as(ids.sara).rpc('reply_to_coach_review', { p_review_id: reviewId, p_reply: 'Self reply' })).error.message, /coach account/);
  assert.match((await as(ids.amal).rpc('reply_to_coach_review', { p_review_id: reviewId, p_reply: '   ' })).error.message, /1 to 1000/);
  assert.equal((await as(ids.amal).rpc('reply_to_coach_review', { p_review_id: reviewId, p_reply: 'Thanks, I will answer faster.' })).error, null);
  assert.match((await as(ids.amal).rpc('reply_to_coach_review', { p_review_id: reviewId, p_reply: 'A second reply' })).error.message, /already replied/);

  const listed = (await as(ids.omar).rpc('list_coach_reviews', { p_coach_id: ids.amal })).data;
  assert.equal(listed.items[0].coach_reply, 'Thanks, I will answer faster.');

  assert.match((await as(ids.amal).sql('delete from public.coach_reviews where id = $1', [reviewId])).error.message, /permission denied/);
  assert.match((await as(ids.amal).sql('update public.coach_reviews set rating = 5 where id = $1', [reviewId])).error.message, /permission denied/);
  assert.match((await as(ids.sara).sql('delete from public.coach_reviews where id = $1', [reviewId])).error.message, /permission denied/);
  for (const name of ['delete_coach_review', 'delete_review']) assert.ok((await as(ids.amal).rpc(name, { p_review_id: reviewId })).error, name);
  assert.equal((await rows('select count(*)::int as n from public.coach_reviews'))[0].n, 1);

  await as(ids.sara).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 4, p_comment: 'Much better now' });
  assert.equal((await rows('select coach_reply from public.coach_reviews'))[0].coach_reply, 'Thanks, I will answer faster.', 'editing the review keeps the reply');
});

// ------------------------------------------------------------------------------------------ reports

test('a person can report a coach or a review once, and not themselves', async () => {
  await publish(ids.amal);
  await link(ids.amal, ids.sara);
  await as(ids.sara).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 1, p_comment: 'Rude review' });
  const [{ id: reviewId }] = await rows('select id from public.coach_reviews');
  const report = (user, type, target, reason = 'spam', details = '') => as(user).rpc('report_marketplace', { p_target_type: type, p_target_id: target, p_reason: reason, p_details: details });

  assert.equal((await report(ids.omar, 'coach', ids.amal, 'misleading', 'Claims I could not verify')).error, null);
  assert.match((await report(ids.omar, 'coach', ids.amal, 'spam')).error.message, /already reported/);
  assert.equal((await report(ids.lina, 'coach', ids.amal)).error, null, 'another person may report the same coach');
  assert.match((await report(ids.amal, 'coach', ids.amal)).error.message, /yourself/);
  assert.match((await report(ids.omar, 'coach', ids.amal, 'bogus')).error.message, /reason/);
  assert.match((await report(ids.omar, 'coach', ids.amal, 'other', 'x'.repeat(501))).error.message, /500/);
  assert.match((await report(ids.omar, 'coach', ids.ben)).error.message, /Coach was not found/, 'an unlisted coach cannot be reported');
  assert.match((await report(ids.omar, 'thing', ids.amal)).error.message, /Unsupported/);

  assert.equal((await report(ids.amal, 'review', reviewId, 'harassment')).error, null, 'the coach may report a review about them');
  assert.match((await report(ids.amal, 'review', reviewId, 'harassment')).error.message, /already reported/);
  assert.match((await report(ids.sara, 'review', reviewId)).error.message, /your own review/);
  assert.match((await report(ids.omar, 'review', '00000000-0000-4000-8000-000000000999')).error.message, /Review was not found/);

  const detail = (await as(ids.omar).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data;
  assert.equal(detail.viewer.reported_coach, true);
  assert.equal((await as(ids.omar).rpc('list_coach_reviews', { p_coach_id: ids.amal })).data.items[0].reported_by_me, false);
  assert.equal((await rows('select count(*)::int as n from public.marketplace_reports'))[0].n, 3);
});

// ------------------------------------------------------------------------------------------ contact requests

test('a client may send 3 requests a day and one open request per coach', async () => {
  for (const coach of [ids.amal, ids.ben, ids.cara, ids.dan]) await publish(coach);
  await publish(ids.dan, { p_accepting_clients: false });
  const request = (coach, message = 'Hi, I would like to train with you.', client = ids.sara) => as(client).rpc('send_contact_request', { p_coach_id: coach, p_message: message });

  const first = await request(ids.amal);
  assert.equal(first.error, null);
  assert.equal(first.data.requests_left, 2);
  assert.match((await request(ids.amal)).error.message, /open request/);
  assert.match((await request(ids.dan)).error.message, /not accepting/);
  assert.match((await request(ids.ben, '   ')).error.message, /message/);
  assert.match((await request(ids.ben, 'x'.repeat(501))).error.message, /message/);
  assert.match((await request(ids.owner)).error.message, /not available/, 'a coach without a listing cannot be contacted');
  assert.match((await as(ids.amal).rpc('send_contact_request', { p_coach_id: ids.ben, p_message: 'Coach to coach' })).error.message, /client account/);

  assert.equal((await request(ids.ben)).error, null);
  assert.equal((await request(ids.cara)).error, null);
  await publish(ids.owner);
  assert.match((await request(ids.owner)).error.message, /up to 3 contact requests/);
  assert.equal((await request(ids.ben, 'Hello', ids.omar)).error, null, 'the limit is per client');

  await db.query(`update public.coach_contact_requests set created_at = now() - interval '25 hours' where client_id = $1`, [ids.sara]);
  assert.equal((await request(ids.owner)).error, null, 'the day window moves on');
  assert.equal((await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.cara })).data.viewer.requests_left, 2);
});

test('a coach sees incoming requests without the client e-mail and answers them', async () => {
  await publish(ids.amal);
  await as(ids.sara).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'I want to lose 8 kg for the summer.' });

  const inbox = (await as(ids.amal).rpc('list_coach_contact_requests')).data;
  assert.equal(inbox.pending_count, 1);
  assert.equal(inbox.items[0].client_name, 'Sara Ali');
  assert.equal(inbox.items[0].client_id, null, 'the client id stays hidden until the coach accepts');
  assert.doesNotMatch(JSON.stringify(inbox), /secret|@example\.com/);
  assert.equal((await rows(`select count(*)::int as n from public.notifications where user_id = $1 and type = 'marketplace_request'`, [ids.amal]))[0].n, 1);

  const [{ id: requestId }] = await rows('select id from public.coach_contact_requests');
  assert.match((await as(ids.ben).rpc('respond_contact_request', { p_request_id: requestId, p_accept: true })).error.message, /Request was not found/);
  assert.match((await as(ids.sara).rpc('respond_contact_request', { p_request_id: requestId, p_accept: true })).error.message, /coach account/);
  assert.equal((await rows('select count(*)::int as n from public.coach_clients'))[0].n, 0);
});

test('accepting links the client, opens the chat and tells both people', async () => {
  await publish(ids.amal);
  await link(ids.ben, ids.sara, '3 days');
  await as(ids.sara).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'Can we start next week?' });
  const [{ id: requestId }] = await rows('select id from public.coach_contact_requests');

  assert.equal((await as(ids.amal).rpc('send_chat_message', { p_receiver_id: ids.sara, p_text: 'Hello' })).error?.message, 'You can only message your own coach or your active clients');
  assert.equal((await as(ids.sara).rpc('marketplace_push_target', { p_request_id: requestId, p_event: 'request' })).data, ids.amal);
  assert.equal((await as(ids.amal).rpc('marketplace_push_target', { p_request_id: requestId, p_event: 'request' })).data, null);
  assert.equal((await as(ids.sara).rpc('marketplace_push_target', { p_request_id: requestId, p_event: 'accepted' })).data, null);

  const accepted = await as(ids.amal).rpc('respond_contact_request', { p_request_id: requestId, p_accept: true });
  assert.equal(accepted.error, null, accepted.error?.message);
  assert.deepEqual(accepted.data, {
    request_id: requestId, status: 'accepted', client_id: ids.sara, already_linked: false, other_active_coaches: 1, chat_path: `/messages?with=${ids.sara}`,
  });

  const [linkRow] = await rows('select client_name, client_email, coach_name, status from public.coach_clients where coach_id = $1 and client_id = $2', [ids.amal, ids.sara]);
  assert.deepEqual(linkRow, { client_name: 'Sara Ali', client_email: 'sara-secret@example.com', coach_name: 'Amal Strength', status: 'active' });
  assert.equal((await as(ids.amal).rpc('send_chat_message', { p_receiver_id: ids.sara, p_text: 'Welcome aboard' })).error, null);
  assert.equal((await as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.amal, p_text: 'Thank you' })).error, null);

  const notes = await rows(`select user_id, type, link from public.notifications where type in ('marketplace_accepted', 'marketplace_linked') order by type`);
  assert.deepEqual(notes, [
    { user_id: ids.sara, type: 'marketplace_accepted', link: '/coach-hub' },
    { user_id: ids.amal, type: 'marketplace_linked', link: `/messages?with=${ids.sara}` },
  ]);
  assert.equal((await as(ids.amal).rpc('marketplace_push_target', { p_request_id: requestId, p_event: 'accepted' })).data, ids.sara);
  assert.equal((await as(ids.sara).rpc('list_my_contact_requests')).data[0].status, 'accepted');
  assert.equal((await as(ids.amal).rpc('list_coach_contact_requests')).data.items[0].client_id, ids.sara);
  assert.match((await as(ids.amal).rpc('respond_contact_request', { p_request_id: requestId, p_accept: false })).error.message, /already answered/);
  assert.match((await as(ids.sara).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'Again?' })).error.message, /already train/);
});

test('declining, cancelling and re-linking an archived client behave', async () => {
  await publish(ids.amal);
  const send = (client = ids.sara) => as(client).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'Hello coach' });

  await send();
  let [{ id: requestId }] = await rows('select id from public.coach_contact_requests');
  assert.equal((await as(ids.amal).rpc('respond_contact_request', { p_request_id: requestId, p_accept: false })).data.status, 'declined');
  assert.equal((await rows('select count(*)::int as n from public.coach_clients'))[0].n, 0);
  assert.equal((await rows(`select count(*)::int as n from public.notifications where user_id = $1 and type = 'marketplace_declined'`, [ids.sara]))[0].n, 1);
  assert.equal((await send()).error, null, 'a declined request can be sent again');

  [{ id: requestId }] = await rows(`select id from public.coach_contact_requests where status = 'pending'`);
  assert.match((await as(ids.omar).rpc('cancel_contact_request', { p_request_id: requestId })).error.message, /Request was not found/);
  assert.equal((await as(ids.sara).rpc('cancel_contact_request', { p_request_id: requestId })).error, null);
  assert.match((await as(ids.amal).rpc('respond_contact_request', { p_request_id: requestId, p_accept: true })).error.message, /already answered/);

  await link(ids.amal, ids.lina, '60 days', 'archived');
  await send(ids.lina);
  [{ id: requestId }] = await rows(`select id from public.coach_contact_requests where status = 'pending'`);
  const accepted = await as(ids.amal).rpc('respond_contact_request', { p_request_id: requestId, p_accept: true });
  assert.equal(accepted.data.already_linked, false);
  assert.equal((await rows('select status from public.coach_clients where client_id = $1', [ids.lina]))[0].status, 'active');
  assert.equal((await rows('select count(*)::int as n from public.coach_clients where client_id = $1', [ids.lina]))[0].n, 1);
});

test('requests stop working once the coach is no longer listed, and accepting needs an active coach', async () => {
  await publish(ids.amal);
  await as(ids.sara).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'Hi' });
  const [{ id: requestId }] = await rows('select id from public.coach_contact_requests');
  await expireTrial(ids.amal);
  assert.match((await as(ids.omar).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'Hi' })).error.message, /not available/);
  assert.match((await as(ids.amal).rpc('respond_contact_request', { p_request_id: requestId, p_accept: true })).error.message, /active coach account/);
  assert.match((await as(ids.amal).rpc('list_coach_contact_requests')).error.message, /active coach account/);
});

// ------------------------------------------------------------------------------------------ owner moderation

test('only the platform owner can use the moderation functions', async () => {
  await publish(ids.amal);
  assert.equal((await as(ids.owner).rpc('is_platform_admin')).data, true);
  assert.equal((await as(ids.amal).rpc('is_platform_admin')).data, false);
  assert.equal((await as(ids.sara).rpc('is_platform_admin')).data, false);

  const attempts = [
    ['admin_list_marketplace_reports', {}],
    ['admin_list_marketplace_coaches', {}],
    ['admin_list_coach_reviews', { p_coach_id: ids.amal }],
    ['admin_set_coach_hidden', { p_coach_id: ids.amal, p_hidden: true, p_reason: 'Not allowed' }],
    ['admin_set_review_hidden', { p_review_id: '00000000-0000-4000-8000-000000000999', p_hidden: true, p_reason: 'Not allowed' }],
    ['admin_resolve_marketplace_report', { p_report_id: '00000000-0000-4000-8000-000000000999', p_status: 'resolved', p_note: 'Not allowed' }],
  ];
  for (const user of [ids.amal, ids.sara]) {
    for (const [name, args] of attempts) assert.match((await as(user).rpc(name, args)).error.message, /Platform owner access/, `${user} ${name}`);
  }
  assert.equal((await search(ids.sara)).total, 1, 'nothing was hidden');
  assert.equal((await as(ids.owner).rpc('admin_list_marketplace_coaches')).data.total, 1);
});

test('the owner hides a coach with a reason, which closes the reports, and can bring the profile back', async () => {
  await publish(ids.amal);
  await as(ids.sara).rpc('report_marketplace', { p_target_type: 'coach', p_target_id: ids.amal, p_reason: 'misleading', p_details: 'Fake certificates' });
  await as(ids.omar).rpc('report_marketplace', { p_target_type: 'coach', p_target_id: ids.amal, p_reason: 'fake' });
  const owner = as(ids.owner);

  const queue = (await owner.rpc('admin_list_marketplace_reports')).data;
  assert.equal(queue.open_count, 2);
  assert.equal(queue.items[0].coach_name, 'Amal Strength');
  assert.equal(queue.items[0].reporter_name, 'Sara Ali');
  const reportId = queue.items[0].id;

  assert.match((await owner.rpc('admin_set_coach_hidden', { p_coach_id: ids.amal, p_hidden: true, p_reason: ' ' })).error.message, /reason/);
  assert.match((await owner.rpc('admin_set_coach_hidden', { p_coach_id: ids.ben, p_hidden: true, p_reason: 'No profile' })).error.message, /was not found/);
  const hidden = await owner.rpc('admin_set_coach_hidden', { p_coach_id: ids.amal, p_hidden: true, p_reason: 'Certificates could not be verified', p_report_id: reportId });
  assert.deepEqual(hidden.data, { coach_id: ids.amal, is_hidden: true, reports_closed: 2 });

  assert.equal((await search(ids.sara)).total, 0);
  assert.equal((await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data, null);
  assert.equal((await as(ids.sara).rpc('send_contact_request', { p_coach_id: ids.amal, p_message: 'Hi' })).error.message, 'This coach is not available');
  const own = (await as(ids.amal).rpc('get_my_marketplace_profile')).data;
  assert.equal(own.is_hidden, true);
  assert.equal(own.hidden_reason, 'Certificates could not be verified');
  assert.ok(own.hidden_reasons.includes('hidden_by_moderation'));

  await publish(ids.amal, { p_headline: 'Updated headline for review' });
  assert.equal((await search(ids.sara)).total, 0, 'saving the profile does not lift the owner\'s decision');
  assert.equal((await owner.rpc('admin_list_marketplace_reports')).data.open_count, 0);
  assert.equal((await owner.rpc('admin_list_marketplace_reports', { p_status: 'resolved' })).data.items[0].resolution_note, 'Certificates could not be verified');
  assert.equal((await owner.rpc('admin_list_marketplace_coaches', { p_state: 'hidden' })).data.items[0].hidden_reason, 'Certificates could not be verified');

  assert.equal((await owner.rpc('admin_set_coach_hidden', { p_coach_id: ids.amal, p_hidden: false, p_reason: 'Verified later' })).error, null);
  assert.equal((await search(ids.sara)).total, 1);
  assert.deepEqual((await rows('select action from public.marketplace_moderation_log order by created_at, action')).map((row) => row.action).sort(), ['hide_coach', 'unhide_coach']);
});

test('the owner hides an abusive review and dismisses or resolves reports', async () => {
  await publish(ids.amal);
  await link(ids.amal, ids.sara);
  await link(ids.amal, ids.omar);
  await as(ids.sara).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 1, p_comment: 'Abusive words' });
  await as(ids.omar).rpc('submit_coach_review', { p_coach_id: ids.amal, p_rating: 5, p_comment: 'Wonderful' });
  const [{ id: abusiveId }] = await rows(`select id from public.coach_reviews where client_id = $1`, [ids.sara]);
  await as(ids.amal).rpc('report_marketplace', { p_target_type: 'review', p_target_id: abusiveId, p_reason: 'harassment' });
  await as(ids.lina).rpc('report_marketplace', { p_target_type: 'coach', p_target_id: ids.amal, p_reason: 'spam' });
  const owner = as(ids.owner);
  const queue = (await owner.rpc('admin_list_marketplace_reports')).data;
  const reviewReport = queue.items.find((item) => item.target_type === 'review');
  const coachReport = queue.items.find((item) => item.target_type === 'coach');
  assert.equal(reviewReport.review_comment, 'Abusive words');

  assert.match((await owner.rpc('admin_set_review_hidden', { p_review_id: abusiveId, p_hidden: true, p_reason: 'Abuse', p_report_id: coachReport.id })).error.message, /not about this review/);
  const done = await owner.rpc('admin_set_review_hidden', { p_review_id: abusiveId, p_hidden: true, p_reason: 'Abusive language', p_report_id: reviewReport.id });
  assert.deepEqual(done.data, { review_id: abusiveId, is_hidden: true, reports_closed: 1 });

  const reviews = (await as(ids.lina).rpc('list_coach_reviews', { p_coach_id: ids.amal })).data;
  assert.deepEqual(reviews.items.map((item) => item.comment), ['Wonderful']);
  assert.equal(Number(reviews.rating_avg), 5, 'a hidden review no longer counts');
  assert.equal((await owner.rpc('admin_list_coach_reviews', { p_coach_id: ids.amal })).data.length, 2);
  assert.equal((await as(ids.sara).rpc('get_marketplace_coach', { p_coach_id: ids.amal })).data.viewer.my_review.is_hidden, true);
  assert.match((await as(ids.omar).rpc('report_marketplace', { p_target_type: 'review', p_target_id: abusiveId, p_reason: 'spam' })).error.message, /Review was not found/);

  assert.match((await owner.rpc('admin_resolve_marketplace_report', { p_report_id: coachReport.id, p_status: 'dismissed', p_note: '' })).error.message, /note/);
  assert.match((await owner.rpc('admin_resolve_marketplace_report', { p_report_id: coachReport.id, p_status: 'banned', p_note: 'Nope' })).error.message, /resolved or dismissed/);
  assert.equal((await owner.rpc('admin_resolve_marketplace_report', { p_report_id: coachReport.id, p_status: 'dismissed', p_note: 'Nothing wrong found' })).error, null);
  assert.match((await owner.rpc('admin_resolve_marketplace_report', { p_report_id: coachReport.id, p_status: 'resolved', p_note: 'Again' })).error.message, /Open report was not found/);
  assert.equal((await owner.rpc('admin_list_marketplace_reports', { p_status: 'all' })).data.total, 2);
  assert.equal((await owner.rpc('admin_list_marketplace_reports', { p_status: 'dismissed' })).data.items[0].resolution_note, 'Nothing wrong found');
});

// ------------------------------------------------------------------------------------------ the app: pure helpers, screens, texts

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const NEW_FILES = [
  'src/pages/MarketplaceProfilePage.jsx', 'src/pages/CoachesPage.jsx', 'src/pages/CoachDetailPage.jsx', 'src/pages/AdminMarketplacePage.jsx',
  'src/components/CoachCard.jsx', 'src/components/RatingStars.jsx', 'src/components/MarketplaceReport.jsx', 'src/components/MarketplaceVideo.jsx',
  'src/services/marketplaceUtils.js', 'src/services/marketplaceService.js',
];

test('a profile form is checked before it is sent, and listing asks for more than saving', () => {
  const full = {
    ...emptyProfileForm(), isListed: true, headline: 'Strength coach for busy people', bio: 'I help busy people build strength with simple plans.',
    specialties: 'Strength, mobility, strength', languages: ['en', 'AR'], countryCode: 'ae', yearsExperience: '6', city: ' Dubai ', trainingMode: 'both', introVideoUrl: 'https://youtu.be/dQw4w9WgXcQ',
  };
  const ok = validateProfileForm(full);
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.payload.specialties, ['Strength', 'mobility']);
  assert.deepEqual(ok.payload.languages, ['en', 'ar']);
  assert.equal(ok.payload.countryCode, 'AE');
  assert.equal(ok.payload.yearsExperience, 6);
  assert.equal(ok.payload.city, 'Dubai');

  const listedEmpty = validateProfileForm({ ...emptyProfileForm(), isListed: true });
  assert.deepEqual(Object.keys(listedEmpty.errors).sort(), ['bio', 'countryCode', 'headline', 'languages', 'specialties']);
  assert.equal(validateProfileForm(emptyProfileForm()).valid, true, 'a private draft may be incomplete');
  assert.equal(validateProfileForm({ ...full, introVideoUrl: 'http://youtu.be/dQw4w9WgXcQ' }).errors.introVideoUrl, 'mkErrVideoInvalid');
  assert.equal(validateProfileForm({ ...full, introVideoUrl: 'https://example.com/video' }).errors.introVideoUrl, 'mkErrVideoUnsupported');
  assert.equal(validateProfileForm({ ...full, yearsExperience: '61' }).errors.yearsExperience, 'mkErrYears');
  assert.equal(validateProfileForm({ ...full, countryCode: 'ZZ' }).errors.countryCode, 'mkErrCountry');
  assert.equal(validateProfileForm({ ...full, specialties: Array.from({ length: 11 }, (_, n) => `S${n}`).join(',') }).errors.specialties, 'mkErrSpecialties');
  assert.deepEqual(profileToForm(null), emptyProfileForm());
  assert.equal(profileToForm({ is_listed: true, specialties: ['A', 'B'], years_experience: 0 }).specialties, 'A, B');
  assert.deepEqual(parseList('One\nTwo, two ; Three،Four', {}), ['One', 'Two', 'Three', 'Four']);
});

test('search filters become RPC arguments, with empty ones left out', () => {
  assert.deepEqual(searchArgs(emptyFilters()), {
    p_query: null, p_specialty: null, p_language: null, p_country: null, p_city: null, p_mode: null, p_min_rating: null, p_accepting_only: false, p_limit: 12, p_offset: 0,
  });
  const args = searchArgs({ ...emptyFilters(), query: ' yoga ', mode: 'in_person', minRating: '4', acceptingOnly: true, country: 'FR' }, 2);
  assert.equal(args.p_query, 'yoga');
  assert.equal(args.p_mode, 'in_person');
  assert.equal(args.p_min_rating, 4);
  assert.equal(args.p_offset, 24);
  assert.equal(searchArgs({ ...emptyFilters(), mode: 'both' }).p_mode, null);
  assert.equal(hasActiveFilters(emptyFilters()), false);
  assert.equal(hasActiveFilters({ ...emptyFilters(), acceptingOnly: true }), true);
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(25), 3);
});

test('stars, distribution bars, review waiting time, contact state and links', () => {
  assert.deepEqual(starStates(4.5), ['full', 'full', 'full', 'full', 'half']);
  assert.deepEqual(starStates(0), ['empty', 'empty', 'empty', 'empty', 'empty']);
  assert.deepEqual(starStates(9), ['full', 'full', 'full', 'full', 'full']);
  assert.equal(formatRating(4.25), '4.3');
  assert.equal(formatRating(0), '-');
  assert.deepEqual(distributionBars({ 5: 3, 1: 1 }, 4).map((bar) => bar.percent), [75, 0, 0, 0, 25]);
  assert.equal(daysUntilReview('2026-11-30T00:00:00Z', new Date('2026-11-27T12:00:00Z')), 3);
  assert.equal(daysUntilReview('2026-11-01T00:00:00Z', new Date('2026-11-27T12:00:00Z')), 0);

  const viewer = (patch) => ({ accepting_clients: true, viewer: { is_client: true, is_linked: false, pending_request: null, requests_left: 3, ...patch } });
  assert.equal(contactState(viewer({})), 'can_request');
  assert.equal(contactState(viewer({ is_linked: true })), 'linked');
  assert.equal(contactState(viewer({ pending_request: { id: 'x' } })), 'pending');
  assert.equal(contactState(viewer({ requests_left: 0 })), 'limit');
  assert.equal(contactState({ ...viewer({}), accepting_clients: false }), 'closed');
  assert.equal(contactState(viewer({ is_client: false })), 'not_client');
  assert.equal(coachPath(ids.amal), `/coaches/${ids.amal}`);
  assert.equal(coachPath('../admin'), '/coaches');
  assert.equal(chatPathForCoach(ids.sara), `/messages?with=${ids.sara}`);
  assert.equal(validateRequestMessage('   ').error, 'mkErrMessageEmpty');
  assert.equal(validateRequestMessage('x'.repeat(501)).error, 'mkErrMessageLong');
  assert.equal(validateReview({ rating: 0, comment: '' }).errors.rating, 'mkErrRating');
  assert.equal(validateReview({ rating: 5, comment: 'x'.repeat(1001) }).errors.comment, 'mkErrCommentLong');
  assert.equal(validateReport({ reason: 'nope', details: '' }).error, 'mkErrReason');
  assert.equal(validateReport({ reason: 'spam', details: ' hi ' }).details, 'hi');
  assert.equal(validateModerationReason('ab').error, 'mkErrReasonShort');
  assert.equal(validateModerationReason('', { required: false }).valid, true);
  assert.match(countryName('AE', 'ar'), /[\u0600-\u06FF]/);
  assert.equal(countryName('FR', 'en'), 'France');
  assert.equal(countryOptions('en').length, COUNTRY_CODES.length);
});

test('the marketplace pages are in the right menus and the owner screen is not a menu page', () => {
  assert.equal(PAGES.marketplace.access, 'coach');
  assert.equal(PAGES.coaches.access, 'client');
  const ids = (role) => navigationFor(role).flatMap((section) => section.items);
  assert.ok(ids('coach').includes('marketplace') && !ids('coach').includes('coaches'));
  assert.ok(ids('client').includes('coaches') && !ids('client').includes('marketplace'));
  assert.ok(!ids('trainer').includes('marketplace') && !ids('trainer').includes('coaches'));
  assert.equal(ADMIN_PATHS.marketplace, '/admin/marketplace');
  assert.ok(!Object.values(PAGES).some((page) => page.path.startsWith('/admin')));
  const app = read('src/App.jsx');
  assert.match(app, /PAGES\.coaches\.path\}\/:coachId/);
  assert.match(app, /ADMIN_PATHS\.marketplace/);
  assert.ok(app.indexOf('PAGES.coaches.path') > app.indexOf('<Route element={<ClientOnly />}'), 'the coach pages are client pages');
  assert.ok(app.indexOf('PAGES.marketplace.path') < app.indexOf('<Route element={<ClientOnly />}'), 'the marketplace profile is a coach page');
  assert.match(read('src/components/AppShell.jsx'), /adminMkTitle/);
});

test('every text the marketplace screens ask for exists in all five languages, and the Arabic is Arabic', () => {
  const missing = [];
  for (const file of NEW_FILES) {
    const source = read(file);
    const keys = new Set([...source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]));
    for (const match of source.matchAll(/'((?:mk|adminMk)[A-Za-z0-9_]+)'/g)) keys.add(match[1]);
    for (const key of keys) for (const locale of supportedLocales) if (!translations[locale][key]) missing.push(`${file}: ${locale} ${key}`);
  }
  assert.deepEqual(missing, []);
  const dynamic = [
    ...Object.values(TRAINING_MODE_KEYS), ...Object.values(REPORT_REASON_KEYS), ...Object.values(REQUEST_STATUS_KEYS), ...Object.values(HIDDEN_REASON_KEYS),
    'mkAdminStatusOpen', 'mkAdminStatusResolved', 'mkAdminStatusDismissed', 'mkAdminStatusAll', 'navMarketplace', 'navCoaches', 'adminMkTitle', 'adminMkDescription', 'adminMkLink', 'adminMkLinkHelp',
  ];
  for (const key of dynamic) for (const locale of supportedLocales) assert.ok(translations[locale][key], `${locale} ${key}`);
  for (const key of Object.keys(marketplaceTranslations.en)) {
    assert.match(translations.ar[key], /[\u0600-\u06FF]/, `ar ${key} is Arabic`);
    for (const locale of supportedLocales) assert.ok(marketplaceTranslations[locale][key], `${locale} ${key}`);
    const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
    for (const locale of supportedLocales) assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale} ${key} placeholders`);
  }
  for (const key of ['mkContactTitle', 'mkReportSend', 'mkFilterAccepting', 'adminMkTitle']) {
    for (const locale of supportedLocales.filter((code) => code !== 'en')) assert.notEqual(translations[locale][key], translations.en[key], `${locale} ${key}`);
  }
});

test('contact request notifications are worded in every language, with a fallback for a missing name', () => {
  for (const type of ['marketplace_request', 'marketplace_accepted', 'marketplace_declined', 'marketplace_linked']) {
    assert.ok(NOTIFICATION_TYPES.includes(type));
    assert.ok(NOTIFICATION_ICONS[type], type);
    for (const locale of supportedLocales) {
      const t = (key) => translations[locale][key];
      const note = describeNotification({ type, payload: { client_name: 'Sara', coach_name: 'Amal' } }, t, locale);
      assert.ok(note.title && note.body && !note.body.includes('{'), `${locale} ${type}`);
      assert.ok(describeNotification({ type, payload: {} }, t, locale).body.includes(t('mkSomeone')), `${locale} ${type} fallback`);
    }
  }
  assert.equal(safeNotificationLink(`/messages?with=${ids.sara}`), `/messages?with=${ids.sara}`);
  for (const locale of supportedLocales) {
    for (const type of ['marketplace_request', 'marketplace_accepted']) {
      const message = buildPushMessage(type, locale);
      assert.ok(message.title && message.body, `${locale} ${type}`);
    }
  }
  assert.match(buildPushMessage('marketplace_request', 'ar').title, /[\u0600-\u06FF]/);
  assert.equal(buildPushMessage('marketplace_request', 'en').url, '/marketplace');
  assert.equal(buildPushMessage('marketplace_accepted', 'en').url, '/coach-hub');
  assert.match(read('api/push.js'), /marketplace_request/);
  assert.match(read('api/_lib/pushNotify.js'), /marketplace_push_target/);
});

test('the browser never reads the marketplace tables or holds a secret, and the server gained no function', () => {
  for (const file of NEW_FILES) {
    const source = read(file);
    assert.doesNotMatch(source, /service_role|SERVICE_ROLE|VAPID_PRIVATE|PLATFORM_ADMIN_EMAILS/, file);
    assert.doesNotMatch(source, /\.from\('(coach_marketplace_profiles|coach_reviews|marketplace_reports|coach_contact_requests|platform_admins|marketplace_moderation_log)'\)/, file);
  }
  const functions = readdirSync(new URL('../api/', import.meta.url)).filter((name) => !name.startsWith('_'));
  assert.equal(functions.length, 11);
  assert.deepEqual(functions.sort(), ['ai.js', 'food-search.js', 'jack-assistant.js', 'jack.js', 'paddle-webhook.js', 'paddle.js', 'push.js', 'send-campaign.js', 'unsubscribe.js', 'video-sessions.js', 'workflows.js']);
  const guide = read('api/_lib/jackKnowledge.js');
  for (const phrase of ['Marketplace profile', 'Find a coach']) assert.ok(guide.includes(phrase), phrase);
});

test('every function of the marketplace migration is explicit about how it runs and who may call it', () => {
  const sql = read('supabase/migrations/20261115004700_coaches_marketplace.sql');
  assert.doesNotMatch(sql, /grant execute[^;]*\bto\s+(anon|public)\b/i);
  for (const match of sql.matchAll(/create or replace function public\.(\w+)\(/g)) {
    const name = match[1];
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(`), `${name} is revoked from the public roles`);
  }
  for (const name of ['admin_list_marketplace_reports', 'admin_list_marketplace_coaches', 'admin_list_coach_reviews', 'admin_set_coach_hidden', 'admin_set_review_hidden', 'admin_resolve_marketplace_report']) {
    const body = sql.slice(sql.indexOf(`function public.${name}(`)).split('$$;')[0];
    assert.match(body, /marketplace_require_admin\(\)/, `${name} checks the owner first`);
  }
});