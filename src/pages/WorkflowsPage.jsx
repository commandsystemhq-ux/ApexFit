import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '../components/Button.jsx';
import PageHeader from '../components/PageHeader.jsx';
import WorkflowBuilder from '../components/WorkflowBuilder.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  deleteWorkflow,
  listWorkflowLogs,
  listWorkflows,
  runMyWorkflows,
  saveWorkflow,
  setWorkflowActive,
} from '../services/workflowService.js';
import {
  WORKFLOW_PRESETS,
  buildPresetDraft,
  draftFromWorkflow,
  emptyWorkflow,
  summarizeWorkflowLogs,
} from '../services/workflowUtils.js';

export default function WorkflowsPage({ onNotify }) {
  const { t } = useLocale();
  const { user, profile } = useAuth();
  const [workflows, setWorkflows] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState('');

  const refresh = useCallback(async () => {
    const [workflowRows, logRows] = await Promise.all([listWorkflows(), listWorkflowLogs()]);
    setWorkflows(workflowRows);
    setLogs(logRows);
    setError('');
  }, []);

  useEffect(() => {
    let active = true;
    // Process anything that became due while the coach was away, then show the result.
    runMyWorkflows()
      .catch(() => null)
      .then(() => refresh())
      .catch((loadError) => {
        if (active) setError(loadError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [refresh]);

  const stats = useMemo(() => summarizeWorkflowLogs(logs), [logs]);
  const previewNames = useMemo(() => {
    const coachName = profile?.full_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Coach';
    return { coach_name: coachName, brand_name: profile?.brand_name || coachName };
  }, [profile, user]);

  async function handleSave(payload) {
    setSaving(true);
    try {
      await saveWorkflow(payload);
      await refresh();
      setDraft(null);
      onNotify(t('wfSaved'));
    } catch (saveError) {
      onNotify(`${t('wfSaveError')} ${saveError.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(workflow) {
    const next = !workflow.is_active;
    setBusyId(workflow.id);
    setWorkflows((current) => current.map((item) => (item.id === workflow.id ? { ...item, is_active: next } : item)));
    try {
      await setWorkflowActive(workflow.id, next);
    } catch (toggleError) {
      setWorkflows((current) => current.map((item) => (item.id === workflow.id ? { ...item, is_active: workflow.is_active } : item)));
      onNotify(`${t('wfToggleError')} ${toggleError.message}`);
    } finally {
      setBusyId('');
    }
  }

  async function handleDelete(workflow) {
    if (!window.confirm(t('wfDeleteConfirm'))) return;
    setBusyId(workflow.id);
    try {
      await deleteWorkflow(workflow.id);
      setWorkflows((current) => current.filter((item) => item.id !== workflow.id));
      onNotify(t('wfDeleted'));
    } catch (deleteError) {
      onNotify(deleteError.message);
    } finally {
      setBusyId('');
    }
  }

  async function handleRun() {
    setRunning(true);
    try {
      const result = await runMyWorkflows();
      await refresh();
      onNotify(`${t('wfRunResult')}: ${result?.sent ?? 0}`);
    } catch (runError) {
      onNotify(`${t('wfRunError')} ${runError.message}`);
    } finally {
      setRunning(false);
    }
  }

  const headerAction = !draft && (
    <div className="wf-header-actions">
      <Button variant="secondary" onClick={handleRun} disabled={running || loading}>{running ? t('wfRunning') : t('wfRunNow')}</Button>
      <Button variant="primary" onClick={() => setDraft(emptyWorkflow())}>+ {t('wfNew')}</Button>
    </div>
  );

  return (
    <>
      <PageHeader eyebrow="APEXFIT" title={t('workflowsTitle')} description={t('workflowsDescription')} action={headerAction} />

      {draft && (
        <WorkflowBuilder
          key={draft.id || 'new'}
          initialDraft={draft}
          previewNames={previewNames}
          saving={saving}
          onSave={handleSave}
          onCancel={() => setDraft(null)}
        />
      )}

      {!draft && (
        <>
          {error && <div className="notice notice-error" role="alert">{t('wfLoadError')} {error}</div>}
          {loading && <div className="empty-state" role="status">{t('loadingProgress')}</div>}

          {!loading && !error && workflows.length === 0 && (
            <section className="panel">
              <div className="dashboard-empty">
                <h3>{t('wfEmptyTitle')}</h3>
                <p>{t('wfEmptyHelp')}</p>
              </div>
            </section>
          )}

          {workflows.length > 0 && (
            <div className="wf-list">
              {workflows.map((workflow) => {
                const counts = stats.get(workflow.id) || { sent: 0, pending: 0 };
                return (
                  <article className={`panel wf-card ${workflow.is_active ? '' : 'is-paused'}`} key={workflow.id}>
                    <div className="wf-card-heading">
                      <div className="wf-card-title">
                        <h3>{workflow.name}</h3>
                        <span className="soft-badge badge-blue">{t(`wfTrigger_${workflow.trigger_type}`)}</span>
                      </div>
                      <button
                        className={`wf-switch ${workflow.is_active ? 'is-on' : ''}`}
                        type="button"
                        role="switch"
                        aria-checked={workflow.is_active}
                        aria-label={`${t('wfToggle')}: ${workflow.name}`}
                        disabled={busyId === workflow.id}
                        onClick={() => handleToggle(workflow)}
                      >
                        <span className="wf-switch-thumb" />
                      </button>
                    </div>
                    {workflow.description && <p className="muted-copy">{workflow.description}</p>}
                    <ol className="wf-card-steps">
                      {workflow.steps.map((step) => (
                        <li key={step.id}>
                          <span className="wf-timeline-day">{t('wfPreviewDay')} {step.delay_days}</span>
                          <span>{step.action_type === 'assign_task' ? step.task_title : step.message_template}</span>
                          <span className="soft-badge badge-muted">{t(`wfAction_${step.action_type}`)}</span>
                        </li>
                      ))}
                    </ol>
                    <div className="wf-card-footer">
                      <div className="template-meta">
                        <span className={workflow.is_active ? 'wf-status-on' : 'wf-status-off'}>{workflow.is_active ? t('wfActive') : t('wfPaused')}</span>
                        <span>{workflow.steps.length} {t('wfStepsLabel')}</span>
                        <span>{counts.sent} {t('wfStatSent')}</span>
                        <span>{counts.pending} {t('wfStatPending')}</span>
                      </div>
                      <div className="template-actions">
                        <button className="text-action" type="button" onClick={() => setDraft(draftFromWorkflow(workflow))}>{t('wfEdit')}</button>
                        <button className="text-action wf-danger" type="button" disabled={busyId === workflow.id} onClick={() => handleDelete(workflow)}>{t('wfDelete')}</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <section className="panel wf-presets">
            <div className="panel-heading">
              <div><span className="eyebrow">{t('workflows')}</span><h3>{t('wfPresetsTitle')}</h3></div>
            </div>
            <p className="muted-copy">{t('wfPresetsHelp')}</p>
            <div className="wf-preset-grid">
              {WORKFLOW_PRESETS.map((preset) => (
                <article className="wf-preset" key={preset.id}>
                  <h4>{t(preset.nameKey)}</h4>
                  <p className="muted-copy">{t(preset.descriptionKey)}</p>
                  <span className="soft-badge badge-muted">{t(`wfTrigger_${preset.trigger_type}`)}</span>
                  <Button variant="secondary" size="small" onClick={() => setDraft(buildPresetDraft(preset, t))}>{t('wfUsePreset')}</Button>
                </article>
              ))}
            </div>
          </section>

          <div className="notice notice-info wf-how">
            <strong>{t('wfHowTitle')}</strong>
            <p>{t('wfHowBody')}</p>
          </div>
        </>
      )}
    </>
  );
}
