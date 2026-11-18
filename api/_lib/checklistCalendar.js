import { eventIdForSession } from './googleCalendar.js';

// Turns checklist tasks into Google Calendar events. A repeating task becomes one weekly event (so the calendar
// repeats it by itself); a one-off task becomes a single event. Event ids come from the task id, so syncing the
// same task again updates its event instead of adding another.

const ICONS = {
  workout: '\u{1F3CB}\uFE0F',
  meal: '\u{1F37D}\uFE0F',
  water: '\u{1F4A7}',
  habit: '\u2705',
  custom: '\u{1F4CC}',
};
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_DURATION_MINUTES = 30;
export const REMINDER_MINUTES = 10;

export const taskEventId = (taskId) => eventIdForSession(taskId);

export function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isIsoDay(value) {
  return typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().startsWith(value);
}

export const addDays = (day, amount) => new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
export const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

// The first day on or after `from` that falls on one of the weekdays (0 = Sunday).
export function firstOccurrence(from, days) {
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addDays(from, offset);
    if (days.includes(weekdayOf(day))) return day;
  }
  return from;
}

// The end of an event that starts at `time` on `day` and lasts `minutes`, possibly on the next day.
export function endOf(day, time, minutes) {
  const [hours, mins] = time.split(':').map(Number);
  const total = hours * 60 + mins + minutes;
  const endDay = total >= 1440 ? addDays(day, 1) : day;
  const wrapped = total % 1440;
  return { day: endDay, time: `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}` };
}

export function describeTarget(task) {
  if (task.target_amount === null || task.target_amount === undefined) return '';
  const amount = Number(task.target_amount);
  return `${Number.isInteger(amount) ? amount : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}${task.unit ? ` ${task.unit}` : ''}`;
}

// task: { id, kind: 'template' | 'entry', title, category, target_amount, unit, remind_time, days_of_week?, task_date? }
export function buildTaskEvent(task, { timeZone, today, durationMinutes = DEFAULT_DURATION_MINUTES }) {
  if (!isValidTimeZone(timeZone)) throw new RangeError('A valid time zone is required');
  if (!TIME.test(String(task.remind_time || ''))) throw new RangeError('The task needs a reminder time');
  const time = String(task.remind_time).slice(0, 5);

  let day;
  let recurrence;
  if (task.kind === 'template') {
    if (!isIsoDay(today)) throw new RangeError('The date is required');
    const days = [...new Set((task.days_of_week || []).map(Number))].filter((value) => value >= 0 && value <= 6).sort();
    if (days.length === 0) throw new RangeError('The task repeats on no day');
    day = firstOccurrence(today, days);
    recurrence = [days.length === 7 ? 'RRULE:FREQ=DAILY' : `RRULE:FREQ=WEEKLY;BYDAY=${days.map((value) => DAY_CODES[value]).join(',')}`];
  } else {
    if (!isIsoDay(task.task_date)) throw new RangeError('The task has no date');
    day = task.task_date;
  }

  const end = endOf(day, time, durationMinutes);
  const target = describeTarget(task);
  const description = [target ? `Target: ${target}` : '', 'Added by ApexFit'].filter(Boolean).join('\n');
  const event = {
    id: taskEventId(task.id),
    summary: `${ICONS[task.category] || ICONS.custom} ${task.title}`,
    description,
    start: { dateTime: `${day}T${time}:00`, timeZone },
    end: { dateTime: `${end.day}T${end.time}:00`, timeZone },
    // Popup reminder shortly before it starts, instead of the calendar's default.
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: REMINDER_MINUTES }] },
    extendedProperties: { private: { apexfitTaskId: task.id } },
    status: 'confirmed',
  };
  if (recurrence) event.recurrence = recurrence;
  return event;
}
