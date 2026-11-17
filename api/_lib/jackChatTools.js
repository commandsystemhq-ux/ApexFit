import { randomUUID } from 'node:crypto';
import { validateChatText } from '../../src/services/chatUtils.js';
import { ToolError, matchOne } from './jackShared.js';

// Tools for the coach/client chat. They run with the signed-in user's own Supabase client, so the database
// functions decide who may read or write which conversation. Reading never marks messages as read.

const DEFAULT_LIMIT = 15;
const SNIPPET = 140;

const snippet = (text) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > SNIPPET ? `${value.slice(0, SNIPPET)}…` : value;
};

async function conversations(ctx) {
  const { data, error } = await ctx.userClient.rpc('get_chat_conversations');
  if (error) throw new ToolError(error.message);
  return data || [];
}

function limitFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(Math.round(number), 30)) : DEFAULT_LIMIT;
}

async function readThread(ctx, partner, limit) {
  const { data, error } = await ctx.userClient.rpc('get_chat_messages', { p_partner_id: partner.partner_id, p_limit: limit });
  if (error) throw new ToolError(error.message);
  const myId = ctx.user.id;
  return {
    with: partner.partner_name,
    unread_from_them: partner.unread_count,
    messages: (data?.messages || []).map((message) => ({
      from: message.sender_id === myId ? 'me' : 'them',
      text: message.message_text,
      at: message.created_at,
      read: message.is_read,
    })),
    has_earlier: Boolean(data?.has_more),
  };
}

async function send(ctx, partner, text) {
  const checked = validateChatText(text);
  if (!checked.valid) throw new ToolError(checked.error === 'chatErrEmpty' ? 'The message is empty.' : 'The message is too long (max 2000 characters).');
  const { data, error } = await ctx.userClient.rpc('send_chat_message', {
    p_receiver_id: partner.partner_id, p_text: checked.text, p_client_ref: randomUUID(),
  });
  if (error) throw new ToolError(error.message);
  return { sent: true, to: partner.partner_name, text: data.message_text, at: data.created_at };
}

const byName = (row) => [row.partner_name];

export const CHAT_COACH_TOOLS = [
  {
    name: 'read_client_chat',
    roles: ['coach'],
    description: 'Read the chat with one client (latest messages, who wrote them, whether they were read). Without a client name, list the conversations that have unread messages from clients.',
    parameters: () => ({
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name. Leave empty to see who wrote and has unread messages.' },
        limit: { type: 'integer', description: 'How many latest messages, 1-30. Defaults to 15.' },
      },
    }),
    async run(args, ctx) {
      const all = await conversations(ctx);
      if (!args.client) {
        const unread = all.filter((item) => item.unread_count > 0);
        return {
          result: {
            unread_total: unread.reduce((sum, item) => sum + item.unread_count, 0),
            conversations: unread.slice(0, 20).map((item) => ({ client: item.partner_name, unread: item.unread_count, last_message: snippet(item.last_text), at: item.last_at })),
          },
        };
      }
      const partner = matchOne(all, args.client, byName, 'client');
      return { result: await readThread(ctx, partner, limitFrom(args.limit)) };
    },
  },
  {
    name: 'send_client_chat_message',
    roles: ['coach'],
    description: 'Send a chat message from the coach to one active client. Only send what the coach asked for; do not invent promises, prices or medical advice.',
    parameters: () => ({
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Client name.' },
        message: { type: 'string', description: 'The message text, up to 2000 characters.' },
      },
      required: ['client', 'message'],
    }),
    async run(args, ctx) {
      const all = (await conversations(ctx)).filter((item) => item.status === 'active');
      const partner = matchOne(all, args.client, byName, 'client');
      return { result: await send(ctx, partner, args.message) };
    },
  },
];

export const CHAT_CLIENT_TOOLS = [
  {
    name: 'read_coach_chat',
    roles: ['client'],
    description: 'Read the client\'s chat with their coach (latest messages and how many are unread).',
    parameters: () => ({
      type: 'object',
      properties: {
        coach: { type: 'string', description: 'Coach name, only needed when the client has more than one coach.' },
        limit: { type: 'integer', description: 'How many latest messages, 1-30. Defaults to 15.' },
      },
    }),
    async run(args, ctx) {
      const all = await conversations(ctx);
      if (all.length === 0) throw new ToolError('You are not linked to a coach yet.');
      const partner = all.length === 1 ? all[0] : matchOne(all, args.coach, byName, 'coach');
      return { result: await readThread(ctx, partner, limitFrom(args.limit)) };
    },
  },
  {
    name: 'send_coach_chat_message',
    roles: ['client'],
    description: 'Send a chat message from the client to their coach. Only send what the client asked for.',
    parameters: () => ({
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message text, up to 2000 characters.' },
        coach: { type: 'string', description: 'Coach name, only needed when the client has more than one coach.' },
      },
      required: ['message'],
    }),
    async run(args, ctx) {
      const all = (await conversations(ctx)).filter((item) => item.status === 'active');
      if (all.length === 0) throw new ToolError('You are not linked to an active coach.');
      const partner = all.length === 1 ? all[0] : matchOne(all, args.coach, byName, 'coach');
      return { result: await send(ctx, partner, args.message) };
    },
  },
];
