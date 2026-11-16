import { PAGES } from '../routes.js';

export const JACK_STORAGE_PREFIX = 'apexfit.jack.';
export const MAX_STORED_MESSAGES = 40;

// Tools that change data. After one of them succeeds the current page reloads its data.
export const WRITE_TOOLS = [
  'create_workflow',
  'assign_program_to_client',
  'create_community_post',
  'log_workout_completion',
  'log_body_metrics',
  'create_group',
  'assign_program_to_group',
  'create_contract',
  'create_store_product',
  'schedule_video_session',
  'invite_trainer',
];

const COACH_PROMPTS = {
  default: ['jackQ_coachSummary', 'jackQ_coachWorkflow', 'jackQ_coachPost', 'jackQ_coachTour'],
  dashboard: ['jackQ_coachSummary', 'jackQ_coachAbsent', 'jackQ_coachWorkflow', 'jackQ_coachTour'],
  clients: ['jackQ_coachAbsent', 'jackQ_coachClearance', 'jackQ_coachAssessment', 'jackQ_coachAssign'],
  groups: ['jackQ_coachGroup', 'jackQ_coachGroupProgram', 'jackQ_coachPost', 'jackQ_coachSummary'],
  contracts: ['jackQ_coachContract', 'jackQ_coachClearance', 'jackQ_coachInvite', 'jackQ_coachTour'],
  programTemplates: ['jackQ_coachAssign', 'jackQ_coachTemplates', 'jackQ_coachWorkflow', 'jackQ_coachTour'],
  workoutBuilder: ['jackQ_coachTemplates', 'jackQ_coachAssign', 'jackQ_coachTour'],
  workflows: ['jackQ_coachWorkflow', 'jackQ_coachFollowUp', 'jackQ_coachAbsent', 'jackQ_coachTour'],
  messages: ['jackQ_coachAbsent', 'jackQ_coachSummary', 'jackQ_coachPost'],
  community: ['jackQ_coachPost', 'jackQ_coachSummary', 'jackQ_coachTour'],
  store: ['jackQ_coachStore', 'jackQ_coachSales', 'jackQ_coachGroupProgram', 'jackQ_coachTour'],
  sessions: ['jackQ_coachSession', 'jackQ_coachGroup', 'jackQ_coachSummary', 'jackQ_coachTour'],
  team: ['jackQ_coachTeam', 'jackQ_coachAssign', 'jackQ_coachSummary', 'jackQ_coachTour'],
  leaderboard: ['jackQ_coachPost', 'jackQ_coachSummary', 'jackQ_coachTour'],
  schedule: ['jackQ_coachSchedule', 'jackQ_coachSummary', 'jackQ_coachTour'],
  invoicing: ['jackQ_coachBilling', 'jackQ_coachSummary', 'jackQ_coachTour'],
  billing: ['jackQ_coachBilling', 'jackQ_coachSummary', 'jackQ_coachTour'],
};

const TRAINER_PROMPTS = { default: ['jackQ_trainerHome'] };

const CLIENT_PROMPTS = {
  default: ['jackQ_clientSchedule', 'jackQ_clientDone', 'jackQ_clientWeight', 'jackQ_clientTour'],
  workouts: ['jackQ_clientDone', 'jackQ_clientSchedule', 'jackQ_clientPoints', 'jackQ_clientTour'],
  progress: ['jackQ_clientWeight', 'jackQ_clientProgress', 'jackQ_clientPoints'],
  strength: ['jackQ_clientDone', 'jackQ_clientProgress', 'jackQ_clientTour'],
  food: ['jackQ_clientFood', 'jackQ_clientPoints', 'jackQ_clientTour'],
  habits: ['jackQ_clientPoints', 'jackQ_clientWeight', 'jackQ_clientTour'],
  intake: ['jackQ_clientTour', 'jackQ_clientJoin', 'jackQ_clientSchedule'],
  assessments: ['jackQ_clientAssessment', 'jackQ_clientContracts', 'jackQ_clientSchedule'],
  myContracts: ['jackQ_clientContracts', 'jackQ_clientAssessment', 'jackQ_clientGroups'],
  myGroups: ['jackQ_clientGroups', 'jackQ_clientSchedule', 'jackQ_clientDone'],
  myStore: ['jackQ_clientStore', 'jackQ_clientSessions', 'jackQ_clientGroups'],
  mySessions: ['jackQ_clientSessions', 'jackQ_clientSchedule', 'jackQ_clientGroups'],
  coachHub: ['jackQ_clientJoin', 'jackQ_clientSchedule', 'jackQ_clientTour'],
  community: ['jackQ_clientPoints', 'jackQ_clientDone', 'jackQ_clientTour'],
  leaderboard: ['jackQ_clientPoints', 'jackQ_clientDone', 'jackQ_clientTour'],
};

export function pageIdForPath(pathname) {
  const entry = Object.entries(PAGES).find(([, page]) => page.path === pathname);
  return entry ? entry[0] : '';
}

// Suggested prompts change with the signed-in role and the page that is open.
export function quickPromptKeys(role, pathname) {
  const table = role === 'client' ? CLIENT_PROMPTS : role === 'trainer' ? TRAINER_PROMPTS : COACH_PROMPTS;
  return table[pageIdForPath(pathname)] || table.default;
}

// A page may only be opened by Jack when the user's own role is allowed to see it.
export function isAllowedNavigation(role, path) {
  const entry = Object.values(PAGES).find((page) => page.path === path);
  return Boolean(entry && (entry.access === 'any' || entry.access === role));
}

export function newAssistantMessage(id) {
  return { id, role: 'assistant', text: '', steps: [], pending: true, error: '' };
}

// Folds one streamed server event into the assistant message it belongs to.
export function applyJackEvent(message, event) {
  switch (event.type) {
    case 'step': {
      const step = { id: event.id, tool: event.tool, status: event.status, detail: event.detail || null };
      const exists = message.steps.some((item) => item.id === event.id);
      return {
        ...message,
        steps: exists ? message.steps.map((item) => (item.id === event.id ? { ...item, ...step } : item)) : [...message.steps, step],
      };
    }
    case 'text':
      return { ...message, text: event.text };
    case 'error':
      return { ...message, error: event.message };
    case 'done':
      return { ...message, pending: false };
    default:
      return message;
  }
}

// The text-only history sent to the server (steps and errors stay in the browser).
export function toApiMessages(messages) {
  return messages
    .filter((message) => !message.error && (message.role === 'user' || message.text))
    .map((message) => ({ role: message.role, content: message.text }));
}

export function parseNdjsonChunk(buffer, chunk) {
  const lines = (buffer + chunk).split('\n');
  const rest = lines.pop();
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore a malformed line instead of breaking the whole conversation.
    }
  }
  return { events, rest };
}

export function restoreMessages(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string')
      .slice(-MAX_STORED_MESSAGES)
      .map((message) => ({ ...message, steps: Array.isArray(message.steps) ? message.steps : [], pending: false }));
  } catch {
    return [];
  }
}