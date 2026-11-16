import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoreCheckoutParams, isDemoStore } from '../api/_lib/storeCheckout.js';
import { NOTIFICATION_TYPES, buildPushMessage } from '../api/_lib/pushText.js';
import { parseJackRequest } from '../api/_lib/jackAgent.js';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { scheduleVideoSession } from '../api/_lib/videoSessions.js';
import {
  ZoomError, buildMeetingBody, createMeeting, deleteMeeting, isZoomConfigured, sanitizePasscode, zoomCredentials,
} from '../api/_lib/zoom.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { PAGES, homePathFor, navigationFor, pageForPath, roleOf } from '../src/routes.js';
import { quickPromptKeys } from '../src/services/jackUtils.js';
import {
  countdownParts, emptySessionDraft, formatCountdown, fromDatetimeLocal, isValidMeetingUrl, linkMatchesProvider, sessionPhase, splitSessions,
  toDatetimeLocal, validateSessionForm,
} from '../src/services/sessionUtils.js';
import {
  centsToInput, emptyProductDraft, formatPrice, formatRevenue, isSecureUrl, isUuid, parsePriceToCents, publicStorePath, validateProductForm,
} from '../src/services/storeUtils.js';
import {
  TEAM_PERMISSIONS, assignmentIndex, defaultPermissions, filterClientsByTrainer, hasPermission, memberLabel, normalizePermissions, validateInviteForm,
} from '../src/services/teamUtils.js';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const at = (minutes, extra = {}) => ({ scheduled_at: new Date(NOW + minutes * 60_000).toISOString(), duration_minutes: 60, status: 'scheduled', ...extra });

// ---------------------------------------------------------------- store

test('prices are parsed to cents and zero means free', () => {
  assert.equal(parsePriceToCents('29'), 2900);
  assert.equal(parsePriceToCents('29.9'), 2990);
  assert.equal(parsePriceToCents(' 29,95 '), 2995);
  assert.equal(parsePriceToCents('0'), 0);
  for (const bad of ['', 'abc', '-5', '1.234', '1e3', null]) assert.equal(parsePriceToCents(bad), null, String(bad));
  assert.equal(centsToInput(0), '0');
  assert.equal(centsToInput(2990), '29.90');
});

test('the product form enforces the same rules as the database', () => {
  const ok = validateProductForm({ programId: 'p1', title: ' Plan ', description: ' d ', price: '29', currency: 'eur', cover: ' https://img.example.com/a.png ', publish: 1 });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.payload, { id: null, programId: 'p1', title: 'Plan', description: 'd', priceCents: 2900, currency: 'eur', cover: 'https://img.example.com/a.png', publish: true });
  assert.equal(validateProductForm({ ...emptyProductDraft({ programId: 'p', title: 'Free', price: '0' }) }).valid, true);

  const bad = validateProductForm({ programId: '', title: ' ', description: 'd'.repeat(1001), price: '0.20', currency: 'xyz', cover: 'http://x.example.com/a.png' });
  assert.deepEqual(bad.errors, { programId: 'strErrProgram', title: 'strErrTitle', description: 'strErrDescription', price: 'strErrPrice', currency: 'strErrCurrency', cover: 'strErrCover' });
  assert.equal(validateProductForm({ programId: 'p', title: 't'.repeat(121), price: '10', currency: 'usd' }).errors.title, 'strErrTitleLength');
  assert.equal(validateProductForm({ programId: 'p', title: 't', price: '1000001', currency: 'usd' }).errors.price, 'strErrPrice');
});

test('store helpers format prices, links and ids', () => {
  assert.equal(formatPrice(0, 'usd', 'en', 'Free'), 'Free');
  assert.equal(formatPrice(2990, 'usd', 'en', 'Free'), '$29.90');
  assert.equal(formatRevenue([{ currency: 'usd', cents: 5800 }, { currency: 'eur', cents: 1500 }], 'en'), '$58.00 · €15.00');
  assert.equal(formatRevenue([], 'en'), '$0.00');
  assert.equal(publicStorePath('abc'), '/shop/abc');
  assert.equal(isSecureUrl('https://a.example.com/x.png'), true);
  for (const bad of ['http://a.example.com', 'javascript:alert(1)', 'https://a b', '', null, `https://a.example.com/${'x'.repeat(500)}`]) assert.equal(isSecureUrl(bad), false, String(bad).slice(0, 30));
  assert.equal(isUuid('00000000-0000-4000-8000-0000000000a1'), true);
  assert.equal(isUuid('../../etc/passwd'), false);
});

test('Stripe checkout for a store order carries the order id and the exact amount', () => {
  const order = { order_id: 'o1', amount_cents: 2990, currency: 'eur', title: 'Strength Basics' };
  const params = buildStoreCheckoutParams({ order, destinationAccount: 'acct_1', appUrl: 'https://app.example.com', customerEmail: 'a@b.co', feePercent: 10 });
  assert.equal(params.line_items[0].price_data.unit_amount, 2990);
  assert.equal(params.line_items[0].price_data.currency, 'eur');
  assert.equal(params.metadata.store_order_id, 'o1');
  assert.equal(params.payment_intent_data.metadata.store_order_id, 'o1');
  assert.equal(params.payment_intent_data.application_fee_amount, 299);
  assert.equal(params.payment_intent_data.transfer_data.destination, 'acct_1');
  assert.equal(params.success_url, 'https://app.example.com/my-store?checkout=success');
  assert.equal(params.cancel_url, 'https://app.example.com/my-store?checkout=canceled');
  assert.equal('application_fee_amount' in buildStoreCheckoutParams({ order, destinationAccount: 'a', appUrl: 'https://x.y' }).payment_intent_data, false);
  assert.equal(isDemoStore({ STORE_DEMO_MODE: 'true' }), true);
  assert.equal(isDemoStore({ STORE_DEMO_MODE: ' 1 ' }), true);
  assert.equal(isDemoStore({ STORE_DEMO_MODE: 'false' }), false);
  assert.equal(isDemoStore({}), false);
});

// ----------------------------------------------------------------- team

test('team forms, permissions and the trainer filter', () => {
  assert.deepEqual(TEAM_PERMISSIONS, ['manage_programs', 'view_assessments', 'messages', 'manage_groups']);
  assert.deepEqual(normalizePermissions({ manage_programs: true, messages: 'yes', admin: true }), { manage_programs: true, view_assessments: false, messages: false, manage_groups: false });
  assert.deepEqual(defaultPermissions(), { manage_programs: true, view_assessments: true, messages: true, manage_groups: false });
  assert.deepEqual(validateInviteForm({ email: ' Tina@Example.COM ', roleTitle: ' Coach ' }), { valid: true, errors: {}, email: 'tina@example.com', roleTitle: 'Coach' });
  assert.deepEqual(validateInviteForm({ email: 'nope', roleTitle: 'r'.repeat(81) }).errors, { email: 'tmErrEmail', roleTitle: 'tmErrRoleTitle' });
  assert.equal(memberLabel({ trainer_name: 'Tina', invite_email: 't@x.co' }), 'Tina');
  assert.equal(memberLabel({ trainer_name: null, invite_email: 't@x.co' }), 't@x.co');
  assert.equal(hasPermission({ team: { permissions: { messages: true } } }, 'messages'), true);
  assert.equal(hasPermission({ team: { permissions: { messages: 'true' } } }, 'messages'), false);
  assert.equal(hasPermission({}, 'messages'), false);

  const members = [{ id: 'm1', trainer_name: 'Tina' }, { id: 'm2', trainer_name: 'Tom' }];
  const index = assignmentIndex([{ client_id: 'c1', team_member_id: 'm1' }, { client_id: 'c2', team_member_id: 'm2' }, { client_id: 'c3', team_member_id: 'gone' }], members);
  const clients = ['c1', 'c2', 'c3', 'c4'].map((id) => ({ client_id: id }));
  const ids = (filter) => filterClientsByTrainer(clients, index, filter).map((client) => client.client_id);
  assert.deepEqual(ids('all'), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(ids('none'), ['c3', 'c4'], 'a client whose trainer is gone counts as unassigned');
  assert.deepEqual(ids('m1'), ['c1']);
  assert.deepEqual(ids('m2'), ['c2']);
  assert.deepEqual(ids(undefined), ['c1', 'c2', 'c3', 'c4']);
});

test('roles, navigation and home pages for coaches, trainers and clients', () => {
  const coach = { role: 'coach', access_state: 'trialing' };
  const trainer = { role: 'coach', access_state: 'trainer' };
  const client = { role: 'client', access_state: 'client' };
  assert.deepEqual([roleOf(coach), roleOf(trainer), roleOf(client), roleOf(null)], ['coach', 'trainer', 'client', 'coach']);
  assert.deepEqual([homePathFor('coach'), homePathFor('trainer'), homePathFor('client')], ['/dashboard', '/team-clients', '/workouts']);

  const idsFor = (role) => navigationFor(role).flatMap((group) => group.items);
  assert.deepEqual(idsFor('trainer'), ['teamClients', 'settings']);
  for (const id of ['team', 'store', 'sessions']) {
    assert.ok(idsFor('coach').includes(id), id);
    assert.ok(!idsFor('client').includes(id) && !idsFor('trainer').includes(id), id);
    assert.equal(PAGES[id].access, 'coach');
  }
  for (const id of ['myStore', 'mySessions']) {
    assert.ok(idsFor('client').includes(id), id);
    assert.ok(!idsFor('coach').includes(id), id);
  }
  assert.ok(!idsFor('coach').includes('teamClients') && !idsFor('client').includes('teamClients'));
  for (const id of idsFor('trainer')) assert.ok(['trainer', 'any'].includes(PAGES[id].access), id);
  assert.equal(pageForPath('/shop/abc'), null, 'the public storefront is not an app page');
});

// ------------------------------------------------------------- sessions

test('session links must be https and match the provider', () => {
  assert.equal(isValidMeetingUrl('https://us02web.zoom.us/j/1?pwd=x'), true);
  for (const bad of ['http://zoom.us/j/1', 'javascript:alert(1)', 'https://zoom.us/j/1 x', '', undefined]) assert.equal(isValidMeetingUrl(bad), false, String(bad));
  assert.equal(linkMatchesProvider('zoom', 'https://us02web.zoom.us/j/1'), true);
  assert.equal(linkMatchesProvider('zoom', 'https://zoom.us/j/1'), true);
  assert.equal(linkMatchesProvider('zoom', 'https://evilzoom.us.example.com/j/1'), false);
  assert.equal(linkMatchesProvider('zoom', 'https://zoom.us.evil.com/j/1'), false);
  assert.equal(linkMatchesProvider('google_meet', 'https://meet.google.com/abc-defg-hij'), true);
  assert.equal(linkMatchesProvider('google_meet', 'https://meet.google.com.evil.com/x'), false);
  assert.equal(linkMatchesProvider('custom', 'https://video.example.org/r/1'), true);
  assert.equal(linkMatchesProvider('skype', 'https://video.example.org/r/1'), false);
});

test('the session form validates audience, time, duration and link, and knows when Zoom can make the link', () => {
  const future = toDatetimeLocal(new Date(NOW + 86_400_000));
  const base = { audience: 'client', clientId: 'c1', groupId: '', title: ' Form check ', description: '', scheduledAt: future, duration: '45', provider: 'custom', meetingUrl: 'https://video.example.org/r/1', passcode: '', autoLink: true };
  const ok = validateSessionForm(base, { now: NOW });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  assert.deepEqual([ok.payload.clientId, ok.payload.groupId, ok.payload.title, ok.payload.durationMinutes, ok.generate], ['c1', null, 'Form check', 45, false]);
  assert.equal(validateSessionForm({ ...base, audience: 'group', groupId: 'g1', clientId: '' }, { now: NOW }).payload.groupId, 'g1');

  const auto = validateSessionForm({ ...base, provider: 'zoom', meetingUrl: '' }, { zoomConfigured: true, now: NOW });
  assert.deepEqual([auto.valid, auto.generate], [true, true], 'an empty link is fine when Zoom is connected');
  assert.equal(validateSessionForm({ ...base, provider: 'zoom', meetingUrl: '' }, { zoomConfigured: false, now: NOW }).errors.meetingUrl, 'vsErrLink');
  assert.equal(validateSessionForm({ ...base, provider: 'zoom', meetingUrl: '', autoLink: false }, { zoomConfigured: true, now: NOW }).errors.meetingUrl, 'vsErrLink');

  const bad = validateSessionForm({ audience: 'group', groupId: '', title: ' ', scheduledAt: '', duration: '2', provider: 'skype', meetingUrl: 'http://x.co', passcode: 'p'.repeat(51) }, { now: NOW });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['audience', 'duration', 'meetingUrl', 'passcode', 'provider', 'scheduledAt', 'title']);
  assert.equal(validateSessionForm({ ...base, clientId: '' }, { now: NOW }).errors.audience, 'vsErrClient');
  assert.equal(validateSessionForm({ ...base, scheduledAt: toDatetimeLocal(new Date(NOW - 5 * 3_600_000)) }, { now: NOW }).errors.scheduledAt, 'vsErrPast');
  assert.equal(validateSessionForm({ ...base, id: 's1', scheduledAt: toDatetimeLocal(new Date(NOW - 5 * 3_600_000)) }, { now: NOW }).valid, true, 'editing a past session is allowed');
  assert.equal(validateSessionForm({ ...base, meetingUrl: 'https://zoom.us/j/1' , provider: 'google_meet' }, { now: NOW }).errors.meetingUrl, 'vsErrLinkProvider');
  assert.equal(validateSessionForm({ ...base, duration: '481' }, { now: NOW }).errors.duration, 'vsErrDuration');
  assert.equal(emptySessionDraft().provider, 'apexfit_live', 'the built-in room is the default');
});

test('date-time inputs round-trip through ISO strings', () => {
  const iso = '2026-11-20T16:30:00.000Z';
  assert.equal(fromDatetimeLocal(toDatetimeLocal(iso)), iso.replace(':00.000Z', ':00.000Z'));
  assert.equal(fromDatetimeLocal('not a date'), null);
  assert.equal(toDatetimeLocal('nope'), '');
});

test('a session moves through upcoming, soon, live and ended, and the countdown follows', () => {
  assert.equal(sessionPhase(at(120), NOW), 'upcoming');
  assert.equal(sessionPhase(at(10), NOW), 'soon');
  assert.equal(sessionPhase(at(0), NOW), 'live');
  assert.equal(sessionPhase(at(-59), NOW), 'live');
  assert.equal(sessionPhase(at(-60), NOW), 'ended');
  assert.equal(sessionPhase(at(120, { status: 'cancelled' }), NOW), 'cancelled');
  assert.equal(sessionPhase(at(-300, { status: 'completed' }), NOW), 'completed');

  assert.deepEqual(countdownParts(new Date(NOW + (2 * 86_400 + 3 * 3600 + 5 * 60 + 9) * 1000), NOW), { done: false, days: 2, hours: 3, minutes: 5, seconds: 9 });
  assert.equal(countdownParts(new Date(NOW - 1000), NOW).done, true);
  assert.equal(formatCountdown({ days: 2, hours: 3, minutes: 5, seconds: 9 }), '2d 3h');
  assert.equal(formatCountdown({ days: 0, hours: 3, minutes: 5, seconds: 9 }), '3h 05m');
  assert.equal(formatCountdown({ days: 0, hours: 0, minutes: 12, seconds: 5 }), '12m 05s');
  assert.equal(formatCountdown({ days: 0, hours: 0, minutes: 0, seconds: 0 }), '0m 00s');

  const sessions = [at(300, { id: 'later' }), at(-200, { id: 'old' }), at(30, { id: 'next' }), at(5, { id: 'live-soon' }), at(-10, { id: 'live' }), at(60, { id: 'cancelled', status: 'cancelled' })];
  const { upcoming, past } = splitSessions(sessions, NOW);
  assert.deepEqual(upcoming.map((session) => session.id), ['live', 'live-soon', 'next', 'later']);
  assert.deepEqual(past.map((session) => session.id), ['cancelled', 'old']);
});

// ------------------------------------------------------------------ zoom

function mockZoom(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const handler = handlers.find((entry) => url.startsWith(entry.prefix));
    return handler.respond(url, init);
  };
  impl.calls = calls;
  return impl;
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const CREDENTIALS = { accountId: 'acc', clientId: 'cid', clientSecret: 'secret' };

test('Zoom is only configured when all three credentials exist', () => {
  assert.equal(isZoomConfigured({}), false);
  assert.equal(isZoomConfigured({ ZOOM_ACCOUNT_ID: 'a', ZOOM_CLIENT_ID: 'b' }), false);
  assert.equal(isZoomConfigured({ ZOOM_ACCOUNT_ID: 'a', ZOOM_CLIENT_ID: 'b', ZOOM_CLIENT_SECRET: ' ' }), false);
  assert.deepEqual(zoomCredentials({ ZOOM_ACCOUNT_ID: ' a ', ZOOM_CLIENT_ID: 'b', ZOOM_CLIENT_SECRET: 'c' }), { accountId: 'a', clientId: 'b', clientSecret: 'c' });
  assert.equal(sanitizePasscode(' ab<c>d1 2!345678901'), 'abcd123456');
  const body = buildMeetingBody({ title: 'Form check', startsAt: '2026-11-20T16:00:00.123Z', durationMinutes: 45.4, passcode: 'a b', description: 'x' });
  assert.deepEqual([body.topic, body.start_time, body.duration, body.type, body.password], ['Form check', '2026-11-20T16:00:00Z', 45, 2, 'ab']);
  assert.equal('password' in buildMeetingBody({ title: 't', startsAt: '2026-11-20T16:00:00Z', durationMinutes: 30 }), false);
  assert.throws(() => buildMeetingBody({ title: 't', startsAt: 'nope', durationMinutes: 30 }), ZoomError);
});

test('createMeeting authenticates with the account credentials and returns the join link', async () => {
  const fetchImpl = mockZoom([
    { prefix: 'https://zoom.us/oauth/token', respond: () => json(200, { access_token: 'tok' }) },
    { prefix: 'https://api.zoom.us/v2/users/me/meetings', respond: () => json(201, { id: 12345, join_url: 'https://us02web.zoom.us/j/12345?pwd=x', password: 'pw1' }) },
  ]);
  const meeting = await createMeeting({ title: 'Call', startsAt: '2026-11-20T16:00:00Z', durationMinutes: 30 }, { credentials: CREDENTIALS, fetchImpl });
  assert.deepEqual(meeting, { id: '12345', url: 'https://us02web.zoom.us/j/12345?pwd=x', passcode: 'pw1' });
  const [token, create] = fetchImpl.calls;
  assert.equal(token.url, 'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=acc');
  assert.equal(token.headers.Authorization, `Basic ${Buffer.from('cid:secret').toString('base64')}`);
  assert.equal(create.headers.Authorization, 'Bearer tok');
  assert.equal(create.body.topic, 'Call');
});

test('Zoom failures become safe errors and never leak credentials', async () => {
  const run = (handlers) => createMeeting({ title: 'x', startsAt: '2026-11-20T16:00:00Z', durationMinutes: 30 }, { credentials: CREDENTIALS, fetchImpl: mockZoom(handlers) });
  await assert.rejects(run([{ prefix: 'https://zoom.us/', respond: () => json(401, {}) }]), (error) => error instanceof ZoomError && error.status === 503 && !error.message.includes('secret'));
  await assert.rejects(run([{ prefix: 'https://zoom.us/', respond: () => json(200, {}) }]), /access token/);
  const authorized = { prefix: 'https://zoom.us/', respond: () => json(200, { access_token: 't' }) };
  await assert.rejects(run([authorized, { prefix: 'https://api.zoom.us/', respond: () => json(429, {}) }]), (error) => error.status === 429);
  await assert.rejects(run([authorized, { prefix: 'https://api.zoom.us/', respond: () => json(500, {}) }]), /could not create/);
  await assert.rejects(run([authorized, { prefix: 'https://api.zoom.us/', respond: () => json(201, { id: 1, join_url: 'http://insecure' }) }]), /meeting link/);
  await assert.rejects(createMeeting({ title: 'x', startsAt: '2026-11-20T16:00:00Z', durationMinutes: 30 }, { credentials: null }), /not configured/);
  await deleteMeeting('1', { credentials: null });
  await deleteMeeting('1', { credentials: CREDENTIALS, fetchImpl: mockZoom([{ prefix: 'https://zoom.us/', respond: () => json(500, {}) }]) });
});

test('scheduleVideoSession keeps its promises with Zoom and the database mocked', async () => {
  const base = { clientId: 'c1', title: 'Call', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 };
  const calls = [];
  const deps = (rpcError = null, configured = true) => ({
    zoom: {
      isConfigured: () => configured,
      createMeeting: async () => { calls.push('create'); return { id: '7', url: 'https://us02web.zoom.us/j/7', passcode: 'p7' }; },
      deleteMeeting: async (id) => { calls.push(`delete:${id}`); },
    },
    notify: async () => { calls.push('notify'); },
  });
  const context = (error) => ({ userClient: { rpc: async (name, args) => { calls.push(`${name}:${args.p_meeting_url}`); return error ? { data: null, error: { message: error } } : { data: 'session-1', error: null }; } } });

  const ok = await scheduleVideoSession(context(null), { ...base, provider: 'zoom' }, deps());
  assert.deepEqual(ok, { id: 'session-1', meetingUrl: 'https://us02web.zoom.us/j/7', passcode: 'p7', provider: 'zoom', generated: true, notified: true, roomPath: null });
  assert.deepEqual(calls, ['create', 'schedule_video_session:https://us02web.zoom.us/j/7', 'notify']);

  calls.length = 0;
  const own = await scheduleVideoSession(context(null), { ...base, provider: 'custom', meetingUrl: 'https://video.example.org/r', notify: false }, deps());
  assert.deepEqual([own.generated, own.notified, calls], [false, false, ['schedule_video_session:https://video.example.org/r']]);

  calls.length = 0;
  await assert.rejects(scheduleVideoSession(context('Choose an active client'), { ...base, provider: 'zoom' }, deps()), (error) => error.status === 400 && /active client/.test(error.message));
  assert.deepEqual(calls, ['create', 'schedule_video_session:https://us02web.zoom.us/j/7', 'delete:7']);

  calls.length = 0;
  await assert.rejects(scheduleVideoSession(context(null), { ...base, provider: 'zoom' }, deps(null, false)), (error) => error.status === 503);
  await assert.rejects(scheduleVideoSession(context(null), { ...base, provider: 'custom' }, deps()), (error) => error.status === 400);
  await assert.rejects(scheduleVideoSession(context(null), { ...base, scheduledAt: 'garbage', provider: 'zoom' }, deps()), (error) => error.status === 400);
  await assert.rejects(scheduleVideoSession(context(null), { ...base, scheduledAt: '2020-01-01T00:00:00Z', provider: 'zoom' }, deps()), /future/);
  assert.deepEqual(calls, [], 'nothing was created or saved for invalid requests');

  const notifyFails = { ...deps(), notify: async () => { throw new Error('push is not configured'); } };
  assert.equal((await scheduleVideoSession(context(null), { ...base, provider: 'zoom' }, notifyFails)).notified, false, 'a failed notification never fails the booking');
});

// ------------------------------------------------------------- push & jack

test('video sessions have a push message in every language that opens the sessions page', () => {
  assert.ok(NOTIFICATION_TYPES.includes('video'));
  for (const locale of supportedLocales) {
    const message = buildPushMessage('video', locale);
    assert.ok(message.title && message.body, locale);
    assert.equal(message.url, '/my-sessions');
  }
  assert.notEqual(buildPushMessage('video', 'ar').title, buildPushMessage('video', 'en').title);
  assert.equal(buildPushMessage('message', 'en').url, '/coach-hub');
});

test('Jack knows about the new pages for each role and the browser UTC offset is validated', () => {
  const prompt = (role) => buildSystemPrompt({ role, locale: 'en', route: '/', today: '2026-11-20' });
  assert.ok(['(/store)', '(/team)', '(/sessions)'].every((path) => prompt('coach').includes(path)));
  assert.ok(!prompt('coach').includes('(/team-clients)'));
  assert.ok(['(/my-store)', '(/my-sessions)'].every((path) => prompt('client').includes(path)));
  const trainer = prompt('trainer');
  assert.ok(trainer.includes('(/team-clients)') && trainer.includes('assistant trainer'));
  for (const path of ['(/dashboard)', '(/store)', '(/clients)', '(/billing)']) assert.ok(!trainer.includes(path), path);

  const parse = (utcOffset) => parseJackRequest({ messages: [{ role: 'user', content: 'hi' }], context: { utcOffset } }).utcOffsetMinutes;
  assert.deepEqual([parse(120), parse(-300), parse(840), parse(841), parse('120'), parse(1.5), parse(undefined)], [120, -300, 840, 0, 120, 0, 0]);
});

test('quick prompts exist for the new pages and trainers, all translated', () => {
  assert.ok(quickPromptKeys('coach', '/store').includes('jackQ_coachStore'));
  assert.ok(quickPromptKeys('coach', '/sessions').includes('jackQ_coachSession'));
  assert.ok(quickPromptKeys('coach', '/team').includes('jackQ_coachTeam'));
  assert.ok(quickPromptKeys('client', '/my-store').includes('jackQ_clientStore'));
  assert.ok(quickPromptKeys('client', '/my-sessions').includes('jackQ_clientSessions'));
  assert.deepEqual(quickPromptKeys('trainer', '/team-clients'), ['jackQ_trainerHome']);
  for (const locale of supportedLocales) {
    for (const key of ['jackQ_trainerHome', 'jackGreetingTrainer', 'jackTool_create_store_product_running', 'jackTool_schedule_video_session_done', 'jackTool_invite_trainer_done', 'jackTool_get_my_sessions_done', 'jackTool_get_my_store_done', 'jackTool_get_store_sales_running']) {
      assert.ok(translations[locale][key], `${key} (${locale})`);
    }
  }
});

test('every new screen is translated in all five languages', () => {
  const keys = new Set(['navStore', 'navMyStore', 'navTeam', 'navTeamClients', 'navSessions', 'navMySessions']);
  for (const id of ['store', 'myStore', 'team', 'teamClients', 'sessions', 'mySessions']) keys.add(PAGES[id].titleKey);
  for (const key of Object.keys(translations.en)) if (/^(str|tm|trn|vs)[A-Z_]/.test(key) && !/^(strength|strong|streak)/i.test(key)) keys.add(key);
  for (const permission of TEAM_PERMISSIONS) keys.add(`tmPerm_${permission}`);
  for (const provider of ['zoom', 'google_meet', 'custom']) keys.add(`vsProvider_${provider}`);
  assert.ok(keys.size > 180, `only ${keys.size} keys found`);
  for (const locale of supportedLocales) {
    for (const key of keys) assert.ok(translations[locale][key], `Missing ${key} for ${locale}`);
  }
  for (const locale of supportedLocales.filter((item) => item !== 'en')) {
    for (const key of ['strDescription', 'tmDescription', 'vsDescription', 'trnDescription', 'strMyDescription', 'vsMyDescription']) {
      assert.notEqual(translations[locale][key], translations.en[key], `${key} is not translated for ${locale}`);
    }
  }
  assert.match(translations.ar.vsJoin, /انضم/);
});
