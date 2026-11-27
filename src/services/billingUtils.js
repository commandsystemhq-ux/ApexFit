// Pure rules for the billing page (no network, no React).

export const PADDLE_LOCALES = { en: 'en', ar: 'ar', de: 'de', fr: 'fr', es: 'es' };

export function paddleLocale(locale) {
  return PADDLE_LOCALES[String(locale || 'en').slice(0, 2)] || 'en';
}

// What Paddle.js is asked to open: the overlay (inside our page, no redirect) for a transaction our server created.
// countryCode is sent for the countries that have their own price, so Paddle applies that country's price override.
export function checkoutOptions({ transactionId, locale, email, countryCode }) {
  const customer = { ...(email ? { email } : {}), ...(countryCode ? { address: { countryCode } } : {}) };
  return {
    transactionId,
    ...(Object.keys(customer).length ? { customer } : {}),
    settings: { displayMode: 'overlay', theme: 'dark', locale: paddleLocale(locale), allowLogout: false },
  };
}

// Paddle.js reports progress through events; these are the ones that matter to the page.
export function interpretPaddleEvent(event) {
  switch (event?.name) {
    case 'checkout.completed': return 'completed';
    case 'checkout.closed': return 'closed';
    case 'checkout.error':
    case 'checkout.failed':
    case 'checkout.payment.failed': return 'error';
    default: return null;
  }
}

// The webhook updates the database a moment after the payment, so after checkout we ask again until the plan is active.
export async function waitForActive(fetchStatus, { attempts = 15, delayMs = 2000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const status = await fetchStatus();
      if (status?.access_state === 'active') return status;
    } catch {
      // A failed check is tried again; the payment itself is already safe with Paddle.
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return null;
}

// How the billing page describes the coach's situation. Returns translation keys, never text.
export function describeBilling({ profile, subscription }) {
  const isTrainer = profile?.access_state === 'trainer';
  const result = { statusKey: 'billingStatusExpired', tone: 'warn', dateKey: null, date: null, notes: [], canSubscribe: false, canManage: false };
  if (!profile || profile.role !== 'coach') return result;
  if (isTrainer) return { ...result, statusKey: 'billingStatusTeam', tone: 'good', notes: ['billingTeamCovered'] };

  const manageable = Boolean(subscription?.can_manage);
  if (subscription) {
    const { status } = subscription;
    if (status === 'active') {
      return {
        ...result,
        statusKey: subscription.cancel_at_period_end ? 'billingStatusEnding' : 'billingStatusActive',
        tone: subscription.cancel_at_period_end ? 'warn' : 'good',
        dateKey: subscription.cancel_at_period_end ? 'billingEndsOn' : 'billingRenewsOn',
        date: subscription.current_period_end,
        notes: subscription.cancel_at_period_end ? ['billingEndingHelp'] : [],
        canManage: manageable,
      };
    }
    if (status === 'past_due') {
      return { ...result, statusKey: 'billingStatusPastDue', tone: 'bad', dateKey: 'billingPaidUntil', date: subscription.current_period_end, notes: ['billingPastDueHelp'], canManage: manageable };
    }
    if (status === 'paused') {
      return { ...result, statusKey: 'billingStatusPaused', tone: 'warn', notes: ['billingPausedHelp'], canManage: manageable };
    }
    if (status === 'canceled') {
      result.statusKey = 'billingStatusCanceled';
      result.dateKey = subscription.current_period_end ? 'billingEndedOn' : null;
      result.date = subscription.current_period_end;
      result.canManage = manageable;
      result.canSubscribe = profile.access_state !== 'active';
      return result;
    }
  }
  if (profile.access_state === 'trialing') {
    return { ...result, statusKey: 'billingStatusTrial', tone: 'good', dateKey: 'billingTrialEnds', date: profile.trial_ends_at, canSubscribe: true };
  }
  return { ...result, canSubscribe: true };
}