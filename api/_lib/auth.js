import { createClient } from '@supabase/supabase-js';
import { env } from './config.js';
import { HttpError } from './http.js';

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

export function adminClient() {
  return createClient(
    env('SUPABASE_URL', ['VITE_SUPABASE_URL']),
    env('SUPABASE_SERVICE_ROLE_KEY'),
    clientOptions,
  );
}

export async function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sign in to continue.');

  const userClient = createClient(
    env('SUPABASE_URL', ['VITE_SUPABASE_URL']),
    env('SUPABASE_ANON_KEY', ['VITE_SUPABASE_ANON_KEY']),
    { ...clientOptions, global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  return { user: data.user, userClient };
}

// Assistant trainers have role 'coach' but access_state 'trainer'; they pass only where `allowTrainer` is set.
export async function requireRole(userClient, expectedRole, { allowTrainer = false } = {}) {
  const { data, error } = await userClient.rpc('get_my_access_status');
  if (error || !data) throw new HttpError(403, 'Account details are not available.');
  if (data.role !== expectedRole) throw new HttpError(403, `A ${expectedRole} account is required.`);
  if (expectedRole === 'coach' && allowTrainer && data.access_state === 'trainer') return data;
  if (expectedRole === 'coach' && !['trialing', 'active'].includes(data.access_state)) {
    throw new HttpError(402, 'An active coach plan is required.');
  }
  return data;
}
