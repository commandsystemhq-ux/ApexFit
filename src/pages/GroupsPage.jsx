import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import {
  addGroupMembers,
  assignProgramToGroup,
  clearGroupProgram,
  deleteGroup,
  deleteGroupAnnouncement,
  listGroups,
  postGroupAnnouncement,
  removeGroupMember,
  saveGroup,
} from '../services/groupService.js';
import { GROUP_LIMITS, availableClients, describeGroup, validateAnnouncement, validateGroupForm } from '../services/groupUtils.js';
import { listMyWorkoutPrograms } from '../services/workoutProgramService.js';

function GroupForm({ group, saving, onSubmit, onCancel }) {
  const { t } = useLocale();
  const [name, setName] = useState(group?.name || '');
  const [description, setDescription] = useState(group?.description || '');
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateGroupForm({ name, description }).errors : {};

  function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    const result = validateGroupForm({ name, description });
    if (result.valid) onSubmit(result.payload);
  }

  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;
  return (
    <form className="panel group-form" onSubmit={handleSubmit} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('navGroups')}</span><h3>{group ? t('grpEditHeading') : t('grpCreateHeading')}</h3></div></div>
      <label className="form-label">
        <span>{t('grpName')}</span>
        <input className="field" value={name} maxLength={GROUP_LIMITS.name + 10} placeholder={t('grpNamePlaceholder')} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(errors.name)} />
        {fieldError(errors.name)}
      </label>
      <label className="form-label">
        <span>{t('grpDescriptionLabel')}</span>
        <textarea className="field" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        {fieldError(errors.description)}
      </label>
      <div className="wf-actions">
        <Button type="submit" variant="primary" disabled={saving}>{group ? (saving ? t('grpSaving') : t('grpSave')) : (saving ? t('grpCreating') : t('grpCreate'))}</Button>
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t('ctrCancel')}</Button>}
      </div>
    </form>
  );
}

function GroupDetail({ group, clients, programs, busy, onRun, onDelete }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState([]);
  const [programId, setProgramId] = useState(group.program_template_id || '');
  const [announcement, setAnnouncement] = useState('');
  const [announcementError, setAnnouncementError] = useState('');

  const free = availableClients(clients, group.members.map((member) => member.client_id));

  useEffect(() => {
    setPicked([]);
    setEditing(false);
    setProgramId(group.program_template_id || '');
    setAnnouncement('');
    setAnnouncementError('');
  }, [group.id, group.program_template_id]);

  const togglePicked = (clientId) => setPicked((current) => (current.includes(clientId) ? current.filter((id) => id !== clientId) : [...current, clientId]));

  async function addPicked() {
    if (picked.length === 0) return;
    await onRun(async () => {
      const result = await addGroupMembers(group.id, picked);
      return result.program_assigned > 0 ? 'grpAddedWithProgram' : 'grpMemberAdded';
    }, 'grpMemberError');
  }

  function postUpdate(event) {
    event.preventDefault();
    const result = validateAnnouncement(announcement);
    setAnnouncementError(result.error);
    if (!result.valid) return;
    onRun(async () => {
      await postGroupAnnouncement(group.id, result.body);
      setAnnouncement('');
      return 'grpPosted';
    }, 'grpPostError');
  }

  return (
    <div className="group-detail">
      {editing ? (
        <GroupForm
          group={group}
          saving={busy}
          onCancel={() => setEditing(false)}
          onSubmit={(payload) => onRun(async () => { await saveGroup({ id: group.id, ...payload }); setEditing(false); return 'grpSaved'; }, 'grpSaveError')}
        />
      ) : (
        <section className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">{group.members.length} {t('grpMembersCount')}</span><h3>{group.name}</h3></div>
            <div className="template-actions">
              <button className="text-action" type="button" onClick={() => setEditing(true)}>{t('ctrEdit')}</button>
              <button className="text-action wf-danger" type="button" disabled={busy} onClick={onDelete}>{t('grpDelete')}</button>
            </div>
          </div>
          {group.description && <p className="muted-copy">{group.description}</p>}
        </section>
      )}

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('grpMembers')}</span><h3>{t('grpMembers')} ({group.members.length})</h3></div></div>
        {group.members.length === 0 && <p className="muted-copy">{t('grpNoMembers')}</p>}
        <ul className="group-members">
          {group.members.map((member) => (
            <li key={member.client_id}>
              <span>{member.client ? clientLabel(member.client) : member.client_id}</span>
              {member.client?.status === 'archived' && <span className="soft-badge badge-muted">{t('ctrArchivedBadge')}</span>}
              <small>{new Date(member.joined_at).toLocaleDateString(locale)}</small>
              <button className="text-action wf-danger" type="button" disabled={busy} onClick={() => onRun(async () => { await removeGroupMember(group.id, member.client_id); return 'grpMemberRemoved'; }, 'grpMemberError')}>{t('grpRemove')}</button>
            </li>
          ))}
        </ul>

        <h4 className="group-subheading">{t('grpAddMembers')}</h4>
        {free.length === 0 ? <p className="muted-copy">{t('grpNoClients')}</p> : (
          <>
            <ul className="group-picker">
              {free.map((client) => (
                <li key={client.client_id}>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={picked.includes(client.client_id)} onChange={() => togglePicked(client.client_id)} />
                    <span>{clientLabel(client)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="wf-actions"><Button variant="secondary" size="small" disabled={busy || picked.length === 0} onClick={addPicked}>{t('grpAddButton')} ({picked.length})</Button></div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('grpProgram')}</span><h3>{group.program ? group.program.title : t('grpNoProgram')}</h3></div></div>
        {programs.length === 0 ? <p className="muted-copy">{t('grpNoPrograms')}</p> : (
          <div className="group-program-row">
            <select className="field" aria-label={t('grpChooseProgram')} value={programId} onChange={(event) => setProgramId(event.target.value)}>
              <option value="">{t('grpChooseProgram')}</option>
              {programs.map((program) => <option key={program.id} value={program.id}>{program.title}</option>)}
            </select>
            <Button variant="primary" size="small" disabled={busy || !programId} onClick={() => onRun(async () => { await assignProgramToGroup(group.id, programId); return 'grpProgramAssigned'; }, 'grpProgramError')}>{busy ? t('grpAssigning') : t('grpAssignAll')}</Button>
            {group.program && <button className="text-action" type="button" disabled={busy} onClick={() => onRun(async () => { await clearGroupProgram(group.id); return 'grpSaved'; }, 'grpProgramError')}>{t('grpClearProgram')}</button>}
          </div>
        )}
        <small className="muted-copy">{t('grpProgramNote')}</small>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">{t('grpAnnouncements')}</span><h3>{t('grpAnnouncements')}</h3></div></div>
        <form className="group-announce-form" onSubmit={postUpdate} noValidate>
          <textarea className="field" rows={2} maxLength={GROUP_LIMITS.announcement + 50} value={announcement} placeholder={t('grpAnnouncementPlaceholder')} aria-label={t('grpAnnouncementPlaceholder')} onChange={(event) => { setAnnouncement(event.target.value); setAnnouncementError(''); }} />
          {announcementError && <span className="field-error" role="alert">{t(announcementError)}</span>}
          <div className="wf-actions"><Button type="submit" variant="secondary" size="small" disabled={busy}>{t('grpPost')}</Button></div>
        </form>
        {group.announcements.length === 0 && <p className="muted-copy">{t('grpNoAnnouncements')}</p>}
        <ul className="group-feed">
          {group.announcements.slice(0, 20).map((item) => (
            <li key={item.id}>
              <p dir="auto">{item.body}</p>
              <div className="group-feed-meta">
                <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString(locale)}</time>
                <button className="text-action wf-danger" type="button" disabled={busy} onClick={() => onRun(async () => { await deleteGroupAnnouncement(item.id); return 'ctrDeleted'; }, 'grpPostError')}>{t('grpDeleteAnnouncement')}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function GroupsPage() {
  const { t } = useLocale();
  const showToast = useToast();
  const [groups, setGroups] = useState([]);
  const [clients, setClients] = useState([]);
  const [programs, setPrograms] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [groupRows, clientRows, programRows] = await Promise.all([listGroups(), listMyClients(), listMyWorkoutPrograms()]);
    setGroups(groupRows);
    setClients(clientRows);
    setPrograms(programRows);
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  const described = useMemo(() => groups.map((group) => describeGroup(group, clients, programs)), [groups, clients, programs]);
  const selected = described.find((group) => group.id === selectedId) || null;

  // Runs a change, reloads, and reports with the success message the action returns.
  const run = useCallback(async (action, errorKey) => {
    setBusy(true);
    try {
      const successKey = await action();
      await refresh();
      if (successKey) showToast(t(successKey));
    } catch (actionError) {
      showToast(`${t(errorKey)} ${actionError.message}`);
    } finally {
      setBusy(false);
    }
  }, [refresh, showToast, t]);

  async function handleCreate(payload) {
    setBusy(true);
    try {
      const id = await saveGroup(payload);
      await refresh();
      setSelectedId(id);
      setCreating(false);
      showToast(t('grpSaved'));
    } catch (createError) {
      showToast(`${t('grpSaveError')} ${createError.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!selected || !window.confirm(t('grpDeleteConfirm'))) return;
    await run(async () => {
      await deleteGroup(selected.id);
      setSelectedId('');
      return 'grpDeleted';
    }, 'grpSaveError');
  }

  const headerAction = <Button variant="primary" onClick={() => { setCreating(true); setSelectedId(''); }}>+ {t('grpNew')}</Button>;

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('grpTitle')} description={t('grpDescription')} action={headerAction} />
      {error && <div className="notice notice-error" role="alert">{t('grpLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
      {!loading && !error && groups.length === 0 && !creating && (
        <section className="panel">
          <div className="dashboard-empty"><h3>{t('grpEmpty')}</h3><p>{t('grpEmptyHelp')}</p><Button variant="primary" onClick={() => setCreating(true)}>+ {t('grpNew')}</Button></div>
        </section>
      )}

      {!loading && !error && (groups.length > 0 || creating) && (
        <div className="groups-layout">
          <aside className="group-list" aria-label={t('navGroups')}>
            {described.map((group) => (
              <button className={`group-item ${group.id === selectedId ? 'is-active' : ''}`} type="button" key={group.id} onClick={() => { setSelectedId(group.id); setCreating(false); }}>
                <strong>{group.name}</strong>
                <small>{group.members.length} {t('grpMembersCount')}{group.program ? ` · ${group.program.title}` : ''}</small>
              </button>
            ))}
          </aside>
          <div className="group-main">
            {creating && <GroupForm saving={busy} onSubmit={handleCreate} onCancel={() => setCreating(false)} />}
            {!creating && selected && <GroupDetail group={selected} clients={clients} programs={programs} busy={busy} onRun={run} onDelete={handleDelete} />}
            {!creating && !selected && <section className="panel"><div className="dashboard-empty"><p>{t('grpSelectPrompt')}</p></div></section>}
          </div>
        </div>
      )}
    </>
  );
}
