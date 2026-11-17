import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  AppleHealthParser, chunk, detectSlashOrder, parseAppleHealthFile, parseCsv, parseDateValue, parseHealthSummary, parseMyFitnessPalCsv, parseNumber,
} from '../src/services/healthImport.js';
import {
  buildSeries, connectionState, countSkipReasons, dayProgress, importErrorKey, isStale, mergeDailyMetrics, mergeNutritionByDay, progressOf,
  summarizeNutrition, summarizeSeries, validateMetricsForm, validateNutritionForm, validateTargetsForm, formatSleep, SKIP_REASON_KEYS,
} from '../src/services/healthUtils.js';
import { translations, supportedLocales } from '../src/i18n/translations.js';

const TODAY = '2026-11-15';

// ----------------------------------------------------------------- numbers, dates, CSV

test('numbers accept thousands separators, decimal commas, units and empty cells', () => {
  assert.equal(parseNumber('1,234'), 1234);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber(' 2 100 '), 2100);
  assert.equal(parseNumber('85g'), 85);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('--'), null);
  assert.ok(Number.isNaN(parseNumber('abc')));
});

test('dates accept ISO and slash formats and reject impossible days', () => {
  assert.equal(parseDateValue('2026-11-05'), '2026-11-05');
  assert.equal(parseDateValue('2026-11-05T08:00:00Z'), '2026-11-05');
  assert.equal(parseDateValue('11/05/2026', 'mdy'), '2026-11-05');
  assert.equal(parseDateValue('11/05/2026', 'dmy'), '2026-05-11');
  assert.equal(parseDateValue('05/11/26', 'dmy'), '2026-11-05');
  assert.equal(parseDateValue('2026-02-31'), null);
  assert.equal(parseDateValue('yesterday'), null);
  assert.equal(detectSlashOrder(['13/02/2026', '01/03/2026']), 'dmy');
  assert.equal(detectSlashOrder(['02/13/2026']), 'mdy');
  assert.equal(detectSlashOrder(['01/02/2026']), 'mdy');
});

test('the CSV reader handles quotes, line breaks inside quotes, BOM and other separators', () => {
  const { rows } = parseCsv('\uFEFFa,b,c\r\n"x, y","say ""hi""","line\nbreak"\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line\nbreak']]);
  assert.deepEqual(parseCsv('a;b\n1;2').rows, [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows, [['a', 'b'], ['1', '2']]);
  assert.equal(parseCsv('a,b\n1,2\n3,4\n5,6', { maxRows: 2 }).truncated, true);
});

// -------------------------------------------------------------------- MyFitnessPal

const MFP = `Date,Meal,Calories,Fat (g),Carbohydrates (g),Protein (g)
2026-11-12,Breakfast,500,"20.5",60,30
2026-11-12,Lunch,"1,000",30,120,70
2026-11-12,Dinner,700,25,80,50.25
2026-11-13,Breakfast,400,10,50,20
2026-11-13,Total,2100,75,240,150
2026-11-14,Snacks,0,0,0,0
`;

test('MyFitnessPal meal rows are added up per day and a Total row wins', () => {
  const result = parseMyFitnessPalCsv(MFP, { today: TODAY });
  assert.equal(result.ok, true);
  assert.deepEqual(result.days, [
    { log_date: '2026-11-12', calories_consumed: 2200, protein_g: 150.25, carbs_g: 260, fats_g: 75.5, water_ml: null },
    { log_date: '2026-11-13', calories_consumed: 2100, protein_g: 150, carbs_g: 240, fats_g: 75, water_ml: null },
  ]);
  assert.deepEqual(result.range, { from: '2026-11-12', to: '2026-11-13' });
  assert.deepEqual(countSkipReasons(result.skipped), { no_data: 1 });
});

test('MyFitnessPal summary files with one row per day, DMY dates and a semicolon separator', () => {
  const dmy = parseMyFitnessPalCsv('Date;Calories;Protein;Carbs;Fat\n13/11/2026;2.000;100;200;60\n'.replace('2.000', '2000'), { today: TODAY });
  assert.equal(dmy.ok, true);
  assert.deepEqual(dmy.days.map((day) => [day.log_date, day.calories_consumed, day.protein_g, day.carbs_g, day.fats_g]), [['2026-11-13', 2000, 100, 200, 60]]);
  assert.equal(dmy.dateFormat, 'dmy');
});

test('bad MyFitnessPal rows are skipped with a reason and good rows still import', () => {
  const text = 'Date,Meal,Calories,Protein\n2026-11-10,Total,1800,120\nnot a date,Total,100,1\n,Total,100,1\n2026-11-11,Total,abc,1\n2026-11-11,Total,99999,1\n2015-01-01,Total,100,1\n2030-01-01,Total,100,1\n';
  const result = parseMyFitnessPalCsv(text, { today: TODAY });
  assert.equal(result.ok, true);
  assert.deepEqual(result.days.map((day) => day.log_date), ['2026-11-10']);
  assert.deepEqual(countSkipReasons(result.skipped), { bad_date: 1, missing_date: 1, bad_number: 1, value_out_of_range: 1, date_out_of_range: 2 });
  for (const reason of Object.keys(countSkipReasons(result.skipped))) assert.ok(SKIP_REASON_KEYS[reason], reason);
});

test('unusable MyFitnessPal files report why', () => {
  assert.equal(parseMyFitnessPalCsv('', { today: TODAY }).error, 'empty');
  assert.equal(parseMyFitnessPalCsv('Date,Meal\n2026-11-10,Lunch', { today: TODAY }).error, 'missing_columns');
  assert.equal(parseMyFitnessPalCsv('Name,Weight\nA,1', { today: TODAY }).error, 'missing_columns');
  assert.equal(parseMyFitnessPalCsv('Date,Calories\n2026-11-10,0', { today: TODAY }).error, 'no_days');
  assert.equal(parseMyFitnessPalCsv('x'.repeat(5 * 1024 * 1024 + 1), { today: TODAY }).error, 'too_large');
  assert.equal(importErrorKey('missing_columns'), 'hltImpMissingColumns');
  assert.equal(importErrorKey('something else'), 'hltImpFailed');
});

// --------------------------------------------------------------------- summaries

test('daily summaries in CSV or JSON are read with flexible column names', () => {
  const csv = parseHealthSummary('Date,Steps,Sleep Hours,RHR,HRV,Readiness\n2026-11-14,9000,7.5,55,48.234,82\n2026-11-15,1000,,,,\n', { today: TODAY });
  assert.equal(csv.ok, true);
  assert.deepEqual(csv.days, [
    { date: '2026-11-14', steps: 9000, sleep_minutes: 450, resting_heart_rate: 55, hrv_ms: 48.23, recovery_score: 82 },
    { date: '2026-11-15', steps: 1000 },
  ]);

  const json = parseHealthSummary(JSON.stringify({ days: [{ date: '2026-11-14', steps: 500, active_energy: 300, sleep_minutes: 400 }] }), { today: TODAY });
  assert.equal(json.ok, true);
  assert.deepEqual(json.days, [{ date: '2026-11-14', steps: 500, active_calories: 300, sleep_minutes: 400 }]);

  const bad = parseHealthSummary('Date,Steps,RHR\n2026-11-14,9000,5\nnope,1,1\n', { today: TODAY });
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.days, [{ date: '2026-11-14', steps: 9000 }]);
  assert.deepEqual(bad.warnings.map((item) => item.reason).sort(), ['bad_date', 'value_out_of_range']);

  assert.equal(parseHealthSummary('{not json', { today: TODAY }).error, 'bad_json');
  assert.equal(parseHealthSummary('Steps\n1\n2', { today: TODAY }).error, 'missing_columns');
});

// --------------------------------------------------------------------- Apple Health

const record = (type, start, end, value, source = 'iPhone', unit = '') =>
  `<Record type="${type}" sourceName="${source}" unit="${unit}" startDate="${start} +0000" endDate="${end} +0000" value="${value}"/>`;
const STEPS = 'HKQuantityTypeIdentifierStepCount';
const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';

const EXPORT = `<?xml version="1.0"?><HealthData locale="en_US">
${record(STEPS, '2026-11-14 08:00:00', '2026-11-14 08:30:00', 3000, 'iPhone')}
${record(STEPS, '2026-11-14 09:00:00', '2026-11-14 09:30:00', 2000, 'iPhone')}
${record(STEPS, '2026-11-14 08:00:00', '2026-11-14 08:30:00', 4200, 'Apple Watch')}
${record('HKQuantityTypeIdentifierActiveEnergyBurned', '2026-11-14 08:00:00', '2026-11-14 09:00:00', 418.4, 'Apple Watch', 'kJ')}
${record('HKQuantityTypeIdentifierRestingHeartRate', '2026-11-14 07:00:00', '2026-11-14 07:00:00', 56, 'Apple Watch', 'count/min')}
${record('HKQuantityTypeIdentifierRestingHeartRate', '2026-11-14 18:00:00', '2026-11-14 18:00:00', 60, 'Apple Watch', 'count/min')}
${record('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', '2026-11-14 03:00:00', '2026-11-14 03:00:00', 40, 'Apple Watch', 'ms')}
${record(SLEEP, '2026-11-13 23:00:00', '2026-11-14 03:00:00', 'HKCategoryValueSleepAnalysisAsleepCore', 'Apple Watch')}
${record(SLEEP, '2026-11-14 02:00:00', '2026-11-14 06:00:00', 'HKCategoryValueSleepAnalysisAsleepDeep', 'Apple Watch')}
${record(SLEEP, '2026-11-13 22:00:00', '2026-11-14 07:00:00', 'HKCategoryValueSleepAnalysisInBed', 'Apple Watch')}
${record(STEPS, '2020-01-01 08:00:00', '2020-01-01 08:30:00', 999, 'iPhone')}
${record('HKQuantityTypeIdentifierHeight', '2026-11-14 08:00:00', '2026-11-14 08:00:00', 170, 'Health')}
</HealthData>`;

test('Apple Health export: steps from the best source, overlapping sleep merged, resting heart rate averaged', () => {
  const parser = new AppleHealthParser({ today: TODAY, sinceDays: 90 });
  parser.push(EXPORT);
  const result = parser.finish();
  assert.deepEqual(result.days, [{
    date: '2026-11-14', steps: 5000, active_calories: 100, sleep_minutes: 420, resting_heart_rate: 58, hrv_ms: 40,
  }]);
  assert.equal(result.recordsRead, 12);
  assert.equal(result.recordsUsed, 9);
});

test('Apple Health export read in small pieces gives the same days, even when a tag is cut in two', () => {
  const parser = new AppleHealthParser({ today: TODAY, sinceDays: 90 });
  for (let index = 0; index < EXPORT.length; index += 37) parser.push(EXPORT.slice(index, index + 37));
  const whole = new AppleHealthParser({ today: TODAY, sinceDays: 90 });
  whole.push(EXPORT);
  assert.deepEqual(parser.finish().days, whole.finish().days);
});

test('Apple Health records older than the window are ignored', () => {
  const parser = new AppleHealthParser({ today: TODAY, sinceDays: 10 });
  parser.push(`<HealthData>${record(STEPS, '2026-10-01 08:00:00', '2026-10-01 09:00:00', 100)}${record(STEPS, '2026-11-10 08:00:00', '2026-11-10 09:00:00', 200)}</HealthData>`);
  assert.deepEqual(parser.finish().days, [{ date: '2026-11-10', steps: 200 }]);
});

const bytes = (text) => new TextEncoder().encode(text);

function makeZip(name, content, method = 8) {
  const data = Buffer.from(content);
  const body = method === 8 ? deflateRawSync(data) : data;
  const file = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const entry = Buffer.concat([local, file, body]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE(0, 42);
  const directory = Buffer.concat([central, file]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, directory, end]);
}

test('an Apple Health export.zip is opened, inflated and read', async () => {
  for (const method of [8, 0]) {
    const file = new File([makeZip('apple_health_export/export.xml', EXPORT, method)], 'export.zip', { type: 'application/zip' });
    const progress = [];
    const result = await parseAppleHealthFile(file, { today: TODAY, onProgress: (value) => progress.push(value) });
    assert.equal(result.ok, true, `method ${method}`);
    assert.equal(result.days[0].steps, 5000);
    assert.deepEqual(result.range, { from: '2026-11-14', to: '2026-11-14' });
    assert.equal(progress.at(-1), 1);
  }
});

test('Apple Health files that cannot be used say why', async () => {
  const xml = new File([EXPORT], 'export.xml');
  assert.equal((await parseAppleHealthFile(xml, { today: TODAY })).ok, true);
  assert.equal((await parseAppleHealthFile(new File(['<html>hello</html>'], 'export.xml'), { today: TODAY })).error, 'not_health_export');
  assert.equal((await parseAppleHealthFile(new File(['<HealthData></HealthData>'], 'export.xml'), { today: TODAY })).error, 'no_days');
  assert.equal((await parseAppleHealthFile(new File([bytes('not a zip at all')], 'export.zip'), { today: TODAY })).error, 'bad_zip');
  assert.equal((await parseAppleHealthFile(new File([makeZip('notes.txt', 'hello')], 'export.zip'), { today: TODAY })).error, 'no_export');
  const controller = new AbortController();
  controller.abort();
  assert.equal((await parseAppleHealthFile(xml, { today: TODAY, signal: controller.signal })).error, 'aborted');
});

test('long lists are sent in parts the database accepts', () => {
  const parts = chunk(Array.from({ length: 950 }, (_, index) => index));
  assert.deepEqual(parts.map((part) => part.length), [400, 400, 150]);
  assert.deepEqual(chunk([]), []);
});

// ------------------------------------------------------------------- merging and summaries

test('the same day from several devices is merged by priority, per value', () => {
  const merged = mergeDailyMetrics([
    { recorded_date: '2026-11-14', provider: 'apple_health', steps: 8000, sleep_minutes: 400, resting_heart_rate: 60 },
    { recorded_date: '2026-11-14', provider: 'oura', steps: null, sleep_minutes: 430, resting_heart_rate: 52, recovery_score: 80 },
    { recorded_date: '2026-11-14', provider: 'manual', steps: 100, hrv_ms: 45 },
  ]).get('2026-11-14');
  assert.deepEqual([merged.steps, merged.sleep_minutes, merged.resting_heart_rate, merged.recovery_score, merged.hrv_ms], [8000, 430, 52, 80, 45]);
  assert.deepEqual(merged.sources, ['apple_health', 'oura', 'manual']);
});

test('the seven-day series keeps empty days and summarizes only what exists', () => {
  const rows = [
    { recorded_date: '2026-11-13', provider: 'fitbit', steps: 6000, sleep_minutes: 420, resting_heart_rate: 60 },
    { recorded_date: '2026-11-15', provider: 'fitbit', steps: 8000, sleep_minutes: 480, resting_heart_rate: 58 },
  ];
  const series = buildSeries(rows, TODAY, 7);
  assert.equal(series.length, 7);
  assert.equal(series[0].date, '2026-11-09');
  assert.equal(series[6].date, TODAY);
  assert.equal(series[3].steps, null);
  const summary = summarizeSeries(series);
  assert.deepEqual([summary.daysWithData, summary.steps, summary.sleepMinutes, summary.restingHeartRate, summary.recoveryScore], [2, 7000, 450, 59, null]);
  assert.equal(formatSleep(450), '7h 30m');
  assert.equal(formatSleep(null), '—');
});

test('connection state and staleness', () => {
  const connections = [{ provider: 'fitbit', status: 'error', last_synced_at: '2026-11-15T10:00:00Z' }, { provider: 'oura', status: 'connected' }];
  assert.equal(connectionState(connections, 'fitbit'), 'error');
  assert.equal(connectionState(connections, 'garmin', { garmin: false }), 'unconfigured');
  assert.equal(connectionState(connections, 'garmin', { garmin: true }), 'disconnected');
  assert.equal(connectionState(connections, 'apple_health', { apple_health: false }), 'disconnected', 'Apple Health never needs server keys');
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.equal(isStale(connections[0], now), false);
  assert.equal(isStale(connections[0], now + 4 * 3_600_000), true);
  assert.equal(isStale(connections[1], now), true);
});

test('nutrition progress is under, on or over the goal', () => {
  assert.deepEqual(progressOf(2000, 2000), { value: 2000, target: 2000, percent: 100, status: 'on' });
  assert.equal(progressOf(1700, 2000).status, 'under');
  assert.equal(progressOf(1800, 2000).status, 'on');
  assert.equal(progressOf(2200, 2000).status, 'on');
  assert.equal(progressOf(2300, 2000).status, 'over');
  assert.equal(progressOf(100, null).status, 'none');
  assert.deepEqual(progressOf(null, 2000), { value: null, target: 2000, percent: 0, status: 'under' });
});

test('typed numbers win over a MyFitnessPal import for the same day', () => {
  const merged = mergeNutritionByDay([
    { log_date: '2026-11-14', source: 'myfitnesspal_csv', calories_consumed: 2000, protein_g: 120, carbs_g: 200, fats_g: 60, target_calories: 2200 },
    { log_date: '2026-11-14', source: 'manual', calories_consumed: 1900, protein_g: null },
  ]).get('2026-11-14');
  assert.deepEqual([merged.calories_consumed, merged.protein_g, merged.target_calories], [1900, 120, 2200]);
  assert.deepEqual(merged.sources, ['manual', 'myfitnesspal_csv']);
  assert.equal(dayProgress(merged, { protein_g: 150 }).protein.percent, 80);
  assert.equal(dayProgress(merged, { calories: 1000 }).calories.target, 2200, 'the goal saved with the day wins');
});

test('seven-day nutrition averages and adherence', () => {
  const logs = [
    { log_date: '2026-11-12', source: 'manual', calories_consumed: 2000, protein_g: 100, carbs_g: 200, fats_g: 60 },
    { log_date: '2026-11-13', source: 'manual', calories_consumed: 2600, protein_g: 140, carbs_g: 300, fats_g: 80 },
    { log_date: '2026-11-14', source: 'myfitnesspal_csv', calories_consumed: 2100, protein_g: 120, carbs_g: 250, fats_g: 70 },
    { log_date: '2026-10-01', source: 'manual', calories_consumed: 9000 },
  ];
  const summary = summarizeNutrition(logs, { calories: 2100 }, TODAY, 7);
  assert.equal(summary.daysLogged, 3);
  assert.equal(summary.averageCalories, 2233);
  assert.equal(summary.averageProtein, 120);
  assert.equal(summary.averageVsTarget, 106);
  assert.deepEqual([summary.daysWithTarget, summary.adherentDays, summary.adherencePercent], [3, 2, 67]);
  assert.equal(summary.byDay.length, 7);
  assert.equal(summarizeNutrition([], null, TODAY).daysLogged, 0);
  assert.equal(summarizeNutrition(logs, null, TODAY).adherencePercent, null);
});

// ------------------------------------------------------------------------ forms

test('the device entry form turns hours into minutes and reports field errors', () => {
  const good = validateMetricsForm({ date: TODAY, steps: '8000', activeCalories: '', sleepHours: '7.5', restingHeartRate: '55', hrv: '', recovery: '' }, TODAY);
  assert.equal(good.valid, true);
  assert.deepEqual(good.payload, { date: TODAY, steps: 8000, sleep_minutes: 450, resting_heart_rate: 55 });

  const bad = validateMetricsForm({ date: 'x', steps: '-3', sleepHours: '30', restingHeartRate: '5', recovery: '101' }, TODAY);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors, { date: 'hltErrDate', steps: 'hltErrNumber', sleepHours: 'hltErrNumber', restingHeartRate: 'hltErrNumber', recovery: 'hltErrNumber' });
  assert.equal(validateMetricsForm({ date: TODAY }, TODAY).errors.form, 'hltErrNoValues');
  assert.equal(validateMetricsForm({ date: '2030-01-01', steps: '1' }, TODAY).errors.date, 'hltErrDateRange');
});

test('the nutrition form and the goal form validate like the database does', () => {
  const good = validateNutritionForm({ date: TODAY, calories: '2100', protein: '150,5', carbs: '', fats: '70', water: '2500', notes: '  fine  ' }, TODAY);
  assert.equal(good.valid, true);
  assert.deepEqual(good.payload, { date: TODAY, calories: 2100, protein: 150.5, carbs: null, fats: 70, waterMl: 2500, notes: 'fine' });
  assert.deepEqual(validateNutritionForm({ date: TODAY, calories: '30000', protein: 'x' }, TODAY).errors, { calories: 'nutErrNumber', protein: 'nutErrNumber' });
  assert.equal(validateNutritionForm({ date: TODAY }, TODAY).errors.form, 'nutErrNoValues');
  assert.equal(validateNutritionForm({ date: TODAY, calories: '1', notes: 'x'.repeat(501) }, TODAY).errors.notes, 'nutErrNotes');
  assert.equal(validateNutritionForm({ date: '', calories: '1' }, TODAY).errors.date, 'nutErrDate');

  assert.deepEqual(validateTargetsForm({ calories: '2200', protein: '150', carbs: '', fats: '' }).payload, { calories: 2200, protein: 150, carbs: null, fats: null });
  assert.equal(validateTargetsForm({ calories: '100' }).errors.calories, 'nutErrCaloriesGoal');
  assert.equal(validateTargetsForm({ calories: '', protein: '', carbs: '', fats: '' }).valid, true, 'all empty clears the goal');
});

// ------------------------------------------------------------------- translations

const HEALTH_KEY = /^(hlt|nut|navIntegrations$|trnViewHealth$|jackTool_(get_my_health_metrics|log_nutrition_summary|get_client_wearables_and_nutrition)_|jackQ_(clientHealth|clientLogMeal|coachHealth)$)/;

test('every language has the same wearable and nutrition texts', () => {
  const keysOf = (locale) => Object.keys(translations[locale]).filter((key) => HEALTH_KEY.test(key)).sort();
  const english = keysOf('en');
  assert.ok(english.length > 120);
  for (const locale of supportedLocales) {
    assert.deepEqual(keysOf(locale), english, locale);
    for (const key of english) assert.ok(String(translations[locale][key]).trim(), `${locale}.${key}`);
  }
});

test('every key the forms, skip reasons and import errors can return exists in all languages', () => {
  const keys = new Set([
    ...Object.values(SKIP_REASON_KEYS),
    ...['too_large', 'too_many_rows', 'too_many_days', 'empty', 'missing_columns', 'no_days', 'bad_json', 'bad_zip', 'no_export', 'not_health_export', 'aborted', 'other'].map(importErrorKey),
    ...['hltErrDate', 'hltErrDateRange', 'hltErrNumber', 'hltErrNoValues', 'nutErrDate', 'nutErrDateRange', 'nutErrNumber', 'nutErrNotes', 'nutErrNoValues', 'nutErrCaloriesGoal'],
    ...['apple_health', 'fitbit', 'garmin', 'oura'].flatMap((provider) => [`hltProv_${provider}`, `hltProvDesc_${provider}`]),
    ...['connected', 'error', 'disconnected', 'unconfigured'].map((state) => `hltState_${state}`),
    ...['connected', 'connected_nodata', 'denied', 'failed'].map((result) => `hltResult_${result}`),
    ...['on', 'under', 'over'].map((status) => `nutStatus_${status}`),
    ...['manual', 'myfitnesspal_csv', 'myfitnesspal_sync'].map((source) => `nutSource_${source}`),
  ]);
  for (const locale of supportedLocales) for (const key of keys) assert.ok(translations[locale][key], `${locale}.${key}`);
});
