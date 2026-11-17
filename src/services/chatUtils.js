// Pure helpers for the coach/client chat: validation, merging live updates into a conversation,
// day grouping and message status. Nothing here touches the network, so it is easy to test.

export const CHAT_MAX_LENGTH = 2000;
export const CHAT_PAGE_SIZE = 50;

export function validateChatText(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return { valid: false, text: '', error: 'chatErrEmpty' };
  if (text.length > CHAT_MAX_LENGTH) return { valid: false, text, error: 'chatErrTooLong' };
  return { valid: true, text, error: null };
}

const time = (message) => {
  const value = Date.parse(message.created_at);
  return Number.isNaN(value) ? 0 : value;
};

export function compareMessages(left, right) {
  return time(left) - time(right) || String(left.id).localeCompare(String(right.id));
}

// Adds or updates one message. A message the person just sent (still waiting for the server, matched by
// client_ref) is replaced by the saved one, and the same message arriving twice (answer + live update) is kept once.
export function upsertMessage(list, incoming) {
  const next = [];
  let placed = false;
  for (const message of list) {
    const sameId = message.id === incoming.id;
    const sameRef = incoming.client_ref && message.client_ref === incoming.client_ref;
    if (sameId || sameRef) {
      if (!placed) {
        next.push({ ...message, ...incoming, pending: false, failed: false });
        placed = true;
      }
    } else next.push(message);
  }
  if (!placed) next.push({ ...incoming, pending: Boolean(incoming.pending), failed: false });
  return next.sort(compareMessages);
}

export function mergePage(list, page) {
  return page.reduce((current, message) => upsertMessage(current, message), list);
}

export function markSentRead(list, ids) {
  const set = new Set(ids);
  return list.map((message) => (set.has(message.id) ? { ...message, is_read: true } : message));
}

// 'sending' | 'failed' | 'sent' | 'read' for a message the current person wrote.
export function messageStatus(message) {
  if (message.failed) return 'failed';
  if (message.pending) return 'sending';
  return message.is_read ? 'read' : 'sent';
}

export function makePendingMessage({ id, senderId, receiverId, text, clientRef, now = new Date() }) {
  return {
    id: id || `pending-${clientRef}`,
    client_ref: clientRef,
    sender_id: senderId,
    receiver_id: receiverId,
    message_text: text,
    created_at: now.toISOString(),
    is_read: false,
    pending: true,
    failed: false,
  };
}

// The conversation the screen shows: chat messages plus the coach's one-way notes and videos
// (broadcasts, workflow messages, purchase thanks) that were sent to this client.
export function buildThread({ chat, notes = [], myId }) {
  const items = chat.map((message) => ({
    key: `chat:${message.id}`,
    type: 'chat',
    id: message.id,
    created_at: message.created_at,
    fromMe: message.sender_id === myId,
    text: message.message_text,
    message,
  }));
  for (const note of notes) {
    items.push({
      key: `note:${note.id}`,
      type: note.kind === 'video' ? 'video' : 'note',
      id: note.id,
      created_at: note.created_at,
      fromMe: note.coach_id === myId,
      text: note.body || '',
      videoPath: note.video_path || null,
      note,
    });
  }
  return items.sort(compareMessages);
}

// 2026-11-17 in the viewer's own time zone.
export function localDay(value) {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function groupByDay(items) {
  const groups = [];
  for (const item of items) {
    const day = localDay(item.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}

// 'today' | 'yesterday' | 'date'
export function dayKind(day, now = new Date()) {
  if (day === localDay(now)) return 'today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return day === localDay(yesterday) ? 'yesterday' : 'date';
}

export function formatClock(value, locale) {
  return new Date(value).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export function formatFullTime(value, locale) {
  return new Date(value).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' });
}

// The time shown in the conversation list: the clock for today, otherwise a short date.
export function formatListTime(value, locale, now = new Date()) {
  if (!value) return '';
  return localDay(value) === localDay(now)
    ? formatClock(value, locale)
    : new Date(value).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function isNearBottom({ scrollHeight, scrollTop, clientHeight }, threshold = 120) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function totalUnread(conversations) {
  return (conversations || []).reduce((sum, item) => sum + (Number(item.unread_count) || 0), 0);
}

export function sortConversations(conversations) {
  return [...(conversations || [])].sort((left, right) => {
    const a = left.last_at ? Date.parse(left.last_at) : 0;
    const b = right.last_at ? Date.parse(right.last_at) : 0;
    return b - a || String(left.partner_name).localeCompare(String(right.partner_name));
  });
}

export function filterConversations(conversations, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return conversations;
  return conversations.filter((item) => String(item.partner_name || '').toLowerCase().includes(needle));
}

export function initialOf(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
}
