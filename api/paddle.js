import { adminClient, authenticate } from './_lib/auth.js';
import { HttpError, handler, readJson } from './_lib/http.js';
import { createCheckoutTransaction, createPortalLinks, paddleConfig, priceIdForCountry, pricingFromRequest } from './_lib/paddle.js';

// Coach subscription with Paddle.
//   pricing   (public, GET or POST) the plan price for the visitor's country, read from the Vercel IP header (a VPN changes it)
//   checkout  (signed-in coach) creates the checkout on the server, with that country's price, and returns what Paddle.js needs
//   portal    (signed-in coach) returns Paddle's customer-portal links (update the card, invoices, cancel)

async function coachAccess(userClient) {
  const { data, error } = await userClient.rpc('get_my_access_status');
  if (error || !data) throw new HttpError(403, 'Account details are not available.');
  if (data.role !== 'coach') throw new HttpError(403, 'Only coach accounts have a subscription.');
  if (data.access_state === 'trainer') throw new HttpError(403, 'Assistant trainers are covered by the head coach\'s plan.');
  return data;
}

async function checkout({ user, userClient }, req) {
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

  // The price is chosen here from the request's country, never taken from the browser.
  const pricing = pricingFromRequest(req);
  const priceId = priceIdForCountry(pricing.country);
  const transactionId = await createCheckoutTransaction({ userId: user.id, customerId, config, priceId });
  return {
    transactionId, clientToken: config.clientToken, environment: config.environment, email: user.email || null,
    country: pricing.localized ? pricing.country : null, usd: pricing.usd,
  };
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

// Public: only the price and the country it was chosen for.
function sendPricing(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json(pricingFromRequest(req));
}

export default handler(['GET', 'POST'], async (req, res) => {
  if (req.method === 'GET') {
    const action = new URL(req.url || '', 'http://localhost').searchParams.get('action') || 'pricing';
    if (action !== 'pricing') throw new HttpError(400, 'Unknown action.');
    return sendPricing(req, res);
  }
  const body = await readJson(req);
  if (body.action === 'pricing') return sendPricing(req, res);
  const context = await authenticate(req);
  const actions = { checkout: () => checkout(context, req), portal: () => portal(context) };
  const action = actions[body.action];
  if (!action) throw new HttpError(400, 'Unknown action.');
  res.status(200).json(await action());
});
