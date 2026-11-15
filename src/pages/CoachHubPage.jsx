import { useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import ClientBilling from '../components/ClientBilling.jsx';
import ClientCoachLink from '../components/ClientCoachLink.jsx';
import ClientInbox from '../components/ClientInbox.jsx';
import ClientSessions from '../components/ClientSessions.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyCoaches } from '../services/coachClientService.js';

const SECTIONS = [
  { id: 'inbox', label: 'inboxTab', icon: '✉' },
  { id: 'sessions', label: 'sessionsTab', icon: '◷' },
  { id: 'billing', label: 'billingTab', icon: '◈' },
  { id: 'coach', label: 'coachTab', icon: '☺' },
];

export default function CoachHubPage({ user, profile, onSignIn }) {
  const { t } = useLocale();
  const hasCheckoutResult = new URLSearchParams(window.location.search).has('checkout');
  const [active, setActive] = useState(hasCheckoutResult ? 'billing' : 'inbox');
  const [linked, setLinked] = useState(null);
  const isClient = profile?.role === 'client';

  useEffect(() => {
    if (!isClient) return undefined;
    let cancelled = false;
    listMyCoaches()
      .then((rows) => {
        if (cancelled) return;
        setLinked(rows.length > 0);
        if (rows.length === 0) setActive('coach');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isClient, user?.id]);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('coachHub')} description={t('coachHubDescription')} />
      {!user && (
        <section className="panel client-portal-gate">
          <div className="dashboard-empty">
            <h3>{t('portalSignIn')}</h3>
            <Button variant="primary" onClick={() => onSignIn('client')}>{t('clientSignIn')}</Button>
          </div>
        </section>
      )}
      {user && !profile && <div className="notice notice-info" role="status">{t('accountLoading')}</div>}
      {user && profile && !isClient && <div className="notice notice-info" role="status">{t('clientAccountRequired')}</div>}
      {isClient && (
        <>
          {linked === false && <div className="notice notice-info" role="status">{t('noCoachYet')}</div>}
          <nav className="client-feature-tabs" aria-label={t('coachHub')}>
            {SECTIONS.map(({ id, label, icon }) => (
              <button key={id} className={`client-feature-tab ${active === id ? 'is-active' : ''}`} type="button" aria-pressed={active === id} onClick={() => setActive(id)}>
                <span aria-hidden="true">{icon}</span>{t(label)}
              </button>
            ))}
          </nav>
          {active === 'inbox' && <ClientInbox />}
          {active === 'sessions' && <ClientSessions />}
          {active === 'billing' && <ClientBilling clientId={user.id} />}
          {active === 'coach' && <ClientCoachLink onLinked={() => setLinked(true)} />}
        </>
      )}
    </>
  );
}
