export function computeApplicationFee(amountCents, feePercent) {
  if (!feePercent) return 0;
  return Math.round((amountCents * feePercent) / 100);
}
