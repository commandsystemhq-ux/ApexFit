import { FALLBACK_PRICING, normalizePricing, testCountry } from './pricingUtils.js';

let cached = null;

// The plan price for the visitor's country, from the public pricing action of /api/paddle. Never throws: if the server
// cannot be reached (plain `vite dev`, offline) the world price is shown instead.
export async function fetchPricing({ search = window.location.search, fetchImpl = fetch } = {}) {
  const country = testCountry(search);
  const query = new URLSearchParams({ action: 'pricing', ...(country ? { country } : {}) });
  try {
    const response = await fetchImpl(`/api/paddle?${query}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return { ...FALLBACK_PRICING };
    return normalizePricing(await response.json());
  } catch {
    return { ...FALLBACK_PRICING };
  }
}

export function cachedPricing() {
  return cached;
}

export async function loadPricing(options) {
  cached = await fetchPricing(options);
  return cached;
}
