import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyCoaches, redeemClientInvite } from '../services/coachClientService.js';
import { disablePush, enablePush, getPushState } from '../services/pushService.js';

export default function ClientCoachLink({ onLinked }) {
  const { locale, t } = useLocale();
  const [coaches, setCoaches] = useState([]);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [joining, setJoining] = useState(false);
  const [pushState, setPushState] = useState('loading');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState('');

  async function refresh() {
    try {
      setCoaches(await listMyCoaches());
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    getPushState().then(setPushState).catch(() => setPushState('unsupported'));
  }, []);

  async function handleJoin(event) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setJoining(true);
    try {
      await redeemClientInvite(code);
      setCode('');
      setSuccess(t('joinSuccess'));
      await refresh();
      onLinked?.();
    } catch (joinError) {
      setError(`${t('joinError')} ${joinError.message}`);
    } finally {
      setJoining(false);
    }
  }

  async function togglePush() {
    setPushBusy(true);
    setPushError('');
    try {
      if (pushState === 'subscribed') await disablePush();
      else await enablePush();
      setPushState(await getPushState());
    } catch (toggleError) {
      setPushError(toggleError.message);
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="client-progress-layout">
      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('coachTab')}</span><h3>{t('myCoach')}</h3></div></div>
        {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
        {!loading && coaches.length === 0 && <div className="empty-state">{t('noCoachYet')}</div>}
        {coaches.map((coach) => (
          <article className="package-card" key={coach.coach_id}>
            <div>
              <strong>{coach.coach_name || coach.coach_email || t('coach')}</strong>
              <small>{coach.coach_email} · {t('joinedOn')} {new Date(coach.created_at).toLocaleDateString(locale)}</small>
            </div>
          </article>
        ))}
        <form className="package-form" onSubmit={handleJoin}>
          <label className="form-label">{t('inviteCodeLabel')}
            <input className="field" value={code} maxLength={12} autoCapitalize="characters" onChange={(event) => setCode(event.target.value.toUpperCase())} required />
          </label>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {success && <div className="notice notice-info" role="status">{success}</div>}
          <Button variant="primary" type="submit" disabled={joining || code.length < 12}>{joining ? t('joining') : t('joinCoach')}</Button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('coachTab')}</span><h3>{t('pushTitle')}</h3></div></div>
        <p className="muted-copy">{t('pushHelp')}</p>
        {pushState === 'unsupported' && <div className="notice notice-info" role="status">{t('pushUnsupported')}</div>}
        {pushState === 'denied' && <div className="notice notice-info" role="status">{t('pushDenied')}</div>}
        {pushError && <div className="notice notice-error" role="alert">{t('pushError')} {pushError}</div>}
        {(pushState === 'available' || pushState === 'subscribed') && (
          <Button variant={pushState === 'subscribed' ? 'secondary' : 'primary'} onClick={togglePush} disabled={pushBusy}>
            {t(pushState === 'subscribed' ? 'pushDisable' : 'pushEnable')}
          </Button>
        )}
      </section>
    </div>
  );
}
