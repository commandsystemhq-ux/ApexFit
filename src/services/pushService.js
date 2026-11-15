import { callApi } from './apiClient.js';
import { urlBase64ToUint8Array } from './coachingUtils.js';
import { requireSupabase } from './supabaseClient.js';

export function isPushSupported() {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

async function getRegistration() {
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export async function getPushState() {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'available';
}

export async function enablePush() {
  if (!isPushSupported()) throw new Error('This browser does not support push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');

  const response = await fetch('/api/push');
  const { publicKey, error } = await response.json().catch(() => ({}));
  if (!response.ok || !publicKey) throw new Error(error || 'Push notifications are not configured yet.');

  const registration = await getRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const { endpoint, keys } = subscription.toJSON();
  const { error: saveError } = await requireSupabase().rpc('save_push_subscription', {
    p_endpoint: endpoint,
    p_p256dh: keys.p256dh,
    p_auth: keys.auth,
    p_user_agent: navigator.userAgent,
  });
  if (saveError) {
    await subscription.unsubscribe();
    throw saveError;
  }
}

export async function disablePush() {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const { error } = await requireSupabase().rpc('delete_push_subscription', { p_endpoint: subscription.endpoint });
  await subscription.unsubscribe();
  if (error) throw error;
}

// Notification delivery is best effort and must never block the action that triggered it.
export function notifyClients(type, id) {
  return callApi('push', { body: { action: 'notify', type, id } }).catch(() => null);
}
