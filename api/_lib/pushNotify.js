import { sendNotification } from 'web-push';
import { adminClient, requireRole } from './auth.js';
import { env } from './config.js';
import { HttpError } from './http.js';
import { buildPushMessage, buildReminderPush } from './pushText.js';

const recentlySent = new Map();
const RESEND_WINDOW_MS = 60_000;

// Chat notifications (type 'chat' and 'voice') go through notifyChatMessage instead.
const COACH_TYPES = ['message', 'session', 'invoice', 'video', 'checkin'];

const SOURCES = {
  message: { table: 'coach_messages', column: 'batch_id' },
  session: { table: 'coach_sessions', column: 'id' },
  invoice: { table: 'invoices', column: 'id' },
  checkin: { table: 'weekly_checkins', column: 'id' },
};

async function findVideoRecipients(userClient, id) {
  const { data: session, error } = await userClient.from('video_sessions').select('client_id,group_id').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!session) throw new HttpError(404, 'Nothing to notify for this item.');
  if (session.client_id) return [session.client_id];
  const { data: members, error: membersError } = await userClient.from('coaching_group_members').select('client_id').eq('group_id', session.group_id);
  if (membersError) throw membersError;
  if (!members?.length) throw new HttpError(404, 'Nothing to notify for this item.');
  return members.map((member) => member.client_id);
}

async function findRecipients(userClient, type, id) {
  if (type === 'video') return [...new Set(await findVideoRecipients(userClient, id))];
  const source = SOURCES[type];
  // Row-level security limits these reads to records owned by the signed-in coach.
  const { data, error } = await userClient.from(source.table).select('client_id').eq(source.column, id);
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, 'Nothing to notify for this item.');
  return [...new Set(data.map((row) => row.client_id))];
}

// Sends a push notification about a record the signed-in coach (or assistant trainer) owns.
export async function notifyRecipients({ user, userClient }, type, id) {
  await requireRole(userClient, 'coach', { allowTrainer: true });
  if (!COACH_TYPES.includes(type)) throw new HttpError(400, 'Unsupported notification type.');

  const key = `${user.id}:${type}:${id}`;
  const now = Date.now();
  if (now - (recentlySent.get(key) || 0) < RESEND_WINDOW_MS) throw new HttpError(429, 'Notification was just sent.');
  recentlySent.set(key, now);

  const clientIds = await findRecipients(userClient, type, id);
  return deliverPush(clientIds, type);
}

// Sends one push message to every device of the given people, in each person's language.
// `custom` replaces the built-in text of the type (used by reminders, which carry their own text).
async function deliverPush(userIds, type, urlFor = () => undefined, custom = null) {
  const admin = adminClient();
  const [{ data: profiles, error: profileError }, { data: subscriptions, error: subscriptionError }] = await Promise.all([
    admin.from('profiles').select('id,locale,role').in('id', userIds),
    admin.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', userIds),
  ]);
  if (profileError) throw profileError;
  if (subscriptionError) throw subscriptionError;

  const vapidDetails = {
    subject: env('VAPID_SUBJECT'),
    publicKey: env('VAPID_PUBLIC_KEY'),
    privateKey: env('VAPID_PRIVATE_KEY'),
  };
  const profileById = new Map((profiles || []).map((profile) => [profile.id, profile]));
  const expired = [];
  let sent = 0;

  await Promise.all((subscriptions || []).map(async (subscription) => {
    const profile = profileById.get(subscription.user_id);
    const message = custom || buildPushMessage(type, profile?.locale);
    const url = urlFor(profile);
    try {
      await sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(url ? { ...message, url } : message),
        { TTL: 3600, urgency: 'normal', vapidDetails },
      );
      sent += 1;
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) expired.push(subscription.id);
    }
  }));

  if (expired.length) await admin.from('push_subscriptions').delete().in('id', expired);
  return { recipients: userIds.length, sent };
}

// Tells the other person in a chat that a message (text or voice) arrived. Only the sender can ask: the message is
// read with the sender's own session, so row-level security hides anyone else's messages.
export async function notifyChatMessage({ user, userClient }, messageId) {
  const key = `${user.id}:chat:${messageId}`;
  const now = Date.now();
  if (now - (recentlySent.get(key) || 0) < RESEND_WINDOW_MS) throw new HttpError(429, 'Notification was just sent.');
  recentlySent.set(key, now);

  const { data, error } = await userClient
    .from('chat_messages')
    .select('receiver_id,message_type')
    .eq('id', messageId)
    .eq('sender_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Nothing to notify for this item.');
  const pushType = data.message_type === 'voice' || data.message_type === 'image' ? data.message_type : 'chat';
  return deliverPush([data.receiver_id], pushType, (profile) => (profile?.role === 'coach' ? '/messages' : '/coach-hub'));
}

// Sends the reminders that came due (the result of run_reminder_engine: [{ user_id, title, message, link }]) to the
// devices of the people they are for. Called by the scheduled job, not by a browser. Never throws: a push problem must
// not stop the other scheduled work.
export async function deliverReminderPushes(reminders) {
  let sent = 0;
  for (const reminder of reminders || []) {
    try {
      const result = await deliverPush([reminder.user_id], 'reminder', () => reminder.link || '/reminders', buildReminderPush(reminder));
      sent += result.sent;
    } catch {
      // This person's devices are skipped; the reminder is still in their notification center.
    }
  }
  return { due: (reminders || []).length, sent };
}
