import { shiftDate } from './clientTrackingUtils.js';

export const PHOTO_SLOTS = Object.freeze(['front', 'side', 'back']);
export const CHECKIN_PHOTO_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
export const MAX_CHECKIN_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_CHECKIN_NOTES = 2000;
export const MAX_FEEDBACK = 2000;
export const SIGNED_URL_SECONDS = 300;

// The Monday of the week a date ('YYYY-MM-DD') falls in; the check-in is kept per week from Monday.
export function weekStartOf(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  const isoDay = (date.getUTCDay() + 6) % 7;
  return shiftDate(dateString, -isoDay);
}

export function emptyCheckinForm() {
  return { weight: '', sleepHours: '', sleepQuality: 0, workout: 0, diet: 0, energy: 0, notes: '' };
}

export function formFromCheckin(checkin) {
  const text = (value) => (value === null || value === undefined ? '' : String(Number(value)));
  return {
    weight: text(checkin.weight_kg),
    sleepHours: text(checkin.sleep_hours),
    sleepQuality: checkin.sleep_quality_1_5 || 0,
    workout: checkin.workout_adherence_1_10 || 0,
    diet: checkin.diet_adherence_1_10 || 0,
    energy: checkin.energy_level_1_5 || 0,
    notes: checkin.client_notes || '',
  };
}

const optionalNumber = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Checks the weekly form before it is sent. Errors are translation keys, one per field.
export function validateCheckinForm(form) {
  const errors = {};
  const weight = optionalNumber(form.weight);
  const sleepHours = optionalNumber(form.sleepHours);
  if (weight !== null && (!Number.isFinite(weight) || weight < 20 || weight > 500)) errors.weight = 'ckErr_weight';
  if (sleepHours !== null && (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 24)) errors.sleepHours = 'ckErr_sleepHours';
  if (!inRange(Number(form.sleepQuality), 1, 5)) errors.sleepQuality = 'ckErr_rate';
  if (!inRange(Number(form.workout), 1, 10)) errors.workout = 'ckErr_rate';
  if (!inRange(Number(form.diet), 1, 10)) errors.diet = 'ckErr_rate';
  if (!inRange(Number(form.energy), 1, 5)) errors.energy = 'ckErr_rate';
  if (String(form.notes ?? '').length > MAX_CHECKIN_NOTES) errors.notes = 'ckErr_notes';
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: {
      weightKg: weight === null ? null : Math.round(weight * 10) / 10,
      sleepHours: sleepHours === null ? null : Math.round(sleepHours * 10) / 10,
      sleepQuality: Number(form.sleepQuality),
      workoutAdherence: Number(form.workout),
      dietAdherence: Number(form.diet),
      energy: Number(form.energy),
      notes: String(form.notes ?? '').trim(),
    },
  };
}

export function validateCheckinPhoto(file) {
  if (!file || !CHECKIN_PHOTO_TYPES[file.type]) return 'ckErr_photoType';
  if (file.size > MAX_CHECKIN_PHOTO_BYTES) return 'ckErr_photoSize';
  return null;
}

export function checkinPhotoPath(clientId, weekStart, slot, file, uniqueId) {
  return `${clientId}/${weekStart}-${slot}-${uniqueId}.${CHECKIN_PHOTO_TYPES[file.type]}`;
}

// What changed since the week before. `direction` is 'up', 'down' or 'same'; a missing number on either side gives null.
export const COMPARED_FIELDS = Object.freeze([
  { key: 'weight_kg', labelKey: 'ckWeight', unit: 'kg', decimals: 1 },
  { key: 'sleep_hours', labelKey: 'ckSleepHours', unit: 'h', decimals: 1 },
  { key: 'sleep_quality_1_5', labelKey: 'ckSleepQuality', unit: '/5', decimals: 0 },
  { key: 'workout_adherence_1_10', labelKey: 'ckWorkout', unit: '/10', decimals: 0 },
  { key: 'diet_adherence_1_10', labelKey: 'ckDiet', unit: '/10', decimals: 0 },
  { key: 'energy_level_1_5', labelKey: 'ckEnergy', unit: '/5', decimals: 0 },
]);

export function diffCheckins(current, previous) {
  return COMPARED_FIELDS.map((field) => {
    const now = current?.[field.key];
    const before = previous?.[field.key];
    const hasBoth = now !== null && now !== undefined && before !== null && before !== undefined;
    const delta = hasBoth ? Math.round((Number(now) - Number(before)) * 10) / 10 : null;
    return {
      ...field,
      value: now === null || now === undefined ? null : Number(now),
      previous: before === null || before === undefined ? null : Number(before),
      delta,
      direction: delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'same',
    };
  });
}

// The weeks of one client that have a photo in the given slot, newest first, for the side-by-side comparison.
export function weeksWithPhoto(checkins, slot) {
  return (checkins || [])
    .filter((checkin) => checkin.photo_paths?.[slot])
    .sort((a, b) => String(b.week_start_date).localeCompare(String(a.week_start_date)));
}

// Sensible starting choice for the comparison: the oldest and the newest week that have a photo in the slot.
export function defaultComparison(checkins, slot) {
  const weeks = weeksWithPhoto(checkins, slot);
  if (weeks.length < 2) return { left: weeks[1]?.id ?? '', right: weeks[0]?.id ?? '' };
  return { left: weeks[weeks.length - 1].id, right: weeks[0].id };
}

export function photoCount(checkin) {
  return PHOTO_SLOTS.filter((slot) => checkin?.photo_paths?.[slot]).length;
}
