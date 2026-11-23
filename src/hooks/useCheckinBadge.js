import { useCallback, useEffect, useState } from 'react';
import { getCheckinsForCoach, getMyCheckinStatus } from '../services/checkinService.js';
import { getLocalDateString } from '../services/clientTrackingUtils.js';

export const CHECKINS_CHANGED_EVENT = 'apexfit:checkins-changed';

// The sidebar badge for weekly check-ins: for a client 1 when this week's check-in has not been sent (and they have a
// coach), for a coach the number of check-ins waiting for a review. 0 hides the badge.
export function useCheckinBadge(userId, role) {
  const [count, setCount] = useState(0);
  const enabled = Boolean(userId) && (role === 'client' || role === 'coach');

  const refresh = useCallback(() => {
    if (!enabled) return;
    const load = role === 'client'
      ? getMyCheckinStatus(getLocalDateString()).then((status) => (status?.due ? 1 : 0))
      : getCheckinsForCoach({ status: 'submitted', limit: 100 }).then((rows) => (Array.isArray(rows) ? rows.length : 0));
    load.then(setCount).catch(() => setCount(0));
  }, [enabled, role]);

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return undefined;
    }
    refresh();
    const timer = window.setInterval(refresh, 5 * 60_000);
    window.addEventListener(CHECKINS_CHANGED_EVENT, refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(CHECKINS_CHANGED_EVENT, refresh);
    };
  }, [enabled, refresh]);

  return count;
}