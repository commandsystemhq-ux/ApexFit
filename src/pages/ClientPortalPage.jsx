import { useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import ClientFoodLogger from '../components/ClientFoodLogger.jsx';
import ClientHabitTracker from '../components/ClientHabitTracker.jsx';
import ClientIntakeForm from '../components/ClientIntakeForm.jsx';
import ClientOneRepMax from '../components/ClientOneRepMax.jsx';
import ClientProgressTracking from '../components/ClientProgressTracking.jsx';
import ClientWorkoutLogger from '../components/ClientWorkoutLogger.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { getMyIntakeForm } from '../services/clientIntakeService.js';

const clientSections = [
  { id: 'workout', label: 'workoutLog', icon: '↕' },
  { id: 'progress', label: 'progressTracking', icon: '⌁' },
  { id: 'strength', label: 'strengthTab', icon: '▲' },
  { id: 'nutrition', label: 'foodTab', icon: '◔' },
  { id: 'habits', label: 'habitTracker', icon: '✓' },
  { id: 'intake', label: 'intakeTab', icon: '☰' },
];

export default function ClientPortalPage({ user, profile, onSignIn }) {
  const { t } = useLocale();
  const [activeSection, setActiveSection] = useState('workout');
  const [visited, setVisited] = useState(() => new Set(['workout']));
  const [intakeMissing, setIntakeMissing] = useState(false);
  const isClient = profile?.role === 'client';

  useEffect(() => {
    if (!isClient || !user) return undefined;
    let active = true;
    getMyIntakeForm()
      .then((row) => {
        if (!active || row) return;
        setIntakeMissing(true);
        showSection('intake');
      })
      .catch(() => {});
    return () => { active = false; };
  }, [isClient, user?.id]);

  function showSection(id) {
    setActiveSection(id);
    setVisited((current) => (current.has(id) ? current : new Set(current).add(id)));
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('portalTitle')} description={t('clientTrackingDescription')} />
      {!user && (
        <section className="panel client-portal-gate">
          <div className="dashboard-empty">
            <span className="feature-icon" aria-hidden="true">▣</span>
            <h3>{t('portalSignIn')}</h3>
            <Button variant="primary" onClick={() => onSignIn('client')}>{t('clientSignIn')}</Button>
          </div>
        </section>
      )}
      {user && !profile && <div className="notice notice-info" role="status">{t('accountLoading')}</div>}
      {user && profile && profile.role !== 'client' && (
        <div className="notice notice-info" role="status">{t('clientAccountRequired')}</div>
      )}
      {user && profile?.role === 'client' && (
        <>
          <nav className="client-feature-tabs" aria-label={t('portalTitle')}>
            {clientSections.map(({ id, label, icon }) => (
              <button
                key={id}
                className={`client-feature-tab ${activeSection === id ? 'is-active' : ''}`}
                type="button"
                aria-pressed={activeSection === id}
                onClick={() => showSection(id)}
              >
                <span aria-hidden="true">{icon}</span>{t(label)}
              </button>
            ))}
          </nav>
          {intakeMissing && activeSection !== 'intake' && <div className="notice notice-info" role="status">{t('intakeCompleteNotice')}</div>}
          <section hidden={activeSection !== 'workout'} aria-label={t('workoutLog')}>
            {visited.has('workout') && <ClientWorkoutLogger />}
          </section>
          <section hidden={activeSection !== 'progress'} aria-label={t('progressTracking')}>
            {visited.has('progress') && <ClientProgressTracking clientId={user.id} />}
          </section>
          <section hidden={activeSection !== 'strength'} aria-label={t('strengthTab')}>
            {activeSection === 'strength' && <ClientOneRepMax />}
          </section>
          <section hidden={activeSection !== 'nutrition'} aria-label={t('foodTab')}>
            {visited.has('nutrition') && <ClientFoodLogger />}
          </section>
          <section hidden={activeSection !== 'habits'} aria-label={t('habitTracker')}>
            {visited.has('habits') && <ClientHabitTracker />}
          </section>
          <section hidden={activeSection !== 'intake'} aria-label={t('intakeTab')}>
            {visited.has('intake') && <ClientIntakeForm onCompleted={() => setIntakeMissing(false)} />}
          </section>
        </>
      )}
    </>
  );
}
