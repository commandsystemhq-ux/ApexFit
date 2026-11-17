import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scheduleVideoSession } from '../api/_lib/videoSessions.js';
import { executeTool } from '../api/_lib/jackTools.js';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  JOIN_GRACE_MINUTES, LIVE_PROVIDER, isValidRoomName, roomAccess, roomNameFor, roomPath, sanitizeDisplayName,
} from '../src/services/liveRoom.js';
import { SESSION_PROVIDERS, emptySessionDraft, needsMeetingLink, providerLabelKey, validateSessionForm } from '../src/services/sessionUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const MIGRATION = new URL('../supabase/migrations/20261115001200_live_video_room.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  lina: '00000000-0000-4000-8000-0000000000c3',
};
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-11-20T12:00:00Z');
const live = (minutesFromNow, extra = {}) => ({
  provider: LIVE_PROVIDER, room_name: roomNameFor(SESSION_ID), status: 'scheduled', duration_minutes: 60,
  scheduled_at: new Date(NOW + minutesFromNow * 60_000).toISOString(), ...extra,
});

// ------------------------------------------------------------ helpers

test('room names are derived from the session id and strictly validated', () => {
  assert.equal(roomNameFor(SESSION_ID), `apexfit-session-${SESSION_ID}`);
  assert.equal(roomNameFor(SESSION_ID.toUpperCase()), `apexfit-session-${SESSION_ID}`);
  assert.equal(isValidRoomName(`apexfit-session-${SESSION_ID}`), true);
  for (const bad of ['', null, 'apexfit-session-1', `other-${SESSION_ID}`, `apexfit-session-${SESSION_ID}/../x`, `apexfit-session-${SESSION_ID}#evil`, ` apexfit-session-${SESSION_ID}`]) {
    assert.equal(isValidRoomName(bad), false, String(bad));
  }
  assert.equal(roomPath(SESSION_ID), `/sessions/${SESSION_ID}/room`);
});

test('display names are cleaned before they are shown to everyone in the room', () => {
  assert.equal(sanitizeDisplayName('  Sara   Ali '), 'Sara Ali');
  assert.equal(sanitizeDisplayName('<img src=x onerror=1>Sara'), 'img src=x onerror=1 Sara');
  assert.equal(sanitizeDisplayName('a\u0000b\nc'), 'a b c');
  assert.equal(sanitizeDisplayName(''), 'ApexFit');
  assert.equal(sanitizeDisplayName(null, 'Guest'), 'Guest');
  assert.equal(sanitizeDisplayName('x'.repeat(200)).length, 60);
});

test('the room opens 10 minutes early for clients, any time for the coach, and closes after the session', () => {
  assert.equal(roomAccess(live(30), 'client', NOW), 'early');
  assert.equal(roomAccess(live(11), 'client', NOW), 'early');
  assert.equal(roomAccess(live(9), 'client', NOW), 'open');
  assert.equal(roomAccess(live(-30), 'client', NOW), 'open');
  assert.equal(roomAccess(live(30), 'coach', NOW), 'open', 'the coach can get ready early');
  assert.equal(roomAccess(live(-60 - JOIN_GRACE_MINUTES + 1), 'client', NOW), 'open', 'a short grace period after the planned end');
  assert.equal(roomAccess(live(-60 - JOIN_GRACE_MINUTES), 'client', NOW), 'closed');
  assert.equal(roomAccess(live(-60 - JOIN_GRACE_MINUTES), 'coach', NOW), 'closed');
  assert.equal(roomAccess(live(5, { status: 'cancelled' }), 'client', NOW), 'closed');
  assert.equal(roomAccess(live(-5, { status: 'completed' }), 'coach', NOW), 'closed');
  assert.equal(roomAccess(live(5, { provider: 'zoom' }), 'client', NOW), 'unavailable');
  assert.equal(roomAccess(live(5, { room_name: null }), 'client', NOW), 'unavailable');
  assert.equal(roomAccess(live(5, { room_name: 'apexfit-session-x' }), 'client', NOW), 'unavailable');
  assert.equal(roomAccess(null, 'client', NOW), 'unavailable');
});

test('the session form needs no link for the built-in room and still requires one elsewhere', () => {
  assert.deepEqual(SESSION_PROVIDERS, ['apexfit_live', 'zoom', 'google_meet', 'custom']);
  assert.equal(needsMeetingLink('apexfit_live'), false);
  assert.equal(needsMeetingLink('zoom'), true);
  assert.equal(providerLabelKey('apexfit_live'), 'vsProvider_apexfit_live');

  const future = new Date(NOW + 86_400_000).toISOString().slice(0, 16);
  const base = { ...emptySessionDraft(), clientId: 'c1', title: 'Check-in', scheduledAt: future, duration: '30' };
  assert.equal(base.provider, 'apexfit_live');
  const ok = validateSessionForm(base, { now: NOW });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  assert.deepEqual([ok.payload.provider, ok.payload.meetingUrl, ok.payload.passcode, ok.generate], ['apexfit_live', '', '', false]);

  const stale = validateSessionForm({ ...base, meetingUrl: 'http://not-used', passcode: 'p'.repeat(80) }, { now: NOW });
  assert.equal(stale.valid, true, 'leftover link and passcode text are ignored in the built-in room');
  assert.deepEqual([stale.payload.meetingUrl, stale.payload.passcode], ['', '']);

  assert.equal(validateSessionForm({ ...base, provider: 'zoom' }, { now: NOW }).errors.meetingUrl, 'vsErrLink');
  assert.equal(validateSessionForm({ ...base, provider: 'google_meet' }, { now: NOW }).errors.meetingUrl, 'vsErrLink');
  assert.equal(validateSessionForm({ ...base, provider: 'custom', meetingUrl: 'https://video.example.org/r' }, { now: NOW }).valid, true);
});

test('the server defaults to the built-in room and never calls Zoom for it', async () => {
  const calls = [];
  const deps = {
    zoom: { isConfigured: () => true, createMeeting: async () => { calls.push('zoom'); return { id: '1', url: 'https://zoom.us/j/1', passcode: '' }; }, deleteMeeting: async () => calls.push('delete') },
    notify: async () => calls.push('notify'),
  };
  const context = { userClient: { rpc: async (name, args) => { calls.push(`${name}:${args.p_provider}:${args.p_meeting_url}:${args.p_meeting_passcode}`); return { data: SESSION_ID, error: null }; } } };
  const base = { clientId: 'c1', title: 'Call', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), durationMinutes: 30 };

  const result = await scheduleVideoSession(context, base, deps);
  assert.deepEqual(result, { id: SESSION_ID, meetingUrl: null, passcode: '', provider: 'apexfit_live', generated: false, notified: true, roomPath: roomPath(SESSION_ID) });
  assert.deepEqual(calls, ['schedule_video_session:apexfit_live:null:', 'notify']);

  calls.length = 0;
  const ignored = await scheduleVideoSession(context, { ...base, provider: 'apexfit_live', meetingUrl: 'https://evil.example.com/x', passcode: 'secret' }, deps);
  assert.equal(ignored.meetingUrl, null, 'a link sent along with the built-in room is dropped');
  assert.equal(calls[0], 'schedule_video_session:apexfit_live:null:');

  calls.length = 0;
  const zoom = await scheduleVideoSession(context, { ...base, provider: 'zoom' }, deps);
  assert.deepEqual([zoom.provider, zoom.generated, zoom.roomPath], ['zoom', true, null]);
  await assert.rejects(scheduleVideoSession(context, { ...base, provider: 'custom' }, deps), (error) => error.status === 400);
});

test('the built-in room is described for every language and for Jack', () => {
  for (const locale of supportedLocales) {
    for (const key of ['vsProvider_apexfit_live', 'vsLiveHelp', 'vsJoinLive', 'vsJoinLiveOpens', 'vsStartRoom', 'vsInAppBadge', 'lrEndCall', 'lrRoomTitle', 'lrEarlyTitle', 'lrEarlyBody', 'lrClosedTitle', 'lrClosedBody', 'lrUnavailableTitle', 'lrNotFound', 'lrLoadError', 'lrBackToSessions', 'rmShare', 'rmMute', 'rmRetry', 'rmWaiting', 'rmConnected']) {
      assert.ok(translations[locale][key], `${key} (${locale})`);
    }
  }
  for (const locale of supportedLocales.filter((item) => item !== 'en')) assert.notEqual(translations[locale].lrEndCall, translations.en.lrEndCall, locale);
  assert.match(translations.ar.lrEndCall, /إنهاء/);

  const coach = buildSystemPrompt({ role: 'coach', today: 'x' });
  const client = buildSystemPrompt({ role: 'client', today: 'x' });
  assert.ok(coach.includes('ApexFit Live') && coach.includes('no link'));
  assert.ok(client.includes('Join Live Room'));
});

// ----------------------------------------------------------- database

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function fails(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}
const inHours = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const schedule = (userId, o = {}) => as(userId).rpc('schedule_video_session', {
  p_client_id: o.client === undefined ? ids.sara : o.client,
  p_group_id: o.group ?? null,
  p_title: o.title ?? 'Form check',
  p_description: '',
  p_scheduled_at: o.at ?? inHours(24),
  p_duration_minutes: o.duration ?? 45,
  p_provider: o.provider ?? 'apexfit_live',
  p_meeting_url: o.url ?? null,
  p_meeting_passcode: o.passcode ?? '',
});

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.lina, 'lina@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara Ali', 'sara@example.com'), ($1, $3, 'Omar Hassan', 'omar@example.com'), ($1, $4, 'Lina Noor', 'lina@example.com')",
    [ids.coachA, ids.sara, ids.omar, ids.lina],
  );
});

test('the migration is part of manual-setup.sql and can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('a built-in session gets its own random room and needs no link', async () => {
  const id = await ok(schedule(ids.coachA));
  const [session] = await rows('select * from public.video_sessions where id = $1', [id]);
  assert.deepEqual([session.provider, session.meeting_url, session.meeting_passcode], ['apexfit_live', null, '']);
  assert.equal(session.room_name, `apexfit-session-${id}`);
  assert.equal(isValidRoomName(session.room_name), true);

  const second = await ok(schedule(ids.coachA, { title: 'Another' }));
  assert.notEqual((await rows('select room_name from public.video_sessions where id = $1', [second]))[0].room_name, session.room_name, 'every session has a different room');

  // A link or passcode sent for the built-in room is ignored, never stored.
  const ignored = await ok(schedule(ids.coachA, { url: 'https://evil.example.com/x', passcode: 'secret' }));
  assert.deepEqual((await rows('select meeting_url, meeting_passcode from public.video_sessions where id = $1', [ignored]))[0], { meeting_url: null, meeting_passcode: '' });
});

test('external providers still require a matching https link and have no room', async () => {
  await fails(schedule(ids.coachA, { provider: 'zoom', url: null }), /https/);
  await fails(schedule(ids.coachA, { provider: 'zoom', url: 'https://meet.google.com/abc-defg-hij' }), /does not match/);
  await fails(schedule(ids.coachA, { provider: 'banana' }), /provider/);
  const zoom = await ok(schedule(ids.coachA, { provider: 'zoom', url: 'https://us02web.zoom.us/j/1', passcode: '123' }));
  assert.deepEqual((await rows('select room_name, meeting_url, meeting_passcode from public.video_sessions where id = $1', [zoom]))[0], { room_name: null, meeting_url: 'https://us02web.zoom.us/j/1', meeting_passcode: '123' });
});

test('the table itself refuses a built-in session without a room or a room with a bad name', async () => {
  const insert = (provider, room, url) => db.query(
    "insert into public.video_sessions (coach_id, client_id, title, scheduled_at, provider, meeting_url, room_name) values ($1, $2, 't', now() + interval '1 day', $3, $4, $5)",
    [ids.coachA, ids.sara, provider, url, room],
  );
  await assert.rejects(insert('apexfit_live', null, null), /live_room_required/);
  await assert.rejects(insert('apexfit_live', 'apexfit-session-not-a-uuid', null), /room_name_format/);
  await assert.rejects(insert('apexfit_live', '../../etc/passwd', null), /room_name_format/);
  await assert.rejects(insert('zoom', null, null), /link_required/);
  await insert('apexfit_live', `apexfit-session-${SESSION_ID}`, null);
});

test('editing keeps the room name, and switching providers adds or removes the room', async () => {
  const id = await ok(schedule(ids.coachA));
  const update = (o = {}) => as(ids.coachA).rpc('update_video_session', {
    p_session_id: id, p_title: o.title ?? 'Moved', p_description: '', p_scheduled_at: inHours(48), p_duration_minutes: 30,
    p_provider: o.provider ?? 'apexfit_live', p_meeting_url: o.url ?? null, p_meeting_passcode: o.passcode ?? '',
  });
  const room = `apexfit-session-${id}`;

  await ok(update());
  assert.deepEqual((await rows('select title, room_name from public.video_sessions where id = $1', [id]))[0], { title: 'Moved', room_name: room });

  await fails(update({ provider: 'zoom' }), /https/);
  await ok(update({ provider: 'zoom', url: 'https://zoom.us/j/9', passcode: '9' }));
  assert.deepEqual((await rows('select provider, room_name, meeting_url from public.video_sessions where id = $1', [id]))[0], { provider: 'zoom', room_name: null, meeting_url: 'https://zoom.us/j/9' });

  await ok(update({ provider: 'apexfit_live' }));
  assert.deepEqual((await rows('select provider, room_name, meeting_url, meeting_passcode from public.video_sessions where id = $1', [id]))[0], { provider: 'apexfit_live', room_name: room, meeting_url: null, meeting_passcode: '' });
  await fails(as(ids.coachB).rpc('update_video_session', { p_session_id: id, p_title: 'x', p_description: '', p_scheduled_at: inHours(2), p_duration_minutes: 30, p_provider: 'apexfit_live', p_meeting_url: null, p_meeting_passcode: '' }), /not found/);
});

test('only the people a session is for can read its room name', async () => {
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  await ok(as(ids.coachA).rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.omar] }));
  const solo = await ok(schedule(ids.coachA, { client: ids.sara, title: 'Solo' }));
  const group = await ok(schedule(ids.coachA, { client: null, group: groupId, title: 'Group' }));

  const rooms = async (userId) => (await ok(as(userId).from('video_sessions').select('title,room_name').order('title'))).map((row) => [row.title, row.room_name]);
  assert.deepEqual(await rooms(ids.coachA), [['Group', `apexfit-session-${group}`], ['Solo', `apexfit-session-${solo}`]]);
  assert.deepEqual(await rooms(ids.sara), [['Solo', `apexfit-session-${solo}`]]);
  assert.deepEqual(await rooms(ids.omar), [['Group', `apexfit-session-${group}`]]);
  assert.deepEqual(await rooms(ids.lina), [], 'a client of the same coach who is not invited sees nothing');
  assert.deepEqual(await rooms(ids.coachB), []);

  const one = await ok(as(ids.sara).from('video_sessions').select('id,room_name,provider').eq('id', solo).maybeSingle());
  assert.deepEqual(one, { id: solo, room_name: `apexfit-session-${solo}`, provider: 'apexfit_live' });
  assert.equal(await ok(as(ids.lina).from('video_sessions').select('id').eq('id', solo).maybeSingle()), null);

  const mine = await ok(as(ids.sara).rpc('get_my_video_sessions'));
  assert.deepEqual(mine.map((item) => [item.title, item.room_name, item.meeting_url]), [['Solo', `apexfit-session-${solo}`, null]]);
  assert.deepEqual(await ok(as(ids.lina).rpc('get_my_video_sessions')), []);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.deepEqual(await rooms(ids.sara), [], 'an archived client loses the room');
});

test('Jack schedules a built-in room session by default and reports the room page', async () => {
  const context = (userId, role) => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today: new Date().toISOString().slice(0, 10), utcOffsetMinutes: 0, access: { role }, videoDeps: { zoom: { isConfigured: () => false }, notify: async () => {} } });
  const when = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
  const booked = await executeTool('schedule_video_session', { client: 'Omar', title: 'Live check-in', when }, context(ids.coachA, 'coach'));
  assert.equal(booked.ok, true, booked.error);
  assert.deepEqual([booked.result.provider, booked.result.in_app_room, booked.result.meeting_url], ['apexfit_live', true, null]);
  assert.equal(booked.result.room_page, `/sessions/${booked.result.session_id}/room`);

  const mine = await executeTool('get_my_sessions', {}, context(ids.omar, 'client'));
  assert.equal(mine.ok, true, mine.error);
  assert.deepEqual(mine.result.upcoming.map((item) => [item.title, item.join_in_app, item.join_url]), [['Live check-in', `/sessions/${booked.result.session_id}/room`, null]]);
});

// ------------------------------------------- signaling channel access (Realtime)

async function asRealtime(userId, topic, sql, params = []) {
  await db.query("select set_config('test.uid', $1, false)", [userId]);
  await db.query("select set_config('realtime.topic', $1, false)", [topic ?? '']);
  await db.exec('set role authenticated');
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('test.uid', '', false)");
    await db.query("select set_config('realtime.topic', '', false)");
  }
}
const canSend = async (userId, topic, extension = 'broadcast') => {
  try {
    await asRealtime(userId, topic, 'insert into realtime.messages (topic, extension, payload) values ($1, $2, $3)', [topic, extension, '{}']);
    return true;
  } catch (error) {
    assert.match(error.message, /row-level security/);
    return false;
  }
};
const canJoin = async (userId, topic) => (await asRealtime(userId, null, 'select public.can_join_video_room($1) as ok', [topic])).rows[0].ok;
const topicOf = (sessionId) => `video-room-${sessionId}`;

test('only the people a live session is for can listen and send on its signaling channel', async () => {
  const groupId = await ok(as(ids.coachA).rpc('save_group', { p_group_id: null, p_name: 'Squad', p_description: '' }));
  await ok(as(ids.coachA).rpc('add_group_members', { p_group_id: groupId, p_client_ids: [ids.omar] }));
  const solo = await ok(schedule(ids.coachA, { client: ids.sara, at: inHours(0.05) }));
  const group = await ok(schedule(ids.coachA, { client: null, group: groupId, at: inHours(0.05) }));

  assert.deepEqual([await canJoin(ids.coachA, topicOf(solo)), await canJoin(ids.sara, topicOf(solo))], [true, true]);
  assert.deepEqual([await canJoin(ids.omar, topicOf(solo)), await canJoin(ids.lina, topicOf(solo)), await canJoin(ids.coachB, topicOf(solo))], [false, false, false]);
  assert.deepEqual([await canJoin(ids.coachA, topicOf(group)), await canJoin(ids.omar, topicOf(group))], [true, true]);
  assert.deepEqual([await canJoin(ids.sara, topicOf(group)), await canJoin(ids.lina, topicOf(group))], [false, false], 'a client outside the group is kept out');

  assert.equal(await canSend(ids.coachA, topicOf(solo)), true);
  assert.equal(await canSend(ids.sara, topicOf(solo)), true);
  for (const outsider of [ids.omar, ids.lina, ids.coachB]) assert.equal(await canSend(outsider, topicOf(solo)), false, 'outsiders cannot send');
  assert.equal(await canSend(ids.sara, topicOf(group)), false);
  assert.equal(await canSend(ids.omar, topicOf(group)), true);

  // Only broadcast traffic on a valid, existing room topic is allowed.
  assert.equal(await canSend(ids.sara, topicOf(solo), 'presence'), false);
  assert.equal(await canSend(ids.sara, 'video-room-00000000-0000-4000-8000-00000000ffff'), false, 'unknown session');
  for (const topic of ['', 'video-room-', 'video-room-not-a-uuid', 'other-topic', `${topicOf(solo)}-extra`, topicOf(solo).toUpperCase()]) {
    assert.equal(await canSend(ids.coachA, topic), false, topic || 'empty topic');
  }

  await db.query("delete from realtime.messages");
  await db.query("insert into realtime.messages (topic, extension, payload) values ($1, 'broadcast', '{}')", [topicOf(solo)]);
  const visible = async (userId, topic) => Number((await asRealtime(userId, topic, 'select count(*) as n from realtime.messages')).rows[0].n);
  assert.deepEqual([await visible(ids.sara, topicOf(solo)), await visible(ids.coachA, topicOf(solo))], [1, 1]);
  assert.deepEqual([await visible(ids.omar, topicOf(solo)), await visible(ids.coachB, topicOf(solo)), await visible(ids.lina, topicOf(solo))], [0, 0, 0], 'outsiders receive nothing');
  assert.equal(await visible(ids.sara, null), 0, 'no topic, no messages');
});

test('the signaling channel follows the same timing and status rules as the room page', async () => {
  const later = await ok(schedule(ids.coachA, { client: ids.sara, at: inHours(3) }));
  assert.equal(await canJoin(ids.coachA, topicOf(later)), true, 'the coach may get ready early');
  assert.equal(await canJoin(ids.sara, topicOf(later)), false, 'the client waits for the start window');

  const soon = await ok(schedule(ids.coachA, { client: ids.sara, at: inHours(0.1) }));
  assert.equal(await canJoin(ids.sara, topicOf(soon)), true, 'inside the 10 minutes before the start');

  const insert = async (startOffsetHours, extra = {}) => {
    const roomId = extra.id || crypto.randomUUID();
    await db.query(
      `insert into public.video_sessions (id, coach_id, client_id, title, scheduled_at, duration_minutes, provider, meeting_url, room_name, status)
       values ($1, $2, $3, 'direct', now() + make_interval(secs => $4), 60, $5, $6, $7, $8)`,
      [roomId, ids.coachA, ids.sara, startOffsetHours * 3600, extra.provider || 'apexfit_live', extra.url || null, extra.provider === 'zoom' ? null : roomNameFor(roomId), extra.status || 'scheduled'],
    );
    return roomId;
  };
  const running = await insert(-0.5);
  assert.equal(await canJoin(ids.sara, topicOf(running)), true);
  const justOver = await insert(-1.9);
  assert.equal(await canJoin(ids.sara, topicOf(justOver)), true, 'a grace hour after the planned end');
  const over = await insert(-2.2);
  assert.deepEqual([await canJoin(ids.sara, topicOf(over)), await canJoin(ids.coachA, topicOf(over))], [false, false], 'the room is closed after the grace hour');

  const cancelled = await insert(0.05, { status: 'cancelled' });
  const completed = await insert(0.05, { status: 'completed' });
  const zoom = await insert(0.05, { provider: 'zoom', url: 'https://zoom.us/j/1' });
  for (const closed of [cancelled, completed, zoom]) assert.deepEqual([await canJoin(ids.coachA, topicOf(closed)), await canJoin(ids.sara, topicOf(closed))], [false, false]);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.equal(await canJoin(ids.sara, topicOf(soon)), false, 'an archived client is locked out');
  assert.equal(await canJoin(ids.coachA, topicOf(soon)), true);
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coachA]);
  assert.equal(await canJoin(ids.coachA, topicOf(soon)), false, 'a coach whose plan ended cannot open rooms');

  assert.equal((await db.query("select public.can_join_video_room(null) as ok")).rows[0].ok, false);
  await db.exec('set role anon');
  try {
    await assert.rejects(db.query("select public.can_join_video_room('video-room-x')"), /permission denied/);
  } finally {
    await db.exec('reset role');
  }
});

test('the signaling migration is part of manual-setup.sql and can be applied again', async () => {
  const migration = readFileSync(new URL('../supabase/migrations/20261115001300_video_room_signaling.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(migration);
  assert.equal((await db.query("select count(*)::int as n from pg_policies where schemaname = 'realtime'")).rows[0].n, 2);
});

test('a refused "enable row level security" no longer prevents the access policies from being created', async () => {
  // On Supabase the realtime.messages table belongs to a system role, so ALTER TABLE is refused for the SQL Editor.
  const migration = readFileSync(new URL('../supabase/migrations/20261115001300_video_room_signaling.sql', import.meta.url), 'utf8');
  const block = migration.slice(migration.indexOf('do $$', migration.indexOf('Row-level security on the Realtime')));

  await db.exec('drop policy if exists "Video room members can receive signals" on realtime.messages; drop policy if exists "Video room members can send signals" on realtime.messages;');
  await db.exec(`
    create or replace function public.test_refuse_alter() returns event_trigger language plpgsql as $f$
    begin raise exception 'must be owner of table messages' using errcode = '42501'; end;
    $f$;
    create event trigger test_refuse_alter on ddl_command_start when tag in ('ALTER TABLE') execute function public.test_refuse_alter();
  `);
  try {
    await assert.rejects(db.exec('alter table realtime.messages enable row level security'), /must be owner/, 'the simulated refusal is active');
    await db.exec(block);
  } finally {
    await db.exec('drop event trigger test_refuse_alter; drop function public.test_refuse_alter();');
  }
  const policies = (await db.query("select policyname from pg_policies where schemaname = 'realtime' order by 1")).rows.map((row) => row.policyname);
  assert.deepEqual(policies, ['Video room members can receive signals', 'Video room members can send signals']);
});
