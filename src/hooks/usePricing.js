import { useEffect, useState } from 'react';
import { cachedPricing, loadPricing } from '../services/pricingService.js';
import { FALLBACK_PRICING } from '../services/pricingUtils.js';

// The plan price for the visitor's country. Starts with the last answer (or the world price) and updates when the server answers.
export function usePricing() {
  const [pricing, setPricing] = useState(() => cachedPricing() || FALLBACK_PRICING);
  const [loading, setLoading] = useState(!cachedPricing());

  useEffect(() => {
    let active = true;
    loadPricing().then((next) => {
      if (!active) return;
      setPricing(next);
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return { pricing, loading };
}
