import { ToolError, matchOne } from './jackShared.js';

// Tools for the client's daily checklist. They run with the signed-in client's own Supabase client, so the
// database functions decide what can be read or changed.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dateFrom(value, ctx) {
  if (value === undefined || value === null || value === '') return ctx.today;
  if (typeof value !== 'string' || !DAY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) throw new ToolError('The date must be in YYYY-MM-DD format.');
  return value;
}

async function load(ctx, date) {
  const { data, error } = await ctx.userClient.rpc('get_my_checklist', { p_date: date });
  if (error) throw new ToolError(error.message);
  return data;
}

const shape = (item) => ({
  task: item.title,
  type: item.category,
  done: item.is_done,
  ...(item.target_amount ? { progress: Number(item.progress_amount), target: Number(item.target_amount), unit: item.unit || '' } : {}),
  ...(item.remind_time ? { time: item.remind_time } : {}),
  repeats: Boolean(item.template_id),
});

export const CHECKLIST_CLIENT_TOOLS = [
  {
    name: 'get_my_checklist',
    roles: ['client'],
    description: 'Read the client\'s daily checklist (workout, meals, water, habits and own tasks) for a day: every task with whether it is done and the progress toward its target (for example water in ml), plus how many are left.',
    parameters: () => ({
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' } },
    }),
    async run(args, ctx) {
      const date = dateFrom(args.date, ctx);
      const data = await load(ctx, date);
      const items = data.items || [];
      const done = items.filter((item) => item.is_done).length;
      return {
        result: {
          date,
          total: items.length,
          done,
          left: items.length - done,
          can_change: data.editable,
          tasks: items.map(shape),
        },
      };
    },
  },
  {
    name: 'update_checklist_item',
    roles: ['client'],
    description: 'Check or uncheck one task on the client\'s checklist, or add an amount to it (for example "I drank 500 ml of water": add_amount 500). Reaching a task\'s target completes it. The task is found by name.',
    parameters: () => ({
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Part of the task title, for example "water" or "workout".' },
        done: { type: 'boolean', description: 'true to check it, false to uncheck it.' },
        add_amount: { type: 'number', description: 'An amount to add to the progress, in the task\'s unit (for example 500 for 500 ml). Use a negative number to take some away.' },
        set_amount: { type: 'number', description: 'Set the progress to this exact amount instead of adding.' },
        date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
      required: ['task'],
    }),
    async run(args, ctx) {
      const given = [args.done !== undefined, args.add_amount !== undefined, args.set_amount !== undefined].filter(Boolean).length;
      if (given === 0) throw new ToolError('Say what to change: done, add_amount or set_amount.');
      if (given > 1) throw new ToolError('Use only one of done, add_amount and set_amount.');
      if (args.done !== undefined && typeof args.done !== 'boolean') throw new ToolError('done must be true or false.');
      for (const name of ['add_amount', 'set_amount']) {
        if (args[name] !== undefined && !Number.isFinite(Number(args[name]))) throw new ToolError(`${name} must be a number.`);
      }

      const date = dateFrom(args.date, ctx);
      const data = await load(ctx, date);
      const item = matchOne(data.items || [], args.task, (row) => [row.title], 'task');
      if ((args.add_amount !== undefined || args.set_amount !== undefined) && !item.target_amount) {
        throw new ToolError(`"${item.title}" has no target to add an amount to. Check it off instead.`);
      }

      const { data: saved, error } = await ctx.userClient.rpc('set_checklist_item', {
        p_entry_id: item.id,
        p_done: args.done ?? null,
        p_progress: args.set_amount !== undefined ? Number(args.set_amount) : null,
        p_add: args.add_amount !== undefined ? Number(args.add_amount) : null,
      });
      if (error) throw new ToolError(error.message);

      const after = await load(ctx, date);
      const left = (after.items || []).filter((row) => !row.is_done).length;
      return { result: { updated: true, date, ...shape(saved), left_today: left, total_today: (after.items || []).length } };
    },
  },
];
