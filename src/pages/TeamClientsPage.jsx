import { useCallback, useEffect, useState } from 'react';
import AssessmentSummary from '../components/AssessmentSummary.jsx';
import Button from '../components/Button.jsx';
import ClientHealthPanel from '../components/ClientHealthPanel.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { getClientAssessment } from '../services/assessmentService.js';
import { addGroupMembers, postGroupAnnouncement } from '../services/groupService.js';
import { GROUP_LIMITS, validateAnnouncement } from '../services/groupUtils.js';
import { assignProgramToClient } from '../services/workflowService.js';
import { getTrainerOverview, leaveTeam, sendTeamMessage } from '../services/teamService.js';

function ClientCard({ client, overview, can, onChanged }) {
  const { t, locale } = useLocale();
  const showToast = useToast();
  const [open, setOpen] = useState('');
  const [assessment, setAssessment] = useState({ status: 'idle', data: null });
  const [programId, setProgramId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function toggleAssessment() {
    if (open === 'assessment') {
      setOpen('');
      return;
    }
    setOpen('assessment');
    setAssessment({ status: 'loading', data: null });
    try {
      setAssessment({ status: 'ready', data: await getClientAssessment(client.client_id) });
    } catch (error) {
      setAssessment({ status: 'error', data: null, error: error.message });
    }
  }

  async function run(action, successKey, errorKey) {
    setBusy(true);
    try {
      await action();
      showToast(t(successKey));
      await onChanged();
      return true;
    } catch (error) {
      showToast(`${t(errorKey)} ${error.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(event) {
    event.preventDefault();
    if (!message.trim()) return;
    if (await run(() => sendTeamMessage(client.client_id, message.trim()), 'trnSent', 'trnSendError')) setMessage('');
  }

  return (
    <article className="client-row">
      <div className="client-row-main">
        <div className="avatar avatar-blue" aria-hidden="true">{client.name.slice(0, 1).toUpperCase()}</div>
        <div className="client-row-copy">
          <strong>{client.name}</strong>
          <small>
            {t('trnLastWorkout')}: {client.last_workout_date ? new Date(`${client.last_workout_date}T12:00:00`).toLocaleDateString(locale) : t('trnNever')}
            {' · '}{client.workouts_7d} {t('trnWorkouts7')}
          </small>
          <small>{t('trnProgram')}: {client.program || t('trnNoProgram')}</small>
        </div>
        {client.medical_clearance_required && <span className="soft-badge badge-amber">{t('trnClearance')}</span>}
      </div>

      <div className="client-row-actions">
        {can.view_assessments && <button className="text-action" type="button" aria-expanded={open === 'assessment'} onClick={toggleAssessment}>{t('trnViewAssessment')}</button>}
        {can.view_assessments && <button className="text-action" type="button" aria-expanded={open === 'health'} onClick={() => setOpen(open === 'health' ? '' : 'health')}>{t('trnViewHealth')}</button>}
        {can.manage_programs && <button className="text-action" type="button" aria-expanded={open === 'program'} onClick={() => setOpen(open === 'program' ? '' : 'program')}>{t('trnAssignProgram')}</button>}
        {can.messages && <button className="text-action" type="button" aria-expanded={open === 'message'} onClick={() => setOpen(open === 'message' ? '' : 'message')}>{t('trnMessage')}</button>}
        {can.manage_groups && overview.groups.length > 0 && <button className="text-action" type="button" aria-expanded={open === 'group'} onClick={() => setOpen(open === 'group' ? '' : 'group')}>{t('trnAddToGroup')}</button>}
      </div>

      {open === 'assessment' && (
        <div className="client-intake-summary">
          {assessment.status === 'loading' && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
          {assessment.status === 'error' && <div className="notice notice-error" role="alert">{assessment.error}</div>}
          {assessment.status === 'ready' && <AssessmentSummary assessment={assessment.data} />}
        </div>
      )}

      {open === 'health' && can.view_assessments && <div className="client-intake-summary"><ClientHealthPanel clientId={client.client_id} /></div>}

      {open === 'program' && (
        <div className="group-program-row">
          <select className="field" aria-label={t('trnChooseProgram')} value={programId} onChange={(event) => setProgramId(event.target.value)}>
            <option value="">{t('trnChooseProgram')}</option>
            {overview.programs.map((program) => <option key={program.id} value={program.id}>{program.title}</option>)}
          </select>
          <Button variant="primary" size="small" disabled={busy || !programId} onClick={() => run(() => assignProgramToClient(client.client_id, programId), 'trnAssigned', 'trnAssignError')}>{t('trnAssign')}</Button>
        </div>
      )}

      {open === 'message' && (
        <form className="group-announce-form" onSubmit={send}>
          <textarea className="field" rows={2} maxLength={2000} value={message} placeholder={t('trnMessagePlaceholder')} aria-label={t('trnMessagePlaceholder')} onChange={(event) => setMessage(event.target.value)} />
          <div className="wf-actions"><Button type="submit" variant="secondary" size="small" disabled={busy || !message.trim()}>{t('trnSend')}</Button></div>
        </form>
      )}

      {open === 'group' && (
        <div className="group-program-row">
          <select className="field" aria-label={t('trnChooseGroup')} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
            <option value="">{t('trnChooseGroup')}</option>
            {overview.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <Button variant="primary" size="small" disabled={busy || !groupId} onClick={() => run(() => addGroupMembers(groupId, [client.client_id]), 'trnAdded', 'trnGroupError')}>{t('trnAddToGroup')}</Button>
        </div>
      )}
    </article>
  );
}

function GroupUpdate({ groups }) {
  const { t } = useLocale();
  const showToast = useToast();
  const [groupId, setGroupId] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    const result = validateAnnouncement(body);
    setError(result.error);
    if (!groupId || !result.valid) return;
    setBusy(true);
    try {
      await postGroupAnnouncement(groupId, result.body);
      setBody('');
      showToast(t('trnPosted'));
    } catch (postError) {
      showToast(`${t('trnGroupError')} ${postError.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">{t('trnGroups')}</span><h3>{t('trnPostUpdate')}</h3></div></div>
      <form className="group-announce-form" onSubmit={submit} noValidate>
        <select className="field" aria-label={t('trnChooseGroup')} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">{t('trnChooseGroup')}</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <textarea className="field" rows={2} maxLength={GROUP_LIMITS.announcement + 50} value={body} placeholder={t('grpAnnouncementPlaceholder')} aria-label={t('grpAnnouncementPlaceholder')} onChange={(event) => { setBody(event.target.value); setError(''); }} />
        {error && <span className="field-error" role="alert">{t(error)}</span>}
        <div className="wf-actions"><Button type="submit" variant="secondary" size="small" disabled={busy || !groupId}>{t('grpPost')}</Button></div>
      </form>
    </section>
  );
}

export default function TeamClientsPage() {
  const { t } = useLocale();
  const showToast = useToast();
  const { profile, setProfile } = useAuth();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setOverview(await getTrainerOverview());
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  async function leave() {
    if (!window.confirm(t('trnLeaveConfirm'))) return;
    try {
      setProfile(await leaveTeam());
      showToast(t('trnLeft'));
    } catch (leaveError) {
      showToast(leaveError.message);
    }
  }

  const permissions = overview?.permissions || profile?.team?.permissions || {};

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('trnTitle')} description={t('trnDescription')} action={<Button variant="secondary" size="small" onClick={leave}>{t('trnLeave')}</Button>} />
      {error && <div className="notice notice-error" role="alert">{t('trnLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}

      {overview && (
        <>
          <section className="panel team-summary">
            <div><span className="eyebrow">{t('trnHeadCoach')}</span><strong>{overview.head_name}</strong></div>
            {profile?.team?.role_title && <div><span className="eyebrow">{t('trnYourRole')}</span><strong>{profile.team.role_title}</strong></div>}
          </section>

          {overview.clients.length === 0 && (
            <section className="panel"><div className="dashboard-empty"><h3>{t('trnNoClients')}</h3><p>{t('trnNoClientsHelp')}</p></div></section>
          )}

          <section className="clients-list">
            {overview.clients.map((client) => (
              <ClientCard key={client.client_id} client={client} overview={overview} can={permissions} onChanged={refresh} />
            ))}
          </section>

          {permissions.manage_groups && overview.groups.length > 0 && <GroupUpdate groups={overview.groups} />}
        </>
      )}
    </>
  );
}
