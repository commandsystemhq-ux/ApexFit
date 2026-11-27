import { useEffect, useState } from 'react';
import ClientBilling from '../components/ClientBilling.jsx';
import ClientCoachLink from '../components/ClientCoachLink.jsx';
import ChatWorkspace from '../components/ChatWorkspace.jsx';
import ClientSessions from '../components/ClientSessions.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyCoaches } from '../services/coachClientService.js';

const SECTIONS = [
  { id: 'inbox', label: 'chatTab', icon: '✉' },
  { id: 'sessions', label: 'sessionsTab', icon: '◷' },
  { id: 'billing', label: 'billingTab', icon: '◈' },
  { id: 'coach', label: 'coachTab', icon: '☺' },
];

export default function CoachHubPage() {
  const { t } = useLocale();
  const { user, profile } = useAuth();
  const query = new URLSearchParams(window.location.search);
  const requestedTab = query.get('tab');
  const openBilling = query.has('checkout') || requestedTab === 'billing';
  const [active, setActive] = useState(openBilling ? 'billing' : SECTIONS.some((item) => item.id === requestedTab) ? requestedTab : 'inbox');
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
          {active === 'inbox' && linked !== false && <ChatWorkspace />}
          {active === 'sessions' && <ClientSessions />}
          {active === 'billing' && <ClientBilling clientId={user.id} />}
          {active === 'coach' && <ClientCoachLink onLinked={() => setLinked(true)} />}
        </>
      )}
    </>
  );
}
