// Pure helpers for custom reminders: kinds, days of the week, the form and its validation, and how a schedule reads.
// Nothing here touches the network.

export const REMINDER_KINDS = ['water', 'meal', 'workout', 'checkin', 'custom'];
export const REMINDER_KIND_KEYS = {
  water: 'rmKindWater',
  meal: 'rmKindMeal',
  workout: 'rmKindWorkout',
  checkin: 'rmKindCheckin',
  custom: 'rmKindCustom',
};
export const REMINDER_KIND_ICONS = { water: '\uD83D\uDCA7', meal: '\uD83C\uDF7D', workout: '\uD83C\uDFCB', checkin: '\u2611', custom: '\u23F0' };

// ISO weekdays: 1 = Monday ... 7 = Sunday (the same numbers the database uses).
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
export const WEEKDAYS_ONLY = [1, 2, 3, 4, 5];
export const REMINDER_TITLE_MAX = 80;
export const REMINDER_MESSAGE_MAX = 300;
export const REMINDER_LIMIT = 40;

export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function emptyReminderForm(kind = 'water') {
  return { id: null, kind, title: '', message: '', time: '09:00', days: [...ALL_DAYS], active: true, target: '' };
}

// A saved reminder (custom_reminders row) as the editable form.
export function reminderToForm(row, me) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    message: row.message || '',
    time: String(row.time_of_day || '09:00').slice(0, 5),
    days: [...(row.days_of_week || ALL_DAYS)].map(Number).sort((a, b) => a - b),
    active: Boolean(row.is_active),
    target: row.target_id && row.target_id !== me ? row.target_id : '',
  };
}

export function toggleDay(days, day) {
  const next = days.includes(day) ? days.filter((value) => value !== day) : [...days, day];
  return next.sort((a, b) => a - b);
}

// Errors are translation keys.
export function validateReminder(form, timezone = localTimezone()) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  const message = String(form.message ?? '').trim();
  if (title.length < 1 || title.length > REMINDER_TITLE_MAX) errors.title = 'rmErrTitle';
  if (message.length > REMINDER_MESSAGE_MAX) errors.message = 'rmErrMessage';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(form.time ?? ''))) errors.time = 'rmErrTime';
  const days = [...new Set((form.days || []).map(Number))].filter((day) => ALL_DAYS.includes(day)).sort((a, b) => a - b);
  if (days.length === 0) errors.days = 'rmErrDays';
  if (!REMINDER_KINDS.includes(form.kind)) errors.kind = 'rmErrKind';
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: { id: form.id || null, kind: form.kind, title, message, time: `${form.time}:00`, days, timezone, active: Boolean(form.active), target: form.target || null },
  };
}

// The short name of a weekday in the person's language ("Mon" / "الاثنين" ...).
export function weekdayLabel(isoDay, locale, style = 'short') {
  // 1 January 2024 was a Monday.
  return new Date(Date.UTC(2024, 0, isoDay)).toLocaleDateString(locale, { weekday: style, timeZone: 'UTC' });
}

export function formatReminderTime(time, locale) {
  const [hours, minutes] = String(time || '00:00').split(':').map(Number);
  return new Date(Date.UTC(2024, 0, 1, hours || 0, minutes || 0)).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

export function describeDays(days, locale, t) {
  const sorted = [...days].map(Number).sort((a, b) => a - b);
  if (sorted.length === 7) return t('rmEveryDay');
  if (sorted.length === 5 && WEEKDAYS_ONLY.every((day) => sorted.includes(day))) return t('rmWeekdays');
  return sorted.map((day) => weekdayLabel(day, locale)).join(' · ');
}

export function defaultTitleKey(kind) {
  return `rmDefaultTitle_${kind}`;
}

// The reminders that are switched on, soonest time of day first (used for the "next reminders" summary).
export function activeReminders(reminders) {
  return reminders.filter((item) => item.is_active).sort((a, b) => String(a.time_of_day).localeCompare(String(b.time_of_day)));
}
