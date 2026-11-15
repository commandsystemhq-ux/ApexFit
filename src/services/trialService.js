export const TRIAL_DURATION_DAYS = 3;

export function createTrialWindow(startedAt = new Date()) {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) {
    throw new TypeError('Trial start date must be a valid date.');
  }

  const endsAt = new Date(start.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  return { startedAt: start.toISOString(), endsAt: endsAt.toISOString() };
}

export function getTrialState({ role, trialEndsAt, subscriptionStatus }, now = new Date()) {
  if (role !== 'coach') return 'client';
  if (subscriptionStatus === 'active') return 'active';
  const end = new Date(trialEndsAt);
  if (Number.isNaN(end.getTime())) {
    throw new TypeError('Trial end date must be a valid date.');
  }
  return end.getTime() > now.getTime() ? 'trialing' : 'expired';
}
