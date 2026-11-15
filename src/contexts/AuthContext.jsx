import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocale } from './LocaleContext.jsx';
import { useToast } from './ToastContext.jsx';
import { getMyAccessStatus, provisionMyProfile, signInWithGoogle, signOut as signOutService, updateMyLocale } from '../services/authService.js';
import { supabase } from '../services/supabaseClient.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const { locale, setLocale, t } = useLocale();
  const showToast = useToast();
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState('');
  const [authReady, setAuthReady] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    let provisioningUserId = null;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user || null;
      setUser(currentUser);
      setAuthReady(true);
      if (!currentUser) {
        provisioningUserId = null;
        setProfile(null);
        setProfileError('');
        return;
      }
      if (provisioningUserId === currentUser.id) return;
      provisioningUserId = currentUser.id;
      setProfile(null);
      setProfileError('');
      // Supabase calls must not run inside the auth callback itself.
      window.setTimeout(async () => {
        try {
          const account = await provisionMyProfile();
          if (!active) return;
          if (window.localStorage.getItem('apexfit.locale') === null && account.locale) {
            setLocale(account.locale);
          }
          setProfile(account);
        } catch (error) {
          if (!active) return;
          provisioningUserId = null;
          if (String(error.message).includes('Choose a coach or client')) {
            showToast(t('authNoAccount'));
            supabase.auth.signOut().catch(() => {});
          } else {
            setProfileError(error.message || t('noAccount'));
          }
        }
      }, 0);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale.startsWith('ar') ? 'rtl' : 'ltr';
  }, [locale]);

  useEffect(() => {
    if (!profile || !supabase) return;
    updateMyLocale(locale).catch((error) => {
      showToast(`${t('saveError')} ${error.message}`);
    });
  }, [locale, profile?.id]);

  useEffect(() => {
    if (!profile || profile.role !== 'coach') return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const account = await getMyAccessStatus();
        if (active) setProfile(account);
      } catch (error) {
        if (active) showToast(error.message);
      }
    };
    const trialEnd = new Date(profile.trial_ends_at).getTime();
    const timer = Number.isFinite(trialEnd)
      ? window.setTimeout(refresh, Math.max(0, trialEnd - Date.now()))
      : null;
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [profile?.id, profile?.trial_ends_at, profile?.role]);

  const signOut = useCallback(async () => {
    try {
      await signOutService();
    } catch (error) {
      showToast(error.message);
    }
  }, [showToast]);

  const signInGoogle = useCallback(async (role) => {
    try {
      await signInWithGoogle(role);
    } catch (error) {
      showToast(error.message.startsWith('Supabase is not configured') ? t('notConfigured') : error.message);
    }
  }, [showToast, t]);

  const value = useMemo(
    () => ({ user, profile, setProfile, profileError, authReady, signOut, signInWithGoogle: signInGoogle }),
    [user, profile, profileError, authReady, signOut, signInGoogle],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
