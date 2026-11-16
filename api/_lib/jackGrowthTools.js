import { formatMoney } from '../../src/services/coachingUtils.js';
import { splitSessions, linkMatchesProvider } from '../../src/services/sessionUtils.js';
import { publicStorePath, validateProductForm } from '../../src/services/storeUtils.js';
import { TEAM_PERMISSIONS, defaultPermissions, validateInviteForm } from '../../src/services/teamUtils.js';
import { ToolError, isoDay, matchOne } from './jackShared.js';
import { scheduleVideoSession } from './videoSessions.js';

// Tools for the program store, trainer teams and live video sessions. They run with the signed-in user's own
// Supabase client, so row-level security and the role checks inside the database functions still apply.

const clientKeys = (row) => [row.client_email, row.client_name];
const ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

// "2026-11-20T18:00" means the user's local time (using their UTC offset); a value with a zone is taken as is.
export function parseWhen(value, utcOffsetMinutes = 0) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ToolError('The date and time of the session is required.');
  const time = ZONE.test(text) ? Date.parse(text) : Date.parse(`${text}Z`) - Number(utcOffsetMinutes || 0) * 60_000;
  if (Number.isNaN(time)) throw new ToolError('The date and time must look like 2026-11-20T18:00.');
  return new Date(time);
}

// Without a link the built-in ApexFit Live room is used; a pasted link picks its own provider.
export function inferProvider(provider, url) {
  if (['apexfit_live', 'zoom', 'google_meet', 'custom'].includes(provider)) return provider;
  if (url && linkMatchesProvider('zoom', url)) return 'zoom';
  if (url && linkMatchesProvider('google_meet', url)) return 'google_meet';
  return url ? 'custom' : 'apexfit_live';
}

async function activeClients(ctx) {
  const { data, error } = await ctx.userClient.from('coach_clients').select('client_id,client_name,client_email,status').eq('status', 'active').limit(500);
  if (error) throw new ToolError(error.message);
  return data || [];
}

export const GROWTH_COACH_TOOLS = [
  {
    name: 'create_store_product',
    roles: ['coach'],
    description: 'Put one of the coach\'s training programs on sale in the store. The price is in whole currency units (29 or 29.90); 0 makes it free.',
    parameters: () => ({
      type: 'object',
      properties: {
        program: { type: 'string', description: 'Title of the program to sell.' },
        title: { type: 'string', description: 'Product title. Defaults to the program title.' },
        price: { type: 'number', description: 'Price, for example 29.9. Use 0 for free.' },
        currency: { type: 'string', enum: ['usd', 'eur', 'gbp', 'egp', 'sar', 'aed'] },
        description: { type: 'string' },
        publish: { type: 'boolean', description: 'Publish right away. Defaults to true.' },
      },
      required: ['program', 'price'],
    }),
    async run(args, ctx) {
      const programs = await ctx.userClient.from('training_programs').select('id,title').order('updated_at', { ascending: false }).limit(200);
      if (programs.error) throw new ToolError(programs.error.message);
      const program = matchOne(programs.data || [], args.program, (row) => [row.title], 'program');

      const price = Number(args.price);
      if (!Number.isFinite(price) || price < 0) throw new ToolError('The price must be 0 or more.');
      const form = validateProductForm({
        programId: program.id,
        title: args.title || program.title,
        description: args.description || '',
        price: String(Math.round(price * 100) / 100),
        currency: args.currency || 'usd',
        cover: '',
        publish: args.publish !== false,
      });
      if (!form.valid) throw new ToolError('The product is not valid: use a title up to 120 characters and a price of 0 or at least 0.50.');

      const { data, error } = await ctx.userClient.rpc('save_store_product', {
        p_product_id: null,
        p_program_id: form.payload.programId,
        p_title: form.payload.title,
        p_description: form.payload.description,
        p_price_cents: form.payload.priceCents,
        p_currency: form.payload.currency,
        p_cover_image_url: null,
        p_publish: form.payload.publish,
      });
      if (error) throw new ToolError(error.message);
      return {
        result: {
          created: true, product_id: data, title: form.payload.title, program: program.title,
          price: form.payload.priceCents / 100, currency: form.payload.currency, published: form.payload.publish,
          public_store_path: publicStorePath(ctx.user.id),
        },
      };
    },
  },
  {
    name: 'get_store_sales',
    roles: ['coach'],
    description: 'Read the store sales: number of paid orders, revenue per currency, best-selling products and the latest buyers.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_store_sales');
      if (error) throw new ToolError(error.message);
      return {
        result: {
          orders_paid: data.orders_paid,
          open_checkouts: data.orders_pending,
          revenue: data.revenue.map((line) => ({ currency: line.currency, amount: Number(line.cents) / 100 })),
          products: data.products.slice(0, 5).map((item) => ({ title: item.title, sales: item.sales, revenue: Number(item.cents) / 100, currency: item.currency })),
          recent: data.recent.slice(0, 5).map((order) => ({
            product: order.title, buyer: order.buyer, amount: formatMoney(order.amount_cents, order.currency, 'en'), date: isoDay(order.purchased_at), test_purchase: order.payment_mode === 'demo',
          })),
        },
      };
    },
  },
  {
    name: 'schedule_video_session',
    roles: ['coach'],
    description: 'Schedule a live video session for one client or one group and notify them. By default it uses the built-in ApexFit Live room (no link needed; everyone joins inside the app). Zoom, Google Meet or another https link are optional; Zoom without a link is created automatically when Zoom is connected.',
    parameters: () => ({
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name or email (for a one-to-one session).' },
        group: { type: 'string', description: 'Group name (for a group session). Give either client or group.' },
        title: { type: 'string' },
        when: { type: 'string', description: 'Start time as ISO 8601, for example 2026-11-20T18:00 (the user\'s local time) or with a zone offset.' },
        duration_minutes: { type: 'integer', description: 'Defaults to 60.' },
        provider: { type: 'string', enum: ['apexfit_live', 'zoom', 'google_meet', 'custom'], description: 'Defaults to apexfit_live, the built-in room.' },
        meeting_url: { type: 'string', description: 'https meeting link, only for Zoom, Google Meet or custom. Leave empty for the built-in room.' },
        passcode: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title', 'when'],
    }),
    async run(args, ctx) {
      if (Boolean(args.client) === Boolean(args.group)) throw new ToolError('Give either a client or a group, not both.');

      let clientId = null;
      let groupId = null;
      let audience;
      if (args.client) {
        const client = matchOne(await activeClients(ctx), args.client, clientKeys, 'client');
        clientId = client.client_id;
        audience = client.client_name || client.client_email;
      } else {
        const groups = await ctx.userClient.from('coaching_groups').select('id,name').order('created_at', { ascending: false }).limit(100);
        if (groups.error) throw new ToolError(groups.error.message);
        const group = matchOne(groups.data || [], args.group, (row) => [row.name], 'group');
        groupId = group.id;
        audience = group.name;
      }

      const startsAt = parseWhen(args.when, ctx.utcOffsetMinutes);
      const url = typeof args.meeting_url === 'string' ? args.meeting_url.trim() : '';
      let result;
      try {
        result = await scheduleVideoSession(ctx, {
          clientId, groupId, title: args.title, description: args.description, scheduledAt: startsAt.toISOString(),
          durationMinutes: args.duration_minutes ?? 60, provider: inferProvider(args.provider, url), meetingUrl: url, passcode: args.passcode,
        }, ctx.videoDeps);
      } catch (error) {
        throw new ToolError(error.message || 'The session could not be scheduled.');
      }
      return {
        result: {
          scheduled: true, session_id: result.id, with: audience, starts_at_utc: startsAt.toISOString(),
          provider: result.provider, meeting_url: result.meetingUrl, in_app_room: result.provider === 'apexfit_live', room_page: result.roomPath,
          link_generated_automatically: result.generated, clients_notified: result.notified,
        },
      };
    },
  },
  {
    name: 'invite_trainer',
    roles: ['coach'],
    description: 'Invite an assistant trainer to the coach\'s team by email. They must sign in as a coach with that email and accept. Permissions default to programs, assessments and messages.',
    parameters: () => ({
      type: 'object',
      properties: {
        email: { type: 'string' },
        role_title: { type: 'string', description: 'For example "Nutrition coach".' },
        permissions: {
          type: 'object',
          description: 'Which things the trainer may do for their assigned clients.',
          properties: Object.fromEntries(TEAM_PERMISSIONS.map((key) => [key, { type: 'boolean' }])),
        },
      },
      required: ['email'],
    }),
    async run(args, ctx) {
      const form = validateInviteForm({ email: args.email, roleTitle: args.role_title });
      if (!form.valid) throw new ToolError('Give a valid email address and a role title of up to 80 characters.');
      const permissions = args.permissions && typeof args.permissions === 'object' ? args.permissions : defaultPermissions();
      const { data, error } = await ctx.userClient.rpc('invite_trainer', { p_email: form.email, p_role_title: form.roleTitle, p_permissions: permissions });
      if (error) throw new ToolError(error.message);
      return {
        result: {
          invited: true, member_id: data, email: form.email,
          next_step: 'Ask them to sign in as a coach with this email and accept the invitation. Then assign clients on the Team page.',
        },
      };
    },
  },
];

export const GROWTH_CLIENT_TOOLS = [
  {
    name: 'get_my_sessions',
    roles: ['client'],
    description: 'Read the client\'s live video sessions: the upcoming ones (with join links) and recent ones.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_my_video_sessions');
      if (error) throw new ToolError(error.message);
      const { upcoming, past } = splitSessions(data, Date.now());
      const brief = (session) => ({
        title: session.title, starts_at_utc: new Date(session.scheduled_at).toISOString(), minutes: session.duration_minutes,
        provider: session.provider, group: session.group_name || null, coach: session.coach_name || null, status: session.status,
      });
      const joinInfo = (session) => (session.provider === 'apexfit_live'
        ? { join_in_app: `/sessions/${session.id}/room`, join_url: null, passcode: null }
        : { join_url: session.meeting_url, passcode: session.meeting_passcode || null });
      return {
        result: {
          upcoming: upcoming.slice(0, 5).map((session) => ({ ...brief(session), ...joinInfo(session) })),
          recent: past.slice(0, 3).map(brief),
          open_page: 'mySessions',
        },
      };
    },
  },
  {
    name: 'get_my_store',
    roles: ['client'],
    description: 'See the programs the coach sells and which ones the client already owns. Buying happens on the Store page.',
    parameters: () => ({ type: 'object', properties: {} }),
    async run(_args, ctx) {
      const { data, error } = await ctx.userClient.rpc('get_my_store');
      if (error) throw new ToolError(error.message);
      return {
        result: {
          products: data.products.slice(0, 10).map((product) => ({
            title: product.title,
            price: product.price_cents === 0 ? 'free' : formatMoney(product.price_cents, product.currency, 'en'),
            owned: product.owned,
          })),
          purchased_programs: data.purchases.map((purchase) => purchase.title),
          open_page: 'myStore',
        },
      };
    },
  },
];