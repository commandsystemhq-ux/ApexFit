import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && publishableKey ? createClient(url, publishableKey) : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase is not configured. Add the project URL and publishable key to .env.local.');
  }
  return supabase;
}
