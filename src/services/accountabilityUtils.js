// Pure helpers for tasks, completion rates and progress reports (no network, no React).

export const TASK_KINDS = [
  { id: 'workout', labelKey: 'taskKindWorkout', icon: '\u{1F3CB}\uFE0F' },
  { id: 'habit', labelKey: 'taskKindHabit', icon: '\u2705' },
  { id: 'check_in', labelKey: 'taskKindCheckIn', icon: '\u{1F4DD}' },
];

export const DEFAULT_TASK_XP = 20;
export const REPORT_PERIODS = [7, 30, 90];

export function fillText(template, values = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined || values[key] === null ? match : String(values[key])));
}

export function emptyTaskForm(today) {
  return { kind: 'workout', title: '', description: '', dueDate: today, xp: String(DEFAULT_TASK_XP) };
}

// Checks the assign-a-task form. `today` is the local YYYY-MM-DD date. Messages are translation keys.
export function validateTaskForm(form, today, { self = false } = {}) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  const description = String(form.description ?? '').trim();
  if (!TASK_KINDS.some((kind) => kind.id === form.kind)) errors.kind = 'taskErrorKind';
  if (!title || title.length > 120) errors.title = 'taskErrorTitle';
  if (description.length > 500) errors.description = 'taskErrorDescription';

  const due = String(form.dueDate || today);
  const dueTime = Date.parse(`${due}T12:00:00Z`);
  const todayTime = Date.parse(`${today}T12:00:00Z`);
  const span = Math.round((dueTime - todayTime) / 86_400_000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(dueTime) || span < -1 || span > (self ? 7 : 90)) errors.dueDate = self ? 'taskErrorDueSelf' : 'taskErrorDue';

  const xp = form.xp === '' || form.xp === undefined ? DEFAULT_TASK_XP : Number(form.xp);
  if (!self && (!Number.isInteger(xp) || xp < 1 || xp > 100)) errors.xp = 'taskErrorXp';

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: { kind: form.kind, title, description, dueDate: due, xp },
  };
}

// Open tasks (overdue ones first), then the ones already done.
export function groupTasks(tasks = []) {
  const open = tasks.filter((task) => task.status === 'pending');
  return {
    overdue: open.filter((task) => task.is_overdue),
    open: open.filter((task) => !task.is_overdue),
    done: tasks.filter((task) => task.status === 'done'),
  };
}

export function rateTone(rate) {
  if (rate === null || rate === undefined) return 'none';
  if (rate >= 75) return 'good';
  if (rate >= 40) return 'warn';
  return 'low';
}

// The average completion rate over the clients that were given work in the period.
export function averageRate(rows = []) {
  const measured = rows.filter((row) => row.rate !== null && row.rate !== undefined);
  if (measured.length === 0) return null;
  return Math.round(measured.reduce((sum, row) => sum + Number(row.rate), 0) / measured.length);
}

export function ratesByClient(rows = []) {
  return new Map(rows.map((row) => [row.client_id, row]));
}

// Clients that fell behind first (lowest rate), then those with nothing assigned.
export function sortByRate(rows = []) {
  return [...rows].sort((a, b) => (a.rate ?? 101) - (b.rate ?? 101) || String(a.client_name).localeCompare(String(b.client_name)));
}

const number = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const trimNumber = (value) => String(Math.round(Math.abs(value) * 10) / 10);

// A ready-made report written from the numbers alone (no AI). `t` is the translation function.
export function buildReportText(stats, t) {
  const days = stats.period_days;
  const lines = [];

  const workouts = number(stats.workouts);
  if (workouts) lines.push(fillText(t('rptWorkouts'), { n: workouts }));
  const volume = number(stats.volume_kg);
  if (volume) lines.push(fillText(t('rptVolume'), { kg: volume.toLocaleString('en-US') }));

  const change = number(stats.weight_change_kg);
  if (change !== null) {
    if (change <= -0.1) lines.push(fillText(t('rptWeightDown'), { kg: trimNumber(change) }));
    else if (change >= 0.1) lines.push(fillText(t('rptWeightUp'), { kg: trimNumber(change) }));
    else lines.push(fillText(t('rptWeightSteady'), { kg: number(stats.weight_end_kg) }));
  }
  const fat = number(stats.body_fat_change);
  if (fat !== null && fat <= -0.1) lines.push(fillText(t('rptFatDown'), { pts: trimNumber(fat) }));

  const foodDays = number(stats.food_days);
  if (foodDays) {
    const calories = number(stats.avg_calories);
    lines.push(fillText(t(calories ? 'rptFoodWithCalories' : 'rptFood'), { n: foodDays, kcal: calories }));
  }
  const sleep = number(stats.avg_sleep_hours);
  if (sleep) lines.push(fillText(t('rptSleep'), { h: sleep }));
  const steps = number(stats.avg_steps);
  if (steps) lines.push(fillText(t('rptSteps'), { n: steps.toLocaleString('en-US') }));

  const assigned = number(stats.tasks?.assigned);
  if (assigned) lines.push(fillText(t('rptTasks'), { done: stats.tasks.done, n: assigned, rate: stats.tasks.rate }));
  const xp = number(stats.tasks?.xp_period);
  if (xp) lines.push(fillText(t('rptXp'), { xp }));

  const name = String(stats.first_name || '').trim();
  const title = fillText(t(name ? 'rptHeadNamed' : 'rptHead'), { name, days });
  if (lines.length === 0) return `${title}\n\n${t('rptEmpty')}`;
  return `${title}\n\n${lines.map((line) => `\u2022 ${line}`).join('\n')}\n\n${t('rptClosing')}`;
}

// What gets copied or posted: the report, the app name and the address of the app. No emails or ids.
export function reportShareText(body, origin = '') {
  const link = origin ? `\n${origin}` : '';
  return `${String(body || '').trim()}\n\n#ApexFit${link}`;
}

export const whatsappUrl = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const xUrl = (text) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(text.slice(0, 270))}`;
