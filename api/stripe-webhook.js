import Stripe from 'stripe';
import { adminClient } from './_lib/auth.js';
import { env } from './_lib/config.js';
import { HttpError, handler, readRawBody } from './_lib/http.js';

// Stripe signs the exact raw payload, so Vercel's body parser must stay disabled.
export const config = { api: { bodyParser: false } };

const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

// Only program-store purchases are paid through Stripe. They carry the order id; the database checks the amount and
// currency before delivering the program.
async function completeStoreOrder(admin, session) {
  const orderId = session.metadata?.store_order_id;
  if (!orderId || session.payment_status !== 'paid') return false;

  const { error } = await admin.rpc('complete_store_order', {
    p_order_id: orderId,
    p_session_id: session.id,
    p_amount_cents: session.amount_total,
    p_currency: session.currency,
    p_payment_intent: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
    p_mode: 'stripe',
  });
  if (error) throw error;
  return true;
}

async function handlePaidSession(admin, session) {
  await completeStoreOrder(admin, session);
}

export default handler(['POST'], async (req, res) => {
  const stripe = new Stripe(env('STRIPE_SECRET_KEY'));
  const signature = req.headers['stripe-signature'];
  if (!signature) throw new HttpError(400, 'Missing Stripe signature.');

  let event;
  try {
    event = stripe.webhooks.constructEvent(await readRawBody(req), signature, env('STRIPE_WEBHOOK_SECRET'));
  } catch {
    throw new HttpError(400, 'Invalid Stripe signature.');
  }

  const admin = adminClient();
  if (PAID_EVENTS.has(event.type)) {
    await handlePaidSession(admin, event.data.object);
  } else if (event.type === 'account.updated') {
    const account = event.data.object;
    const { error } = await admin
      .from('coach_payment_accounts')
      .update({
        charges_enabled: Boolean(account.charges_enabled),
        details_submitted: Boolean(account.details_submitted),
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_account_id', account.id);
    if (error) throw error;
  }

  res.status(200).json({ received: true });
});
