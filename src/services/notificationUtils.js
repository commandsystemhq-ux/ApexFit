// Pure helpers for the notification center: what each kind of notification says, where it leads, how old it is.
// The database stores only the kind and its details; the words come from the translations, so every person reads
// notifications in their own language. Nothing here touches the network.
import { fillTemplate } from './textTemplate.js';

export const NOTIFICATION_TYPES = ['message', 'checkin_submitted', 'checkin_reviewed', 'invoice_new', 'invoice_reported', 'invoice_paid', 'progression', 'reminder'];
export const NOTIFICATION_ICONS = {
  message: '\uD83D\uDCAC',
  checkin_submitted: '\u2611',
  checkin_reviewed: '\u2705',
  invoice_new: '\uD83E\uDDFE',
  invoice_reported: '\uD83D\uDCB5',
  invoice_paid: '\u2714',
  progression: '\uD83D\uDCC8',
  reminder: '\u23F0',
};
export const NOTIFICATION_PAGE_SIZE = 30;

const MESSAGE_KINDS = ['text', 'voice', 'image', 'broadcast'];

// Only links that stay inside the app are followed.
export function safeNotificationLink(link) {
  const value = String(link ?? '');
  if (!value.startsWith('/') || value.startsWith('//') || value.length > 200) return null;
  return /^\/[A-Za-z0-9/_?=&.%:-]*$/.test(value) ? value : null;
}

export function unreadLabel(count) {
  const value = Number(count) || 0;
  return value > 99 ? '99+' : String(value);
}

// "$120.00" style amount in the person's language. Falls back to the plain number if the currency is unknown.
export function formatInvoiceAmount(cents, currency, locale = 'en') {
  const amount = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: String(currency || 'usd').toUpperCase() }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

// { title, body } of one notification, in the language of `t`. Missing details are left out of the sentence.
export function describeNotification(item, t, locale = 'en') {
  const payload = item?.payload || {};
  const type = NOTIFICATION_TYPES.includes(item?.type) ? item.type : null;
  if (!type) return { title: t('notifTitle_unknown'), body: '' };

  if (type === 'reminder') {
    const fromCoach = payload.from_coach ? fillTemplate(t('notifBody_reminderFromCoach'), { name: payload.coach_name || '' }) : '';
    return { title: payload.title || t('notifTitle_reminder'), body: [payload.message, fromCoach].filter(Boolean).join(' · ') };
  }

  const values = {
    name: payload.sender_name || payload.client_name || payload.coach_name || '',
    invoice: payload.invoice_number || '',
    amount: payload.amount_cents !== undefined ? formatInvoiceAmount(payload.amount_cents, payload.currency, locale) : '',
  };
  let bodyKey = `notifBody_${type}`;
  if (type === 'message') {
    const kind = MESSAGE_KINDS.includes(payload.kind) ? payload.kind : 'text';
    bodyKey = `notifBody_message_${kind}`;
  }
  const count = Number(payload.count) || 1;
  const body = fillTemplate(t(bodyKey), values);
  return { title: t(`notifTitle_${type}`), body: count > 1 ? `${body} (${count})` : body };
}

// "now", "5 min", "3 h", "2 d", then a date: a short age that fits in a narrow menu.
export function formatNotificationAge(value, locale, now = new Date(), t = null) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - time) / 1000));
  const label = (key, fallback) => (t ? t(key) : fallback);
  if (seconds < 60) return label('notifAgeNow', 'now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${label('notifAgeMin', 'min')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${label('notifAgeHour', 'h')}`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${label('notifAgeDay', 'd')}`;
  return new Date(time).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

// A list update: new rows first, rows already shown replaced by their newer copy, newest at the top.
export function mergeNotifications(current, incoming) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, { ...byId.get(item.id), ...item });
  return [...byId.values()].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || String(right.id).localeCompare(String(left.id)));
}

export function markReadLocally(items, id, at = new Date().toISOString()) {
  return items.map((item) => (item.id === id && !item.read_at ? { ...item, read_at: at, is_read: true } : item));
}

export function markAllReadLocally(items, at = new Date().toISOString()) {
  return items.map((item) => (item.read_at ? item : { ...item, read_at: at, is_read: true }));
}

export function countUnread(items) {
  return items.filter((item) => !item.read_at).length;
}
