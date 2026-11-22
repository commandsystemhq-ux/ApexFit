// Values baked into the app at build time. Only public settings belong here: the Supabase URL and its publishable
// (anon) key, and the address of the web app. Secrets stay on the server and are never read by the app.
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || '').replace(/\/+$/, '');

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);