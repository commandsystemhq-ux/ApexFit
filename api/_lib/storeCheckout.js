import { computeApplicationFee } from './stripeCheckout.js';

// Stripe Checkout parameters for one pending store order. The order id travels in the metadata so the webhook
// can find the order again; amount and currency are re-checked against the order before anything is delivered.
export function buildStoreCheckoutParams({ order, destinationAccount, appUrl, customerEmail, feePercent = 0 }) {
  const fee = computeApplicationFee(order.amount_cents, feePercent);
  return {
    mode: 'payment',
    client_reference_id: order.order_id,
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: order.currency,
        unit_amount: order.amount_cents,
        product_data: { name: String(order.title).slice(0, 250) },
      },
    }],
    payment_intent_data: {
      transfer_data: { destination: destinationAccount },
      ...(fee > 0 ? { application_fee_amount: fee } : {}),
      metadata: { store_order_id: order.order_id },
    },
    metadata: { store_order_id: order.order_id },
    success_url: `${appUrl}/my-store?checkout=success`,
    cancel_url: `${appUrl}/my-store?checkout=canceled`,
  };
}

export function isDemoStore(environment = process.env) {
  return ['1', 'true', 'yes'].includes(String(environment.STORE_DEMO_MODE || '').trim().toLowerCase());
}