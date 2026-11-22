import { MEAL_TYPES, summarizeFoodDay } from './clientPriority2Utils.js';
import { shiftDate } from './clientTrackingUtils.js';

// The goal table calls fat "fats_g", the food log calls it "fat_g". Each row of progress is one number the person
// is working toward: what was eaten, what is left (negative once over), and a 0-100 bar.
export const TARGET_ROWS = [
  { key: 'calories', labelKey: 'foodCalories', goalField: 'calories', totalField: 'calories', unit: 'kcal' },
  { key: 'protein', labelKey: 'foodProtein', goalField: 'protein_g', totalField: 'protein_g', unit: 'g' },
  { key: 'carbs', labelKey: 'foodCarbs', goalField: 'carbs_g', totalField: 'carbs_g', unit: 'g' },
  { key: 'fat', labelKey: 'foodFat', goalField: 'fats_g', totalField: 'fat_g', unit: 'g' },
];

const round1 = (value) => Math.round(value * 10) / 10;
const hasGoal = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export function buildTargetProgress(target, totals) {
  if (!target) return [];
  return TARGET_ROWS.filter((row) => hasGoal(target[row.goalField])).map((row) => {
    const goal = Number(target[row.goalField]);
    const eaten = round1(Number(totals?.[row.totalField] || 0));
    const remaining = round1(goal - eaten);
    return {
      key: row.key,
      labelKey: row.labelKey,
      unit: row.unit,
      goal,
      eaten,
      remaining,
      over: remaining < 0,
      percent: goal > 0 ? Math.min(100, Math.round((eaten / goal) * 100)) : 0,
    };
  });
}

// One entry per day from `endDate` back `days` days (newest first), with the totals and the meals in meal order.
export function groupLogsByDay(logs, endDate, days) {
  return Array.from({ length: days }, (_, offset) => {
    const date = shiftDate(endDate, -offset);
    const dayLogs = logs.filter((log) => log.logged_on === date);
    const meals = MEAL_TYPES
      .map((meal) => ({ meal, items: dayLogs.filter((log) => log.meal_type === meal) }))
      .filter((group) => group.items.length > 0);
    return { date, count: dayLogs.length, totals: summarizeFoodDay(dayLogs), meals };
  });
}

// How many of the logged days stayed within the calorie goal: a quick sign of how well the plan is followed.
export function calorieAdherence(days, target) {
  if (!target || !hasGoal(target.calories)) return null;
  const logged = days.filter((day) => day.count > 0);
  if (logged.length === 0) return { loggedDays: 0, withinGoal: 0, average: 0 };
  const goal = Number(target.calories);
  return {
    loggedDays: logged.length,
    withinGoal: logged.filter((day) => day.totals.calories <= goal * 1.05).length,
    average: Math.round(logged.reduce((sum, day) => sum + day.totals.calories, 0) / logged.length),
  };
}
