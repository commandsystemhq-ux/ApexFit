import { sendNotification } from 'web-push';
import { adminClient, requireRole } from './auth.js';
import { env } from './config.js';
import { HttpError } from './http.js';
import { NOTIFICATION_TYPES, buildPushMessage } from './pushText.js';

const recentlySent = new Map();
const RESEND_WINDOW_MS = 60_000;

const SOURCES = {
  message: { table: 'coach_messages', column: 'batch_id' },
  session: { table: 'coach_sessions', column: 'id' },
  invoice: { table: 'invoices', column: 'id' },
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
  if (!NOTIFICATION_TYPES.includes(type)) throw new HttpError(400, 'Unsupported notification type.');

  const key = `${user.id}:${type}:${id}`;
  const now = Date.now();
  if (now - (recentlySent.get(key) || 0) < RESEND_WINDOW_MS) throw new HttpError(429, 'Notification was just sent.');
  recentlySent.set(key, now);

  const clientIds = await findRecipients(userClient, type, id);
  const admin = adminClient();
  const [{ data: profiles, error: profileError }, { data: subscriptions, error: subscriptionError }] = await Promise.all([
    admin.from('profiles').select('id,locale').in('id', clientIds),
    admin.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', clientIds),
  ]);
  if (profileError) throw profileError;
  if (subscriptionError) throw subscriptionError;

  const vapidDetails = {
    subject: env('VAPID_SUBJECT'),
    publicKey: env('VAPID_PUBLIC_KEY'),
    privateKey: env('VAPID_PRIVATE_KEY'),
  };
  const localeByUser = new Map((profiles || []).map((profile) => [profile.id, profile.locale]));
  const expired = [];
  let sent = 0;

  await Promise.all((subscriptions || []).map(async (subscription) => {
    const message = buildPushMessage(type, localeByUser.get(subscription.user_id));
    try {
      await sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(message),
        { TTL: 3600, urgency: 'normal', vapidDetails },
      );
      sent += 1;
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) expired.push(subscription.id);
    }
  }));

  if (expired.length) await admin.from('push_subscriptions').delete().in('id', expired);
  return { recipients: clientIds.length, sent };
}