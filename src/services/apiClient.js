import { requireSupabase } from './supabaseClient.js';

export async function callApi(path, { method = 'POST', body } = {}) {
  const { data } = await requireSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Authentication is required.');

  const response = await fetch(`/api/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(payload.error || `Request failed (${response.status}).`);
    failure.status = response.status;
    failure.payload = payload;
    throw failure;
  }
  return payload;
}
