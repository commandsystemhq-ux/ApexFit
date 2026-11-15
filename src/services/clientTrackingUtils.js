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
