import { adminClient } from './_lib/auth.js';
import { HttpError, handler, readRawBody } from './_lib/http.js';
import { configuredPriceId, processPaddleWebhook, webhookSecret } from './_lib/paddle.js';

// Paddle signs the exact raw payload, so Vercel's body parser must stay disabled.
export const config = { api: { bodyParser: false } };

// Paddle notifications (subscription created, renewed, past due, paused, canceled) keep coach_subscriptions up to date.
// Notification destination: https://<your app>/api/paddle-webhook
export default handler(['POST'], async (req, res) => {
  const signatureHeader = req.headers['paddle-signature'];
  if (!signatureHeader) throw new HttpError(400, 'Missing Paddle signature.');
  const result = await processPaddleWebhook({
    rawBody: await readRawBody(req),
    signatureHeader,
    secret: webhookSecret(),
    admin: adminClient(),
    priceId: configuredPriceId(),
  });
  res.status(result.status).json(result.body);
});