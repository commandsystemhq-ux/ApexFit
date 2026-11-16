import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { LIVE_PROVIDER, roomAccess, roomPath } from '../services/liveRoom.js';
import { getMyVideoSessions } from '../services/sessionService.js';
import { countdownParts, formatCountdown, isValidMeetingUrl, providerLabelKey, sessionPhase, splitSessions } from '../services/sessionUtils.js';

function SessionCard({ session, now }) {
  const { t, locale } = useLocale();
  const phase = sessionPhase(session, now);
  const isLive = session.provider === LIVE_PROVIDER;
  const roomOpen = isLive && roomAccess(session, 'client', now) === 'open';
  const joinable = !isLive && ['upcoming', 'soon', 'live'].includes(phase) && isValidMeetingUrl(session.meeting_url);

  return (
    <article className={`panel session-card ${phase === 'live' ? 'is-live' : ''} ${['cancelled', 'ended'].includes(phase) ? 'is-archived' : ''}`}>
      <div className="template-card-heading">
        <h3 dir="auto">{session.title}</h3>
        <div className="contract-badges">
          {phase === 'live' && <span className="soft-badge badge-green">{t('vsLiveNow')}</span>}
          {phase === 'soon' && <span className="soft-badge badge-amber">{t('vsPhase_soon')}</span>}
          {session.group_name && <span className="soft-badge badge-blue">{t('vsGroupSession')}: {session.group_name}</span>}
          <span className={`soft-badge ${isLive ? 'badge-cyan' : 'badge-muted'}`}>{isLive ? t('vsInAppBadge') : t(providerLabelKey(session.provider))}</span>
          {['completed', 'cancelled'].includes(session.status) && <span className="soft-badge badge-muted">{t(`vsStatus_${session.status}`)}</span>}
          {phase === 'ended' && <span className="soft-badge badge-muted">{t('vsEnded')}</span>}
        </div>
      </div>
      <div className="template-meta">
        {session.coach_name && <span dir="auto">{t('vsWith')} {session.coach_name}</span>}
        <time dateTime={session.scheduled_at}>{new Date(session.scheduled_at).toLocaleString(locale)}</time>
        <span>{session.duration_minutes} {t('vsMinutes')}</span>
      </div>
      {session.description && <p className="muted-copy" dir="auto">{session.description}</p>}

      {['upcoming', 'soon'].includes(phase) && (
        <div className="session-countdown" role="timer" aria-live="off">
          <span>{t('vsStartsIn')}</span>
          <strong dir="ltr">{formatCountdown(countdownParts(session.scheduled_at, now))}</strong>
        </div>
      )}
      {isLive && ['upcoming', 'soon', 'live'].includes(phase) && (
        <div className="template-actions">
          {roomOpen
            ? <Link className="button button-primary" to={roomPath(session.id)}>{t('vsJoinLive')}</Link>
            : <small className="muted-copy">{t('vsJoinLiveOpens')}</small>}
        </div>
      )}
      {session.meeting_passcode && joinable && <small className="muted-copy" dir="ltr">{t('vsPasscode')}: <code>{session.meeting_passcode}</code></small>}
      {joinable && (
        <div className="template-actions">
          <a className={`button ${phase === 'upcoming' ? 'button-secondary' : 'button-primary'}`} href={session.meeting_url} target="_blank" rel="noopener noreferrer">{t('vsJoin')}</a>
        </div>
      )}
    </article>
  );
}

export default function MySessionsPage() {
  const { t } = useLocale();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let active = true;
    getMyVideoSessions()
      .then((rows) => {
        if (active) setSessions(rows);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  // One timer drives every countdown on the page.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { upcoming, past } = splitSessions(sessions, now);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('vsMyTitle')} description={t('vsMyDescription')} />
      {error && <div className="notice notice-error" role="alert">{t('vsMyLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && upcoming.length === 0 && (
        <section className="panel"><div className="dashboard-empty"><h3>{t('vsMyEmpty')}</h3><p>{t('vsMyEmptyHelp')}</p></div></section>
      )}
      {upcoming.length > 0 && <h3 className="contract-section-title">{t('vsUpcoming')}</h3>}
      <div className="contract-list">{upcoming.map((session) => <SessionCard key={session.id} session={session} now={now} />)}</div>
      {past.length > 0 && <h3 className="contract-section-title">{t('vsPast')}</h3>}
      <div className="contract-list">{past.slice(0, 20).map((session) => <SessionCard key={session.id} session={session} now={now} />)}</div>
    </>
  );
}
