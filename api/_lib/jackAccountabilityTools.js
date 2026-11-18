import { normalizeFoodEntry } from '../../src/services/clientPriority2Utils.js';
import { ToolError, matchOne } from './jackShared.js';

// Jack's tools for the accountability system, progress reports and meal photos. Everything runs with the signed-in
// user's own Supabase client, so the database functions decide who may see or change what.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['workout', 'habit', 'check_in'];
const clientKeys = (row) => [row.client_name, row.client_email];

function optionalDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) throw new ToolError('The date must be in YYYY-MM-DD format.');
  return value;
}

function daysFrom(value) {
  if (value === undefined || value === null || value === '') return 30;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 7 || days > 365) throw new ToolError('days must be a whole number from 7 to 365.');
  return days;
}

function kindFrom(value) {
  if (!KINDS.includes(value)) throw new ToolError(`type must be one of: ${KINDS.join(', ')}.`);
  return value;
}

const shapeTask = (task) => ({
  id: task.id,
  title: task.title,
  type: task.kind,
  due: task.due_date,
  status: task.status,
  xp: task.xp,
  ...(task.is_overdue ? { overdue: true } : {}),
  ...(task.description ? { details: task.description } : {}),
  by: task.source,
});

async function findClient(ctx, query) {
  const clients = await ctx.userClient.from('coach_clients').select('client_id,client_name,client_email,status').eq('status', 'active').limit(500);
  if (clients.error) throw new ToolError(clients.error.message);
  return matchOne(clients.data || [], query, clientKeys, 'client');
}

// The numbers Jack writes a report around, trimmed to what is useful and with empty values left out.
export function shapeStats(stats) {
  const keep = {
    client: stats.first_name || undefined,
    period_days: stats.period_days,
    workouts: stats.workouts,
    sets_logged: stats.sets_logged,
    total_volume_kg: stats.volume_kg ? Number(stats.volume_kg) : undefined,
    heaviest_lift_kg: stats.heaviest_kg ? Number(stats.heaviest_kg) : undefined,
    weight_start_kg: stats.weight_start_kg !== null ? Number(stats.weight_start_kg) : undefined,
    weight_end_kg: stats.weight_end_kg !== null ? Number(stats.weight_end_kg) : undefined,
    weight_change_kg: stats.weight_change_kg !== null ? Number(stats.weight_change_kg) : undefined,
    body_fat_change_points: stats.body_fat_change !== null ? Number(stats.body_fat_change) : undefined,
    days_with_food_logged: stats.food_days,
    average_daily_calories: stats.avg_calories !== null ? Number(stats.avg_calories) : undefined,
    average_sleep_hours: stats.avg_sleep_hours !== null ? Number(stats.avg_sleep_hours) : undefined,
    average_steps: stats.avg_steps !== null ? Number(stats.avg_steps) : undefined,
    tasks_assigned: stats.tasks?.assigned,
    tasks_done: stats.tasks?.done,
    task_completion_percent: stats.tasks?.rate ?? undefined,
    xp_earned_in_period: Number(stats.tasks?.xp_period ?? 0),
    total_xp: Number(stats.tasks?.xp_total ?? 0),
  };
  return Object.fromEntries(Object.entries(keep).filter(([, value]) => value !== undefined && value !== null));
}

const REPORT_HINT = 'Now write a short, warm, encouraging report in the client\'s language that uses these real numbers (never invent any), then call this tool again with the same arguments plus body. Keep it under 1200 characters, personal and positive, ending with one motivating line for the next period.';

async function reportFlow(ctx, clientId, args, label) {
  const days = daysFrom(args.days);
  const { data: stats, error } = await ctx.userClient.rpc('get_progress_stats', { p_client_id: clientId, p_days: days });
  if (error) throw new ToolError(error.message);

  const body = typeof args.body === 'string' ? args.body.trim() : '';
  if (!body) return { result: { stage: 'write_report', for: label, stats: shapeStats(stats), instruction: REPORT_HINT } };
  if (body.length < 20 || body.length > 3000) throw new ToolError('The report must be 20 to 3000 characters.');

  const { data, error: saveError } = await ctx.userClient.rpc('save_progress_report', { p_client_id: clientId, p_days: days, p_body: body });
  if (saveError) throw new ToolError(saveError.message);
  return { result: { saved: true, report_id: data.id, for: label, period_days: days, shareable_by: ctx.role === 'client' ? 'the client (copy or share button on the Progress page)' : 'the coach (Clients page, then Share with client)' } };
}

const REPORT_PROPS = {
  days: { type: 'integer', description: 'Length of the period in days (7 to 365). Defaults to 30.' },
  body: { type: 'string', description: 'The finished report text. Leave it out on the first call to receive the numbers; add it on the second call to save the report.' },
};

export const ACCOUNTABILITY_COACH_TOOLS = [
  {
    name: 'get_client_accountability',
    roles: ['coach'],
    description: 'Check how well clients complete the tasks they were given. Without a client: every client\'s completion rate for the last 30 days, lowest first. With a client: that client\'s open and recent tasks plus a snapshot of their recent workouts, meals, sleep and weight, so tasks can be suggested from real performance.',
    parameters: () => ({
      type: 'object',
      properties: { client: { type: 'string', description: 'Client name or email. Leave out for the whole roster.' } },
    }),
    async run(args, ctx) {
      if (!args.client) {
        const { data, error } = await ctx.userClient.rpc('get_task_completion_rates', { p_days: 30 });
        if (error) throw new ToolError(error.message);
        const clients = (data || []).map((row) => ({
          client: row.client_name,
          completion_percent: row.rate,
          done: row.done,
          assigned: row.assigned,
          overdue: row.overdue,
          open: row.pending,
          xp: Number(row.xp_total),
        })).sort((a, b) => (a.completion_percent ?? 101) - (b.completion_percent ?? 101));
        return { result: { last_days: 30, clients } };
      }
      const client = await findClient(ctx, args.client);
      const [tasks, stats] = await Promise.all([
        ctx.userClient.rpc('get_client_tasks', { p_client_id: client.client_id }),
        ctx.userClient.rpc('get_progress_stats', { p_client_id: client.client_id, p_days: 14 }),
      ]);
      if (tasks.error) throw new ToolError(tasks.error.message);
      if (stats.error) throw new ToolError(stats.error.message);
      return {
        result: {
          client: client.client_name,
          completion: tasks.data.stats,
          tasks: (tasks.data.tasks || []).slice(0, 25).map(shapeTask),
          last_14_days: shapeStats(stats.data),
        },
      };
    },
  },
  {
    name: 'assign_task_to_client',
    roles: ['coach'],
    description: 'Give a client a task: a workout, a habit or a check-in, with a due date and XP reward. Use it when the coach asks, or to follow up on a client who is falling behind. Completing it earns the client XP.',
    parameters: () => ({
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name or email.' },
        title: { type: 'string', description: 'Short task title, for example "Walk 8,000 steps".' },
        type: { type: 'string', enum: KINDS },
        description: { type: 'string', description: 'Optional details (up to 500 characters).' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        xp: { type: 'integer', description: 'XP reward from 1 to 100. Defaults to 20.' },
      },
      required: ['client', 'title', 'type'],
    }),
    async run(args, ctx) {
      const client = await findClient(ctx, args.client);
      const xp = args.xp === undefined ? 20 : Number(args.xp);
      if (!Number.isInteger(xp) || xp < 1 || xp > 100) throw new ToolError('xp must be a whole number from 1 to 100.');
      const { data, error } = await ctx.userClient.rpc('assign_client_task', {
        p_client_id: client.client_id,
        p_kind: kindFrom(args.type),
        p_title: typeof args.title === 'string' ? args.title : '',
        p_description: typeof args.description === 'string' ? args.description : '',
        p_due_date: optionalDate(args.due_date),
        p_xp: xp,
        p_source: 'jack',
      });
      if (error) throw new ToolError(error.message);
      return { result: { assigned: true, client: client.client_name, ...shapeTask(data) } };
    },
  },
  {
    name: 'generate_client_progress_report',
    roles: ['coach'],
    description: 'Write a progress report for one client. Call it first with the client to get the real numbers (workouts, weight change, nutrition, sleep, tasks, XP), write an encouraging report from them, then call it again with body to save it. The coach can then share it with the client.',
    parameters: () => ({
      type: 'object',
      properties: { client: { type: 'string', description: 'Client name or email.' }, ...REPORT_PROPS },
      required: ['client'],
    }),
    async run(args, ctx) {
      const client = await findClient(ctx, args.client);
      return reportFlow(ctx, client.client_id, args, client.client_name);
    },
  },
];

export const ACCOUNTABILITY_CLIENT_TOOLS = [
  {
    name: 'get_my_tasks',
    roles: ['client'],
    description: 'Read the client\'s tasks from the coach (and their own): what is open, overdue or done, the XP each is worth, and their completion rate and total XP.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_my_tasks');
      if (error) throw new ToolError(error.message);
      const tasks = data.tasks || [];
      return {
        result: {
          open: tasks.filter((task) => task.status === 'pending').map(shapeTask),
          done_recently: tasks.filter((task) => task.status === 'done').map(shapeTask),
          completion_percent_last_30_days: data.stats.rate ?? null,
          total_xp: Number(data.stats.xp_total),
        },
      };
    },
  },
  {
    name: 'complete_task',
    roles: ['client'],
    description: 'Mark one of the client\'s tasks as done (or open again with done=false). Completing a task earns XP. The task is found by name.',
    parameters: () => ({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Part of the task title.' },
        done: { type: 'boolean', description: 'true (default) to complete it, false to reopen it.' },
      },
      required: ['task'],
    }),
    async run(args, ctx) {
      if (args.done !== undefined && typeof args.done !== 'boolean') throw new ToolError('done must be true or false.');
      const done = args.done ?? true;
      const { data, error } = await ctx.userClient.rpc('get_my_tasks');
      if (error) throw new ToolError(error.message);
      const candidates = (data.tasks || []).filter((task) => (done ? task.status === 'pending' : task.status === 'done'));
      const task = matchOne(candidates, args.task, (row) => [row.title], 'task');
      const { data: saved, error: saveError } = await ctx.userClient.rpc('complete_my_task', { p_task_id: task.id, p_done: done });
      if (saveError) throw new ToolError(saveError.message);
      return { result: { updated: true, task: saved.title, status: saved.status, xp_earned: saved.xp_awarded } };
    },
  },
  {
    name: 'add_my_task',
    roles: ['client'],
    description: 'Add a small task for the client themselves (a workout, habit or check-in). Use it when the client asks for a reminder-style goal or when you suggest one and they agree. These earn only a little XP.',
    parameters: () => ({
      type: 'object',
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: KINDS },
        description: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD within the next 7 days. Defaults to today.' },
      },
      required: ['title', 'type'],
    }),
    async run(args, ctx) {
      const { data, error } = await ctx.userClient.rpc('add_my_task', {
        p_kind: kindFrom(args.type),
        p_title: typeof args.title === 'string' ? args.title : '',
        p_description: typeof args.description === 'string' ? args.description : '',
        p_due_date: optionalDate(args.due_date),
      });
      if (error) throw new ToolError(error.message);
      return { result: { added: true, ...shapeTask(data) } };
    },
  },
  {
    name: 'generate_my_progress_report',
    roles: ['client'],
    description: 'Write the client\'s own progress report, ready to share with friends. Call it first to get the real numbers, write a warm, motivating report from them (first person or about the client by first name), then call it again with body to save it.',
    parameters: () => ({ type: 'object', properties: { ...REPORT_PROPS } }),
    async run(args, ctx) {
      return reportFlow(ctx, ctx.user.id, args, 'the client');
    },
  },
  {
    name: 'propose_meal_log',
    roles: ['client'],
    description: 'After looking at a photo of a meal (or from a description), show the client an editable estimate of the meal: name, calories and macros. The client reviews and saves it to their food log themselves. These are estimates, so say so. Use this instead of log_meal for anything you estimated.',
    parameters: () => MEAL_SCHEMA,
    async run(args) {
      const meal = mealFrom(args);
      return { result: { shown_to_client: true, note: 'The client can edit the numbers and press Save. Do not say it is already saved.' }, meta: { meal } };
    },
  },
  {
    name: 'log_meal',
    roles: ['client'],
    description: 'Save a meal to the client\'s food log when they give you the exact values or clearly ask you to save it.',
    parameters: () => MEAL_SCHEMA,
    async run(args, ctx) {
      const meal = mealFrom(args);
      const date = optionalDate(args.date) || ctx.today;
      const { error } = await ctx.userClient.from('client_food_logs').insert({ client_id: ctx.user.id, logged_on: date, ...meal });
      if (error) throw new ToolError(error.message);
      return { result: { saved: true, date, ...meal } };
    },
  },
];

const MEAL_SCHEMA = {
  type: 'object',
  properties: {
    food_name: { type: 'string', description: 'Short name of the meal, for example "Grilled chicken with rice".' },
    meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack'] },
    calories: { type: 'number', description: 'Estimated total calories (kcal).' },
    protein_g: { type: 'number' },
    carbs_g: { type: 'number' },
    fat_g: { type: 'number' },
    ingredients: { type: 'string', description: 'What is on the plate with estimated portions, for example "150 g chicken, 1 cup rice".' },
    date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
  },
  required: ['food_name', 'meal_type', 'calories'],
};

function mealFrom(args) {
  try {
    return normalizeFoodEntry({
      food_name: args.food_name,
      meal_type: args.meal_type,
      calories: args.calories,
      protein_g: args.protein_g,
      carbs_g: args.carbs_g,
      fat_g: args.fat_g,
      ingredients: args.ingredients ?? '',
    });
  } catch (error) {
    throw new ToolError(error.message);
  }
}
