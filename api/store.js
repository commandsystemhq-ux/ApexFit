import Stripe from 'stripe';
import { adminClient, authenticate, requireRole } from './_lib/auth.js';
import { appUrl, env, platformFeePercent } from './_lib/config.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';
import { buildStoreCheckoutParams, isDemoStore } from './_lib/storeCheckout.js';

async function readyAccount(admin, stripe, coachId) {
  const { data: account, error } = await admin
    .from('coach_payment_accounts')
    .select('stripe_account_id')
    .eq('coach_id', coachId)
    .maybeSingle();
  if (error) throw error;
  if (!account) throw new HttpError(409, 'The coach has not finished payment setup yet.');
  const remote = await stripe.accounts.retrieve(account.stripe_account_id);
  if (!remote.charges_enabled) throw new HttpError(409, 'The coach has not finished payment setup yet.');
  return account.stripe_account_id;
}

// A client buys a published program. Free products are delivered by the database right away; paid ones go through
// Stripe Checkout (or, when STORE_DEMO_MODE is on, are confirmed immediately for testing).
async function checkout({ user, userClient }, body) {
  await requireRole(userClient, 'client');
  const productId = requireUuid(body.productId, 'Product');

  // The database checks that the product is published and belongs to this client's coach.
  const { data: order, error } = await userClient.rpc('begin_store_purchase', { p_product_id: productId });
  if (error) throw new HttpError(400, error.message);
  if (order.completed) return { completed: true, alreadyOwned: Boolean(order.already_owned) };

  const admin = adminClient();
  if (isDemoStore()) {
    const { error: demoError } = await admin.rpc('complete_store_order', {
      p_order_id: order.order_id, p_session_id: null, p_amount_cents: null, p_currency: null, p_payment_intent: null, p_mode: 'demo',
    });
    if (demoError) throw demoError;
    return { completed: true, demo: true };
  }

  const stripe = new Stripe(env('STRIPE_SECRET_KEY'));
  const destinationAccount = await readyAccount(admin, stripe, order.coach_id);
  const session = await stripe.checkout.sessions.create(buildStoreCheckoutParams({
    order,
    destinationAccount,
    appUrl: appUrl(),
    customerEmail: user.email,
    feePercent: platformFeePercent(),
  }));
  const { error: updateError } = await admin.from('store_orders').update({ stripe_session_id: session.id }).eq('id', order.order_id);
  if (updateError) throw updateError;
  return { url: session.url };
}

export default handler(['POST'], async (req, res) => {
  const context = await authenticate(req);
  const body = await readJson(req);
  if (body.action !== 'checkout') throw new HttpError(400, 'Unknown action.');
  res.status(200).json(await checkout(context, body));
});