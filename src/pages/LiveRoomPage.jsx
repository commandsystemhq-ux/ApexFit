import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import BrandMark from '../components/BrandMark.jsx';
import Button from '../components/Button.jsx';
import NativeRoom from '../components/NativeRoom.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { PAGES, roleOf } from '../routes.js';
import { displayNameFor } from '../services/profileUtils.js';
import { roomAccess, sanitizeDisplayName } from '../services/liveRoom.js';
import { getVideoSession } from '../services/sessionService.js';
import { isUuid } from '../services/storeUtils.js';

// Full-screen ApexFit Live room page: the ApexFit bar around the native WebRTC call. Only sessions the database
// lets the signed-in user read are found, and the signaling channel applies the same access rules again.
export default function LiveRoomPage() {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { user, profile } = useAuth();
  const role = roleOf(profile) === 'client' ? 'client' : 'coach';
  const backPath = role === 'client' ? PAGES.mySessions.path : PAGES.sessions.path;
  const [state, setState] = useState({ status: 'loading', session: null, error: '' });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isUuid(sessionId)) {
      setState({ status: 'missing', session: null, error: '' });
      return undefined;
    }
    let active = true;
    getVideoSession(sessionId)
      .then((session) => {
        if (active) setState(session ? { status: 'ready', session, error: '' } : { status: 'missing', session: null, error: '' });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', session: null, error: error.message });
      });
    return () => { active = false; };
  }, [sessionId]);

  // Re-check every so often so a waiting client is let in as soon as the room opens.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const { session } = state;
  const access = session ? roomAccess(session, role, now) : 'unavailable';
  const endCall = () => navigate(backPath, { replace: true });

  let message = null;
  if (state.status === 'loading') message = { title: t('lrLoading') };
  else if (state.status === 'missing') message = { title: t('lrNotFound') };
  else if (state.status === 'error') message = { title: t('lrLoadError'), body: state.error };
  else if (access === 'unavailable') message = { title: t('lrUnavailableTitle'), body: t('lrUnavailableBody') };
  else if (access === 'closed') message = { title: t('lrClosedTitle'), body: t('lrClosedBody') };
  else if (access === 'early') {
    message = { title: t('lrEarlyTitle'), body: `${t('lrEarlyBody')} ${new Date(session.scheduled_at).toLocaleString(locale)}.` };
  }

  return (
    <div className="live-room">
      <header className="live-room-bar">
        <Link className="live-room-brand" to={backPath} aria-label={t('lrBackToSessions')}><BrandMark compact /></Link>
        <div className="live-room-title">
          <span className="eyebrow">{t('lrRoomTitle')}</span>
          <strong dir="auto">{session?.title || t('lrLoading')}</strong>
        </div>
        <Button variant="danger" size="small" className="live-room-end" onClick={endCall}>{t('lrEndCall')}</Button>
      </header>

      {message && (
        <main className="live-room-message" role={state.status === 'loading' ? 'status' : undefined}>
          <h1>{message.title}</h1>
          {message.body && <p>{message.body}</p>}
          {state.status !== 'loading' && <Link className="button button-secondary" to={backPath}>{t('lrBackToSessions')}</Link>}
        </main>
      )}

      {!message && (
        <NativeRoom
          sessionId={session.id}
          userId={user.id}
          name={sanitizeDisplayName(displayNameFor(profile, user))}
          coachId={session.coach_id}
          selfRole={role}
          onEnd={endCall}
        />
      )}
    </div>
  );
}
