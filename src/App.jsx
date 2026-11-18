import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import { ClientOnly, CoachOnly, FullPageLoader, LandingGate, PublicOnly, RequireAuth, TrainerOnly, TrialGate } from './components/RouteGuards.jsx';
import PublicStorePage from './pages/PublicStorePage.jsx';
import LandingPage from './pages/LandingPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SignupPage from './pages/SignupPage.jsx';
import { useAuth } from './contexts/AuthContext.jsx';
import { useToast } from './contexts/ToastContext.jsx';
import { ADMIN_PATHS, AUTH_PATHS, PAGES, legacyHashPath, pathFor } from './routes.js';

const BillingPage = lazy(() => import('./pages/BillingPage.jsx'));
const WorkflowsPage = lazy(() => import('./pages/WorkflowsPage.jsx'));
const GroupsPage = lazy(() => import('./pages/GroupsPage.jsx'));
const StorePage = lazy(() => import('./pages/StorePage.jsx'));
const MyStorePage = lazy(() => import('./pages/MyStorePage.jsx'));
const TeamPage = lazy(() => import('./pages/TeamPage.jsx'));
const TeamClientsPage = lazy(() => import('./pages/TeamClientsPage.jsx'));
const SessionsPage = lazy(() => import('./pages/SessionsPage.jsx'));
const LiveRoomPage = lazy(() => import('./pages/LiveRoomPage.jsx'));
const MySessionsPage = lazy(() => import('./pages/MySessionsPage.jsx'));
const IntegrationsPage = lazy(() => import('./pages/IntegrationsPage.jsx'));
const ContractsPage = lazy(() => import('./pages/ContractsPage.jsx'));
const AssessmentPage = lazy(() => import('./pages/AssessmentPage.jsx'));
const ClientContractsPage = lazy(() => import('./pages/ClientContractsPage.jsx'));
const ClientGroupsPage = lazy(() => import('./pages/ClientGroupsPage.jsx'));
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
const AdminAiPage = lazy(() => import('./pages/AdminAiPage.jsx'));
const ChecklistPage = lazy(() => import('./pages/ChecklistPage.jsx'));
const WorkoutBuilderPage = lazy(() => import('./pages/WorkoutBuilderPage.jsx'));

// Old bookmarks and notifications used hash URLs such as /#coachHub.
function LegacyHashRedirect() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const target = legacyHashPath(hash);
    if (target) navigate(target, { replace: true });
  }, [hash]);
  return null;
}

export default function App() {
  const navigate = useNavigate();
  const showToast = useToast();
  const { profile } = useAuth();
  const go = (idOrPath) => navigate(pathFor(idOrPath));

  return (
    <>
      <LegacyHashRedirect />
      <Routes>
        <Route path={AUTH_PATHS.home} element={<LandingGate><LandingPage /></LandingGate>} />

        <Route path="/shop/:coachId" element={<PublicStorePage />} />

        <Route element={<PublicOnly />}>
          <Route path={AUTH_PATHS.login} element={<LoginPage />} />
          <Route path={AUTH_PATHS.signup} element={<SignupPage />} />
        </Route>

        <Route element={<RequireAuth />}>
          <Route path="/sessions/:sessionId/room" element={<Suspense fallback={<FullPageLoader />}><LiveRoomPage /></Suspense>} />
          <Route element={<AppShell />}>
            <Route element={<CoachOnly />}>
              <Route path={PAGES.dashboard.path} element={<DashboardPage onNavigate={go} />} />
              <Route path={PAGES.generator.path} element={<GeneratorPage onNotify={showToast} />} />
              <Route path={PAGES.exerciseLibrary.path} element={<ExerciseLibraryPage />} />
              <Route path={PAGES.workoutBuilder.path} element={<WorkoutBuilderPage onNotify={showToast} />} />
              <Route path={PAGES.programTemplates.path} element={<ProgramTemplatesPage onNavigate={go} onNotify={showToast} />} />
              <Route path={PAGES.messages.path} element={<MessagesPage onNavigate={go} />} />
              <Route path={PAGES.workflows.path} element={<WorkflowsPage onNotify={showToast} />} />
              <Route path={PAGES.groups.path} element={<GroupsPage />} />
              <Route path={PAGES.team.path} element={<TeamPage />} />
              <Route path={PAGES.store.path} element={<StorePage />} />
              <Route path={PAGES.sessions.path} element={<SessionsPage />} />
              <Route path={PAGES.contracts.path} element={<ContractsPage />} />
              <Route path={PAGES.clients.path} element={<ClientsPage onNavigate={go} onNotify={showToast} />} />
              <Route path={PAGES.schedule.path} element={<SchedulePage onNavigate={go} onNotify={showToast} />} />
              <Route path={PAGES.invoicing.path} element={<InvoicingPage onNavigate={go} onNotify={showToast} />} />
              <Route path={PAGES.billing.path} element={<BillingPage profile={profile} onNotify={showToast} />} />
            </Route>

            <Route element={<ClientOnly />}>
              <Route path="/portal" element={<Navigate to={PAGES.workouts.path} replace />} />
              {['workouts', 'progress', 'strength', 'food', 'habits', 'intake'].map((section) => (
                <Route key={section} path={PAGES[section].path} element={<ClientPortalPage section={section} />} />
              ))}
              <Route path={PAGES.coachHub.path} element={<CoachHubPage />} />
              <Route path={PAGES.integrations.path} element={<IntegrationsPage />} />
<Route path={PAGES.checklist.path} element={<ChecklistPage />} />
              <Route path={PAGES.assessments.path} element={<AssessmentPage />} />
              <Route path={PAGES.myStore.path} element={<MyStorePage />} />
              <Route path={PAGES.mySessions.path} element={<MySessionsPage />} />
              <Route path={PAGES.myContracts.path} element={<ClientContractsPage />} />
              <Route path={PAGES.myGroups.path} element={<ClientGroupsPage />} />
            </Route>

            <Route element={<TrainerOnly />}>
              <Route path={PAGES.teamClients.path} element={<TeamClientsPage />} />
            </Route>

            <Route element={<TrialGate />}>
              <Route path={PAGES.community.path} element={<CommunityPage view="feed" />} />
              <Route path={PAGES.leaderboard.path} element={<CommunityPage view="leaderboard" />} />
            </Route>

            <Route path={PAGES.settings.path} element={<SettingsPage />} />
<Route path={ADMIN_PATHS.ai} element={<AdminAiPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to={AUTH_PATHS.home} replace />} />
      </Routes>
    </>
  );
}
