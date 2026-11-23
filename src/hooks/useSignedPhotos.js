import { useEffect, useMemo, useState } from 'react';
import { signCheckinPhotos } from '../services/checkinService.js';

const REFRESH_MS = 240_000;

// Short-lived links for private check-in photos: requested when the photos are about to be shown and renewed before
// they expire. Returns { urls: { path -> link }, loading, error }.
export function useSignedPhotos(paths) {
  const key = useMemo(() => [...new Set((paths || []).filter(Boolean))].sort().join('|'), [paths]);
  const [state, setState] = useState({ urls: {}, loading: Boolean(key), error: '' });

  useEffect(() => {
    if (!key) {
      setState({ urls: {}, loading: false, error: '' });
      return undefined;
    }
    let active = true;
    const load = () => signCheckinPhotos(key.split('|'))
      .then((urls) => active && setState({ urls, loading: false, error: '' }))
      .catch((error) => active && setState((current) => ({ ...current, loading: false, error: error.message })));
    setState((current) => ({ ...current, loading: true }));
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [key]);

  return state;
}