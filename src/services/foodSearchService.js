import { requireSupabase } from './supabaseClient.js';
import { FOOD_SEARCH_TIMEOUT_MS, buildFoodSearchUrl } from './foodSearchUtils.js';

export class FoodSearchError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Searches through ApexFit's own /api/food-search; the browser never talks to the food database directly.
// Rejects with FoodSearchError (status 0 for a network failure, 504 for a timeout) so the page can offer manual entry.
export async function searchFoodDatabase(query, { signal } = {}) {
  const { data } = await requireSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new FoodSearchError('Authentication is required.', 401);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FOOD_SEARCH_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller);

  try {
    const response = await fetch(buildFoodSearchUrl(query), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new FoodSearchError(payload.error || `Request failed (${response.status}).`, response.status);
    return Array.isArray(payload.items) ? payload.items : [];
  } catch (error) {
    if (error instanceof FoodSearchError) throw error;
    if (timedOut) throw new FoodSearchError('The food database took too long to answer.', 504);
    if (signal?.aborted) throw error;
    throw new FoodSearchError('The food database could not be reached.', 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
