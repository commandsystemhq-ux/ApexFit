// The sidebar's remembered choices. Only plain strings are stored, and every read or write is allowed to fail
// (private mode, blocked storage) without breaking the page.

export const SIDEBAR_COLLAPSED_KEY = 'apexfit.sidebar-collapsed';
export const NAV_SEEN_KEY = 'apexfit.nav-seen';
// Below this width the sidebar is a drawer and is never collapsed (it matches the CSS breakpoint).
export const DRAWER_MAX_WIDTH = 820;

function safe(storage, action, fallback) {
  try {
    return action(storage);
  } catch {
    return fallback;
  }
}

export function readCollapsed(storage) {
  return safe(storage, (store) => store.getItem(SIDEBAR_COLLAPSED_KEY) === '1', false);
}

export function writeCollapsed(storage, collapsed) {
  safe(storage, (store) => store.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'), null);
}

export function readSeenPages(storage) {
  return safe(storage, (store) => {
    const parsed = JSON.parse(store.getItem(NAV_SEEN_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  }, []);
}

export function markPageSeen(storage, id) {
  const seen = readSeenPages(storage);
  if (seen.includes(id)) return seen;
  const next = [...seen, id];
  safe(storage, (store) => store.setItem(NAV_SEEN_KEY, JSON.stringify(next)), null);
  return next;
}

// Where the label of a collapsed item is shown: beside the icon, on the side the page is not.
export function tooltipPosition(rect, { rtl, viewportWidth }) {
  const top = rect.top + rect.height / 2;
  return rtl ? { top, right: Math.max(0, viewportWidth - rect.left + 10) } : { top, left: rect.right + 10 };
}
