// Single source of truth for URL paths, navigation labels, and who may open each page.
export const PAGES = {
  dashboard: { path: '/dashboard', titleKey: 'dashboard', icon: '⚡', access: 'coach' },
  generator: { path: '/generator', titleKey: 'generator', icon: '✦', access: 'coach' },
  workoutBuilder: { path: '/workout-builder', titleKey: 'workoutBuilder', icon: '↕', access: 'coach' },
  programTemplates: { path: '/templates', titleKey: 'programTemplates', icon: '❖', access: 'coach' },
  exerciseLibrary: { path: '/exercises', titleKey: 'exerciseLibrary', icon: '⌕', access: 'coach' },
  mealPlans: { path: '/meal-plans', titleKey: 'navMealPlans', icon: '\u2615', access: 'coach' },
  workflows: { path: '/workflows', titleKey: 'workflows', icon: '↻', access: 'coach' },
  messages: { path: '/messages', titleKey: 'messages', icon: '◌', access: 'coach' },
  campaigns: { path: '/campaigns', titleKey: 'navCampaigns', icon: '\u2709', access: 'coach' },
  groups: { path: '/groups', titleKey: 'navGroups', icon: '\u25CE', access: 'coach' },
  contracts: { path: '/contracts', titleKey: 'navContracts', icon: '\u270E', access: 'coach' },
  team: { path: '/team', titleKey: 'navTeam', icon: '\u2691', access: 'coach' },
  store: { path: '/store', titleKey: 'navStore', icon: '\u25A3', access: 'coach' },
  sessions: { path: '/sessions', titleKey: 'navSessions', icon: '\u25B6', access: 'coach' },
  teamClients: { path: '/team-clients', titleKey: 'navTeamClients', icon: '\u2691', access: 'trainer' },
  tasks: { path: '/tasks', titleKey: 'navTasks', icon: '\u2714', access: 'coach' },
  checkins: { path: '/checkins', titleKey: 'navCheckins', icon: '\u2611', access: 'coach' },
  clients: { path: '/clients', titleKey: 'clients', icon: '☺', access: 'coach' },
  schedule: { path: '/schedule', titleKey: 'schedule', icon: '◷', access: 'coach' },
  invoicing: { path: '/invoicing', titleKey: 'invoicing', icon: '$', access: 'coach' },
  billing: { path: '/billing', titleKey: 'billing', icon: '◈', access: 'coach' },
  workouts: { path: '/workouts', titleKey: 'workoutLog', icon: '↕', access: 'client' },
  progress: { path: '/progress', titleKey: 'progressTracking', icon: '↗', access: 'client' },
  strength: { path: '/strength', titleKey: 'strengthTab', icon: '▲', access: 'client' },
  food: { path: '/food', titleKey: 'foodTab', icon: '◔', access: 'client' },
  weeklyCheckin: { path: '/weekly-checkin', titleKey: 'navWeeklyCheckin', icon: '\u2611', access: 'client' },
  habits: { path: '/habits', titleKey: 'habitTracker', icon: '✓', access: 'client' },
  intake: { path: '/intake', titleKey: 'intakeTab', icon: '☰', access: 'client' },
  myTasks: { path: '/my-tasks', titleKey: 'navMyTasks', icon: '\u2605', access: 'client' },
  checklist: { path: '/checklist', titleKey: 'navChecklist', icon: '\u2611', access: 'client' },
  integrations: { path: '/integrations', titleKey: 'navIntegrations', icon: '\u25C9', access: 'client' },
  assessments: { path: '/assessments', titleKey: 'navAssessments', icon: '\u2665', access: 'client' },
  myContracts: { path: '/my-contracts', titleKey: 'navMyContracts', icon: '\u270E', access: 'client' },
  myGroups: { path: '/my-groups', titleKey: 'navMyGroups', icon: '\u25CE', access: 'client' },
  mySessions: { path: '/my-sessions', titleKey: 'navMySessions', icon: '\u25B6', access: 'client' },
  myStore: { path: '/my-store', titleKey: 'navMyStore', icon: '\u25A3', access: 'client' },
  coachHub: { path: '/coach-hub', titleKey: 'coachHub', icon: '✉', access: 'client' },
  community: { path: '/community', titleKey: 'community', icon: '★', access: 'any' },
  leaderboard: { path: '/leaderboard', titleKey: 'leaderboardPage', icon: '♛', access: 'any' },
  settings: { path: '/settings', titleKey: 'settings', icon: '⚙', access: 'any' },
};

export const AUTH_PATHS = { home: '/', login: '/login', signup: '/signup' };

// Open to everyone, signed in or not: pricing and the policies payment providers ask to review.
export const PUBLIC_PATHS = { pricing: '/pricing', terms: '/terms', privacy: '/privacy', refunds: '/refunds' };

// Pages that are not part of any role's navigation. The platform owner's AI screen is opened by its address only.
export const ADMIN_PATHS = { ai: '/admin/ai' };

// Each group's group is the translation key of its heading.
const COACH_NAVIGATION = [
  { group: 'navGrpTraining', items: ['dashboard', 'generator', 'workoutBuilder', 'programTemplates', 'mealPlans', 'exerciseLibrary', 'workflows'] },
  { group: 'navGrpClients', items: ['clients', 'checkins', 'messages', 'campaigns', 'tasks', 'groups', 'sessions', 'schedule', 'team', 'community', 'leaderboard'] },
  { group: 'navGrpBusiness', items: ['store', 'invoicing', 'contracts', 'billing'] },
  { group: 'navGrpAccount', items: ['settings'] },
];

const CLIENT_NAVIGATION = [
  { group: 'navGrpTrainNutrition', items: ['workouts', 'strength', 'food', 'habits'] },
  { group: 'navGrpTracking', items: ['progress', 'weeklyCheckin', 'myTasks', 'checklist', 'integrations', 'intake', 'assessments'] },
  { group: 'navGrpSocial', items: ['coachHub', 'mySessions', 'myGroups', 'myStore', 'myContracts', 'community', 'leaderboard'] },
  { group: 'navGrpAccount', items: ['settings'] },
];

// Assistant trainers work inside the head coach's team and only see their own workspace.
const TRAINER_NAVIGATION = [
  { group: 'navGrpClients', items: ['teamClients'] },
  { group: 'navGrpAccount', items: ['settings'] },
];

// Pages that wear a "New" badge in the sidebar until the person opens them once.
export const NEW_PAGE_IDS = ['campaigns'];
// 'trainer' is an assistant on a head coach's team (role 'coach' with access_state 'trainer').
export function roleOf(profile) {
  if (profile?.role === 'client') return 'client';
  if (profile?.role === 'coach' && profile.access_state === 'trainer') return 'trainer';
  return 'coach';
}

export function navigationFor(role) {
  if (role === 'trainer') return TRAINER_NAVIGATION;
  return role === 'client' ? CLIENT_NAVIGATION : COACH_NAVIGATION;
}

export function homePathFor(role) {
  if (role === 'trainer') return PAGES.teamClients.path;
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
