import { requireSupabase } from './supabaseClient.js';

const SIGNUP_ROLE_KEY = 'apexfit.signup-role';

export async function signInWithGoogle(role) {
  if (role && role !== 'coach' && role !== 'client') {
    throw new TypeError('Choose whether to sign in as a coach or client.');
  }

  const client = requireSupabase();
  // Without a role this is a login; the server rejects it unless the account already exists.
  if (role) window.sessionStorage.setItem(SIGNUP_ROLE_KEY, role);
  else window.sessionStorage.removeItem(SIGNUP_ROLE_KEY);
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });

  if (error) {
    window.sessionStorage.removeItem(SIGNUP_ROLE_KEY);
    throw error;
  }
}

export async function provisionMyProfile() {
  const client = requireSupabase();
  const role = window.sessionStorage.getItem(SIGNUP_ROLE_KEY);
  const { data, error } = await client.rpc('provision_my_profile', { p_role: role });
  if (error) throw error;
  window.sessionStorage.removeItem(SIGNUP_ROLE_KEY);
  return data;
}

export async function getMyAccessStatus() {
  const client = requireSupabase();
  const { data, error } = await client.rpc('get_my_access_status');
  if (error) throw error;
  return data;
}

export async function updateMyLocale(locale) {
  const client = requireSupabase();
  const { error } = await client.rpc('update_my_locale', { p_locale: locale });
  if (error) throw error;
}

export async function signOut() {
  const client = requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

export async function signInWithPassword(email, password) {
  const client = requireSupabase();
  window.sessionStorage.removeItem(SIGNUP_ROLE_KEY);
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
}

// Returns true when the account is signed in immediately, false when the email must be confirmed first.
export async function signUpWithPassword({ email, password, fullName, role }) {
  if (role !== 'coach' && role !== 'client') {
    throw new TypeError('Choose whether to sign up as a coach or client.');
  }
  const client = requireSupabase();
  window.sessionStorage.setItem(SIGNUP_ROLE_KEY, role);
  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: `${window.location.origin}/login`,
      data: { full_name: fullName.trim(), signup_role: role },
    },
  });
  if (error) {
    window.sessionStorage.removeItem(SIGNUP_ROLE_KEY);
    throw error;
  }
  return Boolean(data.session);
}
