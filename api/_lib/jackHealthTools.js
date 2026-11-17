import { ToolError, matchOne } from './jackShared.js';
import {
  buildSeries, connectionState, formatSleep, summarizeNutrition, summarizeSeries, validateNutritionForm,
} from '../../src/services/healthUtils.js';

// Tools for smart-device data and nutrition. They run with the signed-in user's own Supabase client, so the
// database functions still decide who may read or write what.

const clientKeys = (row) => [row.client_email, row.client_name];
const text = (value) => (value === undefined || value === null ? '' : String(value));

async function overviewFor(ctx, clientId) {
  const { data, error } = await ctx.userClient.rpc('get_health_overview', { p_client_id: clientId, p_days: 8 });
  if (error) throw new ToolError(error.message);
  return data;
}

function describe(overview, today) {
  const series = buildSeries(overview.metrics, today, 7);
  const device = summarizeSeries(series);
  const nutrition = summarizeNutrition(overview.nutrition.logs, overview.nutrition.targets, today, 7);
  return {
    devices: overview.connections.map((item) => ({ provider: item.provider, status: item.status, last_synced_at: item.last_synced_at })),
    device_days_with_data: device.daysWithData,
    daily_average: {
      steps: device.steps,
      active_calories: device.activeCalories,
      sleep: device.sleepMinutes === null ? null : formatSleep(device.sleepMinutes),
      resting_heart_rate: device.restingHeartRate,
      hrv_ms: device.hrvMs,
      recovery_score: device.recoveryScore,
    },
    last_days: series.filter((day) => day.sources.length > 0).slice(-3).map((day) => ({
      date: day.date, steps: day.steps, sleep: day.sleep_minutes === null ? null : formatSleep(day.sleep_minutes),
      resting_heart_rate: day.resting_heart_rate, recovery_score: day.recovery_score,
    })),
    nutrition: {
      days_logged: nutrition.daysLogged,
      average_calories: nutrition.averageCalories,
      average_protein_g: nutrition.averageProtein,
      average_carbs_g: nutrition.averageCarbs,
      average_fats_g: nutrition.averageFats,
      goal: overview.nutrition.targets
        ? { calories: overview.nutrition.targets.calories, protein_g: overview.nutrition.targets.protein_g, carbs_g: overview.nutrition.targets.carbs_g, fats_g: overview.nutrition.targets.fats_g }
        : null,
      days_on_goal: nutrition.daysWithTarget ? `${nutrition.adherentDays}/${nutrition.daysWithTarget}` : null,
      average_vs_goal_percent: nutrition.averageVsTarget,
    },
  };
}

export const HEALTH_COACH_TOOLS = [
  {
    name: 'get_client_wearables_and_nutrition',
    roles: ['coach'],
    description: 'Read one client\'s smart-device data (steps, sleep, resting heart rate, recovery) and calorie/macro adherence for the last 7 days.',
    parameters: () => ({
      type: 'object',
      properties: { client: { type: 'string', description: 'Client name or email.' } },
      required: ['client'],
    }),
    async run(args, ctx) {
      const clients = await ctx.userClient.from('coach_clients').select('client_id,client_name,client_email,status').eq('status', 'active').limit(500);
      if (clients.error) throw new ToolError(clients.error.message);
      const client = matchOne(clients.data || [], args.client, clientKeys, 'client');
      const overview = await overviewFor(ctx, client.client_id);
      return { result: { client: client.client_name, ...describe(overview, ctx.today) } };
    },
  },
];

export const HEALTH_CLIENT_TOOLS = [
  {
    name: 'get_my_health_metrics',
    roles: ['client'],
    description: 'Read the client\'s own smart-device data (steps, sleep, resting heart rate, recovery) and calorie/macro progress for the last 7 days.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const overview = await overviewFor(ctx, null);
      const connected = ['apple_health', 'fitbit', 'garmin', 'oura'].filter((provider) => connectionState(overview.connections, provider) === 'connected');
      return { result: { connected_devices: connected, ...describe(overview, ctx.today) } };
    },
  },
  {
    name: 'log_nutrition_summary',
    roles: ['client'],
    description: 'Save the client\'s calories and macros (protein, carbs, fats in grams) and optional water (ml) for a day. It replaces the client\'s typed entry for that day. Use it when the client gives a daily nutrition total.',
    parameters: () => ({
      type: 'object',
      properties: {
        calories: { type: 'number' },
        protein_g: { type: 'number' },
        carbs_g: { type: 'number' },
        fats_g: { type: 'number' },
        water_ml: { type: 'number' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        notes: { type: 'string' },
      },
    }),
    async run(args, ctx) {
      const form = validateNutritionForm({
        date: args.date || ctx.today,
        calories: text(args.calories),
        protein: text(args.protein_g),
        carbs: text(args.carbs_g),
        fats: text(args.fats_g),
        water: text(args.water_ml),
        notes: text(args.notes),
      }, ctx.today);
      if (!form.valid) {
        const problem = form.errors.form
          ? 'Give at least one value: calories, protein, carbs, fats or water.'
          : 'Check the values: calories 0-20000, protein 0-2000 g, carbs 0-3000 g, fats 0-2000 g, water 0-20000 ml, and a valid date that is not in the future.';
        throw new ToolError(problem);
      }
      const { payload } = form;
      const { error } = await ctx.userClient.rpc('save_nutrition_log', {
        p_date: payload.date, p_calories: payload.calories, p_protein: payload.protein, p_carbs: payload.carbs,
        p_fats: payload.fats, p_water_ml: payload.waterMl, p_notes: payload.notes,
      });
      if (error) throw new ToolError(error.message);
      return {
        result: {
          saved: true, date: payload.date, calories: payload.calories, protein_g: payload.protein, carbs_g: payload.carbs, fats_g: payload.fats, water_ml: payload.waterMl,
        },
      };
    },
  },
];
