import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, isConfigured } from './config.js';
import { createChunkedStorage } from './secureStorage.js';

// The same Supabase project as the web app. The session lives in the device's secure storage; row-level security and
// the database functions decide what each person can read or change, exactly as on the web.
export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: createChunkedStorage(SecureStore),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  })
  : null;

export function requireSupabase() {
  if (!supabase) throw new Error('The app is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.');
  return supabase;
}