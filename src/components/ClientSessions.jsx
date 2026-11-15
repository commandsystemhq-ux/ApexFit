import { useEffect, useState } from 'react';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { isUpcoming, totalCreditsRemaining } from '../services/coachingUtils.js';
import { listCredits } from '../services/invoicingService.js';
import { listSessions } from '../services/scheduleService.js';

export default function ClientSessions() {
  const { locale, t } = useLocale();
  const [sessions, setSessions] = useState([]);
  const [credits, setCredits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([listSessions(), listCredits()])
      .then(([sessionRows, creditRows]) => {
        if (!active) return;
        setSessions(sessionRows);
        setCredits(creditRows);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const upcoming = sessions.filter((session) => isUpcoming(session)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = sessions.filter((session) => !isUpcoming(session)).slice(0, 15);
  const remaining = totalCreditsRemaining(credits);

  function renderSession(session) {
    const start = new Date(session.starts_at);
    const end = new Date(session.ends_at);
    return (
      <article className="session-row" key={session.id}>
        <div className="session-row-main">
          <strong>{session.title}</strong>
          <small>{start.toLocaleDateString(locale)} · {start.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} – {end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}{session.location ? ` · ${session.location}` : ''}</small>
          {session.notes && <small>{session.notes}</small>}
        </div>
        <span className={`soft-badge session-${session.status}`}>{t(`session_${session.status}`)}</span>
      </article>
    );
  }

  return (
    <div className="client-progress-layout">
      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('sessionsTab')}</span><h3>{t('upcomingSessions')}</h3></div></div>
        {error && <div className="notice notice-error" role="alert">{t('scheduleLoadError')} {error}</div>}
        {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!loading && !error && upcoming.length === 0 && <div className="empty-state">{t('noUpcomingSessions')}</div>}
        <div className="session-list">{upcoming.map(renderSession)}</div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('sessionsTab')}</span><h3>{t('packageCredits')}</h3></div></div>
        <dl className="strength-stats">
          <div><dt>{t('sessionsRemaining')}</dt><dd>{remaining}</dd></div>
        </dl>
        {credits.map((credit) => (
          <article className="package-card" key={credit.id}>
            <div><strong>{credit.package_name}</strong><small>{credit.sessions_remaining} / {credit.sessions_total} {t('sessionsRemainingShort')}</small></div>
          </article>
        ))}
        {!loading && credits.length === 0 && <div className="empty-state">{t('noCredits')}</div>}
        {past.length > 0 && (
          <>
            <h4 className="subheading">{t('pastSessions')}</h4>
            <div className="session-list">{past.map(renderSession)}</div>
          </>
        )}
      </section>
    </div>
  );
}
