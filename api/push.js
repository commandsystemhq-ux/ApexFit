import { sendNotification } from 'web-push';
import { adminClient, authenticate, requireRole } from './_lib/auth.js';
import { env } from './_lib/config.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';
import { NOTIFICATION_TYPES, buildPushMessage } from './_lib/pushText.js';

const recentlySent = new Map();
const RESEND_WINDOW_MS = 60_000;

const SOURCES = {
  message: { table: 'coach_messages', column: 'batch_id' },
  session: { table: 'coach_sessions', column: 'id' },
  invoice: { table: 'invoices', column: 'id' },
};

async function findRecipients(userClient, type, id) {
  const source = SOURCES[type];
  // Row-level security limits these reads to records owned by the signed-in coach.
  const { data, error } = await userClient.from(source.table).select('client_id').eq(source.column, id);
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, 'Nothing to notify for this item.');
  return [...new Set(data.map((row) => row.client_id))];
}

async function notify({ user, userClient }, body) {
  await requireRole(userClient, 'coach');
  if (!NOTIFICATION_TYPES.includes(body.type)) throw new HttpError(400, 'Unsupported notification type.');
  const id = requireUuid(body.id, 'Item');

  const key = `${user.id}:${body.type}:${id}`;
  const now = Date.now();
  if (now - (recentlySent.get(key) || 0) < RESEND_WINDOW_MS) throw new HttpError(429, 'Notification was just sent.');
  recentlySent.set(key, now);

  const clientIds = await findRecipients(userClient, body.type, id);
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
    const message = buildPushMessage(body.type, localeByUser.get(subscription.user_id));
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

export default handler(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ publicKey: env('VAPID_PUBLIC_KEY') });
  }
  const context = await authenticate(req);
  const body = await readJson(req);
  if (body.action !== 'notify') throw new HttpError(400, 'Unknown action.');
  res.status(200).json(await notify(context, body));
});
