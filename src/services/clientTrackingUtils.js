export function getLocalDateString(date = new Date()) {
  const localDate = new Date(date);
  localDate.setMinutes(localDate.getMinutes() - localDate.getTimezoneOffset());
  return localDate.toISOString().slice(0, 10);
}

export function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  return getLocalDateString(date);
}

export function normalizeBodyMetric({ weight_kg, body_fat_percentage, notes = '' }) {
  const weight = weight_kg === '' || weight_kg === null || weight_kg === undefined ? null : Number(weight_kg);
  const bodyFat = body_fat_percentage === '' || body_fat_percentage === null || body_fat_percentage === undefined
    ? null
    : Number(body_fat_percentage);

  if (weight !== null && (!Number.isFinite(weight) || weight < 0.1 || weight > 500)) {
    throw new RangeError('Weight must be between 0.1 and 500 kg.');
  }
  if (bodyFat !== null && (!Number.isFinite(bodyFat) || bodyFat < 0 || bodyFat > 100)) {
    throw new RangeError('Body fat must be between 0 and 100 percent.');
  }
  if (weight === null && bodyFat === null) {
    throw new TypeError('Enter weight or body fat before saving.');
  }
  if (typeof notes !== 'string' || notes.length > 500) {
    throw new RangeError('Metric notes cannot exceed 500 characters.');
  }

  return { weight_kg: weight, body_fat_percentage: bodyFat, notes: notes.trim() };
}

export function validateProgressPhoto(file) {
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!file || !allowedTypes.has(file.type)) {
    throw new TypeError('Choose a JPG, PNG, or WebP image.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new RangeError('Progress photos must be 10 MB or smaller.');
  }
}

export const HABIT_GOALS = Object.freeze({ sleepHours: 8, waterLiters: 2.5, steps: 10000 });

export function calculateGoalPercent(value, goal) {
  const amount = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(amount) || amount <= 0 || goal <= 0) return 0;
  return Math.min(100, Math.round((amount / goal) * 100));
}

export function summarizeWorkoutSets(entries) {
  let totalSets = 0;
  let completedSets = 0;
  let volumeKg = 0;
  for (const entry of entries) {
    for (const set of entry.sets) {
      totalSets += 1;
      if (!set.done) continue;
      completedSets += 1;
      const reps = Number(set.reps);
      const weight = set.weight_kg === '' || set.weight_kg === null ? 0 : Number(set.weight_kg);
      if (Number.isFinite(reps) && Number.isFinite(weight)) volumeKg += reps * weight;
    }
  }
  return {
    totalSets,
    completedSets,
    volumeKg: Math.round(volumeKg * 10) / 10,
    percent: totalSets === 0 ? 0 : Math.round((completedSets / totalSets) * 100),
  };
}

export function filterByDateRange(items, dateField, days, today = getLocalDateString()) {
  if (!days) return items;
  const start = shiftDate(today, -(days - 1));
  return items.filter((item) => item[dateField] >= start);
}

export function summarizeSeries(items, field) {
  const values = items
    .filter((item) => item[field] !== null && item[field] !== undefined && item[field] !== '')
    .map((item) => Number(item[field]))
    .filter(Number.isFinite);
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  const round = (value) => Math.round(value * 100) / 100;
  return {
    count: values.length,
    latest: values[values.length - 1],
    change: round(values[values.length - 1] - values[0]),
    min: Math.min(...values),
    max: Math.max(...values),
    average: round(sum / values.length),
  };
}