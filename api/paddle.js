import { adminClient, authenticate } from './_lib/auth.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { createCheckoutTransaction, createPortalLinks, paddleConfig } from './_lib/paddle.js';

// Coach subscription with Paddle. Both actions are for the signed-in coach only.
//   checkout  creates the checkout on the server and returns what Paddle.js needs to open it inside the app
//   portal    returns Paddle's customer-portal links (update the card, invoices, cancel)

async function coachAccess(userClient) {
  const { data, error } = await userClient.rpc('get_my_access_status');
  if (error || !data) throw new HttpError(403, 'Account details are not available.');
  if (data.role !== 'coach') throw new HttpError(403, 'Only coach accounts have a subscription.');
  if (data.access_state === 'trainer') throw new HttpError(403, 'Assistant trainers are covered by the head coach\'s plan.');
  return data;
}

async function checkout({ user, userClient }) {
  const access = await coachAccess(userClient);
  if (access.access_state === 'active') throw new HttpError(409, 'Your subscription is already active.');
  const config = paddleConfig();

  // A coach who subscribed before reuses their Paddle customer, so a returning coach does not get a second one.
  const { data: existing, error } = await adminClient()
    .from('coach_subscriptions')
    .select('provider,provider_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  const customerId = existing?.provider === 'paddle' ? existing.provider_customer_id : null;

  const transactionId = await createCheckoutTransaction({ userId: user.id, customerId, config });
  return { transactionId, clientToken: config.clientToken, environment: config.environment, email: user.email || null };
}

async function portal({ user, userClient }) {
  await coachAccess(userClient);
  const config = paddleConfig();
  const { data, error } = await adminClient()
    .from('coach_subscriptions')
    .select('provider,provider_customer_id,provider_subscription_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.provider !== 'paddle' || !data.provider_customer_id) throw new HttpError(404, 'There is no subscription to manage yet.');
  return createPortalLinks({ customerId: data.provider_customer_id, subscriptionId: data.provider_subscription_id, config });
}

export default handler(['POST'], async (req, res) => {
  const context = await authenticate(req);
  const body = await readJson(req);
  const actions = { checkout: () => checkout(context), portal: () => portal(context) };
  const action = actions[body.action];
  if (!action) throw new HttpError(400, 'Unknown action.');
  res.status(200).json(await action());
});