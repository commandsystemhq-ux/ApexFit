import { formatMoney } from './coachingUtils.js';

// A client without a filled-in onboarding form is held to this many training days a week.
export const DEFAULT_WEEKLY_TARGET = 3;
export const DASHBOARD_DAYS = 30;
export const MIN_AGE_FOR_ALERTS = 3;
export const LATE_WORKOUT_DAYS = 7;
export const NO_FOOD_DAYS = 3;
export const MAX_INSIGHTS = 8;

const DAY_MS = 86_400_000;
const toNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Whole days from a 'YYYY-MM-DD' (or ISO) date to today, counted in UTC like the database does. null when there is no date.
export function daysSince(date, now = new Date()) {
  if (!date) return null;
  const day = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day)) return null;
  return Math.max(0, Math.floor((Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) - day) / DAY_MS));
}

// "today", "yesterday", "6 days ago" in the person's language, with that language's own plural forms. null (no date) stays null.
export function relativeDays(days, locale = 'en') {
  if (days === null || days === undefined) return null;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
}

export const weeklyGoal = (client) => Math.max(1, toNumber(client?.weekly_target) || DEFAULT_WEEKLY_TARGET);

// Workouts logged in the last 7 days against the weekly goal, 0 to 100.
export function weeklyAdherence(client) {
  return Math.min(100, Math.round((toNumber(client?.workout_days_7) / weeklyGoal(client)) * 100));
}

// The same over the whole period, but a client who joined only a few days ago is judged on the days they have had.
export function periodAdherence(client, days = DASHBOARD_DAYS, now = new Date()) {
  const joined = daysSince(client?.joined_at, now);
  const effectiveDays = Math.max(1, Math.min(days, joined === null ? days : joined + 1));
  const expected = (weeklyGoal(client) * effectiveDays) / 7;
  return Math.min(100, Math.round((toNumber(client?.workout_days_period) / expected) * 100));
}

// 0 when there are no clients or nobody logged a workout: real zeros, never a made-up number.
export function averageAdherence(clients, days = DASHBOARD_DAYS, now = new Date()) {
  if (!clients?.length) return 0;
  return Math.round(clients.reduce((sum, client) => sum + periodAdherence(client, days, now), 0) / clients.length);
}

export function revenueParts(revenue, locale = 'en') {
  const parts = (revenue || []).filter((row) => toNumber(row.cents) > 0).map((row) => formatMoney(toNumber(row.cents), row.currency, locale));
  return { primary: parts[0] ?? '0', others: parts.slice(1) };
}

// The four cards plus the roster, from what get_coach_dashboard returned.
export function summarizeDashboard(data, { now = new Date(), days = data?.days || DASHBOARD_DAYS } = {}) {
  const clients = (data?.clients || []).map((client) => ({
    ...client,
    goal: weeklyGoal(client),
    weekly: weeklyAdherence(client),
    period: periodAdherence(client, days, now),
    daysSinceWorkout: daysSince(client.last_workout_on, now),
    daysSinceFood: daysSince(client.last_food_on, now),
    daysSinceJoined: daysSince(client.joined_at, now),
  }));
  return {
    activeClients: toNumber(data?.active_clients),
    plansCreated: toNumber(data?.plans_created),
    revenue: data?.revenue_month || [],
    avgAdherence: averageAdherence(data?.clients || [], days, now),
    days,
    clients,
  };
}

const SEVERITY_ORDER = { warning: 0, info: 1, success: 2 };

// Alerts that come from what the clients really did. Each one names the client and carries the numbers for its text.
export function buildInsights(clients, { limit = MAX_INSIGHTS } = {}) {
  const found = [];
  for (const client of clients || []) {
    const old = client.daysSinceJoined !== null && client.daysSinceJoined >= MIN_AGE_FOR_ALERTS;
    const base = { clientId: client.client_id, name: client.name };
    const late = old && (client.daysSinceWorkout === null || client.daysSinceWorkout >= LATE_WORKOUT_DAYS);
    if (late) {
      found.push(client.daysSinceWorkout === null
        ? { ...base, type: 'lateNever', severity: 'warning', weight: client.daysSinceJoined, values: {} }
        : { ...base, type: 'late', severity: 'warning', weight: client.daysSinceWorkout, values: { days: client.daysSinceWorkout } });
    } else if (client.daysSinceJoined !== null && client.daysSinceJoined >= 7 && client.weekly < 50) {
      found.push({ ...base, type: 'low', severity: 'warning', weight: 100 - client.weekly, values: { done: client.workout_days_7, goal: client.goal } });
    } else if (client.weekly >= 100) {
      found.push({ ...base, type: 'onTrack', severity: 'success', weight: client.workout_days_7, values: { done: client.workout_days_7, goal: client.goal } });
    }
    if (old && (client.daysSinceFood === null || client.daysSinceFood >= NO_FOOD_DAYS)) {
      found.push(client.daysSinceFood === null
        ? { ...base, type: 'noFoodNever', severity: 'info', weight: client.daysSinceJoined, values: {} }
        : { ...base, type: 'noFood', severity: 'info', weight: client.daysSinceFood, values: { days: client.daysSinceFood } });
    }
    if (toNumber(client.unread_messages) > 0) {
      found.push({ ...base, type: 'unread', severity: 'info', weight: toNumber(client.unread_messages), values: { count: toNumber(client.unread_messages) } });
    }
  }
  const sorted = found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.weight - a.weight || a.name.localeCompare(b.name));
  return { items: sorted.slice(0, limit), hidden: Math.max(0, sorted.length - limit) };
}
