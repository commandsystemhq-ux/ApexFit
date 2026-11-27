import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import { clientTagTranslations } from '../src/i18n/clientTagTranslations.js';
import {
  SUGGESTED_TAGS, TAG_COLORS, countByTag, emptyTagForm, filterClients, missingSuggestions, selectionTooLarge, tagsByClient, toggleTag, validateTagForm,
} from '../src/services/clientTagUtils.js';
import { addUser, createTestDatabase, createUserClient } from './helpers/pgliteSupabase.js';

const ids = {
  coach: '00000000-0000-4000-8000-0000000000a1',
  other: '00000000-0000-4000-8000-0000000000b1',
  sara: '00000000-0000-4000-8000-0000000000c1',
  omar: '00000000-0000-4000-8000-0000000000c2',
  lina: '00000000-0000-4000-8000-0000000000c3',
  foreign: '00000000-0000-4000-8000-0000000000c4',
};
let db;
const as = (userId) => createUserClient(db, userId);
const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const saveTag = (userId, { id = null, name = 'VIP', color = 'amber', kind = 'tag' } = {}) => as(userId).rpc('save_client_tag', { p_tag_id: id, p_name: name, p_color: color, p_kind: kind });
const newTag = async (userId, values) => {
  const result = await saveTag(userId, values);
  assert.equal(result.error, null, result.error?.message);
  return result.data;
};
const assign = (userId, clientId, tagIds) => as(userId).sql('select public.set_client_tags($1, $2::uuid[])', [clientId, tagIds]);

before(async () => { db = await createTestDatabase(); });

beforeEach(async () => {
  await db.exec('truncate public.profiles cascade; delete from auth.users;');
  await addUser(db, { id: ids.coach, email: 'amal@example.com', role: 'coach' });
  await addUser(db, { id: ids.other, email: 'ben@example.com', role: 'coach' });
  for (const [id, email] of [[ids.sara, 'sara@example.com'], [ids.omar, 'omar@example.com'], [ids.lina, 'lina@example.com'], [ids.foreign, 'foreign@example.com']]) await addUser(db, { id, email, role: 'client' });
  await db.query(
    `insert into public.coach_clients (coach_id, client_id, client_name, client_email) values
       ($1, $2, 'Sara Ali', 'sara@example.com'), ($1, $3, 'Omar Hassan', 'omar@example.com'), ($1, $4, 'Lina Noor', 'lina@example.com'), ($5, $6, 'Other Client', 'foreign@example.com')`,
    [ids.coach, ids.sara, ids.omar, ids.lina, ids.other, ids.foreign],
  );
});

// ------------------------------------------------------------------------------------------ the database

test('a coach creates, renames and deletes tags; names are unique per coach ignoring case', async () => {
  const vip = await newTag(ids.coach, { name: '  VIP  ' });
  assert.deepEqual((await rows('select name, color, kind from public.client_tags where id = $1', [vip]))[0], { name: 'VIP', color: 'amber', kind: 'tag' });
  assert.match((await saveTag(ids.coach, { name: 'vip' })).error.message, /already exists/);
  await newTag(ids.other, { name: 'VIP' });
  assert.equal(await newTag(ids.coach, { id: vip, name: 'Gold', color: 'pink' }), vip);
  assert.deepEqual((await rows('select name, color from public.client_tags where id = $1', [vip]))[0], { name: 'Gold', color: 'pink' });
  assert.equal((await as(ids.coach).rpc('delete_client_tag', { p_tag_id: vip })).error, null);
  assert.equal((await rows('select count(*)::int as n from public.client_tags where coach_id = $1', [ids.coach]))[0].n, 0);
});

test('tag input is validated: name, colour, kind, owner, limit and role', async () => {
  assert.match((await saveTag(ids.coach, { name: '   ' })).error.message, /between 1 and 30/);
  assert.match((await saveTag(ids.coach, { name: 'x'.repeat(31) })).error.message, /between 1 and 30/);
  assert.match((await saveTag(ids.coach, { color: 'black' })).error.message, /colour/);
  assert.match((await saveTag(ids.coach, { kind: 'group' })).error.message, /tag or type/);
  assert.match((await saveTag(ids.sara)).error.message, /active coach/);
  const theirs = await newTag(ids.other, { name: 'Private' });
  assert.match((await saveTag(ids.coach, { id: theirs, name: 'Mine now' })).error.message, /not found/);
  assert.match((await as(ids.coach).rpc('delete_client_tag', { p_tag_id: theirs })).error.message, /not found/);
  await db.query(`insert into public.client_tags (coach_id, name) select $1, 'T' || g from generate_series(1, 40) g`, [ids.coach]);
  assert.match((await saveTag(ids.coach, { name: 'One too many' })).error.message, /up to 40/);
});

test('tags are given to clients, replaced as a set and read back by the coach only', async () => {
  const vip = await newTag(ids.coach, { name: 'VIP' });
  const cutting = await newTag(ids.coach, { name: 'Cutting', color: 'red' });
  const online = await newTag(ids.coach, { name: 'Online', color: 'blue', kind: 'type' });
  assert.equal((await assign(ids.coach, ids.sara, [vip, online, vip])).error, null);
  assert.equal((await assign(ids.coach, ids.omar, [cutting])).error, null);
  const seen = (await as(ids.coach).from('client_tag_assignments')).data;
  assert.deepEqual(seen.map((row) => [row.client_id, row.tag_id]).sort(), [[ids.omar, cutting], [ids.sara, online], [ids.sara, vip]].sort());
  assert.equal((await assign(ids.coach, ids.sara, [cutting])).error, null);
  assert.deepEqual((await rows('select tag_id from public.client_tag_assignments where client_id = $1', [ids.sara])).map((row) => row.tag_id), [cutting]);
  assert.equal((await assign(ids.coach, ids.sara, [])).error, null);
  assert.equal((await rows('select count(*)::int as n from public.client_tag_assignments where client_id = $1', [ids.sara]))[0].n, 0);
  assert.deepEqual((await as(ids.other).from('client_tag_assignments')).data, []);
  assert.deepEqual((await as(ids.other).from('client_tags')).data, []);
  assert.deepEqual((await as(ids.sara).from('client_tags')).data, [], 'a client never sees the coach tags');
  assert.deepEqual((await as(ids.sara).from('client_tag_assignments')).data, []);
});

test('a client has at most one type and at most ten tags, and only the coach own tags and clients', async () => {
  const online = await newTag(ids.coach, { name: 'Online', kind: 'type' });
  const inPerson = await newTag(ids.coach, { name: 'In-person', kind: 'type' });
  assert.match((await assign(ids.coach, ids.sara, [online, inPerson])).error.message, /only one type/);
  const many = [];
  for (let index = 0; index < 11; index += 1) many.push(await newTag(ids.coach, { name: `T${index}` }));
  assert.match((await assign(ids.coach, ids.sara, many)).error.message, /up to 10/);
  const foreignTag = await newTag(ids.other, { name: 'Theirs' });
  assert.match((await assign(ids.coach, ids.sara, [foreignTag])).error.message, /Tag was not found/);
  assert.match((await assign(ids.coach, ids.foreign, [online])).error.message, /Client was not found/);
  assert.match((await assign(ids.other, ids.sara, [foreignTag])).error.message, /Client was not found/);
  assert.match((await assign(ids.sara, ids.sara, [online])).error.message, /active coach/);
  const direct = await as(ids.coach).sql('insert into public.client_tag_assignments (coach_id, client_id, tag_id) values ($1, $2, $3)', [ids.coach, ids.sara, online]);
  assert.ok(direct.error, 'direct writes are refused');
});

test('deleting a tag removes it from every client, and the kind of a tag in use cannot change', async () => {
  const vip = await newTag(ids.coach, { name: 'VIP' });
  await assign(ids.coach, ids.sara, [vip]);
  await assign(ids.coach, ids.omar, [vip]);
  assert.match((await saveTag(ids.coach, { id: vip, name: 'VIP', kind: 'type' })).error.message, /before changing its kind/);
  await as(ids.coach).rpc('delete_client_tag', { p_tag_id: vip });
  assert.equal((await rows('select count(*)::int as n from public.client_tag_assignments'))[0].n, 0);
  const unused = await newTag(ids.coach, { name: 'Unused' });
  assert.equal(await newTag(ids.coach, { id: unused, name: 'Unused', kind: 'type' }), unused);
});

test('removing a client from the coach removes their tags', async () => {
  const vip = await newTag(ids.coach, { name: 'VIP' });
  await assign(ids.coach, ids.sara, [vip]);
  await db.query('delete from public.coach_clients where client_id = $1', [ids.sara]);
  assert.equal((await rows('select count(*)::int as n from public.client_tag_assignments'))[0].n, 0);
});

// ------------------------------------------------------------------------------------------ the helpers

const tags = [
  { id: 't-vip', name: 'VIP', color: 'amber', kind: 'tag' },
  { id: 't-cut', name: 'Cutting', color: 'red', kind: 'tag' },
  { id: 't-online', name: 'Online', color: 'blue', kind: 'type' },
  { id: 't-person', name: 'In-person', color: 'teal', kind: 'type' },
];
const clients = [
  { client_id: 'sara', client_name: 'Sara Ali', client_email: 'sara@example.com' },
  { client_id: 'omar', client_name: 'Omar Hassan', client_email: 'omar@example.com' },
  { client_id: 'lina', client_name: 'لينا نور', client_email: 'lina@example.com' },
];
const assignments = [
  { client_id: 'sara', tag_id: 't-cut' }, { client_id: 'sara', tag_id: 't-online' }, { client_id: 'sara', tag_id: 't-vip' },
  { client_id: 'omar', tag_id: 't-person' }, { client_id: 'omar', tag_id: 't-cut' },
  { client_id: 'lina', tag_id: 't-online' }, { client_id: 'ghost', tag_id: 't-vip' }, { client_id: 'lina', tag_id: 'deleted' },
];
const map = tagsByClient(assignments, tags);
const names = (list) => list.map((client) => client.client_id);

test('a client list shows the type first and then the tags by name; unknown tags are ignored', () => {
  assert.deepEqual(map.get('sara').map((tag) => tag.name), ['Online', 'Cutting', 'VIP']);
  assert.deepEqual(map.get('lina').map((tag) => tag.name), ['Online']);
  assert.deepEqual([...countByTag(assignments)].sort(), [['deleted', 1], ['t-cut', 2], ['t-online', 2], ['t-person', 1], ['t-vip', 2]]);
});

test('filters: by type, by tags (all of them) and by words in the name, e-mail or tags', () => {
  assert.deepEqual(names(filterClients(clients, {}, map)), ['sara', 'omar', 'lina']);
  assert.deepEqual(names(filterClients(clients, { typeId: 't-online' }, map)), ['sara', 'lina']);
  assert.deepEqual(names(filterClients(clients, { tagIds: ['t-cut'] }, map)), ['sara', 'omar']);
  assert.deepEqual(names(filterClients(clients, { tagIds: ['t-cut', 't-vip'] }, map)), ['sara']);
  assert.deepEqual(names(filterClients(clients, { typeId: 't-online', tagIds: ['t-cut'] }, map)), ['sara']);
  assert.deepEqual(names(filterClients(clients, { query: 'hassan' }, map)), ['omar']);
  assert.deepEqual(names(filterClients(clients, { query: 'LINA@' }, map)), ['lina']);
  assert.deepEqual(names(filterClients(clients, { query: 'in-person' }, map)), ['omar']);
  assert.deepEqual(names(filterClients(clients, { query: 'cutting ali' }, map)), ['sara']);
  assert.deepEqual(names(filterClients(clients, { query: 'نور' }, map)), ['lina']);
  assert.deepEqual(names(filterClients(clients, { query: 'nobody' }, map)), []);
});

test('choosing a type replaces the previous type, choosing a tag adds it and choosing it again removes it', () => {
  assert.deepEqual(toggleTag(['t-vip'], tags[2], tags), ['t-vip', 't-online']);
  assert.deepEqual(toggleTag(['t-vip', 't-online'], tags[3], tags), ['t-vip', 't-person']);
  assert.deepEqual(toggleTag(['t-vip', 't-online'], tags[2], tags), ['t-vip']);
  assert.deepEqual(toggleTag([], tags[1], tags), ['t-cut']);
  assert.equal(selectionTooLarge(Array.from({ length: 11 }, (_, index) => `t${index}`)), true);
  assert.equal(selectionTooLarge(Array.from({ length: 10 }, (_, index) => `t${index}`)), false);
});

test('the tag form is checked and the suggested tags skip those the coach already has', () => {
  assert.equal(validateTagForm(emptyTagForm()).ok, false);
  assert.deepEqual(validateTagForm({ name: '', color: 'x', kind: 'y' }).errors, { name: 'tgErr_name', color: 'tgErr_color', kind: 'tgErr_kind' });
  assert.deepEqual(validateTagForm({ name: '  VIP ', color: 'amber', kind: 'tag' }).payload, { name: 'VIP', color: 'amber', kind: 'tag' });
  const label = (key) => translations.en[`tgPreset_${key}`];
  assert.equal(missingSuggestions([], label).length, SUGGESTED_TAGS.length);
  assert.deepEqual(missingSuggestions([{ name: 'vip' }, { name: 'ONLINE' }], label).map((item) => item.key), ['inPerson', 'cutting', 'bulking', 'special']);
  assert.ok(SUGGESTED_TAGS.every((item) => TAG_COLORS.includes(item.color)));
});

// ------------------------------------------------------------------------------------------ the screens

test('every tag text exists in all five languages and is merged into the app dictionary', () => {
  const keys = Object.keys(clientTagTranslations.en).sort();
  for (const locale of supportedLocales) {
    assert.deepEqual(Object.keys(clientTagTranslations[locale]).sort(), keys, locale);
    for (const key of keys) assert.equal(translations[locale][key], clientTagTranslations[locale][key], `${locale}.${key}`);
    for (const color of TAG_COLORS) assert.ok(translations[locale][`tgColor_${color}`], `${locale}.${color}`);
  }
  assert.equal(translations.ar.tgPreset_special, 'متابعة خاصة');
  assert.equal(translations.ar.tgPreset_cutting, 'تنشيف');
  assert.equal(translations.ar.tgPreset_bulking, 'تضخيم');
});

test('the clients page has the filters, the tag badges, the editor and the manager; the colours exist in the stylesheet', () => {
  const page = read('src/pages/ClientsPage.jsx');
  for (const piece of ['<ClientTagFilters', '<ClientTagBadge key={tag.id} tag={tag} />', '<ClientTagEditor', '<ClientTagManager', 'filterClients(trainerClients, tagFilters, tagMap)']) assert.ok(page.includes(piece), piece);
  const css = read('src/styles/app.css');
  for (const color of TAG_COLORS) assert.match(css, new RegExp(`\\.tag-color-${color} \\{ --tag-color`), color);
  assert.ok(read('supabase/manual-setup.sql').includes('-- ===== 20261115004200_client_tags.sql ====='));
});
