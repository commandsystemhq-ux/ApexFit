import { Suspense, lazy, useEffect, useState } from 'react';
import AppShell from './components/AppShell.jsx';
import Toast from './components/Toast.jsx';
import CoachSignInPage from './pages/CoachSignInPage.jsx';
import LandingPage from './pages/LandingPage.jsx';
import TrialExpiredPage from './pages/TrialExpiredPage.jsx';
import { getMyAccessStatus, provisionMyProfile, signInWithGoogle, signOut, updateMyLocale } from './services/authService.js';
import { useLocale } from './contexts/LocaleContext.jsx';
import { supabase } from './services/supabaseClient.js';

const BillingPage = lazy(() => import('./pages/BillingPage.jsx'));
const ClientPortalPage = lazy(() => import('./pages/ClientPortalPage.jsx'));
const ClientsPage = lazy(() => import('./pages/ClientsPage.jsx'));
const CoachHubPage = lazy(() => import('./pages/CoachHubPage.jsx'));
const CommunityPage = lazy(() => import('./pages/CommunityPage.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const ExerciseLibraryPage = lazy(() => import('./pages/ExerciseLibraryPage.jsx'));
const GeneratorPage = lazy(() => import('./pages/GeneratorPage.jsx'));
const InvoicingPage = lazy(() => import('./pages/InvoicingPage.jsx'));
const MessagesPage = lazy(() => import('./pages/MessagesPage.jsx'));
const ProgramTemplatesPage = lazy(() => import('./pages/ProgramTemplatesPage.jsx'));
const SchedulePage = lazy(() => import('./pages/SchedulePage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const WorkoutBuilderPage = lazy(() => import('./pages/WorkoutBuilderPage.jsx'));

const pageTitleKeys = {
  dashboard: 'dashboard',
  generator: 'generator',
  exerciseLibrary: 'exerciseLibrary',
  workoutBuilder: 'workoutBuilder',
  programTemplates: 'programTemplates',
  clients: 'clients',
  schedule: 'schedule',
  invoicing: 'invoicing',
  coachHub: 'coachHub',
  community: 'community',
  messages: 'messages',
  portal: 'portal',
  billing: 'billing',
  settings: 'settings',
};

export default function App() {
  const [page, setPage] = useState(() => window.location.hash.slice(1) || 'home');
  const [toast, setToast] = useState('');
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const { locale, setLocale, t } = useLocale();

  useEffect(() => {
    const handleHashChange = () => {
      const nextPage = window.location.hash.slice(1) || 'home';
      setPage(nextPage === 'home' || pageTitleKeys[nextPage] ? nextPage : 'home');
    };

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    let provisioningUserId = null;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user || null;
      setUser(currentUser);
      if (!currentUser) {
        provisioningUserId = null;
        setProfile(null);
        return;
      }
      if (provisioningUserId === currentUser.id) return;
      provisioningUserId = currentUser.id;
      setProfile(null);
      window.setTimeout(async () => {
        try {
          const account = await provisionMyProfile();
          if (!active) return;
          if (window.localStorage.getItem('apexfit.locale') === null && account.locale) {
            setLocale(account.locale);
          }
          setProfile(account);
        } catch (error) {
          if (active) {
            provisioningUserId = null;
            setProfile(null);
            showToast(error.message || t('noAccount'));
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

  function navigate(nextPage) {
    window.location.hash = nextPage;
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSignIn(role = 'coach') {
    try {
      await signInWithGoogle(role);
    } catch (error) {
      setToast(error.message.startsWith('Supabase is not configured') ? t('notConfigured') : error.message);
    }
  }

  async function handleSignOut() {
    try {
      await signOut();
    } catch (error) {
      setToast(error.message);
    }
  }

  const showToast = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3500);
  };

  const restrictedByTrial = profile?.role === 'coach'
    && profile.access_state === 'expired'
    && !['billing', 'settings'].includes(page);
  const restrictedByRole = profile?.role === 'client'
    && !['portal', 'coachHub', 'community', 'settings'].includes(page);
  const requiresCoachAccess = ['dashboard', 'generator', 'exerciseLibrary', 'workoutBuilder', 'programTemplates', 'clients', 'schedule', 'invoicing', 'messages', 'billing'].includes(page)
    && profile?.role !== 'coach';

  let content;
  if (page === 'home') {
    content = <LandingPage onNavigate={navigate} onSignIn={handleSignIn} />;
  } else if (requiresCoachAccess && !user) {
    content = <CoachSignInPage user={user} profile={profile} onSignIn={handleSignIn} />;
  } else if (requiresCoachAccess && !profile) {
    content = <CoachSignInPage user={user} profile={profile} onSignIn={handleSignIn} />;
  } else if (restrictedByTrial) {
    content = <TrialExpiredPage onNavigate={navigate} />;
  } else if (restrictedByRole) {
    content = <p className="notice notice-info">{t('accessRequired')}</p>;
  } else {
    switch (page) {
      case 'dashboard':
        content = <DashboardPage onNavigate={navigate} />;
        break;
      case 'generator':
        content = <GeneratorPage onNotify={showToast} />;
        break;
      case 'exerciseLibrary':
        content = <ExerciseLibraryPage />;
        break;
      case 'workoutBuilder':
        content = <WorkoutBuilderPage onNotify={showToast} />;
        break;
      case 'programTemplates':
        content = <ProgramTemplatesPage onNavigate={navigate} onNotify={showToast} />;
        break;
      case 'messages':
        content = <MessagesPage onNavigate={navigate} />;
        break;
      case 'clients':
        content = <ClientsPage onNavigate={navigate} onNotify={showToast} />;
        break;
      case 'schedule':
        content = <SchedulePage onNavigate={navigate} onNotify={showToast} />;
        break;
      case 'invoicing':
        content = <InvoicingPage onNavigate={navigate} onNotify={showToast} />;
        break;
      case 'community':
        content = <CommunityPage user={user} profile={profile} onSignIn={handleSignIn} onNavigate={navigate} />;
        break;
      case 'coachHub':
        content = <CoachHubPage user={user} profile={profile} onSignIn={handleSignIn} />;
        break;
      case 'portal':
        content = <ClientPortalPage user={user} profile={profile} onSignIn={handleSignIn} />;
        break;
      case 'billing':
        content = <BillingPage profile={profile} onNotify={showToast} />;
        break;
      case 'settings':
        content = <SettingsPage user={user} profile={profile} onSignOut={handleSignOut} />;
        break;
      default:
        content = <LandingPage onNavigate={navigate} onSignIn={handleSignIn} />;
    }
  }

  return (
    <>
      {page === 'home' ? content : (
        <AppShell page={page} title={t(pageTitleKeys[page] || 'dashboard')} onNavigate={navigate} onSignIn={handleSignIn} onSignOut={handleSignOut} user={user} profile={profile}>
          <Suspense fallback={<div className="empty-state" role="status">{t('loadingProgress')}</div>}>{content}</Suspense>
        </AppShell>
      )}
      <Toast message={toast} />
    </>
  );
}
