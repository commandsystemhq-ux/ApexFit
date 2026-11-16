import { requireSupabase } from './supabaseClient.js';
import { parseNdjsonChunk } from './jackUtils.js';

export class JackRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Sends the conversation plus page context and reports each streamed event (steps, text, navigation).
export async function streamJack({ messages, context, signal, onEvent }) {
  const { data } = await requireSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new JackRequestError('Authentication is required.', 401);

  const response = await fetch('/api/jack', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context }),
    signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new JackRequestError(payload.error || `Request failed (${response.status}).`, response.status);
  }

  if (!response.body) {
    const text = await response.text();
    parseNdjsonChunk('', `${text}\n`).events.forEach(onEvent);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const parsed = parseNdjsonChunk(buffer, decoder.decode(value, { stream: true }));
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
  parseNdjsonChunk('', `${buffer}\n`).events.forEach(onEvent);
}