import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { useToast } from '../contexts/ToastContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import {
  assignClientTrainer,
  getTeam,
  inviteTrainer,
  listAssignments,
  removeTeamMember,
  updateTeamMember,
} from '../services/teamService.js';
import { TEAM_LIMITS, TEAM_PERMISSIONS, assignmentIndex, defaultPermissions, memberLabel, normalizePermissions, validateInviteForm } from '../services/teamUtils.js';

function PermissionChecks({ value, onChange, disabled }) {
  const { t } = useLocale();
  return (
    <div className="team-permissions" role="group" aria-label={t('tmPermissions')}>
      {TEAM_PERMISSIONS.map((permission) => (
        <label className="checkbox-row" key={permission}>
          <input type="checkbox" checked={value[permission] === true} disabled={disabled} onChange={(event) => onChange({ ...value, [permission]: event.target.checked })} />
          <span>{t(`tmPerm_${permission}`)}</span>
        </label>
      ))}
    </div>
  );
}

function InviteForm({ onInvite, busy }) {
  const { t } = useLocale();
  const [email, setEmail] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [permissions, setPermissions] = useState(defaultPermissions());
  const [attempted, setAttempted] = useState(false);
  const errors = attempted ? validateInviteForm({ email, roleTitle }).errors : {};

  async function handleSubmit(event) {
    event.preventDefault();
    setAttempted(true);
    const result = validateInviteForm({ email, roleTitle });
    if (!result.valid) return;
    if (await onInvite({ email: result.email, roleTitle: result.roleTitle, permissions })) {
      setEmail('');
      setRoleTitle('');
      setPermissions(defaultPermissions());
      setAttempted(false);
    }
  }

  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;
  return (
    <form className="panel team-invite" onSubmit={handleSubmit} noValidate>
      <div className="panel-heading"><div><span className="eyebrow">{t('navTeam')}</span><h3>{t('tmInviteHeading')}</h3></div></div>
      <label className="form-label">
        <span>{t('tmEmail')}</span>
        <input className="field" type="email" dir="ltr" value={email} placeholder={t('tmEmailPlaceholder')} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(errors.email)} />
        {fieldError(errors.email)}
      </label>
      <label className="form-label">
        <span>{t('tmRoleTitle')}</span>
        <input className="field" value={roleTitle} maxLength={TEAM_LIMITS.roleTitle + 10} placeholder={t('tmRoleTitlePlaceholder')} onChange={(event) => setRoleTitle(event.target.value)} />
        {fieldError(errors.roleTitle)}
      </label>
      <div className="form-label">
        <span>{t('tmPermissions')}</span>
        <PermissionChecks value={permissions} onChange={setPermissions} />
      </div>
      <div className="wf-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? t('tmInviting') : t('tmInvite')}</Button></div>
    </form>
  );
}

function MemberEditor({ member, busy, onSave }) {
  const { t } = useLocale();
  const [roleTitle, setRoleTitle] = useState(member.role_title);
  const [permissions, setPermissions] = useState(normalizePermissions(member.permissions));
  return (
    <div className="team-editor">
      <label className="form-label">
        <span>{t('tmRoleTitle')}</span>
        <input className="field" value={roleTitle} maxLength={TEAM_LIMITS.roleTitle + 10} onChange={(event) => setRoleTitle(event.target.value)} />
      </label>
      <PermissionChecks value={permissions} onChange={setPermissions} />
      <div className="wf-actions"><Button variant="secondary" size="small" disabled={busy} onClick={() => onSave({ roleTitle: roleTitle.trim(), permissions })}>{t('tmSavePermissions')}</Button></div>
    </div>
  );
}

export default function TeamPage() {
  const { t } = useLocale();
  const showToast = useToast();
  const [members, setMembers] = useState([]);
  const [clients, setClients] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState('');

  const refresh = useCallback(async () => {
    const [team, clientRows, assignmentRows] = await Promise.all([getTeam(), listMyClients(), listAssignments()]);
    setMembers(team);
    setClients(clientRows.filter((client) => client.status === 'active'));
    setAssignments(assignmentRows);
    setError('');
  }, []);

  useEffect(() => {
    refresh()
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  const index = useMemo(() => assignmentIndex(assignments, members), [assignments, members]);
  const activeMembers = members.filter((member) => member.status === 'active');

  async function act(action, successKey) {
    setBusy(true);
    try {
      await action();
      await refresh();
      if (successKey) showToast(t(successKey));
      return true;
    } catch (actionError) {
      showToast(`${t('tmActionError')} ${actionError.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleInvite(form) {
    setBusy(true);
    try {
      await inviteTrainer(form);
      await refresh();
      showToast(t('tmInvited'));
      return true;
    } catch (inviteError) {
      showToast(`${t('tmInviteError')} ${inviteError.message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('tmTitle')} description={t('tmDescription')} />
      {error && <div className="notice notice-error" role="alert">{t('tmLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}

      {!loading && !error && (
        <div className="team-layout">
          <InviteForm onInvite={handleInvite} busy={busy} />

          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('navTeam')}</span><h3>{t('tmMembers')} ({members.length})</h3></div></div>
            {members.length === 0 && <p className="muted-copy">{t('tmNoMembers')}</p>}
            <ul className="team-members">
              {members.map((member) => (
                <li key={member.id}>
                  <div className="team-member-main">
                    <div className="avatar avatar-blue" aria-hidden="true">{memberLabel(member).slice(0, 1).toUpperCase()}</div>
                    <div className="team-member-copy">
                      <strong>{memberLabel(member)}</strong>
                      <small dir="auto">{member.role_title ? `${member.role_title} · ` : ''}{member.trainer_name ? member.invite_email : ''}</small>
                    </div>
                    <span className={`soft-badge ${member.status === 'active' ? 'badge-green' : member.status === 'invited' ? 'badge-amber' : 'badge-muted'}`}>{t(`tmStatus_${member.status}`)}</span>
                    <span className="soft-badge badge-blue">{member.client_count} {t('tmClients')}</span>
                  </div>
                  <div className="client-row-actions">
                    <button className="text-action" type="button" aria-expanded={editingId === member.id} onClick={() => setEditingId(editingId === member.id ? '' : member.id)}>{t('tmEdit')}</button>
                    {member.status !== 'invited' && (
                      <button className="text-action" type="button" disabled={busy} onClick={() => act(() => updateTeamMember({ memberId: member.id, roleTitle: member.role_title, permissions: member.permissions, status: member.status === 'active' ? 'disabled' : 'active' }), 'tmSaved')}>{member.status === 'active' ? t('tmDisable') : t('tmEnable')}</button>
                    )}
                    <button className="text-action wf-danger" type="button" disabled={busy} onClick={() => window.confirm(t('tmRemoveConfirm')) && act(() => removeTeamMember(member.id), 'tmRemoved')}>{t('tmRemove')}</button>
                  </div>
                  {editingId === member.id && (
                    <MemberEditor member={member} busy={busy} onSave={({ roleTitle, permissions }) => act(async () => { await updateTeamMember({ memberId: member.id, roleTitle, permissions }); setEditingId(''); }, 'tmSaved')} />
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="panel">
            <div className="panel-heading"><div><span className="eyebrow">{t('navTeam')}</span><h3>{t('tmAssignHeading')}</h3></div></div>
            <p className="muted-copy">{t('tmAssignHelp')}</p>
            {activeMembers.length === 0 && <div className="notice notice-info">{t('tmNoActive')}</div>}
            {clients.length === 0 && <p className="muted-copy">{t('tmNoClients')}</p>}
            <ul className="team-assignments">
              {clients.map((client) => (
                <li key={client.client_id}>
                  <span>{clientLabel(client)}</span>
                  <select
                    className="field"
                    aria-label={`${t('tmFilterLabel')}: ${clientLabel(client)}`}
                    value={index.get(client.client_id)?.id || ''}
                    disabled={busy || activeMembers.length === 0}
                    onChange={(event) => act(() => assignClientTrainer(client.client_id, event.target.value || null), 'tmAssigned')}
                  >
                    <option value="">{t('tmUnassigned')}</option>
                    {activeMembers.map((member) => <option key={member.id} value={member.id}>{memberLabel(member)}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
