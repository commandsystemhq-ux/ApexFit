import { PAGES } from '../../src/routes.js';
import { ENGAGEMENT_CLIENT_TOOLS, ENGAGEMENT_COACH_TOOLS } from './jackEngagementTools.js';
import { CHAT_CLIENT_TOOLS, CHAT_COACH_TOOLS } from './jackChatTools.js';
import { CHECKLIST_CLIENT_TOOLS } from './jackChecklistTools.js';
import { GROWTH_CLIENT_TOOLS, GROWTH_COACH_TOOLS } from './jackGrowthTools.js';
import { HEALTH_CLIENT_TOOLS, HEALTH_COACH_TOOLS } from './jackHealthTools.js';
import { ToolError, matchOne, requireText } from './jackShared.js';
import { normalizeBodyMetric } from '../../src/services/clientTrackingUtils.js';
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  emptyWorkflow,
  validateWorkflowDraft,
} from '../../src/services/workflowUtils.js';

export { ToolError, matchOne };

// Every tool runs with the signed-in user's own Supabase client (their JWT), so row-level security and
// the role checks inside each database function still apply. Roles are re-checked here before running.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STALE_DAYS = 2;

export function navigablePages(role) {
  // Assistant trainers have their own workspace; the community pages are not part of it.
  const shared = (id, page) => page.access === 'any' && (role !== 'trainer' || id === 'settings');
  return Object.entries(PAGES)
    .filter(([id, page]) => page.access === role || shared(id, page))
    .map(([id]) => id);
}

function optionalDate(value, label, today) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new ToolError(`${label} must be a date in YYYY-MM-DD format.`);
  }
  if (value > today) throw new ToolError(`${label} cannot be in the future.`);
  return value;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function describeDraftErrors(errors) {
  const problems = [];
  if (errors.name) problems.push('name is missing or too long');
  if (errors.description) problems.push('description is too long');
  if (errors.trigger) problems.push('trigger_type is not supported');
  if (errors.stepCount) problems.push('a workflow needs 1 to 10 steps');
  errors.steps.forEach((stepErrors, index) => {
    if (stepErrors.delay) problems.push(`step ${index + 1}: delay_days must be a whole number from 0 to 365`);
    if (stepErrors.action) problems.push(`step ${index + 1}: unsupported action_type`);
    if (stepErrors.message) problems.push(`step ${index + 1}: message_template is missing or too long`);
    if (stepErrors.task) problems.push(`step ${index + 1}: task_title is missing or too long`);
  });
  return problems.join('; ');
}

// Counts days between two YYYY-MM-DD dates.
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Turns the raw database overview into the short facts the model needs. Emails are never included.
export function summarizeCoachOverview(overview) {
  const today = overview.today;
  const clients = (overview.clients || []).map((client) => ({
    name: client.name,
    workouts_7d: client.workouts_7d,
    week_points: client.week_points,
    last_workout_date: client.last_workout_date,
    days_since_workout: client.last_workout_date ? daysBetween(client.last_workout_date, today) : null,
  }));
  const names = (list) => list.slice(0, 15).map((client) => client.name);

  const absent = clients.filter((client) => client.days_since_workout === null || client.days_since_workout >= STALE_DAYS);
  const engaged = clients.filter((client) => client.workouts_7d >= 3);
  const trainedRecently = clients.filter((client) => client.days_since_workout !== null && client.days_since_workout < STALE_DAYS);

  return {
    active_clients: overview.active_clients,
    archived_clients: overview.archived_clients,
    trained_in_last_2_days: { count: trainedRecently.length, names: names(trainedRecently) },
    engaged_3plus_workouts_this_week: { count: engaged.length, names: names(engaged) },
    absent_2plus_days: {
      count: absent.length,
      clients: absent.slice(0, 15).map((client) => ({ name: client.name, days_since_workout: client.days_since_workout })),
    },
    workflows: { total: overview.workflows_total, active: overview.workflows_active },
    programs: overview.programs,
  };
}

const NAVIGATE_TOOL = {
  name: 'navigate_to',
  roles: ['coach', 'client', 'trainer'],
  description: 'Open a page of the app for the user. Use when they ask where something is or to go somewhere.',
  parameters: (role) => ({
    type: 'object',
    properties: {
      page: { type: 'string', enum: navigablePages(role), description: 'Id of the page to open.' },
    },
    required: ['page'],
  }),
  async run({ page }, ctx) {
    if (!navigablePages(ctx.role).includes(page)) throw new ToolError('That page is not available for this account.');
    return { result: { opened: page, path: PAGES[page].path }, navigate: PAGES[page].path, meta: { page } };
  },
};

const COACH_TOOLS = [
  {
    name: 'create_workflow',
    roles: ['coach'],
    description: 'Create an automated workflow (a sequence of timed messages or tasks for clients) and turn it on immediately.',
    parameters: () => ({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short workflow name.' },
        description: { type: 'string' },
        trigger_type: { type: 'string', enum: WORKFLOW_TRIGGERS, description: 'client_joined, plan_assigned, workout_missed (2 days) or milestone_reached (level or badge).' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              delay_days: { type: 'integer', description: 'Days after the trigger (0 = immediately).' },
              action_type: { type: 'string', enum: WORKFLOW_ACTIONS },
              message_template: { type: 'string', description: 'Text sent to the client. May use {client_name}, {coach_name}, {brand_name}.' },
              task_title: { type: 'string', description: 'Required for assign_task.' },
            },
            required: ['delay_days', 'action_type'],
          },
        },
      },
      required: ['name', 'trigger_type', 'steps'],
    }),
    async run(args, ctx) {
      const draft = emptyWorkflow({
        name: args.name,
        description: args.description || '',
        trigger_type: args.trigger_type,
        is_active: true,
        steps: Array.isArray(args.steps) ? args.steps : [],
      });
      const { valid, errors, payload } = validateWorkflowDraft(draft);
      if (!valid) throw new ToolError(`The workflow is not valid: ${describeDraftErrors(errors)}.`);

      const { data, error } = await ctx.userClient.rpc('save_workflow', {
        p_workflow_id: null,
        p_name: payload.name,
        p_description: payload.description,
        p_trigger_type: payload.trigger_type,
        p_is_active: true,
        p_steps: payload.steps,
      });
      if (error) throw new ToolError(error.message);
      return { result: { workflow_id: data, name: payload.name, trigger_type: payload.trigger_type, steps: payload.steps.length, active: true } };
    },
  },
  {
    name: 'assign_program_to_client',
    roles: ['coach'],
    description: 'Assign one of the coach\'s training programs to a client, found by name or email.',
    parameters: () => ({
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name or email.' },
        program: { type: 'string', description: 'Program title.' },
      },
      required: ['client', 'program'],
    }),
    async run(args, ctx) {
      const clients = await ctx.userClient.from('coach_clients').select('client_id,client_name,client_email,status').eq('status', 'active');
      if (clients.error) throw new ToolError(clients.error.message);
      const programs = await ctx.userClient.from('training_programs').select('id,title').order('updated_at', { ascending: false }).limit(200);
      if (programs.error) throw new ToolError(programs.error.message);

      const client = matchOne(clients.data || [], args.client, (row) => [row.client_email, row.client_name], 'client');
      const program = matchOne(programs.data || [], args.program, (row) => [row.title], 'program');

      const { data, error } = await ctx.userClient.rpc('assign_program_to_client', { p_client_id: client.client_id, p_program_id: program.id });
      if (error) throw new ToolError(error.message);
      return {
        result: {
          assigned: true,
          client: client.client_name || client.client_email,
          program: program.title,
          workflow_steps_queued: data?.steps_queued ?? 0,
        },
      };
    },
  },
  {
    name: 'create_community_post',
    roles: ['coach'],
    description: 'Publish an announcement or an update to the coach\'s community feed.',
    parameters: () => ({
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Post text, up to 1000 characters.' },
        kind: { type: 'string', enum: ['announcement', 'update'], description: 'Defaults to announcement.' },
      },
      required: ['body'],
    }),
    async run(args, ctx) {
      const body = requireText(args.body, 'The post text', 1000);
      const kind = args.kind === 'update' ? 'update' : 'announcement';
      const coachId = ctx.user.id;

      const existing = await ctx.userClient.from('community_profiles').select('user_id').eq('user_id', coachId).maybeSingle();
      if (existing.error) throw new ToolError(existing.error.message);
      if (!existing.data) {
        const displayName = String(ctx.access?.brand_name || ctx.access?.full_name || '').trim().slice(0, 40);
        if (displayName.length < 2) throw new ToolError('The coach has no display name yet. Ask them to set a name in Settings first.');
        const joined = await ctx.userClient.rpc('join_community', { p_display_name: displayName, p_leaderboard_opt_in: true });
        if (joined.error) throw new ToolError(joined.error.message);
      }

      const { data, error } = await ctx.userClient.rpc('create_community_post', {
        p_coach_id: coachId, p_kind: kind, p_body: body, p_achievement_code: null,
      });
      if (error) throw new ToolError(error.message);
      return { result: { posted: true, post_id: data, kind } };
    },
  },
  {
    name: 'get_coach_summary',
    roles: ['coach'],
    description: 'Get quick statistics: active clients, who trained recently, who is engaged, and who missed workouts.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_coach_client_overview');
      if (error) throw new ToolError(error.message);
      return { result: summarizeCoachOverview(data) };
    },
  },
  NAVIGATE_TOOL,
];

const CLIENT_TOOLS = [
  {
    name: 'log_workout_completion',
    roles: ['client'],
    description: 'Record that the client completed a workout. Optionally include exercises with sets (reps and weight in kg) to log the weights lifted.',
    parameters: () => ({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Workout name, for example "Upper body".' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        exercises: {
          type: 'array',
          maxItems: 40,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exercise name from the catalog.' },
              sets: {
                type: 'array',
                minItems: 1,
                maxItems: 30,
                items: {
                  type: 'object',
                  properties: { reps: { type: 'integer' }, weight_kg: { type: 'number' } },
                  required: ['reps'],
                },
              },
            },
            required: ['name', 'sets'],
          },
        },
      },
      required: ['title'],
    }),
    async run(args, ctx) {
      const title = requireText(args.title, 'The workout title', 160);
      const date = optionalDate(args.date, 'The date', ctx.today);
      const exercises = Array.isArray(args.exercises) ? args.exercises : [];

      if (exercises.length === 0) {
        const params = { p_title: title };
        if (date) params.p_date = date;
        const { data, error } = await ctx.userClient.rpc('log_workout_completion', params);
        if (error) throw new ToolError(error.message);
        return { result: { logged: true, already_logged: data.already_logged, title, date: date || ctx.today } };
      }

      const resolved = [];
      for (const exercise of exercises) {
        const query = requireText(exercise?.name, 'Each exercise name', 120);
        const found = await ctx.userClient
          .from('exercises').select('id,name').eq('is_published', true).ilike('name', `%${escapeLike(query)}%`).limit(10);
        if (found.error) throw new ToolError(found.error.message);
        const match = matchOne(found.data || [], query, (row) => [row.name], 'exercise');
        const sets = (Array.isArray(exercise.sets) ? exercise.sets : []).map((set) => ({
          reps: Number(set?.reps),
          weight_kg: set?.weight_kg === undefined || set?.weight_kg === null ? null : Number(set.weight_kg),
        }));
        if (sets.length === 0 || sets.some((set) => !Number.isInteger(set.reps) || set.reps < 1 || set.reps > 200)) {
          throw new ToolError(`Each set of ${match.name} needs reps between 1 and 200.`);
        }
        if (sets.some((set) => set.weight_kg !== null && (!Number.isFinite(set.weight_kg) || set.weight_kg < 0 || set.weight_kg > 1000))) {
          throw new ToolError(`Weights for ${match.name} must be between 0 and 1000 kg.`);
        }
        resolved.push({ exercise_id: match.id, sets, name: match.name });
      }

      const { data, error } = await ctx.userClient.rpc('save_client_workout', {
        p_workout_date: date || ctx.today,
        p_title: title,
        p_exercises: resolved.map(({ exercise_id, sets }) => ({ exercise_id, sets })),
      });
      if (error) throw new ToolError(error.message);
      return { result: { logged: true, session_id: data, title, date: date || ctx.today, exercises: resolved.map((item) => item.name) } };
    },
  },
  {
    name: 'log_body_metrics',
    roles: ['client'],
    description: 'Save the client\'s body weight (kg) and/or body fat percentage for a day.',
    parameters: () => ({
      type: 'object',
      properties: {
        weight_kg: { type: 'number' },
        body_fat_percentage: { type: 'number' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        notes: { type: 'string' },
      },
    }),
    async run(args, ctx) {
      const date = optionalDate(args.date, 'The date', ctx.today) || ctx.today;
      let normalized;
      try {
        normalized = normalizeBodyMetric({
          weight_kg: args.weight_kg ?? null,
          body_fat_percentage: args.body_fat_percentage ?? null,
          notes: typeof args.notes === 'string' ? args.notes.trim() : '',
        });
      } catch (error) {
        throw new ToolError(error.message);
      }

      // Keep whatever was already saved for that day when only one value is provided.
      const existing = await ctx.userClient
        .from('client_body_metrics').select('weight_kg,body_fat_percentage,notes').eq('client_id', ctx.user.id).eq('measured_on', date).maybeSingle();
      if (existing.error) throw new ToolError(existing.error.message);
      const row = {
        client_id: ctx.user.id,
        measured_on: date,
        weight_kg: normalized.weight_kg ?? existing.data?.weight_kg ?? null,
        body_fat_percentage: normalized.body_fat_percentage ?? existing.data?.body_fat_percentage ?? null,
        notes: normalized.notes || existing.data?.notes || '',
      };
      const { error } = await ctx.userClient.from('client_body_metrics').upsert(row, { onConflict: 'client_id,measured_on' });
      if (error) throw new ToolError(error.message);
      return { result: { saved: true, date, weight_kg: row.weight_kg, body_fat_percentage: row.body_fat_percentage } };
    },
  },
  {
    name: 'get_my_schedule',
    roles: ['client'],
    description: 'Read the client\'s assigned program, upcoming coach sessions, recent tasks from the coach, and whether a workout is logged today.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_my_schedule');
      if (error) throw new ToolError(error.message);
      return { result: data };
    },
  },
  NAVIGATE_TOOL,
];

const ALL_TOOLS = [
  ...COACH_TOOLS,
  ...ENGAGEMENT_COACH_TOOLS,
  ...GROWTH_COACH_TOOLS,
...HEALTH_COACH_TOOLS,
...CHAT_COACH_TOOLS,
  ...CLIENT_TOOLS.filter((tool) => tool !== NAVIGATE_TOOL),
  ...ENGAGEMENT_CLIENT_TOOLS,
  ...GROWTH_CLIENT_TOOLS,
...HEALTH_CLIENT_TOOLS,
...CHAT_CLIENT_TOOLS,
...CHECKLIST_CLIENT_TOOLS,
];

export function toolsForRole(role) {
  return ALL_TOOLS.filter((tool) => tool.roles.includes(role));
}

// The definitions sent to the model: only the tools the verified role may use.
export function toolSpecsForRole(role) {
  return toolsForRole(role).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters(role),
  }));
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

// Runs one tool call requested by the model. Never throws: failures become an error result for the model.
export async function executeTool(name, rawArgs, ctx) {
  const tool = ALL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}.` };
  if (!tool.roles.includes(ctx.role)) {
    return { ok: false, forbidden: true, error: 'This action is not available for your account type.' };
  }
  const args = parseArgs(rawArgs);
  if (!args) return { ok: false, error: 'The tool arguments were not valid JSON.' };

  try {
    const output = await tool.run(args, ctx);
    return { ok: true, result: output.result, navigate: output.navigate, meta: output.meta };
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, error: error.message };
    console.error('Jack tool failed', name, error);
    return { ok: false, error: 'The action could not be completed.' };
  }
}
