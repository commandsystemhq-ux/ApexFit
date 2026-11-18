// Pure helpers for the daily checklist: form checks, progress, grouping and the same arithmetic the database uses,
// so a checkbox can respond at once and the saved result then confirms it.

export const CATEGORIES = ['workout', 'meal', 'water', 'habit', 'custom'];
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const LIMITS = { title: 120, unit: 20, target: 100000 };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseAmount(value) {
  const text = String(value ?? '').trim().replace(',', '.');
  if (text === '') return null;
  return /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : Number.NaN;
}

export function emptyTaskForm(category = 'custom') {
  return { category, title: '', target: category === 'water' ? '2500' : '', unit: category === 'water' ? 'ml' : '', time: '', repeat: 'daily', days: [...ALL_DAYS] };
}

export function validateTaskForm(form) {
  const errors = {};
  const category = CATEGORIES.includes(form.category) ? form.category : null;
  if (!category) errors.category = 'chkErrCategory';

  const title = String(form.title ?? '').trim();
  if (!title) errors.title = 'chkErrTitle';
  else if (title.length > LIMITS.title) errors.title = 'chkErrTitleLong';

  const target = parseAmount(form.target);
  if (Number.isNaN(target) || (target !== null && (target <= 0 || target > LIMITS.target))) errors.target = 'chkErrTarget';

  const unit = String(form.unit ?? '').trim();
  if (unit.length > LIMITS.unit) errors.unit = 'chkErrUnit';

  const time = String(form.time ?? '').trim();
  if (time && !TIME.test(time)) errors.time = 'chkErrTime';

  let repeatDays = null;
  if (form.repeat === 'daily') repeatDays = ALL_DAYS;
  else if (form.repeat === 'days') {
    repeatDays = [...new Set((form.days || []).map(Number))].filter((day) => day >= 0 && day <= 6).sort();
    if (repeatDays.length === 0) errors.days = 'chkErrDays';
  }


  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: { category, title, target: target ?? null, unit: unit || null, remindTime: time || null, repeatDays },
  };
}

// ---------------------------------------------------------------------------- progress

export function itemPercent(item) {
  if (item.target_amount) return Math.max(0, Math.min(100, Math.round((Number(item.progress_amount) / Number(item.target_amount)) * 100)));
  return item.is_done ? 100 : 0;
}

export function dayCompletion(items) {
  const total = items.length;
  const done = items.filter((item) => item.is_done).length;
  return { total, done, left: total - done, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function groupItems(items) {
  return CATEGORIES
    .map((category) => ({ category, items: items.filter((item) => item.category === category) }))
    .filter((group) => group.items.length > 0);
}

export function replaceItem(items, updated) {
  return items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
}

// What the database does when a task is checked or unchecked (see set_checklist_item).
export function toggled(item, done) {
  let progress = Number(item.progress_amount) || 0;
  const target = item.target_amount === null || item.target_amount === undefined ? null : Number(item.target_amount);
  if (done && target !== null && progress < target) progress = target;
  else if (!done && target !== null && progress >= target) progress = 0;
  return { ...item, is_done: done, progress_amount: progress };
}

// ...and when an amount is added (for example 250 ml of water).
export function withAmount(item, delta) {
  const target = item.target_amount === null || item.target_amount === undefined ? null : Number(item.target_amount);
  const progress = Math.max(0, Math.min(LIMITS.target, Math.round(((Number(item.progress_amount) || 0) + delta) * 100) / 100));
  return { ...item, progress_amount: progress, is_done: target !== null ? progress >= target : item.is_done };
}

export function quickSteps(item) {
  if (item.category !== 'water') return [1];
  return /^(l|lt|liter|litre|liters|litres)$/i.test(item.unit || '') ? [0.25, 0.5] : [250, 500];
}

export function formatAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

// Days in a row (ending today, or yesterday while today is unfinished) with every task done.
export function streakOf(summary) {
  const days = [...(summary || [])].sort((left, right) => left.date.localeCompare(right.date));
  if (days.length === 0) return 0;
  const complete = (day) => day.total > 0 && day.done === day.total;
  let index = days.length - 1;
  if (!complete(days[index])) index -= 1;
  let streak = 0;
  while (index >= 0 && complete(days[index])) {
    streak += 1;
    index -= 1;
  }
  return streak;
}

// A starter set, in the person's language.
export function suggestedTasks(t) {
  return [
    { category: 'workout', title: t('chkSuggestWorkout'), target: '', unit: '', time: '', repeat: 'daily', days: [...ALL_DAYS] },
    { category: 'meal', title: t('chkSuggestMeals'), target: '', unit: '', time: '', repeat: 'daily', days: [...ALL_DAYS] },
    { category: 'water', title: t('chkSuggestWater'), target: '2500', unit: 'ml', time: '', repeat: 'daily', days: [...ALL_DAYS] },
    { category: 'habit', title: t('chkSuggestSleep'), target: '', unit: '', time: '', repeat: 'daily', days: [...ALL_DAYS] },
  ];
}
