// Single source of truth for URL paths, navigation labels, and who may open each page.
export const PAGES = {
  dashboard: { path: '/dashboard', titleKey: 'dashboard', icon: '⚡', access: 'coach' },
  generator: { path: '/generator', titleKey: 'generator', icon: '✦', access: 'coach' },
  workoutBuilder: { path: '/workout-builder', titleKey: 'workoutBuilder', icon: '↕', access: 'coach' },
  programTemplates: { path: '/templates', titleKey: 'programTemplates', icon: '❖', access: 'coach' },
  exerciseLibrary: { path: '/exercises', titleKey: 'exerciseLibrary', icon: '⌕', access: 'coach' },
  workflows: { path: '/workflows', titleKey: 'workflows', icon: '↻', access: 'coach' },
  messages: { path: '/messages', titleKey: 'messages', icon: '◌', access: 'coach' },
  clients: { path: '/clients', titleKey: 'clients', icon: '☺', access: 'coach' },
  schedule: { path: '/schedule', titleKey: 'schedule', icon: '◷', access: 'coach' },
  invoicing: { path: '/invoicing', titleKey: 'invoicing', icon: '$', access: 'coach' },
  billing: { path: '/billing', titleKey: 'billing', icon: '◈', access: 'coach' },
  workouts: { path: '/workouts', titleKey: 'workoutLog', icon: '↕', access: 'client' },
  progress: { path: '/progress', titleKey: 'progressTracking', icon: '↗', access: 'client' },
  strength: { path: '/strength', titleKey: 'strengthTab', icon: '▲', access: 'client' },
  food: { path: '/food', titleKey: 'foodTab', icon: '◔', access: 'client' },
  habits: { path: '/habits', titleKey: 'habitTracker', icon: '✓', access: 'client' },
  intake: { path: '/intake', titleKey: 'intakeTab', icon: '☰', access: 'client' },
  coachHub: { path: '/coach-hub', titleKey: 'coachHub', icon: '✉', access: 'client' },
  community: { path: '/community', titleKey: 'community', icon: '★', access: 'any' },
  leaderboard: { path: '/leaderboard', titleKey: 'leaderboardPage', icon: '♛', access: 'any' },
  settings: { path: '/settings', titleKey: 'settings', icon: '⚙', access: 'any' },
};

export const AUTH_PATHS = { home: '/', login: '/login', signup: '/signup' };

const COACH_NAVIGATION = [
  { group: 'main', items: ['dashboard', 'generator', 'workoutBuilder', 'programTemplates', 'exerciseLibrary', 'messages', 'workflows'] },
  { group: 'clients', items: ['clients', 'schedule', 'invoicing', 'community', 'leaderboard', 'billing'] },
  { group: 'account', items: ['settings'] },
];

const CLIENT_NAVIGATION = [
  { group: 'clients', items: ['workouts', 'progress', 'strength', 'food', 'habits', 'intake'] },
  { group: 'community', items: ['coachHub', 'community', 'leaderboard'] },
  { group: 'account', items: ['settings'] },
];

export function navigationFor(role) {
  return role === 'client' ? CLIENT_NAVIGATION : COACH_NAVIGATION;
}

export function homePathFor(role) {
  return role === 'client' ? PAGES.workouts.path : PAGES.dashboard.path;
}

// Resolve a page id (or an already-absolute path) to a URL path.
export function pathFor(idOrPath) {
  if (idOrPath === 'home') return AUTH_PATHS.home;
  if (typeof idOrPath === 'string' && idOrPath.startsWith('/')) return idOrPath;
  return PAGES[idOrPath]?.path || AUTH_PATHS.home;
}

export function pageForPath(pathname) {
  return Object.values(PAGES).find((page) => page.path === pathname) || null;
}

// Old hash URLs (#coachHub, #portal, ...) from before path routing existed.
export function legacyHashPath(hash) {
  const id = String(hash || '').replace(/^#/, '');
  if (id === 'portal') return PAGES.workouts.path;
  return PAGES[id] ? PAGES[id].path : null;
}

// Only follow redirects that stay inside the app and are not the auth screens themselves.
export function safeRedirectPath(from) {
  const pathname = typeof from === 'string' ? from : from?.pathname;
  if (!pathname || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
  if (Object.values(AUTH_PATHS).includes(pathname)) return null;
  return `${pathname}${from?.search || ''}`;
}
