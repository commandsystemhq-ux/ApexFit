import { authenticate } from './_lib/auth.js';
import { env } from './_lib/config.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';
import { notifyChatMessage, notifyRecipients } from './_lib/pushNotify.js';

export default handler(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ publicKey: env('VAPID_PUBLIC_KEY') });
  }
  const context = await authenticate(req);
  const body = await readJson(req);
  if (body.action !== 'notify') throw new HttpError(400, 'Unknown action.');
  if (body.type === 'chat') return res.status(200).json(await notifyChatMessage(context, requireUuid(body.id, 'Message')));
  res.status(200).json(await notifyRecipients(context, body.type, requireUuid(body.id, 'Item')));
});