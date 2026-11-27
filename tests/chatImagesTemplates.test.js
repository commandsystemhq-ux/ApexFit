import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPushMessage, NOTIFICATION_TYPES } from '../api/_lib/pushText.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  CHAT_IMAGE_BUCKET, CHAT_IMAGE_MAX_BYTES, baseImageMime, buildImagePath, extensionForImageMime, formatFileSize, isImageMessage, isSupportedImageMime, validateChatImage,
} from '../src/services/chatImageUtils.js';
import {
  STARTER_TEMPLATES, TEMPLATE_CATEGORIES, TEMPLATE_CATEGORY_KEYS, applyTemplate, friendlyClientName, groupTemplates, insertIntoDraft, starterPayloads, validateTemplate,
} from '../src/services/messageTemplateUtils.js';
import { describeLastMessage } from '../src/services/voiceUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = new URL('../supabase/migrations/20261115004400_chat_images_templates.sql', import.meta.url);

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  stranger: '00000000-0000-4000-8000-0000000000c9',
};
const FILE = '22222222-2222-4222-8222-222222222222';
const BUCKET = CHAT_IMAGE_BUCKET;

let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
async function ok(promise) {
  const result = await promise;
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}
async function refused(promise, pattern) {
  const result = await promise;
  assert.ok(result.error, 'expected the call to fail');
  assert.match(result.error.message, pattern);
}
const upload = (owner, name = `${owner}/${FILE}.jpg`) => db.query('insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)', [BUCKET, name, owner]);
const photo = (from, to, overrides = {}) => as(from).rpc('send_chat_image_message', {
  p_receiver_id: to, p_image_path: `${from}/${FILE}.jpg`, p_mime: 'image/jpeg', p_caption: 'Lunch', p_client_ref: FILE, ...overrides,
});

before(async () => {
  db = await createTestDatabase();
  await db.exec('grant select, insert, delete on storage.objects to authenticated');
});

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users; delete from storage.objects;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach', fullName: 'Coach Amal' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach', fullName: 'Coach Ben' });
  await addUser(db, { id: ids.sara, email: 'sara@example.com', role: 'client', fullName: 'Sara' });
  await addUser(db, { id: ids.stranger, email: 'x@example.com', role: 'client', fullName: 'Stranger' });
  await db.query("insert into public.coach_clients (coach_id, client_id, client_name, client_email) values ($1, $2, 'Sara', 'sara@example.com')", [ids.coach, ids.sara]);
});

// ------------------------------------------------------------------------------------------ photos in the chat

test('the migration is in manual-setup.sql, can run again, and the bucket is private with a 5 MB image-only limit', async () => {
  const migration = read('supabase/migrations/20261115004400_chat_images_templates.sql').replace(/\r\n/g, '\n').trim();
  assert.ok(read('supabase/manual-setup.sql').replace(/\r\n/g, '\n').includes(migration));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const [bucket] = await rows('select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1', [BUCKET]);
  assert.equal(bucket.public, false);
  assert.equal(Number(bucket.file_size_limit), CHAT_IMAGE_MAX_BYTES);
  assert.deepEqual([...bucket.allowed_mime_types].sort(), ['image/jpeg', 'image/png', 'image/webp']);
});

test('a client and the linked coach exchange photos with a caption, in both directions', async () => {
  await upload(ids.sara);
  const sent = await ok(photo(ids.sara, ids.coach));
  assert.equal(sent.message_type, 'image');
  assert.equal(sent.message_text, 'Lunch');
  assert.equal(sent.image_mime, 'image/jpeg');
  assert.equal(sent.audio_path, null);

  const page = await ok(as(ids.coach).rpc('get_chat_messages', { p_partner_id: ids.sara }));
  assert.equal(page.messages[0].image_path, `${ids.sara}/${FILE}.jpg`);
  assert.equal(page.messages[0].image_mime, 'image/jpeg');

  const second = '33333333-3333-4333-8333-333333333333';
  await upload(ids.coach, `${ids.coach}/${second}.png`);
  const back = await ok(photo(ids.coach, ids.sara, { p_image_path: `${ids.coach}/${second}.png`, p_mime: 'image/png', p_caption: '', p_client_ref: second }));
  assert.equal(back.message_text, '', 'a photo needs no caption');

  const list = await ok(as(ids.sara).rpc('get_chat_conversations'));
  assert.equal(list[0].last_type, 'image');
  assert.deepEqual(describeLastMessage(list[0]), { voice: false, image: true, text: '' });
});

test('sending the same photo twice stores one message; retries are safe', async () => {
  await upload(ids.sara);
  const first = await ok(photo(ids.sara, ids.coach));
  const second = await ok(photo(ids.sara, ids.coach));
  assert.equal(first.id, second.id);
  assert.equal((await rows("select count(*)::int as n from public.chat_messages where message_type = 'image'"))[0].n, 1);
});

test('the photo is checked: type, owner folder, file name, upload, link between the people, caption and rate', async () => {
  await upload(ids.sara);
  await refused(photo(ids.sara, ids.coach, { p_mime: 'image/gif' }), /JPG, PNG or WebP/);
  await refused(photo(ids.sara, ids.coach, { p_mime: 'application/pdf' }), /JPG, PNG or WebP/);
  await refused(photo(ids.sara, ids.coach, { p_image_path: `${ids.coach}/${FILE}.jpg` }), /not valid/);
  await refused(photo(ids.sara, ids.coach, { p_image_path: `${ids.sara}/../${FILE}.jpg` }), /not valid/);
  await refused(photo(ids.sara, ids.coach, { p_image_path: `${ids.sara}/photo.jpg` }), /not valid/);
  await refused(photo(ids.sara, ids.coach, { p_image_path: `${ids.sara}/${FILE}.exe` }), /not valid/);
  await refused(photo(ids.sara, ids.coach, { p_image_path: `${ids.sara}/44444444-4444-4444-8444-444444444444.jpg`, p_client_ref: null }), /not uploaded/);
  await refused(photo(ids.sara, ids.coach, { p_caption: 'x'.repeat(2001) }), /2000/);
  await refused(photo(ids.sara, ids.other), /only message your own coach/);
  await refused(photo(ids.stranger, ids.coach), /only message your own coach/);
  await db.query("update public.coach_clients set status = 'archived' where client_id = $1", [ids.sara]);
  await refused(photo(ids.sara, ids.coach), /only message your own coach/);
});

test('the database itself refuses a text message with a photo, or an image message without one', async () => {
  const bad = (sql) => assert.rejects(db.query(sql, [ids.sara, ids.coach]), /violates check constraint/);
  await bad("insert into public.chat_messages (sender_id, receiver_id, message_type, message_text, image_path, image_mime) values ($1, $2, 'text', 'hi', 'a/b.jpg', 'image/jpeg')");
  await bad("insert into public.chat_messages (sender_id, receiver_id, message_type, message_text) values ($1, $2, 'image', 'no file')");
  await bad("insert into public.chat_messages (sender_id, receiver_id, message_type, message_text, image_path, image_mime) values ($1, $2, 'image', '', 'a/b.gif', 'image/gif')");
  await bad("insert into public.chat_messages (sender_id, receiver_id, message_type, message_text, image_path, image_mime, audio_path, audio_duration_seconds, audio_mime) values ($1, $2, 'image', '', 'a/b.jpg', 'image/jpeg', 'a/c.webm', 5, 'audio/webm')");
});

test('only the two people in the conversation can read the photo file; only the sender can add or remove it', async () => {
  await upload(ids.sara);
  await ok(photo(ids.sara, ids.coach));
  const names = async (userId) => ((await as(userId).sql('select name from storage.objects where bucket_id = $1', [BUCKET])).rows || []).map((row) => row.name);
  assert.deepEqual(await names(ids.sara), [`${ids.sara}/${FILE}.jpg`]);
  assert.deepEqual(await names(ids.coach), [`${ids.sara}/${FILE}.jpg`]);
  assert.deepEqual(await names(ids.other), []);
  assert.deepEqual(await names(ids.stranger), []);

  const intruder = await as(ids.stranger).sql("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [BUCKET, `${ids.sara}/${'55555555-5555-4555-8555-555555555555'}.jpg`, ids.stranger]);
  assert.match(intruder.error.message, /row-level security/);
  const ownFile = await as(ids.stranger).sql('insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)', [BUCKET, `${ids.stranger}/${FILE}.png`, ids.stranger]);
  assert.equal(ownFile.error, null, ownFile.error?.message);
  await as(ids.coach).sql('delete from storage.objects where bucket_id = $1 and name = $2', [BUCKET, `${ids.sara}/${FILE}.jpg`]);
  assert.equal((await rows('select count(*)::int as n from storage.objects where name = $1', [`${ids.sara}/${FILE}.jpg`]))[0].n, 1, 'the receiver cannot delete it');
});

test('a photo notifies the receiver as a photo and has its own push text in every language', async () => {
  await upload(ids.sara);
  await ok(photo(ids.sara, ids.coach));
  const [note] = await rows("select payload from public.notifications where user_id = $1 and type = 'message'", [ids.coach]);
  assert.equal(note.payload.kind, 'image');
  assert.ok(NOTIFICATION_TYPES.includes('image'));
  for (const locale of supportedLocales) assert.ok(buildPushMessage('image', locale).title, locale);
  assert.match(buildPushMessage('image', 'ar').title, /[\u0600-\u06FF]/);
  assert.match(read('api/_lib/pushNotify.js'), /data\.message_type === 'voice' \|\| data\.message_type === 'image'/);
});

test('photo rules in the app match the database: types, 5 MB, folder and file name', () => {
  assert.deepEqual(['image/jpeg', 'image/png', 'image/webp'].map(isSupportedImageMime), [true, true, true]);
  assert.equal(isSupportedImageMime('image/gif'), false);
  assert.equal(isSupportedImageMime(''), false);
  assert.equal(baseImageMime('IMAGE/PNG; charset=x'), 'image/png');
  assert.deepEqual(['image/jpeg', 'image/png', 'image/webp'].map(extensionForImageMime), ['jpg', 'png', 'webp']);
  assert.equal(validateChatImage({ size: 1000, type: 'image/jpeg' }), null);
  assert.equal(validateChatImage({ size: CHAT_IMAGE_MAX_BYTES, type: 'image/webp' }), null);
  assert.equal(validateChatImage({ size: CHAT_IMAGE_MAX_BYTES + 1, type: 'image/png' }), 'chatImgErrTooBig');
  assert.equal(validateChatImage({ size: 1000, type: 'application/pdf' }), 'chatImgErrType');
  assert.equal(validateChatImage({ size: 0, type: 'image/png' }), 'chatImgErrEmpty');
  assert.equal(buildImagePath(ids.sara, FILE, 'image/jpeg;x=1'), `${ids.sara}/${FILE}.jpg`);
  assert.throws(() => buildImagePath(ids.sara, FILE, 'image/gif'), TypeError);
  assert.equal(isImageMessage({ message_type: 'image', image_path: 'a/b.jpg' }), true);
  assert.equal(isImageMessage({ message_type: 'text' }), false);
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(2048), '2 KB');
  assert.equal(formatFileSize(5 * 1024 * 1024), '5.0 MB');
});

test('the chat shows photos through signed links, enlarges them on a press and lets both sides attach them', () => {
  const service = read('src/services/chatImageService.js');
  assert.match(service, /createSignedUrl\(imagePath, CHAT_IMAGE_URL_SECONDS\)/);
  assert.match(read('src/services/chatImageUtils.js'), /CHAT_IMAGE_URL_SECONDS = 300/);
  const thread = read('src/components/ChatThread.jsx');
  assert.match(thread, /<ChatImage path=/);
  assert.match(thread, /accept=\{CHAT_IMAGE_ACCEPT\}/);
  assert.match(thread, /onPaste=\{onPaste\}/);
  assert.doesNotMatch(thread, /isClient &&[^\n]*chatImageAttach/, 'the attach button is not limited to one side');
  assert.match(read('src/components/ChatImage.jsx'), /ImageLightbox/);
  assert.match(read('src/components/ImageLightbox.jsx'), /Escape/);
});

// ------------------------------------------------------------------------------------------ message templates

const saveTemplate = (userId, { id = null, title = 'Welcome', category = 'welcome', body = 'Hi {client_name}!' } = {}) => as(userId).rpc('save_message_template', { p_id: id, p_title: title, p_category: category, p_body: body });

test('a coach creates, edits and deletes templates; names are unique per coach ignoring case', async () => {
  const id = await ok(saveTemplate(ids.coach, { title: '  Welcome  ' }));
  assert.deepEqual((await rows('select title, category, body from public.coach_message_templates where id = $1', [id]))[0], { title: 'Welcome', category: 'welcome', body: 'Hi {client_name}!' });
  await refused(saveTemplate(ids.coach, { title: 'welcome' }), /already exists/);
  await ok(saveTemplate(ids.other, { title: 'Welcome' }));
  assert.equal(await ok(saveTemplate(ids.coach, { id, title: 'Hello', category: 'custom', body: 'Hello {client_name}' })), id);
  assert.deepEqual((await rows('select title, category from public.coach_message_templates where id = $1', [id]))[0], { title: 'Hello', category: 'custom' });
  await ok(as(ids.coach).rpc('delete_message_template', { p_id: id }));
  assert.equal((await rows('select count(*)::int as n from public.coach_message_templates where coach_id = $1', [ids.coach]))[0].n, 0);
});

test('template input is validated and only the owner coach can use or read them', async () => {
  await refused(saveTemplate(ids.coach, { title: '   ' }), /between 1 and 60/);
  await refused(saveTemplate(ids.coach, { title: 'x'.repeat(61) }), /between 1 and 60/);
  await refused(saveTemplate(ids.coach, { body: '   ' }), /between 1 and 2000/);
  await refused(saveTemplate(ids.coach, { body: 'x'.repeat(2001) }), /between 1 and 2000/);
  await refused(saveTemplate(ids.coach, { category: 'spam' }), /valid template category/);
  await refused(saveTemplate(ids.sara), /active coach/);
  const theirs = await ok(saveTemplate(ids.other, { title: 'Private' }));
  await refused(saveTemplate(ids.coach, { id: theirs, title: 'Mine now' }), /not found/);
  await refused(as(ids.coach).rpc('delete_message_template', { p_id: theirs }), /not found/);
  assert.deepEqual((await as(ids.coach).from('coach_message_templates')).data, []);
  assert.deepEqual((await as(ids.sara).from('coach_message_templates')).data, []);
  assert.equal((await as(ids.other).from('coach_message_templates')).data.length, 1);
  const direct = await as(ids.coach).sql("insert into public.coach_message_templates (coach_id, title, body) values ($1, 'x', 'y')", [ids.coach]);
  assert.match(direct.error.message, /permission denied/);
  await db.query("insert into public.coach_message_templates (coach_id, title, body) select $1, 'T' || g, 'b' from generate_series(1, 50) g", [ids.coach]);
  await refused(saveTemplate(ids.coach, { title: 'One too many' }), /up to 50/);
});

test('{client_name} is replaced by the name of the person being written to, and nothing else is touched', () => {
  const template = { body: 'Hi {client_name}, see {other} and {client_name} again.' };
  assert.equal(applyTemplate(template, 'Sara Ali'), 'Hi Sara Ali, see {other} and Sara Ali again.');
  assert.equal(applyTemplate(template, 'sara@example.com'), 'Hi sara, see {other} and sara again.');
  assert.equal(applyTemplate('Hello {client_name}', '  Omar  '), 'Hello Omar');
  assert.equal(applyTemplate('Hello {client_name}', ''), 'Hello ');
  assert.equal(friendlyClientName(null), '');
  assert.equal(insertIntoDraft('', 'Hi'), 'Hi');
  assert.equal(insertIntoDraft('Already typed  ', 'Hi'), 'Already typed\nHi');
  assert.equal(insertIntoDraft('a'.repeat(1999), 'bcd'), `${'a'.repeat(1999)}\n`);
});

test('the template form is checked and the starter set is offered once, in the current language', () => {
  assert.equal(validateTemplate({ title: ' Cut ', category: 'diet', body: ' Hi ' }).valid, true);
  assert.deepEqual(validateTemplate({ title: ' Cut ', category: 'diet', body: ' Hi ' }).payload, { title: 'Cut', category: 'diet', body: 'Hi' });
  assert.deepEqual(Object.keys(validateTemplate({ title: '', category: 'x', body: '' }).errors).sort(), ['body', 'category', 'title']);
  assert.equal(validateTemplate({ title: 'x'.repeat(61), category: 'custom', body: 'b' }).errors.title, 'tplErrTitle');
  assert.deepEqual(STARTER_TEMPLATES.map((item) => item.category), ['welcome', 'encouragement', 'checkin', 'diet']);

  for (const locale of supportedLocales) {
    const t = (key) => translations[locale][key];
    const starters = starterPayloads(t, []);
    assert.equal(starters.length, 4, locale);
    for (const starter of starters) {
      assert.ok(starter.title && starter.body, locale);
      assert.match(starter.body, /\{client_name\}/, `${locale} starter keeps the placeholder`);
      assert.equal(validateTemplate(starter).valid, true, `${locale} ${starter.title}`);
    }
    assert.equal(starterPayloads(t, [starters[0].title.toUpperCase()]).length, 3);
    assert.equal(starterPayloads(t, starters.map((item) => item.title)).length, 0);
  }
  const grouped = groupTemplates([{ category: 'diet', id: 1 }, { category: 'welcome', id: 2 }, { category: 'diet', id: 3 }]);
  assert.deepEqual(grouped.map((group) => [group.category, group.items.length]), [['welcome', 1], ['diet', 2]]);
});

test('templates are in the chat box for coaches and in a Templates tab, with all texts in every language', () => {
  const thread = read('src/components/ChatThread.jsx');
  assert.match(thread, /\{!isClient && <MessageTemplatesPicker clientName=\{partner\.name\}/);
  assert.match(read('src/pages/MessagesPage.jsx'), /<MessageTemplatesManager \/>/);
  assert.match(read('src/pages/MessagesPage.jsx'), /id: 'templates', label: 'tplTab'/);
  for (const category of TEMPLATE_CATEGORIES) for (const locale of supportedLocales) assert.ok(translations[locale][TEMPLATE_CATEGORY_KEYS[category]], `${locale} ${category}`);
  const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  for (const key of Object.keys(translations.en).filter((name) => name.startsWith('tplStarter_'))) {
    for (const locale of supportedLocales) assert.equal(placeholders(translations[locale][key]), placeholders(translations.en[key]), `${locale} ${key}`);
  }
});
