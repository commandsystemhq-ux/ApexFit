import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createChunkedStorage, splitIntoChunks, CHUNK_SIZE } from '../apps/mobile/src/lib/secureStorage.js';
import {
  VOICE_BUCKET, VOICE_MAX_BYTES, VOICE_MAX_SECONDS, VOICE_MIME, buildAudioPath, formatVoiceDuration, uuid, validateRecording,
} from '../apps/mobile/src/lib/voice.js';
import { exerciseName, localDateString, parseWeight, upsertMessage } from '../apps/mobile/src/lib/format.js';
import { SUPPORTED_LOCALES, isRtlLocale, pickLocale, translate, translations } from '../apps/mobile/src/lib/translations.js';
import * as webVoice from '../src/services/voiceUtils.js';
import { supportedLocales } from '../src/i18n/translations.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function sourceFiles(directory) {
  return readdirSync(new URL(`${directory}/`, root)).flatMap((name) => {
    if (name === 'node_modules' || name === '.expo') return [];
    const path = `${directory}/${name}`;
    return statSync(new URL(path, root)).isDirectory() ? sourceFiles(path) : [path];
  });
}

function memoryStore() {
  const values = new Map();
  return {
    values,
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  };
}

test('a long session is stored in pieces and read back whole, and old pieces are removed', async () => {
  const store = memoryStore();
  const storage = createChunkedStorage(store);
  const session = JSON.stringify({ access_token: 'a'.repeat(CHUNK_SIZE * 2 + 50), user: { id: 'x' } });
  await storage.setItem('sb', session);
  assert.equal(await storage.getItem('sb'), session);
  assert.equal(store.values.get('sb.count'), '3');
  assert.ok([...store.values.values()].every((value) => value.length <= CHUNK_SIZE));

  await storage.setItem('sb', 'short');
  assert.equal(await storage.getItem('sb'), 'short');
  assert.equal(store.values.size, 2);

  store.values.delete('sb.0');
  assert.equal(await storage.getItem('sb'), null);
  await storage.removeItem('sb');
  assert.equal(store.values.size, 0);
  assert.equal(await storage.getItem('missing'), null);
  assert.deepEqual(splitIntoChunks('', 5), []);
  assert.deepEqual(splitIntoChunks('abcdefg', 3), ['abc', 'def', 'g']);
});

test('voice rules in the app match the web app and the database', () => {
  assert.equal(VOICE_MAX_SECONDS, webVoice.VOICE_MAX_SECONDS);
  assert.equal(VOICE_MAX_BYTES, webVoice.VOICE_MAX_BYTES);
  assert.equal(VOICE_BUCKET, webVoice.VOICE_BUCKET);
  assert.equal(webVoice.isSupportedVoiceMime(VOICE_MIME), true);
  const migration = read('supabase/migrations/20261115002600_chat_voice_messages.sql');
  assert.ok(migration.includes(String(VOICE_MAX_BYTES)));
  assert.ok(migration.includes(`'${VOICE_BUCKET}'`));
  assert.ok(migration.includes(`between 1 and ${VOICE_MAX_SECONDS}`));

  const good = { bytes: 4000, seconds: 12 };
  assert.equal(validateRecording(good), null);
  assert.equal(validateRecording({ ...good, seconds: 0 }), 'voiceErrTooShort');
  assert.equal(validateRecording({ ...good, bytes: 0 }), 'voiceErrTooShort');
  assert.equal(validateRecording({ ...good, seconds: VOICE_MAX_SECONDS + 1 }), 'voiceErrTooLong');
  assert.equal(validateRecording({ ...good, bytes: VOICE_MAX_BYTES + 1 }), 'voiceErrTooBig');
  assert.equal(formatVoiceDuration(75), webVoice.formatVoiceDuration(75));
});

test('the file path the app builds is accepted by the database function', () => {
  const sender = '00000000-0000-4000-8000-0000000000c1';
  const file = uuid();
  assert.match(file, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(file, uuid());
  const path = buildAudioPath(sender, file);
  assert.match(path, new RegExp(`^${sender}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(webm|mp4|ogg)$`));
  assert.throws(() => buildAudioPath('', file), TypeError);
});

test('the app has the same five languages with the same texts, Arabic reads right to left', () => {
  assert.deepEqual(SUPPORTED_LOCALES, supportedLocales);
  const english = Object.keys(translations.en).sort();
  for (const locale of SUPPORTED_LOCALES) assert.deepEqual(Object.keys(translations[locale]).sort(), english, locale);
  assert.equal(isRtlLocale('ar'), true);
  assert.equal(isRtlLocale('en'), false);
  assert.equal(pickLocale('ar-EG'), 'ar');
  assert.equal(pickLocale('pt'), 'en');
  assert.equal(pickLocale(undefined), 'en');
  assert.equal(translate('de', 'noSuchKey'), 'noSuchKey');
  assert.match(translations.ar.voiceDenied, /[\u0600-\u06FF]/);
});

test('weights, dates, exercise names and chat lists behave', () => {
  assert.equal(parseWeight('82,46'), 82.5);
  assert.equal(parseWeight(' 70 '), 70);
  for (const bad of ['', 'abc', '19.9', '401', null]) assert.equal(parseWeight(bad), null);
  assert.equal(localDateString(new Date(2026, 10, 5)), '2026-11-05');
  assert.equal(exerciseName({ name: 'Squat', name_i18n: { ar: 'سكوات' } }, 'ar'), 'سكوات');
  assert.equal(exerciseName({ name: 'Squat', name_i18n: { ar: 'سكوات' } }, 'de'), 'Squat');
  assert.equal(exerciseName(null, 'en'), '');

  const first = { id: 'a', created_at: '2026-11-01T10:00:00Z' };
  const pending = { id: 'pending-1', client_ref: 'r1', created_at: '2026-11-01T10:01:00Z', pending: true };
  const saved = { id: 'b', client_ref: 'r1', created_at: '2026-11-01T10:01:01Z' };
  let list = upsertMessage(upsertMessage([], pending), first);
  assert.deepEqual(list.map((message) => message.id), ['a', 'pending-1']);
  list = upsertMessage(upsertMessage(list, saved), saved);
  assert.deepEqual(list.map((message) => message.id), ['a', 'b']);
});

test('the app holds only public settings and leaves the web app\'s build and deployment alone', () => {
  const files = sourceFiles('apps/mobile').filter((path) => !/package-lock\.json$/.test(path));
  assert.ok(files.length > 20);
  const code = files.filter((path) => /\.(js|json|md)$/.test(path)).map((path) => read(path)).join('\n');
  assert.doesNotMatch(code, /service_role|SERVICE_ROLE|RESEND_API_KEY|VAPID_PRIVATE|TOKEN_ENCRYPTION_KEY|EMAIL_UNSUBSCRIBE_SECRET/);
  const env = read('apps/mobile/.env.example');
  const names = env.split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split('=')[0]);
  assert.deepEqual(names, ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_API_URL']);
  assert.match(read('apps/mobile/.gitignore'), /^\.env$/m);

  const appConfig = JSON.parse(read('apps/mobile/app.json'));
  assert.equal(appConfig.expo.scheme, 'apexfit');
  assert.ok(appConfig.expo.ios.infoPlist.NSMicrophoneUsageDescription);
  assert.ok(appConfig.expo.android.permissions.includes('RECORD_AUDIO'));

  const web = JSON.parse(read('package.json'));
  assert.equal(web.scripts.build, 'vite build');
  assert.equal(web.scripts.test, 'node --test');
  assert.ok(!Object.keys({ ...web.dependencies, ...web.devDependencies }).some((name) => /^(expo|react-native)/.test(name)));
  assert.equal(web.workspaces, undefined);
  assert.doesNotMatch(read('vercel.json'), /apps/);
  assert.match(read('.vercelignore'), /^apps\/$/m);
});

test('every screen of the app exists and uses the shared chat and voice code', () => {
  for (const path of [
    'app/_layout.js', 'app/index.js', 'app/login.js', 'app/auth/callback.js', 'app/(tabs)/_layout.js', 'app/(tabs)/home.js', 'app/(tabs)/programs.js',
    'app/(tabs)/progress.js', 'app/(tabs)/chat.js', 'app/(tabs)/settings.js', 'app/chat/[partnerId].js', 'app/program/[id].js',
    'src/components/VoiceBubble.js', 'src/components/VoiceComposer.js',
  ]) assert.ok(existsSync(new URL(`apps/mobile/${path}`, root)), path);
  const chat = read('apps/mobile/src/lib/chat.js');
  for (const name of ['send_chat_message', 'send_chat_voice_message', 'get_chat_messages', 'mark_chat_read', 'get_chat_conversations']) assert.ok(chat.includes(name), name);
  assert.match(read('apps/mobile/README.md'), /apexfit:\/\/auth\/callback/);
});
