import { useState } from 'react';
import Button from '../components/Button.jsx';
import ClientHabitTracker from '../components/ClientHabitTracker.jsx';
import ClientProgressTracking from '../components/ClientProgressTracking.jsx';
import ClientWorkoutLogger from '../components/ClientWorkoutLogger.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';

const clientSections = [
  { id: 'workout', label: 'workoutLog', icon: '↕' },
  { id: 'progress', label: 'progressTracking', icon: '⌁' },
  { id: 'habits', label: 'habitTracker', icon: '✓' },
];

export default function ClientPortalPage({ user, profile, onSignIn }) {
  const { t } = useLocale();
  const [activeSection, setActiveSection] = useState('workout');

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
                onClick={() => setActiveSection(id)}
              >
                <span aria-hidden="true">{icon}</span>{t(label)}
              </button>
            ))}
          </nav>
          <section hidden={activeSection !== 'workout'} aria-label={t('workoutLog')}>
            <ClientWorkoutLogger />
          </section>
          <section hidden={activeSection !== 'progress'} aria-label={t('progressTracking')}>
            <ClientProgressTracking clientId={user.id} />
          </section>
          <section hidden={activeSection !== 'habits'} aria-label={t('habitTracker')}>
            <ClientHabitTracker />
          </section>
        </>
      )}
    </>
  );
}
