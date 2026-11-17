import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executeTool, toolSpecsForRole } from '../api/_lib/jackTools.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { subscribeToChat } from '../src/services/chatRealtime.js';
import {
  CHAT_MAX_LENGTH, buildThread, dayKind, filterConversations, formatListTime, groupByDay, isNearBottom, localDay, makePendingMessage, markSentRead,
  mergePage, messageStatus, sortConversations, totalUnread, upsertMessage, validateChatText,
} from '../src/services/chatUtils.js';
import { WRITE_TOOLS, quickPromptKeys } from '../src/services/jackUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const MIGRATION = new URL('../supabase/migrations/20261115001500_realtime_chat.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coachA: '00000000-0000-4000-8000-0000000000a1',
  coachB: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  bFan: '00000000-0000-4000-8000-0000000000c4',
};

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const count = async (sql, params = []) => Number((await rows(sql, params))[0].n);

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

const say = (from, to, text, ref = null) => as(from).rpc('send_chat_message', { p_receiver_id: to, p_text: text, p_client_ref: ref });
// Messages with exact times, written as the database owner (the way a restore or a migration would).
const seed = (sender, receiver, text, minutesAgo, read = false) => db.query(
  "insert into public.chat_messages (sender_id, receiver_id, message_text, created_at, is_read) values ($1, $2, $3, now() - ($4 || ' minutes')::interval, $5)",
  [sender, receiver, text, String(minutesAgo), read],
);

before(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coachA, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal', brandName: 'Amal Strength' });
  await addUser(db, { id: ids.coachB, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.bFan, 'b@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name, coach_email) values
       ($1, $2, 'Sara Ali', 'sara@example.com', 'Amal Strength', 'amal@example.com'), ($1, $3, 'Omar Hassan', 'omar@example.com', 'Amal Strength', 'amal@example.com'),
       ($4, $5, 'Bea Fan', 'b@example.com', 'Coach Ben', 'ben@example.com')`,
    [ids.coachA, ids.sara, ids.omar, ids.coachB, ids.bFan],
  );
});

test('manual-setup.sql contains the migration and it can be applied again', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});

test('the chat table joins the Realtime publication when Supabase has one, and is not fatal when it does not', async () => {
  await db.exec('create publication supabase_realtime');
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const first = await count("select count(*) as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_messages'");
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const second = await count("select count(*) as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'chat_messages'");
  await db.exec('drop publication supabase_realtime');
  assert.deepEqual([first, second], [1, 1]);
});

// ------------------------------------------------------------------ sending

test('a coach and a client exchange messages and each sees both sides', async () => {
  const first = await ok(say(ids.coachA, ids.sara, '  Hi Sara, ready for leg day?  '));
  assert.deepEqual([first.sender_id, first.receiver_id, first.message_text, first.is_read], [ids.coachA, ids.sara, 'Hi Sara, ready for leg day?', false]);
  await ok(say(ids.sara, ids.coachA, 'Yes! What time?'));
  await ok(say(ids.coachA, ids.sara, '6pm'));

  for (const user of [ids.coachA, ids.sara]) {
    const thread = await ok(as(user).rpc('get_chat_messages', { p_partner_id: user === ids.coachA ? ids.sara : ids.coachA }));
    assert.deepEqual(thread.messages.map((message) => message.message_text), ['Hi Sara, ready for leg day?', 'Yes! What time?', '6pm']);
    assert.equal(thread.has_more, false);
  }
  assert.equal(await ok(as(ids.sara).rpc('get_chat_unread_count')), 2);
  assert.equal(await ok(as(ids.coachA).rpc('get_chat_unread_count')), 1);
  assert.equal(await ok(as(ids.omar).rpc('get_chat_unread_count')), 0);
});

test('only a coach and their own active client can message each other', async () => {
  await fails(say(ids.coachA, ids.bFan, 'hello'), /own coach or your active clients/);
  await fails(say(ids.coachB, ids.sara, 'hello'), /own coach or your active clients/);
  await fails(say(ids.sara, ids.coachB, 'hello'), /own coach or your active clients/);
  await fails(say(ids.sara, ids.omar, 'hello'), /own coach or your active clients/);
  await fails(say(ids.coachA, ids.coachB, 'hello'), /own coach or your active clients/);
  await fails(say(ids.sara, ids.sara, 'hello'), /own coach or your active clients/);
  await fails(say(ids.sara, '00000000-0000-4000-8000-00000000ffff', 'hello'), /own coach or your active clients/);
  await fails(as(ids.sara).rpc('send_chat_message', { p_receiver_id: null, p_text: 'x' }), /own coach or your active clients/);
  assert.equal(await count('select count(*) as n from public.chat_messages'), 0);
});

test('messages are validated', async () => {
  await fails(say(ids.coachA, ids.sara, '   '), /Write a message/);
  await fails(say(ids.coachA, ids.sara, null), /Write a message/);
  await fails(say(ids.coachA, ids.sara, 'x'.repeat(2001)), /2000 characters/);
  await ok(say(ids.coachA, ids.sara, 'x'.repeat(2000)));
  assert.equal(await count('select count(*) as n from public.chat_messages'), 1);
});

test('an archived client or a coach whose access ended cannot start new messages, but the history stays readable', async () => {
  await ok(say(ids.coachA, ids.sara, 'before'));
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  await fails(say(ids.coachA, ids.sara, 'after'), /own coach or your active clients/);
  await fails(say(ids.sara, ids.coachA, 'after'), /own coach or your active clients/);
  assert.equal((await ok(as(ids.sara).rpc('get_chat_messages', { p_partner_id: ids.coachA }))).messages.length, 1);

  await db.query("update public.coach_clients set status = 'active' where client_id = $1", [ids.sara]);
  await ok(say(ids.sara, ids.coachA, 'back'));
  await db.query("update public.profiles set trial_started_at = now() - interval '5 days', trial_ends_at = now() - interval '2 days' where id = $1", [ids.coachA]);
  await fails(say(ids.coachA, ids.sara, 'expired'), /own coach or your active clients/);
  await fails(say(ids.sara, ids.coachA, 'to an expired coach'), /own coach or your active clients/);
  assert.equal((await ok(as(ids.sara).rpc('get_chat_conversations')))[0].status, 'archived', 'the client sees a closed chat, not a broken composer');
});

test('sending the same message twice with the same reference stores it once', async () => {
  const ref = '11111111-1111-4111-8111-111111111111';
  const a = await ok(say(ids.sara, ids.coachA, 'Can we move to 7pm?', ref));
  const b = await ok(say(ids.sara, ids.coachA, 'Can we move to 7pm?', ref));
  assert.equal(a.id, b.id);
  assert.equal(await count('select count(*) as n from public.chat_messages'), 1);
  await ok(say(ids.sara, ids.coachA, 'Another', '22222222-2222-4222-8222-222222222222'));
  await ok(say(ids.sara, ids.coachA, 'No reference'));
  await ok(say(ids.sara, ids.coachA, 'No reference'));
  assert.equal(await count('select count(*) as n from public.chat_messages'), 4);
});

test('sending too fast is limited', async () => {
  for (let index = 0; index < 40; index += 1) await ok(say(ids.sara, ids.coachA, `message ${index}`));
  await fails(say(ids.sara, ids.coachA, 'one too many'), /too fast/);
  await ok(say(ids.coachA, ids.sara, 'the other person is not limited'));
});

// ----------------------------------------------------------------- security

test('people outside the conversation cannot read it, and nobody writes the table directly', async () => {
  await ok(say(ids.coachA, ids.sara, 'private plan'));
  await ok(say(ids.sara, ids.coachA, 'thanks'));

  assert.equal((await ok(as(ids.sara).from('chat_messages').select('message_text'))).length, 2);
  assert.equal((await ok(as(ids.coachA).from('chat_messages').select('message_text'))).length, 2);
  for (const outsider of [ids.omar, ids.coachB, ids.bFan]) {
    assert.equal((await ok(as(outsider).from('chat_messages').select('message_text'))).length, 0, 'table read');
    assert.deepEqual(await ok(as(outsider).rpc('get_chat_messages', { p_partner_id: ids.sara })), { messages: [], has_more: false });
    assert.deepEqual(await ok(as(outsider).rpc('get_chat_messages', { p_partner_id: ids.coachA })), { messages: [], has_more: false });
  }

  const refused = [
    `insert into public.chat_messages (sender_id, receiver_id, message_text) values ('${ids.sara}', '${ids.coachA}', 'forged')`,
    `insert into public.chat_messages (sender_id, receiver_id, message_text) values ('${ids.coachA}', '${ids.sara}', 'forged')`,
    "update public.chat_messages set message_text = 'edited'",
    'update public.chat_messages set is_read = true',
    'delete from public.chat_messages',
  ];
  for (const statement of refused) assert.ok((await as(ids.sara).sql(statement)).error, statement);
  for (const statement of refused) assert.ok((await as(ids.coachA).sql(statement)).error, statement);
  assert.ok((await createUserClient(db, ids.sara).sql('select * from public.chat_messages')).error === null);
  assert.deepEqual((await rows('select message_text from public.chat_messages order by created_at')).map((row) => row.message_text), ['private plan', 'thanks']);
});

test('the database refuses self-chat and empty text even for direct writes', async () => {
  await assert.rejects(db.query("insert into public.chat_messages (sender_id, receiver_id, message_text) values ($1, $1, 'me')", [ids.sara]), /check/);
  await assert.rejects(db.query("insert into public.chat_messages (sender_id, receiver_id, message_text) values ($1, $2, '   ')", [ids.sara, ids.coachA]), /check/);
});

test('signed-out callers get nothing', async () => {
  await ok(say(ids.coachA, ids.sara, 'hello'));
  const nobody = createUserClient(db, '00000000-0000-4000-8000-000000000000');
  assert.deepEqual(await ok(nobody.rpc('get_chat_messages', { p_partner_id: ids.sara })), { messages: [], has_more: false });
  await fails(nobody.rpc('send_chat_message', { p_receiver_id: ids.sara, p_text: 'hi' }), /own coach or your active clients/);
});

// ------------------------------------------------------------ reading history

test('history loads newest first in pages and is shown oldest first', async () => {
  for (let index = 7; index >= 1; index -= 1) await seed(index % 2 ? ids.coachA : ids.sara, index % 2 ? ids.sara : ids.coachA, `m${8 - index}`, index * 10);

  const latest = await ok(as(ids.sara).rpc('get_chat_messages', { p_partner_id: ids.coachA, p_limit: 3 }));
  assert.deepEqual(latest.messages.map((message) => message.message_text), ['m5', 'm6', 'm7']);
  assert.equal(latest.has_more, true);

  const earlier = await ok(as(ids.sara).rpc('get_chat_messages', { p_partner_id: ids.coachA, p_limit: 3, p_before: latest.messages[0].created_at }));
  assert.deepEqual(earlier.messages.map((message) => message.message_text), ['m2', 'm3', 'm4']);
  assert.equal(earlier.has_more, true);

  const first = await ok(as(ids.sara).rpc('get_chat_messages', { p_partner_id: ids.coachA, p_limit: 3, p_before: earlier.messages[0].created_at }));
  assert.deepEqual(first.messages.map((message) => message.message_text), ['m1']);
  assert.equal(first.has_more, false);

  const everything = await ok(as(ids.sara).rpc('get_chat_messages', { p_partner_id: ids.coachA, p_limit: 500 }));
  assert.equal(everything.messages.length, 7);
  assert.deepEqual(Object.keys(everything.messages[0]).sort(), ['created_at', 'id', 'is_read', 'message_text', 'receiver_id', 'sender_id']);
});

test('only messages with the chosen person are returned', async () => {
  await ok(say(ids.coachA, ids.sara, 'for Sara'));
  await ok(say(ids.coachA, ids.omar, 'for Omar'));
  const withSara = await ok(as(ids.coachA).rpc('get_chat_messages', { p_partner_id: ids.sara }));
  assert.deepEqual(withSara.messages.map((message) => message.message_text), ['for Sara']);
});

// ---------------------------------------------------------------- read receipts

test('opening a conversation marks only the other person\'s messages as read', async () => {
  await ok(say(ids.coachA, ids.sara, 'one'));
  await ok(say(ids.coachA, ids.sara, 'two'));
  await ok(say(ids.sara, ids.coachA, 'reply'));
  await ok(say(ids.coachA, ids.omar, 'other client'));

  assert.equal(await ok(as(ids.sara).rpc('mark_chat_read', { p_partner_id: ids.coachA })), 2);
  assert.equal(await ok(as(ids.sara).rpc('mark_chat_read', { p_partner_id: ids.coachA })), 0, 'nothing left to mark');

  const seenByCoach = await ok(as(ids.coachA).rpc('get_chat_messages', { p_partner_id: ids.sara }));
  assert.deepEqual(seenByCoach.messages.map((message) => [message.message_text, message.is_read]), [['one', true], ['two', true], ['reply', false]]);
  assert.equal(await ok(as(ids.sara).rpc('get_chat_unread_count')), 0);
  assert.equal(await ok(as(ids.omar).rpc('get_chat_unread_count')), 1, 'other conversations are untouched');

  // Marking someone else's conversation changes nothing for them.
  assert.equal(await ok(as(ids.omar).rpc('mark_chat_read', { p_partner_id: ids.sara })), 0);
  assert.equal(await ok(as(ids.coachA).rpc('mark_chat_read', { p_partner_id: ids.sara })), 1);
});

// ------------------------------------------------------------ conversation list

test('the coach\'s list shows every active client with the last message and unread count', async () => {
  await seed(ids.sara, ids.coachA, 'older', 50);
  await seed(ids.sara, ids.coachA, 'newest from Sara', 5);
  await seed(ids.coachA, ids.sara, 'coach reply', 20, true);

  const list = await ok(as(ids.coachA).rpc('get_chat_conversations'));
  assert.deepEqual(list.map((item) => item.partner_name), ['Sara Ali', 'Omar Hassan']);
  const [sara, omar] = list;
  assert.deepEqual([sara.partner_id, sara.last_text, sara.last_sender_id, sara.unread_count, sara.status], [ids.sara, 'newest from Sara', ids.sara, 2, 'active']);
  assert.deepEqual([omar.last_text, omar.last_at, omar.unread_count], [null, null, 0]);
  assert.ok(!JSON.stringify(list).includes('@'), 'no email addresses in the list');
});

test('the client\'s list shows their coach, and archived people appear only when there is history', async () => {
  const empty = await ok(as(ids.sara).rpc('get_chat_conversations'));
  assert.deepEqual(empty.map((item) => [item.partner_id, item.partner_name, item.unread_count]), [[ids.coachA, 'Amal Strength', 0]]);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.omar]);
  assert.deepEqual((await ok(as(ids.coachA).rpc('get_chat_conversations'))).map((item) => item.partner_name), ['Sara Ali'], 'archived without messages is hidden');
  await seed(ids.omar, ids.coachA, 'I was here', 30);
  const withHistory = await ok(as(ids.coachA).rpc('get_chat_conversations'));
  assert.deepEqual(withHistory.map((item) => [item.partner_name, item.status]), [['Omar Hassan', 'archived'], ['Sara Ali', 'active']]);

  assert.deepEqual((await ok(as(ids.bFan).rpc('get_chat_conversations'))).map((item) => item.partner_id), [ids.coachB]);
  assert.deepEqual((await ok(as(ids.coachB).rpc('get_chat_conversations'))).map((item) => item.partner_id), [ids.bFan]);
});

// ---------------------------------------------------------------- Jack's tools

const ctx = (userId, role) => ({ user: { id: userId }, userClient: createUserClient(db, userId), role, today: '2026-11-17', access: { role } });

test('Jack\'s chat tools exist only for the right role', async () => {
  const names = (role) => toolSpecsForRole(role).map((tool) => tool.name);
  assert.ok(names('coach').includes('read_client_chat') && names('coach').includes('send_client_chat_message'));
  assert.ok(!names('coach').includes('read_coach_chat') && !names('coach').includes('send_coach_chat_message'));
  assert.ok(names('client').includes('read_coach_chat') && names('client').includes('send_coach_chat_message'));
  assert.ok(!names('client').includes('read_client_chat') && !names('client').includes('send_client_chat_message'));
  assert.ok(!names('trainer').some((name) => name.includes('chat')));
  assert.equal((await executeTool('send_client_chat_message', { client: 'Sara', message: 'x' }, ctx(ids.sara, 'client'))).forbidden, true);
  assert.equal((await executeTool('send_coach_chat_message', { message: 'x' }, ctx(ids.coachA, 'coach'))).forbidden, true);
  assert.ok(WRITE_TOOLS.includes('send_client_chat_message') && WRITE_TOOLS.includes('send_coach_chat_message'));
  assert.ok(quickPromptKeys('coach', '/messages').includes('jackQ_coachChat'));
  assert.ok(quickPromptKeys('client', '/coach-hub').includes('jackQ_clientChat'));
});

test('the coach reads and writes chat through Jack', async () => {
  await seed(ids.sara, ids.coachA, 'Can I swap Friday?', 12);
  await seed(ids.coachA, ids.sara, 'Sure', 8, true);
  await seed(ids.omar, ids.coachA, 'Question about my diet', 3);

  const overview = await executeTool('read_client_chat', {}, ctx(ids.coachA, 'coach'));
  assert.equal(overview.ok, true, overview.error);
  assert.equal(overview.result.unread_total, 2);
  assert.deepEqual(overview.result.conversations.map((item) => [item.client, item.unread]), [['Omar Hassan', 1], ['Sara Ali', 1]]);

  const thread = await executeTool('read_client_chat', { client: 'sara', limit: 5 }, ctx(ids.coachA, 'coach'));
  assert.equal(thread.ok, true, thread.error);
  assert.deepEqual(thread.result.messages.map((message) => [message.from, message.text]), [['them', 'Can I swap Friday?'], ['me', 'Sure']]);
  assert.equal(await ok(as(ids.coachA).rpc('get_chat_unread_count')), 2, 'reading through Jack does not mark messages as read');

  const sent = await executeTool('send_client_chat_message', { client: 'Omar Hassan', message: '  Let\'s talk tomorrow.  ' }, ctx(ids.coachA, 'coach'));
  assert.equal(sent.ok, true, sent.error);
  assert.deepEqual([sent.result.sent, sent.result.to, sent.result.text], [true, 'Omar Hassan', 'Let\'s talk tomorrow.']);
  assert.deepEqual((await rows('select sender_id, receiver_id, message_text from public.chat_messages where receiver_id = $1', [ids.omar])), [{ sender_id: ids.coachA, receiver_id: ids.omar, message_text: 'Let\'s talk tomorrow.' }]);
});

test('Jack refuses unknown clients, other coaches\' clients, empty messages and archived clients', async () => {
  const stranger = await executeTool('send_client_chat_message', { client: 'Bea Fan', message: 'hi' }, ctx(ids.coachA, 'coach'));
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /No client matches/);
  assert.equal((await executeTool('read_client_chat', { client: 'Bea Fan' }, ctx(ids.coachA, 'coach'))).ok, false);

  const empty = await executeTool('send_client_chat_message', { client: 'Sara', message: '   ' }, ctx(ids.coachA, 'coach'));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /empty/);
  const long = await executeTool('send_client_chat_message', { client: 'Sara', message: 'x'.repeat(CHAT_MAX_LENGTH + 1) }, ctx(ids.coachA, 'coach'));
  assert.equal(long.ok, false);
  assert.match(long.error, /too long/);

  const ambiguous = await executeTool('read_client_chat', { client: 'a' }, ctx(ids.coachA, 'coach'));
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /Ask which one|No client|Several/);

  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  assert.equal((await executeTool('send_client_chat_message', { client: 'Sara', message: 'hi' }, ctx(ids.coachA, 'coach'))).ok, false);
  assert.equal(await count('select count(*) as n from public.chat_messages'), 0);
});

test('the client reads and writes to their coach through Jack', async () => {
  await seed(ids.coachA, ids.sara, 'How did leg day go?', 9);
  const read = await executeTool('read_coach_chat', {}, ctx(ids.sara, 'client'));
  assert.equal(read.ok, true, read.error);
  assert.deepEqual([read.result.with, read.result.unread_from_them, read.result.messages.map((message) => [message.from, message.text])], ['Amal Strength', 1, [['them', 'How did leg day go?']]]);

  const sent = await executeTool('send_coach_chat_message', { message: 'It went great!' }, ctx(ids.sara, 'client'));
  assert.equal(sent.ok, true, sent.error);
  assert.deepEqual((await rows('select sender_id, receiver_id, message_text from public.chat_messages where sender_id = $1', [ids.sara])), [{ sender_id: ids.sara, receiver_id: ids.coachA, message_text: 'It went great!' }]);

  assert.equal((await executeTool('send_coach_chat_message', { message: 'hi' }, ctx(ids.omar, 'client'))).ok, true, 'Omar has a coach too');
  await db.query('delete from public.coach_clients where client_id = $1', [ids.omar]);
  const alone = await executeTool('read_coach_chat', {}, ctx(ids.omar, 'client'));
  assert.equal(alone.ok, false);
  assert.match(alone.error, /not linked/);
});

test('a client with two coaches must say which one', async () => {
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, coach_name) values ($1, $2, 'Sara Ali', 'Ben Fitness')", [ids.coachB, ids.sara]);
  const unclear = await executeTool('send_coach_chat_message', { message: 'hi' }, ctx(ids.sara, 'client'));
  assert.equal(unclear.ok, false);
  const clear = await executeTool('send_coach_chat_message', { message: 'hi', coach: 'ben' }, ctx(ids.sara, 'client'));
  assert.equal(clear.ok, true, clear.error);
  assert.equal(await count('select count(*) as n from public.chat_messages where receiver_id = $1', [ids.coachB]), 1);
});

// --------------------------------------------------------------------- helpers

const T0 = Date.parse('2026-11-17T10:00:00Z');
const message = (id, minutes, extra = {}) => ({ id, sender_id: 'coach', receiver_id: 'sara', message_text: id, created_at: new Date(T0 + minutes * 60000).toISOString(), is_read: false, ...extra });

test('message text is trimmed and limited', () => {
  assert.deepEqual(validateChatText('  hello\r\nworld  '), { valid: true, text: 'hello\nworld', error: null });
  assert.equal(validateChatText('   ').error, 'chatErrEmpty');
  assert.equal(validateChatText(null).error, 'chatErrEmpty');
  assert.equal(validateChatText('x'.repeat(CHAT_MAX_LENGTH)).valid, true);
  assert.equal(validateChatText('x'.repeat(CHAT_MAX_LENGTH + 1)).error, 'chatErrTooLong');
});

test('a message that arrives twice, or after its pending copy, is shown once and in order', () => {
  let list = [];
  list = upsertMessage(list, message('b', 2));
  list = upsertMessage(list, message('a', 1));
  list = upsertMessage(list, message('b', 2));
  assert.deepEqual(list.map((item) => item.id), ['a', 'b']);

  const pending = makePendingMessage({ senderId: 'sara', receiverId: 'coach', text: 'hi', clientRef: 'ref-1', now: new Date(T0 + 5 * 60000) });
  list = upsertMessage(list, pending);
  assert.equal(messageStatus(list.at(-1)), 'sending');
  list = upsertMessage(list, message('real-id', 5, { sender_id: 'sara', receiver_id: 'coach', client_ref: 'ref-1', message_text: 'hi' }));
  assert.deepEqual(list.map((item) => item.id), ['a', 'b', 'real-id']);
  assert.equal(messageStatus(list.at(-1)), 'sent');
  list = upsertMessage(list, message('real-id', 5, { sender_id: 'sara', receiver_id: 'coach', client_ref: 'ref-1' }));
  assert.equal(list.length, 3, 'the live copy of my own message does not add another');
});

test('read receipts, failed sends and paging merge into the list', () => {
  let list = mergePage([], [message('b', 2), message('c', 3)]);
  list = mergePage(list, [message('a', 1), message('b', 2)]);
  assert.deepEqual(list.map((item) => item.id), ['a', 'b', 'c']);
  list = markSentRead(list, ['b']);
  assert.deepEqual(list.map((item) => messageStatus(item)), ['sent', 'read', 'sent']);
  assert.equal(messageStatus({ ...message('x', 1), failed: true }), 'failed');
  assert.equal(messageStatus({ ...message('x', 1), pending: true }), 'sending');
});

test('the thread merges chat with the coach\'s notes and videos by time', () => {
  const thread = buildThread({
    chat: [message('c1', 2, { sender_id: 'coach' }), message('c2', 4, { sender_id: 'sara' })],
    notes: [{ id: 'n1', coach_id: 'coach', kind: 'note', body: 'Welcome!', created_at: message('x', 1).created_at }, { id: 'v1', coach_id: 'coach', kind: 'video', body: '', video_path: 'coach/v.mp4', created_at: message('x', 3).created_at }],
    myId: 'sara',
  });
  assert.deepEqual(thread.map((item) => [item.key, item.type, item.fromMe]), [['note:n1', 'note', false], ['chat:c1', 'chat', false], ['video:v1'.replace('video', 'note'), 'video', false], ['chat:c2', 'chat', true]]);
  assert.equal(thread[2].videoPath, 'coach/v.mp4');
  assert.equal(buildThread({ chat: [], notes: [{ id: 'n', coach_id: 'coach', kind: 'note', body: 'hi', created_at: message('x', 1).created_at }], myId: 'coach' })[0].fromMe, true);
});

test('messages are grouped by the viewer\'s own day', () => {
  const noon = (day) => new Date(`${day}T12:00:00`).toISOString();
  const groups = groupByDay([{ created_at: noon('2026-11-15') }, { created_at: noon('2026-11-16') }, { created_at: noon('2026-11-16') }]);
  assert.deepEqual(groups.map((group) => [group.day, group.items.length]), [['2026-11-15', 1], ['2026-11-16', 2]]);
  const now = new Date('2026-11-17T12:00:00');
  assert.deepEqual(['2026-11-17', '2026-11-16', '2026-11-10'].map((day) => dayKind(day, now)), ['today', 'yesterday', 'date']);
  assert.equal(localDay(new Date('2026-03-05T12:00:00')), '2026-03-05');
  assert.match(formatListTime(new Date('2026-11-17T09:05:00').toISOString(), 'en', now), /9:05|09:05/);
  assert.doesNotMatch(formatListTime(new Date('2026-11-10T09:05:00').toISOString(), 'en', now), /:/);
  assert.equal(formatListTime(null, 'en'), '');
});

test('conversations sort by latest message, filter by name, and count unread', () => {
  const list = [
    { partner_id: 'a', partner_name: 'Zed', last_at: null, unread_count: 0 },
    { partner_id: 'b', partner_name: 'Amy', last_at: '2026-11-17T09:00:00Z', unread_count: 2 },
    { partner_id: 'c', partner_name: 'Ben', last_at: '2026-11-17T10:00:00Z', unread_count: 3 },
    { partner_id: 'd', partner_name: 'Al', last_at: null, unread_count: 0 },
  ];
  assert.deepEqual(sortConversations(list).map((item) => item.partner_id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(filterConversations(list, ' AM ').map((item) => item.partner_id), ['b']);
  assert.equal(filterConversations(list, '').length, 4);
  assert.equal(totalUnread(list), 5);
  assert.equal(totalUnread(null), 0);
});

test('auto-scroll only follows new messages when the reader is near the bottom', () => {
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 450, clientHeight: 500 }), true);
  assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 500 }), false);
  assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 500 }), true);
});

// ---------------------------------------------------------------- Realtime

function fakeRealtime() {
  const state = { listeners: [], callback: null, removed: [], name: null };
  const channel = {
    on(type, filter, handler) {
      state.listeners.push({ type, filter, handler });
      return channel;
    },
    subscribe(callback) {
      state.callback = callback;
      return channel;
    },
  };
  const client = {
    channel(name) {
      state.name = name;
      return channel;
    },
    removeChannel(value) {
      state.removed.push(value);
    },
  };
  return { client, state, channel };
}

test('the live subscription listens for my incoming and outgoing messages and my read receipts, and stops cleanly', () => {
  const { client, state, channel } = fakeRealtime();
  const seen = { messages: [], reads: [], status: [] };
  const stop = subscribeToChat(client, 'user-1', {
    onMessage: (row) => seen.messages.push(row.id),
    onRead: (row) => seen.reads.push(row.id),
    onStatus: (status) => seen.status.push(status),
  });

  assert.match(state.name, /^chat-user-1-\d+$/);
  assert.deepEqual(state.listeners.map(({ filter }) => [filter.event, filter.table, filter.filter]), [
    ['INSERT', 'chat_messages', 'receiver_id=eq.user-1'],
    ['INSERT', 'chat_messages', 'sender_id=eq.user-1'],
    ['UPDATE', 'chat_messages', 'sender_id=eq.user-1'],
  ]);
  state.listeners[0].handler({ new: { id: 'm1' } });
  state.listeners[1].handler({ new: { id: 'm2' } });
  state.listeners[2].handler({ new: { id: 'm1' } });
  state.callback('SUBSCRIBED');
  state.callback('CHANNEL_ERROR');
  state.callback('SUBSCRIBED');
  state.callback('CLOSED');
  assert.deepEqual(seen, { messages: ['m1', 'm2'], reads: ['m1'], status: ['live', 'offline', 'live', 'offline'] });

  stop();
  assert.deepEqual(state.removed, [channel]);

  const second = fakeRealtime();
  subscribeToChat(second.client, 'user-1');
  assert.notEqual(second.state.name, state.name, 'every subscription gets its own channel name');
  second.state.listeners[0].handler({ new: { id: 'ignored' } });
  second.state.callback('SUBSCRIBED');
});

// --------------------------------------------------------------- translations

const CHAT_KEY = /^(chat[A-Z]|jackTool_(read|send)_(client|coach)_chat|jackQ_(coach|client)Chat$)/;

test('every language has the same chat texts', () => {
  const keysOf = (locale) => Object.keys(translations[locale]).filter((key) => CHAT_KEY.test(key)).sort();
  const english = keysOf('en');
  assert.ok(english.length >= 40);
  for (const locale of supportedLocales) {
    assert.deepEqual(keysOf(locale), english, locale);
    for (const key of english) assert.ok(String(translations[locale][key]).trim(), `${locale}.${key}`);
  }
});

test('every text the chat screens and validation can show exists in every language', () => {
  const keys = [
    'chatTab', 'chatBroadcastTab', 'chatBroadcastNote', 'chatBroadcastVideo', 'chatPlaceholder', 'chatSend', 'chatErrEmpty', 'chatErrTooLong', 'chatDay_today', 'chatDay_yesterday',
    ...['sending', 'sent', 'read', 'failed'].map((status) => `chatStatus_${status}`),
    'loadingProgress', 'playVideo', 'videoLoadError',
  ];
  for (const locale of supportedLocales) for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
});
