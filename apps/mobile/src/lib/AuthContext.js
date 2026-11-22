import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase, requireSupabase } from './supabase.js';

WebBrowser.maybeCompleteAuthSession();

const AuthContext = createContext(null);

// apexfit://auth/callback in a built app, exp://… in Expo Go. Both must be in Supabase > Authentication > URL
// Configuration > Redirect URLs.
export const redirectUrl = () => Linking.createURL('auth/callback');

// Reads the code (PKCE) or the tokens (implicit) that the sign-in page put in the returned address.
export function parseAuthUrl(url) {
  const parsed = Linking.parse(url);
  const hash = url.includes('#') ? Object.fromEntries(new URLSearchParams(url.split('#')[1])) : {};
  return {
    code: parsed.queryParams?.code || null,
    accessToken: hash.access_token || null,
    refreshToken: hash.refresh_token || null,
    error: parsed.queryParams?.error_description || hash.error_description || null,
  };
}

export async function completeFromUrl(client, url) {
  const { code, accessToken, refreshToken, error } = parseAuthUrl(url);
  if (error) throw new Error(error);
  if (code) {
    const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
    if (exchangeError) throw exchangeError;
  } else if (accessToken && refreshToken) {
    const { error: sessionError } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (sessionError) throw sessionError;
  } else {
    throw new Error('No sign-in information was returned.');
  }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(Boolean(supabase));

  const loadProfile = useCallback(async (role = null) => {
    const client = requireSupabase();
    let { data, error } = await client.rpc('get_my_access_status');
    if (error || !data?.role) {
      // A first sign-in has no profile yet: the database creates it, with the role chosen at sign-up.
      ({ data, error } = await client.rpc('provision_my_profile', { p_role: role }));
    }
    if (error) throw error;
    setProfile(data);
    return data;
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) await loadProfile().catch(() => setProfile(null));
      if (active) setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setProfile(null);
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, [loadProfile]);

  // A deep link that comes back while the app is running (some Android browsers) finishes the sign-in too.
  useEffect(() => {
    if (!supabase) return undefined;
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (url.includes('auth/callback')) completeFromUrl(supabase, url).then(() => loadProfile()).catch(() => null);
    });
    return () => subscription.remove();
  }, [loadProfile]);

  const signInWithPassword = useCallback(async (email, password) => {
    const { error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    await loadProfile();
  }, [loadProfile]);

  // Returns true when signed in at once, false when the email must be confirmed first.
  const signUpWithPassword = useCallback(async ({ email, password, fullName, role }) => {
    if (role !== 'coach' && role !== 'client') throw new TypeError('Choose coach or client.');
    const { data, error } = await requireSupabase().auth.signUp({
      email: email.trim(),
      password,
      options: { data: { full_name: fullName.trim(), signup_role: role }, emailRedirectTo: redirectUrl() },
    });
    if (error) throw error;
    if (!data.session) return false;
    await loadProfile(role);
    return true;
  }, [loadProfile]);

  const signInWithGoogle = useCallback(async (role = null) => {
    const client = requireSupabase();
    const redirectTo = redirectUrl();
    const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } });
    if (error) throw error;
    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type !== 'success') throw new Error('cancelled');
    await completeFromUrl(client, result.url);
    await loadProfile(role);
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await requireSupabase().auth.signOut();
    setProfile(null);
  }, []);

  const value = useMemo(() => ({
    session, profile, loading, userId: session?.user?.id || null, role: profile?.role || null,
    signInWithPassword, signUpWithPassword, signInWithGoogle, signOut,
  }), [session, profile, loading, signInWithPassword, signUpWithPassword, signInWithGoogle, signOut]);

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider.');
  return value;
}