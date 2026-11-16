import { PARQ_TOPICS, flaggedQuestions } from '../../src/services/assessmentUtils.js';
import { validateContractForm } from '../../src/services/contractUtils.js';
import { GROUP_LIMITS, validateGroupForm } from '../../src/services/groupUtils.js';
import { ToolError, isoDay, matchOne } from './jackShared.js';

// Tools for assessments, contracts and groups. Like the other Jack tools they run with the signed-in
// user's own Supabase client, so row-level security and the database functions' role checks apply.

const clientKeys = (row) => [row.client_email, row.client_name];

async function activeClients(ctx) {
  const { data, error } = await ctx.userClient
    .from('coach_clients').select('client_id,client_name,client_email,status').eq('status', 'active').limit(500);
  if (error) throw new ToolError(error.message);
  return data || [];
}

async function myPrograms(ctx) {
  const { data, error } = await ctx.userClient.from('training_programs').select('id,title').order('updated_at', { ascending: false }).limit(200);
  if (error) throw new ToolError(error.message);
  return data || [];
}

async function myGroups(ctx) {
  const { data, error } = await ctx.userClient.from('coaching_groups').select('id,name').order('created_at', { ascending: false }).limit(100);
  if (error) throw new ToolError(error.message);
  return data || [];
}

function nameOf(row) {
  return row.client_name || row.client_email;
}

export const ENGAGEMENT_COACH_TOOLS = [
  {
    name: 'create_group',
    roles: ['coach'],
    description: 'Create a group coaching group (for example a 90-day challenge). Optionally add clients by name or email and give the whole group a training program.',
    parameters: () => ({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name, up to 80 characters.' },
        description: { type: 'string' },
        clients: { type: 'array', items: { type: 'string' }, description: 'Names or emails of the coach\'s active clients to add.' },
        program: { type: 'string', description: 'Title of one of the coach\'s programs to assign to every member.' },
      },
      required: ['name'],
    }),
    async run(args, ctx) {
      const form = validateGroupForm({ name: args.name, description: args.description });
      if (!form.valid) throw new ToolError('The group is not valid: it needs a name of up to 80 characters and a description of up to 500.');

      // Resolve every name first so an ambiguous name stops the request before anything is created.
      const wanted = Array.isArray(args.clients) ? args.clients.filter((item) => typeof item === 'string' && item.trim()) : [];
      if (wanted.length > GROUP_LIMITS.members) throw new ToolError(`A group can have at most ${GROUP_LIMITS.members} members.`);
      let members = [];
      if (wanted.length > 0) {
        const clients = await activeClients(ctx);
        members = [...new Set(wanted.map((query) => matchOne(clients, query, clientKeys, 'client')))];
      }
      const program = args.program ? matchOne(await myPrograms(ctx), args.program, (row) => [row.title], 'program') : null;

      const created = await ctx.userClient.rpc('save_group', { p_group_id: null, p_name: form.payload.name, p_description: form.payload.description });
      if (created.error) throw new ToolError(created.error.message);
      const groupId = created.data;

      try {
        if (members.length > 0) {
          const added = await ctx.userClient.rpc('add_group_members', { p_group_id: groupId, p_client_ids: members.map((member) => member.client_id) });
          if (added.error) throw new Error(added.error.message);
        }
        if (program) {
          const assigned = await ctx.userClient.rpc('assign_program_to_group', { p_group_id: groupId, p_program_id: program.id });
          if (assigned.error) throw new Error(assigned.error.message);
        }
      } catch (error) {
        throw new ToolError(`The group "${form.payload.name}" was created, but a follow-up step failed: ${error.message}`);
      }

      return {
        result: {
          created: true,
          group_id: groupId,
          name: form.payload.name,
          members_added: members.map(nameOf),
          program: program?.title ?? null,
        },
      };
    },
  },
  {
    name: 'assign_program_to_group',
    roles: ['coach'],
    description: 'Assign one of the coach\'s programs to every member of a coaching group in one step. Members who join later receive it too.',
    parameters: () => ({
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group name.' },
        program: { type: 'string', description: 'Program title.' },
      },
      required: ['group', 'program'],
    }),
    async run(args, ctx) {
      const group = matchOne(await myGroups(ctx), args.group, (row) => [row.name], 'group');
      const program = matchOne(await myPrograms(ctx), args.program, (row) => [row.title], 'program');
      const { data, error } = await ctx.userClient.rpc('assign_program_to_group', { p_group_id: group.id, p_program_id: program.id });
      if (error) throw new ToolError(error.message);
      return { result: { assigned: true, group: group.name, program: program.title, members_assigned: data.assigned, skipped_inactive: data.skipped_inactive } };
    },
  },
  {
    name: 'get_client_assessment',
    roles: ['coach'],
    description: 'Read a client\'s health assessment (PAR-Q answers, goals, injuries, whether medical clearance is required). Without a client name, list which clients need medical clearance or have not submitted an assessment.',
    parameters: () => ({
      type: 'object',
      properties: { client: { type: 'string', description: 'Client name or email. Leave empty for an overview of all clients.' } },
    }),
    async run(args, ctx) {
      const clients = await activeClients(ctx);

      if (!args.client) {
        const flags = await ctx.userClient.from('client_assessments').select('client_id,medical_clearance_required,submitted_at');
        if (flags.error) throw new ToolError(flags.error.message);
        const byClient = new Map((flags.data || []).map((row) => [row.client_id, row]));
        const needing = clients.filter((client) => byClient.get(client.client_id)?.medical_clearance_required);
        const missing = clients.filter((client) => !byClient.has(client.client_id));
        return {
          result: {
            active_clients: clients.length,
            submitted: clients.length - missing.length,
            need_medical_clearance: { count: needing.length, names: needing.slice(0, 20).map(nameOf) },
            not_submitted: { count: missing.length, names: missing.slice(0, 20).map(nameOf) },
          },
        };
      }

      const client = matchOne(clients, args.client, clientKeys, 'client');
      const { data, error } = await ctx.userClient
        .from('client_assessments')
        .select('parq_answers,fitness_goals,injuries_notes,medical_clearance_required,submitted_at')
        .eq('client_id', client.client_id)
        .maybeSingle();
      if (error) throw new ToolError(error.message);
      if (!data) return { result: { client: nameOf(client), submitted: false } };
      return {
        result: {
          client: nameOf(client),
          submitted: true,
          submitted_on: isoDay(data.submitted_at),
          medical_clearance_required: data.medical_clearance_required,
          yes_answers: flaggedQuestions(data.parq_answers).map((key) => PARQ_TOPICS[key]),
          fitness_goals: data.fitness_goals.slice(0, 500),
          injuries_notes: data.injuries_notes.slice(0, 500),
        },
      };
    },
  },
  {
    name: 'create_contract',
    roles: ['coach'],
    description: 'Create a contract or liability waiver that clients can e-sign. It can be required during onboarding.',
    parameters: () => ({
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string', description: 'The full contract text, up to 20000 characters.' },
        required: { type: 'boolean', description: 'Ask every client to sign it during onboarding.' },
      },
      required: ['title', 'content'],
    }),
    async run(args, ctx) {
      const form = validateContractForm({ title: args.title, content: args.content, required: args.required });
      if (!form.valid) throw new ToolError('The contract needs a title (up to 160 characters) and text (up to 20000 characters).');
      const { data, error } = await ctx.userClient.rpc('save_contract', {
        p_contract_id: null, p_title: form.payload.title, p_content: form.payload.content, p_required: form.payload.required,
      });
      if (error) throw new ToolError(error.message);
      return { result: { created: true, contract_id: data, title: form.payload.title, required_on_onboarding: form.payload.required } };
    },
  },
];

export const ENGAGEMENT_CLIENT_TOOLS = [
  {
    name: 'get_my_groups',
    roles: ['client'],
    description: 'Read the coaching groups the client belongs to: the shared program and the latest updates from the coach.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_my_groups');
      if (error) throw new ToolError(error.message);
      return {
        result: {
          count: data.length,
          groups: data.map((group) => ({
            name: group.name,
            coach: group.coach_name,
            members: group.member_count,
            program: group.program?.title ?? null,
            program_days: group.program ? group.program.days.map((day) => day.name) : [],
            latest_updates: group.announcements.slice(0, 2).map((item) => item.body.slice(0, 300)),
          })),
        },
      };
    },
  },
  {
    name: 'get_my_contracts',
    roles: ['client'],
    description: 'See which contracts or waivers from the coach are waiting for the client\'s signature and which are already signed. Signing itself happens on the Contracts page.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const contracts = await ctx.userClient.from('contracts').select('id,title,is_required_on_onboarding,is_archived').order('created_at', { ascending: false }).limit(50);
      if (contracts.error) throw new ToolError(contracts.error.message);
      const signatures = await ctx.userClient.from('contract_signatures').select('contract_id,signed_at').limit(200);
      if (signatures.error) throw new ToolError(signatures.error.message);

      const signedAt = new Map((signatures.data || []).map((row) => [row.contract_id, row.signed_at]));
      const rows = contracts.data || [];
      return {
        result: {
          to_sign: rows.filter((row) => !signedAt.has(row.id) && !row.is_archived).map((row) => ({ title: row.title, required: row.is_required_on_onboarding })),
          signed: rows.filter((row) => signedAt.has(row.id)).map((row) => ({ title: row.title, signed_on: isoDay(signedAt.get(row.id)) })),
          sign_on_page: 'myContracts',
        },
      };
    },
  },
];
