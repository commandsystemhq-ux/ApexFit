import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Button from '../components/Button.jsx';
import ClientCheckinsReview from '../components/ClientCheckinsReview.jsx';
import ClientCompliancePanel from '../components/ClientCompliancePanel.jsx';
import ClientFoodReview from '../components/ClientFoodReview.jsx';
import ProgressionSuggestions from '../components/ProgressionSuggestions.jsx';
import ClientJackAssistant from '../components/ClientJackAssistant.jsx';
import ClientHabitReview from '../components/ClientHabitReview.jsx';
import ClientHealthPanel from '../components/ClientHealthPanel.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  createClientInvite,
  getClientIntake,
  listMyClients,
  listOpenInvites,
  setClientStatus,
} from '../services/coachClientService.js';
import { getTaskCompletionRates } from '../services/accountabilityService.js';
import { fillText, ratesByClient, rateTone } from '../services/accountabilityUtils.js';
import { listClearanceFlags } from '../services/assessmentService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { getTeam, listAssignments } from '../services/teamService.js';
import { TRAINER_FILTER_ALL, TRAINER_FILTER_NONE, assignmentIndex, filterClientsByTrainer, memberLabel } from '../services/teamUtils.js';

const GOAL_LABELS = {
  fat_loss: 'goalFatLoss', muscle_gain: 'goalMuscleGain', strength: 'goalStrength',
  endurance: 'goalEndurance', general_fitness: 'goalGeneralFitness',
};
const EQUIPMENT_LABELS = { full_gym: 'fullGym', home_gym: 'equipHomeGym', bodyweight_only: 'equipBodyweight' };

export default function ClientsPage({ onNotify }) {
  const { locale, t } = useLocale();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const openedFromLink = useRef('');
  const [clients, setClients] = useState([]);
  const [invites, setInvites] = useState([]);
  const [team, setTeam] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [trainerFilter, setTrainerFilter] = useState(TRAINER_FILTER_ALL);
  const [clearance, setClearance] = useState({});
  const [rates, setRates] = useState(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState('');
  const [detailTab, setDetailTab] = useState('profile');
  const [intake, setIntake] = useState({ state: 'idle', data: null, error: '' });

  async function refresh() {
    try {
      const [clientRows, inviteRows, flagRows, teamRows, assignmentRows] = await Promise.all([listMyClients(), listOpenInvites(), listClearanceFlags().catch(() => []), getTeam().catch(() => []), listAssignments().catch(() => [])]);
      getTaskCompletionRates(30).then((rows) => setRates(ratesByClient(rows))).catch(() => {});
      setTeam(teamRows);
      setAssignments(assignmentRows);
      setClients(clientRows);
      setInvites(inviteRows);
      setClearance(Object.fromEntries(flagRows.filter((row) => row.medical_clearance_required).map((row) => [row.client_id, true])));
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreateInvite() {
    setCreating(true);
    try {
      await createClientInvite();
      await refresh();
    } catch (createError) {
      onNotify(`${t('inviteCreateError')} ${createError.message}`);
    } finally {
      setCreating(false);
    }
  }

  async function copyCode(code) {
    try {
      await navigator.clipboard.writeText(code);
      onNotify(t('inviteCopied'));
    } catch {
      onNotify(code);
    }
  }

  async function toggleStatus(client) {
    try {
      await setClientStatus(client.client_id, client.status === 'active' ? 'archived' : 'active');
      await refresh();
    } catch (statusError) {
      onNotify(statusError.message);
    }
  }

  async function toggleIntake(clientId) {
    if (expandedId === clientId) {
      setExpandedId('');
      return;
    }
    setExpandedId(clientId);
    setDetailTab('profile');
    setIntake({ state: 'loading', data: null, error: '' });
    try {
      setIntake({ state: 'ready', data: await getClientIntake(clientId), error: '' });
    } catch (intakeError) {
      setIntake({ state: 'error', data: null, error: intakeError.message });
    }
  }

  // A link such as /clients?client=<id> (from the dashboard) opens that client's details and scrolls to them.
  const linkedClientId = searchParams.get('client');
  useEffect(() => {
    if (!linkedClientId || loading || openedFromLink.current === linkedClientId) return;
    openedFromLink.current = linkedClientId;
    if (clients.some((client) => client.client_id === linkedClientId)) {
      toggleIntake(linkedClientId);
      window.requestAnimationFrame(() => document.getElementById(`client-${linkedClientId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    setSearchParams({}, { replace: true });
  }, [linkedClientId, loading, clients]);

  const activeCount = clients.filter((client) => client.status === 'active').length;
  const trainerIndex = assignmentIndex(assignments, team);
  const visibleClients = filterClientsByTrainer(clients, trainerIndex, trainerFilter);

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('clientsTitle')} description={t('clientsDescription')} />
      <div className="client-feature-grid">
        <section className="panel clients-roster">
          <div className="panel-heading">
            <div><span className="eyebrow">{t('clientRoster')}</span><h3>{t('clients')}</h3></div>
            <span className="soft-badge badge-muted">{activeCount} {t('activeClients')}</span>
          </div>
          {team.length > 0 && (
            <label className="trainer-filter">
              <span>{t('tmFilterLabel')}</span>
              <select className="field" value={trainerFilter} onChange={(event) => setTrainerFilter(event.target.value)}>
                <option value={TRAINER_FILTER_ALL}>{t('tmFilterAll')}</option>
                <option value={TRAINER_FILTER_NONE}>{t('tmFilterNone')}</option>
                {team.filter((member) => member.status === 'active').map((member) => <option key={member.id} value={member.id}>{memberLabel(member)}</option>)}
              </select>
            </label>
          )}
          {error && <div className="notice notice-error" role="alert">{t('clientsLoadError')} {error}</div>}
          {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}
          {!loading && !error && clients.length === 0 && (
            <div className="dashboard-empty"><h3>{t('emptyClients')}</h3><p>{t('clientsEmptyHelp')}</p></div>
          )}
          <div className="clients-list">
            {visibleClients.map((client) => (
              <article className="client-row" id={`client-${client.client_id}`} key={client.client_id}>
                <div className="client-row-main">
                  <div className="avatar avatar-blue" aria-hidden="true">{clientLabel(client).slice(0, 1).toUpperCase()}</div>
                  <div className="client-row-copy">
                    <strong>{clientLabel(client)}</strong>
                    <small>{client.client_email} · {t('joinedOn')} {new Date(client.created_at).toLocaleDateString(locale)}</small>
                  </div>
                  {trainerIndex.get(client.client_id) && <span className="soft-badge badge-cyan" title={t('tmTrainerBadge')}>{t('tmTrainerBadge')}: {memberLabel(trainerIndex.get(client.client_id))}</span>}
                  {clearance[client.client_id] && <span className="soft-badge badge-amber">{t('asmClearanceBadge')}</span>}
                  {rates.get(client.client_id)?.rate !== null && rates.get(client.client_id)?.rate !== undefined && (
                    <span className={`soft-badge rate-badge tone-${rateTone(rates.get(client.client_id).rate)}`} title={fillText(t('taskDoneOf'), { done: rates.get(client.client_id).done, n: rates.get(client.client_id).assigned })} dir="ltr">
                      {t('taskTasksBadge')} {rates.get(client.client_id).rate}%
                    </span>
                  )}
                  <span className={`soft-badge ${client.status === 'active' ? 'badge-blue' : 'badge-muted'}`}>{t(client.status === 'active' ? 'active' : 'archivedStatus')}</span>
                </div>
                <div className="client-row-actions">
                  <button className="text-action" type="button" aria-expanded={expandedId === client.client_id} onClick={() => toggleIntake(client.client_id)}>{t('viewOnboarding')}</button>
                  <button className="text-action" type="button" onClick={() => navigate(`/messages?with=${client.client_id}`)}>{t('messages')}</button>
                  <button className="text-action" type="button" onClick={() => navigate(`/tasks?client=${client.client_id}`)}>{t('taskManageLink')}</button>
                  <button className="text-action" type="button" onClick={() => toggleStatus(client)}>{client.status === 'active' ? t('archiveClient') : t('restoreClient')}</button>
                </div>
                {expandedId === client.client_id && (
                  <div className="client-detail-tabs" role="tablist" aria-label={clientLabel(client)}>
                    <button type="button" role="tab" aria-selected={detailTab === 'profile'} className={`client-detail-tab ${detailTab === 'profile' ? 'is-active' : ''}`} onClick={() => setDetailTab('profile')}>{t('clientTabProfile')}</button>
                    <button type="button" role="tab" aria-selected={detailTab === 'food'} className={`client-detail-tab ${detailTab === 'food' ? 'is-active' : ''}`} onClick={() => setDetailTab('food')}>{t('clientTabFood')}</button>
                    <button type="button" role="tab" aria-selected={detailTab === 'habits'} className={`client-detail-tab ${detailTab === 'habits' ? 'is-active' : ''}`} onClick={() => setDetailTab('habits')}>{t('clientTabHabits')}</button>
                    <button type="button" role="tab" aria-selected={detailTab === 'checkins'} className={`client-detail-tab ${detailTab === 'checkins' ? 'is-active' : ''}`} onClick={() => setDetailTab('checkins')}>{t('clientTabCheckins')}</button>
                    <button type="button" role="tab" aria-selected={detailTab === 'progression'} className={`client-detail-tab ${detailTab === 'progression' ? 'is-active' : ''}`} onClick={() => setDetailTab('progression')}>{t('clientTabProgression')}</button>
                    <button type="button" role="tab" aria-selected={detailTab === 'jack'} className={`client-detail-tab ${detailTab === 'jack' ? 'is-active' : ''}`} onClick={() => setDetailTab('jack')}>{'\u2726'} {t('clientTabJack')}</button>
                  </div>
                )}
                {expandedId === client.client_id && detailTab === 'jack' && (
                  <div className="client-intake-summary" role="tabpanel"><ClientJackAssistant clientId={client.client_id} clientName={clientLabel(client)} /></div>
                )}
                {expandedId === client.client_id && detailTab === 'progression' && (
                  <div className="client-intake-summary" role="tabpanel"><ProgressionSuggestions clientId={client.client_id} showClient={false} /></div>
                )}
                {expandedId === client.client_id && detailTab === 'checkins' && (
                  <div className="client-intake-summary" role="tabpanel"><ClientCheckinsReview clientId={client.client_id} /></div>
                )}
                {expandedId === client.client_id && detailTab === 'habits' && (
                  <div className="client-intake-summary" role="tabpanel"><ClientHabitReview clientId={client.client_id} /></div>
                )}
                {expandedId === client.client_id && detailTab === 'food' && (
                  <div className="client-intake-summary" role="tabpanel"><ClientFoodReview clientId={client.client_id} /></div>
                )}
                {expandedId === client.client_id && detailTab === 'profile' && (
                  <div className="client-intake-summary">
                    {intake.state === 'loading' && <p className="muted-copy" role="status">{t('loadingProgress')}</p>}
                    {intake.state === 'error' && <div className="notice notice-error" role="alert">{t('intakeLoadError')} {intake.error}</div>}
                    {intake.state === 'ready' && !intake.data && <p className="muted-copy">{t('intakeNotSubmitted')}</p>}
                    {intake.state === 'ready' && intake.data && (
                      <dl className="intake-summary-list">
                        <div><dt>{t('intakeGoal')}</dt><dd>{t(GOAL_LABELS[intake.data.primary_goal])}</dd></div>
                        <div><dt>{t('intakeExperience')}</dt><dd>{t(`difficulty_${intake.data.experience_level}`)}</dd></div>
                        <div><dt>{t('intakeTrainingDays')}</dt><dd>{intake.data.training_days_per_week}</dd></div>
                        <div><dt>{t('intakeEquipment')}</dt><dd>{t(EQUIPMENT_LABELS[intake.data.equipment_access])}</dd></div>
                        {intake.data.height_cm !== null && <div><dt>{t('intakeHeight')}</dt><dd>{intake.data.height_cm}</dd></div>}
                        {intake.data.injuries && <div><dt>{t('intakeInjuries')}</dt><dd>{intake.data.injuries}</dd></div>}
                        {intake.data.medical_conditions && <div><dt>{t('intakeMedical')}</dt><dd>{intake.data.medical_conditions}</dd></div>}
                        {intake.data.dietary_preferences && <div><dt>{t('intakeDiet')}</dt><dd>{intake.data.dietary_preferences}</dd></div>}
                        {intake.data.additional_notes && <div><dt>{t('intakeNotes')}</dt><dd>{intake.data.additional_notes}</dd></div>}
                      </dl>
                    )}
                    <ClientCompliancePanel clientId={client.client_id} />
                    <ClientHealthPanel clientId={client.client_id} canSetTargets />
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="panel clients-invites">
          <div className="panel-heading"><div><span className="eyebrow">{t('inviteClient')}</span><h3>{t('inviteCodes')}</h3></div></div>
          <p className="muted-copy">{t('inviteHelp')}</p>
          <Button variant="primary" onClick={handleCreateInvite} disabled={creating}>{creating ? t('inviteCreating') : t('inviteCreate')}</Button>
          {invites.length === 0 && <div className="empty-state">{t('noOpenInvites')}</div>}
          <div className="invite-list">
            {invites.map((invite) => (
              <div className="invite-row" key={invite.code}>
                <code>{invite.code}</code>
                <small>{t('inviteExpires')} {new Date(invite.expires_at).toLocaleDateString(locale)}</small>
                <button className="text-action" type="button" onClick={() => copyCode(invite.code)}>{t('inviteCopy')}</button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
