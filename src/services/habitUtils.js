import { shiftDate } from './clientTrackingUtils.js';

export const HABIT_COLORS = Object.freeze(['blue', 'green', 'amber', 'purple', 'pink', 'teal']);
export const HABIT_KINDS = Object.freeze(['numeric', 'boolean']);
export const MAX_HABITS = 30;
export const MAX_HABIT_NAME = 60;
export const MAX_HABIT_UNIT = 20;
export const STREAK_LOOKBACK_DAYS = 120;

// Sleep, water and steps keep their values in the older client_habit_logs columns.
export const BUILTIN_HABITS = Object.freeze({
  sleep: { field: 'sleep_hours', labelKey: 'sleepHours', unitKey: 'hours', max: 24, step: '0.25' },
  water: { field: 'water_liters', labelKey: 'waterLiters', unitKey: 'liters', max: 50, step: '0.1' },
  steps: { field: 'steps', labelKey: 'steps', unitKey: null, max: 200000, step: '1' },
});

// One-tap starting points in the "add a habit" window. The names are translation keys, written in the person's language.
export const HABIT_SUGGESTIONS = Object.freeze([
  { id: 'creatine', nameKey: 'hbSug_creatine', kind: 'boolean', color: 'purple' },
  { id: 'vitamins', nameKey: 'hbSug_vitamins', kind: 'boolean', color: 'amber' },
  { id: 'noSugar', nameKey: 'hbSug_noSugar', kind: 'boolean', color: 'pink' },
  { id: 'stretch', nameKey: 'hbSug_stretch', kind: 'numeric', goal: 15, quickAdd: 5, unitKey: 'hbUnitMinutes', color: 'teal' },
  { id: 'walk', nameKey: 'hbSug_walk', kind: 'boolean', color: 'green' },
]);

const toNumber = (value) => (value === '' || value === null || value === undefined ? null : Number(value));
const round = (value) => Math.round(value * 100) / 100;

export const isBuiltin = (habit) => Boolean(habit?.builtin_key);
export const isBoolean = (habit) => habit?.kind === 'boolean';

export function habitName(habit, t) {
  const builtin = BUILTIN_HABITS[habit?.builtin_key];
  return builtin ? t(builtin.labelKey) : habit?.name || '';
}

export function habitUnit(habit, t) {
  const builtin = BUILTIN_HABITS[habit?.builtin_key];
  if (builtin) return builtin.unitKey ? t(builtin.unitKey) : '';
  return habit?.unit || '';
}

export function habitMax(habit) {
  return BUILTIN_HABITS[habit?.builtin_key]?.max ?? 1000000;
}

export function activeHabits(habits) {
  return (habits || []).filter((habit) => habit.status === 'active');
}

export function archivedHabits(habits) {
  return (habits || []).filter((habit) => habit.status === 'archived');
}

// How far along a habit is today, 0 to 100. A yes/no habit is 0 or 100.
export function habitPercent(habit, value) {
  const amount = toNumber(value);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return 0;
  if (isBoolean(habit)) return 100;
  const goal = Number(habit.daily_goal);
  if (!(goal > 0)) return 0;
  return Math.min(100, Math.round((amount / goal) * 100));
}

export function habitMet(habit, value) {
  const amount = toNumber(value);
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return false;
  return isBoolean(habit) ? true : amount >= Number(habit.daily_goal);
}

// What each habit recorded on each day: { habitId -> { 'YYYY-MM-DD' -> number } }. Sleep, water and steps come from the
// older daily rows, every other habit from its own rows.
export function buildHabitValues(habits, dailyLogs = [], customLogs = []) {
  const values = {};
  for (const habit of habits || []) values[habit.id] = {};
  for (const habit of habits || []) {
    const builtin = BUILTIN_HABITS[habit.builtin_key];
    if (!builtin) continue;
    for (const log of dailyLogs) {
      const value = toNumber(log[builtin.field]);
      if (value !== null && Number.isFinite(value)) values[habit.id][log.habit_date] = value;
    }
  }
  for (const log of customLogs) {
    if (values[log.habit_id]) values[log.habit_id][log.log_date] = Number(log.value);
  }
  return values;
}

// Days in a row on which the habit was met. Today not being done yet does not break a streak that ran up to yesterday.
export function calculateStreak(habit, valuesByDate = {}, today) {
  let day = habitMet(habit, valuesByDate[today]) ? today : shiftDate(today, -1);
  let streak = 0;
  for (let step = 0; step < STREAK_LOOKBACK_DAYS && habitMet(habit, valuesByDate[day]); step += 1) {
    streak += 1;
    day = shiftDate(day, -1);
  }
  return streak;
}

// "3 / 5 goals": every active habit counts, whatever its type. Drafts are what is typed in the boxes right now.
export function summarizeGoals(habits, values, drafts = {}, today) {
  const list = activeHabits(habits);
  const reached = list.filter((habit) => {
    const draft = drafts[habit.id];
    return habitMet(habit, !isBoolean(habit) && draft !== undefined ? draft : values[habit.id]?.[today]);
  }).length;
  return { reached, total: list.length };
}

export function weekDays(today, count = 7) {
  return Array.from({ length: count }, (_, index) => shiftDate(today, index - (count - 1)));
}

export function emptyHabitForm() {
  return { id: null, builtinKey: null, name: '', kind: 'numeric', unit: '', dailyGoal: '', quickAdd: '', color: 'blue' };
}

export function formFromHabit(habit) {
  return {
    id: habit.id,
    builtinKey: habit.builtin_key || null,
    name: habit.name || '',
    kind: habit.kind,
    unit: habit.unit || '',
    dailyGoal: habit.daily_goal === null || habit.daily_goal === undefined ? '' : String(Number(habit.daily_goal)),
    quickAdd: habit.quick_add === null || habit.quick_add === undefined ? '' : String(Number(habit.quick_add)),
    color: habit.color || 'blue',
  };
}

export function formFromSuggestion(suggestion, t) {
  return {
    ...emptyHabitForm(),
    name: t(suggestion.nameKey),
    kind: suggestion.kind,
    unit: suggestion.unitKey ? t(suggestion.unitKey) : '',
    dailyGoal: suggestion.goal === undefined ? '' : String(suggestion.goal),
    quickAdd: suggestion.quickAdd === undefined ? '' : String(suggestion.quickAdd),
    color: suggestion.color,
  };
}

// Checks the "add / edit a habit" form. Errors are translation keys, one per field.
export function validateHabitForm(form) {
  const errors = {};
  const builtin = BUILTIN_HABITS[form.builtinKey];
  const name = String(form.name ?? '').trim();
  const unit = String(form.unit ?? '').trim();
  if (!builtin && (name.length < 1 || name.length > MAX_HABIT_NAME)) errors.name = 'hbErr_name';
  if (!HABIT_KINDS.includes(form.kind)) errors.kind = 'hbErr_kind';
  if (!builtin && unit.length > MAX_HABIT_UNIT) errors.unit = 'hbErr_unit';
  if (!HABIT_COLORS.includes(form.color)) errors.color = 'hbErr_color';

  const max = builtin?.max ?? 1000000;
  let goal = null;
  let quick = null;
  if (form.kind === 'numeric') {
    goal = toNumber(form.dailyGoal);
    if (goal === null || !Number.isFinite(goal) || goal <= 0 || goal > max) errors.dailyGoal = 'hbErr_goal';
    quick = toNumber(form.quickAdd);
    if (quick === null) quick = 1;
    if (!Number.isFinite(quick) || quick <= 0 || quick > max) errors.quickAdd = 'hbErr_quick';
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    payload: {
      id: form.id || null,
      name: builtin ? '' : name,
      kind: form.kind,
      unit: form.kind === 'numeric' && !builtin ? unit : '',
      dailyGoal: form.kind === 'numeric' && goal !== null ? round(goal) : null,
      quickAdd: form.kind === 'numeric' ? round(quick ?? 1) : null,
      color: form.color,
    },
  };
}

// The value a numeric habit shows after the quick-add button, never above what the database accepts.
export function addQuickAmount(habit, current) {
  const base = Number(current) || 0;
  return String(Math.min(habitMax(habit), round(base + Number(habit.quick_add || 0))));
}
