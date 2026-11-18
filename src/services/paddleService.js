import { requireSupabase } from './supabaseClient.js';
import { checkoutOptions, interpretPaddleEvent } from './billingUtils.js';

const PADDLE_SCRIPT = 'https://cdn.paddle.com/paddle/v2/paddle.js';

let scriptPromise = null;
let initializedWith = '';
let listener = () => {};

export class BillingError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function call(action) {
  const { data } = await requireSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new BillingError('Authentication is required.', 401);
  const response = await fetch('/api/paddle', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new BillingError(payload.error || `Request failed (${response.status}).`, response.status);
  return payload;
}

export async function getMySubscription() {
  const { data, error } = await requireSupabase().rpc('get_my_subscription');
  if (error) throw error;
  return data;
}

// Paddle's own script, loaded only when a coach actually starts to pay.
function loadPaddle() {
  if (window.Paddle) return Promise.resolve(window.Paddle);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PADDLE_SCRIPT;
      script.async = true;
      script.onload = () => (window.Paddle ? resolve(window.Paddle) : reject(new BillingError('The payment window could not start.')));
      script.onerror = () => {
        scriptPromise = null;
        reject(new BillingError('The secure payment window could not be loaded. Check your connection or ad blocker and try again.'));
      };
      document.head.appendChild(script);
    });
  }
  return scriptPromise;
}

// Opens Paddle's checkout as an overlay on this page. `onEvent` receives 'completed', 'closed' or 'error'.
export async function openSubscriptionCheckout({ locale, onEvent }) {
  const session = await call('checkout');
  const paddle = await loadPaddle();
  listener = onEvent;

  const key = `${session.environment}:${session.clientToken}`;
  if (initializedWith !== key) {
    if (session.environment === 'sandbox') paddle.Environment.set('sandbox');
    paddle.Initialize({ token: session.clientToken, eventCallback: (event) => { const kind = interpretPaddleEvent(event); if (kind) listener(kind, event); } });
    initializedWith = key;
  }
  paddle.Checkout.open(checkoutOptions({ transactionId: session.transactionId, locale, email: session.email }));
}

export async function getBillingPortalLinks() {
  return call('portal');
}