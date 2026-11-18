import { useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel, isUpcoming } from '../services/coachingUtils.js';
import { listSessions, scheduleSession, setSessionStatus } from '../services/scheduleService.js';

const EMPTY_FORM = { clientId: '', title: '', date: '', startTime: '09:00', endTime: '10:00', location: '', notes: '' };

export default function SchedulePage({ onNavigate, onNotify }) {
  const { locale, t } = useLocale();
  const [clients, setClients] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loadError, setLoadError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState('');

  const clientsById = new Map(clients.map((client) => [client.client_id, client]));
  const upcoming = sessions.filter((session) => isUpcoming(session)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = sessions.filter((session) => !isUpcoming(session));

  async function refresh() {
    try {
      const [clientRows, sessionRows] = await Promise.all([listMyClients(), listSessions()]);
      setClients(clientRows.filter((client) => client.status === 'active'));
      setSessions(sessionRows);
      setLoadError('');
    } catch (error) {
      setLoadError(error.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSchedule(event) {
    event.preventDefault();
    setFormError('');
    setBusy('schedule');
    try {
      await scheduleSession(form);
      setForm((current) => ({ ...EMPTY_FORM, clientId: current.clientId }));
      onNotify(t('sessionScheduled'));
      await refresh();
    } catch (error) {
      setFormError(`${t('sessionScheduleError')} ${error.message}`);
    } finally {
      setBusy('');
    }
  }

  async function handleStatus(session, status) {
    setBusy(session.id);
    try {
      const result = await setSessionStatus(session.id, status);
      if (status === 'completed') onNotify(t(result.credit_used ? 'sessionCompletedCredit' : 'sessionCompleted'));
      await refresh();
    } catch (error) {
      onNotify(error.message);
    } finally {
      setBusy('');
    }
  }

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  function renderSession(session) {
    const start = new Date(session.starts_at);
    const end = new Date(session.ends_at);
    return (
      <article className="session-row" key={session.id}>
        <div className="session-row-main">
          <strong>{session.title}</strong>
          <span>{clientLabel(clientsById.get(session.client_id))}</span>
          <small>{start.toLocaleDateString(locale)} · {start.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} – {end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}{session.location ? ` · ${session.location}` : ''}</small>
        </div>
        <span className={`soft-badge session-${session.status}`}>{t(`session_${session.status}`)}</span>
        <div className="session-row-actions">
          {session.status === 'scheduled' && <button className="text-action" type="button" disabled={busy === session.id} onClick={() => handleStatus(session, 'completed')}>{t('markCompleted')}</button>}
          {session.status !== 'canceled' && <button className="text-action" type="button" disabled={busy === session.id} onClick={() => handleStatus(session, 'canceled')}>{t('cancelSession')}</button>}
          {session.status !== 'scheduled' && <button className="text-action" type="button" disabled={busy === session.id} onClick={() => handleStatus(session, 'scheduled')}>{t('reopenSession')}</button>}
        </div>
      </article>
    );
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('schedule')} description={t('scheduleDescription')} />
      {loadError && <div className="notice notice-error" role="alert">{t('scheduleLoadError')} {loadError}</div>}

      <div className="client-feature-grid">
        <section className="panel schedule-form-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('schedule')}</span><h3>{t('newSession')}</h3></div></div>
          {clients.length === 0
            ? <div className="dashboard-empty"><p>{t('messagesNeedClients')}</p><Button variant="secondary" onClick={() => onNavigate('clients')}>{t('inviteClient')}</Button></div>
            : (
              <form className="package-form" onSubmit={handleSchedule}>
                <label className="form-label">{t('clientWord')}
                  <select className="field" value={form.clientId} onChange={(event) => update('clientId', event.target.value)} required>
                    <option value="">{t('chooseClient')}</option>
                    {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
                  </select>
                </label>
                <label className="form-label">{t('sessionTitle')}<input className="field" maxLength={160} value={form.title} onChange={(event) => update('title', event.target.value)} required /></label>
                <div className="form-grid">
                  <label className="form-label">{t('sessionDate')}<input className="field" type="date" value={form.date} onChange={(event) => update('date', event.target.value)} required /></label>
                  <label className="form-label">{t('sessionLocation')}<input className="field" maxLength={200} value={form.location} onChange={(event) => update('location', event.target.value)} /></label>
                  <label className="form-label">{t('sessionStart')}<input className="field" type="time" value={form.startTime} onChange={(event) => update('startTime', event.target.value)} required /></label>
                  <label className="form-label">{t('sessionEnd')}<input className="field" type="time" value={form.endTime} onChange={(event) => update('endTime', event.target.value)} required /></label>
                </div>
                <label className="form-label">{t('notes')}<input className="field" maxLength={1000} value={form.notes} onChange={(event) => update('notes', event.target.value)} /></label>
                {formError && <div className="notice notice-error" role="alert">{formError}</div>}
                <Button variant="primary" type="submit" disabled={busy === 'schedule'}>{t('scheduleSession')}</Button>
              </form>
            )}
        </section>

        <section className="panel session-list-panel">
          <div className="panel-heading"><div><span className="eyebrow">{t('schedule')}</span><h3>{t('upcomingSessions')}</h3></div></div>
          {upcoming.length === 0 && <div className="empty-state">{t('noUpcomingSessions')}</div>}
          <div className="session-list">{upcoming.map(renderSession)}</div>
          {past.length > 0 && (
            <>
              <h4 className="subheading">{t('pastSessions')}</h4>
              <div className="session-list">{past.slice(0, 20).map(renderSession)}</div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
