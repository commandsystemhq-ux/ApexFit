import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPushMessage, NOTIFICATION_TYPES } from '../api/_lib/pushText.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  VOICE_MAX_BYTES, VOICE_MAX_SECONDS, baseMime, buildAudioPath, canRecordVoice, describeLastMessage, extensionForMime, formatVoiceDuration, isSupportedVoiceMime,
  microphoneErrorKey, pickRecorderMime, validateRecording,
} from '../src/services/voiceUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const MIGRATION = new URL('../supabase/migrations/20261115002600_chat_voice_messages.sql', import.meta.url);
const MANUAL_SETUP = new URL('../supabase/manual-setup.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  otherCoach: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  stranger: '00000000-0000-4000-8000-0000000000c9',
};
const FILE = '11111111-1111-4111-8111-111111111111';
const BUCKET = 'apexfit-chat-audio';

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const upload = (owner, name = `${owner}/${FILE}.webm`) => db.query('insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)', [BUCKET, name, owner]);
const voice = (from, to, overrides = {}) => as(from).rpc('send_chat_voice_message', {
  p_receiver_id: to, p_audio_path: `${from}/${FILE}.webm`, p_duration: 12, p_mime: 'audio/webm;codecs=opus', p_client_ref: FILE, ...overrides,
});

before(async () => {
  db = await createTestDatabase();
  // Supabase gives the authenticated role access to storage.objects; the row-level policies then decide. The test stub does not.
  await db.exec('grant select, insert, delete on storage.objects to authenticated');
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users; delete from storage.objects;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.otherCoach, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client' });
  await addUser(db, { id: ids.stranger, email: 'x@example.com', role: 'client' });
  await db.query(
    "insert into public.coach_clients (coach_id, client_id, client_name, client_email, coach_name, coach_email) values ($1, $2, 'Sara', 'sara@example.com', 'Amal', 'amal@example.com')",
    [ids.coach, ids.sara],
  );
});

test('the migration is in manual-setup.sql, can run again, and the bucket is private with a 10 MB audio-only limit', async () => {
  const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(readFileSync(MANUAL_SETUP, 'utf8').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const [bucket] = await rows('select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1', [BUCKET]);
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), VOICE_MAX_BYTES);
  assert.deepEqual([...bucket.allowed_mime_types].sort(), ['audio/mp4', 'audio/ogg', 'audio/webm']);
});

test('a client and the linked coach exchange voice messages in both directions', async () => {
  await upload(ids.sara);
  const sent = await voice(ids.sara, ids.coach);
  assert.equal(sent.error, null, sent.error?.message);
  assert.equal(sent.data.message_type, 'voice');
  assert.equal(sent.data.audio_duration_seconds, 12);
  assert.equal(sent.data.audio_mime, 'audio/webm');
  assert.equal(sent.data.message_text, '');

  const coachPage = await as(ids.coach).rpc('get_chat_messages', { p_partner_id: ids.sara });
  assert.equal(coachPage.data.messages[0].audio_path, `${ids.sara}/${FILE}.webm`);

  await upload(ids.coach, `${ids.coach}/22222222-2222-4222-8222-222222222222.mp4`);
  const reply = await voice(ids.coach, ids.sara, { p_audio_path: `${ids.coach}/22222222-2222-4222-8222-222222222222.mp4`, p_mime: 'audio/mp4', p_client_ref: '22222222-2222-4222-8222-222222222222' });
  assert.equal(reply.error, null, reply.error?.message);
  const list = await as(ids.sara).rpc('get_chat_conversations');
  assert.equal(list.data[0].last_type, 'voice');
  assert.equal(list.data[0].unread_count, 1);
});

test('sending the same voice message again stores it once', async () => {
  await upload(ids.sara);
  const first = await voice(ids.sara, ids.coach);
  const second = await voice(ids.sara, ids.coach);
  assert.equal(second.data.id, first.data.id);
  assert.equal((await rows('select count(*)::int as n from public.chat_messages'))[0].n, 1);
});

test('bad requests are refused: strangers, wrong length, format, path, missing file', async () => {
  await upload(ids.stranger);
  assert.match((await voice(ids.stranger, ids.coach)).error.message, /only message your own coach/);

  await upload(ids.sara);
  assert.match((await voice(ids.sara, ids.coach, { p_duration: 0 })).error.message, /1 to 120 seconds/);
  assert.match((await voice(ids.sara, ids.coach, { p_duration: VOICE_MAX_SECONDS + 1 })).error.message, /1 to 120 seconds/);
  assert.match((await voice(ids.sara, ids.coach, { p_mime: 'audio/wav' })).error.message, /not supported/);
  assert.match((await voice(ids.sara, ids.coach, { p_audio_path: `${ids.stranger}/${FILE}.webm` })).error.message, /not valid/);
  assert.match((await voice(ids.sara, ids.coach, { p_audio_path: `${ids.sara}/../${FILE}.webm` })).error.message, /not valid/);
  assert.match((await voice(ids.sara, ids.coach, { p_audio_path: `${ids.sara}/33333333-3333-4333-8333-333333333333.webm` })).error.message, /was not uploaded/);
  assert.equal((await rows('select count(*)::int as n from public.chat_messages'))[0].n, 0);
});

test('chat rows cannot be forged directly and text messages still work with their limits', async () => {
  await upload(ids.sara);
  const direct = await as(ids.sara).sql(
    "insert into public.chat_messages (sender_id, receiver_id, message_type, message_text, audio_path, audio_duration_seconds, audio_mime) values ($1, $2, 'voice', '', 'x', 5, 'audio/webm')",
    [ids.sara, ids.coach],
  );
  assert.ok(direct.error);

  const text = await as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: 'hello' });
  assert.equal(text.data.message_type, 'text');
  const empty = await as(ids.sara).rpc('send_chat_message', { p_receiver_id: ids.coach, p_text: '   ' });
  assert.ok(empty.error);
  assert.ok((await db.query("select 1").then(() => db.query("insert into public.chat_messages (sender_id, receiver_id, message_type, message_text) values ($1, $2, 'voice', 'hi')", [ids.sara, ids.coach]).then(() => false, () => true))));
});

test('only the two people in the conversation can read the audio file', async () => {
  await upload(ids.sara);
  await voice(ids.sara, ids.coach);
  const select = (userId) => as(userId).sql('select name from storage.objects where bucket_id = $1', [BUCKET]);
  const names = async (userId) => (await select(userId)).rows.map((row) => row.name);
  assert.deepEqual(await names(ids.sara), [`${ids.sara}/${FILE}.webm`]);
  assert.deepEqual(await names(ids.coach), [`${ids.sara}/${FILE}.webm`]);
  assert.deepEqual(await names(ids.otherCoach), []);
  assert.deepEqual(await names(ids.stranger), []);
});

test('people can upload only into their own folder', async () => {
  const insert = (userId, folder) => as(userId).sql(
    "insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)",
    [BUCKET, `${folder}/${FILE}.webm`, userId],
  );
  assert.equal((await insert(ids.sara, ids.sara)).error, null);
  assert.ok((await insert(ids.sara, ids.coach)).error);
});

test('browser recording helpers pick a format, enforce the limits and name files', () => {
  assert.equal(pickRecorderMime((type) => type === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickRecorderMime((type) => type.startsWith('audio/webm')), 'audio/webm;codecs=opus');
  assert.equal(pickRecorderMime(() => false), '');
  assert.equal(pickRecorderMime(undefined), '');
  assert.equal(baseMime('Audio/WebM;codecs=opus'), 'audio/webm');
  assert.equal(extensionForMime('audio/mp4'), 'mp4');
  assert.equal(isSupportedVoiceMime('audio/wav'), false);
  assert.equal(formatVoiceDuration(75.4), '1:15');
  assert.equal(formatVoiceDuration(-3), '0:00');
  assert.equal(buildAudioPath(ids.sara, FILE, 'audio/webm;codecs=opus'), `${ids.sara}/${FILE}.webm`);
  assert.throws(() => buildAudioPath(ids.sara, FILE, 'audio/wav'), TypeError);

  const good = { bytes: 5000, seconds: 10, mime: 'audio/webm' };
  assert.equal(validateRecording(good), null);
  assert.equal(validateRecording({ ...good, seconds: 0 }), 'voiceErrTooShort');
  assert.equal(validateRecording({ ...good, bytes: 0 }), 'voiceErrTooShort');
  assert.equal(validateRecording({ ...good, seconds: 121 }), 'voiceErrTooLong');
  assert.equal(validateRecording({ ...good, bytes: VOICE_MAX_BYTES + 1 }), 'voiceErrTooBig');
  assert.equal(validateRecording({ ...good, mime: 'audio/wav' }), 'voiceErrFormat');
});

test('microphone problems map to clear messages and unsupported browsers are detected', () => {
  assert.equal(microphoneErrorKey({ name: 'NotAllowedError' }), 'voiceErrDenied');
  assert.equal(microphoneErrorKey({ name: 'NotFoundError' }), 'voiceErrNoMic');
  assert.equal(microphoneErrorKey({ name: 'NotReadableError' }), 'voiceErrBusy');
  assert.equal(microphoneErrorKey(new Error('x')), 'voiceErrUnsupported');
  assert.equal(canRecordVoice({ navigator: {} }), false);
  assert.equal(canRecordVoice({ navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: class {} }), true);
  assert.deepEqual(describeLastMessage({ last_type: 'voice', last_text: '' }), { voice: true, text: '' });
  assert.deepEqual(describeLastMessage({ last_type: 'text', last_text: 'hi' }), { voice: false, text: 'hi' });
});

test('every language has the voice texts and the chat push messages', () => {
  const keys = ['voiceRecord', 'voiceStop', 'voiceCancel', 'voiceDiscard', 'voiceRecording', 'voiceAllowMic', 'voicePlay', 'voicePause', 'voiceProgress', 'voicePlayError', 'voiceMessage',
    'voiceErrDenied', 'voiceErrNoMic', 'voiceErrBusy', 'voiceErrUnsupported', 'voiceErrFormat', 'voiceErrTooShort', 'voiceErrTooLong', 'voiceErrTooBig', 'voiceErrUpload'];
  for (const locale of supportedLocales) {
    for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
    for (const type of ['chat', 'voice']) assert.ok(buildPushMessage(type, locale).title, `${locale}.${type}`);
  }
  assert.match(translations.ar.voiceErrDenied, /[\u0600-\u06FF]/);
  assert.ok(NOTIFICATION_TYPES.includes('voice'));
});

test('the push endpoint only tells the other person about the sender\'s own message', () => {
  const source = readFileSync(new URL('../api/_lib/pushNotify.js', import.meta.url), 'utf8');
  assert.match(source, /\.eq\('sender_id', user\.id\)/);
  assert.match(readFileSync(new URL('../api/push.js', import.meta.url), 'utf8'), /notifyChatMessage\(context, requireUuid/);
});
