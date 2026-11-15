export const CURRENCIES = ['usd', 'eur', 'gbp', 'egp', 'sar', 'aed'];
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

export function validateVideoFile(file) {
  if (!file || !VIDEO_TYPES[file.type]) throw new TypeError('Choose an MP4, WebM, or MOV video.');
  if (file.size > MAX_VIDEO_BYTES) throw new RangeError('Videos must be 50 MB or smaller.');
  return VIDEO_TYPES[file.type];
}

export function normalizeMessageDraft({ body = '', videoFile = null, sendToAll = false, clientIds = [] }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length > 2000) throw new RangeError('Messages cannot exceed 2000 characters.');
  if (!text && !videoFile) throw new TypeError('Write a message or attach a video.');
  if (videoFile) validateVideoFile(videoFile);
  if (!sendToAll && clientIds.length === 0) throw new TypeError('Choose at least one client.');
  return { body: text, sendToAll: Boolean(sendToAll), clientIds: sendToAll ? [] : [...new Set(clientIds)] };
}

export function parseMoneyToCents(input) {
  const text = String(input ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new TypeError('Enter an amount such as 49.99.');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 50 || cents > 100000000) {
    throw new RangeError('Amount must be between 0.50 and 1,000,000.00.');
  }
  return cents;
}

export function formatMoney(cents, currency, locale = 'en') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: String(currency).toUpperCase() }).format(cents / 100);
}

function requireCurrency(currency) {
  if (!CURRENCIES.includes(currency)) throw new TypeError('Choose a supported currency.');
  return currency;
}

export function normalizePackageForm({ name, description = '', session_count, price, currency = 'usd' }) {
  const title = String(name ?? '').trim();
  if (!title || title.length > 120) throw new RangeError('Package name must be between 1 and 120 characters.');
  const details = String(description ?? '').trim();
  if (details.length > 500) throw new RangeError('Package description cannot exceed 500 characters.');
  const sessions = Number(session_count);
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 500) {
    throw new RangeError('Sessions must be a whole number between 1 and 500.');
  }
  return {
    name: title,
    description: details,
    session_count: sessions,
    price_cents: parseMoneyToCents(price),
    currency: requireCurrency(currency),
  };
}

export function normalizeInvoiceForm({ description, amount, currency = 'usd', dueDate = '' }) {
  const text = String(description ?? '').trim();
  if (!text || text.length > 300) throw new RangeError('Description must be between 1 and 300 characters.');
  return {
    description: text,
    amountCents: parseMoneyToCents(amount),
    currency: requireCurrency(currency),
    dueDate: dueDate || null,
  };
}

export function normalizeSessionForm({ clientId, title, date, startTime, endTime, location = '', notes = '' }) {
  if (!clientId) throw new TypeError('Choose a client.');
  const name = String(title ?? '').trim();
  if (!name || name.length > 160) throw new RangeError('Title must be between 1 and 160 characters.');
  const start = new Date(`${date}T${startTime}`);
  const end = new Date(`${date}T${endTime}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new TypeError('Enter a valid date and time.');
  if (end <= start) throw new RangeError('The session must end after it starts.');
  if (end.getTime() - start.getTime() > 12 * 60 * 60 * 1000) throw new RangeError('A session cannot be longer than 12 hours.');
  if (String(location).length > 200) throw new RangeError('Location cannot exceed 200 characters.');
  if (String(notes).length > 1000) throw new RangeError('Notes cannot exceed 1000 characters.');
  return {
    clientId,
    title: name,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    location: String(location).trim(),
    notes: String(notes).trim(),
  };
}

export function groupSentMessages(rows) {
  const batches = new Map();
  for (const row of rows) {
    if (!batches.has(row.batch_id)) {
      batches.set(row.batch_id, {
        batchId: row.batch_id,
        kind: row.kind,
        body: row.body,
        videoPath: row.video_path,
        createdAt: row.created_at,
        recipients: 0,
        read: 0,
      });
    }
    const batch = batches.get(row.batch_id);
    batch.recipients += 1;
    if (row.read_at) batch.read += 1;
  }
  return [...batches.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function totalCreditsRemaining(credits) {
  return credits.reduce((sum, credit) => sum + Number(credit.sessions_remaining || 0), 0);
}

export function urlBase64ToUint8Array(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isUpcoming(session, now = Date.now()) {
  return session.status === 'scheduled' && new Date(session.ends_at).getTime() >= now;
}

export function clientLabel(link) {
  return link?.client_name || link?.client_email || '—';
}
