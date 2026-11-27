import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { supportedLocales, translations } from '../src/i18n/translations.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');

const NEW_MIGRATIONS = [
  '20261115004400_chat_images_templates.sql',
  '20261115004500_recipes.sql',
  '20261115004600_custom_reminders.sql',
  '20261115004700_coaches_marketplace.sql',
];

const NEW_UI_FILES = [
  'src/components/NotificationBell.jsx',
  'src/components/ThemeToggle.jsx',
  'src/components/ImageLightbox.jsx',
  'src/components/ChatImage.jsx',
  'src/components/MessageTemplatesPicker.jsx',
  'src/components/MessageTemplatesManager.jsx',
  'src/components/RecipeEditor.jsx',
  'src/components/RecipePicker.jsx',
  'src/components/RecipeView.jsx',
  'src/components/ChatThread.jsx',
  'src/components/ClientMealPlan.jsx',
  'src/components/MealPlanEditor.jsx',
  'src/pages/RecipesPage.jsx',
  'src/pages/RemindersPage.jsx',
  'src/pages/SettingsPage.jsx',
  'src/pages/MessagesPage.jsx',
];

test('the four new migrations are the last ones, in order, and each is idempotent by construction', () => {
  const files = readdirSync(new URL('supabase/migrations/', root)).filter((name) => name.endsWith('.sql'));
  assert.deepEqual(files.slice(-4), NEW_MIGRATIONS);
  for (const name of NEW_MIGRATIONS) {
    const sql = read(`supabase/migrations/${name}`);
    assert.doesNotMatch(sql, /^\s*create (table|index|unique index) (?!if not exists)/im, `${name}: tables and indexes use "if not exists"`);
    assert.doesNotMatch(sql, /^\s*create function\b/im, `${name}: functions are "create or replace"`);
    for (const trigger of sql.matchAll(/^create trigger (\w+)/gim)) assert.match(sql, new RegExp(`drop trigger if exists ${trigger[1]} on`), `${name}: trigger ${trigger[1]} is dropped first`);
    for (const table of sql.matchAll(/create table if not exists public\.(\w+)/g)) {
      assert.match(sql, new RegExp(`alter table public\\.${table[1]} enable row level security`), `${name}: ${table[1]} has row-level security`);
    }
    for (const fn of sql.matchAll(/create or replace function public\.(\w+)\([^)]*\)[\s\S]*?\$\$;/g)) {
      assert.match(fn[0], /security definer|security invoker|language sql\s+(stable|immutable)/, `${fn[1]} states how it runs`);
      if (/security definer/.test(fn[0])) assert.match(fn[0], /set search_path = public, pg_temp/, `${fn[1]} pins its search_path`);
    }
  }
});

test('no secret or service key is placed in the browser code of the new features', () => {
  for (const file of NEW_UI_FILES.concat(['src/services/notificationService.js', 'src/services/recipeService.js', 'src/services/reminderService.js', 'src/services/chatImageService.js', 'src/services/messageTemplateService.js'])) {
    const source = read(file);
    assert.doesNotMatch(source, /service_role|SERVICE_ROLE|VAPID_PRIVATE|CRON_SECRET/, file);
  }
  assert.doesNotMatch(read('.env.example'), /VITE_[A-Z_]*(SECRET|PRIVATE)/);
});

test('every text the new screens ask for exists in all five languages', () => {
  const missing = [];
  for (const file of NEW_UI_FILES) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)) {
      for (const locale of supportedLocales) if (!translations[locale][match[1]]) missing.push(`${file}: ${locale} ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('texts chosen at run time by the new screens exist too', () => {
  const dynamic = [
    ...['water', 'meal', 'workout', 'checkin', 'custom'].flatMap((kind) => [`rmDefaultTitle_${kind}`]),
    ...['welcome', 'encouragement', 'checkin', 'diet'].flatMap((id) => [`tplStarter_${id}_title`, `tplStarter_${id}_body`]),
    ...['unknown', 'message', 'checkin_submitted', 'checkin_reviewed', 'invoice_new', 'invoice_reported', 'invoice_paid', 'progression', 'reminder'].map((type) => `notifTitle_${type}`),
    'notifAgeNow', 'notifAgeMin', 'notifAgeHour', 'notifAgeDay',
  ];
  for (const key of dynamic) for (const locale of supportedLocales) assert.ok(translations[locale][key], `${locale} ${key}`);
});

test('the new texts are real translations, not copies of the English text (except words that are the same in a language)', () => {
  const keys = ['notifMarkAll', 'tplTitle', 'rcMethod', 'rmDescription', 'themeHelp', 'chatImageAttach'];
  for (const key of keys) {
    for (const locale of supportedLocales.filter((code) => code !== 'en')) assert.notEqual(translations[locale][key], translations.en[key], `${locale} ${key}`);
  }
});

test('the server keeps its 11 functions: reminders, images and recipes were added to existing files and the database only', () => {
  const endpoints = readdirSync(new URL('api/', root), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => entry.name).sort();
  assert.deepEqual(endpoints, ['ai.js', 'food-search.js', 'jack-assistant.js', 'jack.js', 'paddle-webhook.js', 'paddle.js', 'push.js', 'send-campaign.js', 'unsubscribe.js', 'video-sessions.js', 'workflows.js']);
});

test('ARCHITECTURE.md documents the new migrations, bucket, pages and the appearance rules', () => {
  const doc = read('ARCHITECTURE.md');
  for (const phrase of ['| 4300 | `notifications`', '| 4400 | `chat_images_templates`', '| 4500 | `recipes`', '| 4600 | `custom_reminders`', 'apexfit-chat-images', '`/recipes`', '`/reminders`',
    'Dark / Light / System', '3.11 Notification center', 'run_reminder_engine', 'coach_message_templates', '`--tx-<hex>`']) assert.ok(doc.includes(phrase), phrase);
  assert.match(doc, new RegExp(`${readdirSync(new URL('supabase/migrations/', root)).length} files`), 'the migration count is current');
  assert.match(read('README.md'), /Custom reminders/);
});

test('the guide Jack reads mentions the new features', () => {
  const guide = read('api/_lib/jackKnowledge.js');
  for (const phrase of ['Reminders', 'Notification center', 'Appearance', 'Recipes', 'Chat photos and templates', '{client_name}']) assert.ok(guide.includes(phrase), phrase);
});
