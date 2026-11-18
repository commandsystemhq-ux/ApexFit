import { addDays, parseNumber } from './healthImport.js';

export const HEALTH_PROVIDERS = ['apple_health'];
export const METRIC_FIELDS = ['steps', 'active_calories', 'sleep_minutes', 'resting_heart_rate', 'hrv_ms', 'recovery_score'];

// When two sources report the same day, each value comes from the first source in this list that has it.
// Values typed in by hand are the fallback.
export const METRIC_PRIORITY = ['apple_health', 'manual'];
export const NUTRITION_PRIORITY = ['manual', 'myfitnesspal_sync', 'myfitnesspal_csv'];

export const ADHERENCE_BAND = { low: 90, high: 110 };

// ------------------------------------------------------------------ days

export function lastDates(today, count) {
  return Array.from({ length: count }, (_, index) => addDays(today, index - (count - 1)));
}

const present = (value) => value !== null && value !== undefined;
const rank = (list, item) => (list.includes(item) ? list.indexOf(item) : list.length);

// ---------------------------------------------------------- wearable data

export function mergeDailyMetrics(rows) {
  const byDay = new Map();
  for (const row of rows || []) {
    const day = byDay.get(row.recorded_date) || [];
    day.push(row);
    byDay.set(row.recorded_date, day);
  }
  const merged = new Map();
  for (const [date, list] of byDay) {
    const ordered = [...list].sort((left, right) => rank(METRIC_PRIORITY, left.provider) - rank(METRIC_PRIORITY, right.provider));
    const out = { date, sources: [] };
    for (const field of METRIC_FIELDS) {
      const source = ordered.find((row) => present(row[field]));
      out[field] = source ? Number(source[field]) : null;
      if (source && !out.sources.includes(source.provider)) out.sources.push(source.provider);
    }
    merged.set(date, out);
  }
  return merged;
}

// One entry per day of the window, with empty days kept so charts show the gaps.
export function buildSeries(rows, today, days = 7) {
  const merged = mergeDailyMetrics(rows);
  return lastDates(today, days).map((date) => merged.get(date) || { date, sources: [], ...Object.fromEntries(METRIC_FIELDS.map((field) => [field, null])) });
}

export function averageOf(values, digits = 0) {
  const numbers = values.filter(present).map(Number).filter(Number.isFinite);
  if (numbers.length === 0) return null;
  const mean = numbers.reduce((total, value) => total + value, 0) / numbers.length;
  const factor = 10 ** digits;
  return Math.round(mean * factor) / factor;
}

export function summarizeSeries(series) {
  return {
    daysWithData: series.filter((day) => METRIC_FIELDS.some((field) => present(day[field]))).length,
    steps: averageOf(series.map((day) => day.steps)),
    activeCalories: averageOf(series.map((day) => day.active_calories)),
    sleepMinutes: averageOf(series.map((day) => day.sleep_minutes)),
    restingHeartRate: averageOf(series.map((day) => day.resting_heart_rate)),
    hrvMs: averageOf(series.map((day) => day.hrv_ms), 1),
    recoveryScore: averageOf(series.map((day) => day.recovery_score)),
  };
}

export function formatSleep(minutes) {
  if (!present(minutes)) return '—';
  const total = Math.round(Number(minutes));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
}

// 'connected' when data from that source has been imported, otherwise 'disconnected'.
export function connectionState(connections, provider) {
  const connection = (connections || []).find((item) => item.provider === provider);
  return connection ? connection.status : 'disconnected';
}

// ---------------------------------------------------------------- nutrition

const NUTRITION_FIELDS = ['calories_consumed', 'protein_g', 'carbs_g', 'fats_g', 'water_ml'];

export function mergeNutritionByDay(logs) {
  const byDay = new Map();
  for (const log of logs || []) {
    const list = byDay.get(log.log_date) || [];
    list.push(log);
    byDay.set(log.log_date, list);
  }
  const merged = new Map();
  for (const [date, list] of byDay) {
    const ordered = [...list].sort((left, right) => rank(NUTRITION_PRIORITY, left.source) - rank(NUTRITION_PRIORITY, right.source));
    const out = { log_date: date, sources: [], target_calories: null, notes: null };
    for (const field of NUTRITION_FIELDS) {
      const source = ordered.find((row) => present(row[field]));
      out[field] = source ? Number(source[field]) : null;
      if (source && !out.sources.includes(source.source)) out.sources.push(source.source);
    }
    out.target_calories = ordered.find((row) => present(row.target_calories))?.target_calories ?? null;
    out.notes = ordered.find((row) => row.notes)?.notes ?? null;
    merged.set(date, out);
  }
  return merged;
}

export function progressOf(value, target) {
  if (!present(target) || Number(target) <= 0) return { value: present(value) ? Number(value) : null, target: null, percent: null, status: 'none' };
  if (!present(value)) return { value: null, target: Number(target), percent: 0, status: 'under' };
  const percent = Math.round((Number(value) / Number(target)) * 100);
  const status = percent < ADHERENCE_BAND.low ? 'under' : percent > ADHERENCE_BAND.high ? 'over' : 'on';
  return { value: Number(value), target: Number(target), percent, status };
}

// A day compared with the goal. The goal saved with the log wins over the current one for the calories.
export function dayProgress(day, targets) {
  return {
    calories: progressOf(day?.calories_consumed, day?.target_calories ?? targets?.calories),
    protein: progressOf(day?.protein_g, targets?.protein_g),
    carbs: progressOf(day?.carbs_g, targets?.carbs_g),
    fats: progressOf(day?.fats_g, targets?.fats_g),
  };
}

export function summarizeNutrition(logs, targets, today, days = 7) {
  const merged = mergeNutritionByDay(logs);
  const dates = lastDates(today, days);
  const logged = dates.map((date) => merged.get(date)).filter((day) => day && NUTRITION_FIELDS.some((field) => present(day[field])));
  const withCalories = logged.filter((day) => present(day.calories_consumed));
  const withTarget = withCalories.filter((day) => present(day.target_calories ?? targets?.calories));
  const adherentDays = withTarget.filter((day) => progressOf(day.calories_consumed, day.target_calories ?? targets?.calories).status === 'on').length;
  const averageCalories = averageOf(withCalories.map((day) => day.calories_consumed));
  const targetCalories = targets?.calories ?? null;
  return {
    daysLogged: logged.length,
    averageCalories,
    averageProtein: averageOf(logged.map((day) => day.protein_g), 1),
    averageCarbs: averageOf(logged.map((day) => day.carbs_g), 1),
    averageFats: averageOf(logged.map((day) => day.fats_g), 1),
    averageWater: averageOf(logged.map((day) => day.water_ml)),
    targetCalories,
    averageVsTarget: present(averageCalories) && present(targetCalories) ? Math.round((averageCalories / targetCalories) * 100) : null,
    daysWithTarget: withTarget.length,
    adherentDays,
    adherencePercent: withTarget.length ? Math.round((adherentDays / withTarget.length) * 100) : null,
    byDay: dates.map((date) => merged.get(date) || { log_date: date, sources: [], calories_consumed: null }),
  };
}

// ----------------------------------------------------------------- forms

function numberField(value, { min, max, integer = false }) {
  const text = String(value ?? '').trim();
  if (text === '') return { value: null };
  const number = parseNumber(text);
  if (number === null || Number.isNaN(number) || number < min || number > max) return { error: true };
  return { value: integer ? Math.round(number) : Math.round(number * 100) / 100 };
}

function isoDayOrNull(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) ? value : null;
}

export function validateMetricsForm(form, today) {
  const errors = {};
  const date = isoDayOrNull(form.date);
  if (!date) errors.date = 'hltErrDate';
  else if (date > addDays(today, 1) || date < addDays(today, -3650)) errors.date = 'hltErrDateRange';

  const fields = {
    steps: numberField(form.steps, { min: 0, max: 200000, integer: true }),
    active_calories: numberField(form.activeCalories, { min: 0, max: 20000, integer: true }),
    resting_heart_rate: numberField(form.restingHeartRate, { min: 20, max: 250, integer: true }),
    hrv_ms: numberField(form.hrv, { min: 0, max: 500 }),
    recovery_score: numberField(form.recovery, { min: 0, max: 100, integer: true }),
  };
  const hours = numberField(form.sleepHours, { min: 0, max: 24 });
  const labels = { steps: 'steps', active_calories: 'activeCalories', resting_heart_rate: 'restingHeartRate', hrv_ms: 'hrv', recovery_score: 'recovery' };
  for (const [field, result] of Object.entries(fields)) if (result.error) errors[labels[field]] = 'hltErrNumber';
  if (hours.error) errors.sleepHours = 'hltErrNumber';

  const entry = { date };
  for (const [field, result] of Object.entries(fields)) if (present(result.value)) entry[field] = result.value;
  if (present(hours.value)) entry.sleep_minutes = Math.round(hours.value * 60);
  if (!errors.date && Object.keys(entry).length === 1 && Object.keys(errors).length === 0) errors.form = 'hltErrNoValues';
  return { valid: Object.keys(errors).length === 0, errors, payload: entry };
}

export function validateNutritionForm(form, today) {
  const errors = {};
  const date = isoDayOrNull(form.date);
  if (!date) errors.date = 'nutErrDate';
  else if (date > addDays(today, 1) || date < addDays(today, -3650)) errors.date = 'nutErrDateRange';

  const calories = numberField(form.calories, { min: 0, max: 20000, integer: true });
  const protein = numberField(form.protein, { min: 0, max: 2000 });
  const carbs = numberField(form.carbs, { min: 0, max: 3000 });
  const fats = numberField(form.fats, { min: 0, max: 2000 });
  const water = numberField(form.water, { min: 0, max: 20000, integer: true });
  for (const [key, result] of Object.entries({ calories, protein, carbs, fats, water })) if (result.error) errors[key] = 'nutErrNumber';
  const notes = String(form.notes ?? '').trim();
  if (notes.length > 500) errors.notes = 'nutErrNotes';
  if (Object.keys(errors).length === 0 && [calories, protein, carbs, fats, water].every((item) => !present(item.value))) errors.form = 'nutErrNoValues';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: { date, calories: calories.value, protein: protein.value, carbs: carbs.value, fats: fats.value, waterMl: water.value, notes: notes || null },
  };
}

export function validateTargetsForm(form) {
  const errors = {};
  const calories = numberField(form.calories, { min: 500, max: 10000, integer: true });
  const protein = numberField(form.protein, { min: 0, max: 1000 });
  const carbs = numberField(form.carbs, { min: 0, max: 1500 });
  const fats = numberField(form.fats, { min: 0, max: 1000 });
  for (const [key, result] of Object.entries({ calories, protein, carbs, fats })) if (result.error) errors[key] = key === 'calories' ? 'nutErrCaloriesGoal' : 'nutErrNumber';
  return { valid: Object.keys(errors).length === 0, errors, payload: { calories: calories.value, protein: protein.value, carbs: carbs.value, fats: fats.value } };
}

export function targetsToForm(targets) {
  const text = (value) => (present(value) ? String(Number(value)) : '');
  return { calories: text(targets?.calories), protein: text(targets?.protein_g), carbs: text(targets?.carbs_g), fats: text(targets?.fats_g) };
}

export function emptyMetricsForm(today) {
  return { date: today, steps: '', activeCalories: '', sleepHours: '', restingHeartRate: '', hrv: '', recovery: '' };
}

export function emptyNutritionForm(today) {
  return { date: today, calories: '', protein: '', carbs: '', fats: '', water: '', notes: '' };
}

export function nutritionFormFromDay(day, today) {
  const text = (value) => (present(value) ? String(Number(value)) : '');
  return day
    ? { date: day.log_date, calories: text(day.calories_consumed), protein: text(day.protein_g), carbs: text(day.carbs_g), fats: text(day.fats_g), water: text(day.water_ml), notes: day.notes || '' }
    : emptyNutritionForm(today);
}

// ---------------------------------------------------------------- import summaries

export const SKIP_REASON_KEYS = {
  bad_date: 'nutSkipBadDate',
  missing_date: 'nutSkipMissingDate',
  date_out_of_range: 'nutSkipDateRange',
  bad_number: 'nutSkipBadNumber',
  value_out_of_range: 'nutSkipValueRange',
  no_data: 'nutSkipNoData',
};

export function countSkipReasons(skipped) {
  const counts = {};
  for (const item of skipped || []) counts[item.reason] = (counts[item.reason] || 0) + 1;
  return counts;
}

export function importErrorKey(error) {
  return {
    too_large: 'hltImpTooLarge',
    too_many_rows: 'hltImpTooManyRows',
    too_many_days: 'hltImpTooManyDays',
    empty: 'hltImpEmpty',
    missing_columns: 'hltImpMissingColumns',
    no_days: 'hltImpNoDays',
    bad_json: 'hltImpBadJson',
    bad_zip: 'hltImpBadZip',
    no_export: 'hltImpNoExport',
    not_health_export: 'hltImpNotHealth',
    aborted: 'hltImpAborted',
  }[error] || 'hltImpFailed';
}
