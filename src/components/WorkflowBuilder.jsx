import { useMemo, useRef, useState } from 'react';
import Button from './Button.jsx';
import { useLocale } from '../contexts/LocaleContext.jsx';
import {
  MAX_WORKFLOW_STEPS,
  TEMPLATE_VARIABLES,
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  buildPreviewTimeline,
  emptyStep,
  insertVariable,
  validateWorkflowDraft,
} from '../services/workflowUtils.js';

export default function WorkflowBuilder({ initialDraft, previewNames, saving, onSave, onCancel }) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(initialDraft);
  const [errors, setErrors] = useState({ steps: [] });
  const fields = useRef({});

  const timeline = useMemo(
    () => buildPreviewTimeline(draft.steps, { client_name: t('wfSampleClient'), ...previewNames }, t('wfTaskLabel')),
    [draft.steps, previewNames, t],
  );

  const setField = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  const setStep = (index, changes) => setDraft((current) => ({
    ...current,
    steps: current.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...changes } : step)),
  }));

  function moveStep(index, offset) {
    setDraft((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps };
    });
  }

  function addStep() {
    setDraft((current) => {
      if (current.steps.length >= MAX_WORKFLOW_STEPS) return current;
      const lastDelay = Number(current.steps[current.steps.length - 1]?.delay_days) || 0;
      return { ...current, steps: [...current.steps, emptyStep({ delay_days: lastDelay + 1 })] };
    });
  }

  function removeStep(index) {
    setDraft((current) => ({ ...current, steps: current.steps.filter((_, stepIndex) => stepIndex !== index) }));
  }

  function addVariable(index, field, variable) {
    const element = fields.current[`${index}-${field}`];
    const current = draft.steps[index][field] || '';
    const { value, cursor } = insertVariable(current, variable, element?.selectionStart ?? current.length, element?.selectionEnd ?? current.length);
    setStep(index, { [field]: value });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(cursor, cursor);
    });
  }

  function handleSubmit(event) {
    event.preventDefault();
    const result = validateWorkflowDraft(draft);
    setErrors(result.errors);
    if (result.valid) onSave(result.payload);
  }

  const fieldError = (key) => key && <span className="field-error" role="alert">{t(key)}</span>;

  function renderVariables(index, field) {
    return (
      <div className="wf-variables" role="group" aria-label={t('wfVariables')}>
        <span>{t('wfInsertVariable')}</span>
        {TEMPLATE_VARIABLES.map((variable) => (
          <button className="wf-chip" type="button" key={variable} onClick={() => addVariable(index, field, variable)}>{`{${variable}}`}</button>
        ))}
      </div>
    );
  }

  return (
    <form className="wf-builder" onSubmit={handleSubmit} noValidate>
      <section className="panel wf-builder-main">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t('workflows')}</span>
            <h3>{draft.id ? t('wfBuilderEdit') : t('wfBuilderNew')}</h3>
          </div>
        </div>

        <div className="wf-form-grid">
          <label className="form-label wf-span-2">
            <span>{t('wfName')}</span>
            <input className="field" value={draft.name} maxLength={140} placeholder={t('wfNamePlaceholder')} onChange={setField('name')} aria-invalid={Boolean(errors.name)} />
            {fieldError(errors.name)}
          </label>
          <label className="form-label wf-span-2">
            <span>{t('wfDescription')}</span>
            <input className="field" value={draft.description} onChange={setField('description')} />
            {fieldError(errors.description)}
          </label>
          <label className="form-label wf-span-2">
            <span>{t('wfTrigger')}</span>
            <select className="field" value={draft.trigger_type} onChange={setField('trigger_type')}>
              {WORKFLOW_TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{t(`wfTrigger_${trigger}`)}</option>)}
            </select>
            <small className="muted-copy">{t(`wfTriggerHelp_${draft.trigger_type}`)}</small>
            {fieldError(errors.trigger)}
          </label>
        </div>

        <div className="wf-steps-heading">
          <h4>{t('wfSteps')}</h4>
          <small className="muted-copy">{draft.steps.length}/{MAX_WORKFLOW_STEPS}</small>
        </div>
        {fieldError(errors.stepCount)}

        <ol className="wf-steps">
          {draft.steps.map((step, index) => {
            const stepErrors = errors.steps[index] || {};
            return (
              <li className="wf-step" key={index}>
                <div className="wf-step-heading">
                  <strong>{t('wfStep')} {index + 1}</strong>
                  <div className="wf-step-actions">
                    <button className="text-action" type="button" disabled={index === 0} onClick={() => moveStep(index, -1)} aria-label={t('wfMoveUp')}>↑</button>
                    <button className="text-action" type="button" disabled={index === draft.steps.length - 1} onClick={() => moveStep(index, 1)} aria-label={t('wfMoveDown')}>↓</button>
                    <button className="text-action wf-danger" type="button" disabled={draft.steps.length === 1} onClick={() => removeStep(index)}>{t('wfRemoveStep')}</button>
                  </div>
                </div>

                <div className="wf-form-grid">
                  <label className="form-label">
                    <span>{t('wfDelayDays')}</span>
                    <input className="field" type="number" inputMode="numeric" min="0" max="365" step="1" value={step.delay_days} onChange={(event) => setStep(index, { delay_days: event.target.value })} aria-invalid={Boolean(stepErrors.delay)} />
                    <small className="muted-copy">{t('wfDelayHelp')}</small>
                    {fieldError(stepErrors.delay)}
                  </label>
                  <label className="form-label">
                    <span>{t('wfAction')}</span>
                    <select className="field" value={step.action_type} onChange={(event) => setStep(index, { action_type: event.target.value })}>
                      {WORKFLOW_ACTIONS.map((action) => <option key={action} value={action}>{t(`wfAction_${action}`)}</option>)}
                    </select>
                    {fieldError(stepErrors.action)}
                  </label>
                </div>

                {step.action_type === 'assign_task' && (
                  <label className="form-label">
                    <span>{t('wfTaskTitle')}</span>
                    <input className="field" value={step.task_title} maxLength={140} placeholder={t('wfTaskPlaceholder')} ref={(node) => { fields.current[`${index}-task_title`] = node; }} onChange={(event) => setStep(index, { task_title: event.target.value })} aria-invalid={Boolean(stepErrors.task)} />
                    {fieldError(stepErrors.task)}
                  </label>
                )}

                <label className="form-label">
                  <span>{step.action_type === 'assign_task' ? t('wfTaskMessage') : t('wfMessage')}</span>
                  <textarea className="field wf-textarea" rows={3} value={step.message_template} maxLength={1600} placeholder={t('wfMessagePlaceholder')} ref={(node) => { fields.current[`${index}-message_template`] = node; }} onChange={(event) => setStep(index, { message_template: event.target.value })} aria-invalid={Boolean(stepErrors.message)} />
                  {fieldError(stepErrors.message)}
                </label>
                {renderVariables(index, 'message_template')}
              </li>
            );
          })}
        </ol>

        <div className="wf-builder-footer">
          <Button type="button" variant="secondary" size="small" onClick={addStep} disabled={draft.steps.length >= MAX_WORKFLOW_STEPS}>+ {t('wfAddStep')}</Button>
          {draft.steps.length >= MAX_WORKFLOW_STEPS && <small className="muted-copy">{t('wfMaxSteps')}</small>}
        </div>

        <label className="wf-checkbox">
          <input type="checkbox" checked={draft.is_active} onChange={(event) => setDraft((current) => ({ ...current, is_active: event.target.checked }))} />
          <span>{t('wfStartActive')}</span>
        </label>

        <div className="wf-actions">
          <Button type="submit" variant="primary" disabled={saving}>{saving ? t('wfSaving') : t('wfSave')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>{t('wfCancel')}</Button>
        </div>
      </section>

      <aside className="panel wf-preview">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t('wfPreview')}</span>
            <h3>{t(`wfTrigger_${draft.trigger_type}`)}</h3>
          </div>
        </div>
        <p className="muted-copy">{t('wfPreviewHelp')}</p>
        <ol className="wf-timeline">
          {timeline.map((item) => (
            <li key={item.index}>
              <span className="wf-timeline-day">{t('wfPreviewDay')} {item.day}</span>
              <span className="soft-badge badge-muted">{t(`wfAction_${item.action}`)}</span>
              <p>{item.text || '…'}</p>
            </li>
          ))}
        </ol>
        <div className="notice notice-info wf-how">
          <strong>{t('wfHowTitle')}</strong>
          <p>{t('wfHowBody')}</p>
        </div>
      </aside>
    </form>
  );
}
