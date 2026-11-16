import { Navigate, Outlet, useLocation } from 'react-router-dom';
import BrandMark from './BrandMark.jsx';
import Button from './Button.jsx';
import TrialExpiredPage from '../pages/TrialExpiredPage.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { AUTH_PATHS, PAGES, homePathFor, roleOf, safeRedirectPath } from '../routes.js';

export function FullPageLoader() {
  const { t } = useLocale();
  return (
    <div className="route-loader" role="status" aria-live="polite">
      <BrandMark />
      <span>{t('accountLoading')}</span>
    </div>
  );
}

function AccountError({ message }) {
  const { t } = useLocale();
  const { signOut } = useAuth();
  return (
    <div className="route-loader">
      <BrandMark />
      <p className="notice notice-error" role="alert">{message || t('noAccount')}</p>
      <Button variant="secondary" onClick={signOut}>{t('signOut')}</Button>
    </div>
  );
}

// Everything behind the login: waits for the session, then redirects guests to /login.
export function RequireAuth() {
  const { user, profile, profileError, authReady } = useAuth();
  const location = useLocation();

  if (!authReady) return <FullPageLoader />;
  if (!user) return <Navigate to={AUTH_PATHS.login} replace state={{ from: location }} />;
  if (profileError) return <AccountError message={profileError} />;
  if (!profile) return <FullPageLoader />;
  return <Outlet />;
}

// /login and /signup: signed-in users go straight to where they were headed or their home page.
export function PublicOnly() {
  const { user, profile, profileError, authReady } = useAuth();
  const location = useLocation();

  if (!authReady) return <FullPageLoader />;
  if (user && profileError) return <AccountError message={profileError} />;
  if (user && !profile) return <FullPageLoader />;
  if (user && profile) {
    return <Navigate to={safeRedirectPath(location.state?.from) || homePathFor(roleOf(profile))} replace />;
  }
  return <Outlet />;
}

// Coaches whose trial ended can only reach billing (and settings, which is outside this guard).
export function TrialGate() {
  const { profile } = useAuth();
  const location = useLocation();
  if (roleOf(profile) === 'trainer') return <Navigate to={homePathFor('trainer')} replace />;
  const trialExpired = profile.role === 'coach'
    && profile.access_state === 'expired'
    && location.pathname !== PAGES.billing.path;
  return trialExpired ? <TrialExpiredPage /> : <Outlet />;
}

export function CoachOnly() {
  const { profile } = useAuth();
  const role = roleOf(profile);
  if (role !== 'coach') return <Navigate to={homePathFor(role)} replace />;
  return <TrialGate />;
}

// The assistant trainer workspace: only accounts with an active team membership.
export function TrainerOnly() {
  const { profile } = useAuth();
  const role = roleOf(profile);
  if (role !== 'trainer') return <Navigate to={homePathFor(role)} replace />;
  return <Outlet />;
}

export function ClientOnly() {
  const { profile } = useAuth();
  if (profile.role !== 'client') return <Navigate to={homePathFor(roleOf(profile))} replace />;
  return <Outlet />;
}

// The landing page is public, but signed-in users are sent to their workspace.
export function LandingGate({ children }) {
  const { user, profile } = useAuth();
  if (user && profile) return <Navigate to={homePathFor(roleOf(profile))} replace />;
  return children;
}
