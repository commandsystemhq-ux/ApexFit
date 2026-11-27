import { useEffect, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ProgramPreview from '../components/ProgramPreview.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import { listMyClients } from '../services/coachClientService.js';
import { clientLabel } from '../services/coachingUtils.js';
import { assignProgramToClient } from '../services/workflowService.js';
import {
  BUILDER_HANDOFF_KEY,
  duplicateWorkoutProgram,
  listMyWorkoutPrograms,
  setProgramTemplate,
} from '../services/workoutProgramService.js';

export default function ProgramTemplatesPage({ onNavigate, onNotify }) {
  const { locale, t } = useLocale();
  const [programs, setPrograms] = useState([]);
  const [filter, setFilter] = useState('templates');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [clients, setClients] = useState([]);
  const [assignTo, setAssignTo] = useState({});

  useEffect(() => {
    let active = true;
    listMyWorkoutPrograms()
      .then((result) => {
        if (active) setPrograms(result);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    listMyClients()
      .then((rows) => {
        if (active) setClients(rows.filter((client) => client.status === 'active'));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const visiblePrograms = filter === 'templates' ? programs.filter((program) => program.is_template) : programs;

  function openInBuilder(programId) {
    window.sessionStorage.setItem(BUILDER_HANDOFF_KEY, programId);
    onNavigate('workoutBuilder');
  }

  async function toggleTemplate(program) {
    setBusyId(program.id);
    try {
      await setProgramTemplate(program.id, !program.is_template);
      setPrograms((current) => current.map((item) => (
        item.id === program.id ? { ...item, is_template: !program.is_template } : item
      )));
      onNotify(t('templateUpdated'));
    } catch (updateError) {
      onNotify(`${t('templateUpdateError')} ${updateError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function assignProgram(program) {
    const clientId = assignTo[program.id];
    if (!clientId) return;
    setBusyId(program.id);
    try {
      await assignProgramToClient(clientId, program.id);
      setAssignTo((current) => ({ ...current, [program.id]: '' }));
      onNotify(t('wfAssigned'));
    } catch (assignError) {
      onNotify(`${t('wfAssignError')} ${assignError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function useProgram(program) {
    setBusyId(program.id);
    try {
      const newId = await duplicateWorkoutProgram(program.id, `${program.title} (${t('copySuffix')})`.slice(0, 160), false);
      onNotify(t('templateCreated'));
      openInBuilder(newId);
    } catch (createError) {
      onNotify(`${t('templateCreateError')} ${createError.message}`);
      setBusyId('');
    }
  }

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('programTemplates')} description={t('programTemplatesDescription')} />
      <div className="range-switch" role="group" aria-label={t('programTemplates')}>
        <button type="button" className={filter === 'templates' ? 'is-active' : ''} aria-pressed={filter === 'templates'} onClick={() => setFilter('templates')}>{t('templatesTab')}</button>
        <button type="button" className={filter === 'all' ? 'is-active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('allProgramsTab')}</button>
      </div>
      {error && <div className="notice notice-error" role="alert">{t('programLoadError')} {error}</div>}
      {loading && <div className="empty-state" role="status">{t('loadingPrograms')}</div>}
      {!loading && !error && visiblePrograms.length === 0 && (
        <section className="panel">
          <div className="dashboard-empty">
            <h3>{filter === 'templates' ? t('noTemplates') : t('noProgramsYet')}</h3>
            <p>{t('noTemplatesHelp')}</p>
            <Button variant="primary" onClick={() => onNavigate('workoutBuilder')}>{t('workoutBuilder')}</Button>
          </div>
        </section>
      )}
      {visiblePrograms.length > 0 && (
        <div className="template-grid">
          {visiblePrograms.map((program) => (
            <article className="panel template-card" key={program.id}>
              <div className="template-card-heading">
                <h3>{program.title}</h3>
                {program.is_template && <span className="soft-badge">{t('templateBadge')}</span>}
              </div>
              {program.description && <p className="muted-copy template-description">{program.description}</p>}
              <div className="template-meta">
                <span>{program.dayCount} {t('days')}</span>
                <span>{program.exerciseCount} {t('exercises')}</span>
                <time dateTime={program.updated_at}>{t('updatedOn')} {new Date(program.updated_at).toLocaleDateString(locale)}</time>
              </div>
              <ProgramPreview programId={program.id} />
              <div className="template-actions">
                <Button variant="primary" size="small" disabled={busyId === program.id} onClick={() => useProgram(program)}>
                  {program.is_template ? t('useTemplate') : t('duplicateProgram')}
                </Button>
                <Button variant="secondary" size="small" disabled={busyId === program.id} onClick={() => openInBuilder(program.id)}>{t('openInBuilder')}</Button>
                <button className="text-action" type="button" disabled={busyId === program.id} onClick={() => toggleTemplate(program)}>
                  {program.is_template ? t('removeFromTemplates') : t('saveAsTemplateAction')}
                </button>
              </div>
              <div className="wf-assign">
                <select className="field" aria-label={t('wfAssignProgram')} value={assignTo[program.id] || ''} disabled={clients.length === 0 || busyId === program.id} onChange={(event) => setAssignTo((current) => ({ ...current, [program.id]: event.target.value }))}>
                  <option value="">{clients.length === 0 ? t('wfNoClients') : t('wfChooseClient')}</option>
                  {clients.map((client) => <option key={client.client_id} value={client.client_id}>{clientLabel(client)}</option>)}
                </select>
                <Button variant="secondary" size="small" disabled={!assignTo[program.id] || busyId === program.id} onClick={() => assignProgram(program)}>{t('wfAssign')}</Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
