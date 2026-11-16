import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { listGroups } from '../services/groupService.js';
import { notifyClients } from '../services/pushService.js';
import {
  deleteVideoSession,
  getVideoConfig,
  listVideoSessions,
  scheduleVideoSession,
  setVideoSessionStatus,
  updateVideoSession,
} from '../services/sessionService.js';
import {
  SESSION_LIMITS,
  SESSION_PROVIDERS,
  emptySessionDraft,
  isValidMeetingUrl,
  providerLabelKey,
  sessionPhase,
  toDatetimeLocal,
  validateSessionForm,
} from '../services/sessionUtils.js';

function SessionForm({ initial, clients, groups, zoomConfigured, saving, onSave, onCancel }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const check = validateSessionForm(draft, { zoomConfigured });
  const errors = attempted ? check.errors : {};
  const set = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;
  const canGenerate = draft.provider === 'zoom' && zoomConfigured && !draft.id;

  function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    if (check.valid) onSave(check.payload, { generate: check.generate });
  }

  return (
    <form className="panel session-form" onSubmit={handleSubmit} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('navSessions')}</span><h3>{draft.id ? t('vsEditHeading') : t('vsNewHeading')}</h3></div></div>

      {!draft.id && (
        <div className="range-switch" role="group" aria-label={t('vsAudience')}>
          <button type="button" className={draft.audience === 'client' ? 'is-active' : ''} aria-pressed={draft.audience === 'client'} onClick={() => setDraft((current) => ({ ...current, audience: 'client', groupId: '' }))}>{t('vsAudienceClient')}</button>
          <button type="button" className={draft.audience === 'group' ? 'is-active' : ''} aria-pressed={draft.audience === 'group'} onClick={() => setDraft((current) => ({ ...current, audience: 'group', clientId: '' }))}>{t('vsAudienceGroup')}</button>
        </div>
      )}
      {!draft.id && (
        <label className="form-label">
          <span>{t('vsAudience')}</span>
          {draft.audience === 'client' ? (
            <select className="field" value={draft.clientId} onChange={set('clientId')} aria-invalid={Boolean(errors.audience)}>
              <option value="">{t('vsChooseClient')}</option>
              {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
            </select>
          ) : (
            <select className="field" value={draft.groupId} onChange={set('groupId')} aria-invalid={Boolean(errors.audience)}>
              <option value="">{t('vsChooseGroup')}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
          )}
          {fieldError(errors.audience)}
        </label>
      )}

      <label className="form-label">
        <span>{t('vsFieldTitle')}</span>
        <input className="field" value={draft.title} maxLength={SESSION_LIMITS.title + 20} placeholder={t('vsTitlePlaceholder')} onChange={set('title')} aria-invalid={Boolean(errors.title)} />
        {fieldError(errors.title)}
      </label>
      <label className="form-label">
        <span>{t('vsFieldDescription')}</span>
        <textarea className="field" rows={2} value={draft.description} onChange={set('description')} />
        {fieldError(errors.description)}
      </label>
      <div className="wf-form-grid">
        <label className="form-label">
          <span>{t('vsFieldWhen')}</span>
          <input className="field" type="datetime-local" dir="ltr" value={draft.scheduledAt} onChange={set('scheduledAt')} aria-invalid={Boolean(errors.scheduledAt)} />
          {fieldError(errors.scheduledAt)}
        </label>
        <label className="form-label">
          <span>{t('vsFieldDuration')}</span>
          <input className="field" type="number" min={SESSION_LIMITS.minDuration} max={SESSION_LIMITS.maxDuration} step="5" value={draft.duration} onChange={set('duration')} aria-invalid={Boolean(errors.duration)} />
          {fieldError(errors.duration)}
        </label>
      </div>
      <label className="form-label">
        <span>{t('vsFieldProvider')}</span>
        <select className="field" value={draft.provider} onChange={set('provider')}>
          {SESSION_PROVIDERS.map((provider) => <option key={provider} value={provider}>{t(providerLabelKey(provider))}</option>)}
        </select>
        {fieldError(errors.provider)}
      </label>
      <label className="form-label">
        <span>{t('vsFieldLink')}</span>
        <input className="field" dir="ltr" value={draft.meetingUrl} placeholder={canGenerate ? t('vsAutoLink') : t('vsLinkPlaceholder')} onChange={set('meetingUrl')} aria-invalid={Boolean(errors.meetingUrl)} />
        {draft.provider === 'zoom' && <small className="muted-copy">{canGenerate ? t('vsAutoLinkHelp') : t('vsZoomManual')}</small>}
        {fieldError(errors.meetingUrl)}
      </label>
      <label className="form-label">
        <span>{t('vsFieldPasscode')}</span>
        <input className="field" dir="ltr" value={draft.passcode} maxLength={SESSION_LIMITS.passcode + 10} onChange={set('passcode')} />
        {fieldError(errors.passcode)}
      </label>
      <div className="wf-actions">
        <Button type="submit" variant="primary" disabled={saving}>{draft.id ? (saving ? t('vsSaving') : t('vsSave')) : (saving ? t('vsScheduling') : t('vsSchedule'))}</Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t('vsCancelEdit')}</Button>
      </div>
    </form>
  );
}

export default function SessionsPage() {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const [sessions, setSessions] = useState([]);
  const [clients, setClients] = useState([]);
  const [groups, setGroups] = useState([]);
  const [zoomConfigured, setZoomConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');

  const refresh = useCallback(async () => {
    const [sessionRows, clientRows, groupRows] = await Promise.all([listVideoSessions(), listMyClients(), listGroups()]);
    setSessions(sessionRows);
    setClients(clientRows);
    setGroups(groupRows);
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
    getVideoConfig().then((config) => setZoomConfigured(Boolean(config.zoom))).catch(() => {});
  }, [refresh]);

  const activeClients = useMemo(() => clients.filter((client) => client.status === 'active'), [clients]);
  const names = useMemo(() => ({
    clients: new Map(clients.map((client) => [client.client_id, clientLabel(client)])),
    groups: new Map(groups.map((group) => [group.id, group.name])),
  }), [clients, groups]);

  const now = Date.now();
  const upcoming = sessions.filter((session) => ['upcoming', 'soon', 'live'].includes(sessionPhase(session, now))).sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const past = sessions.filter((session) => !upcoming.includes(session));

  async function handleSave(payload, { generate }) {
    setSaving(true);
    try {
      if (payload.id) {
        await updateVideoSession(payload);
        notifyClients('video', payload.id);
        showToast(t('vsUpdated'));
      } else {
        const result = await scheduleVideoSession(payload, { autoLink: generate });
        showToast(t(result.notified ? 'vsScheduledNotified' : 'vsScheduled'));
      }
      await refresh();
      setDraft(null);
    } catch (saveError) {
      showToast(`${t('vsScheduleError')} ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function run(session, action, successKey) {
    setBusyId(session.id);
    try {
      await action();
      await refresh();
      showToast(t(successKey));
    } catch (actionError) {
      showToast(`${t('vsActionError')} ${actionError.message}`);
    } finally {
      setBusyId('');
    }
  }

  function renderSession(session) {
    const phase = sessionPhase(session, now);
    const audience = session.group_id ? `${t('vsForGroup')}: ${names.groups.get(session.group_id) || ''}` : `${t('vsForClient')} ${names.clients.get(session.client_id) || ''}`;
    return (
      <article className={`panel session-card ${phase === 'cancelled' ? 'is-archived' : ''}`} key={session.id}>
        <div className="template-card-heading">
          <h3 dir="auto">{session.title}</h3>
          <div className="contract-badges">
            {phase === 'live' && <span className="soft-badge badge-green">{t('vsPhase_live')}</span>}
            {phase === 'soon' && <span className="soft-badge badge-amber">{t('vsPhase_soon')}</span>}
            <span className="soft-badge badge-muted">{t(providerLabelKey(session.provider))}</span>
            {['completed', 'cancelled'].includes(session.status) && <span className="soft-badge badge-muted">{t(`vsStatus_${session.status}`)}</span>}
          </div>
        </div>
        <div className="template-meta">
          <span dir="auto">{audience}</span>
          <time dateTime={session.scheduled_at}>{new Date(session.scheduled_at).toLocaleString(locale)}</time>
          <span>{session.duration_minutes} {t('vsMinutes')}</span>
          {session.meeting_passcode && <span dir="ltr">{t('vsPasscode')}: {session.meeting_passcode}</span>}
        </div>
        {session.description && <p className="muted-copy" dir="auto">{session.description}</p>}
        <div className="template-actions">
          {isValidMeetingUrl(session.meeting_url) && session.status === 'scheduled' && (
            <a className="button button-primary button-small" href={session.meeting_url} target="_blank" rel="noopener noreferrer">{t('vsOpenMeeting')}</a>
          )}
          <button className="text-action" type="button" onClick={() => setDraft(emptySessionDraft({ id: session.id, audience: session.group_id ? 'group' : 'client', clientId: session.client_id || '', groupId: session.group_id || '', title: session.title, description: session.description, scheduledAt: toDatetimeLocal(session.scheduled_at), duration: String(session.duration_minutes), provider: session.provider, meetingUrl: session.meeting_url, passcode: session.meeting_passcode, autoLink: false }))}>{t('vsEdit')}</button>
          {session.status === 'scheduled' && <button className="text-action" type="button" disabled={busyId === session.id} onClick={() => run(session, () => setVideoSessionStatus(session.id, 'completed'), 'vsUpdated')}>{t('vsComplete')}</button>}
          {session.status === 'scheduled' && <button className="text-action" type="button" disabled={busyId === session.id} onClick={() => window.confirm(t('vsCancelConfirm')) && run(session, () => setVideoSessionStatus(session.id, 'cancelled'), 'vsUpdated')}>{t('vsCancel')}</button>}
          <button className="text-action wf-danger" type="button" disabled={busyId === session.id} onClick={() => window.confirm(t('vsDeleteConfirm')) && run(session, () => deleteVideoSession(session.id), 'vsDeleted')}>{t('vsDelete')}</button>
        </div>
      </article>
    );
  }

  const headerAction = !draft && <Button variant="primary" onClick={() => setDraft(emptySessionDraft())}>+ {t('vsNew')}</Button>;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('vsTitle')} description={t('vsDescription')} action={headerAction} />
      {draft && (
        <SessionForm
          key={draft.id || 'new'}
          initial={draft}
          clients={activeClients}
          groups={groups}
          zoomConfigured={zoomConfigured}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setDraft(null)}
        />
      )}

      {!draft && (
        <>
          {error && <div className="notice notice-error" role="alert">{t('vsLoadError')} {error}</div>}
          {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {!loading && !error && upcoming.length === 0 && (
            <section className="panel"><div className="dashboard-empty"><h3>{t('vsNone')}</h3><p>{t('vsNoneHelp')}</p><Button variant="primary" onClick={() => setDraft(emptySessionDraft())}>+ {t('vsNew')}</Button></div></section>
          )}
          {upcoming.length > 0 && <h3 className="contract-section-title">{t('vsUpcoming')}</h3>}
          <div className="contract-list">{upcoming.map(renderSession)}</div>
          {past.length > 0 && <h3 className="contract-section-title">{t('vsPast')}</h3>}
          <div className="contract-list">{past.slice(0, 30).map(renderSession)}</div>
        </>
      )}
    </>
  );
}
