import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { ConfigError } from '../api/_lib/config.js';
import { HttpError } from '../api/_lib/http.js';
import {
  addDays, buildTaskEvent, describeTarget, endOf, firstOccurrence, isIsoDay, isValidTimeZone, taskEventId, weekdayOf,
} from '../api/_lib/checklistCalendar.js';
import {
  INTEGRATION_PROVIDERS, configuredProviders, createIntegrationStore, envCredentials, handleIntegrationsRequest, redirectUriFor, resolveCredentials,
} from '../api/_lib/platformIntegrations.js';
import { decryptSecret } from '../api/_lib/crypto.js';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { PAGES, ADMIN_PATHS, navigationFor } from '../src/routes.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  ALL_DAYS, calendarIdsFor, dayCompletion, emptyTaskForm, formatAmount, groupItems, itemPercent, parseAmount, quickSteps, replaceItem, streakOf, suggestedTasks,
  toggled, validateTaskForm, withAmount,
} from '../src/services/checklistUtils.js';
import { quickPromptKeys, WRITE_TOOLS } from '../src/services/jackUtils.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ the task form

test('the task form is validated and turned into what the database expects', () => {
  const good = validateTaskForm({ category: 'water', title: '  Drink water ', target: '2,5', unit: ' L ', time: '09:30', repeat: 'daily', days: [], calendar: true });
  assert.equal(good.valid, true);
  assert.deepEqual(good.payload, { category: 'water', title: 'Drink water', target: 2.5, unit: 'L', remindTime: '09:30', repeatDays: ALL_DAYS, calendarSync: true });

  const once = validateTaskForm({ ...emptyTaskForm(), title: 'Call the coach', repeat: 'once' });
  assert.deepEqual([once.valid, once.payload.repeatDays, once.payload.target, once.payload.remindTime], [true, null, null, null]);
  const days = validateTaskForm({ ...emptyTaskForm(), title: 'Run', repeat: 'days', days: [3, 1, 3, 9, '5'] });
  assert.deepEqual(days.payload.repeatDays, [1, 3, 5], 'sorted, unique and only real weekdays');

  const bad = validateTaskForm({ category: 'sleep', title: ' ', target: '-2', unit: 'u'.repeat(21), time: '25:00', repeat: 'days', days: [], calendar: true });
  assert.deepEqual(bad.errors, { category: 'chkErrCategory', title: 'chkErrTitle', target: 'chkErrTarget', unit: 'chkErrUnit', time: 'chkErrTime', days: 'chkErrDays' }, 'an invalid time is reported as such');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x'.repeat(121) }).errors.title, 'chkErrTitleLong');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x', target: 'abc' }).errors.target, 'chkErrTarget');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x', target: '100001' }).errors.target, 'chkErrTarget');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x', calendar: true }).errors.calendar, 'chkErrCalendarTime');
  assert.deepEqual([parseAmount(''), parseAmount('1,5'), parseAmount('12.25')], [null, 1.5, 12.25]);
  assert.ok(Number.isNaN(parseAmount('1.234')));
  assert.deepEqual([emptyTaskForm('water').target, emptyTaskForm('water').unit], ['2500', 'ml']);
});

test('the suggested tasks are valid in every language', () => {
  for (const locale of supportedLocales) {
    const t = (key) => translations[locale][key];
    const tasks = suggestedTasks(t);
    assert.deepEqual(tasks.map((task) => task.category), ['workout', 'meal', 'water', 'habit']);
    for (const task of tasks) assert.equal(validateTaskForm(task).valid, true, `${locale} ${task.category}`);
    assert.equal(validateTaskForm(tasks[2]).payload.target, 2500);
  }
});

// ------------------------------------------------------------------ progress arithmetic

const item = (extra = {}) => ({ id: 'a', title: 'Task', category: 'custom', is_done: false, target_amount: null, progress_amount: 0, unit: null, ...extra });

test('checking and adding amounts follow the same rules as the database', () => {
  const water = item({ category: 'water', target_amount: 2000, unit: 'ml' });
  assert.deepEqual([toggled(water, true).progress_amount, toggled(water, true).is_done], [2000, true]);
  assert.deepEqual([toggled(toggled(water, true), false).progress_amount, toggled(toggled(water, true), false).is_done], [0, false]);
  assert.equal(toggled(withAmount(water, 600), false).progress_amount, 600);
  assert.deepEqual([toggled(item(), true).is_done, toggled(item(), true).progress_amount], [true, 0]);

  assert.equal(withAmount(water, 500).progress_amount, 500);
  assert.deepEqual([withAmount(withAmount(water, 1750), 250).is_done, withAmount(withAmount(water, 1750), 250).progress_amount], [true, 2000]);
  assert.equal(withAmount(withAmount(water, 2000), -300).is_done, false);
  assert.equal(withAmount(water, -50).progress_amount, 0);
  assert.equal(withAmount(item({ is_done: true }), 5).is_done, true, 'a task without a target keeps its state');
  assert.deepEqual([quickSteps(water), quickSteps(item({ category: 'water', unit: 'L' })), quickSteps(item())], [[250, 500], [0.25, 0.5], [1]]);
  assert.deepEqual([formatAmount(2500), formatAmount(0.25), formatAmount(1.5), formatAmount('x')], ['2500', '0.25', '1.5', '0']);
});

test('the day\'s progress, grouping and streak', () => {
  const items = [
    item({ id: '1', category: 'meal', is_done: true }),
    item({ id: '2', category: 'workout' }),
    item({ id: '3', category: 'water', target_amount: 2000, progress_amount: 500 }),
    item({ id: '4', category: 'custom', is_done: true }),
  ];
  assert.deepEqual(dayCompletion(items), { total: 4, done: 2, left: 2, percent: 50 });
  assert.deepEqual(dayCompletion([]), { total: 0, done: 0, left: 0, percent: 0 });
  assert.deepEqual(groupItems(items).map((group) => [group.category, group.items.length]), [['workout', 1], ['meal', 1], ['water', 1], ['custom', 1]], 'in the usual order, empty groups left out');
  assert.deepEqual([itemPercent(items[2]), itemPercent(items[0]), itemPercent(items[1]), itemPercent(item({ target_amount: 100, progress_amount: 250 }))], [25, 100, 0, 100]);
  assert.equal(replaceItem(items, { id: '2', is_done: true })[1].is_done, true);
  assert.deepEqual(calendarIdsFor({ id: 'e', template_id: 't' }), { templateIds: ['t'], entryIds: [] });
  assert.deepEqual(calendarIdsFor({ id: 'e', template_id: null }), { templateIds: [], entryIds: ['e'] });

  const day = (date, done, total) => ({ date, done, total });
  assert.equal(streakOf([day('2026-11-14', 2, 2), day('2026-11-15', 3, 3), day('2026-11-16', 1, 1), day('2026-11-17', 1, 4)]), 3, 'today unfinished does not break it');
  assert.equal(streakOf([day('2026-11-15', 3, 3), day('2026-11-16', 0, 2), day('2026-11-17', 2, 2)]), 1);
  assert.equal(streakOf([day('2026-11-16', 2, 2), day('2026-11-17', 2, 2)]), 2);
  assert.equal(streakOf([day('2026-11-16', 0, 0), day('2026-11-17', 0, 0)]), 0, 'days without tasks are not days done');
  assert.equal(streakOf([]), 0);
});

// ---------------------------------------------------------- Google Calendar events

const WATER = { id: '3f2b8a4e-1c6d-4e7f-9a0b-123456789abc', kind: 'template', title: 'Drink water', category: 'water', target_amount: 2500, unit: 'ml', remind_time: '09:30:00', days_of_week: ALL_DAYS };

test('a repeating task becomes one repeating event with a reminder', () => {
  const event = buildTaskEvent(WATER, { timeZone: 'Africa/Cairo', today: '2026-11-18' });
  assert.equal(event.id, '3f2b8a4e1c6d4e7f9a0b123456789abc');
  assert.match(event.id, /^[a-v0-9]{5,}$/, 'a valid Google event id');
  assert.equal(event.id, taskEventId(WATER.id));
  assert.deepEqual(event.start, { dateTime: '2026-11-18T09:30:00', timeZone: 'Africa/Cairo' });
  assert.deepEqual(event.end, { dateTime: '2026-11-18T10:00:00', timeZone: 'Africa/Cairo' });
  assert.deepEqual(event.recurrence, ['RRULE:FREQ=DAILY']);
  assert.deepEqual(event.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
  assert.equal(event.summary, '\u{1F4A7} Drink water');
  assert.equal(event.description, 'Target: 2500 ml\nAdded by ApexFit');
  assert.equal(event.extendedProperties.private.apexfitTaskId, WATER.id);
});

test('weekday tasks start on their first matching day and repeat on those weekdays', () => {
  // 2026-11-18 is a Wednesday (3).
  assert.equal(weekdayOf('2026-11-18'), 3);
  const event = buildTaskEvent({ ...WATER, title: 'Run', category: 'workout', target_amount: null, days_of_week: [1, 5] }, { timeZone: 'Europe/Berlin', today: '2026-11-18' });
  assert.equal(event.start.dateTime, '2026-11-20T09:30:00', 'the next Friday');
  assert.deepEqual(event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,FR']);
  assert.equal(event.description, 'Added by ApexFit');
  assert.equal(firstOccurrence('2026-11-18', [3]), '2026-11-18');
  assert.equal(firstOccurrence('2026-11-18', [2]), '2026-11-24');
  assert.equal(buildTaskEvent({ ...WATER, days_of_week: [0, 6] }, { timeZone: 'UTC', today: '2026-11-18' }).recurrence[0], 'RRULE:FREQ=WEEKLY;BYDAY=SU,SA');
});

test('a one-off task becomes one event on its day, and an event can end after midnight', () => {
  const event = buildTaskEvent({ id: 'b2b8a4e1-c6d4-4e7f-9a0b-123456789abc', kind: 'entry', title: 'Late stretch', category: 'habit', remind_time: '23:45', task_date: '2026-11-18' }, { timeZone: 'UTC', today: '2026-11-18' });
  assert.equal(event.recurrence, undefined);
  assert.deepEqual([event.start.dateTime, event.end.dateTime], ['2026-11-18T23:45:00', '2026-11-19T00:15:00']);
  assert.deepEqual(endOf('2026-12-31', '23:50', 30), { day: '2027-01-01', time: '00:20' });
  assert.deepEqual(endOf('2026-11-18', '08:00', 45), { day: '2026-11-18', time: '08:45' });
  assert.equal(describeTarget({ target_amount: 2.5, unit: 'L' }), '2.5 L');
  assert.equal(describeTarget({ target_amount: 10, unit: null }), '10');
  assert.equal(describeTarget({ target_amount: null }), '');
});

test('events are refused for bad input rather than guessed', () => {
  const options = { timeZone: 'UTC', today: '2026-11-18' };
  assert.throws(() => buildTaskEvent({ ...WATER, remind_time: null }, options), /reminder time/);
  assert.throws(() => buildTaskEvent({ ...WATER, remind_time: '25:00' }, options), /reminder time/);
  assert.throws(() => buildTaskEvent(WATER, { ...options, timeZone: 'Mars/Base' }), /time zone/);
  assert.throws(() => buildTaskEvent(WATER, { ...options, today: 'soon' }), /date/);
  assert.throws(() => buildTaskEvent({ ...WATER, days_of_week: [] }, options), /no day/);
  assert.throws(() => buildTaskEvent({ ...WATER, kind: 'entry', task_date: null }, options), /no date/);
  for (const value of ['Africa/Cairo', 'UTC', 'America/Argentina/Buenos_Aires', 'Europe/Berlin']) assert.equal(isValidTimeZone(value), true, value);
  for (const value of ['', 'Mars/Base', '../../etc', 'Europe/Berlin; drop', null, 5, 'x'.repeat(80)]) assert.equal(isValidTimeZone(value), false, String(value));
  assert.deepEqual([isIsoDay('2026-02-28'), isIsoDay('2026-02-30'), isIsoDay('2026-2-3'), isIsoDay(undefined)], [true, false, false, false]);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

// ----------------------------------------------- the keys of the connected services

const KEY = randomBytes(32).toString('base64');
const OWNER = { id: 'owner-1', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const ENVIRONMENT = { TOKEN_ENCRYPTION_KEY: KEY, PLATFORM_ADMIN_EMAILS: 'owner@example.com', APP_URL: 'https://app.example.com/' };

function memoryStore() {
  const state = { rows: [], calls: [] };
  return {
    state,
    async list() { state.calls.push('list'); return state.rows.map((row) => ({ ...row })); },
    async save({ provider, clientId, clientSecretEncrypted }, userId) {
      state.calls.push('save');
      state.rows = [...state.rows.filter((row) => row.provider !== provider), { provider, client_id: clientId, client_secret_encrypted: clientSecretEncrypted, updated_at: '2026-11-18T10:00:00Z', updated_by: userId }];
    },
    async clear(provider) { state.calls.push('clear'); state.rows = state.rows.filter((row) => row.provider !== provider); },
  };
}
const send = (store, body, user = OWNER, environment = ENVIRONMENT) => handleIntegrationsRequest({ body, user, store, environment });
const FITBIT = { provider: 'fitbit', clientId: '23ABCD', clientSecret: 'fitbit-secret-value-0123' };

test('only the platform owner can read or change the keys of the connected services', async () => {
  const people = [
    { id: 'c1', email: 'coach@example.com', email_confirmed_at: '2026-01-01' },
    { id: 'c2', email: 'client@example.com', email_confirmed_at: '2026-01-01', user_metadata: { role: 'super_admin' } },
    { id: 'c3', email: 'owner@example.com', email_confirmed_at: null },
    null,
  ];
  for (const user of people) {
    for (const action of ['get', 'save', 'clear', 'other']) {
      let opened = 0;
      await assert.rejects(
        handleIntegrationsRequest({ body: { action, ...FITBIT }, user, store: () => { opened += 1; return memoryStore(); }, environment: ENVIRONMENT }),
        (error) => error instanceof HttpError && error.status === 403,
      );
      assert.equal(opened, 0, 'the database was never reached');
    }
  }
});

test('saved keys are encrypted, never shown again, and an empty secret keeps the old one', async () => {
  const store = memoryStore();
  const saved = await send(store, { action: 'save', ...FITBIT });
  assert.equal(saved.status, 200);
  const [row] = store.state.rows;
  assert.deepEqual([row.provider, row.client_id, row.updated_by], ['fitbit', '23ABCD', 'owner-1']);
  assert.ok(!JSON.stringify(row).includes(FITBIT.clientSecret), 'only ciphertext at rest');
  assert.equal(decryptSecret(row.client_secret_encrypted, KEY), FITBIT.clientSecret);

  const shown = JSON.stringify((await send(store, { action: 'get' })).body);
  assert.ok(!shown.includes(FITBIT.clientSecret) && !shown.includes(row.client_secret_encrypted));
  const view = JSON.parse(shown).providers.find((item) => item.provider === 'fitbit');
  assert.deepEqual([view.source, view.clientId, view.hasSecret, view.redirectUri], ['database', '23ABCD', true, 'https://app.example.com/api/wearables/fitbit?action=callback']);

  await send(store, { action: 'save', provider: 'fitbit', clientId: 'NEWID99', clientSecret: '' });
  assert.deepEqual([store.state.rows[0].client_id, decryptSecret(store.state.rows[0].client_secret_encrypted, KEY)], ['NEWID99', FITBIT.clientSecret]);
  await send(store, { action: 'save', provider: 'fitbit', clientId: 'NEWID99', clientSecret: 'a-brand-new-secret-9' });
  assert.equal(decryptSecret(store.state.rows[0].client_secret_encrypted, KEY), 'a-brand-new-secret-9');
});

test('keys are validated and need the encryption key', async () => {
  const store = memoryStore();
  assert.deepEqual((await send(store, { action: 'save', provider: 'fitbit', clientId: '', clientSecret: '' })).body.errors, { clientId: 'aiErrRequired', clientSecret: 'aiErrRequired' });
  assert.deepEqual((await send(store, { action: 'save', provider: 'fitbit', clientId: 'a b', clientSecret: 'short' })).body.errors, { clientId: 'adminIntErrClientId', clientSecret: 'adminIntErrSecret' });
  assert.equal((await send(store, { action: 'save', provider: 'whoop', clientId: 'abcd', clientSecret: 'abcdefgh1' })).status, 422);
  assert.equal((await send(store, { action: 'clear', provider: 'whoop' })).status, 422);
  assert.equal((await send(store, { action: 'save', ...FITBIT }, OWNER, { ...ENVIRONMENT, TOKEN_ENCRYPTION_KEY: '' })).status, 422);
  assert.equal(store.state.calls.includes('save'), false);
  await assert.rejects(send(store, { action: 'bogus' }), (error) => error instanceof HttpError && error.status === 400);
});

test('saved keys win over server variables, and removing them returns to the variables', async () => {
  const environment = { ...ENVIRONMENT, FITBIT_CLIENT_ID: 'ENVID', FITBIT_CLIENT_SECRET: 'env-secret-12345', GOOGLE_CLIENT_ID: 'g-env', GOOGLE_CLIENT_SECRET: 'g-env-secret-1' };
  const store = memoryStore();
  const admin = { from: () => ({ select: () => ({ eq: (_column, provider) => ({ maybeSingle: async () => ({ data: store.state.rows.find((row) => row.provider === provider) || null, error: null }) }) }) }) };

  assert.deepEqual(await resolveCredentials('fitbit', { admin, environment }), { clientId: 'ENVID', clientSecret: 'env-secret-12345', source: 'environment' });
  await send(store, { action: 'save', ...FITBIT }, OWNER, environment);
  assert.deepEqual(await resolveCredentials('fitbit', { admin, environment }), { clientId: '23ABCD', clientSecret: FITBIT.clientSecret, source: 'database' });
  assert.equal((await resolveCredentials('google', { admin, environment })).source, 'environment', 'other services are unaffected');
  assert.equal(await resolveCredentials('oura', { admin, environment }), null);
  assert.equal(await resolveCredentials('whoop', { admin, environment }), null);

  await send(store, { action: 'clear', provider: 'fitbit' }, OWNER, environment);
  assert.equal((await resolveCredentials('fitbit', { admin, environment })).source, 'environment');
  assert.deepEqual(await configuredProviders({ admin, environment }), { fitbit: true, garmin: false, oura: false, google: true });

  // No database at all, a database that fails, or a key that no longer decrypts: the variables still work.
  assert.equal((await resolveCredentials('fitbit', { admin: null, environment })).source, 'environment');
  const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => { throw new Error('relation does not exist'); } }) }) }) };
  assert.equal((await resolveCredentials('fitbit', { admin: broken, environment })).source, 'environment');
  store.state.rows = [{ provider: 'fitbit', client_id: 'x', client_secret_encrypted: 'garbage' }];
  assert.equal((await resolveCredentials('fitbit', { admin, environment })).source, 'environment');
  const unreadable = (await send(store, { action: 'get' }, OWNER, environment)).body.providers.find((entry) => entry.provider === 'fitbit');
  assert.deepEqual([unreadable.unreadable, unreadable.source], [true, 'environment']);
});

test('the redirect address of each service, and the store\'s calls', async () => {
  assert.equal(redirectUriFor('oura', 'https://a.example.com'), 'https://a.example.com/api/wearables/oura?action=callback');
  assert.equal(redirectUriFor('google', 'https://a.example.com'), 'https://a.example.com/api/google?action=callback');
  assert.deepEqual(INTEGRATION_PROVIDERS, ['fitbit', 'garmin', 'oura', 'google']);
  assert.deepEqual(envCredentials('garmin', { GARMIN_CLIENT_KEY: 'k', GARMIN_CLIENT_SECRET: 's' }), { clientId: 'k', clientSecret: 's' });
  assert.equal(envCredentials('garmin', { GARMIN_CLIENT_KEY: 'k' }), null);
  const noUrl = (await send(memoryStore(), { action: 'get' }, OWNER, { ...ENVIRONMENT, APP_URL: '' })).body;
  assert.deepEqual([noUrl.appUrlSet, noUrl.providers[0].redirectUri], [false, '']);

  const calls = [];
  const chain = (table) => {
    const api = {
      select: () => { calls.push([table, 'select']); return Promise.resolve({ data: [{ provider: 'oura' }], error: null }); },
      upsert: async (payload, options) => { calls.push([table, 'upsert', payload, options]); return { error: null }; },
      delete: () => ({ eq: async (column, value) => { calls.push([table, 'delete', column, value]); return { error: null }; } }),
    };
    return api;
  };
  const store = createIntegrationStore({ admin: { from: chain } });
  assert.deepEqual(await store.list(), [{ provider: 'oura' }]);
  await store.save({ provider: 'google', clientId: 'id', clientSecretEncrypted: 'cipher' }, 'owner-1');
  await store.clear('google');
  assert.ok(calls.every((call) => call[0] === 'platform_integration_settings'));
  assert.deepEqual(calls[1][3], { onConflict: 'provider' });
  assert.deepEqual(calls[2], ['platform_integration_settings', 'delete', 'provider', 'google']);
  await assert.rejects(createIntegrationStore({ admin: { from: () => ({ select: async () => ({ error: { message: 'boom' } }) }) } }).list(), /boom/);
});

// ------------------------------------------- the Connect buttons, and what each role sees

test('the device cards always offer Connect, with no "not available" dead end', () => {
  const panel = read('src/components/WearablesPanel.jsx');
  assert.doesNotMatch(panel, /hltUnconfigured|getWearableProviders|configured\b|state === 'unconfigured'/);
  assert.match(panel, /error\.status === 503/, 'a missing key is explained after pressing Connect');
  assert.match(panel, /startWearableConnection/);
  for (const locale of supportedLocales) assert.ok(translations[locale].hltSetupNeeded, locale);
  assert.match(read('api/wearables/[provider].js'), /resolveCredentials\(provider/);
  assert.match(read('api/_lib/googleAuth.js'), /resolveCredentials\('google'/);
  assert.match(read('api/google.js'), /loadGoogleCredentials/);
  assert.doesNotMatch(read('api/google.js'), /env\('GOOGLE_CLIENT_ID'\)/, 'the Google keys come from the shared resolver');
});

test('the keys page and its API are for the platform owner only', () => {
  assert.equal(ADMIN_PATHS.integrations, '/admin/integrations');
  for (const page of Object.values(PAGES)) assert.ok(!page.path.startsWith('/admin'), page.path);
  const users = ['src/pages', 'src/components'].flatMap((dir) => readdirSync(new URL(`../${dir}/`, import.meta.url)).map((name) => `${dir}/${name}`))
    .filter((path) => /\.jsx?$/.test(path) && /platformService|PlatformIntegrationsPanel/.test(read(path)));
  assert.deepEqual(users.sort(), ['src/components/PlatformIntegrationsPanel.jsx', 'src/pages/AdminIntegrationsPage.jsx']);
  assert.match(read('src/pages/AdminIntegrationsPage.jsx'), /getAiStatus[\s\S]*Navigate/, 'anyone else is sent away');
  const api = read('api/platform.js');
  assert.match(api, /handleIntegrationsRequest/);
  assert.match(api, /store: \(\) =>/, 'the service-role client is created only after the owner check');
  assert.match(read('api/_lib/platformIntegrations.js'), /assertPlatformAdmin\(user, environment\)/);
  for (const role of ['coach', 'client', 'trainer']) {
    const prompt = buildSystemPrompt({ role, locale: 'en', route: '/settings', pageTitle: 'settings', name: 'Sam', summary: '', today: '2026-11-18' });
    assert.doesNotMatch(prompt, /admin\/integrations|client secret|Connected services/i, role);
  }
  assert.ok(existsSync(new URL('../api/platform.js', import.meta.url)));
});

test('the checklist is a client page in the navigation, and Jack knows about it for clients only', () => {
  assert.equal(PAGES.checklist.path, '/checklist');
  assert.equal(PAGES.checklist.access, 'client');
  assert.ok(navigationFor('client').some((section) => section.items.includes('checklist')));
  for (const role of ['coach', 'trainer']) assert.ok(!navigationFor(role).some((section) => section.items.includes('checklist')), role);

  const prompt = (role) => buildSystemPrompt({ role, locale: 'en', route: '/checklist', pageTitle: 'checklist', name: 'Sara', summary: '', today: '2026-11-18' });
  assert.match(prompt('client'), /Daily checklist \(\/checklist\)/);
  assert.match(prompt('client'), /Google Calendar/);
  for (const role of ['coach', 'trainer']) assert.doesNotMatch(prompt(role), /Daily checklist \(/, role);
  assert.ok(WRITE_TOOLS.includes('update_checklist_item'));
  assert.ok(quickPromptKeys('client', '/checklist').includes('jackQ_clientWater'));
});

// ------------------------------------------------------------------- translations

const KEY_PATTERN = /^(chk|navChecklist$|adminInt|hltSetupNeeded$|jackTool_(get_my_checklist|update_checklist_item)_|jackQ_(clientChecklist|clientWater)$)/;

test('every language has the same checklist and connected-services texts', () => {
  const keysOf = (locale) => Object.keys(translations[locale]).filter((key) => KEY_PATTERN.test(key)).sort();
  const english = keysOf('en');
  assert.ok(english.length >= 100);
  for (const locale of supportedLocales) {
    assert.deepEqual(keysOf(locale), english, locale);
    for (const key of english) assert.ok(String(translations[locale][key]).trim(), `${locale}.${key}`);
  }
});

test('every key the checklist screens, forms and calendar results can show exists in every language', () => {
  const keys = [
    ...['workout', 'meal', 'water', 'habit', 'custom'].map((category) => `chkCat_${category}`),
    ...['connected', 'denied', 'failed'].map((result) => `chkCalendarResult_${result}`),
    'chkErrCategory', 'chkErrTitle', 'chkErrTitleLong', 'chkErrTarget', 'chkErrUnit', 'chkErrTime', 'chkErrDays', 'chkErrCalendarTime',
    'chkSuggestWorkout', 'chkSuggestMeals', 'chkSuggestWater', 'chkSuggestSleep', 'chkCalendarNotReady', 'hltConnecting', 'loadingProgress',
    ...INTEGRATION_PROVIDERS.flatMap((provider) => [`adminIntProvider_${provider}`, `adminIntHelp_${provider}`]),
    ...['database', 'environment', 'none'].map((source) => `adminIntSource_${source}`),
    'adminIntErrProvider', 'adminIntErrClientId', 'adminIntErrSecret', 'aiErrRequired', 'aiNeedsKey', 'aiSavedPlaceholder', 'aiLoadError',
  ];
  for (const locale of supportedLocales) for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
});

test('unknown configuration helpers fail loudly', () => {
  assert.throws(() => decryptSecret('garbage', KEY));
  assert.ok(new ConfigError('x') instanceof Error);
});
