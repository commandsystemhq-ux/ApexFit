import { useCallback, useEffect, useState } from 'react';

const KEY = 'apexfit.ramadanMeals';
const EVENT = 'apexfit:ramadan-meals';

function read() {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

// The Ramadan meals switch (before iftar, iftar, suhoor). It is a display choice kept on this device and shared by every
// screen that lists meals; the screens also show a Ramadan meal that is already in use even when the switch is off.
export function useRamadanMode() {
  const [on, setOn] = useState(read);

  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = useCallback((value) => {
    try {
      window.localStorage.setItem(KEY, value ? '1' : '0');
    } catch {
      // Storage may be unavailable (private mode); the choice then lasts until the page is closed.
    }
    setOn(Boolean(value));
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [on, set];
}