import { callApi } from './apiClient.js';
import { chunk } from './healthImport.js';
import { requireSupabase } from './supabaseClient.js';
import { getLocalDateString } from './clientTrackingUtils.js';

async function rpc(name, args) {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw error;
  return data;
}

// Connections, device metrics, nutrition logs and the nutrition goal for the last days.
// With a client id (coach or assistant trainer) it reads that client; without one it reads the signed-in client.
export const getHealthOverview = (clientId = null, days = 7) => rpc('get_health_overview', { p_client_id: clientId, p_days: days });

export async function saveWearableMetrics(provider, days) {
  let saved = 0;
  for (const part of chunk(days)) saved += (await rpc('save_wearable_metrics', { p_provider: provider, p_metrics: part })).saved;
  return saved;
}

export const deleteWearableData = (provider) => rpc('delete_my_wearable_data', { p_provider: provider });

export async function importNutritionLogs(days) {
  let imported = 0;
  for (const part of chunk(days)) imported += (await rpc('import_nutrition_logs', { p_logs: part })).imported;
  return imported;
}

export const saveNutritionLog = ({ date, calories, protein, carbs, fats, waterMl, notes }) =>
  rpc('save_nutrition_log', { p_date: date, p_calories: calories, p_protein: protein, p_carbs: carbs, p_fats: fats, p_water_ml: waterMl, p_notes: notes });

export const deleteNutritionLog = (date, source) => rpc('delete_nutrition_log', { p_date: date, p_source: source });

export const setMyNutritionTargets = ({ calories, protein, carbs, fats }) =>
  rpc('set_my_nutrition_targets', { p_calories: calories, p_protein: protein, p_carbs: carbs, p_fats: fats });

export const setClientNutritionTargets = (clientId, { calories, protein, carbs, fats }) =>
  rpc('set_client_nutrition_targets', { p_client_id: clientId, p_calories: calories, p_protein: protein, p_carbs: carbs, p_fats: fats });

// ------------------------------------------------ cloud devices (server side)

export const getWearableProviders = () => callApi('wearables/status', { body: {} });
export const startWearableConnection = (provider) => callApi(`wearables/${provider}`, { body: { action: 'auth-url' } });
export const syncWearable = (provider) => callApi(`wearables/${provider}`, { body: { action: 'sync', today: getLocalDateString() } });
export const disconnectWearable = (provider) => callApi(`wearables/${provider}`, { body: { action: 'disconnect' } });
