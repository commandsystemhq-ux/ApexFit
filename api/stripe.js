import Stripe from 'stripe';
import { adminClient, authenticate, requireRole } from './_lib/auth.js';
import { appUrl, env, platformFeePercent } from './_lib/config.js';
import { HttpError, handler, readJson, requireUuid } from './_lib/http.js';
import { buildCheckoutParams } from './_lib/stripeCheckout.js';

const stripeClient = () => new Stripe(env('STRIPE_SECRET_KEY'));

async function syncAccount(admin, stripe, coachId, accountId) {
  const account = await stripe.accounts.retrieve(accountId);
  const row = {
    charges_enabled: Boolean(account.charges_enabled),
    details_submitted: Boolean(account.details_submitted),
    updated_at: new Date().toISOString(),
  };
  const { error } = await admin.from('coach_payment_accounts').update(row).eq('coach_id', coachId);
  if (error) throw error;
  return row;
}

async function connectOnboard({ user, userClient }) {
  await requireRole(userClient, 'coach');
  const admin = adminClient();
  const stripe = stripeClient();
  const { data: existing, error } = await admin
    .from('coach_payment_accounts')
    .select('stripe_account_id')
    .eq('coach_id', user.id)
    .maybeSingle();
  if (error) throw error;

  let accountId = existing?.stripe_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: user.email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { coach_id: user.id },
    });
    accountId = account.id;
    const { error: insertError } = await admin
      .from('coach_payment_accounts')
      .insert({ coach_id: user.id, stripe_account_id: accountId });
    if (insertError) throw insertError;
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${appUrl()}/invoicing`,
    return_url: `${appUrl()}/invoicing?stripe=return`,
    type: 'account_onboarding',
  });
  return { url: link.url };
}

async function connectStatus({ user, userClient }) {
  await requireRole(userClient, 'coach');
  const admin = adminClient();
  const { data, error } = await admin
    .from('coach_payment_accounts')
    .select('stripe_account_id')
    .eq('coach_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { connected: false, charges_enabled: false, details_submitted: false };
  const row = await syncAccount(admin, stripeClient(), user.id, data.stripe_account_id);
  return { connected: true, charges_enabled: row.charges_enabled, details_submitted: row.details_submitted };
}

async function checkout({ user, userClient }, body) {
  await requireRole(userClient, 'client');
  const invoiceId = requireUuid(body.invoiceId, 'Invoice');

  // Row-level security guarantees the signed-in client can only load their own invoice.
  const { data: invoice, error } = await userClient
    .from('invoices')
    .select('id,invoice_number,coach_id,description,amount_cents,currency,status')
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw error;
  if (!invoice) throw new HttpError(404, 'Invoice not found.');
  if (invoice.status !== 'open') throw new HttpError(409, 'This invoice is no longer payable.');

  const admin = adminClient();
  const { data: account, error: accountError } = await admin
    .from('coach_payment_accounts')
    .select('stripe_account_id')
    .eq('coach_id', invoice.coach_id)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account) throw new HttpError(409, 'Your coach has not finished payment setup yet.');

  const stripe = stripeClient();
  const status = await syncAccount(admin, stripe, invoice.coach_id, account.stripe_account_id);
  if (!status.charges_enabled) throw new HttpError(409, 'Your coach has not finished payment setup yet.');

  const session = await stripe.checkout.sessions.create(buildCheckoutParams({
    invoice,
    destinationAccount: account.stripe_account_id,
    appUrl: appUrl(),
    customerEmail: user.email,
    feePercent: platformFeePercent(),
  }));
  return { url: session.url };
}

export default handler(['POST'], async (req, res) => {
  const context = await authenticate(req);
  const body = await readJson(req);
  const actions = {
    'connect-onboard': () => connectOnboard(context),
    'connect-status': () => connectStatus(context),
    checkout: () => checkout(context, body),
  };
  const action = actions[body.action];
  if (!action) throw new HttpError(400, 'Unknown action.');
  res.status(200).json(await action());
});
