export function computeApplicationFee(amountCents, feePercent) {
  if (!feePercent) return 0;
  return Math.round((amountCents * feePercent) / 100);
}

export function buildCheckoutParams({ invoice, destinationAccount, appUrl, customerEmail, feePercent = 0 }) {
  const fee = computeApplicationFee(invoice.amount_cents, feePercent);
  return {
    mode: 'payment',
    client_reference_id: invoice.id,
    customer_email: customerEmail || undefined,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: invoice.currency,
        unit_amount: invoice.amount_cents,
        product_data: { name: `${invoice.invoice_number} · ${invoice.description}`.slice(0, 250) },
      },
    }],
    payment_intent_data: {
      transfer_data: { destination: destinationAccount },
      ...(fee > 0 ? { application_fee_amount: fee } : {}),
      metadata: { invoice_id: invoice.id },
    },
    metadata: { invoice_id: invoice.id },
    success_url: `${appUrl}/?checkout=success#coachHub`,
    cancel_url: `${appUrl}/?checkout=canceled#coachHub`,
  };
}
