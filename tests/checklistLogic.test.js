import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../api/_lib/jackKnowledge.js';
import { PAGES, navigationFor } from '../src/routes.js';
import { supportedLocales, translations } from '../src/i18n/translations.js';
import {
  ALL_DAYS, dayCompletion, emptyTaskForm, formatAmount, groupItems, itemPercent, parseAmount, quickSteps, replaceItem, streakOf, suggestedTasks,
  toggled, validateTaskForm, withAmount,
} from '../src/services/checklistUtils.js';
import { quickPromptKeys, WRITE_TOOLS } from '../src/services/jackUtils.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ the task form

test('the task form is validated and turned into what the database expects', () => {
  const good = validateTaskForm({ category: 'water', title: '  Drink water ', target: '2,5', unit: ' L ', time: '09:30', repeat: 'daily', days: [] });
  assert.equal(good.valid, true);
  assert.deepEqual(good.payload, { category: 'water', title: 'Drink water', target: 2.5, unit: 'L', remindTime: '09:30', repeatDays: ALL_DAYS });

  const once = validateTaskForm({ ...emptyTaskForm(), title: 'Call the coach', repeat: 'once' });
  assert.deepEqual([once.valid, once.payload.repeatDays, once.payload.target, once.payload.remindTime], [true, null, null, null]);
  const days = validateTaskForm({ ...emptyTaskForm(), title: 'Run', repeat: 'days', days: [3, 1, 3, 9, '5'] });
  assert.deepEqual(days.payload.repeatDays, [1, 3, 5], 'sorted, unique and only real weekdays');

  const bad = validateTaskForm({ category: 'sleep', title: ' ', target: '-2', unit: 'u'.repeat(21), time: '25:00', repeat: 'days', days: [] });
  assert.deepEqual(bad.errors, { category: 'chkErrCategory', title: 'chkErrTitle', target: 'chkErrTarget', unit: 'chkErrUnit', time: 'chkErrTime', days: 'chkErrDays' }, 'an invalid time is reported as such');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x'.repeat(121) }).errors.title, 'chkErrTitleLong');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x', target: 'abc' }).errors.target, 'chkErrTarget');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x', target: '100001' }).errors.target, 'chkErrTarget');
  assert.equal(validateTaskForm({ ...emptyTaskForm(), title: 'x', time: '07:05' }).payload.remindTime, '07:05');
  assert.deepEqual(Object.keys(validateTaskForm({ ...emptyTaskForm(), title: 'x' }).payload).sort(), ['category', 'remindTime', 'repeatDays', 'target', 'title', 'unit']);
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

  const day = (date, done, total) => ({ date, done, total });
  assert.equal(streakOf([day('2026-11-14', 2, 2), day('2026-11-15', 3, 3), day('2026-11-16', 1, 1), day('2026-11-17', 1, 4)]), 3, 'today unfinished does not break it');
  assert.equal(streakOf([day('2026-11-15', 3, 3), day('2026-11-16', 0, 2), day('2026-11-17', 2, 2)]), 1);
  assert.equal(streakOf([day('2026-11-16', 2, 2), day('2026-11-17', 2, 2)]), 2);
  assert.equal(streakOf([day('2026-11-16', 0, 0), day('2026-11-17', 0, 0)]), 0, 'days without tasks are not days done');
  assert.equal(streakOf([]), 0);
});

// ------------------------------------------------- what each role sees

test('the checklist is a client page in the navigation, and Jack knows about it for clients only', () => {
  assert.equal(PAGES.checklist.path, '/checklist');
  assert.equal(PAGES.checklist.access, 'client');
  assert.ok(navigationFor('client').some((section) => section.items.includes('checklist')));
  for (const role of ['coach', 'trainer']) assert.ok(!navigationFor(role).some((section) => section.items.includes('checklist')), role);

  const prompt = (role) => buildSystemPrompt({ role, locale: 'en', route: '/checklist', pageTitle: 'checklist', name: 'Sara', summary: '', today: '2026-11-18' });
  assert.match(prompt('client'), /Daily checklist \(\/checklist\)/);
  assert.doesNotMatch(prompt('client'), /Google|calendar/i, 'no outside calendar any more');
  for (const role of ['coach', 'trainer']) assert.doesNotMatch(prompt(role), /Daily checklist \(/, role);
  assert.ok(WRITE_TOOLS.includes('update_checklist_item'));
  assert.ok(quickPromptKeys('client', '/checklist').includes('jackQ_clientWater'));
});

// ------------------------------------------------------------------- translations

const KEY_PATTERN = /^(chk|navChecklist$|jackTool_(get_my_checklist|update_checklist_item)_|jackQ_(clientChecklist|clientWater)$)/;

test('every language has the same checklist texts', () => {
  const keysOf = (locale) => Object.keys(translations[locale]).filter((key) => KEY_PATTERN.test(key)).sort();
  const english = keysOf('en');
  assert.ok(english.length >= 60);
  for (const locale of supportedLocales) {
    assert.deepEqual(keysOf(locale), english, locale);
    for (const key of english) assert.ok(String(translations[locale][key]).trim(), `${locale}.${key}`);
  }
});

test('every key the checklist screens and forms can show exists in every language', () => {
  const keys = [
    ...['workout', 'meal', 'water', 'habit', 'custom'].map((category) => `chkCat_${category}`),
    'chkErrCategory', 'chkErrTitle', 'chkErrTitleLong', 'chkErrTarget', 'chkErrUnit', 'chkErrTime', 'chkErrDays',
    'chkSuggestWorkout', 'chkSuggestMeals', 'chkSuggestWater', 'chkSuggestSleep', 'chkReminder', 'chkReminderSave', 'chkTime', 'loadingProgress',
  ];
  for (const locale of supportedLocales) for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
});
